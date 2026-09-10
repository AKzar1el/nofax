# Security Policy

## Supported versions

Nofax is pre-1.0 software. Security fixes are applied to the latest release on the default branch.

## Reporting a vulnerability

Do not publish credentials, exploit details, private ntfy topics, one-time response URLs, remote MCP capability URLs, or sensitive hook/MCP payloads in a public issue.

If GitHub private vulnerability reporting is enabled for this repository, use it. Otherwise, open a minimal public issue asking for a private maintainer contact channel without including sensitive details.

## Local Nofax security

### Public ntfy is not end-to-end encryption

With the default `https://ntfy.sh` configuration, notification content transits and may be cached by the ntfy service. A random topic name reduces unauthorized discovery but does not encrypt content from the service operator.

Use a trusted authenticated/self-hosted ntfy server for sensitive source code, production operations, credentials, regulated data, or confidential prompts.

### Topics and one-time response URLs are capabilities

On anonymous ntfy servers, knowledge of a topic can be sufficient to subscribe or publish. Treat the local ntfy topic as a bearer secret.

Local Nofax generates fresh one-time response topics for interactive requests. Do not log, share, bookmark, or persist those callback URLs outside the state Nofax itself requires.

### Durable local request state

Local MCP human-response requests are stored under `~/.nofax/requests/` so an MCP/client restart does not erase an unresolved human decision gate.

Nofax writes these files with user-only permissions where supported. MCP-facing request projections deliberately omit the secret response topic. Protect the Nofax home directory like other local application state.

### Pending never means approved

A local interactive request remains pending until a matching terminal response is accepted. Passage of time, timeout, tool failure, network failure, or client disconnect never means approval.

`nofax_wait_for_response` uses bounded long-polls. If it returns pending, the caller must wait again rather than continue the guarded action.

### First terminal response wins

Local durable requests are single-use. Once a valid terminal response is accepted, later responses cannot intentionally replace it.

### Native hook failures never become approval

The Claude Code and Codex adapters fail closed. If the local transport times out, returns malformed data, or encounters a network/polling error, Nofax does not synthesize an Allow decision.

### Redaction is best-effort

Nofax redacts values under common secret-bearing object keys and bounds serialized payloads. It cannot reliably detect a credential embedded in arbitrary free-form command text. Treat all notification content accordingly.

## Read-only remote Worker security

The optional Cloudflare Worker in v0.3 is a **one-way notification plus inspection remote MCP endpoint**.

### Remote side effects are structurally bounded

MCP tool annotations are descriptive metadata, not the security boundary.

The remote Worker bounds side effects in code:

- only `nofax_notify`, `nofax_get_request`, and `nofax_list_pending` are registered as MCP tools;
- the remote handler object exposes one-way notification plus two read operations;
- there is no remote approval, choice, refinement, wait, callback, or webhook handler;
- public Worker routing is limited to health and authenticated MCP paths;
- `/telegram/webhook` and `/r/*` are not routes and return 404;
- pending-list reads filter expired rows without deleting them or performing hidden cleanup writes.

The two inspection tools are annotated with `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, and `openWorldHint: false`. `nofax_notify` is accurately marked side-effecting/non-idempotent/open-world and non-destructive.

### Remote response minimization

Remote MCP responses deliberately omit capability-bearing or unnecessary fields. Public request projections do not expose:

- callback hashes;
- callback tokens/URLs;
- original request title;
- original request message/prompt material;
- internal allowed-decision lists.

Terminal state may include the stored terminal decision and historical refinement text when present in existing durable state.

### Remote MCP key is a bearer secret

The Worker is a private single-user deployment protected by `NOFAX_REMOTE_KEY`.

Preferred clients send:

```text
Authorization: Bearer <NOFAX_REMOTE_KEY>
```

Clients that cannot attach a static header may use:

```text
/mcp/<NOFAX_REMOTE_KEY>
```

The complete capability URL is equivalent to a password and may leak through browser history, screenshots, copied configuration, proxies, or third-party logging. Prefer the Authorization header whenever the MCP host supports it.

Nofax uses equal-length constant-time credential comparison. After capability-path authentication, the Worker normalizes the request internally to `/mcp` before MCP protocol handling.

Rotate `NOFAX_REMOTE_KEY` immediately if it is exposed.

A single deployment-wide key is not sufficient for a shared/public multi-user service. Use a delegated authentication and authorization design before operating a multi-user deployment.

### Durable Object compatibility

The v0.3 Worker preserves the existing SQLite request schema so upgrading from experimental pre-read-only Worker builds does not require destructive storage migration.

Only read methods are reachable from the public MCP/router surface. Existing legacy rows may therefore be inspected after upgrade, but the read-only Worker cannot create, resolve, or delete them through MCP or HTTP routes.

### Cloudflare is the remote trust boundary

Remote mode adds Cloudflare as an infrastructure boundary. For notification calls, ntfy is an additional provider boundary and receives the bounded notification title/message plus the configured topic identifier.

The Worker does not automatically forward durable request records to ntfy. Only explicit `nofax_notify` content is published; Telegram, WhatsApp, SMS, and human-response callbacks remain absent remotely.

Do not expose the deployment key in source, Wrangler vars, `.env`, `.dev.vars`, CI logs, PR text, screenshots, or issue reports. Use Wrangler secrets for production values and keep local secret files untracked.

## Nofax is not a policy engine

Local Nofax answers approval requests that an upstream agent or workflow explicitly delegates to it. It does not decide which operations should require approval and must not be used to bypass an agent's deny rules, sandbox, or existing authorization boundaries.

An `allow` result permits the caller to continue only within authority it already possessed.

The remote Worker does not grant authority. Its only mutation is sending an informational notification; request-state operations remain inspection-only.

## MCP transport notes

### Local stdio

`nofax mcp` is a local stdio server. Stdout is reserved for MCP protocol traffic. Do not wrap it with tooling that injects banners or diagnostics into stdout.

### Remote Streamable HTTP

The optional Worker uses authenticated Streamable HTTP for MCP. The only unauthenticated functional route is the secret-free `/healthz` health check.

See [`docs/remote-mcp.md`](docs/remote-mcp.md) for the remote architecture and qualification checklist.
