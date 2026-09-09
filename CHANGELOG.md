# Changelog

All notable changes to Nofax will be documented here.

## 0.3.0 - Unreleased

### Added

- Optional self-deployed Cloudflare Workers remote MCP transport using stateless Streamable HTTP.
- SQLite-backed Durable Object request state for remote approval, choice, and refinement workflows.
- Free Telegram Bot API transport for remote phone delivery.
- Telegram inline Allow/Deny/choice callbacks through a verified Worker webhook.
- Telegram Refine URL button opening the Worker-hosted free-text form with no Apple Shortcut required in remote mode.
- Telegram webhook authentication using `X-Telegram-Bot-Api-Secret-Token`, plus exact configured user/chat binding.
- Private remote MCP authentication through a bearer header, plus an opt-in capability-URL compatibility mode.
- Remote recovery tools with the same seven public MCP tool names and terminal decision semantics as local Nofax.
- 20-second bounded remote waits with an explicit repeat-until-terminal contract.
- Public remote deployment and qualification documentation.

### Changed

- Nofax now has two MCP transports: the existing local stdio server and the optional remote Worker.
- Local CLI/Claude/Codex workflows continue to use ntfy; the default Cloudflare remote Worker uses Telegram to avoid public ntfy shared-serverless-egress rate-limit failures.
- Remote callback confirmation now uses Telegram.
- Public documentation distinguishes the local iOS Shortcut refinement path from the remote browser refinement path.
- Root CI qualifies both the Node package and the Cloudflare Worker, including a Wrangler deployment dry-run.

### Free-only

- Remote Telegram delivery never sends `allow_paid_broadcast=true` and does not use Telegram Stars.
- Nofax has no paid notification fallback; provider/free-tier failures fail closed.
- The remote state layer uses SQLite-backed Durable Objects supported by Cloudflare Workers Free, subject to current provider limits.

### Security

- Remote callback tokens are generated per request, expire after 24 hours, and are stored only as SHA-256 hashes.
- Telegram callbacks must pass webhook-secret, user-ID, chat-ID, callback-capability, and allowed-decision validation before durable mutation.
- Telegram callback acknowledgement/message editing is best-effort and never substitutes for durable terminal state.
- The remote MCP key is never included in callback URLs, Telegram controls, or MCP tool results.
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
