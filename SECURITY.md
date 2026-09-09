# Security Policy

## Supported versions

Nofax is pre-1.0 software. Security fixes are applied to the latest release on the default branch.

## Reporting a vulnerability

Do not publish credentials, exploit details, private ntfy topics, Telegram bot tokens, Telegram webhook secrets, one-time response URLs, remote MCP capability URLs, or sensitive hook/MCP payloads in a public issue.

If GitHub private vulnerability reporting is enabled for this repository, use it. Otherwise, open a minimal public issue asking for a private maintainer contact channel without including sensitive details.

## Important deployment assumptions

### Local public ntfy is not end-to-end encryption

With the default local `https://ntfy.sh` configuration, notification content transits and may be cached by the ntfy service. Random topic names reduce unauthorized discovery but do not encrypt messages from the service operator.

Use a trusted authenticated/self-hosted ntfy server for sensitive local source code, production operations, credentials, regulated data, or confidential prompts.

### Local topics and callback URLs are capabilities

On anonymous ntfy servers, knowledge of a topic can be sufficient to subscribe or publish. Treat the local ntfy topic as a bearer secret.

Local Nofax generates a fresh one-time ntfy response topic for every interactive request. Remote Nofax generates a fresh per-request Worker callback token instead.

Do not log, share, bookmark, or persist raw callback capability URLs outside the state Nofax itself requires.

### Remote MCP key is a bearer secret

The optional Cloudflare Worker is a private single-user deployment protected by `NOFAX_REMOTE_KEY`.

Preferred clients send:

```text
Authorization: Bearer <NOFAX_REMOTE_KEY>
```

Clients that cannot attach a static header may use:

```text
/mcp/<NOFAX_REMOTE_KEY>
```

The complete capability URL is equivalent to a password. It may leak through browser history, screenshots, copied configuration, proxies, or third-party logging if handled carelessly. Prefer the Authorization header whenever the MCP host supports it.

Nofax does not intentionally log request URLs. After authentication, the Worker normalizes the MCP request to `/mcp` and removes the Authorization header before protocol handling.

This deployment-wide key is not sufficient authentication for a multi-user/public service. Use an OAuth 2.1 authorization design before exposing Nofax as a shared public remote MCP service.

### Telegram remote secrets and identity binding

The default remote Worker transport uses Telegram Bot API. Treat all of these as sensitive deployment values:

- `TELEGRAM_BOT_TOKEN`;
- `TELEGRAM_WEBHOOK_SECRET`;
- `TELEGRAM_CHAT_ID`;
- `TELEGRAM_USER_ID`.

Telegram interactive callbacks are accepted only at `POST /telegram/webhook` and only after Nofax verifies:

1. `X-Telegram-Bot-Api-Secret-Token` against `TELEGRAM_WEBHOOK_SECRET` with equal-length constant-time comparison;
2. `callback_query.from.id` against `TELEGRAM_USER_ID`;
3. `callback_query.message.chat.id` against `TELEGRAM_CHAT_ID`;
4. the Nofax callback-data grammar;
5. the live one-time callback capability;
6. the stored allowed decision.

A Telegram UI acknowledgement is never authority. Durable request resolution is the source of truth.

If a bot token or webhook secret is exposed, rotate it before trusting further callbacks.

### No paid Telegram path

Nofax remote mode deliberately does not opt into Telegram paid broadcasts and does not send `allow_paid_broadcast=true`.

There is no paid-provider fallback. If a normal free Telegram call or Cloudflare free-tier operation fails, Nofax fails closed rather than silently incurring charges.

Provider pricing and free limits are external policy and may change; re-check them before production use.

### Remote callback tokens are independent capabilities

Telegram callback data and Refine URLs never contain `NOFAX_REMOTE_KEY`. Every remote interactive request gets a fresh high-entropy callback token with a 24-hour expiry.

The raw token is used only to construct Telegram controls / the Refine URL. The Durable Object stores only its SHA-256 hash. Unknown, malformed, or expired tokens fail closed.

A valid callback can resolve only to a decision explicitly allowed by the stored request. The first accepted terminal response wins and later callback attempts cannot replace it.

### Cloudflare and Telegram are infrastructure trust boundaries

Remote mode adds hosted infrastructure that local mode does not require:

- Cloudflare receives remote MCP requests, bounded request summaries, Telegram webhook callbacks, and browser Refine text.
- Telegram receives notification/request summaries and inline callback or Refine controls.

Nofax does not claim these paths are application-level end-to-end encrypted from the infrastructure operators.

Do not place credentials or secrets in free-form approval text unless you accept those infrastructure boundaries.

### Browser Refine is bounded but still sensitive

Remote Refine text is submitted to the Worker and persisted as terminal request state for the bounded recovery window.

The Refine page is server-rendered with escaped user content, `Cache-Control: no-store`, a restrictive Content Security Policy, `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer`. It loads no external JavaScript, fonts, analytics, or third-party assets.

These controls reduce browser-side exposure; they do not remove the Cloudflare trust boundary.

### Durable request state is sensitive metadata

Local MCP human-response requests are stored under `~/.nofax/requests/` so a client or MCP process restart cannot erase an unresolved approval gate. These files include the one-time response topic needed to recover the wait.

Nofax writes them with user-only permissions where supported. MCP-facing request projections deliberately omit the response topic. Protect the Nofax home directory like other local application state.

Remote MCP requests are stored in a SQLite-backed Durable Object. Stored rows contain bounded request summaries, the callback-token hash, allowed decisions, timestamps, and terminal response/refinement after resolution. Raw callback tokens, Telegram bot tokens, and `NOFAX_REMOTE_KEY` are not stored in request rows.

Expired pending rows and old resolved rows are lazily cleaned up.

### Pending never means approved

A Nofax MCP request returns `status: "pending"` until a matching terminal phone response is accepted. A model or caller must not infer approval from the passage of time, a timeout, a tool error, or a client disconnect.

`nofax_wait_for_response` uses bounded long-polls. Local waits are capped at 240 seconds; remote Worker waits are capped at 20 seconds. When a wait returns pending, the caller is explicitly required to call it again rather than continue the guarded action.

### First terminal response wins

Nofax treats a durable request as single-use. Once a valid terminal response is persisted, later responses cannot intentionally expand or replace that decision. Telegram callback answers/message edits and confirmation notifications are best-effort and do not alter the stored terminal result.

### Nofax is not a policy engine

Nofax answers approval requests that an upstream agent or workflow explicitly delegates to it. It does not decide which operations should require approval and must not be used to bypass an agent's deny rules, sandbox, or existing authorization boundaries.

An `allow` result permits the caller to continue only within authority it already possessed.

### Native hook failures never become approval

Timeout, malformed remote responses, publish failures, and poll failures never resolve to `allow`. Native Claude Code and Codex adapters return no decision so the upstream tool can continue with its normal approval path.

### Redaction is best-effort

Nofax redacts values under common secret-bearing object keys and bounds serialized payloads. It cannot reliably detect a secret embedded in arbitrary free-form command text. Treat notification and MCP content accordingly.

### Local MCP transport

`nofax mcp` is a local stdio server. Stdout is reserved for MCP protocol traffic. Do not wrap it with tooling that injects banners or diagnostics into stdout. Codexify and other MCP aggregators launch the process with the same OS-user privileges as the caller; only bridge Nofax from hosts you trust.

### Remote MCP transport

The optional Worker uses stateless Streamable HTTP for MCP protocol traffic and a SQLite-backed Durable Object only for Nofax human-response state. The MCP endpoint is private; `/healthz`, `/telegram/webhook`, and per-request `/r/...` callback routes are intentionally separate from deployment-key authentication and have their own boundaries.

Do not expose deployment secrets in source, Wrangler vars, `.dev.vars`, `.env`, CI logs, PR text, screenshots, or issue reports. Use Wrangler secrets for production values and keep local secret files untracked.

See [`docs/remote-mcp.md`](docs/remote-mcp.md) for the remote architecture and qualification checklist.
