# Nofax Remote Worker

This package is the optional Cloudflare Workers transport for Nofax. It exposes the same seven Nofax MCP tools as the local stdio server, but stores pending human-response state in a SQLite-backed Durable Object and accepts phone callbacks through the Worker.

It is designed for a **private, single-user deployment in your own Cloudflare account**. Nofax does not operate a hosted service for this component.

## What it provides

- Stateless Streamable HTTP MCP at `/mcp`.
- Private MCP authentication with `NOFAX_REMOTE_KEY`.
- Durable pending requests in a SQLite-backed Durable Object.
- One-tap ntfy **Allow** and **Deny** actions.
- Browser-based **Refine** with no Apple Shortcut required.
- First-terminal-response-wins semantics.
- 24-hour callback capability expiry and lazy stale-state cleanup.
- Bounded 20-second MCP waits; callers repeat the wait tool until terminal.

## Requirements

- Node.js 22 or newer for Worker development.
- A Cloudflare account with Workers enabled.
- An ntfy topic subscribed on your phone.
- Wrangler authentication for deployment.

SQLite-backed Durable Objects are supported on the Cloudflare Workers Free plan. Check current Cloudflare limits before production use.

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

`NTFY_TOPIC` is the private ntfy topic already subscribed on your phone. `NOFAX_REMOTE_KEY` must be a high-entropy secret generated outside the repository. Never commit either value.

`NTFY_SERVER` defaults to:

```text
https://ntfy.sh
```

To use a trusted self-hosted ntfy server, change the non-secret `NTFY_SERVER` value under `vars` in `wrangler.jsonc` before deployment.

For the complete pre-deploy gate, run:

```bash
npm run check
```

That performs TypeScript checking, the Worker test suite, and a Wrangler deployment dry-run.

## Connect an MCP client

Preferred mode for clients that support custom headers:

```text
https://<worker>.workers.dev/mcp
Authorization: Bearer <NOFAX_REMOTE_KEY>
```

Private capability-URL mode for clients that cannot attach a static header:

```text
https://<worker>.workers.dev/mcp/<NOFAX_REMOTE_KEY>
```

The capability URL is itself a bearer secret. Do not paste it into public issues, logs, screenshots, analytics, or shared configuration. Prefer the Authorization header when the MCP client supports it.

The Worker normalizes the authenticated request to `/mcp` before protocol handling and does not intentionally log capability URLs.

## Phone callbacks

Interactive notifications contain only a fresh per-request callback capability. They never contain `NOFAX_REMOTE_KEY`.

Typical routes are:

```text
POST /r/<callback-token>/allow
POST /r/<callback-token>/deny
GET  /r/<callback-token>
POST /r/<callback-token>/refine
```

The raw callback token is not stored. The Durable Object stores only its SHA-256 hash. Unknown, expired, malformed, or already-resolved callbacks fail closed.

The Refine page is server-rendered HTML with no external JavaScript, fonts, analytics, or third-party assets.

## MCP tools

The remote server exposes:

- `nofax_notify`
- `nofax_request_approval`
- `nofax_request_choice`
- `nofax_request_refinement`
- `nofax_wait_for_response`
- `nofax_get_request`
- `nofax_list_pending`

Request tools return durable `status: "pending"` state. `nofax_wait_for_response` waits for at most 20 seconds per call. If it still returns pending, the caller **must call it again with the same request ID** and must not infer approval.

## Security boundary

This private-key scheme is intentionally scoped to single-user/private deployments. It is not a substitute for per-user identity, delegated authorization, revocation, or audit controls in a public multi-user service.

Before multi-user/public hosting, use an OAuth 2.1 authorization design rather than sharing one deployment-wide bearer key.

Cloudflare receives Worker/MCP requests and Refine text. ntfy receives notification summaries and action URLs. Public ntfy is not end-to-end encrypted from the service operator. Read [`../SECURITY.md`](../SECURITY.md) before sending sensitive content.

## Development

```bash
npm ci
npm run check
```

Individual commands:

```bash
npm test
npm run typecheck
npx wrangler deploy --dry-run
npm run dev
```

Do not commit `.dev.vars`, `.env`, Cloudflare credentials, ntfy topics, remote keys, or callback URLs.

See [`../docs/remote-mcp.md`](../docs/remote-mcp.md) for the full architecture and qualification flow.
