# Nofax Remote Worker

This package is the optional Cloudflare Workers transport for Nofax. It exposes the same seven Nofax MCP tools as the local stdio server, stores pending human-response state in a SQLite-backed Durable Object, and uses Telegram for remote phone delivery.

It is designed for a **private, single-user deployment in your own Cloudflare account**. Nofax does not operate a hosted service for this component.

Local Nofax CLI/Claude/Codex hooks still use ntfy. Telegram is the default only for the Cloudflare remote Worker because public ntfy can rate-limit shared serverless egress IPs.

## What it provides

- Stateless Streamable HTTP MCP at `/mcp`.
- Private MCP authentication with `NOFAX_REMOTE_KEY`.
- Durable pending requests in a SQLite-backed Durable Object.
- Telegram **Allow**, **Deny**, and explicit-choice callback buttons.
- Telegram **Refine** button opening the Worker-hosted browser form.
- Verified Telegram webhook at `POST /telegram/webhook`.
- Exact Telegram user/chat binding for decision callbacks.
- First-terminal-response-wins semantics.
- 24-hour callback capability expiry and lazy stale-state cleanup.
- Bounded 20-second MCP waits; callers repeat the wait tool until terminal.

## Free-only design

Nofax remote mode does not enable Telegram paid broadcasts and never sends `allow_paid_broadcast=true`. Normal Bot API messaging is sufficient for the expected private single-user workload.

The Worker is designed to fit the Cloudflare Workers Free plan and uses a SQLite-backed Durable Object, which Cloudflare makes available on Workers Free subject to current free-tier limits.

Nofax has no paid-provider fallback. If a free provider rejects a request or a free-tier limit is reached, the operation fails closed rather than silently incurring a charge.

## Requirements

- Node.js 22 or newer for Worker development.
- A Cloudflare account with Workers enabled.
- A Telegram account and the Telegram app on your phone.
- One private Telegram bot created through `@BotFather`.
- Wrangler authentication for deployment.

## Telegram setup

### 1. Create the bot

In Telegram, open the official `@BotFather` account and send:

```text
/newbot
```

Choose a display name and a unique username ending in `bot`. BotFather returns the bot token. Treat the token like a password and never commit or paste it into issues/screenshots.

Open your new bot and send:

```text
/start
```

Do this **before** registering a webhook so `getUpdates` can discover the private chat/user IDs.

### 2. Discover your private IDs

Before a webhook exists, call Telegram `getUpdates` with the bot token and inspect the latest `/start` message:

```text
message.from.id -> TELEGRAM_USER_ID
message.chat.id -> TELEGRAM_CHAT_ID
```

For a private one-to-one bot chat these are usually the same numeric value, but Nofax stores and validates both explicitly.

### 3. Create the webhook secret

Generate a high-entropy value outside the repository. For example with Node:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Use that value as `TELEGRAM_WEBHOOK_SECRET`.

## Deploy

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

All five production values are secrets. Never commit them to `wrangler.jsonc`, `.env`, `.dev.vars`, CI output, issues, or screenshots.

`NTFY_TOPIC` / `NTFY_SERVER` may remain in an older deployment for compatibility, but the default remote Worker no longer uses ntfy for phone delivery. Local Nofax still uses ntfy normally.

## Register the Telegram webhook

After deployment, register:

```text
https://<worker>.workers.dev/telegram/webhook
```

with Telegram `setWebhook` using:

- `secret_token = TELEGRAM_WEBHOOK_SECRET`
- `allowed_updates = ["callback_query"]`
- optionally `drop_pending_updates = true` for first-time setup.

Then call Telegram `getWebhookInfo` and verify the URL is correct and no delivery error is reported.

Telegram sends the configured secret in `X-Telegram-Bot-Api-Secret-Token`. Nofax rejects missing/wrong secrets before touching durable request state.

## Connect an MCP client

Preferred mode for clients that support custom headers:

```text
https://<worker>.workers.dev/mcp
Authorization: Bearer <NOFAX_REMOTE_KEY>
```

Private capability-URL mode for clients that cannot attach a static header:

```text
https://<worker>.workers.dev/mcp/<NOFAX_REMOTE_KEY>
```

The capability URL is itself a bearer secret. Do not paste it into public issues, logs, screenshots, analytics, or shared configuration. Prefer the Authorization header when the MCP client supports it.

The Worker normalizes the authenticated request to `/mcp` before protocol handling and does not intentionally log capability URLs.

## Phone callbacks

Telegram interactive messages contain only a fresh per-request callback capability. They never contain `NOFAX_REMOTE_KEY`.

Allow/Deny/choice buttons use compact Telegram `callback_data` and resolve through:

```text
POST /telegram/webhook
```

Nofax verifies:

1. Telegram webhook secret;
2. configured Telegram user ID;
3. configured Telegram chat ID;
4. callback-data grammar;
5. live callback capability;
6. stored allowed decision.

Only then is the durable request resolved. The first accepted terminal response wins.

After durable resolution, Nofax best-effort answers the Telegram callback and edits the message to show the terminal result. Telegram UI feedback failure cannot undo a valid durable decision.

### Refine

The **Refine** Telegram button opens:

```text
GET /r/<callback-token>
```

Submission posts to:

```text
POST /r/<callback-token>/refine
```

The Refine page is server-rendered HTML with no external JavaScript, fonts, analytics, or third-party assets. The raw callback token is not stored; the Durable Object keeps only its SHA-256 hash.

## MCP tools

The remote server exposes:

- `nofax_notify`
- `nofax_request_approval`
- `nofax_request_choice`
- `nofax_request_refinement`
- `nofax_wait_for_response`
- `nofax_get_request`
- `nofax_list_pending`

Request tools return durable `status: "pending"` state. `nofax_wait_for_response` waits for at most 20 seconds per call. If it still returns pending, the caller **must call it again with the same request ID** and must not infer approval.

## Security boundary

This private-key scheme is intentionally scoped to single-user/private deployments. It is not a substitute for per-user identity, delegated authorization, revocation, or audit controls in a public multi-user service.

Before multi-user/public hosting, use an OAuth 2.1 authorization design rather than sharing one deployment-wide bearer key.

Remote mode adds two hosted trust boundaries:

- Cloudflare receives MCP requests, bounded request summaries, Telegram webhook callbacks, and Refine text.
- Telegram receives notification/request summaries and inline callback/Refine controls.

Do not place secrets in free-form approval text unless you accept those infrastructure boundaries. Read [`../SECURITY.md`](../SECURITY.md) before using Nofax for sensitive work.

## Development

```bash
npm ci
npm run check
```

Individual commands:

```bash
npm test
npm run typecheck
npx wrangler deploy --dry-run
npm run dev
```

Do not commit `.dev.vars`, `.env`, Cloudflare credentials, Telegram bot tokens, Telegram IDs/webhook secrets, ntfy topics, remote keys, or callback URLs.

See [`../docs/remote-mcp.md`](../docs/remote-mcp.md) for the full architecture and qualification flow.
