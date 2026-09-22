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
