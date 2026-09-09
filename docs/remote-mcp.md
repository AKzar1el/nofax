# Remote MCP on Cloudflare Workers

Nofax v0.3 adds an optional remote MCP transport for users who want their agent to reach the same phone approval workflow without launching a local stdio Nofax process.

The remote runtime is self-deployed to your own Cloudflare account. It does not replace the local CLI/MCP implementation and it is not a Nofax-operated SaaS.

## Architecture

```text
MCP client
   |
   | private Streamable HTTP
   v
Cloudflare Worker /mcp
   |
   +--> Nofax tool handler
   |       |
   |       +--> SQLite Durable Object: pending request
   |       |
   |       +--> ntfy: phone notification
   |
phone <-- ntfy
   |
   | Allow / Deny / Choice / Refine
   v
/r/<one-time callback capability>
   |
   v
SQLite Durable Object: terminal result
   |
   v
nofax_wait_for_response
```

The MCP protocol is stateless Streamable HTTP. Human-response state is separate and durable.

## Why a Durable Object

A remote MCP request may end before a human responds. Nofax therefore never treats one long HTTP connection as the source of truth.

Each interactive request is persisted before notification delivery. The stored row contains:

- request ID;
- interaction kind;
- bounded title and message;
- allowed terminal decisions;
- SHA-256 hash of the callback capability;
- creation/expiry timestamps;
- terminal decision/refinement after resolution.

The raw callback token is discarded after ntfy publication. It is not returned by any MCP tool.

Pending callback capabilities expire after 24 hours. Resolved rows are retained for a bounded recovery period and then removed by lazy cleanup.

## Human-response contract

Interactive request tools return immediately with a durable handle:

```json
{
  "status": "pending",
  "requestId": "nfx_...",
  "mustWait": true,
  "instruction": "WAIT REQUIRED: ..."
}
```

The caller then invokes:

```text
nofax_wait_for_response
```

A remote wait lasts at most 20 seconds. If the result is still pending, the caller must invoke the same wait tool again with the same request ID.

This repetition is intentional. Nofax does not assume a remote MCP server can universally force every host/model to start a new model turn after an unsolicited phone event.

Terminal semantics match local Nofax:

- `allow`: continue only within the authority the caller already had;
- `deny`: do not perform the guarded action;
- `refine`: apply the human text and request a fresh approval if the revised action still requires approval;
- explicit choice: use exactly the selected value.

Timeout, network failure, missing state, malformed callbacks, and expired capabilities never become approval.

## Phone UX

### Allow / Deny

ntfy action buttons send direct POST requests to the Worker:

```text
POST /r/<callback-token>/allow
POST /r/<callback-token>/deny
```

This is one tap on the phone.

### Choice

Choice requests support up to three explicit options, matching ntfy's compact action limit used by Nofax.

### Refine

Refine opens a small Worker-hosted page:

```text
GET /r/<callback-token>
```

The page is rendered server-side and contains one bounded textarea. It uses no external JavaScript, analytics, fonts, or third-party assets. Submission posts to:

```text
POST /r/<callback-token>/refine
```

The remote Refine flow therefore requires no Apple Shortcut. The Shortcut remains relevant only to the local v0.2 ntfy callback mode.

## MCP authentication

The v0.3 remote Worker is designed for private single-user use.

### Preferred: Authorization header

```text
https://<worker>.workers.dev/mcp
Authorization: Bearer <NOFAX_REMOTE_KEY>
```

### Compatibility: private capability URL

For MCP clients that cannot attach a static header:

```text
https://<worker>.workers.dev/mcp/<NOFAX_REMOTE_KEY>
```

The path form is a bearer capability. Treat the complete URL like a password. Do not publish it, paste it into issues, expose it to analytics, or share screenshots containing it.

After successful authentication, Nofax normalizes the request internally to `/mcp` and removes the Authorization header before MCP protocol handling.

`/r/...` phone callback routes do **not** require `NOFAX_REMOTE_KEY`. They are independently protected by fresh per-request callback capabilities.

OAuth 2.1 remains the hardening path before any multi-user/public hosted deployment.

## Deploy

From `worker/`:

```bash
npm ci
npx wrangler login
npx wrangler secret put NTFY_TOPIC
npx wrangler secret put NOFAX_REMOTE_KEY
npm test
npm run deploy
```

`NTFY_TOPIC` is the private topic subscribed in the ntfy mobile app. `NOFAX_REMOTE_KEY` should be a high-entropy secret generated outside the repository.

`NTFY_SERVER` defaults to `https://ntfy.sh`. For self-hosted ntfy, change the non-secret Wrangler `vars.NTFY_SERVER` value.

Before deployment, the complete Worker gate is:

```bash
npm run check
```

It runs:

```text
TypeScript -> Vitest -> wrangler deploy --dry-run
```

## Qualification checklist

A release-quality remote deployment should verify all of the following:

1. `/healthz` returns only `{ "status": "ok" }`.
2. `/mcp` rejects missing/wrong credentials.
3. An authenticated MCP client discovers exactly seven Nofax tools.
4. `nofax_notify` reaches the subscribed phone.
5. `nofax_request_approval` + repeated waits returns terminal `allow` after tapping Allow.
6. A new request returns terminal `deny` after tapping Deny.
7. A Refine request returns exactly the submitted bounded text.
8. Pending requests remain recoverable by request ID after MCP/client interruption.
9. A second callback cannot replace the first terminal response.
10. Expired callback capabilities fail closed.

MCP Inspector is the protocol-level qualification tool. Client-specific tool scans are additional compatibility evidence, not a replacement for the protocol test.

## Threat boundaries

Remote mode adds two hosted infrastructure boundaries that local mode does not have:

- Cloudflare receives MCP requests, bounded request summaries, callback requests, and Refine text.
- ntfy receives notification summaries plus one-time callback URLs.

Neither boundary should be described as end-to-end encrypted by Nofax.

The following values are bearer secrets/capabilities:

- `NTFY_TOPIC`;
- `NOFAX_REMOTE_KEY`;
- each raw callback token;
- the full `/mcp/<key>` capability URL.

If `NOFAX_REMOTE_KEY` or `NTFY_TOPIC` is exposed, rotate it. Callback tokens expire and are single-use, but should still never be logged or shared.

For confidential source code, credentials, regulated data, or production operations, prefer a trusted authenticated/self-hosted ntfy instance and review [`../SECURITY.md`](../SECURITY.md).

## Free-plan fit

The Worker uses a SQLite-backed Durable Object rather than the legacy key-value storage backend. Cloudflare documents SQLite-backed Durable Objects as available on the Workers Free plan, subject to current free-tier limits.

Nofax deliberately uses one bounded request table and lazy cleanup so stale human-response state does not grow without bound.

## Local versus remote

| Capability | Local Nofax | Remote Worker |
| --- | --- | --- |
| MCP transport | stdio | Streamable HTTP |
| Human state | local request files | SQLite Durable Object |
| Allow/Deny | ntfy response topic | direct Worker callback |
| Refine | iOS Shortcut callback | Worker-hosted HTML form |
| Inbound port on PC | none | none |
| Hosted Nofax service required | no | no; self-deploy Worker |
| MCP auth | local process boundary | private bearer key |
| Max wait per call | 240 s | 20 s |

Both transports intentionally expose the same seven public tool names and terminal decision semantics.
