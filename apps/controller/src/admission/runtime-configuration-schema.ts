import { readFileSync } from "node:fs";

/**
 * The configuration JSON Schema and UI hints of the OpenClaw runtime this controller's source
 * pins (`deploy/runtime/openclaw-source.json`). `scripts/generate-runtime-config-schema.ts`
 * regenerates the file from the runtime image and records the commit it describes.
 */
const SCHEMA_FILE = new URL(
  "../../../../deploy/runtime/openclaw-config-schema.json",
  import.meta.url,
);

export interface RuntimeConfigurationSchema {
  /** The OpenClaw source commit the schema and hints describe. */
  readonly commit: string;
  /** What `openclaw config schema` prints at that commit: JSON Schema draft-07. */
  readonly schema: Readonly<Record<string, unknown>>;
  /**
   * The display metadata the OpenClaw Control UI reads, keyed by dotted setting path with `*` for
   * any map key and `[]` for any list entry.
   */
  readonly uiHints: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

let cached: RuntimeConfigurationSchema | undefined;

/** Reads the bundled file once; later calls return the same parsed document. */
export function loadRuntimeConfigurationSchema(): RuntimeConfigurationSchema {
  if (cached === undefined) {
    const { openclaw, schema, uiHints } = JSON.parse(readFileSync(SCHEMA_FILE, "utf8")) as {
      openclaw: { commit: string };
      schema: RuntimeConfigurationSchema["schema"];
      uiHints: RuntimeConfigurationSchema["uiHints"];
    };
    cached = Object.freeze({ commit: openclaw.commit, schema, uiHints });
  }
  return cached;
}
