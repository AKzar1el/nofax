# Remote MCP on Cloudflare Workers

Nofax v0.3 adds an optional remote MCP transport for users who want the same phone approval workflow without launching a local stdio Nofax process.

The remote runtime is self-deployed to your own Cloudflare account. It does not replace the local CLI/MCP implementation and it is not a Nofax-operated SaaS.

Local Nofax continues to use ntfy. The remote Worker uses Telegram by default because public ntfy free-tier traffic can be rate-limited by shared serverless egress IPs.

## Architecture

```text
MCP client
   |
   | private Streamable HTTP
   v
Cloudflare Worker /mcp
   |
   +--> Nofax tool handler
   |       |
   |       +--> SQLite Durable Object: pending request
   |       |
   |       +--> Telegram Bot API: phone message
   |
Telegram on phone
   |
   | Allow / Deny / Choice -> callback_query
   | Refine -> Worker-hosted form
   v
POST /telegram/webhook  or  /r/<callback-token>/refine
   |
   v
SQLite Durable Object: terminal result
   |
   v
nofax_wait_for_response
```

The MCP protocol is stateless Streamable HTTP. Human-response state is separate and durable.

## Free-only constraint

The default remote path is intentionally free-only:

- Telegram normal Bot API messaging is used within its ordinary free limits.
- Nofax never sends `allow_paid_broadcast=true` and does not use Telegram Stars.
- The Worker uses Cloudflare Workers Free-compatible primitives and a SQLite-backed Durable Object.
- Nofax has no paid fallback. Provider/limit failures fail closed instead of silently incurring charges.

Always check current provider limits before relying on a free tier in production.

## Why a Durable Object

A remote MCP request may end before a human responds. Nofax therefore never treats one long HTTP connection as the source of truth.

Each interactive request is persisted before notification delivery. The stored row contains:

- request ID;
- interaction kind;
- bounded title and message;
- allowed terminal decisions;
- SHA-256 hash of the callback capability;
- creation/expiry timestamps;
- terminal decision/refinement after resolution.

The raw callback token is discarded after Telegram publication. It is not returned by any MCP tool.

Pending callback capabilities expire after 24 hours. Resolved rows are retained for a bounded recovery period and then removed by lazy cleanup.

## Human-response contract

Interactive request tools return immediately with a durable handle:

```json
{
  "status": "pending",
  "requestId": "nfx_...",
  "mustWait": true,
  "instruction": "WAIT REQUIRED: ..."
}
```

The caller then invokes:

```text
nofax_wait_for_response
```

A remote wait lasts at most 20 seconds. If the result is still pending, the caller must invoke the same wait tool again with the same request ID.

This repetition is intentional. Nofax does not assume a remote MCP server can universally force every host/model to start a new model turn after an unsolicited phone event.

Terminal semantics match local Nofax:

- `allow`: continue only within the authority the caller already had;
- `deny`: do not perform the guarded action;
- `refine`: apply the human text and request a fresh approval if the revised action still requires approval;
- explicit choice: use exactly the selected value.

Timeout, network failure, missing state, malformed callbacks, and expired capabilities never become approval.

## Telegram phone UX

### Allow / Deny

Approval messages use one inline keyboard row:

```text
[ Allow ] [ Refine ] [ Deny ]
```

When Refine is not enabled, the middle button is omitted. Allow and Deny are Telegram callback buttons, so one tap sends a `callback_query` to Nofax.

### Choice

Choice requests support up to three explicit callback buttons. Telegram callback data contains only the one-time Nofax callback capability and a compact option index. The authoritative allowed values remain in the Durable Object.

### Refine

Refine is a Telegram URL button opening:

```text
GET /r/<callback-token>
```

The page is rendered server-side and contains one bounded textarea. It uses no external JavaScript, analytics, fonts, or third-party assets. Submission posts to:

```text
POST /r/<callback-token>/refine
```

Remote Refine therefore requires no Apple Shortcut.

## Telegram webhook security

Telegram callbacks arrive at:

```text
POST /telegram/webhook
```

Nofax requires all of the following before changing durable state:

1. `X-Telegram-Bot-Api-Secret-Token` matches `TELEGRAM_WEBHOOK_SECRET` using equal-length constant-time comparison;
2. `callback_query.from.id` matches `TELEGRAM_USER_ID`;
3. `callback_query.message.chat.id` matches `TELEGRAM_CHAT_ID`;
4. callback data has the Nofax grammar;
5. the callback capability is live and unexpired;
6. the requested decision is explicitly allowed by the stored request.

After a durable terminal result is written, Nofax best-effort calls Telegram `answerCallbackQuery` and edits the original message to show the terminal state. If that UI feedback fails, the durable terminal result remains authoritative.

First terminal response wins. A replay cannot replace an existing result.

## MCP authentication

The v0.3 remote Worker is designed for private single-user use.

### Preferred: Authorization header

```text
https://<worker>.workers.dev/mcp
Authorization: Bearer <NOFAX_REMOTE_KEY>
```

### Compatibility: private capability URL

For MCP clients that cannot attach a static header:

```text
https://<worker>.workers.dev/mcp/<NOFAX_REMOTE_KEY>
```

The path form is a bearer capability. Treat the complete URL like a password. Do not publish it, paste it into issues, expose it to analytics, or share screenshots containing it.

After successful authentication, Nofax normalizes the request internally to `/mcp` and removes the Authorization header before MCP protocol handling.

`/telegram/webhook` and `/r/...` callback routes do **not** require `NOFAX_REMOTE_KEY`; they have separate verification/capability boundaries.

OAuth 2.1 remains the hardening path before any multi-user/public hosted deployment.

## Telegram setup and deployment

### 1. Create a private bot

Open the official `@BotFather` account and send:

```text
/newbot
```

After BotFather creates the bot, open it and send `/start`.

Keep the returned bot token private.

### 2. Discover IDs before registering a webhook

Call Telegram `getUpdates` with the bot token and inspect the `/start` message:

```text
message.from.id -> TELEGRAM_USER_ID
message.chat.id -> TELEGRAM_CHAT_ID
```

### 3. Generate secrets

Generate high-entropy values for:

```text
TELEGRAM_WEBHOOK_SECRET
NOFAX_REMOTE_KEY
```

Example:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

### 4. Store Worker secrets and deploy

From `worker/`:

```bash
npm ci
npx wrangler login
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put TELEGRAM_USER_ID
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put NOFAX_REMOTE_KEY
npm run check
npm run deploy
```

No Telegram secret belongs in `wrangler.jsonc`, source, `.env`, `.dev.vars`, screenshots, or issue text.

### 5. Register webhook

Call Telegram `setWebhook` with:

```text
url = https://<worker>.workers.dev/telegram/webhook
secret_token = <TELEGRAM_WEBHOOK_SECRET>
allowed_updates = ["callback_query"]
```

For first setup, `drop_pending_updates=true` is reasonable.

Then call `getWebhookInfo` and verify the expected URL and no current delivery error.

## Qualification checklist

A release-quality remote deployment should verify all of the following:

1. `/healthz` returns only `{ "status": "ok" }`.
2. `/mcp` rejects missing/wrong credentials.
3. An authenticated MCP client discovers exactly seven Nofax tools.
4. `nofax_notify` reaches the Telegram phone chat.
5. `nofax_request_approval` + repeated waits returns terminal `allow` after tapping Allow.
6. A new request returns terminal `deny` after tapping Deny.
7. A Refine request opens the Worker form and returns exactly the submitted bounded text.
8. A choice request maps the tapped button to the exact stored option.
9. Pending requests remain recoverable by request ID after MCP/client interruption.
10. A second callback cannot replace the first terminal response.
11. Expired callback capabilities fail closed.
12. Wrong webhook secret/user/chat cannot mutate request state.

MCP Inspector is the protocol-level qualification tool. Client-specific tool scans are additional compatibility evidence, not a replacement for the protocol test.

## Threat boundaries

Remote mode adds hosted infrastructure that local mode does not require:

- Cloudflare receives remote MCP requests, bounded request summaries, Telegram webhook callback requests, and Refine text.
- Telegram receives notification/request summaries, inline callback capabilities, and Refine URLs.

Neither boundary should be described as application-level end-to-end encryption by Nofax.

The following values are secrets/capabilities:

- `TELEGRAM_BOT_TOKEN`;
- `TELEGRAM_CHAT_ID` / `TELEGRAM_USER_ID` as private deployment metadata;
- `TELEGRAM_WEBHOOK_SECRET`;
- `NOFAX_REMOTE_KEY`;
- each raw callback token;
- the full `/mcp/<key>` capability URL.

If a bot token, webhook secret, or remote MCP key is exposed, rotate it. Callback tokens expire and are single-use, but should still never be logged or shared.

## Local versus remote

| Capability | Local Nofax | Remote Worker |
| --- | --- | --- |
| MCP transport | stdio | Streamable HTTP |
| Human state | local request files | SQLite Durable Object |
| Phone transport | ntfy | Telegram Bot API |
| Allow/Deny | ntfy response topic | Telegram callback query |
| Refine | iOS Shortcut callback | Worker-hosted HTML form opened from Telegram |
| Inbound port on PC | none | none |
| Hosted Nofax service required | no | no; self-deploy Worker |
| MCP auth | local process boundary | private bearer key |
| Max wait per call | 240 s | 20 s |

Both transports intentionally expose the same seven public tool names and terminal decision semantics.
