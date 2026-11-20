# Agent configuration schema

Use this reference to read the JSON Schema of the native OpenClaw document that
an [Agent Configuration](../configuration.md) holds in `values`. OpenClaw
Control Plane (OCC) serves the schema of the OpenClaw runtime that its source
pins. A client can use it to show the settings as a form or to check a document
before it sends a save. OCC [checks saved values](#save-time-check) against the
same schema.

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

## Save-time check

OCC refuses Configuration `values` that the schema does not accept. The check
applies to these API operations and saves nothing when it refuses:

- [Configuration create](../api.md#post-namespacesnamespaceidconfigurations) and
  [update](../api.md#patch-namespacesnamespaceidconfigurationsconfigurationid).
- [Agent provisioning](../api.md#post-namespacesnamespaceidagentsprovision) and
  the [Agent create check](../api.md#post-namespacesnamespaceidagentsvalidate).

The check runs last, after OCC's own [content rules](../configuration.md#failure-semantics-and-limitations)
and the Configuration Driver's rules. A setting that those rules refuse keeps
their message. No setting or environment variable turns the check off.

| Checked                                                        | Detail code     |
| -------------------------------------------------------------- | --------------- |
| A key that is not a setting, where the schema lists every key  | `UNKNOWN_FIELD` |
| A value of the wrong JSON type                                 | `INVALID_TYPE`  |
| A value that is not one of the fixed values of the setting     | `INVALID_VALUE` |
| A number below the minimum or above the maximum of the setting | `INVALID_RANGE` |

The check applies these rules through maps, lists, and alternatives. Where the
schema gives alternatives, a value is accepted when one alternative accepts it.

The saved document is not the document that the runtime validates. OCC
therefore leaves these rules to the runtime, which applies them when it starts:

- **Required settings.** The runtime fills defaults, and OCC sets some settings
  at deployment.
- **Text patterns, formats, and lengths.** The runtime replaces `${NAME}`
  environment references before it validates. For the same reason, a string that
  contains such a reference is checked for its type only.
- **Conditional rules** (`not`, `if`) and references into plugin schemas (`$ref`).

A refusal is `400 INVALID_REQUEST`. The message is the first problem. `details`
lists up to 32 problems. Each `path` is a JSON Pointer in the request body. It
starts with `/values` for a Configuration and with `/configuration/values` for
an Agent operation. A message names the setting and the accepted values. It
does not contain the value that the request sent.

```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "Configuration setting tools.web.serch is not a setting of the pinned OpenClaw runtime.",
    "details": [
      {
        "path": "/values/tools/web/serch",
        "code": "UNKNOWN_FIELD",
        "message": "Configuration setting tools.web.serch is not a setting of the pinned OpenClaw runtime."
      }
    ]
  }
}
```

Correct the named setting and send the request again. To see what a setting
accepts, find its path in the schema.

## Limits

- The schema describes the OpenClaw commit in
  [`deploy/runtime/openclaw-source.json`](../../../deploy/runtime/openclaw-source.json)
  with the patches that the [runtime recipe](../../../deploy/runtime/README.md)
  applies, at the controller's source revision. An Installation that runs a
  runtime image built from another source can accept other settings. OCC then
  refuses a setting that only that image accepts.
- A saved Configuration is not checked again. A Configuration saved before the
  check existed, or before a change of the pinned commit, can still be read and
  deployed. The check applies to its next update.
- [Preset](../presets.md) save does not run the check, because a template can
  contain variables without values. The check applies to the Configuration that a
  launch saves.
- The check refuses a setting that the schema does not list, also where the
  runtime still tolerates it. For example, the runtime accepts an empty legacy
  `agents.list`, and the check refuses it. Remove the setting.
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
