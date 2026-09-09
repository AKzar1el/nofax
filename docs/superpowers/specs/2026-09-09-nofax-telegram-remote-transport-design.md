# Nofax Telegram Remote Transport Design

## Goal

Replace ntfy.sh as the default Cloudflare remote-notification transport with Telegram Bot API while preserving the existing Nofax MCP tool surface, Durable Object request state, browser-based Refine form, and local ntfy CLI/hooks.

## Hard constraints

- Free-only: no paid API, no Telegram Stars, no paid broadcasts, no Cloudflare paid feature, and no paid fallback.
- Never set Telegram `allow_paid_broadcast=true`.
- Keep local Nofax CLI/Claude/Codex ntfy behavior unchanged.
- Keep the seven remote MCP tool names and durable wait semantics unchanged.
- Pending, timeout, malformed, replayed, expired, or delivery-failed state never becomes approval.
- First terminal response wins.
- No bot token, webhook secret, chat ID, callback capability, or MCP key may be committed or returned by MCP tools.

## Architecture

Remote mode becomes:

`MCP client -> Cloudflare Worker -> Durable Object -> Telegram Bot API -> iPhone -> Telegram webhook or Refine page -> Durable Object -> nofax_wait_for_response -> MCP client`

The Worker remains stateless at the HTTP edge. Durable request state remains in the existing `NofaxRequestStore` Durable Object. Telegram becomes a transport adapter rather than authority: all decisions are validated and committed by the existing request store.

## Telegram configuration

Cloudflare secrets:

- `TELEGRAM_BOT_TOKEN`: BotFather token.
- `TELEGRAM_CHAT_ID`: the single private chat allowed to receive Nofax prompts.
- `TELEGRAM_USER_ID`: the Telegram user allowed to resolve callback-query decisions.
- `TELEGRAM_WEBHOOK_SECRET`: high-entropy secret passed to Telegram `setWebhook` and verified from `X-Telegram-Bot-Api-Secret-Token`.

Existing `NOFAX_REMOTE_KEY` remains the MCP credential. `NTFY_TOPIC` becomes optional for remote deployments and is retained only for compatibility/self-hosted transport experiments.

## Outbound messages

`nofax_notify` calls Telegram `sendMessage` with title + message and no keyboard.

Interactive requests call `sendMessage` with an inline keyboard:

- approval: `Allow`, optional `Refine`, `Deny`.
- choice: up to three explicit option buttons.
- refinement-only: one `Refine` URL button.

Allow/Deny/choice buttons use `callback_data` containing only a compact opaque callback capability plus an option index/action code. The actual allowed decision remains authoritative in the Durable Object. Refine uses the existing one-time browser URL `/r/<token>`.

No outbound Telegram request enables paid broadcasts.

## Webhook

Public route: `POST /telegram/webhook`.

The route must:

1. Require an exact constant-time match of `X-Telegram-Bot-Api-Secret-Token` against `TELEGRAM_WEBHOOK_SECRET`.
2. Accept only Telegram updates containing a `callback_query` for the configured `TELEGRAM_USER_ID` and `TELEGRAM_CHAT_ID`.
3. Parse only Nofax callback-data format.
4. Hash the embedded one-time callback token and resolve the existing Durable Object request through `resolveByCallbackHash`.
5. Preserve first-terminal-response-wins and reject expired/invalid/replayed capabilities.
6. Call `answerCallbackQuery` for immediate phone feedback.
7. Best-effort edit the Telegram message to remove its inline keyboard and show the terminal status.

A webhook acknowledgement or Telegram UI response never substitutes for durable request resolution.

## Refine

Refine continues to use the existing browser form and `/r/<token>/refine` callback. The Refine Telegram button is a URL button pointing at `/r/<token>`.

After terminal Refine submission, confirmation is sent through Telegram rather than ntfy. The returned MCP result remains `{ decision: "refine", text }` and the caller must create a new approval if the refined action still requires one.

## Transport boundary

Create `worker/src/telegram.ts` as the only module that knows Telegram Bot API HTTP details. MCP handlers consume a generic remote notification interface so the request/authority logic does not depend on Telegram.

`worker/src/ntfy.ts` remains for local/legacy behavior but is no longer used by the default remote Worker path.

## Setup flow

1. User creates a bot with BotFather.
2. User sends `/start` to the bot.
3. A setup helper or direct Bot API `getUpdates` obtains the private chat/user ID.
4. Store Telegram values as Worker secrets.
5. Register `https://<worker>/telegram/webhook` with Telegram `setWebhook` using `secret_token` and allowed update `callback_query`.
6. Run live MCP notification and approval tests.

## Failure behavior

- Telegram non-2xx or network failure: delete the newly created pending request and return a delivery error to MCP.
- Invalid webhook secret/user/chat/data: reject without mutation.
- Duplicate callback: return acknowledgement but do not replace the terminal result.
- `answerCallbackQuery`/message-edit failure after durable resolution: preserve the durable terminal result; phone confirmation is best-effort.
- Missing Telegram configuration: fail with explicit `NOFAX_TELEGRAM_*_REQUIRED` error.

## Test and release gates

Before merge:

- Unit tests for Telegram payloads, free-only invariant, webhook authentication, callback parsing, user/chat binding, replay behavior, and confirmation behavior.
- Existing Worker tests remain green.
- Worker TypeScript and Wrangler dry-run pass.
- Official MCP Inspector still discovers exactly seven tools.
- Live `nofax_notify` reaches Telegram on iPhone.
- Live Allow returns terminal `allow` to MCP.
- Live Deny returns terminal `deny` to MCP.
- Live Refine returns exact submitted text.
- ChatGPT custom NoFax app completes at least one real approval loop.
- Only after all gates pass: mark PR #3 ready, merge, then rotate any credentials exposed during qualification.
