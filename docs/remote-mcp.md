# Read-Only Remote MCP on Cloudflare Workers

Nofax v0.3 adds an optional, self-deployed remote MCP endpoint for **inspection only**.

It does not replace the local Nofax CLI/stdio server and it does not expose local phone-approval capabilities remotely.

## Architecture

```text
MCP client
   |
   | private Streamable HTTP
   v
Cloudflare Worker
   |
   +--> authenticated MCP router
            |
            +--> nofax_get_request
            |
            +--> nofax_list_pending
                     |
                     v
             SQLite Durable Object
```

The Worker has no messaging-provider integration and no human-response callback route.

## Public routes

Only these paths are intentional:

```text
GET|HEAD /healthz
/mcp
/mcp/<NOFAX_REMOTE_KEY>
```

The `/mcp` routes still enforce the deployment key. The capability-path form exists only for MCP clients that cannot attach a static Authorization header.

Former experimental routes such as `/telegram/webhook` and `/r/<token>` are not registered and return 404.

## MCP tools

The remote server exposes exactly two tools.

### `nofax_get_request`

Input:

```json
{
  "requestId": "nfx_..."
}
```

It retrieves the safe public projection for one existing durable request.

The response may include:

- request ID;
- interaction kind;
- status;
- creation timestamp;
- terminal timestamp/decision when already resolved;
- terminal refinement text when it exists in historical state.

It does not return the original title/message, callback hash, callback capability, or allowed-decision list.

### `nofax_list_pending`

Optional input:

```json
{
  "limit": 20
}
```

It lists a bounded set of unresolved, unexpired request projections. The limit is 1-100.

The query is observational only. It filters expired rows but does not delete them or perform lazy cleanup as a side effect of the read.

## Read-only enforcement

Both tools declare MCP annotations equivalent to:

```json
{
  "readOnlyHint": true,
  "destructiveHint": false,
  "idempotentHint": true,
  "openWorldHint": false
}
```

Those annotations improve client risk/confirmation UX, but Nofax does not treat them as enforcement.

The actual read-only boundary is structural:

- only the two read tools are registered with MCP;
- the handler object exposes only two read methods;
- the Worker router has no notification, approval, choice, refinement, wait, callback, or webhook route;
- no Telegram, ntfy, WhatsApp, SMS, or other phone transport exists in the remote Worker source;
- list operations do not perform hidden state cleanup.

The existing Durable Object schema is preserved to avoid destructive migration of deployments that previously created request rows during development. Legacy storage methods are not reachable from the public Worker route or MCP tool surface.

## MCP authentication

The v0.3 Worker is intended for a private single-user deployment.

### Preferred: Authorization header

```text
https://<worker>.workers.dev/mcp
Authorization: Bearer <NOFAX_REMOTE_KEY>
```

### Compatibility: capability URL

```text
https://<worker>.workers.dev/mcp/<NOFAX_REMOTE_KEY>
```

The complete capability URL is equivalent to a password. Do not publish it, paste it into issues, expose it to analytics, or include it in screenshots.

After successful authentication, Nofax normalizes the request internally to `/mcp` before protocol handling.

For a future shared/multi-user service, a single deployment-wide bearer key is not sufficient; use delegated authentication/authorization instead.

## Deployment

### 1. Generate a remote key

Generate a high-entropy secret outside the repository. For example:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

### 2. Store the secret and deploy

From `worker/`:

```bash
npm ci
npx wrangler login
npx wrangler secret put NOFAX_REMOTE_KEY
npm run check
npm run deploy
```

No phone-provider secret is required.

Do not place the remote key in `wrangler.jsonc`, source files, `.env`, `.dev.vars`, screenshots, or issue text.

## Qualification checklist

A release-quality remote deployment should verify all of the following:

1. `/healthz` returns only `{ "status": "ok" }`.
2. `/mcp` rejects missing/wrong credentials.
3. An authenticated MCP client discovers exactly:
   - `nofax_get_request`
   - `nofax_list_pending`
4. Both tools carry accurate read-only/non-destructive/idempotent/closed-world annotations.
5. `/telegram/webhook` returns 404.
6. `/r/anything` returns 404.
7. `nofax_list_pending` does not delete expired state while serving a read.
8. MCP results do not expose callback hashes, callback capabilities, original prompt/message text, or allowed-decision internals.
9. Worker TypeScript/tests/Wrangler dry-run pass.
10. Production dependency audit has no findings.

MCP Inspector or another protocol-level MCP client should be used for the final deployed tool scan. A ChatGPT custom-app scan is useful compatibility evidence but is not a substitute for protocol qualification.

## Local versus remote

| Capability | Local Nofax 0.2 | Remote Worker 0.3 |
| --- | --- | --- |
| MCP transport | stdio | Streamable HTTP |
| Phone notifications | ntfy | none |
| Create approval/choice/refinement | yes | no |
| Wait for human response | yes | no |
| Read one request | yes | yes |
| List unresolved requests | yes | yes |
| Human-response state | local files | existing SQLite Durable Object rows |
| Inbound port on PC | none | none |
| Nofax-operated backend | none | none; self-deployed Worker |
| Authentication | local process boundary | private bearer key |

## Threat boundaries

Remote mode adds a Cloudflare trust boundary: Cloudflare receives authenticated MCP requests and the read-only result data returned from the Durable Object.

The Worker does not send request data to a phone/messaging provider.

Treat these as sensitive:

- `NOFAX_REMOTE_KEY`;
- the complete `/mcp/<key>` capability URL;
- request metadata returned by read tools.

Read [`../SECURITY.md`](../SECURITY.md) before using the remote endpoint with sensitive metadata.
