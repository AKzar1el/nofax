# Nofax

[![CI](https://github.com/AKzar1el/nofax/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/AKzar1el/nofax/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js >=20](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](package.json)
[![MCP](https://img.shields.io/badge/MCP-compatible-6f42c1)](https://modelcontextprotocol.io/)

**Human-in-the-loop approvals and notifications for AI coding agents, without running a Nofax SaaS.**

Nofax is a small open-source bridge between an agent and a human. Local mode can pause an AI workflow, notify your phone, and return an explicit decision. An optional self-deployed Cloudflare Worker exposes a deliberately narrower remote MCP surface for one-way notifications and safe request inspection.

No Nofax account. No paid model API. No inbound port on your machine. MIT licensed.

> **Current status:** local Nofax is `0.2.0`. The optional Cloudflare Worker is the upcoming `0.3.0` remote surface and is developed alongside the local package.

## Why Nofax

Agent workflows increasingly need a clean answer to one question: **when automation reaches a human decision boundary, how does it ask without pretending that silence means approval?**

Nofax keeps that boundary explicit:

- pending is never approval;
- timeout and transport failure fail closed;
- the first accepted terminal response wins;
- agent-specific hook schemas stay isolated in adapters;
- remote access is intentionally narrower than local access;
- Nofax does not grant authority the calling agent did not already have.

## Two operating modes

| Capability | Local Nofax `0.2` | Remote Worker `0.3` |
| --- | --- | --- |
| Transport | stdio / CLI hooks | MCP Streamable HTTP |
| One-way notification | Yes | Yes |
| Allow / Deny | Yes | No |
| Explicit choices | Yes | No |
| Free-text refinement | Yes | No |
| Wait for human response | Yes | No |
| Read request metadata | Yes | Yes |
| Durable state | Local files | Existing SQLite Durable Object rows |
| Hosted by Nofax | No | No — self-deployed Worker |
| Remote authentication | Local process boundary | Private bearer key |

The remote Worker is **not** a hosted remote-approval service. It can send an informational notification and inspect existing request state, but it has no approval callback, choice, refinement, wait, webhook, or arbitrary remote-write endpoint.

## Quick start

### 1. Install

Until a registry release is published:

```bash
npm install -g https://github.com/AKzar1el/nofax.git
```

Requires Node.js 20 or newer.

### 2. Initialize

```bash
nofax init
```

Nofax creates `~/.nofax/config.json` and generates a high-entropy notification topic. With the default transport, subscribe to the displayed topic in the ntfy mobile app.

### 3. Test

```bash
nofax test
```

### 4. Use it

```bash
nofax notify --title "Build finished" "All tests passed"
nofax approve --title "Deploy?" "Release 1.4.0 is ready"
nofax refine --title "Refine draft" "Tell me what to change"
```

An approval resolves to stable terminal JSON:

```json
{"decision":"allow"}
```

or:

```json
{"decision":"deny"}
```

If the request is still pending, times out, disconnects, or hits a transport error, Nofax never converts that condition into approval.

## MCP

Start the local stdio MCP server:

```bash
nofax mcp
```

Local MCP exposes:

- `nofax_notify`
- `nofax_request_approval`
- `nofax_request_choice`
- `nofax_request_refinement`
- `nofax_wait_for_response`
- `nofax_get_request`
- `nofax_list_pending`

Interactive requests return a durable request ID. `nofax_wait_for_response` performs a bounded wait; callers must repeat the wait while the request remains pending rather than infer approval.

## Agent integrations

### Claude Code

Use Nofax as a local `PermissionRequest` hook in `~/.claude/settings.json`:

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

### Codex

Enable hooks in `~/.codex/config.toml`:

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

### Gemini CLI

Gemini integration is notification-only where the upstream hook contract is advisory:

```bash
nofax hook gemini
```

Nofax does not claim bidirectional permission control where the host does not expose a suitable decision contract.

## Optional remote Cloudflare Worker

The `worker/` package provides a private, self-deployed MCP endpoint:

```text
remote MCP client
       |
       | authenticated Streamable HTTP
       v
Cloudflare Worker
       |
       +--> nofax_notify ------> ntfy ------> phone
       |
       +--> SQLite Durable Object
              |
              +--> get request metadata
              +--> list pending requests
```

It exposes exactly three tools:

- `nofax_notify` — one-way notification only;
- `nofax_get_request` — read one safe request projection;
- `nofax_list_pending` — read unresolved, unexpired request projections.

Deploy from `worker/`:

```bash
npm ci
npx wrangler login
npx wrangler secret put NOFAX_REMOTE_KEY
npx wrangler secret put NTFY_TOPIC
npm run check
npm run deploy
```

Preferred MCP connection:

```text
https://<worker>.workers.dev/mcp
Authorization: Bearer <NOFAX_REMOTE_KEY>
```

Clients that cannot attach a static authorization header can use the compatibility capability path:

```text
https://<worker>.workers.dev/mcp/<NOFAX_REMOTE_KEY>
```

Treat the complete capability URL like a password.

See [`docs/remote-mcp.md`](docs/remote-mcp.md) for deployment, threat boundaries, and qualification details.

### Important: public ntfy + serverless egress

The default public `ntfy.sh` service applies publisher quotas. Serverless platforms such as Cloudflare Workers may use shared outbound IP space, so a Worker can receive an ntfy `42908` daily-quota response even when that individual Worker has sent very little traffic. That limit is imposed by ntfy, not by the Cloudflare Workers request quota.

For reliability-sensitive deployments, use a notification provider whose quota is tied to your own authenticated account/identity, or operate a trusted self-hosted transport. Do not build a critical workflow around anonymous public-topic quota assumptions.

## Security model

Nofax is a transport and human-interaction component, **not an authorization policy engine**.

Local mode:

- pending, timeout, disconnect, malformed state, and network failure never mean approval;
- the first valid terminal response wins;
- notification topics and one-time response topics are capabilities;
- public ntfy is not end-to-end encrypted from the provider;
- redaction is best-effort and cannot reliably identify secrets embedded in arbitrary free-form text.

Remote mode:

- only explicit `nofax_notify` performs an external messaging side effect;
- request-inspection operations are read-only and do not perform hidden cleanup writes;
- remote approval, callback, webhook, refinement, choice, and wait surfaces are absent;
- `NOFAX_REMOTE_KEY` is a bearer credential;
- remote projections omit callback capabilities, prompt/message text, and internal allowed-decision lists.

Read [`SECURITY.md`](SECURITY.md) before using Nofax with sensitive information.

## Configuration

Default local config lives at `~/.nofax/config.json`:

```json
{
  "version": 1,
  "server": "https://ntfy.sh",
  "topic": "nofax_<random>",
  "timeoutSeconds": 300
}
```

Override the home directory with `NOFAX_HOME`:

```bash
NOFAX_HOME=/path/to/nofax-home nofax config
```

Use another ntfy-compatible server with:

```bash
nofax init --server https://ntfy.example.com --force
```

## Development

Local package:

```bash
npm ci
npm run check
npm test
npm pack --dry-run
```

Remote Worker:

```bash
cd worker
npm ci
npm run check
```

CI qualifies Node.js 20, 22, and 24 for the local package. The Worker gate runs TypeScript, Vitest, a production-dependency audit, and a Wrangler deployment dry-run.

## Project docs

- [`docs/architecture.md`](docs/architecture.md) — trust boundaries and data flow
- [`docs/remote-mcp.md`](docs/remote-mcp.md) — remote Worker deployment and qualification
- [`SECURITY.md`](SECURITY.md) — security assumptions and vulnerability reporting
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — contribution and test expectations
- [`CHANGELOG.md`](CHANGELOG.md) — release history

## Non-goals

Nofax deliberately does not provide:

- a Nofax-operated approval SaaS;
- a paid model API dependency;
- persistent `always approve` policy;
- an arbitrary remote shell endpoint;
- a public multi-user Worker behind one shared deployment key;
- a claim that MCP annotations themselves are a security boundary.

## License

MIT © Tomi Šeregi. See [`LICENSE`](LICENSE).
