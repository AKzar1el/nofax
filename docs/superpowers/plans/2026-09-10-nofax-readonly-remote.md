# Nofax Read-Only Remote MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Strip the Cloudflare Nofax remote MCP to two deterministic read-only inspection tools while preserving the local Nofax 0.2 implementation.

**Architecture:** Keep the existing authenticated Streamable HTTP MCP shell and Durable Object read path. Remove all remote phone transports, callback routes, mutating tools, and wait semantics. Make list reads non-mutating and verify the final tool surface with CI and MCP Inspector.

**Tech Stack:** TypeScript, Cloudflare Workers, SQLite Durable Objects, MCP TypeScript SDK v2, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-10-nofax-readonly-remote-design.md`

## Global Constraints

- Remote MCP exposes exactly `nofax_get_request` and `nofax_list_pending`.
- Remote Worker performs no user-triggered external side effects.
- Local root-package CLI/stdio Nofax 0.2 remains unchanged.
- No Telegram or remote ntfy dependency/configuration remains.
- Read-only annotations are metadata only; enforcement must come from unreachable mutating code paths.
- Auth remains `NOFAX_REMOTE_KEY` via Bearer header or capability path.
- PR #3 stays unmerged until final deployed tool scan is verified.

---

### Task 1: Lock the two-tool MCP contract

**Files:**
- Modify: `worker/test/mcp-server.test.ts`
- Modify: `worker/src/mcp.ts`

**Interfaces:**
- Produces `REMOTE_MCP_TOOL_NAMES = ["nofax_get_request", "nofax_list_pending"]`.
- Both tools use existing read handlers from `createRemoteToolHandlers`.

- [ ] **Step 1: Write failing tests**

Change the expected tool-name array to exactly:

```ts
const EXPECTED = ["nofax_get_request", "nofax_list_pending"] as const;
```

Add an assertion over registered tool metadata if the SDK test surface exposes it; otherwise keep the annotations explicit in production and cover behavior through Inspector later.

- [ ] **Step 2: Run RED**

Run: `npm test -- mcp-server.test.ts`
Expected: FAIL because seven tools are still registered.

- [ ] **Step 3: Implement minimum two-tool server**

Delete registrations for notify, approval, choice, refinement, and wait. Replace server instructions with read-only inspection wording. Keep only the two read tool registrations with:

```ts
annotations: {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
}
```

- [ ] **Step 4: Run GREEN**

Run: `npm test -- mcp-server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

`git commit -am "feat: restrict remote MCP to read-only tools"`

---

### Task 2: Make read handlers physically non-mutating

**Files:**
- Modify: `worker/src/mcp-tools.ts`
- Modify: `worker/src/request-store.ts`
- Modify: `worker/test/mcp-tools.test.ts`
- Modify: `worker/test/request-store.test.ts`

**Interfaces:**
- `createRemoteToolHandlers(env, overrides?)` exposes only `getRequest` and `listPending`.
- `listPending(limit, nowMs)` performs a SELECT only and filters expired requests without cleanup writes.

- [ ] **Step 1: Write failing tests**

Update handler tests so the only callable methods are `getRequest` and `listPending`. Add a request-store regression proving `listPending` does not delete an expired row: insert an expired fixture using test setup, call `listPending`, assert it is omitted from results, then verify the fixture still exists through direct store lookup/test harness.

- [ ] **Step 2: Run RED**

Run: `npm test -- mcp-tools.test.ts request-store.test.ts`
Expected: FAIL because current handlers expose mutators/wait and `listPending` invokes cleanup.

- [ ] **Step 3: Implement minimum read-only handlers**

Remove notification/protocol-generation imports and all request creation/wait logic from `mcp-tools.ts`. Keep only safe public serialization, limit validation, `getRequest`, and `listPending`.

In `request-store.ts`, remove `this.cleanup(now)` from `listPending`; keep SQL predicate `status = 'pending' AND expires_at >= ?`.

- [ ] **Step 4: Run GREEN**

Run: `npm test -- mcp-tools.test.ts request-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

`git commit -am "refactor: make remote inspection path read only"`

---

### Task 3: Remove remote side-effect routes and transport code

**Files:**
- Modify: `worker/src/index.ts`
- Modify: `worker/src/env.ts`
- Modify: `worker/test/router.test.ts`
- Delete: `worker/src/telegram.ts`
- Delete: `worker/src/telegram-webhook.ts`
- Delete: `worker/src/ntfy.ts`
- Delete: `worker/src/callbacks.ts`
- Delete: `worker/src/mobile.ts`
- Delete transport/callback-specific Worker tests.

**Interfaces:**
- Public routes: `/healthz`, `/mcp`, `/mcp/<key>` only.
- `Env` contains only `REQUESTS` and `NOFAX_REMOTE_KEY`.

- [ ] **Step 1: Write failing router tests**

Assert:

```ts
expect((await routeRequest(new Request("https://nofax.example/telegram/webhook", { method: "POST" }), env(), ctx)).status).toBe(404);
expect((await routeRequest(new Request("https://nofax.example/r/token"), env(), ctx)).status).toBe(404);
```

- [ ] **Step 2: Run RED**

Run: `npm test -- router.test.ts`
Expected: FAIL because callback routes are still registered.

- [ ] **Step 3: Remove routes and dead transport modules**

Delete Telegram/callback imports and override types from `index.ts`. Reduce `Env`. Delete transport modules and their tests after confirming no remaining imports.

- [ ] **Step 4: Run GREEN + typecheck**

Run: `npm test -- router.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

`git commit -am "refactor: remove remote side-effect transports"`

---

### Task 4: Production docs and configuration cleanup

**Files:**
- Modify: `worker/README.md`
- Modify: `docs/remote-mcp.md`
- Modify: `README.md`
- Modify: `SECURITY.md`
- Modify: `CHANGELOG.md`
- Verify: `worker/wrangler.jsonc`

**Interfaces:**
- Docs call remote v0.3 a read-only inspection MCP.
- Deployment requires only `NOFAX_REMOTE_KEY` plus Wrangler/Cloudflare auth.

- [ ] **Step 1: Rewrite remote docs**

Remove Telegram/ntfy setup, phone callback flow, approval/refinement claims, webhook secrets, and free-transport discussion. Document exactly two tools and explain that there is no remote write/notification surface.

- [ ] **Step 2: Update security/changelog**

Document hard read-only enforcement and capability-key handling. Keep local 0.2 behavior clearly separate.

- [ ] **Step 3: Verify Wrangler config**

Ensure only the Durable Object binding remains and there are no phone-provider vars.

- [ ] **Step 4: Commit**

`git commit -am "docs: productionize read-only remote MCP"`

---

### Task 5: Final qualification and PR cleanup

**Files:**
- Remove this spec/plan from public branch if repository policy prefers product-only docs.
- Update PR #3 description.

**Interfaces:**
- Final deployed tool count is exactly two.

- [ ] **Step 1: Run Worker verification**

From `worker/`:

```bash
npm run check
npm audit --omit=dev
```

Expected: tests/typecheck/Wrangler dry-run PASS; production audit has no findings.

- [ ] **Step 2: Run root package verification**

```bash
npm run check
npm test
npm pack --dry-run
```

Expected: PASS; local package remains unchanged.

- [ ] **Step 3: Deploy exact branch head**

Use existing Cloudflare OAuth and preserve/rotate `NOFAX_REMOTE_KEY` as needed. Do not configure Telegram or ntfy secrets.

- [ ] **Step 4: MCP Inspector smoke**

Verify authenticated remote MCP returns exactly:

```text
nofax_get_request
nofax_list_pending
```

Verify unauthenticated `/mcp` is rejected and `/telegram/webhook` plus `/r/...` return 404.

- [ ] **Step 5: Refresh ChatGPT custom app**

Refresh the app tool scan and verify only two read-only actions appear.

- [ ] **Step 6: Update PR #3 and final CI**

Record exact head SHA/evidence. Keep draft until deployed scan passes; then mark ready for review/merge only after verification-before-completion.
