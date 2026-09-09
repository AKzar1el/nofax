# Nofax Architecture

## Purpose

Nofax is a provider-neutral human-interaction bridge for coding agents and automations. It sends actionable notifications to a phone through ntfy and translates the user's remote answer back into the originating agent's native approval contract.

The first release is deliberately small: one core interaction model, one ntfy transport, a generic CLI, native bidirectional adapters for Claude Code and Codex PermissionRequest hooks, and a notification-only Gemini CLI adapter. No paid API, hosted Nofax backend, database, account system, or persistent auto-approval policy is required.

## Design principles

1. **Provider-neutral core.** Agent-specific schemas stay in adapters. The transport only understands Nofax requests and decisions.
2. **No silent authority expansion.** Nofax can answer an approval request only when the originating agent has explicitly delegated that decision to its hook contract.
3. **Fail back to native UI.** Timeout, malformed response, or transport failure must not auto-approve. Claude Code and Codex adapters return no decision so their native approval flow can continue.
4. **No persistent "always approve" in v1.** Every remote approval is single-use.
5. **Secret-by-capability topics.** The phone topic and every response topic are generated from cryptographically random values. The public ntfy service treats topic names as bearer secrets; self-hosted ntfy is supported for sensitive environments.
6. **Minimal data exposure.** Known secret-bearing keys are redacted and payloads are bounded before leaving the machine. Commands or free-form text can still contain secrets, so public ntfy must not be treated as an end-to-end encrypted channel.
7. **Zero mandatory dependencies.** Runtime uses Node.js built-ins and the documented ntfy HTTP API.

## Interaction model

Nofax exposes three v1 interaction kinds:

- `notify`: one-way informational message.
- `approval`: two choices, `allow` or `deny`.
- `choice`: up to three explicit options, matching ntfy's notification-action limit.

Text-entry/refinement is intentionally not claimed as native v1 functionality because ntfy action buttons do not provide an inline text field. The core protocol leaves room for a future reply surface (for example, an iOS Shortcut or a small self-hosted reply UI) without changing agent adapters.

## ntfy transport

A user runs `nofax init` once and subscribes the ntfy iOS/Android app to the generated topic.

For an approval request:

1. Nofax creates a request ID and a fresh high-entropy response topic.
2. Nofax publishes a JSON notification to the configured ntfy server.
3. The notification contains HTTP action buttons. Each button POSTs a small signed-by-capability response body to the unique response topic.
4. Nofax polls the response topic for a matching request ID until the configured timeout.
5. The adapter maps the result into the originating agent's exact hook output.
6. The response topic expires naturally with ntfy's cache; Nofax stores no approval history in v1.

No callback server, inbound port, Tailscale, SMS provider, WhatsApp API, or AI API is required.

## Adapter contracts

### Claude Code

Input: `PermissionRequest` hook JSON on stdin.

Remote `allow` -> `hookSpecificOutput.PermissionRequest.decision.behavior = "allow"`.

Remote `deny` -> the same structure with `behavior = "deny"` and a human-readable message.

Timeout or transport error -> no decision output, allowing Claude Code's normal permission dialog to continue.

### Codex

Input: `PermissionRequest` hook JSON on stdin.

Remote `allow` / `deny` map to Codex's documented PermissionRequest hook output. Nofax never emits reserved `updatedInput`, `updatedPermissions`, or `interrupt` fields.

Timeout or transport error -> no decision output, allowing Codex's normal approval path to continue.

### Gemini CLI

Gemini's `Notification` hook is observability-only. Nofax forwards the notification to the phone and returns an empty hook response. It does not claim remote approval for Gemini until Gemini exposes a documented decision-capable hook path suitable for this use case.

### Generic CLI

Any script can call `nofax notify` or `nofax approve`. The latter prints a stable JSON decision to stdout for scripting.

## Configuration

Default home: `~/.nofax`, overrideable with `NOFAX_HOME`.

`config.json` fields:

- `version`: config schema version, currently `1`.
- `server`: ntfy base URL, default `https://ntfy.sh`.
- `topic`: cryptographically generated phone topic.
- `timeoutSeconds`: approval timeout, default `300`.

The config file is created with user-only permissions where supported.

## Security boundaries

- Nofax is not an authorization policy engine; the agent remains authoritative about when approval is required.
- Nofax never turns a timeout into approval.
- Random topics are capabilities. Anyone who learns a topic can read or publish to it unless the ntfy server adds authentication.
- Public ntfy is convenient but not end-to-end encrypted application storage. Sensitive teams should self-host ntfy behind authentication/TLS.
- Adapter input is untrusted. Parsing is strict enough to reject wrong hook event types while preserving unknown tool-input fields for display only.
- Secret-like object keys are redacted before notification rendering; free-form strings are bounded, not semantically inspected.

## Compatibility and roadmap

V1 is useful without an MCP server because hook commands and the generic CLI already cover agent and automation workflows. A later MCP wrapper should call the same core interfaces rather than create a second protocol or transport implementation.

Likewise, future OpenCode/Hermes adapters should be thin translators around the same `notify`, `approval`, and `choice` operations and must only claim bidirectional behavior when the upstream tool exposes a documented response contract.
