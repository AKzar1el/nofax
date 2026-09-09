# Security Policy

## Supported versions

Nofax is pre-1.0 software. Security fixes are applied to the latest release on the default branch.

## Reporting a vulnerability

Do not publish credentials, exploit details, private ntfy topics, one-time response URLs, or sensitive hook/MCP payloads in a public issue.

If GitHub private vulnerability reporting is enabled for this repository, use it. Otherwise, open a minimal public issue asking for a private maintainer contact channel without including sensitive details.

## Important deployment assumptions

### Public ntfy is not end-to-end encryption

With the default `https://ntfy.sh` configuration, notification content transits and may be cached by the ntfy service. Random topic names reduce unauthorized discovery but do not encrypt messages from the service operator.

Use a trusted self-hosted ntfy server for sensitive source code, production operations, credentials, regulated data, or confidential prompts.

### Topics and callback URLs are capabilities

On anonymous ntfy servers, knowledge of a topic can be sufficient to subscribe or publish. Nofax generates high-entropy phone topics and a fresh response topic for every human interaction.

The iOS refinement Shortcut receives a one-time `callbackUrl`. Treat it as a bearer capability. Do not log, share, bookmark, or persist it outside Nofax's local request state.

### Durable request state is sensitive local metadata

MCP human-response requests are stored under `~/.nofax/requests/` so a client or MCP process restart cannot erase an unresolved approval gate. These files include the one-time response topic needed to recover the wait.

Nofax writes them with user-only permissions where supported. MCP-facing request projections deliberately omit the response topic. Protect the Nofax home directory like other local application state.

### Pending never means approved

A Nofax MCP request returns `status: "pending"` until a matching terminal phone response is accepted. A model or caller must not infer approval from the passage of time, a timeout, a tool error, or a client disconnect.

`nofax_wait_for_response` uses bounded long-polls. When it returns pending, the caller is explicitly required to call it again rather than continue the guarded action.

### First terminal response wins

Nofax treats a durable request as single-use. Once a valid terminal response is persisted, later responses cannot intentionally expand that decision. Confirmation notifications are best-effort and do not alter the stored terminal result.

### Nofax is not a policy engine

Nofax answers approval requests that an upstream agent or workflow explicitly delegates to it. It does not decide which operations should require approval and must not be used to bypass an agent's deny rules, sandbox, or existing authorization boundaries.

### Native hook failures never become approval

Timeout, malformed remote responses, publish failures, and poll failures never resolve to `allow`. Native Claude Code and Codex adapters return no decision so the upstream tool can continue with its normal approval path.

### Redaction is best-effort

Nofax redacts values under common secret-bearing object keys and bounds serialized payloads. It cannot reliably detect a secret embedded in arbitrary free-form command text. Treat notification content accordingly.

### MCP transport

`nofax mcp` is a local stdio server. Stdout is reserved for MCP protocol traffic. Do not wrap it with tooling that injects banners or diagnostics into stdout. Codexify and other MCP aggregators launch the process with the same OS-user privileges as the caller; only bridge Nofax from hosts you trust.
