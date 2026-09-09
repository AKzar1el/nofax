# Nofax Remote MCP Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a free Cloudflare Workers remote MCP deployment with durable phone approvals, one-tap Allow/Deny, browser-based Refine, and semantic parity with Nofax's existing local stdio MCP server.

**Architecture:** Keep the existing Node CLI/stdio implementation under `src/` untouched as the local transport. Add an isolated `worker/` package that uses Cloudflare's stateless `createMcpHandler()` for Streamable HTTP and a SQLite-backed Durable Object for Nofax request state. The Worker publishes ntfy notifications, accepts per-request callback tokens, renders the Refine form, and exposes the same seven MCP tool names as local Nofax.

**Tech Stack:** TypeScript 6, Cloudflare Workers, `agents` 0.22.x, `@modelcontextprotocol/server` 2.0.0, Zod 4.x, Wrangler 4.x, Vitest 4.1+, `@cloudflare/vitest-plugin`, SQLite-backed Durable Objects.

**Spec:** `docs/superpowers/specs/2026-09-09-nofax-remote-mcp-worker-design.md`

## Global Constraints

- Keep local CLI and local stdio MCP behavior working; v0.3 adds a remote transport rather than replacing v0.2.
- New remote MCP uses stateless Streamable HTTP through `createMcpHandler()`; do not use `McpAgent` for the MCP protocol.
- Application state uses a SQLite-backed Durable Object and must fit Workers Free.
- No paid AI/model/notification API, hosted Nofax backend, SMS/WhatsApp/Viber dependency, or inbound connection to the user's PC.
- `Allow`/`Deny` are one-tap phone actions; `Refine` uses a Worker-hosted HTML form and no Apple Shortcut.
- Missing/expired/malformed state and transport failures never become approval.
- The remote MCP endpoint must be private through `NOFAX_REMOTE_KEY`; the key never appears in tool output, ntfy callback URLs, logs, or repository files.
- Per-request callback tokens are random, single-use, expire after 24 hours, and are stored only as SHA-256 hashes.
- Root CI must run both the existing local gates and the Worker gates.

---

### Task 1: Scaffold the isolated Worker package and lock the Cloudflare runtime contract

**Files:**
- Create: `worker/package.json`
- Create: `worker/package-lock.json`
- Create: `worker/tsconfig.json`
- Create: `worker/wrangler.jsonc`
- Create: `worker/vitest.config.ts`
- Create: `worker/test/env.d.ts`
- Create: `worker/src/env.ts`
- Create: `worker/src/protocol.ts`
- Create: `worker/test/protocol.test.ts`
- Modify: `.gitignore`

**Interfaces:**
- Produces `Env` with `REQUESTS`, `NTFY_TOPIC`, optional `NTFY_SERVER`, and `NOFAX_REMOTE_KEY`.
- Produces `createRequestId(): string`, `createCallbackToken(): string`, `hashCallbackToken(token): Promise<string>`, `boundText(value,max,name): string`, and `escapeHtml(value): string`.
- Produces Wrangler Durable Object binding `REQUESTS` for class `NofaxRequestStore` using `new_sqlite_classes` migration.

- [ ] **Step 1: Write failing protocol tests**

Create `worker/test/protocol.test.ts` asserting request IDs start with `nfx_`, callback tokens contain at least 32 random bytes encoded URL-safely, hashes are deterministic 64-char lowercase hex, `boundText` rejects empty values and truncates, and `escapeHtml` escapes `&<>"'`.

```ts
import { describe, expect, it } from "vitest";
import { boundText, createCallbackToken, createRequestId, escapeHtml, hashCallbackToken } from "../src/protocol";

describe("worker protocol", () => {
  it("creates high-entropy URL-safe identifiers", () => {
    expect(createRequestId()).toMatch(/^nfx_[A-Za-z0-9_-]{24,}$/);
    expect(createCallbackToken()).toMatch(/^[A-Za-z0-9_-]{43,}$/);
  });

  it("hashes callback tokens without retaining the raw token", async () => {
    const digest = await hashCallbackToken("abc");
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(digest).toBe(await hashCallbackToken("abc"));
  });

  it("escapes HTML", () => {
    expect(escapeHtml(`<script>alert("x")</script>&'`)).not.toContain("<script>");
  });
});
```

- [ ] **Step 2: Run the Worker test and verify RED**

Run from `worker/`:

```bash
npm test -- protocol.test.ts
```

Expected: FAIL because `src/protocol.ts` does not exist.

- [ ] **Step 3: Add package/runtime configuration**

Use an isolated package with scripts:

```json
{
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "check": "npm run typecheck && npm test && wrangler deploy --dry-run"
  },
  "dependencies": {
    "@modelcontextprotocol/server": "2.0.0",
    "agents": "0.22.0",
    "zod": "^4.5.4"
  },
  "devDependencies": {
    "@cloudflare/vitest-plugin": "^1.0.0",
    "@cloudflare/workers-types": "^5.20260909.0",
    "typescript": "^6.0.3",
    "vitest": "^4.1.0",
    "wrangler": "^4.115.0"
  }
}
```

If the exact `@cloudflare/workers-types` build is unavailable when installing, select the latest published build on or before the current compatibility date and commit the resulting lockfile; do not loosen the runtime packages to `latest` or `*`.

Use compatibility date `2026-09-09` and this Durable Object binding/migration in `wrangler.jsonc`:

```jsonc
{
  "name": "nofax-remote",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-09",
  "durable_objects": {
    "bindings": [
      { "name": "REQUESTS", "class_name": "NofaxRequestStore" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["NofaxRequestStore"] }
  ],
  "vars": {
    "NTFY_SERVER": "https://ntfy.sh"
  }
}
```

- [ ] **Step 4: Implement `src/protocol.ts` minimally**

Use Web Crypto only:

```ts
export function createRequestId(): string {
  return `nfx_${randomBase64Url(18)}`;
}

export function createCallbackToken(): string {
  return randomBase64Url(32);
}

export async function hashCallbackToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
```

- [ ] **Step 5: Run focused tests and package checks**

```bash
npm ci
npm test -- protocol.test.ts
npm run typecheck
npx wrangler deploy --dry-run
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add worker .gitignore
git commit -m "feat: scaffold Cloudflare remote runtime"
```

---

### Task 2: Implement the SQLite Durable Object request state machine

**Files:**
- Create: `worker/src/request-store.ts`
- Create: `worker/test/request-store.test.ts`
- Modify: `worker/src/env.ts`

**Interfaces:**
- Produces RPC methods on `NofaxRequestStore`: `createRequest(input)`, `getRequest(requestId)`, `resolveByCallbackHash(input)`, `listPending(limit)`, `cleanup(nowMs)`.
- `resolveByCallbackHash` returns the existing terminal row if already resolved and never changes a terminal decision.

- [ ] **Step 1: Write failing Durable Object tests**

Use `@cloudflare/vitest-plugin` and direct `env.REQUESTS.getByName("default")` access. Cover creation, recovery after a second call, first-terminal-response-wins, expired callback rejection, refinement text bound to 2,000 chars, and safe pending listing.

Core assertion:

```ts
const store = env.REQUESTS.getByName("default");
await store.createRequest(request);
const first = await store.resolveByCallbackHash({ callbackHash, decision: "allow", nowMs: 1000 });
const second = await store.resolveByCallbackHash({ callbackHash, decision: "deny", nowMs: 1001 });
expect(first.decision).toBe("allow");
expect(second.decision).toBe("allow");
```

- [ ] **Step 2: Run focused test and verify RED**

```bash
npm test -- request-store.test.ts
```

Expected: FAIL because `NofaxRequestStore` is not implemented/exported.

- [ ] **Step 3: Implement SQLite schema initialization**

Inside the Durable Object constructor, create one table and indexes using `ctx.storage.sql.exec`:

```sql
CREATE TABLE IF NOT EXISTS requests (
  request_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  allowed_json TEXT NOT NULL,
  callback_hash TEXT NOT NULL UNIQUE,
  decision TEXT,
  text TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS requests_pending_idx ON requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS requests_expiry_idx ON requests(expires_at);
```

- [ ] **Step 4: Implement atomic first-terminal-response-wins**

Validate decision against `allowed_json`, reject expired requests, then issue an update guarded by `status = 'pending'`.

```sql
UPDATE requests
SET status = 'resolved', decision = ?, text = ?, resolved_at = ?
WHERE callback_hash = ? AND status = 'pending' AND expires_at >= ?;
```

Re-read the row after the update and return its canonical terminal state.

- [ ] **Step 5: Implement lazy cleanup**

Delete pending rows older than expiry and resolved rows after a bounded 7-day recovery window whenever create/list operations run.

- [ ] **Step 6: Run focused tests**

```bash
npm test -- request-store.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add worker/src/request-store.ts worker/test/request-store.test.ts worker/src/env.ts
git commit -m "feat: add durable remote request store"
```

---

### Task 3: Add ntfy publishing, one-tap callbacks, and the browser Refine page

**Files:**
- Create: `worker/src/ntfy.ts`
- Create: `worker/src/mobile.ts`
- Create: `worker/src/callbacks.ts`
- Create: `worker/test/ntfy.test.ts`
- Create: `worker/test/callbacks.test.ts`
- Create: `worker/test/mobile.test.ts`

**Interfaces:**
- `publishInteractiveNotification({ env, requestId, callbackToken, title, message, options, includeRefine, origin })`.
- `handleCallback(request, env): Promise<Response>` handles `/r/<token>` routes.
- `renderRefineForm(input): Response` and `renderResultPage(title,message): Response`.

- [ ] **Step 1: Write failing ntfy/action tests**

Assert `Allow` and `Deny` actions POST to Worker URLs, `Refine` uses a view action to `GET /r/<token>`, no action contains `NOFAX_REMOTE_KEY`, and the ntfy topic is supplied only in the outbound publish body.

Expected action sequence when refinement is enabled:

```text
Allow -> POST /r/<token>/allow
Refine -> VIEW /r/<token>
Deny -> POST /r/<token>/deny
```

- [ ] **Step 2: Write failing mobile/callback tests**

Cover:

- HTML escapes title/message;
- response headers contain `Content-Security-Policy`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer`;
- no external scripts/styles/fonts exist;
- `POST /refine` rejects empty or >2,000-char input after bounding rules;
- resolved/expired/unknown callback tokens fail closed;
- Allow/Deny/refine call the Durable Object with only the token hash.

- [ ] **Step 3: Run focused tests and verify RED**

```bash
npm test -- ntfy.test.ts callbacks.test.ts mobile.test.ts
```

Expected: FAIL because modules do not exist.

- [ ] **Step 4: Implement ntfy publisher**

Publish JSON to `${NTFY_SERVER}/` with `topic`, bounded title/message, and action objects. Use the request's Worker origin to construct callback URLs. Treat non-2xx responses as delivery failures.

- [ ] **Step 5: Implement the no-JS Refine form**

Render server-side HTML with:

```html
<form method="post" action="/r/<escaped-token>/refine">
  <label for="text">What should I change?</label>
  <textarea id="text" name="text" maxlength="2000" required autofocus></textarea>
  <button type="submit">Send refinement</button>
</form>
```

Use inline CSS only, mobile viewport metadata, and no external resources.

- [ ] **Step 6: Implement callback routing and terminal confirmation**

Hash callback token, resolve through the Durable Object, and publish a low-priority `Approved`, `Denied`, `Refinement received`, or `Choice received` ntfy confirmation after successful first resolution. Confirmation failure never changes the already stored decision.

- [ ] **Step 7: Run focused tests**

```bash
npm test -- ntfy.test.ts callbacks.test.ts mobile.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add worker/src/ntfy.ts worker/src/mobile.ts worker/src/callbacks.ts worker/test
git commit -m "feat: add remote phone callback flow"
```

---

### Task 4: Implement remote MCP tools with local semantic parity

**Files:**
- Create: `worker/src/mcp-tools.ts`
- Create: `worker/src/mcp.ts`
- Create: `worker/test/mcp-tools.test.ts`
- Create: `worker/test/mcp-server.test.ts`
- Modify: `worker/src/env.ts`

**Interfaces:**
- `createRemoteToolHandlers(env, origin)` returns `notify`, `requestApproval`, `requestChoice`, `requestRefinement`, `waitForResponse`, `getRequest`, `listPending`.
- `createRemoteMcpHandler(env, origin)` creates/handles the stateless MCP server.
- Remote tool names exactly match local `MCP_TOOL_NAMES`.

- [ ] **Step 1: Write failing semantic-parity tests**

Load the local list from `../../src/mcp-server.mjs` in a Node-side parity helper or duplicate the expected frozen list in the Worker test and add a root test comparing both. Assert the remote tool set is exactly:

```ts
[
  "nofax_notify",
  "nofax_request_approval",
  "nofax_request_choice",
  "nofax_request_refinement",
  "nofax_wait_for_response",
  "nofax_get_request",
  "nofax_list_pending"
]
```

- [ ] **Step 2: Write failing wait-contract tests**

Create a pending request, call `waitForResponse({ requestId, waitSeconds: 1 })`, and assert pending returns `mustWait: true` plus a mandatory repeat instruction. Resolve the request and assert terminal allow/deny/refine semantics match local v0.2 wording.

- [ ] **Step 3: Run focused tests and verify RED**

```bash
npm test -- mcp-tools.test.ts mcp-server.test.ts
```

- [ ] **Step 4: Implement request handlers**

On request creation:

1. validate/bound title, message, options;
2. generate request ID and callback token;
3. hash callback token;
4. persist request in Durable Object with 24-hour expiry;
5. publish ntfy notification using raw callback token;
6. discard raw token;
7. return only safe pending data.

If publish fails, the handler must not leave an actionable orphaned pending request; mark/delete the just-created request before returning the tool error.

- [ ] **Step 5: Implement bounded remote wait**

Allow `waitSeconds` from 1 to 20. Loop:

```ts
const deadline = Date.now() + waitSeconds * 1000;
do {
  const current = await store.getRequest(requestId);
  if (current.status === "resolved") return terminalResult(current);
  if (Date.now() >= deadline) break;
  await scheduler.wait(Math.min(1000, deadline - Date.now()));
} while (true);
return pendingResult(requestId);
```

- [ ] **Step 6: Register tools on `McpServer` and wrap with `createMcpHandler()`**

Use the same titles/descriptions/wait instructions as local v0.2 except the remote wait maximum is 20 seconds.

- [ ] **Step 7: Run focused and full Worker tests**

```bash
npm test
npm run typecheck
npx wrangler deploy --dry-run
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add worker/src/mcp-tools.ts worker/src/mcp.ts worker/test/mcp-tools.test.ts worker/test/mcp-server.test.ts
git commit -m "feat: expose remote Nofax MCP tools"
```

---

### Task 5: Add HTTP routing and private MCP authentication

**Files:**
- Create: `worker/src/auth.ts`
- Create: `worker/src/index.ts`
- Create: `worker/test/auth.test.ts`
- Create: `worker/test/router.test.ts`

**Interfaces:**
- `authorizeMcpRequest(request, env): { authorized: boolean; normalizedRequest: Request }`.
- Worker routes `/mcp`, `/mcp/<key>`, `/r/<token>`, `/r/<token>/<action>`, and `/healthz`.

- [ ] **Step 1: Write failing authentication tests**

Cover:

```text
/mcp + missing Authorization          -> 401
/mcp + wrong Bearer                   -> 401
/mcp + correct Bearer                 -> authorized
/mcp/<wrong-key>                      -> 404 or 401
/mcp/<correct-key>                    -> authorized and internally normalized to /mcp
/r/<token>                            -> never requires NOFAX_REMOTE_KEY
```

Use constant-time byte comparison after checking equal byte lengths.

- [ ] **Step 2: Write failing router tests**

Assert `/healthz` returns only `{ "status": "ok" }`, no secrets; unknown routes return 404; callback routes bypass MCP auth but still require valid per-request token.

- [ ] **Step 3: Run focused tests and verify RED**

```bash
npm test -- auth.test.ts router.test.ts
```

- [ ] **Step 4: Implement auth and routing**

Do not log request URLs because capability-path mode contains the remote key. Normalize `/mcp/<key>` into a cloned request whose pathname is `/mcp` before passing to `createMcpHandler()`.

- [ ] **Step 5: Run full Worker gate**

```bash
npm run check
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add worker/src/auth.ts worker/src/index.ts worker/test/auth.test.ts worker/test/router.test.ts
git commit -m "feat: secure remote MCP transport"
```

---

### Task 6: Integrate root CI and public documentation

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`
- Modify: `SECURITY.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/architecture.md`
- Create: `worker/README.md`
- Create: `docs/remote-mcp.md`

**Interfaces:**
- Root CI has a separate Worker job that runs from `worker/`.
- Documentation exposes no real topic/key/account identifiers.

- [ ] **Step 1: Update CI**

Keep the existing Node 20/22/24 local matrix. Add one Worker job on Node 22:

```yaml
worker:
  runs-on: ubuntu-latest
  defaults:
    run:
      working-directory: worker
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with:
        node-version: 22
        cache: npm
        cache-dependency-path: worker/package-lock.json
    - run: npm ci
    - run: npm run check
```

- [ ] **Step 2: Document private deployment**

`worker/README.md` must contain exact commands:

```bash
npm ci
npx wrangler login
npx wrangler secret put NTFY_TOPIC
npx wrangler secret put NOFAX_REMOTE_KEY
npm test
npm run deploy
```

Explain `NTFY_SERVER` defaults to `https://ntfy.sh` and can be changed in Wrangler vars for self-hosted ntfy.

- [ ] **Step 3: Document MCP connection modes**

Show:

```text
https://<worker>.workers.dev/mcp        + Bearer header
https://<worker>.workers.dev/mcp/<key>  private capability-URL mode
```

State that the capability URL is a bearer secret, suitable for private testing, and OAuth 2.1 remains the hardening path before multi-user/public hosting.

- [ ] **Step 4: Update security docs**

Add remote threat boundaries: Cloudflare/ntfy see transmitted request summaries; remote key and callback token secrecy; Refine text transits Cloudflare; no end-to-end-encryption claim; rotate `NOFAX_REMOTE_KEY` and `NTFY_TOPIC` if exposed.

- [ ] **Step 5: Run both full gates**

From repo root:

```bash
npm ci
npm run check
npm test
npm pack --dry-run
cd worker
npm ci
npm run check
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add .github README.md SECURITY.md CHANGELOG.md docs worker/README.md
git commit -m "docs: ship remote Nofax deployment guide"
```

---

### Task 7: Local MCP Inspector and live Cloudflare qualification

**Files:**
- Modify only if evidence exposes a defect; every defect gets a failing regression test before implementation.
- Record final verified commands/results in PR body rather than committing secrets or transient URLs to the repository.

**Interfaces:**
- Produces live evidence for remote MCP tool discovery and the real phone loop.

- [ ] **Step 1: Run fresh pre-deploy verification**

```bash
npm ci
npm run check
npm test
npm pack --dry-run
cd worker
npm ci
npm run check
```

Expected: PASS.

- [ ] **Step 2: Run Worker locally**

```bash
npm run dev
```

Use `.dev.vars` only for local secrets and ensure it is gitignored:

```text
NTFY_TOPIC=<private-topic>
NOFAX_REMOTE_KEY=<random-32-byte-secret>
```

- [ ] **Step 3: Exercise `/mcp` with MCP Inspector**

```bash
npx @modelcontextprotocol/inspector@latest
```

Connect using bearer auth if Inspector supports configured headers; otherwise use the local `/mcp/<key>` capability URL. Verify all seven tools are discovered.

- [ ] **Step 4: Live-test ntfy callbacks locally where reachable**

If the phone cannot reach localhost, skip callback E2E until deployment; do not add an ad hoc tunnel dependency to the product.

- [ ] **Step 5: Confirm Cloudflare authentication state**

```bash
npx wrangler whoami
```

If not authenticated, run `npx wrangler login`. If interactive account authorization cannot be completed in the current environment, stop and report `NEEDS_USER` with the exact command; do not invent deployment success.

- [ ] **Step 6: Configure production secrets**

```bash
npx wrangler secret put NTFY_TOPIC
npx wrangler secret put NOFAX_REMOTE_KEY
```

Never echo either secret in logs or PR text.

- [ ] **Step 7: Deploy**

```bash
npm run deploy
```

Capture only the non-secret Worker origin.

- [ ] **Step 8: Remote MCP Inspector test**

Connect to the deployed remote MCP endpoint and verify tool discovery + one-way `nofax_notify`.

- [ ] **Step 9: Real phone Allow test**

Invoke `nofax_request_approval`, call `nofax_wait_for_response`, tap **Allow** on the phone, and verify the next wait returns terminal `allow`.

- [ ] **Step 10: Real phone Deny test**

Repeat with **Deny** and verify terminal `deny`.

- [ ] **Step 11: Real phone Refine test**

Invoke approval with refinement enabled or `nofax_request_refinement`, tap **Refine**, enter `Make it shorter and more professional`, submit, and verify terminal result contains exactly that refinement text.

- [ ] **Step 12: Test remote client scan**

If ChatGPT workspace developer-mode/custom-app access is available, create a draft custom app using the private Worker endpoint and run **Scan Tools**. If account/workspace UI blocks this, report the exact account-level limitation; MCP Inspector remains the protocol qualification.

- [ ] **Step 13: Final verification and PR**

Rerun the complete local + Worker gate after the last change. Open a PR only from that verified head. Do not merge until CI is green and live qualification results are recorded.

- [ ] **Step 14: Squash merge and post-merge CI**

Squash merge the exact green PR head, then verify the push-triggered `main` CI run completes successfully before declaring v0.3 complete.
