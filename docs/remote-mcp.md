# Remote Notification + Inspection MCP on Cloudflare Workers

Nofax v0.3 adds an optional, self-deployed remote MCP endpoint for **one-way phone notifications plus request inspection**.

It does not replace the local Nofax CLI/stdio server and it does not expose local phone-approval or callback capabilities remotely.

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
            +--> nofax_notify --> ntfy --> phone
            |
            +--> nofax_get_request
            |
            +--> nofax_list_pending
                     |
                     v
             SQLite Durable Object
```

The Worker can publish one-way notifications to ntfy. It has no human-response callback route.

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

The remote server exposes exactly three tools.

### `nofax_notify`

Input:

```json
{
  "title": "Optional title",
  "message": "Required message"
}
```

It publishes a one-way notification to the configured `NTFY_TOPIC`. It does not create durable request state and does not imply or wait for human approval.

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

## Remote side-effect boundary

The two inspection tools declare MCP annotations equivalent to:

```json
{
  "readOnlyHint": true,
  "destructiveHint": false,
  "idempotentHint": true,
  "openWorldHint": false
}
```

Those annotations improve client risk/confirmation UX, but Nofax does not treat them as enforcement.

The actual boundary is structural:

- only `nofax_notify` plus the two read tools are registered with MCP;
- the handler object exposes only one-way notify plus two read methods;
- the Worker router has no approval, choice, refinement, wait, callback, or webhook route;
- ntfy publication is the only remote messaging transport;
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
npx wrangler secret put NTFY_TOPIC
npm run check
npm run deploy
```

`NTFY_TOPIC` is a bearer-like capability and should be stored as a Worker secret. The publisher defaults to `https://ntfy.sh` unless `NTFY_SERVER` is configured.

Do not place the remote key in `wrangler.jsonc`, source files, `.env`, `.dev.vars`, screenshots, or issue text.

### Public ntfy quota caveat

The hosted `ntfy.sh` service enforces its own publish quotas independently of Cloudflare. Cloudflare Workers may share outbound IP space with unrelated workloads, so ntfy can return `42908` (`daily message quota reached`) even when one Worker has sent very little traffic.

This is an upstream ntfy availability/quota boundary, not exhaustion of the Cloudflare Worker request allowance. For reliability-sensitive remote notifications, prefer an authenticated provider with account-scoped quota or a trusted self-hosted transport.

## Qualification checklist

A release-quality remote deployment should verify all of the following:

1. `/healthz` returns only `{ "status": "ok" }`.
2. `/mcp` rejects missing/wrong credentials.
3. An authenticated MCP client discovers exactly:
   - `nofax_notify`
   - `nofax_get_request`
   - `nofax_list_pending`
4. `nofax_notify` is non-destructive but side-effecting/open-world; the two inspection tools carry accurate read-only/non-destructive/idempotent/closed-world annotations.
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
| Phone notifications | ntfy | ntfy |
| Create approval/choice/refinement | yes | no |
| Wait for human response | yes | no |
| Read one request | yes | yes |
| List unresolved requests | yes | yes |
| Human-response state | local files | existing SQLite Durable Object rows |
| Inbound port on PC | none | none |
| Nofax-operated backend | none | none; self-deployed Worker |
| Authentication | local process boundary | private bearer key |

## Threat boundaries

Remote mode adds Cloudflare and ntfy trust boundaries for notification calls: Cloudflare receives authenticated MCP requests and ntfy receives the bounded title/message published to the configured topic. Request-inspection calls remain within Cloudflare/Durable Object state.

The Worker sends only explicit `nofax_notify` title/message content to ntfy. Request-inspection results are not forwarded to the phone provider automatically.

Treat these as sensitive:

- `NOFAX_REMOTE_KEY`;
- the complete `/mcp/<key>` capability URL;
- request metadata returned by read tools.

Read [`../SECURITY.md`](../SECURITY.md) before using the remote endpoint with sensitive metadata.
