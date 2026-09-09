# Nofax

**Remote approvals and actionable phone notifications for coding agents.**

Nofax lets Claude Code, Codex, scripts, scheduled jobs, and other agent workflows ask for your attention on an iPhone or Android phone through [ntfy](https://ntfy.sh/). For supported agents, tapping **Allow** or **Deny** on the notification returns that decision to the waiting agent.

No Nofax account. No SMS provider. No WhatsApp Business API. No paid AI API. No inbound port on your machine.

> **Status:** early public release (`0.1.0`). Claude Code and Codex approvals are bidirectional. Gemini CLI support is notification-only because its documented `Notification` hook is observability-only.

## Why Nofax

Most agent notification projects solve only one half of the problem:

```text
agent -> phone
```

Nofax adds the return path while keeping the agent-specific logic isolated:

```text
Claude Code ---\
Codex ---------+--> Nofax core --> ntfy --> phone
scripts -------/                       |      |
                                      |   Allow / Deny
                                      |      |
                                      +------+
                                         |
                                  one-time response topic
                                         |
                                         +--> native agent hook result
```

The transport does not know what Claude or Codex is. Adapters translate native hook JSON into the same small Nofax interaction model.

## Features

- **Bidirectional Claude Code approvals** through `PermissionRequest` hooks.
- **Bidirectional Codex approvals** through `PermissionRequest` hooks.
- **Gemini CLI attention notifications** without claiming unsupported approval control.
- **Generic CLI** for scripts, cron jobs, CI helpers, and local automations.
- **Choice primitive** in the programmatic API, up to ntfy's three-action limit.
- **Zero runtime dependencies**; Node.js built-ins only.
- **No callback server**; phone actions POST directly to one-time ntfy response topics.
- **No persistent auto-approve** in v1.
- **Fail back to native approval** on timeout or transport failure.
- **Known secret-key redaction** and bounded notification payloads.
- **Self-hosted ntfy support** for sensitive environments.

## Requirements

- Node.js 20 or newer.
- The free [ntfy app](https://ntfy.sh/) on your phone.
- An internet connection when using the public `https://ntfy.sh` service.

## Install

Until an npm registry release is published, install directly from GitHub:

```bash
npm install -g https://github.com/AKzar1el/nofax.git
```

Or clone it and link the CLI locally:

```bash
git clone https://github.com/AKzar1el/nofax.git
cd nofax
npm link
```

## 60-second setup

### 1. Initialize Nofax

```bash
nofax init
```

Nofax creates `~/.nofax/config.json` and prints a private topic URL such as:

```text
https://ntfy.sh/nofax_<random-secret-topic>
```

### 2. Subscribe on your phone

Install ntfy, add the topic printed by `nofax init`, and allow notifications.

The topic name is a bearer secret on anonymous ntfy servers. Do not share it.

### 3. Verify the connection

```bash
nofax test
```

Your phone should receive **Nofax is connected**.

## Generic usage

Send a one-way notification:

```bash
nofax notify --title "Build finished" "All tests passed"
```

Ask for a decision:

```bash
nofax approve --title "Deploy production?" "Release 1.4.0 is ready"
```

The command waits for the phone response and writes stable JSON to stdout:

```json
{"decision":"allow"}
```

Possible decisions are `allow`, `deny`, and `timeout`. A timeout exits with code `3`; other CLI errors exit with code `1`.

## Claude Code

Claude Code documents a decision-capable `PermissionRequest` hook. Add Nofax to your user-level `~/.claude/settings.json`:

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

When Claude Code would ask for permission, Nofax sends the request to your phone. **Allow** or **Deny** is returned through Claude Code's documented hook output.

Nofax intentionally does not use Claude's persistent permission-update suggestions in v1. Every remote decision applies only to the current request.

Reference: [Claude Code hooks](https://code.claude.com/docs/en/hooks).

## Codex

Codex exposes a `PermissionRequest` command hook that can return `allow`, `deny`, or no decision. Hooks currently require the hooks feature to be enabled.

Add this to `~/.codex/config.toml` if hooks are not already enabled:

```toml
[features]
hooks = true
```

Then create or merge `~/.codex/hooks.json`:

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

Nofax emits only the currently supported Codex decision fields. It does **not** emit the reserved `updatedInput`, `updatedPermissions`, or `interrupt` fields.

### Codex UX caveat

Current Codex `PermissionRequest` hooks run before the native approval UI. While Nofax is waiting for a remote answer, the local approval prompt is not simultaneously available. If Nofax times out or fails, it returns no decision and Codex continues to its normal approval path.

Reference: [Codex hooks](https://developers.openai.com/codex/hooks).

## Gemini CLI

Gemini CLI's documented `Notification` hook is observability-only: it can report a `ToolPermission` alert but cannot grant the permission. Nofax therefore forwards those alerts to the phone without pretending it can approve them.

Configure the Gemini `Notification` hook to execute:

```text
nofax hook gemini
```

Use Gemini's current hook configuration format from the official docs when registering the command, because that surface is still evolving.

Reference: [Gemini CLI hooks](https://geminicli.com/docs/hooks/).

## Self-hosted ntfy

Public `ntfy.sh` is ideal for a zero-setup personal install. For private source code, production operations, or other sensitive prompts, run your own ntfy server and initialize Nofax against it:

```bash
nofax init --server https://ntfy.example.com --force
```

Nofax accepts HTTP or HTTPS ntfy servers, but HTTPS should be used across untrusted networks.

## Security model

Nofax is an **interaction transport**, not an authorization policy engine.

- The originating agent decides when approval is required.
- Nofax never turns a timeout or network failure into approval.
- Each approval uses a fresh random response topic and request ID.
- The phone topic is generated from 192 bits of randomness.
- Object keys that look like credentials (`token`, `password`, `api_key`, `authorization`, and similar) are redacted before rendering.
- Free-form commands can still contain secrets. Nofax does not claim semantic secret detection or end-to-end encryption.
- Anonymous ntfy topics are capability URLs: anyone who learns the topic may be able to read or publish to it.

Read [SECURITY.md](SECURITY.md) before using public ntfy for sensitive work.

## Configuration

Default config: `~/.nofax/config.json`.

Override the config directory:

```bash
NOFAX_HOME=/path/to/nofax-home nofax config
```

Config schema:

```json
{
  "version": 1,
  "server": "https://ntfy.sh",
  "topic": "nofax_<random>",
  "timeoutSeconds": 300
}
```

Regenerate the topic or change the server:

```bash
nofax init --force
nofax init --server https://ntfy.example.com --force
nofax init --timeout 120 --force
```

## Programmatic API

The package exports the same core used by the CLI:

```js
import { loadConfig, requestApproval } from 'nofax';

const config = await loadConfig();
const result = await requestApproval({
  config,
  title: 'Release ready',
  message: 'Deploy version 1.4.0?'
});

if (result.decision === 'allow') {
  // Continue your already-authorized workflow.
}
```

For three-way decisions:

```js
import { loadConfig, requestChoice } from 'nofax';

const config = await loadConfig();
const result = await requestChoice({
  config,
  title: 'Choose deployment',
  message: 'Select a target',
  options: [
    { value: 'staging', label: 'Staging' },
    { value: 'canary', label: 'Canary' },
    { value: 'cancel', label: 'Cancel' }
  ]
});
```

## What v1 deliberately does not do

- No hosted Nofax backend.
- No SMS, WhatsApp, or Viber integration.
- No paid model or notification API.
- No persistent `always approve` button.
- No arbitrary remote shell endpoint.
- No native free-text reply/refinement field inside an ntfy notification.
- No claim of bidirectional Gemini support while its documented notification hook is advisory-only.
- No MCP wrapper yet; a future MCP surface should reuse this exact core instead of creating a second transport.

## Roadmap

- OpenCode adapter after its permission reply contract is pinned and tested.
- Hermes and additional agent adapters through the same thin-adapter pattern.
- Optional iOS Shortcut / web reply surface for free-text refinement.
- MCP wrapper exposing `notify`, `approval`, `choice`, and future text input.
- Optional authenticated ntfy configuration helpers.
- Signed releases and npm registry publication.

## Development

```bash
npm test
npm run check
npm pack --dry-run
```

Nofax has no runtime dependencies. Tests use Node's built-in test runner and mock the ntfy HTTP boundary; they do not require a live phone or ntfy account.

See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/architecture.md](docs/architecture.md).

## Prior art

Nofax exists because several good projects solved adjacent pieces first. In particular, `claude-remote-approver` demonstrated the usefulness of ntfy action callbacks for Claude Code, while multi-agent notification projects demonstrated the value of small per-agent adapters. Nofax does not vendor their source; it generalizes the interaction boundary into its own implementation.

## License

MIT. See [LICENSE](LICENSE).
