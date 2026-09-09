# Nofax

**Remote human approval, refinement, and phone notifications for AI agents.**

Nofax lets coding agents and automations ask for your attention on an iPhone or Android phone through [ntfy](https://ntfy.sh/). Supported workflows can receive **Allow**, **Deny**, explicit choices, or free-text refinement back from the phone.

No Nofax account. No SMS provider. No WhatsApp Business API. No paid AI API. No Nofax-operated backend. No inbound port on your machine.

> **Status:** local Nofax `0.2.0` is the current package version. The optional Cloudflare remote MCP transport is the `0.3.0` release candidate and remains marked unreleased until live qualification and publication are complete.

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
remote MCP client -> your Cloudflare Worker -> ntfy -> phone
                            ^                          |
                            | durable callback        |
                            +--------------------------+
```

The optional `worker/` package runs in **your Cloudflare account**. It uses stateless Streamable HTTP for MCP and a SQLite-backed Durable Object for pending human-response state. It is designed for private single-user use.

See [Remote MCP on Cloudflare Workers](docs/remote-mcp.md).

## Features

- **Bidirectional Claude Code approvals** through `PermissionRequest` hooks.
- **Bidirectional Codex approvals** through `PermissionRequest` hooks.
- **Notification-only Gemini CLI adapter** where its upstream hook is advisory-only.
- **Provider-neutral local MCP server** via `nofax mcp`.
- **Optional remote MCP Worker** with the same seven public tools and terminal semantics.
- **Durable human waits** that survive MCP/client interruption.
- **One-tap Allow/Deny** on the phone.
- **Explicit choices** with up to three compact actions.
- **Free-text refinement**:
  - local mode: iOS Shortcut + one-time ntfy callback topic;
  - remote mode: Worker-hosted no-JavaScript browser form.
- **Phone confirmation** after accepted terminal responses.
- **Generic CLI** for scripts, scheduled jobs, CI helpers, and automations.
- **No persistent auto-approve**.
- **Fail closed**: pending, timeout, malformed state, expiry, and network failures never become approval.
- **Known secret-key redaction** and bounded payloads.
- **Self-hosted ntfy support** for sensitive environments.

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
- The same ntfy phone subscription.

Cloudflare documents SQLite-backed Durable Objects as available on the Workers Free plan, subject to current limits.

## Install local Nofax

Until the npm registry release is published, install directly from GitHub:

```bash
npm install -g https://github.com/AKzar1el/nofax.git
```

Updating uses the same command:

```bash
npm install -g https://github.com/AKzar1el/nofax.git
```

## 60-second phone setup

### 1. Initialize Nofax

```bash
nofax init
```

Nofax creates `~/.nofax/config.json` and prints a private topic URL:

```text
https://ntfy.sh/nofax_<random-secret-topic>
```

### 2. Subscribe on your phone

Install ntfy, subscribe to the printed topic, and allow notifications.

The topic name is a bearer secret on anonymous ntfy servers. Keep it private. If exposed, rotate it:

```bash
nofax init --force
```

### 3. Verify the connection

```bash
nofax test
```

Your phone should receive **Nofax is connected**.

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

Remote Worker users do **not** need this Shortcut; remote Refine uses the Worker-hosted browser form.

For local refinement, create one Shortcut named exactly:

```text
Nofax Refine
```

Configure it to:

1. Receive **Text** input from the `shortcuts://run-shortcut` URL.
2. Convert the input text to a dictionary/JSON object.
3. Read `requestId` and `callbackUrl`.
4. Use **Ask for Input** with a prompt such as `What should I change?`.
5. Use **Get Contents of URL** on `callbackUrl` with method **POST** and a JSON body containing:

```json
{
  "v": 1,
  "requestId": "<requestId from input>",
  "decision": "refine",
  "text": "<Ask for Input result>"
}
```

6. Optionally show a local notification such as `Refinement sent`.

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

Deploy from that directory:

```bash
npm ci
npx wrangler login
npx wrangler secret put NTFY_TOPIC
npx wrangler secret put NOFAX_REMOTE_KEY
npm test
npm run deploy
```

`NTFY_TOPIC` is the private ntfy topic subscribed on your phone. `NOFAX_REMOTE_KEY` must be a high-entropy secret generated outside the repository.

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

- **Allow** -> direct one-tap Worker callback.
- **Deny** -> direct one-tap Worker callback.
- **Choice** -> direct option callback.
- **Refine** -> opens a small Worker-hosted browser page with one textarea.

Remote callback tokens are fresh per request, expire after 24 hours, and are stored only as SHA-256 hashes. The phone callback URL never contains `NOFAX_REMOTE_KEY`.

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

After restarting or refreshing Codexify, Nofax tools should appear with downstream-prefixed names such as:

```text
nofax__nofax_request_approval
nofax__nofax_wait_for_response
```

A good first live test is:

> Send me a Nofax approval asking whether to continue the test. Do not continue until I answer on my phone.

The model should create the request, call the wait tool repeatedly while pending, then continue only after the terminal phone response.

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

Current Codex `PermissionRequest` hooks run before the native local approval UI. If Nofax times out or transport fails, it emits no decision so Codex can continue to its normal approval path.

## Gemini CLI

Gemini's documented `Notification` hook is advisory/observability-oriented. Nofax forwards those notifications but does not claim remote permission granting where the upstream contract does not provide it.

```text
nofax hook gemini
```

## Self-hosted ntfy

For sensitive local prompts or source code:

```bash
nofax init --server https://ntfy.example.com --force
```

For the remote Worker, change `vars.NTFY_SERVER` in `worker/wrangler.jsonc` to the trusted server before deployment.

Nofax accepts HTTP or HTTPS servers, but HTTPS should be used across untrusted networks.

## Security model

Nofax is an interaction transport, not an authorization policy engine.

- The originating agent remains authoritative about which operations require human approval.
- A pending request is **not** approval.
- Timeout, network failure, malformed responses, expiry, or client disconnect never become approval.
- The first valid terminal response wins.
- An Allow result permits only what the caller was already authorized to do.
- The local phone topic and remote MCP key are bearer secrets.
- Local response topics and remote callback tokens are one-time capabilities.
- Remote callback token material is stored only as a SHA-256 hash.
- Remote Refine text transits Cloudflare; ntfy receives notification summaries and callback URLs.
- Public ntfy is not application-level end-to-end encrypted from the service operator.
- Object keys resembling credentials are redacted before rendering where supported.
- Free-form strings can still contain secrets; Nofax does not claim semantic secret detection.

Read [SECURITY.md](SECURITY.md) before using Nofax for sensitive work.

## Configuration

Default local config: `~/.nofax/config.json`.

Override the config directory:

```bash
NOFAX_HOME=/path/to/nofax-home nofax config
```

Current config schema:

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
- No SMS, WhatsApp, or Viber dependency.
- No persistent `always approve` policy.
- No arbitrary remote shell endpoint.
- No claim that an MCP server can universally wake/re-run every model host from an unsolicited phone ping.
- No claim of bidirectional Gemini support until its upstream permission contract supports it cleanly.
- No claim that the private v0.3 Worker key is sufficient for public multi-user hosting; OAuth 2.1 is the hardening path there.

## Roadmap

- Finish v0.3 live Cloudflare + real-phone qualification.
- MCP Tasks optimization when host support is sufficiently interoperable.
- Optional host-specific wake adapters where they can be implemented without a Nofax-operated service.
- OpenCode and Hermes adapters after their decision contracts are pinned and tested.
- Optional authenticated ntfy setup helpers.
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
