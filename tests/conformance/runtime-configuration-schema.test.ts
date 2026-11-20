import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import {
  loadRuntimeConfigurationSchema,
  runtimeConfigurationProblems,
} from "../../apps/controller/src/admission/runtime-configuration-schema.ts";
import { prepareNativeAdminConfiguration } from "../../apps/controller/src/gateway/native-admin.ts";
import type { OpenClawConfigurationDocument } from "../../packages/contracts/src/index.ts";
import { admitGatewaySecurityDefaults } from "../../packages/occ/src/gateway-security-defaults.ts";

type Schema = Parameters<typeof runtimeConfigurationProblems>[0];

function refusals(schema: Schema, values: unknown): [string, string][] {
  return runtimeConfigurationProblems(schema, values).map(({ path, code }) => [path, code]);
}

test("the pinned runtime schema accepts the bundled Presets and the settings OCC writes itself", async () => {
  const { schema } = loadRuntimeConfigurationSchema();
  const directory = new URL("../../deploy/presets/", import.meta.url);
  const files = (await readdir(directory)).filter((name) => name.endsWith(".json"));
  assert.ok(files.length > 0);
  for (const file of files) {
    const preset: unknown = JSON.parse(await readFile(new URL(file, directory), "utf8"));
    assert.ok(typeof preset === "object" && preset !== null && "template" in preset);
    const { template } = preset as {
      template: { configuration: { values: OpenClawConfigurationDocument } };
    };
    // A launch saves these values with its variables filled; every placeholder stands in text.
    const values = template.configuration.values;
    assert.deepEqual(refusals(schema, values), [], file);
    // A pin whose schema refused OCC's own Gateway defaults or browser access settings would
    // refuse documents that OCC wrote.
    const defaults = admitGatewaySecurityDefaults(values);
    assert.deepEqual(refusals(schema, defaults), [], `${file} with Gateway defaults`);
    const browserAccess = prepareNativeAdminConfiguration(defaults, {
      agent: { id: "agt_00000000-0000-4000-8000-000000000000", namespaceId: "ns_schema" },
      installationId: "inst_schema",
      publicOrigin: "https://occ.example.test",
      domain: "agents.example.test",
    });
    assert.deepEqual(refusals(schema, browserAccess), [], `${file} with browser access`);
  }
});

const settings = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: {
    name: { type: "string", pattern: "^[a-z]+$", minLength: 3 },
    port: { type: "integer", exclusiveMinimum: 0, maximum: 65535 },
    mode: { type: "string", enum: ["off", "on"] },
    kind: { const: "fixed" },
    ratio: { type: "number", minimum: 0.5 },
    account: { $ref: "#/$defs/account" },
  },
};

test("a refusal names the setting and what is accepted, and leaves the rest to the runtime", () => {
  assert.deepEqual(
    runtimeConfigurationProblems(settings, {
      port: 0,
      mode: "maybe",
      kind: "other",
      ratio: "high",
      "retry/limit": 3,
    }),
    [
      {
        path: "/port",
        code: "INVALID_RANGE",
        message: "Configuration setting port must be greater than 0.",
      },
      {
        path: "/mode",
        code: "INVALID_VALUE",
        message: 'Configuration setting mode must be one of "off", "on".',
      },
      {
        path: "/kind",
        code: "INVALID_VALUE",
        message: 'Configuration setting kind must be "fixed".',
      },
      {
        path: "/ratio",
        code: "INVALID_TYPE",
        message: "Configuration setting ratio must be a number, not a string.",
      },
      {
        path: "/retry~1limit",
        code: "UNKNOWN_FIELD",
        message:
          'Configuration setting ["retry/limit"] is not a setting of the pinned OpenClaw runtime.',
      },
    ],
  );
  // The runtime fills defaults, so a missing required setting is not refused. It also checks
  // text patterns and lengths itself, and resolves references into embedded plugin schemas.
  assert.deepEqual(refusals(settings, {}), []);
  assert.deepEqual(refusals(settings, { name: "A", account: { anything: true } }), []);
});

test("a string that holds an environment reference is checked for its type only", () => {
  // The runtime replaces ${NAME} before it validates, so the final text is unknown at save.
  assert.deepEqual(refusals(settings, { mode: "${MODE}", kind: "${KIND:-fixed}" }), []);
  // The replacement is text, which a number setting never accepts.
  assert.deepEqual(refusals(settings, { port: "${PORT}" }), [["/port", "INVALID_TYPE"]]);
  // $${MODE} is the runtime's escape for the literal text ${MODE}, which is not a choice.
  assert.deepEqual(refusals(settings, { mode: "$${MODE}" }), [["/mode", "INVALID_VALUE"]]);
});

test("unions accept any matching branch; maps and lists check each entry", () => {
  const model = {
    anyOf: [
      { type: "string" },
      { type: "object", properties: { primary: { type: "string" } }, additionalProperties: false },
    ],
  };
  assert.deepEqual(refusals(model, "openai/gpt-5"), []);
  assert.deepEqual(refusals(model, { primary: "openai/gpt-5" }), []);
  // The object branch fits the value's type, so the misspelled key is what the caller fixes.
  assert.deepEqual(refusals(model, { primry: "x" }), [["/primry", "UNKNOWN_FIELD"]]);
  assert.deepEqual(runtimeConfigurationProblems(model, 5), [
    {
      path: "",
      code: "INVALID_TYPE",
      message:
        "Configuration setting (the whole document) must be a string or an object, not a number.",
    },
  ]);

  // A union of fixed values is refused with all of them, not with the first branch's value.
  const bind = {
    anyOf: [
      { type: "string", const: "auto" },
      { type: "string", const: "lan" },
    ],
  };
  assert.deepEqual(runtimeConfigurationProblems(bind, "wan"), [
    {
      path: "",
      code: "INVALID_VALUE",
      message: 'Configuration setting (the whole document) must be one of "auto", "lan".',
    },
  ]);

  const providers = {
    type: "object",
    properties: {
      providers: {
        type: "object",
        additionalProperties: {
          type: "object",
          additionalProperties: false,
          properties: {
            models: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: { id: { type: "string" } },
              },
            },
          },
        },
      },
      labels: { type: "object", patternProperties: { "^x-": { type: "boolean" } } },
    },
  };
  const problems = runtimeConfigurationProblems(providers, {
    providers: { "openai/eu": { models: [{ id: "a" }, { id: 7 }] } },
    labels: { "x-ready": "yes", other: 1 },
  });
  assert.deepEqual(
    problems.map(({ path, code }) => [path, code]),
    [
      ["/providers/openai~1eu/models/1/id", "INVALID_TYPE"],
      ["/labels/x-ready", "INVALID_TYPE"],
    ],
  );
  assert.equal(
    problems[0]?.message,
    'Configuration setting providers["openai/eu"].models[1].id must be a string, not a number.',
  );
});
