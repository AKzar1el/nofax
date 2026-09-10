# Nofax Remote Worker

Optional, self-deployed Cloudflare Workers transport for Nofax remote MCP access.

The Worker is designed for a **private, single-user deployment in your own Cloudflare account**. Nofax does not operate it as a hosted service.

Remote capabilities are intentionally narrower than local Nofax: the Worker can send a one-way notification and inspect existing request metadata, but it cannot create or resolve approvals, collect choices/refinements, wait for human responses, or accept callbacks/webhooks.

## Public surface

The Worker exposes only:

- `GET|HEAD /healthz`
- authenticated Streamable HTTP MCP at `/mcp`
- authenticated capability-path compatibility at `/mcp/<NOFAX_REMOTE_KEY>`

Remote MCP exposes exactly three tools:

- `nofax_notify` — one-way notification side effect;
- `nofax_get_request` — read one safe request projection;
- `nofax_list_pending` — read unresolved, unexpired request projections.

The two inspection tools are marked read-only, non-destructive, idempotent, and closed-world. `nofax_notify` is explicitly marked side-effecting, non-idempotent, non-destructive, and open-world.

MCP annotations are descriptive metadata, not the security boundary. The hard boundary is the actual registered tool/handler/router surface.

## What remote mode does not provide

Remote v0.3 cannot:

- create or resolve an approval;
- create a choice;
- request free-text refinement;
- wait for a phone response;
- accept human-response callbacks or webhooks;
- mutate Durable Object request state through MCP;
- expose an arbitrary remote shell or generic external-write primitive.

Former phone callback and webhook paths are intentionally absent.

## Durable Object

The Worker preserves the existing SQLite-backed `NofaxRequestStore` schema so an upgraded deployment can inspect durable request rows created by earlier experimental builds without a destructive migration.

The MCP-facing request-state path is observational:

- `getRequest` reads one existing request by ID;
- `listPending` selects only unresolved, unexpired rows;
- listing performs no lazy cleanup write;
- projections omit callback hashes/capabilities, prompt text, titles, and allowed-decision internals.

Legacy internal mutation methods may remain for schema/backward compatibility, but no public Worker route or MCP handler exposes them.

## Requirements

- Node.js 22 or newer for Worker development
- Cloudflare Workers enabled
- Wrangler authentication
- high-entropy `NOFAX_REMOTE_KEY` Worker secret
- `NTFY_TOPIC` Worker secret when using the included ntfy notification transport

The publisher defaults to `https://ntfy.sh` unless `NTFY_SERVER` is configured.

## Deploy

From `worker/`:

```bash
npm ci
npx wrangler login
npx wrangler secret put NOFAX_REMOTE_KEY
npx wrangler secret put NTFY_TOPIC
npm run check
npm run deploy
```

Keep `NOFAX_REMOTE_KEY` and `NTFY_TOPIC` out of source, `wrangler.jsonc`, `.env`, `.dev.vars`, CI output, screenshots, and issue text.

## Connect an MCP client

Preferred mode:

```text
https://<worker>.workers.dev/mcp
Authorization: Bearer <NOFAX_REMOTE_KEY>
```

Compatibility mode for clients that cannot attach a static header:

```text
https://<worker>.workers.dev/mcp/<NOFAX_REMOTE_KEY>
```

The complete capability URL is itself a bearer secret. Prefer the Authorization header whenever the MCP host supports it.

## Public ntfy quota caveat

The hosted `ntfy.sh` service applies publisher quotas independently of Cloudflare Workers. Cloudflare Workers may share outbound IP space with unrelated workloads, so ntfy can return `42908` (`daily message quota reached`) even when one Worker has published very little traffic.

That response comes from ntfy, not from exhaustion of your Cloudflare Worker request allowance. Reliability-sensitive deployments should use a provider with account-scoped quota/identity or a trusted self-hosted transport.

## Security boundary

Remote mode is structurally bounded:

1. only `nofax_notify`, `nofax_get_request`, and `nofax_list_pending` are registered;
2. only `nofax_notify` reaches the notification transport;
3. request inspection cannot create, resolve, or delete request state;
4. the public router exposes only health and authenticated MCP paths;
5. callback/webhook routes are absent;
6. returned request projections omit capability-bearing fields.

`NOFAX_REMOTE_KEY` remains a sensitive bearer credential. The single deployment-wide key is suitable only for private/single-user use; a shared service would require delegated per-user authentication and authorization.

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

CI also runs `npm audit --omit=dev --audit-level=high` against production dependencies.

Final deployed qualification should use an MCP client/Inspector to verify the exact three-tool surface and reject unauthenticated `/mcp` requests.

See [`../docs/remote-mcp.md`](../docs/remote-mcp.md) and [`../SECURITY.md`](../SECURITY.md).
