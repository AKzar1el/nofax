# Changelog

All notable changes to Nofax will be documented here.

## 0.3.0 - Unreleased

### Added

- Optional self-deployed Cloudflare Workers remote MCP transport using stateless Streamable HTTP.
- SQLite-backed Durable Object compatibility for reading request state created by earlier remote-development builds.
- Private remote MCP authentication through a bearer header, plus capability-URL compatibility mode for clients that cannot attach a static header.
- Remote MCP tools:
  - `nofax_notify` for one-way ntfy phone notifications;
  - `nofax_get_request`
  - `nofax_list_pending`
- Public deployment, security, and qualification documentation for bounded remote notification + inspection mode.

### Changed

- Gemini CLI integration can now use the current synchronous `BeforeTool` hook for explicit Nofax Allow/Deny decisions while retaining the advisory `Notification` path; timeout or transport failure leaves Gemini's native policy flow in control.
- Remote v0.3 is deliberately limited to **one-way notification plus inspection** rather than a remote human-approval transport.
- The remote MCP handler exposes one notification method plus two read methods.
- `nofax_list_pending` filters expired rows without performing lazy cleanup writes.
- The two remote inspection tools are annotated `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, and `openWorldHint: false`; `nofax_notify` is explicitly side-effecting and non-idempotent.
- ntfy publish failures now preserve bounded provider diagnostics such as ntfy error codes and `Retry-After` values when available.
- Root CI continues to qualify both the local Node package and the Cloudflare Worker, including a Wrangler deployment dry-run.

### Removed

- Remote approval, choice, refinement, and wait tools.
- Telegram remote transport and webhook.
- Browser phone-callback/Refine routes.

Local Nofax `0.2.x` behavior is unchanged by these removals.

### Security

- Remote side effects are structurally limited to authenticated one-way ntfy publication; approval/callback/state mutation remains unreachable.
- Former `/telegram/webhook` and `/r/*` routes are absent and return 404.
- Remote result projections omit callback hashes/capabilities, original request title/message content, and allowed-decision internals.
- MCP bearer/capability authentication uses equal-length constant-time comparison.
- The capability-path form is normalized to `/mcp` before MCP protocol handling.
- Remote read operations perform no external messaging/provider calls; only explicit `nofax_notify` invokes ntfy.

## 0.2.26 - 2026-09-23

### Security

- Agent-hook summary redaction now fully removes `Authorization` and `Proxy-Authorization` credential values when parameterized headers appear after structural punctuation or use quoted header keys with unquoted Digest-, AWS-, Bearer-, or Basic-style values, preventing secret credential parameters from surviving in outbound agent summaries.

Pending, timeout, disconnect, setup/config failure, transport failure, and notification delivery still never mean approval. Explicit Allow/Deny behavior, response-topic secrecy, notification authority, and the narrower remote Worker boundary are unchanged.

## 0.2.25 - 2026-09-23

### Security

- Agent-hook summary redaction now fully removes unquoted inline parameterized `Authorization` and `Proxy-Authorization` credential values, including Digest- and AWS-style forms, instead of allowing later credential parameters on the same line to survive a partial redaction.

### Fixed

- Canonical npm `bin.nofax` metadata now matches the normalized path npm publishes, avoiding publish-time metadata self-correction without changing the executable entry point.

Pending, timeout, disconnect, setup/config failure, transport failure, and notification delivery still never mean approval. Explicit Allow/Deny behavior, response-topic secrecy, notification authority, and the narrower remote Worker boundary are unchanged.

## 0.2.24 - 2026-09-23

### Security

- Agent-hook summary redaction now treats credential-bearing `authHeader` and prefixed `*AuthHeader` object fields as secrets, preventing bearer/basic credentials from escaping through common aliases while preserving non-secret metadata such as `authHeaderName`, `authMode`, and `authentication`.

Pending, timeout, disconnect, setup/config failure, transport failure, and notification delivery still never mean approval. Explicit Allow/Deny behavior, response-topic secrecy, notification authority, and the narrower remote Worker boundary are unchanged.

## 0.2.23 - 2026-09-23

### Security

- Agent-hook summary redaction now treats structured secret-bearing HTTP header entries case-insensitively across `name`/`key`/`header` label fields and sibling `value`/`values` payload fields, preventing credentials from escaping through case variants such as `{name: "Authorization", Value: secret}` or `{Header: "X-Api-Key", Values: [secret]}` while preserving benign header values.

Pending, timeout, disconnect, setup/config failure, transport failure, and notification delivery still never mean approval. Explicit Allow/Deny behavior, response-topic secrecy, notification authority, and the narrower remote Worker boundary are unchanged.

## 0.2.22 - 2026-09-23

### Fixed

- Claude Code and Codex `PermissionRequest` hook setup/configuration failures now decline cleanly to the host's native approval flow with exit 0, empty stdout, and diagnostics on stderr instead of surfacing a hook error boundary when Nofax cannot establish a remote decision.
- Gemini CLI `Notification` setup/configuration and ntfy transport failures now remain advisory with valid empty JSON plus diagnostics, while synchronous `BeforeTool` failures continue to return strict `{\"decision\":\"ask\"}` native-confirmation fallback JSON.

Pending, timeout, disconnect, setup/config failure, transport failure, and notification delivery still never mean approval. Explicit remote Allow/Deny decisions, response-topic secrecy, and the narrower remote Worker authority boundary are unchanged.

## 0.2.21 - 2026-09-23

### Fixed

- Gemini CLI hook setup, input-parse, configuration, or unexpected adapter failures now return strict `{"decision":"ask"}` hook JSON with a diagnostic on stderr instead of escaping the CLI boundary with empty stdout, preserving native confirmation when Nofax cannot produce a remote decision.
- Asynchronous failures from other hook adapters are now contained by the normal CLI error boundary instead of escaping as rejected promises.

Pending, timeout, disconnect, setup/config failure, and transport failure still never mean approval. Remote Worker authority, response-topic secrecy, and notification scope are unchanged.

## 0.2.20 - 2026-09-23

### Fixed

- Phone confirmations for an ordinary `nofax_request_choice` option whose value is `refine` now keep choice semantics in the message body (`Nofax recorded: refine`) instead of claiming that free-text refinement was sent back to the agent.

### Security

- Agent-hook summary redaction now recognizes structured HTTP header entries shaped as `{ header, value }`, redacting credential values for `Authorization`, `Cookie`, `X-Api-Key`, and other recognized secret-bearing header names while preserving ordinary header values such as `Accept`.

Pending, timeout, disconnect, and transport failure still never mean approval. Remote Worker authority, response-topic secrecy, and notification scope are unchanged.

## 0.2.19 - 2026-09-23

### Fixed

- Ordinary `nofax_request_choice` results and ntfy confirmations now honor the durable request kind even when a selected option value is named `allow`, `deny`, or `refine`, avoiding approval/denial/refinement wording for ordinary explicit choices.
- The ntfy response parser now accepts `refine` as a normal selected value for `choice` requests without requiring refinement text, while true approval-with-refine and dedicated refinement requests still require a non-empty human refinement.

Pending, timeout, disconnect, and transport failure still never mean approval. Remote Worker authority, response-topic secrecy, and notification scope are unchanged.

## 0.2.18 - 2026-09-23

### Security

- Agent-hook summary redaction now treats standalone `auth` fields as credential-bearing while preserving non-secret auth metadata such as `authMode` and `authentication`.
- Passphrase credential fields, including standalone and suffix-style forms such as `passphrase`, `keyPassphrase`, and `signingPassphrase`, are now redacted before notification text leaves the local process while benign metadata such as `passphraseHint` remains visible.

Approval decisions, pending-never-means-approval semantics, response-topic secrecy, notification authority, and the deliberately narrower remote Worker surface are unchanged.

## 0.2.17 - 2026-09-23

### Security

- Flat alternating secret key/value arrays now redact valid secret pairs even when the array has an odd trailing element or another key slot is malformed/non-string, preventing one malformed sibling from disabling redaction for otherwise recognizable Authorization, Cookie, API-key, and similar secret-bearing pairs.
- Ordinary non-secret pairs and malformed sibling values remain visible/processed normally so approval context stays useful.

Approval decisions, pending-never-means-approval semantics, response-topic secrecy, notification authority, and the deliberately narrower remote Worker surface are unchanged.

## 0.2.16 - 2026-09-22

### Security

- Agent-hook summary redaction now recognizes flat alternating secret key/value arrays such as Node-style `rawHeaders`, redacting paired Authorization, Cookie, API-key, and other secret-like values before notification text leaves the local process.
- Ordinary non-secret pairs remain visible so approval context stays useful.

Approval decisions, pending-never-means-approval semantics, response-topic secrecy, notification authority, and the deliberately narrower remote Worker surface are unchanged.

## 0.2.15 - 2026-09-22

### Security

- Agent-hook summary redaction now covers structured secret-header entries that store one or more values under a plural `values` field, including Authorization, Cookie, and API-key entry objects.
- Ordinary non-secret multi-value header entries remain visible so approval context stays useful.

Approval decisions, pending-never-means-approval semantics, response-topic secrecy, notification authority, and the deliberately narrower remote Worker surface are unchanged.

## 0.2.14 - 2026-09-22

### Security

- Agent-hook summary redaction now recognizes common structured header-entry objects such as `{ name: 'Authorization', value: '…' }` and `{ key: 'X-Api-Key', value: '…' }`, redacting only the secret-bearing value while preserving benign header context.
- Secret-key normalization now uses deterministic linear-time ASCII scanning instead of the previously flagged polynomial regular-expression path, closing GitHub CodeQL `js/polynomial-redos` alert #1 on uncontrolled tool-input keys.

Approval decisions, pending-never-means-approval semantics, response-topic secrecy, notification authority, and the deliberately narrower remote Worker surface are unchanged.

## 0.2.13 - 2026-09-22

### Security

- Agent-hook summary redaction now treats exact two-element secret-key entry tuples such as `['Authorization', 'Bearer …']`, `['Cookie', '…']`, and `['X-Api-Key', '…']` as secret-bearing structured fields and redacts their value side before notification text leaves the local process.
- Ordinary non-secret tuples remain visible so human approval context stays useful.

Approval decisions, pending-never-means-approval semantics, response-topic secrecy, notification authority, and the deliberately narrower remote Worker surface are unchanged.

## 0.2.12 - 2026-09-22

### Security

- Agent-hook summary redaction now removes complete inline quoted parameterized `Authorization` / `Proxy-Authorization` values, including Digest and AWS-style credentials embedded in shell commands, instead of leaving trailing credential parameters visible.
- Line-start assignment forms such as `Authorization = Digest ...` are now fully redacted as well. Existing Bearer/Basic formatting remains intact.

Approval decisions, pending-never-means-approval semantics, response-topic secrecy, notification authority, and the deliberately narrower remote Worker surface are unchanged.

## 0.2.11 - 2026-09-22

### Security

- Agent-hook summary redaction now covers URI userinfo passwords, including password-only forms such as Redis-style URLs, before notification text leaves the local process.
- Secret detection now runs before the per-string summary bound, so credentials whose closing delimiter falls beyond the truncation boundary cannot leak a visible prefix.
- Complete and unterminated PEM/OpenSSH/PGP private-key blocks are redacted while public certificates and unrelated `BEGIN`/`END` blocks remain visible.
- Complete `Cookie:` and `Set-Cookie:` header values are redacted so credentials in later semicolon-delimited cookie pairs cannot survive after an earlier pair is removed.
- Complete line-start and multiline `Authorization:` / `Proxy-Authorization:` header values are redacted so parameterized Digest/AWS-style nonce, response, credential, and signature material cannot survive partial scheme redaction.

Approval decisions, pending-never-means-approval semantics, response-topic secrecy, notification authority, and the deliberately narrower remote Worker surface are unchanged.

## 0.2.10 - 2026-09-22

### Security

- Agent-hook summaries now redact high-confidence secret values embedded inside ordinary strings, including Authorization bearer/basic credentials, secret-bearing URL query parameters, environment-style key assignments, quoted JSON-like fields, and CLI secret flags before notification text leaves the local process.
- Benign lookalikes such as `safeTokenizedValue`, `apiKeynote`, and non-secret CLI flags remain visible so approval context stays useful.

This remains best-effort redaction rather than a credential scanner; sensitive notification content should still use a trusted authenticated/self-hosted ntfy server as documented in `SECURITY.md`. Approval semantics, pending-never-means-approval behavior, response-topic secrecy, notification authority, and the deliberately narrower remote Worker surface are unchanged.

## 0.2.9 - 2026-09-22

### Fixed

- Free-text refinement responses now preserve the full trimmed human response through the documented 2,000-character ceiling instead of passing through the generic 500-character notification-summary bound.
- Gemini CLI `BeforeTool` timeout or transport failure now returns `decision: "ask"`, forcing Gemini's native interactive confirmation instead of allowing host auto-approval policy to interpret a missing Nofax decision as permission.

Explicit Nofax Allow/Deny behavior, pending-never-means-approval semantics, response-topic secrecy, notification transport authority, and the deliberately narrower remote Worker surface are unchanged.

## 0.2.8 - 2026-09-22

### Security

- Agent-hook summaries now redact camelCase, PascalCase, acronym-style, snake_case, and kebab-case variants of the existing secret-key vocabulary consistently, preventing values under keys such as `accessToken`, `clientSecret`, and `dbPassword` from being serialized into outbound Nofax notification text.

Approval semantics, response-topic secrecy, notification transport authority, and the deliberately narrower remote Worker surface are unchanged.

## 0.2.7 - 2026-09-22

### Fixed

- Concurrent local MCP waiters that observe the same accepted terminal response now emit only one best-effort phone confirmation while every waiter still converges on the same durable first-terminal winner.
- Bounded pending-request recovery now returns the newest unresolved requests first by durable creation time, so a recent request is not omitted merely because random requestId ordering filled the limit first.

Fail-closed pending/timeout/transport-failure semantics, response-topic secrecy, tool authority, agent hooks, and the deliberately narrower remote Worker surface are unchanged.

## 0.2.6 - 2026-09-22

### Fixed

- Concurrent local MCP waiters now send a phone confirmation only for the authoritative first terminal response; a contradictory response that loses the durable terminal claim can no longer produce a misleading confirmation.
- `nofax_wait_for_response` now advertises `readOnlyHint: false`, accurately reflecting that a terminal wait can persist resolved state and send a best-effort external confirmation while retaining non-destructive, idempotent, open-world hints.

First-terminal-response-wins behavior, pending/timeout/transport-failure-never-approval semantics, response-topic secrecy, tool authority, and the deliberately narrower remote Worker surface are unchanged.

## 0.2.5 - 2026-09-22

### Fixed

- Durable local MCP requests now replay the full cached one-time ntfy response topic instead of only the last ten minutes, so a terminal human response can still be recovered after a longer client or conversation interruption while the provider retains it.
- Local MCP approval, choice, and refinement requests now persist their generated request handle and response capability before publishing the phone notification, preventing a delivered response action from being orphaned if local persistence fails afterward.

Exact request/decision validation, response-topic secrecy, first-terminal-response-wins behavior, fail-closed approval semantics, and the deliberately narrower remote Worker surface are unchanged.

## 0.2.4 - 2026-09-22

### Added

- Semantic JSON Schema descriptions for every local MCP input parameter, including nested choice fields, so clients and agents can understand parameter intent directly from `tools/list`.
- Object-root MCP `outputSchema` contracts for all seven local tools, covering notification results, durable pending handles, terminal wait results, safe request projections, and bounded pending lists.
- Regression coverage that validates representative structured results through the MCP SDK's production output validator and rejects malformed output contracts.

### Changed

- `nofax_notify` now states explicitly that successful notification transport never counts as human approval.
- Package README release status now uses the stable `0.2.x` line instead of an obsolete exact patch reference.

Local approval, choice, refinement, waiting, persistence, and fail-closed semantics are unchanged.

## 0.2.3 - 2026-09-21

### Fixed

- Terminal sidecar claims are now the authoritative resolved record and are read before the original pending projection, eliminating the remaining Windows read/replace race between concurrent waiters.
- Resolving a request no longer rewrites the original projection after claiming terminal state, while historical main-only resolved records remain readable.

## 0.2.2 - 2026-09-21

### Added

- Side-effect-free `nofax --version` and `nofax -v` reporting from installed package metadata.

### Fixed

- Concurrent contradictory responses to the same durable local request now converge on one exclusive terminal claim, preserving the first-terminal-response-wins invariant across competing waiters.
- A terminal claim remains authoritative if a process stops before the ordinary request projection is refreshed, so recovery does not regress a resolved request back to pending.

## 0.2.1 - 2026-09-21

### Changed

- Public package onboarding now uses `npm install -g nofax` instead of the obsolete pre-registry GitHub install path.
- Release and MCP metadata now report local package version `0.2.1` consistently.

Local runtime behavior and the fail-closed human-approval boundary are unchanged from `0.2.0`.

## 0.2.0 - 2026-09-09

### Added

- Provider-neutral stdio MCP server using the stable MCP TypeScript server SDK v2.
- Durable local human-response requests that survive MCP/client disconnects.
- Bounded `nofax_wait_for_response` long-poll with an explicit repeat-until-terminal model contract.
- MCP recovery tools for reading one request and listing unresolved requests without exposing secret response topics.
- Free-text refinement through the `Nofax Refine` iOS Shortcut and one-time ntfy callback topics.
- Best-effort phone confirmation after accepted approvals, denials, choices, and refinements.
- Generic `nofax refine` CLI command.
- Codexify stdio MCP configuration and live-test documentation.

### Changed

- Package now depends on the official `@modelcontextprotocol/server` v2 runtime and Zod v4.
- The interaction protocol can return structured refinement text while preserving the v0.1 decision parser for hook compatibility.

### Security

- Pending MCP requests never imply approval.
- One-time response topics remain local and are omitted from MCP tool results.
- Durable request files use user-only permissions where supported.

## 0.1.0 - 2026-09-09

### Added

- Provider-neutral ntfy notification and approval transport.
- Generic `notify` and `approve` CLI commands.
- Bidirectional Claude Code `PermissionRequest` adapter.
- Bidirectional Codex `PermissionRequest` adapter.
- Notification-only Gemini CLI adapter.
- Bounded secret-key redaction and high-entropy one-time response topics.
- Public security, architecture, contribution, and CI documentation.
