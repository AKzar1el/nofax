# Nofax Remote Worker

This package is the optional **read-only** Cloudflare Workers MCP transport for Nofax.

It is designed for a private, single-user deployment in your own Cloudflare account. Nofax does not operate this Worker as a hosted service.

The local Nofax CLI and stdio MCP server remain separate and can still use ntfy for interactive human approvals. The remote Worker deliberately does not expose those actions.

> Upgrading from an earlier v0.3 development deployment requires redeploying this Worker before the live endpoint reflects the read-only tool surface.

## Public surface

The Worker exposes only:

- `GET|HEAD /healthz`
- authenticated Streamable HTTP MCP at `/mcp`
- authenticated capability-path compatibility at `/mcp/<NOFAX_REMOTE_KEY>`

It exposes exactly two MCP tools:

- `nofax_get_request`
- `nofax_list_pending`

Both tools are marked:

```text
readOnlyHint: true
destructiveHint: false
idempotentHint: true
openWorldHint: false
```

These annotations are descriptive metadata, not the security boundary. The hard read-only guarantee comes from the Worker code: its MCP handler exposes only the two read methods and its router has no notification, approval, callback, webhook, or other side-effect route.

## What it does not provide

Remote v0.3 cannot:

- send notifications;
- request or resolve approvals;
- create choices;
- request refinements;
- wait for phone responses;
- call a messaging provider;
- mutate remote account state.

Former phone callback and webhook paths are intentionally absent.

## Durable Object

The Worker preserves the existing SQLite-backed `NofaxRequestStore` schema so an upgraded deployment can inspect durable request rows created by earlier experimental builds without a destructive migration.

The MCP-facing path is read-only:

- `getRequest` reads one existing request by ID;
- `listPending` selects only unresolved, unexpired rows;
- listing does not perform lazy cleanup or another hidden write;
- MCP projections omit callback hashes/capabilities, prompt text, titles, and allowed-decision internals.

Legacy mutation methods may remain inside the Durable Object implementation for schema/backward compatibility, but no remote route or MCP tool can reach them.

## Requirements

- Node.js 22 or newer for Worker development.
- A Cloudflare account with Workers enabled.
- Wrangler authentication.
- One high-entropy `NOFAX_REMOTE_KEY` secret.

No ntfy, Telegram, WhatsApp, SMS, or other phone-provider configuration is required for the remote Worker.

## Deploy

From `worker/`:

```bash
npm ci
npx wrangler login
npx wrangler secret put NOFAX_REMOTE_KEY
npm run check
npm run deploy
```

Keep `NOFAX_REMOTE_KEY` out of source, `wrangler.jsonc`, `.env`, `.dev.vars`, CI output, screenshots, and issue text.

## Connect an MCP client

Preferred mode:

```text
https://<worker>.workers.dev/mcp
Authorization: Bearer <NOFAX_REMOTE_KEY>
```

Compatibility mode when a client cannot attach a static header:

```text
https://<worker>.workers.dev/mcp/<NOFAX_REMOTE_KEY>
```

The full capability URL is itself a bearer secret. Prefer the Authorization header when possible.

After authentication, Nofax normalizes the request internally to `/mcp` before handing it to the MCP server.

## Security boundary

The remote Worker is read-only by construction, not by prompt instruction:

1. only two MCP tools are registered;
2. the handler object exposes only `getRequest` and `listPending`;
3. the router exposes only health and MCP routes;
4. no phone-provider transport exists in the Worker source;
5. list reads do not delete expired rows;
6. returned request projections omit capability-bearing fields.

`NOFAX_REMOTE_KEY` is still a sensitive bearer credential because it controls access to request metadata. Rotate it if exposed.

The single deployment-wide key is intended only for private/single-user use. A public multi-user service would require a proper delegated authentication/authorization design instead.

## Development

```bash
npm ci
npm run check
```

Individual gates:

```bash
npm run typecheck
npm test
npx wrangler deploy --dry-run
```

CI also runs `npm audit --omit=dev --audit-level=high` against the production dependency graph.

The final protocol qualification should use an MCP client/Inspector to verify that the deployed endpoint exposes exactly the two expected read-only tools and that unauthenticated `/mcp` requests are rejected.

See [`../docs/remote-mcp.md`](../docs/remote-mcp.md) and [`../SECURITY.md`](../SECURITY.md).
