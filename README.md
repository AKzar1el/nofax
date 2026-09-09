# Nofax

**Remote human approval, refinement, and phone notifications for AI agents.**

Nofax lets coding agents and automations ask for your attention on an iPhone or Android phone through [ntfy](https://ntfy.sh/). Supported workflows can receive **Allow**, **Deny**, explicit choices, or free-text refinement back from the phone.

No Nofax account. No SMS provider. No WhatsApp Business API. No paid AI API. No hosted Nofax backend. No inbound port on your machine.

> **Status:** `0.2.0` release candidate. Claude Code and Codex permission hooks are bidirectional. The generic CLI and MCP server support durable approval/choice/refinement workflows. Gemini CLI remains notification-only where its documented hook is advisory-only.

## Why Nofax

Most agent notification tools stop here:

```text
agent -> phone
```

Nofax adds the return path without tying the transport to one model:

```text
Claude Code ---\
Codex ---------+--> Nofax --> ntfy --> phone
MCP hosts -----+                 |       |
scripts -------/                 |   Allow / Deny / Refine
                                 |       |
                                 +-------+
                                     |
                              durable request
                                     |
                               agent continues
```

Agent-specific hook schemas stay in thin adapters. The ntfy transport and durable interaction core do not know which model created the request.

## Features

- **Bidirectional Claude Code approvals** through `PermissionRequest` hooks.
- **Bidirectional Codex approvals** through `PermissionRequest` hooks.
- **Provider-neutral MCP server** via `nofax mcp`.
- **Durable human waits** that survive MCP/client disconnects.
- **Free-text refinement** through an iOS Shortcut and one-time ntfy callback topic.
- **Phone confirmation** after accepted Allow/Deny/choice/refinement responses.
- **Generic CLI** for scripts, scheduled jobs, CI helpers, and local automations.
- **Choice primitive** with up to three ntfy notification actions.
- **No callback server**; phone responses publish directly to one-time ntfy topics.
- **No persistent auto-approve**.
- **Fail closed**: pending, timeout, malformed responses, and network failures never become approval.
- **Known secret-key redaction** and bounded notification payloads.
- **Self-hosted ntfy support** for sensitive environments.
- Uses the official stable MCP TypeScript server SDK v2.

## Requirements

- Node.js 20 or newer.
- The free ntfy app on your phone.
- Internet access when using the public `https://ntfy.sh` service.
- For free-text refinement on iPhone: one Apple Shortcut named **Nofax Refine**.

## Install

Until the npm registry release is published, install directly from GitHub:

```bash
npm install -g https://github.com/AKzar1el/nofax.git
```

To update an existing global install after a new Nofax release:

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

The topic name is a bearer secret on anonymous ntfy servers. Keep it private. If it is exposed, rotate it:

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

The command returns stable JSON:

```json
{"decision":"allow"}
```

or:

```json
{"decision":"deny"}
```

After Nofax records the decision, it sends a best-effort confirmation notification such as **Approved** or **Denied**. Confirmation delivery does not change the already-recorded decision.

### Free-text refinement

After creating the iOS Shortcut described below:

```bash
nofax refine --title "Refine draft" "Tell me what to change"
```

The phone opens the Shortcut, asks for text, and Nofax returns:

```json
{"decision":"refine","text":"Make it shorter and mention the deadline."}
```

## Nofax Refine iOS Shortcut

Create one Shortcut named exactly:

```text
Nofax Refine
```

Configure it to:

1. Receive **Text** input from the `shortcuts://run-shortcut` URL.
2. Convert the input text to a dictionary/JSON object.
3. Read `requestId` and `callbackUrl` from that object.
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

## MCP server

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

### Durable wait semantics

Nofax deliberately does **not** keep one MCP call open forever.

A request tool creates a durable local request and immediately returns a `requestId` with `status: "pending"`. The model is instructed to call `nofax_wait_for_response`. Each wait call long-polls for at most 240 seconds.

If no phone response exists yet, Nofax returns another pending result containing an explicit instruction to call `nofax_wait_for_response` again with the same request ID. The model must repeat this until a terminal response arrives or the user explicitly changes/cancels the goal.

```text
request approval
      |
      v
{ status: pending, requestId }
      |
      v
nofax_wait_for_response  <= 240 s
      |
      +--> pending -> call wait again
      |
      +--> allow  -> continue within existing authority
      +--> deny   -> do not perform guarded action
      +--> refine -> apply text; request a fresh approval if still required
```

Pending request metadata is stored under `~/.nofax/requests/`, so a client/MCP process disconnect does not erase the human decision gate. Secret one-time response topics remain local and are never exposed in MCP tool results.

There is currently no portable MCP mechanism that lets an arbitrary MCP server force every host/model to start a fresh model turn after an unsolicited phone event. Durable polling is therefore Nofax's robust baseline. Hosts can later add wake integration, and MCP Tasks can be adopted when the target client supports that extension, without replacing the durable request core.

## Codexify

Codexify can bridge Nofax as a local stdio MCP server. Add an explicit entry to your user-level Codexify config (normally `~/.codexify/codexify.config.json`):

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

`toolTimeoutSec: 270` intentionally sits above Nofax's 240-second bounded long-poll window. Codexify applies this timeout to each forwarded upstream tool call.

After restarting/refreshing Codexify, the Nofax tools should appear with names such as:

```text
nofax__nofax_request_approval
nofax__nofax_wait_for_response
```

The exact downstream prefix depends on the bridge exposure mode.

A good first live test is:

> Send me a Nofax approval asking whether to continue the test. Do not continue until I answer on my phone.

The model should create the request, call the wait tool repeatedly while pending, then continue only after your terminal response.

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

For sensitive prompts or source code, use a trusted self-hosted ntfy instance:

```bash
nofax init --server https://ntfy.example.com --force
```

Nofax accepts HTTP or HTTPS servers, but HTTPS should be used across untrusted networks.

## Security model

Nofax is an interaction transport, not an authorization policy engine.

- The originating agent remains authoritative about which operations require human approval.
- A pending request is **not** approval.
- Timeout, network failure, malformed responses, or client disconnect never become approval.
- Every phone response is correlated to a random request ID and one-time response topic.
- The phone topic is generated from 192 bits of randomness.
- Durable response topics are stored locally and never returned by MCP tools.
- Object keys resembling credentials are redacted before rendering.
- Free-form strings can still contain secrets; Nofax does not claim semantic secret detection or end-to-end encryption.
- Anonymous ntfy topic names are bearer capabilities.

Read [SECURITY.md](SECURITY.md) before using public ntfy for sensitive work.

## Configuration

Default config: `~/.nofax/config.json`.

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

The package exports the transport and durable handler core:

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

- No hosted Nofax backend.
- No paid model API.
- No SMS, WhatsApp, or Viber dependency.
- No persistent `always approve` policy.
- No arbitrary remote shell endpoint.
- No claim that an MCP server can universally wake/re-run every model host from an unsolicited phone ping.
- No claim of bidirectional Gemini support until its upstream permission contract supports it cleanly.

## Roadmap

- MCP Tasks optimization when host support is sufficiently interoperable.
- Optional host-specific wake adapters where they can be implemented without a hosted service.
- OpenCode and Hermes adapters after their decision contracts are pinned and tested.
- Optional authenticated ntfy setup helpers.
- Signed releases and npm registry publication.

## Development

```bash
npm ci
npm test
npm run check
npm pack --dry-run
```

Tests use Node's built-in test runner and mock the ntfy boundary; normal test runs do not require a live phone.

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [docs/architecture.md](docs/architecture.md).

## Prior art

Nofax builds on ideas demonstrated by projects such as `claude-remote-approver` and multi-agent notification tools, but implements its own provider-neutral interaction/durability layer rather than vendoring their source.

## License

MIT. See [LICENSE](LICENSE).
