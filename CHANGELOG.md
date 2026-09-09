# Changelog

All notable changes to Nofax will be documented here.

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
