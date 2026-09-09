# Nofax Read-Only Remote MCP Design

## Goal

Reduce the optional Cloudflare Nofax remote MCP surface to deterministic read-only inspection only. The local Nofax 0.2 CLI/stdio implementation remains unchanged.

## Remote public surface

The remote MCP server exposes exactly two tools:

- `nofax_get_request`
- `nofax_list_pending`

Both tools are annotated with `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, and `openWorldHint: false`.

The Worker exposes only:

- `GET|HEAD /healthz`
- authenticated `/mcp` and `/mcp/<NOFAX_REMOTE_KEY>`

All previous phone/callback routes are removed from the router.

## Hard read-only boundary

The read-only guarantee is enforced by code shape, not annotations alone:

- no remote notification tool;
- no remote approval/choice/refinement request tool;
- no remote wait tool;
- no Telegram transport;
- no remote ntfy transport;
- no callback or Refine HTTP routes;
- no public remote handler that creates, resolves, deletes, or otherwise mutates request rows.

The two MCP handlers only call read methods on the Durable Object binding.

`listPending` must not perform lazy cleanup or any other write as part of a read tool call. Expired rows are filtered in the SELECT query. Existing mutation methods may remain private/unreachable only if required for migration compatibility, but they are not part of the remote handler interface and cannot be reached from any Worker route or MCP tool.

## Data returned

`nofax_get_request` returns safe request metadata and terminal state for an existing durable request ID. It does not return callback hashes/capabilities.

`nofax_list_pending` returns a bounded list of unresolved, unexpired request summaries. It does not return callback hashes/capabilities.

## Authentication

The existing private single-user `NOFAX_REMOTE_KEY` boundary remains unchanged. Preferred mode is `Authorization: Bearer`; capability-path compatibility remains available for clients that cannot send a static header.

## Production cleanup

Remove Telegram-specific source, tests, environment fields, docs, and deployment instructions from the remote Worker. Remove stale ntfy remote source/config if no longer referenced. The Worker production dependency graph must not include a phone transport.

## Verification

Release acceptance requires:

1. Remote MCP tool list is exactly the two read-only tools.
2. Tool annotations correctly declare read-only semantics.
3. `/telegram/webhook` and `/r/*` return 404.
4. Unauthenticated `/mcp` remains rejected.
5. `nofax_get_request` and `nofax_list_pending` perform no store mutation.
6. Worker tests/typecheck/Wrangler dry-run pass.
7. Root Node 20/22/24 package gates remain green.
8. Official MCP Inspector discovers exactly two remote tools.
9. Public docs describe the remote Worker as read-only and do not instruct users to configure Telegram/ntfy remote secrets.
10. PR #3 remains unmerged until the final deployed two-tool scan is verified.
