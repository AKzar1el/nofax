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

- Remote v0.3 is deliberately limited to **one-way notification plus inspection** rather than a remote human-approval transport.
- The remote MCP handler exposes one notification method plus two read methods.
- `nofax_list_pending` filters expired rows without performing lazy cleanup writes.
- Both remote tools are annotated `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, and `openWorldHint: false`.
- Root CI continues to qualify both the local Node package and the Cloudflare Worker, including a Wrangler deployment dry-run.

### Removed

- Remote approval, choice, refinement, and wait tools.
- Telegram remote transport and webhook.
- Browser phone-callback/Refine routes.

Local Nofax `0.2.0` behavior is unchanged by these removals.

### Security

- Remote side effects are structurally limited to authenticated one-way ntfy publication; approval/callback/state mutation remains unreachable.
- Former `/telegram/webhook` and `/r/*` routes are absent and return 404.
- Remote result projections omit callback hashes/capabilities, original request title/message content, and allowed-decision internals.
- MCP bearer/capability authentication uses equal-length constant-time comparison.
- The capability-path form is normalized to `/mcp` before MCP protocol handling.
- Remote read operations perform no external messaging/provider calls; only explicit `nofax_notify` invokes ntfy.

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
