// Regenerates deploy/runtime/openclaw-config-schema.json from a built OpenClaw runtime image, or
// checks that the committed file still describes the source this checkout builds:
//
//   node scripts/generate-runtime-config-schema.ts --image <reference>
//   node scripts/generate-runtime-config-schema.ts --check
//
// The file holds the configuration JSON Schema that `openclaw config schema` prints and the UI
// hints of the OpenClaw Control UI. That command leaves the hints out, so they come from
// `buildConfigSchemaCore()`, the function behind the Gateway `config.schema` method, imported
// from the OpenClaw build inside the image.
//
// A carried patch can change the schema as the pinned commit can, so the file records both: the
// commit and the SHA-256 of each patch from the image's /opt/oce/runtime/provenance.json. The
// check compares them with deploy/runtime/openclaw-source.json and the patch files. It needs no
// image.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readOpenclawSource } from "./lib/openclaw-source.ts";

interface SourceIdentity {
  readonly commit: string;
  readonly patches: Readonly<Record<string, string>>;
}

const runtimeDirectory = new URL("../deploy/runtime/", import.meta.url);
const schemaFile = new URL("openclaw-config-schema.json", runtimeDirectory);
const REGENERATE =
  "Build the runtime image from this checkout, then run `pnpm config-schema:generate --image <reference>`.";

// Runs inside the image. The bundler gives the module that exports buildConfigSchemaCore a hashed
// file name and can shorten the export name, so the script reads both from the export clause.
const PRINT_UI_HINTS = String.raw`
import { readdirSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const dist = "/app/node_modules/openclaw/dist";
let build;
for (const name of readdirSync(dist).sort()) {
  if (build !== undefined || !name.endsWith(".mjs")) {
    continue;
  }
  const text = readFileSync(dist + "/" + name, "utf8");
  for (const clause of text.matchAll(/export\{([^}]*)\}/g)) {
    for (const entry of clause[1].split(",")) {
      const match = /^\s*buildConfigSchemaCore(?:\s+as\s+([\w$]+))?\s*$/.exec(entry);
      if (match && build === undefined) {
        const module = await import(pathToFileURL(dist + "/" + name).href);
        build = module[match[1] ?? "buildConfigSchemaCore"];
      }
    }
  }
}
if (typeof build !== "function") {
  throw new Error("No module in " + dist + " exports buildConfigSchemaCore.");
}
process.stdout.write(JSON.stringify(build().uiHints));
`;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The image needs no network to print its schema.
function inImage(image: string, command: readonly string[], input?: string): unknown {
  const [entrypoint, ...args] = command;
  const output = execFileSync(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "none",
      ...(input === undefined ? [] : ["-i"]),
      "--entrypoint",
      entrypoint!,
      image,
      ...args,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...(input === undefined ? {} : { input }) },
  );
  return JSON.parse(output);
}

/** The OpenClaw commit and carried patches this checkout builds its runtime image from. */
async function checkoutIdentity(): Promise<SourceIdentity> {
  const { commit } = await readOpenclawSource();
  const patches: Record<string, string> = {};
  for (const name of (await readdir(runtimeDirectory)).sort()) {
    if (name.endsWith(".patch")) {
      patches[name] = createHash("sha256")
        .update(await readFile(new URL(name, runtimeDirectory)))
        .digest("hex");
    }
  }
  return { commit, patches };
}

function differences(recorded: SourceIdentity, checkout: SourceIdentity, subject: string) {
  const reasons: string[] = [];
  if (recorded.commit !== checkout.commit) {
    reasons.push(
      `${subject} describes OpenClaw ${recorded.commit}, but deploy/runtime/openclaw-source.json pins ${checkout.commit}.`,
    );
  }
  for (const name of new Set([
    ...Object.keys(recorded.patches),
    ...Object.keys(checkout.patches),
  ])) {
    if (recorded.patches[name] !== checkout.patches[name]) {
      reasons.push(`${subject} was built with another deploy/runtime/${name}.`);
    }
  }
  return reasons;
}

/**
 * Why the committed schema file no longer describes the runtime source this checkout builds; empty
 * when it does.
 */
export async function runtimeConfigSchemaStaleness(): Promise<string[]> {
  const { openclaw } = JSON.parse(await readFile(schemaFile, "utf8")) as { openclaw: unknown };
  if (!isObject(openclaw) || typeof openclaw.commit !== "string" || !isObject(openclaw.patches)) {
    return ["deploy/runtime/openclaw-config-schema.json does not record its OpenClaw source."];
  }
  return differences(
    openclaw as unknown as SourceIdentity,
    await checkoutIdentity(),
    "deploy/runtime/openclaw-config-schema.json",
  );
}

// One entry per line down to `depth` levels of objects, so a regeneration diff names the settings
// whose schema or hints changed without a line for every keyword.
function lines(value: unknown, depth: number, indent: string): string {
  if (depth === 0 || !isObject(value)) {
    return JSON.stringify(value);
  }
  const entries = Object.entries(value).map(
    ([key, entry]) =>
      `${indent}  ${JSON.stringify(key)}: ${lines(entry, depth - 1, `${indent}  `)}`,
  );
  return `{\n${entries.join(",\n")}\n${indent}}`;
}

async function generate(image: string): Promise<void> {
  const provenance = inImage(image, ["cat", "/opt/oce/runtime/provenance.json"]);
  if (
    !isObject(provenance) ||
    typeof provenance.commit !== "string" ||
    !isObject(provenance.patches)
  ) {
    throw new Error(`Image ${image} has no OCE runtime provenance.`);
  }
  const openclaw = {
    commit: provenance.commit,
    patches: provenance.patches,
  } as SourceIdentity;
  const mismatches = differences(openclaw, await checkoutIdentity(), `Image ${image}`);
  if (mismatches.length > 0) {
    throw new Error(`${mismatches.join("\n")}\n${REGENERATE}`);
  }
  const schema = inImage(image, ["openclaw", "config", "schema"]);
  const uiHints = inImage(image, ["node", "--input-type=module", "-"], PRINT_UI_HINTS);
  if (!isObject(schema) || !isObject(uiHints) || Object.keys(uiHints).length === 0) {
    throw new Error(`Image ${image} printed no configuration schema or no UI hints.`);
  }
  await writeFile(
    schemaFile,
    [
      "{",
      `  "openclaw": ${lines(openclaw, 2, "  ")},`,
      `  "schema": ${lines(schema, 2, "  ")},`,
      `  "uiHints": ${lines(uiHints, 1, "  ")}`,
      "}",
      "",
    ].join("\n"),
  );
  console.log(`Wrote deploy/runtime/openclaw-config-schema.json for OpenClaw ${openclaw.commit}.`);
}

async function main(args: readonly string[]): Promise<void> {
  if (args.length === 1 && args[0] === "--check") {
    const reasons = await runtimeConfigSchemaStaleness();
    if (reasons.length > 0) {
      throw new Error(`${reasons.join("\n")}\n${REGENERATE}`);
    }
    return;
  }
  if (args.length !== 2 || args[0] !== "--image" || args[1]!.startsWith("--")) {
    throw new Error(
      "Usage: node scripts/generate-runtime-config-schema.ts --image <reference> | --check",
    );
  }
  await generate(args[1]!);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
