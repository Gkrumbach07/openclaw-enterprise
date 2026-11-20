# Agent configuration schema

Use this reference to read the JSON Schema of the native OpenClaw document that
an [Agent Configuration](../configuration.md) holds in `values`. OpenClaw
Control Plane (OCC) serves the schema of the OpenClaw runtime that its source
pins. A client can use it to show the settings as a form or to check a document
before it sends a save.

## Read the schema

Send [`GET /namespaces/{namespaceId}/agents/configuration-schema`](../api.md#get-namespacesnamespaceidagentsconfigurationschema).
The operation needs `namespace:read` on the Namespace in the path. It has no
permission of its own. The answer is the same in every Namespace.

| Field            | Content                                                                                                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime.commit` | The OpenClaw source commit that the schema and hints describe.                                                                                                                         |
| `schema`         | The JSON Schema (draft-07) that `openclaw config schema` prints in the runtime image. It includes the settings of the plugins and channels in that image.                              |
| `uiHints`        | The display hints of the OpenClaw Control UI, keyed by dotted setting path. `*` matches any map key and `[]` any list entry. A hint can hold `label`, `help`, `order`, and `advanced`. |

OCC passes the hints through as the runtime reports them. A later runtime can
add hint fields, so a client must ignore fields that it does not know.

The response is approximately 2.1 MB of JSON. OCC sends it with
`Cache-Control: no-store` and does not compress it, as for every API response.
Read it one time for each session and keep it in memory.

## Limits

- The schema describes the OpenClaw commit in
  [`deploy/runtime/openclaw-source.json`](../../../deploy/runtime/openclaw-source.json)
  with the patches that the [runtime recipe](../../../deploy/runtime/README.md)
  applies, at the controller's source revision. An Installation that runs a
  runtime image built from another source can accept other settings.
- OCC does not check Configuration `values` against this schema when it saves
  them. Its own [content rules](../configuration.md#failure-semantics-and-limitations)
  still apply, and the runtime checks the document when it starts.
- OCC changes some settings when it deploys an Agent, for example the
  [Gateway tool policy](../configuration.md#gateway-tool-policy). The schema
  describes the document format, not the document a deployed Gateway reads.

## Keep the schema current

The schema is the generated file `deploy/runtime/openclaw-config-schema.json`.
`pnpm config-schema:check` fails when the file records another OpenClaw commit
or other patches than the checkout builds. The
[pin-update recipe](../../../.agents/skills/oce-cookbook/references/update-openclaw-pin.md)
regenerates the file. See the [schema flow](../../flows/agent-configuration-schema.md)
for the implementation.
