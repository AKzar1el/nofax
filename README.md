# Nofax

**Remote human approval, refinement, and phone notifications for AI agents.**

Nofax gives agents and automations a small human-attention bridge. Local workflows use [ntfy](https://ntfy.sh/) for iPhone/Android notifications and decisions. The optional remote MCP Worker uses Telegram for reliable serverless phone delivery while keeping the same durable decision semantics.

No Nofax account. No SMS provider. No WhatsApp Business API. No paid AI API. No Nofax-operated backend. No inbound port on your machine.

> **Status:** local Nofax `0.2.0` is the current package version. The optional Cloudflare remote MCP transport is the `0.3.0` release candidate and remains unreleased until live qualification and publication are complete.

## Two ways to run Nofax

### Local

```text
agent / MCP host -> local Nofax -> ntfy -> phone
                         ^                 |
                         |  response       |
                         +-----------------+
```

The local CLI and stdio MCP server need no hosted Nofax component. Durable MCP requests live under `~/.nofax/requests/`.

### Remote

```text
remote MCP client -> your Cloudflare Worker -> Telegram -> phone
                            ^                            |
                            | durable webhook/result     |
                            +----------------------------+
```

The optional `worker/` package runs in **your Cloudflare account**. It uses stateless Streamable HTTP for MCP, a SQLite-backed Durable Object for pending human-response state, Telegram callback queries for one-tap decisions, and a tiny Worker-hosted form for Refine.

Remote mode is designed to stay free at normal private single-user usage: Nofax never enables Telegram paid broadcasts and has no paid fallback. If a free provider limit is reached, the operation fails closed.

See [Remote MCP on Cloudflare Workers](docs/remote-mcp.md).

## Features

- **Bidirectional Claude Code approvals** through `PermissionRequest` hooks.
- **Bidirectional Codex approvals** through `PermissionRequest` hooks.
- **Notification-only Gemini CLI adapter** where its upstream hook is advisory-only.
- **Provider-neutral local MCP server** via `nofax mcp`.
- **Optional remote MCP Worker** with the same seven public tools and terminal semantics.
- **Durable human waits** that survive MCP/client interruption.
- **One-tap Allow/Deny** on the phone.
- **Explicit choices** with up to three actions.
- **Free-text refinement**:
  - local mode: iOS Shortcut + one-time ntfy callback topic;
  - remote mode: Telegram Refine button -> Worker-hosted no-JavaScript browser form.
- **Phone confirmation** after accepted terminal responses.
- **Generic CLI** for scripts, scheduled jobs, CI helpers, and automations.
- **No persistent auto-approve**.
- **Fail closed**: pending, timeout, malformed state, expiry, and network failures never become approval.
- **Known secret-key redaction** and bounded payloads.
- **Self-hosted ntfy support** for sensitive local environments.

## Requirements

### Local Nofax

- Node.js 20 or newer.
- The free ntfy app on your phone.
- Internet access when using public `https://ntfy.sh`.
- For local free-text refinement on iPhone: one Apple Shortcut named **Nofax Refine**.

### Remote Worker

- Node.js 22 or newer for Worker development.
- A Cloudflare account with Workers enabled.
- Wrangler authentication.
- Telegram on your phone.
- One private Telegram bot created through `@BotFather`.

The remote Worker uses a SQLite-backed Durable Object and is designed for Cloudflare Workers Free limits. Nofax does not opt into Telegram paid broadcasts or Telegram Stars.

## Install local Nofax

Until the npm registry release is published, install directly from GitHub:

```bash
npm install -g https://github.com/AKzar1el/nofax.git
```

Updating uses the same command.

## Local phone setup

### 1. Initialize

```bash
nofax init
```

Nofax creates `~/.nofax/config.json` and prints a private topic URL:

```text
https://ntfy.sh/nofax_<random-secret-topic>
```

### 2. Subscribe

Install ntfy, subscribe to the printed topic, and allow notifications. The topic is a bearer secret on anonymous ntfy servers. If exposed, rotate it:

```bash
nofax init --force
```

### 3. Test

```bash
nofax test
```

## Generic CLI

One-way notification:

```bash
nofax notify --title "Build finished" "All tests passed"
```

Blocking approval:

```bash
nofax approve --title "Deploy production?" "Release 1.4.0 is ready"
```

Terminal stdout is stable JSON:

```json
{"decision":"allow"}
```

or:

```json
{"decision":"deny"}
```

After Nofax records a decision, it sends a best-effort confirmation notification. Confirmation delivery does not alter the already-recorded result.

### Local free-text refinement

```bash
nofax refine --title "Refine draft" "Tell me what to change"
```

With the local iOS Shortcut configured, Nofax can return:

```json
{"decision":"refine","text":"Make it shorter and mention the deadline."}
```

## Nofax Refine iOS Shortcut — local mode only

Remote Worker users do **not** need this Shortcut; remote Refine uses the Worker-hosted browser form opened from Telegram.

For local refinement, create one Shortcut named exactly:

```text
Nofax Refine
```

Configure it to receive Text input from the `shortcuts://run-shortcut` URL, parse the supplied JSON, ask for text, and POST the result to the supplied one-time callback URL as:

```json
{
  "v": 1,
  "requestId": "<requestId>",
  "decision": "refine",
  "text": "<your refinement>"
}
```

The callback URL is a one-time high-entropy ntfy response topic. Do not save or share it.

## Local MCP server

Start Nofax as a local stdio MCP server:

```bash
nofax mcp
```

It exposes:

- `nofax_notify`
- `nofax_request_approval`
- `nofax_request_choice`
- `nofax_request_refinement`
- `nofax_wait_for_response`
- `nofax_get_request`
- `nofax_list_pending`

### Durable local wait semantics

Nofax deliberately does **not** keep one MCP call open forever.

A request tool creates durable local state and immediately returns a `requestId` with `status: "pending"`. The model is instructed to call `nofax_wait_for_response`. Local waits are bounded to at most 240 seconds per call.

If no phone response exists yet, the result remains pending and explicitly instructs the model to call the wait tool again with the same request ID.

```text
request approval
      |
      v
{ status: pending, requestId }
      |
      v
nofax_wait_for_response <= 240 s
      |
      +--> pending -> call wait again
      |
      +--> allow  -> continue within existing authority
      +--> deny   -> do not perform guarded action
      +--> refine -> apply text; request fresh approval if still required
```

Pending request metadata is stored under `~/.nofax/requests/`, so an MCP/client disconnect does not erase the human decision gate. Secret one-time response topics remain local and are never exposed in MCP tool results.

## Remote MCP Worker — v0.3 release candidate

The optional remote transport is under [`worker/`](worker/).

### Telegram setup

1. Open the official `@BotFather` in Telegram and send `/newbot`.
2. Create the bot and keep its token private.
3. Open your new bot and send `/start`.
4. Before registering a webhook, call Telegram `getUpdates` and record:
   - `message.from.id` as `TELEGRAM_USER_ID`;
   - `message.chat.id` as `TELEGRAM_CHAT_ID`.
5. Generate high-entropy values for `TELEGRAM_WEBHOOK_SECRET` and `NOFAX_REMOTE_KEY`.

### Deploy

From `worker/`:

```bash
npm ci
npx wrangler login
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put TELEGRAM_USER_ID
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put NOFAX_REMOTE_KEY
npm run check
npm run deploy
```

Then register:

```text
https://<worker>.workers.dev/telegram/webhook
```

with Telegram `setWebhook`, passing the same `TELEGRAM_WEBHOOK_SECRET` as `secret_token` and `allowed_updates=["callback_query"]`.

Nofax never sets Telegram `allow_paid_broadcast=true`.

Preferred MCP connection:

```text
https://<worker>.workers.dev/mcp
Authorization: Bearer <NOFAX_REMOTE_KEY>
```

Compatibility mode for clients that cannot attach static headers:

```text
https://<worker>.workers.dev/mcp/<NOFAX_REMOTE_KEY>
```

The full capability URL is a bearer secret. Prefer the Authorization header when possible.

Remote MCP exposes the same seven tool names as local Nofax. Remote `nofax_wait_for_response` is capped at 20 seconds per call, so a pending caller repeats the wait until a terminal response appears.

### Remote phone behavior

```text
[ Allow ] [ Refine ] [ Deny ]
```

- **Allow** -> verified Telegram callback query -> durable `allow`.
- **Deny** -> verified Telegram callback query -> durable `deny`.
- **Choice** -> verified callback query -> exact stored option.
- **Refine** -> opens a small Worker-hosted browser page with one textarea.

Telegram callback handling verifies the webhook secret, exact configured user ID and chat ID, the one-time callback capability, and the stored allowed decision. Remote callback tokens expire after 24 hours and are stored only as SHA-256 hashes.

Read the full [remote deployment, security, and qualification guide](docs/remote-mcp.md).

## Codexify

Codexify can bridge the local stdio MCP server. Add an explicit entry to your user-level Codexify config, normally `~/.codexify/codexify.config.json`:

```json
{
  "mcpServers": {
    "nofax": {
      "command": "nofax",
      "args": ["mcp"],
      "type": "stdio",
      "mode": "direct",
      "startupTimeoutSec": 20,
      "toolTimeoutSec": 270
    }
  }
}
```

`toolTimeoutSec: 270` intentionally sits above Nofax's 240-second local long-poll window.

## Claude Code

Add Nofax to `~/.claude/settings.json` as a `PermissionRequest` hook:

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
            "statusMessage": "Waiting for Nofax remote approval"
          }
        ]
      }
    ]
  }
}
```

If Nofax times out or transport fails, it emits no decision so Codex can continue to its normal approval path.

## Gemini CLI

Gemini's documented `Notification` hook is advisory/observability-oriented. Nofax forwards those notifications but does not claim remote permission granting where the upstream contract does not provide it cleanly.

```text
nofax hook gemini
```

## Self-hosted ntfy

For sensitive **local** prompts or source code:

```bash
nofax init --server https://ntfy.example.com --force
```

Nofax accepts HTTP or HTTPS servers, but HTTPS should be used across untrusted networks. Remote Cloudflare mode uses Telegram by default rather than public ntfy.

## Security model

Nofax is an interaction transport, not an authorization policy engine.

- The originating agent remains authoritative about which operations require human approval.
- A pending request is **not** approval.
- Timeout, network failure, malformed responses, expiry, or client disconnect never become approval.
- The first valid terminal response wins.
- An Allow result permits only what the caller was already authorized to do.
- Local ntfy topics and remote MCP keys are bearer secrets.
- Local response topics and remote callback tokens are one-time capabilities.
- Remote callback token material is stored only as a SHA-256 hash.
- Remote Telegram callbacks require the configured webhook secret, Telegram user ID, and Telegram chat ID.
- Remote Refine text transits Cloudflare; Telegram receives request summaries and button/Refine controls.
- Nofax never enables paid Telegram broadcasts.
- Object keys resembling credentials are redacted before rendering where supported.
- Free-form strings can still contain secrets; Nofax does not claim semantic secret detection.

Read [SECURITY.md](SECURITY.md) before using Nofax for sensitive work.

## Configuration

Default local config: `~/.nofax/config.json`.

Override the config directory:

```bash
NOFAX_HOME=/path/to/nofax-home nofax config
```

Current local config schema:

```json
{
  "version": 1,
  "server": "https://ntfy.sh",
  "topic": "nofax_<random>",
  "timeoutSeconds": 300
}
```

## Programmatic API

The package exports the local transport and durable handler core:

```js
import { createMcpToolHandlers } from 'nofax';

const nofax = createMcpToolHandlers();
const pending = await nofax.requestApproval({
  title: 'Release ready',
  message: 'Deploy version 1.4.0?',
  allowRefine: true
});

let result = pending;
while (result.status === 'pending') {
  result = await nofax.waitForResponse({
    requestId: pending.requestId,
    waitSeconds: 240
  });
}
```

## Deliberate non-goals

- No Nofax-operated approval SaaS/backend.
- No paid model API.
- No paid notification fallback.
- No SMS, WhatsApp, or Viber dependency.
- No persistent `always approve` policy.
- No arbitrary remote shell endpoint.
- No claim that an MCP server can universally wake/re-run every model host from an unsolicited phone ping.
- No claim of bidirectional Gemini support until its upstream permission contract supports it cleanly.
- No claim that the private v0.3 Worker key is sufficient for public multi-user hosting; OAuth 2.1 is the hardening path there.

## Roadmap

- Finish v0.3 live Cloudflare + Telegram/iPhone qualification.
- MCP Tasks optimization when host support is sufficiently interoperable.
- Optional host-specific wake adapters where they can be implemented without a Nofax-operated service.
- OpenCode and Hermes adapters after their decision contracts are pinned and tested.
- Optional authenticated ntfy setup helpers for local mode.
- Signed releases and npm registry publication.

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

The Worker gate includes TypeScript, Vitest, and a Wrangler deployment dry-run. Normal automated tests do not require a live phone.

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), [docs/architecture.md](docs/architecture.md), and [docs/remote-mcp.md](docs/remote-mcp.md).

## Prior art

Nofax builds on ideas demonstrated by projects such as `claude-remote-approver` and multi-agent notification tools, but implements its own provider-neutral interaction/durability layer rather than vendoring their source.

## License

MIT. See [LICENSE](LICENSE).
