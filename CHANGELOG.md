# Changelog

All notable changes to Nofax will be documented here.

## 0.3.0 - 2026-09-09

### Added

- Optional self-deployed Cloudflare Workers remote MCP transport using stateless Streamable HTTP.
- SQLite-backed Durable Object request state for remote approval, choice, and refinement workflows.
- One-tap phone Allow/Deny callbacks through per-request Worker capability URLs.
- Browser-based free-text Refine flow with no Apple Shortcut required in remote mode.
- Private remote MCP authentication through a bearer header, plus an opt-in capability-URL compatibility mode.
- Remote recovery tools with the same seven public MCP tool names and terminal decision semantics as local Nofax.
- 20-second bounded remote waits with an explicit repeat-until-terminal contract.
- Public remote deployment and qualification documentation.

### Changed

- Nofax now has two MCP transports: the existing local stdio server and the optional remote Worker.
- Public documentation distinguishes the local iOS Shortcut refinement path from the remote browser refinement path.
- Root CI now qualifies both the Node package and the Cloudflare Worker, including a Wrangler deployment dry-run.

### Security

- Remote callback tokens are generated per request, expire after 24 hours, and are stored only as SHA-256 hashes.
- The remote MCP key is never included in callback URLs or MCP tool results.
- MCP bearer/capability authentication uses equal-length constant-time byte comparison.
- Phone callback state is first-terminal-response-wins; later callbacks cannot replace the accepted result.
- Refine HTML is server-rendered with strict security headers, no external scripts/assets, and bounded escaped content.
- Stale remote request rows are lazily removed, including expired pending rows and resolved rows outside the recovery window.

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
