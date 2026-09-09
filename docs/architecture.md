# Nofax Architecture

## Purpose

Nofax is a provider-neutral human-interaction bridge for coding agents and automations. It sends actionable notifications through ntfy and returns explicit human decisions to the originating workflow without requiring a hosted Nofax backend, inbound callback server, paid model API, SMS, WhatsApp, or Viber.

Version 0.2 adds a local stdio MCP server and durable human-response state while retaining the v0.1 Claude Code, Codex, Gemini, and generic CLI adapters.

## Design principles

1. **Provider-neutral core.** Agent-specific schemas stay in adapters. MCP/CLI callers use the same interaction core.
2. **Pending is not authority.** A request remains non-authorizing until a matching terminal response is persisted.
3. **Durable human gates.** MCP/client disconnects must not erase an unresolved approval/refinement request.
4. **Bounded transport calls.** Nofax does not rely on an infinite HTTP/MCP request. It uses repeated bounded long-polls over a durable handle.
5. **No silent authority expansion.** An Allow result only permits what the originating caller was already authorized to do.
6. **Fail closed.** Timeout, network failure, malformed responses, or process interruption never become approval.
7. **Single-use response capabilities.** Every human request gets a fresh random response topic and request ID.
8. **Minimal exposure.** Secret response topics remain local and never appear in MCP tool results.
9. **Best-effort confirmation only.** A phone confirmation is UX feedback, not part of decision authority.
10. **Free baseline.** Public ntfy or a self-hosted ntfy instance is sufficient; no paid AI or messaging API is required.

## Components

```text
Agent hook / CLI / MCP host
          |
          v
+-------------------------+
| Nofax interaction core  |
|                         |
| protocol                |
| ntfy transport          |
| durable request store   |
| provider adapters       |
+------------+------------+
             |
             v
           ntfy
             |
             v
           phone
      Allow / Deny /
      Choice / Refine
             |
             v
  one-time response topic
             |
             v
   durable terminal result
```

## Interaction kinds

- `notify`: one-way information; no wait contract.
- `approval`: Allow/Deny; MCP may optionally add Refine as the third action.
- `choice`: 1-3 explicit choices.
- `refinement`: free-text human input through the `Nofax Refine` iOS Shortcut.

Native Claude/Codex permission hooks remain Allow/Deny only. Refine belongs to generic/MCP workflows that can actually consume revised instructions.

## ntfy transport

For an actionable request:

1. Generate a random request ID and one-time response topic.
2. Publish a notification to the user's private phone topic.
3. HTTP action buttons POST structured JSON directly to the one-time response topic.
4. A Refine `view` action opens `shortcuts://run-shortcut`, passing only the request ID and callback URL to the local Shortcut.
5. Nofax polls the response topic for a matching structured response.
6. The first valid terminal response is persisted.
7. Nofax sends a low-priority best-effort confirmation notification.

No inbound port on the user's computer is required.

## Durable MCP model

### Why not wait forever in one MCP call?

MCP hosts and aggregators commonly impose per-tool and HTTP tunnel timeouts. Keeping a single request open indefinitely is therefore less robust than storing the human gate and polling it through bounded calls.

Nofax uses this state machine:

```text
request_* -> PENDING
                |
                v
        wait <= 240 seconds
           /          \
      no answer       answer
         |              |
         v              v
      PENDING        RESOLVED
         |
         +--> caller MUST invoke wait again
```

Every pending MCP result contains both `mustWait: true` and a mandatory instruction naming `nofax_wait_for_response`. The server-level MCP instructions repeat the same rule.

The portable v0.2 contract is deliberate: Nofax does not claim that an MCP server can universally wake or re-run an arbitrary model host after an unsolicited phone event. Future host-specific wake adapters or MCP Tasks integration can optimize scheduling without changing the persisted request contract.

## MCP tools

`nofax mcp` exposes seven stdio tools:

- `nofax_notify`
- `nofax_request_approval`
- `nofax_request_choice`
- `nofax_request_refinement`
- `nofax_wait_for_response`
- `nofax_get_request`
- `nofax_list_pending`

The server uses the official stable MCP TypeScript server SDK v2 and Zod v4. Stdout is MCP protocol traffic only.

## Durable request state

Default request directory:

```text
~/.nofax/requests/
```

A pending file contains bounded recovery metadata:

```json
{
  "version": 1,
  "requestId": "nfx_...",
  "kind": "approval",
  "responseTopic": "nofax_r_...",
  "allowed": ["allow", "deny"],
  "status": "pending",
  "createdAt": "..."
}
```

The phone prompt body is intentionally not persisted. Resolved files add the terminal response and timestamp. Response topics are never included in MCP projections.

Writes use a temporary file followed by rename so a crash does not intentionally publish a partially-written JSON document. User-only permissions are requested where the OS supports POSIX mode semantics.

## Adapter contracts

### Claude Code

Input: `PermissionRequest` hook JSON on stdin.

- remote Allow -> native `allow` hook decision;
- remote Deny -> native `deny` hook decision;
- timeout/transport error -> no hook decision, allowing native approval fallback.

### Codex

Input: `PermissionRequest` hook JSON on stdin.

Nofax emits only the currently documented decision fields. It does not emit reserved permission/input mutation fields.

### Gemini CLI

The documented notification hook is treated as observability-only. Nofax forwards the phone notification without pretending it can grant permission.

### Generic CLI

`nofax notify`, `nofax approve`, and `nofax refine` expose the same transport without MCP.

## Codexify bridge

Codexify is the initial MCP aggregation target. It launches `nofax mcp` over stdio in direct mode. Nofax's wait call is capped at 240 seconds; the recommended Codexify `toolTimeoutSec` is 270 seconds so the bridge timeout remains outside the Nofax long-poll window.

If a Codexify/ChatGPT conversation rolls over or a call is interrupted, `nofax_get_request` and `nofax_list_pending` provide bounded recovery while the secret response topic stays local.

## Security boundaries

- Nofax is not an authorization policy engine.
- Pending is never equivalent to Allow.
- Anonymous ntfy topics are bearer capabilities.
- Public ntfy is not application-level end-to-end encrypted storage.
- Secret-like object keys are redacted, but free-form strings are not semantically secret-scanned.
- The `Nofax Refine` callback URL is a one-time bearer capability.
- Only the first accepted terminal response should govern the durable request.
- Self-hosted authenticated ntfy is preferred for sensitive production content.

See `SECURITY.md` for operational guidance.

## Future compatibility

The durable request store is intentionally independent of any one MCP host. MCP Tasks or host-specific wake mechanisms may later reference the same request IDs instead of repeated polling. OpenCode, Hermes, or other agent adapters should remain thin translators and must not claim bidirectional behavior until their upstream decision contracts are pinned and tested.
