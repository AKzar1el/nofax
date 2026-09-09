# Nofax Remote MCP Worker Design

## Status

Approved architecture for Nofax v0.3.

## Goal

Add a free-to-run remote Nofax deployment on Cloudflare Workers so remote MCP clients such as ChatGPT can invoke the same human-notification and approval/refinement workflow without requiring Codexify or a machine-local MCP bridge.

Nofax must continue to support the existing local stdio MCP server and CLI. The Cloudflare deployment is an additional transport and hosting profile, not a replacement.

## User experience

The target interaction is:

```text
remote MCP client
      |
      v
Cloudflare Worker /mcp
      |
      v
Nofax request state
      |
      +----> ntfy ----> phone
                      [Allow] [Refine] [Deny]
                         |       |        |
                         |       |        +--> direct POST to Worker
                         |       +-----------> tiny mobile web form
                         +-------------------> direct POST to Worker
      ^
      |
MCP client waits/retries until a terminal response exists
```

`Allow` and `Deny` remain one tap. `Refine` opens a small Nofax-hosted mobile form in Safari; the user types or dictates text and submits it. No Apple Shortcut is required.

## Platform choices

### Remote MCP transport

Use Cloudflare's current stateless MCP path:

- `createMcpHandler()` from `agents/mcp/server`.
- `@modelcontextprotocol/server` v2.
- Streamable HTTP on `/mcp` for remote clients.
- Do not use `McpAgent` for the MCP protocol itself; Cloudflare documents it as the legacy/deprecated stateful MCP path for new servers.

The MCP protocol handler is stateless. Application state is stored separately in a Durable Object.

### Request state

Use one SQLite-backed Durable Object namespace per Nofax Worker deployment. v0.3 is single-owner/single-deployment by design. The object serializes request creation/resolution and enforces first-terminal-response-wins.

The Durable Object stores only the state necessary to recover pending interactions:

```text
request_id
kind
status
allowed_json
decision nullable
text nullable
callback_token_hash
created_at
resolved_at nullable
expires_at
```

Raw callback tokens are never stored. The Worker hashes the presented callback token with SHA-256 and looks up the matching row.

### ntfy

The remote Worker publishes phone notifications directly to the configured ntfy server.

Required deployment secrets/config:

- `NTFY_TOPIC` - existing private phone topic.
- `NTFY_SERVER` - optional, default `https://ntfy.sh`.
- `NOFAX_REMOTE_KEY` - high-entropy secret protecting the private MCP deployment.

No OpenAI, Anthropic, model, SMS, WhatsApp, Viber, or other paid API is introduced.

## Authentication boundary

v0.3 is a private single-user deployment, not a hosted public Nofax SaaS.

The Worker must reject unauthenticated MCP access. It supports two equivalent private connection forms:

1. `Authorization: Bearer <NOFAX_REMOTE_KEY>` on `/mcp` for MCP clients that support custom headers.
2. `/mcp/<NOFAX_REMOTE_KEY>` as an opt-in capability URL for clients that accept a remote endpoint but cannot attach a static bearer header.

The key is generated outside the repository and configured as a Worker secret. It is never returned by MCP tools, written to logs, embedded in ntfy callbacks, or committed.

The capability-URL form is intended for private/dev deployments. OAuth 2.1 is a post-v0.3 hardening path for multi-user/public distribution; it is not required to prove the current product loop.

## Callback security

Every interactive request gets:

- a random request ID;
- a fresh 256-bit callback token;
- an expiry timestamp;
- an allowlist of terminal decisions.

Phone action URLs contain only the per-request callback token, never `NOFAX_REMOTE_KEY`.

Endpoints:

```text
POST /r/<callback-token>/allow
POST /r/<callback-token>/deny
GET  /r/<callback-token>
POST /r/<callback-token>/refine
```

Rules:

- expired tokens fail closed;
- unknown tokens return not found;
- a resolved request cannot change decision;
- `refine` requires non-empty bounded text;
- callback responses must send `Cache-Control: no-store`;
- form HTML must escape all user-controlled content and use a strict CSP;
- no arbitrary URL supplied by an MCP caller is ever fetched by the Worker.

## Refine page

`GET /r/<token>` renders one small mobile-first HTML page with no external JavaScript, analytics, fonts, or third-party assets.

The page contains:

- request title/summary, already bounded and escaped;
- a `<textarea>`;
- a submit button;
- optional Cancel/close copy.

The form posts to `/r/<token>/refine`. On success, render a simple `Refinement sent` confirmation page.

This keeps the Refine flow usable on iPhone without Apple Shortcuts and keeps the callback token within the Worker + ntfy/browser path.

## Remote MCP tools

Expose the same public tool names as local v0.2 where behavior is portable:

- `nofax_notify`
- `nofax_request_approval`
- `nofax_request_choice`
- `nofax_request_refinement`
- `nofax_wait_for_response`
- `nofax_get_request`
- `nofax_list_pending`

The remote tool contract must remain semantically compatible with local Nofax so agent prompts do not need separate logic.

### Wait contract

A request tool persists state and returns:

```json
{
  "status": "pending",
  "requestId": "nfx_...",
  "mustWait": true,
  "instruction": "..."
}
```

`nofax_wait_for_response` performs a bounded long poll of at most 20 seconds. It checks durable state, waits with `scheduler.wait()`, and checks again. If still pending it returns another explicit mandatory wait instruction.

The MCP client/model must repeat `nofax_wait_for_response` until a terminal response is observed. There is no portable assumption that a remote MCP server can unsolicitedly wake and rerun an arbitrary model after a phone callback.

Terminal behavior:

- `allow`: caller may continue only within its existing authority;
- `deny`: guarded action must not execute;
- `refine`: caller applies the supplied text and requests a fresh approval if the resulting action still requires approval;
- explicit choice: caller uses exactly the selected choice.

No timeout, transport failure, missing request, or malformed callback becomes approval.

## Local/remote compatibility

Existing local files under `src/` remain the source for CLI and stdio MCP behavior.

Cloudflare-specific code lives under `worker/` with its own package and tests so Cloudflare dependencies do not inflate or destabilize the published local CLI package.

Repository shape:

```text
nofax/
  src/                       # existing Node CLI + stdio MCP
  test/                      # existing local tests
  worker/
    package.json
    package-lock.json
    wrangler.jsonc
    tsconfig.json
    src/
      index.ts               # HTTP router + MCP handler
      mcp.ts                 # remote MCP tool registration
      request-store.ts       # Durable Object class / state operations
      ntfy.ts                # outbound ntfy publisher + action construction
      mobile.ts              # Refine HTML + callback responses
      auth.ts                # bearer/capability-path validation
      protocol.ts            # Worker-safe IDs, validation, redaction/bounds
    test/
      auth.test.ts
      request-store.test.ts
      callbacks.test.ts
      mcp-tools.test.ts
      mobile.test.ts
```

Duplication between Node and Worker code is acceptable only where runtime APIs differ. Tool names, decision vocabulary, bounds, and wait instructions must stay intentionally aligned and be asserted in tests.

## Free-tier constraints

The implementation must fit Cloudflare Workers Free for normal personal use:

- Worker request volume far below 100,000/day;
- SQLite-backed Durable Objects only;
- bounded request rows with cleanup/expiry;
- no long-running model inference;
- no paid Cloudflare product required for the basic deployment.

Pending requests expire after 24 hours by default. Resolved requests may be retained for a short bounded recovery window and then deleted by lazy cleanup on subsequent state operations. v0.3 must not accumulate unbounded Durable Object storage.

## Deployment

`worker/README.md` documents:

1. `npm ci`
2. `npx wrangler login` if not already authenticated
3. set `NTFY_TOPIC` with `wrangler secret put`
4. set `NOFAX_REMOTE_KEY` with `wrangler secret put`
5. optional `NTFY_SERVER` variable
6. `npm test`
7. `npm run deploy`
8. connect an MCP inspector to the deployed URL
9. connect ChatGPT/custom MCP clients using `/mcp/<key>` only for the private capability-URL mode, or bearer auth where supported

The repository must never contain a real topic, remote key, Worker token, or Cloudflare account credential.

## Test strategy

TDD is required.

Minimum automated coverage:

- auth rejects missing/wrong remote key and accepts the two intended auth forms;
- request IDs and callback tokens have sufficient entropy and stable validation;
- Durable Object first-terminal-response-wins;
- expired callbacks fail closed;
- allow/deny callbacks resolve exactly once;
- Refine page escapes content and includes no external resources;
- Refine POST validates and bounds text;
- ntfy payload exposes only per-request callback URLs;
- remote MCP tool names match local MCP tool names;
- remote pending/terminal wait contract matches local semantics;
- remote server builds under Wrangler/Workers types;
- root CI runs both local Nofax and Worker test/build gates.

## Release and rollout

v0.3 is complete only when:

1. local v0.2 tests still pass unchanged;
2. Worker tests/typecheck/build pass;
3. remote MCP is exercised with MCP Inspector locally;
4. a deployed Worker sends a real ntfy notification to the existing phone topic;
5. phone Allow and Deny are observed as terminal remote MCP results;
6. mobile Refine form returns free text as a terminal remote MCP result;
7. the deployed endpoint can be scanned by a compatible remote MCP client;
8. documentation clearly distinguishes local stdio, remote Cloudflare, private capability URL, and future OAuth hardening.

Do not merge based only on mocked tests if live Cloudflare deployment is available. If deployment credentials are not available, stop at a verified deployable branch and report the exact live-validation gap.

## Explicit non-goals

- No Privatizmo integration in v0.3.
- No Codexify requirement for remote MCP.
- No Apple Shortcut requirement.
- No public multi-tenant Nofax service.
- No billing/account system.
- No AI model inference in the Worker.
- No arbitrary remote shell or generic HTTP proxy.
- No persistent `always approve` capability.
- No claim that the server can universally wake/rerun every MCP host after a phone response.
