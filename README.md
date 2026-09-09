# Nofax

**Human approval for local AI agents, with an optional read-only remote MCP inspector.**

Nofax is a small, open-source human-attention bridge. The current local package can notify a phone and collect explicit human decisions through ntfy. The optional Cloudflare Worker is deliberately narrower: it exposes only read-only inspection tools over remote MCP and has no notification, approval, callback, or external-write surface.

No Nofax account. No paid AI API. No Nofax-operated SaaS. No inbound port on your machine.

> **Status:** local Nofax `0.2.0` is the current package version. The optional read-only Cloudflare MCP Worker is the `0.3.0` release candidate. Source/CI qualification is complete; an existing older Worker deployment must be redeployed before its live tool surface reflects this read-only build.

## Local Nofax

```text
agent / MCP host -> local Nofax -> ntfy -> phone
                         ^                 |
                         | human response  |
                         +-----------------+
```

Local Nofax provides:

- generic `notify`, `approve`, and `refine` CLI commands;
- Claude Code `PermissionRequest` integration;
- Codex `PermissionRequest` integration;
- notification-only Gemini CLI integration;
- a provider-neutral local stdio MCP server;
- durable human-response state under `~/.nofax/requests/`;
- explicit Allow/Deny and choices;
- bounded repeat-until-terminal waits;
- fail-closed behavior on timeout, malformed state, or transport failure.

### Install

Until a registry release is published:

```bash
npm install -g https://github.com/AKzar1el/nofax.git
```

Requirements: Node.js 20 or newer and the ntfy app when using the default phone transport.

### Initialize

```bash
nofax init
```

Nofax creates `~/.nofax/config.json` and generates a high-entropy topic. Subscribe to the displayed topic in the ntfy phone app, then test it:

```bash
nofax test
```

Treat an anonymous public ntfy topic as a bearer secret. Rotate an exposed topic with:

```bash
nofax init --force
```

### Generic CLI

```bash
nofax notify --title "Build finished" "All tests passed"
nofax approve --title "Deploy?" "Release 1.4.0 is ready"
nofax refine --title "Refine draft" "Tell me what to change"
```

An approval returns stable terminal JSON such as:

```json
{"decision":"allow"}
```

or:

```json
{"decision":"deny"}
```

Pending, timeout, network failure, malformed state, or client disconnect never imply approval.

## Local MCP server

Start the local stdio server with:

```bash
nofax mcp
```

The local server exposes seven tools:

- `nofax_notify`
- `nofax_request_approval`
- `nofax_request_choice`
- `nofax_request_refinement`
- `nofax_wait_for_response`
- `nofax_get_request`
- `nofax_list_pending`

Interactive requests return a durable request ID. `nofax_wait_for_response` waits for at most 240 seconds per call; if the request is still pending, the caller must call it again with the same request ID instead of inferring approval.

## Optional remote MCP Worker — read-only v0.3

The `worker/` package is intentionally **read-only**.

```text
remote MCP client
       |
       | authenticated Streamable HTTP
       v
Cloudflare Worker
       |
       v
SQLite Durable Object
       |
       +--> read existing request metadata
       +--> list unresolved request handles
```

It exposes exactly two MCP tools:

- `nofax_get_request`
- `nofax_list_pending`

Both are registered with MCP read-only annotations. More importantly, read-only behavior is enforced by the implementation itself: the remote MCP handler has no create, notify, approval, choice, refinement, wait, callback, or provider transport method.

The Worker has only these public routes:

- `GET|HEAD /healthz`
- authenticated `/mcp`
- authenticated `/mcp/<NOFAX_REMOTE_KEY>` compatibility mode

Former `/telegram/webhook` and `/r/*` callback routes do not exist and return 404.

### What remote mode cannot do

Remote v0.3 cannot:

- send a phone notification;
- create an approval or choice;
- request refinement;
- wait for a human response;
- resolve or delete request state;
- call Telegram, ntfy, WhatsApp, SMS, or another messaging provider;
- mutate an external account or service.

It is an inspection endpoint only. Local Nofax remains the interactive human-approval implementation.

### Deploy remote read-only mode

Requirements:

- Node.js 22 or newer for Worker development;
- a Cloudflare account with Workers enabled;
- Wrangler authentication.

From `worker/`:

```bash
npm ci
npx wrangler login
npx wrangler secret put NOFAX_REMOTE_KEY
npm run check
npm run deploy
```

No phone-provider secret is required.

Preferred MCP connection:

```text
https://<worker>.workers.dev/mcp
Authorization: Bearer <NOFAX_REMOTE_KEY>
```

Compatibility mode for clients that cannot attach a static header:

```text
https://<worker>.workers.dev/mcp/<NOFAX_REMOTE_KEY>
```

The full capability URL is a bearer secret. Prefer the Authorization header when your MCP host supports one, and rotate the key if the complete URL is exposed.

See [`docs/remote-mcp.md`](docs/remote-mcp.md) for the complete remote architecture and qualification checklist.

## Claude Code

Add Nofax to `~/.claude/settings.json` as a local `PermissionRequest` hook:

```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "matcher": ".*",
        "hooks": [
          {
            "type": "command",
            "command": "nofax hook claude"
          }
        ]
      }
    ]
  }
}
```

Allow/Deny is returned through Claude Code's native hook contract. Nofax does not create persistent permission rules.

## Codex

Enable hooks in `~/.codex/config.toml` when needed:

```toml
[features]
hooks = true
```

Then configure `~/.codex/hooks.json`:

```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "matcher": ".*",
        "hooks": [
          {
            "type": "command",
            "command": "nofax hook codex",
            "statusMessage": "Waiting for Nofax approval"
          }
        ]
      }
    ]
  }
}
```

If Nofax times out or its local transport fails, it emits no approval decision so the upstream tool can continue with its own normal permission flow.

## Gemini CLI

Gemini's Notification hook is treated as notification-only by the current Nofax adapter:

```text
nofax hook gemini
```

Nofax does not claim bidirectional permission control where the upstream hook contract does not provide it cleanly.

## Self-hosted ntfy for local mode

For sensitive local workflows:

```bash
nofax init --server https://ntfy.example.com --force
```

Use HTTPS over untrusted networks. Public anonymous ntfy topics are capabilities, not end-to-end encryption.

## Security model

Nofax is a transport/inspection component, not an authorization policy engine.

Local mode:

- pending is never approval;
- the first accepted terminal response wins;
- an Allow result never expands the caller's existing authority;
- local ntfy topics and one-time response topics are capabilities;
- secret redaction is best-effort and cannot reliably detect credentials embedded in arbitrary free-form text.

Remote read-only mode:

- only two read methods are registered;
- MCP annotations accurately mark them read-only, non-destructive, idempotent, and closed-world;
- hard enforcement does not depend on those annotations;
- the Worker exposes no phone/provider/callback route;
- list operations do not perform hidden cleanup writes;
- `NOFAX_REMOTE_KEY` is a bearer credential and must remain private;
- remote responses omit callback hashes, callback capabilities, request prompt text, and allowed-decision internals.

Read [`SECURITY.md`](SECURITY.md) before using Nofax with sensitive information.

## Local configuration

Default local config: `~/.nofax/config.json`.

Override its directory with `NOFAX_HOME`:

```bash
NOFAX_HOME=/path/to/nofax-home nofax config
```

Current local schema:

```json
{
  "version": 1,
  "server": "https://ntfy.sh",
  "topic": "nofax_<random>",
  "timeoutSeconds": 300
}
```

## Deliberate non-goals

- No Nofax-operated approval SaaS.
- No paid model API requirement.
- No persistent `always approve` policy.
- No arbitrary remote shell endpoint.
- No claim that MCP annotations are a security boundary.
- No remote phone/write action in the v0.3 Worker.
- No public multi-user remote hosting under one shared deployment key.

## Development

Local package:

```bash
npm ci
npm run check
npm test
npm pack --dry-run
```

Read-only Worker:

```bash
cd worker
npm ci
npm run check
```

The Worker gate includes TypeScript, Vitest, a production-dependency audit in CI, and a Wrangler deployment dry-run.

See [`CONTRIBUTING.md`](CONTRIBUTING.md), [`SECURITY.md`](SECURITY.md), [`docs/architecture.md`](docs/architecture.md), and [`docs/remote-mcp.md`](docs/remote-mcp.md).

## License

MIT. See [`LICENSE`](LICENSE).
