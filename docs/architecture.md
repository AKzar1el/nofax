# Nofax Architecture

## Purpose

Nofax has two deliberately different surfaces:

- **Local Nofax 0.2:** a provider-neutral human-interaction bridge for coding agents and automations. It can notify a phone and return explicit human decisions through ntfy.
- **Remote Worker 0.3:** an optional self-deployed Cloudflare MCP endpoint for one-way phone notifications plus read-only inspection of existing durable request state.

The remote Worker is intentionally not a remote approval transport. It can publish one-way ntfy notifications, but it has no human-response callback route.

## Design principles

1. **Keep local interaction local.** The existing CLI/hooks/stdio MCP retain their human-response semantics without forcing a hosted backend.
2. **Remote mutation is narrow.** The only remote side effect is an explicitly requested one-way ntfy notification; request-state operations remain read-only.
3. **Enforce by reachability, not hints.** MCP annotations describe the tools, but the hard boundary is the absence of remote approval/callback/state-mutation handlers and routes.
4. **Minimize returned data.** Remote request projections omit callback capabilities, callback hashes, original request title/message content, and allowed-decision internals.
5. **No hidden writes in reads.** Listing pending requests filters expired rows in SQL without cleanup mutation.
6. **Private deployment.** `NOFAX_REMOTE_KEY` protects the remote MCP endpoint; the Worker is intended for one private user/deployment.
7. **Preserve upgrade compatibility.** The existing SQLite Durable Object schema remains available so prior experimental rows can still be inspected without destructive migration.

## High-level topology

```text
Local interactive path

agent / local MCP host
        |
        v
   Nofax 0.2
        |
        v
      ntfy
        |
        v
      phone
        |
        +---- explicit response ----> local durable request state


Remote notification + inspection path

remote MCP client
        |
        | authenticated Streamable HTTP
        v
Cloudflare Worker 0.3
        |
        +---- nofax_notify ----------> ntfy ----------> phone
        |
        +---- nofax_get_request ----+
        |                           |
        +---- nofax_list_pending ---+
                                    v
                           SQLite Durable Object
```

The only remote messaging path is one-way publication to the configured ntfy topic. There is no remote Telegram, WhatsApp, SMS, approval callback, or human-response path.

## Local implementation

The root `src/` package remains the interactive implementation.

### Interaction kinds

- `notify`: one-way information.
- `approval`: Allow/Deny; generic local MCP flows can optionally support refinement.
- `choice`: one to three explicit choices.
- `refinement`: free-text human input.

Native Claude Code and Codex permission hooks remain Allow/Deny only. Gemini CLI remains notification-only where its upstream hook is advisory.

### Local durable flow

1. Generate a request ID and one-time response topic.
2. Persist bounded request metadata under `~/.nofax/requests/`.
3. Publish through the configured ntfy server/topic.
4. Poll the one-time response topic for a matching terminal response.
5. Persist the first valid terminal result.
6. Return the result to the caller.

A pending request never implies approval. Timeout, malformed data, network errors, and client disconnects never synthesize Allow.

`nofax_wait_for_response` uses bounded waits and requires the caller to wait again while state remains pending.

## Remote Worker

The optional `worker/` package uses stateless Streamable HTTP for MCP and a SQLite-backed Durable Object for existing request data.

### Public HTTP surface

The router intentionally exposes only:

```text
GET|HEAD /healthz
/mcp
/mcp/<NOFAX_REMOTE_KEY>
```

`/mcp` requires an exact bearer credential. The path form is a compatibility capability for clients that cannot attach a static Authorization header.

Former development callback/webhook paths are not routed and return 404.

### Remote MCP surface

Exactly two tools are registered:

- `nofax_get_request`
- `nofax_list_pending`

Both carry:

```text
readOnlyHint: true
destructiveHint: false
idempotentHint: true
openWorldHint: false
```

The annotations are not treated as enforcement. `createRemoteToolHandlers()` itself returns only the two read functions.

### Request projections

`nofax_get_request` may return:

- request ID;
- kind;
- status;
- creation timestamp;
- terminal decision/timestamp when historical state is already resolved;
- stored historical refinement text when present.

It does not return the original title/message, callback hash/capability, or internal allowed-decision list.

`nofax_list_pending` returns bounded public projections for unresolved, unexpired rows only.

### Observational list semantics

The list query uses an expiry predicate rather than deleting stale rows. This is intentional: a read-only MCP call must not cause state mutation as a cleanup side effect.

### Durable Object compatibility

The request table/schema and legacy internal methods are retained so deployments created during pre-release experimentation do not require destructive migration. Those mutation methods are not reachable through the Worker router or MCP handler surface.

## Authentication

`NOFAX_REMOTE_KEY` is a deployment-wide bearer credential intended for private single-user operation.

Preferred form:

```text
Authorization: Bearer <NOFAX_REMOTE_KEY>
```

Compatibility form:

```text
/mcp/<NOFAX_REMOTE_KEY>
```

Credential comparison is equal-length constant-time. Capability-path requests are normalized to `/mcp` before protocol handling.

A future shared/public service would need delegated per-user authentication/authorization rather than one deployment key.

## Security boundaries

### Local

- ntfy topics and one-time response URLs are capabilities.
- public ntfy is not application-level end-to-end encryption from the provider.
- secret-key redaction is best-effort; arbitrary free-form text may still contain secrets.
- the originating agent remains responsible for deciding which actions require approval.

### Remote

- Cloudflare receives authenticated MCP requests and returned read-only request metadata.
- the Worker does not forward request data to a messaging provider.
- the remote MCP key and full capability URL are secrets.
- MCP annotations improve client UX but are not considered a security control.
- hard read-only behavior comes from the two-tool/two-handler/router structure.

See [`../SECURITY.md`](../SECURITY.md) and [`remote-mcp.md`](remote-mcp.md) for operational guidance.
