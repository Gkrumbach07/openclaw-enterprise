---
created: "2026-11-20"
updated: "2026-11-20"
last_updated_session: "authoring-run/5e465a02-4a1b-46a6-bc69-dca7d7862318"
---

# How OCC serves the Agent configuration schema

## Overview

OpenClaw Control Plane (OCC) serves the configuration JSON Schema and display
hints of the OpenClaw runtime that its source pins. A contributor generates them
from a runtime image into one committed file. The controller image carries that
file, and the API reads it for a caller who can read the Namespace. The flow
stops when the API sends the response. OCC does not use the schema to check a
saved Configuration.

## Entry Points

- A contributor regenerates the file after a change to the pinned OpenClaw
  commit or a carried patch. `scripts/generate-runtime-config-schema.ts:generate`
- A caller with `namespace:read` sends
  `GET /namespaces/{namespaceId}/agents/configuration-schema`.
  `apps/controller/src/http/agents.ts:getAgentConfigurationSchema`

## Flow

```mermaid
graph TD
  Image["Runtime image built from the checkout"] -->|Provenance differs| Refuse["Generator stops; no file written"]
  Image -->|Provenance matches the checkout| File["Generator writes openclaw-config-schema.json"]
  File --> Check["config-schema:check compares the recorded commit and patches"]
  File --> Controller["Controller image copies the file"]
  Request["GET configuration-schema"] --> Authorize["OCC checks namespace:read"]
  Authorize -->|Denied| Forbidden["403 FORBIDDEN"]
  Authorize -->|Allowed| Load["API reads and keeps the parsed file"]
  Controller --> Load
  Load --> Response["200 with runtime.commit, schema, uiHints"]
```

## Execution Trace

### 1. Generate the file from a runtime image

`scripts/generate-runtime-config-schema.ts:generate`

The generator reads `/opt/oce/runtime/provenance.json` from the selected image.
It compares the recorded OpenClaw commit and the SHA-256 of each patch with
`deploy/runtime/openclaw-source.json` and the `deploy/runtime/*.patch` files in
the checkout. A difference stops the run before any write, because a carried
patch can change the schema as the commit can.

The generator then runs two commands in the image without network access.
`openclaw config schema` prints the JSON Schema, which includes the settings of
the plugins and channels in the image. A short module imports the image's
`buildConfigSchemaCore()` and prints its `uiHints`, because the schema command
omits them. The generator writes `deploy/runtime/openclaw-config-schema.json`
with three members: `openclaw` (commit and patch digests), `schema`, and
`uiHints`. It writes one line for each top-level setting and each hint path.

### 2. Detect a stale file

`scripts/generate-runtime-config-schema.ts:runtimeConfigSchemaStaleness`

`pnpm config-schema:check` compares the `openclaw` member with the checkout and
needs no image. `tests/integration/runtime-assets.test.ts` runs the same
comparison, and `tests/integration/console-api.test.ts` compares the served
commit with the pin. A changed pin or patch without a new file fails these checks.

### 3. Package and load the file

`apps/controller/src/admission/runtime-configuration-schema.ts:loadRuntimeConfigurationSchema`

The development and runtime stages of the controller `Dockerfile` copy the file
to `/app/deploy/runtime/openclaw-config-schema.json`. The controller image build
does not read the runtime image. The loader resolves the same path relative to
its source file, so a checkout and the image use one location. It reads and
parses the file on the first call and returns the same object afterwards.

### 4. Authorize and answer the read

`apps/controller/src/http/agents.ts:getAgentConfigurationSchema`

The handler calls `OpenClawController.getNamespace`, which requires
`namespace:read` on the Namespace in the path and returns `403 FORBIDDEN`
without it. The handler records the Namespace as the audit read target, then
sends `runtime.commit`, `schema`, and `uiHints` from the loader. The response
has the default API headers, which include `Cache-Control: no-store`. The answer
does not depend on the Namespace. The caller owns any use of the schema.

## Debugging and Verification

- `pnpm config-schema:check` exits with a message that names the differing
  commit or patch. Rebuild the runtime image from the checkout, then run
  `pnpm config-schema:generate --image <reference>`.
- `node --test --test-name-pattern="Agent configuration schema" tests/integration/console-api.test.ts`
  reads the route through the controller with Native IAM. It proves the
  permission and the response contract. It does not prove that a deployed
  runtime image has the same source.
- The read fails with a server error when the controller image does not contain
  the file. Check the `COPY` lines in the `Dockerfile`.

## Related docs

- [Agent configuration schema reference](../reference/configuration/runtime-schema.md)
- [Configuration Driver flow](configuration-driver.md)
- [Runtime image recipe](../../deploy/runtime/README.md)
- [Pin-update recipe](../../.agents/skills/oce-cookbook/references/update-openclaw-pin.md)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-11-20 14:18: Document schema generation, the staleness check, and the read route added with this change (authoring-run/5e465a02-4a1b-46a6-bc69-dca7d7862318 - 5bf2ae7fd703197701f311098d734a10ed4ab593)
