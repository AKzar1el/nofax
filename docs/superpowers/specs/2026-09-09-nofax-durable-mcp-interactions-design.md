# Nofax Durable MCP Interactions Design

**Date:** 2026-09-09
**Status:** Approved for v0.2 implementation

## Goal

Add a provider-neutral MCP surface that can safely wait for human phone decisions without holding one transport request open indefinitely, while adding phone-side decision confirmation and free-text refinement.

## Core decision

Nofax will use a durable request handle plus bounded long-polling:

1. `nofax_request_*` creates a high-entropy one-time ntfy response topic, publishes the phone prompt, persists a local pending record, and returns a public `requestId` only.
2. The MCP result explicitly instructs the model to call `nofax_wait_for_response` and to repeat that call while the status remains `pending`.
3. `nofax_wait_for_response` blocks only for a bounded window (default 240 seconds, max 240 seconds), then returns either a terminal response or another `pending` result with the same mandatory wait instruction.
4. Pending records survive MCP process/client disconnects under `~/.nofax/requests/` and can be recovered by request ID.
5. A pending request never grants authority. Only a matching terminal phone response does.

This avoids depending on an infinite HTTP/tunnel lifetime. It also maps cleanly to the MCP Tasks extension when the target client supports it in the future.

## MCP surface

- `nofax_notify`: one-way notification. No wait contract.
- `nofax_request_approval`: creates Allow/Deny, optionally Refine, and returns `pending`.
- `nofax_request_choice`: creates 1-3 explicit choices and returns `pending`.
- `nofax_request_refinement`: asks for free-text refinement through the configured iOS Shortcut and returns `pending`.
- `nofax_wait_for_response`: bounded long-poll. If pending, the model must call it again. If resolved, the model may act on the result.
- `nofax_get_request`: recovery/read tool for one durable request.
- `nofax_list_pending`: bounded recovery list.

The MCP server instructions and relevant tool descriptions must state that guarded work must not continue while a request is pending.

## Confirmation UX

When Nofax accepts a valid terminal phone response, it sends a best-effort low-priority confirmation notification (`Approved`, `Denied`, `Choice received`, or `Refinement received`). Confirmation failure never changes the already-recorded decision.

## Refine UX

Nofax uses a third ntfy `view` action named `Refine` that opens the local iOS Shortcut named `Nofax Refine` by default. The shortcut receives JSON input containing a one-time callback URL and request ID, asks the user for text, and POSTs a bounded JSON response to that one-time ntfy topic.

No hosted Nofax backend, paid API, inbound port, SMS, WhatsApp, or model API is introduced.

## Durable request state

Each `~/.nofax/requests/<requestId>.json` record contains only bounded local metadata required to recover the wait:

- schema version;
- request ID;
- kind (`approval`, `choice`, `refinement`);
- one-time response topic;
- allowed response values;
- status (`pending` or `resolved`);
- created/resolved timestamps;
- terminal decision/value and optional bounded refinement text.

The phone prompt body is not persisted. Files are written with user-only permissions where supported.

## Failure semantics

- network/publish error before persistence: return an MCP error; no pending request is claimed;
- timeout of one `wait` call: return `pending`, not denial or approval;
- malformed/wrong-request ntfy messages: ignore;
- MCP/client disconnect: request remains pending on disk;
- duplicate terminal responses: first valid terminal response wins;
- confirmation publish failure: record remains terminal;
- `deny`: caller must not perform the guarded action;
- `refine`: caller applies the supplied text, then requests a new approval if the resulting action still requires approval.

## Model wakeup

Nofax v0.2 does not claim that an MCP server can universally re-run an arbitrary model after an unsolicited phone ping. The portable behavior is durable polling. A future host-specific wake adapter or MCP Tasks integration may optimize this without changing the durable request core.

## Codexify integration

Run `nofax mcp` as a local stdio server. Codexify should configure a forwarded tool timeout comfortably above the 240-second long-poll (recommended 270 seconds). The server uses the stable MCP TypeScript SDK v2 and writes no non-MCP output to stdout.
