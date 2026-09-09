# Nofax Architecture

## Purpose

Nofax is a provider-neutral human-interaction bridge for coding agents and automations. It sends actionable notifications through ntfy and returns explicit human decisions without coupling the approval transport to one model vendor.

Version 0.3 supports two MCP transports:

- **Local:** the existing Node.js stdio MCP server and local durable request files.
- **Remote:** an optional self-deployed Cloudflare Worker using stateless Streamable HTTP plus a SQLite-backed Durable Object for human-response state.

The remote Worker is deployed in the user's own Cloudflare account. Nofax does not require or operate a hosted Nofax SaaS backend.

## Design principles

1. **Provider-neutral core.** Agent-specific schemas stay in thin adapters. MCP/CLI callers share the same decision vocabulary.
2. **Pending is not authority.** A request remains non-authorizing until a matching terminal human response is persisted.
3. **Durable human gates.** MCP/client interruption must not erase an unresolved approval/refinement request.
4. **Bounded waits.** Nofax never requires an infinite MCP/HTTP request; callers repeat bounded waits over a durable request ID.
5. **No silent authority expansion.** Allow permits only what the originating caller was already authorized to do.
6. **Fail closed.** Timeout, network failure, malformed input, missing state, and expiry never become approval.
7. **Single-use capabilities.** Every interactive request gets fresh high-entropy callback material.
8. **Minimal exposure.** Raw callback capabilities are never returned through MCP request projections.
9. **First terminal response wins.** Later callbacks cannot replace the accepted decision.
10. **Free baseline.** Public/self-hosted ntfy plus local Nofax or a SQLite-backed Cloudflare Durable Object is sufficient; no paid AI or messaging API is introduced.

## High-level topology

```text
                    +------------------+
                    |   MCP / agent    |
                    |      caller      |
                    +---------+--------+
                              |
                 +------------+-------------+
                 |                          |
                 v                          v
        +----------------+         +------------------+
        | Local Nofax    |         | Remote Worker    |
        | stdio MCP/CLI  |         | Streamable HTTP  |
        +-------+--------+         +--------+---------+
                |                           |
                | durable request           | durable request
                v                           v
        local request files          SQLite Durable Object
                |                           |
                +------------+--------------+
                             |
                             v
                           ntfy
                             |
                             v
                           phone
                  Allow / Deny / Choice / Refine
                             |
                 +-----------+-----------+
                 |                       |
                 v                       v
          local ntfy response      Worker callback
          topic / Shortcut         /r/<capability>
                 |                       |
                 +-----------+-----------+
                             |
                             v
                    durable terminal result
```

## Interaction kinds

- `notify`: one-way information; no wait contract.
- `approval`: Allow/Deny; generic/MCP workflows may optionally include Refine as a third action.
- `choice`: one to three explicit choices.
- `refinement`: free-text human input.

Native Claude Code and Codex permission hooks remain Allow/Deny only. Gemini CLI remains notification-only where its upstream hook contract is advisory.

## Local transport

The local implementation under `src/` remains the default zero-backend mode.

### Local ntfy flow

1. Generate a random request ID and one-time ntfy response topic.
2. Publish an actionable notification to the user's private phone topic.
3. Allow/Deny/choice actions publish structured JSON to that response topic.
4. Local Refine opens the `Nofax Refine` iOS Shortcut, which asks for text and posts it to the one-time response topic.
5. Nofax polls the response topic for a matching request.
6. The first valid terminal response is persisted locally.
7. A low-priority phone confirmation is sent best-effort.

No inbound port on the user's computer is required.

### Local durable state

Pending MCP request metadata lives under:

```text
~/.nofax/requests/
```

The files contain only bounded recovery metadata plus the one-time response topic required to resume the wait. MCP projections omit that topic.

Local `nofax_wait_for_response` is bounded to at most 240 seconds per call.

## Remote Worker transport

The optional `worker/` package adds remote Streamable HTTP MCP without replacing the local implementation.

### Protocol layer

The Worker uses Cloudflare's stateless `createMcpHandler()` path for MCP. The MCP protocol itself is not stored in a Durable Object.

The authenticated endpoint is:

```text
/mcp
```

A private capability-URL compatibility form is also supported:

```text
/mcp/<NOFAX_REMOTE_KEY>
```

See `docs/remote-mcp.md` for connection details.

### Remote durable state

Human-response state is stored in one SQLite-backed Durable Object namespace. Each row contains:

- request ID;
- kind/status;
- bounded title/message;
- allowed terminal decisions;
- SHA-256 callback-token hash;
- created/expiry timestamps;
- terminal decision/text/timestamp after resolution.

The raw callback token is never persisted.

Pending callback capabilities expire after 24 hours. Expired pending rows and resolved rows beyond the recovery window are lazily deleted during normal create/list operations.

### Remote phone flow

1. Generate request ID + fresh callback token.
2. Hash the callback token.
3. Persist the request before notification delivery.
4. Publish ntfy actions containing only the raw per-request callback capability.
5. Discard the raw callback token after publication.
6. Phone action reaches `/r/<token>/...`.
7. Worker hashes the supplied token and resolves state through the Durable Object.
8. First valid terminal response wins.
9. Confirmation notification is sent best-effort.
10. `nofax_wait_for_response` observes the terminal durable row.

Remote Allow/Deny are one tap. Remote Refine opens a no-JavaScript Worker-hosted HTML form rather than the Apple Shortcut.

Remote wait calls are capped at 20 seconds.

## MCP semantic parity

Both local and remote transports expose the same seven public tool names:

- `nofax_notify`
- `nofax_request_approval`
- `nofax_request_choice`
- `nofax_request_refinement`
- `nofax_wait_for_response`
- `nofax_get_request`
- `nofax_list_pending`

Both use the same terminal semantics:

- `allow`: human approved; caller may continue only within existing authority;
- `deny`: guarded action must not execute;
- `refine`: apply the human text and request a fresh approval if the resulting action still requires approval;
- explicit choice: apply only the selected value.

The wait duration differs by transport, but pending/result semantics do not.

## Durable wait model

Nofax intentionally does not keep one MCP call open forever.

```text
request_* -> PENDING
                |
                v
        bounded wait call
           /          \
      no answer       answer
         |              |
         v              v
      PENDING        RESOLVED
         |
         +--> caller MUST invoke wait again
```

Every pending result contains `mustWait: true` plus an explicit instruction naming `nofax_wait_for_response`.

There is no portable assumption that a remote MCP server can force every host/model to begin a new turn after an unsolicited phone event. Host-specific wake integration or MCP Tasks may later optimize this without replacing Nofax's durable request contract.

## Authentication and capability separation

Remote Nofax deliberately separates deployment authentication from per-request phone capabilities.

- `NOFAX_REMOTE_KEY` protects only the private MCP endpoint.
- Each phone interaction gets an independent callback token.
- Phone callback URLs never contain `NOFAX_REMOTE_KEY`.
- The Durable Object stores only callback-token hashes.
- Authenticated MCP requests are normalized to `/mcp` before protocol handling.

For private clients that support headers, use `Authorization: Bearer <key>`. Capability-URL mode exists only for clients that cannot attach headers. OAuth 2.1 is the expected hardening path before multi-user/public hosting.

## Browser Refine security

The remote Refine page is server-rendered and mobile-first. It loads no external JavaScript, analytics, fonts, or third-party assets.

Responses use restrictive security headers including:

- `Content-Security-Policy`;
- `Cache-Control: no-store`;
- `X-Content-Type-Options: nosniff`;
- `Referrer-Policy: no-referrer`.

All user-controlled content is escaped and bounded. Refine text is capped before durable persistence.

## Adapter contracts

### Claude Code

Input: `PermissionRequest` hook JSON on stdin.

- remote Allow -> native `allow` decision;
- remote Deny -> native `deny` decision;
- timeout/transport error -> no hook decision, allowing native approval fallback.

### Codex

Input: `PermissionRequest` hook JSON on stdin.

Nofax emits only documented allow/deny fields and does not fabricate reserved permission/input mutation behavior.

### Gemini CLI

The documented Notification hook is treated as observability-only. Nofax forwards the phone notification without pretending it grants permission.

### Generic CLI

`nofax notify`, `nofax approve`, and `nofax refine` expose the local transport without MCP.

## Security boundaries

- Nofax is not an authorization policy engine.
- Pending is never equivalent to Allow.
- Anonymous ntfy topics are bearer capabilities.
- Public ntfy is not application-level end-to-end encrypted from the service operator.
- Cloudflare is an additional infrastructure trust boundary in remote mode.
- Secret-like object keys are redacted, but free-form strings are not semantically secret-scanned.
- Local one-time response topics and remote callback tokens are bearer capabilities.
- Remote `NOFAX_REMOTE_KEY` and the full capability-URL MCP endpoint are bearer secrets.
- Only the first accepted terminal response governs the durable request.
- Self-hosted authenticated ntfy is preferred for sensitive production content.

See `SECURITY.md` for operational guidance.

## Future compatibility

The durable human-response contract is intentionally independent of any one MCP host. MCP Tasks or host-specific wake mechanisms may later reference the same request IDs instead of repeated polling.

OpenCode, Hermes, or other agent adapters should remain thin translators and must not claim bidirectional behavior until their upstream decision contracts are pinned and tested.
