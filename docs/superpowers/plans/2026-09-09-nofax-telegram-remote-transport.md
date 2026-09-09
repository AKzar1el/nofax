# Nofax Telegram Remote Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Telegram Bot API the free default remote phone transport for the Cloudflare Nofax MCP server while preserving local ntfy and all seven MCP tools.

**Architecture:** Add a focused Telegram transport module, route verified Telegram callback queries into the existing Durable Object callback resolver, and inject the Telegram transport into existing MCP request creation. Browser Refine keeps using the existing `/r/<token>` page. Telegram transport never enables paid broadcasts.

**Tech Stack:** TypeScript, Cloudflare Workers, SQLite Durable Objects, Telegram Bot API, Vitest, official MCP TypeScript server.

**Spec:** `docs/superpowers/specs/2026-09-09-nofax-telegram-remote-transport-design.md`

## Global Constraints

- Free-only: never use Telegram paid broadcasts/Stars or paid Cloudflare features.
- Never send `allow_paid_broadcast=true`.
- Keep local ntfy CLI/hooks unchanged.
- Keep all seven remote MCP tool names and durable wait semantics unchanged.
- First terminal response wins and pending/error state never becomes approval.
- Telegram credentials and callback capabilities remain secret.

---

### Task 1: Telegram outbound transport

**Files:**
- Create: `worker/src/telegram.ts`
- Modify: `worker/src/env.ts`
- Test: `worker/test/telegram.test.ts`

**Interfaces:**
- Produces `publishTelegramNotification({ env, title, message, fetchImpl? }): Promise<void>`.
- Produces `publishTelegramInteractive({ env, callbackToken, title, message, options, includeRefine, origin, fetchImpl? }): Promise<void>`.
- Produces `answerTelegramCallback(...)` and `editTelegramTerminalMessage(...)` for webhook feedback.

- [ ] **Step 1: Write failing tests** covering required bot/chat config, normal sendMessage payload, inline Allow/Refine/Deny keyboard order, choice callback-data mapping, Refine URL, HTTP/network failure, and asserting serialized requests do not contain `allow_paid_broadcast`.

Example assertion:

```ts
expect(JSON.stringify(body)).not.toContain("allow_paid_broadcast");
expect(body.reply_markup.inline_keyboard[0].map((b) => b.text)).toEqual(["Allow", "Refine", "Deny"]);
```

- [ ] **Step 2: Run RED**

Run: `npm test -- telegram.test.ts`
Expected: FAIL because `../src/telegram` does not exist.

- [ ] **Step 3: Implement minimum Telegram adapter**

Use `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`. Validate `TELEGRAM_CHAT_ID`, bound title/message, construct callback data such as `nfx:<token>:<index-or-code>`, and never include Telegram paid-broadcast fields.

- [ ] **Step 4: Run GREEN**

Run: `npm test -- telegram.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

`git commit -am "feat: add free Telegram remote transport"`

---

### Task 2: Transport injection into remote MCP handlers

**Files:**
- Modify: `worker/src/mcp-tools.ts`
- Modify: `worker/test/mcp-tools.test.ts`

**Interfaces:**
- Replace direct ntfy production defaults with Telegram production defaults while keeping test dependency injection.
- `createInteraction()` continues to create and store the same callback token/hash/request rows before delivery.

- [ ] **Step 1: Write failing tests** proving `notify`, approval, choice, and refinement use injected Telegram publishers; delivery failure deletes the pending request; durable wait results are unchanged.

- [ ] **Step 2: Run RED**

Run: `npm test -- mcp-tools.test.ts`
Expected: new Telegram-default assertions fail against ntfy defaults.

- [ ] **Step 3: Implement minimum injection change**

Rename generic override fields to `publishInteractiveNotificationImpl` / `publishNotificationImpl` if necessary but set production defaults to Telegram functions. Do not alter request IDs, callback tokens, wait instructions, or terminal semantics.

- [ ] **Step 4: Run GREEN**

Run: `npm test -- mcp-tools.test.ts telegram.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

`git commit -am "feat: route remote MCP notifications through Telegram"`

---

### Task 3: Verified Telegram webhook callbacks

**Files:**
- Create: `worker/src/telegram-webhook.ts`
- Modify: `worker/src/index.ts`
- Test: `worker/test/telegram-webhook.test.ts`
- Modify: `worker/test/router.test.ts`

**Interfaces:**
- Produces `handleTelegramWebhook(request, env, overrides?): Promise<Response>`.
- Public route is exactly `POST /telegram/webhook`.
- Consumes `resolveByCallbackHash()` from the existing request store.

- [ ] **Step 1: Write failing tests** for wrong/missing webhook secret, wrong user, wrong chat, malformed callback data, valid Allow/Deny/choice resolution, expired token, replay/first-terminal-wins, and non-POST routing.

Example valid update shape:

```ts
{
  callback_query: {
    id: "cq1",
    from: { id: 123 },
    message: { chat: { id: 456 }, message_id: 99 },
    data: `nfx:${token}:allow`
  }
}
```

- [ ] **Step 2: Run RED**

Run: `npm test -- telegram-webhook.test.ts router.test.ts`
Expected: FAIL because the webhook route/handler does not exist.

- [ ] **Step 3: Implement minimum webhook handler**

Verify `X-Telegram-Bot-Api-Secret-Token` using constant-time comparison, require configured user/chat IDs, parse `nfx:<token>:<action>`, hash token, resolve through `resolveByCallbackHash`, then best-effort call Telegram `answerCallbackQuery` and edit the message keyboard/status. A failed UI acknowledgement must not roll back an already-durable terminal result.

- [ ] **Step 4: Run GREEN**

Run: `npm test -- telegram-webhook.test.ts router.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

`git commit -am "feat: accept verified Telegram approval callbacks"`

---

### Task 4: Browser Refine confirmation through Telegram

**Files:**
- Modify: `worker/src/callbacks.ts`
- Modify: `worker/test/callbacks.test.ts`

**Interfaces:**
- Existing `/r/<token>` and `/r/<token>/refine` behavior stays unchanged.
- Terminal confirmation uses Telegram instead of ntfy in remote mode.

- [ ] **Step 1: Write failing tests** proving Refine still returns exact text, first-response-wins remains intact, and the confirmation function is Telegram-backed/best-effort.

- [ ] **Step 2: Run RED**

Run: `npm test -- callbacks.test.ts`
Expected: Telegram confirmation assertion fails against ntfy confirmation.

- [ ] **Step 3: Implement minimum confirmation swap** without changing form parsing, CSP, callback hashing, decision validation, or result pages.

- [ ] **Step 4: Run GREEN**

Run: `npm test -- callbacks.test.ts telegram.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

`git commit -am "feat: confirm remote responses through Telegram"`

---

### Task 5: Setup, docs, CI, and full qualification

**Files:**
- Modify: `worker/README.md`
- Modify: `docs/remote-mcp.md`
- Modify: `README.md`
- Modify: `SECURITY.md`
- Modify: `worker/wrangler.jsonc` only if non-secret binding comments/config need updating.
- Modify/add tests only if qualification exposes a regression.

**Interfaces:**
- Document secrets `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_USER_ID`, `TELEGRAM_WEBHOOK_SECRET`.
- Document `setWebhook` with `secret_token` and `allowed_updates=["callback_query"]`.

- [ ] **Step 1: Update docs** with BotFather creation, `/start`, ID discovery, Worker secret commands, webhook registration, free-only guarantee, and credential rotation.

- [ ] **Step 2: Run full deterministic verification**

Run: `npm run check`
Expected: TypeScript PASS, all Worker tests PASS, Wrangler dry-run PASS.

From repo root run existing package gates: `npm run check && npm test && npm pack --dry-run`.

- [ ] **Step 3: Official MCP Inspector smoke** against local/remote endpoint; expect exactly seven tools and unauthenticated `/mcp` rejection.

- [ ] **Step 4: Deploy using existing Cloudflare OAuth** and set Telegram secrets without committing values.

- [ ] **Step 5: Register Telegram webhook** and verify `getWebhookInfo` reports the Worker URL with no delivery error.

- [ ] **Step 6: Live phone qualification**

Verify in order: one-way notify, Allow terminal result, Deny terminal result, browser Refine exact text, and a ChatGPT custom NoFax app approval loop that waits until terminal.

- [ ] **Step 7: Release hygiene**

Remove internal spec/plan if the public repo policy prefers only product docs, update PR #3 with exact evidence, rerun final CI, and do not merge until the live phone tests are green.

- [ ] **Step 8: Commit**

`git commit -am "docs: document Telegram remote approvals"`
