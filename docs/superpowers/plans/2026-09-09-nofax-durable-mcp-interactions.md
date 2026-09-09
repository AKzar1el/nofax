# Nofax Durable MCP Interactions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Nofax v0.2 with phone decision confirmation, durable human-response waits, free-text refinement, and a provider-neutral stdio MCP server suitable for Codexify.

**Architecture:** Keep ntfy as the transport, add a small local request store under `~/.nofax/requests`, expose provider-neutral tool handlers, and wire those handlers to the stable MCP TypeScript SDK v2. MCP request tools return durable handles immediately; a separate bounded long-poll tool repeats until the human response is terminal.

**Tech Stack:** Node.js >=20, ESM, built-in fs/fetch/crypto, `@modelcontextprotocol/server@2.0.0`, `zod@4.4.3`, ntfy HTTP API, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-09-nofax-durable-mcp-interactions-design.md`

## Global Constraints

- No paid API, hosted Nofax backend, inbound callback server, SMS, WhatsApp, or AI inference dependency.
- Never translate timeout/network failure/pending state into approval.
- Persist the one-time response topic locally but never expose it in MCP tool results.
- Default MCP long-poll window is 240 seconds and may not exceed 240 seconds.
- MCP stdout is protocol-only; diagnostics go to stderr.
- Claude/Codex native permission adapters keep their existing fail-back behavior.
- Use strict TDD for production behavior changes.

---

### Task 1: Response protocol and confirmation

**Files:** `src/protocol.mjs`, `src/ntfy.mjs`, `test/protocol.test.mjs`, `test/ntfy.test.mjs`

- [ ] Add failing tests for structured responses with optional bounded refinement text.
- [ ] Add failing tests proving terminal Allow/Deny sends best-effort phone confirmation while confirmation failure does not change the accepted result.
- [ ] Implement the minimum protocol/transport changes and keep existing CLI/hook behavior compatible.
- [ ] Run focused tests.

### Task 2: Durable request store

**Files:** `src/requests.mjs`, `test/requests.test.mjs`

**Produces:** `savePendingRequest`, `loadRequest`, `resolveRequest`, `listPendingRequests`.

- [ ] Write failing tests for user-only local persistence, recovery after reopening, first-terminal-response-wins, invalid IDs, and bounded pending lists.
- [ ] Implement the request store using atomic temp-file + rename writes.
- [ ] Run focused tests.

### Task 3: Provider-neutral durable interaction handlers

**Files:** `src/mcp-tools.mjs`, `test/mcp-tools.test.mjs`

- [ ] Write failing tests for notify, approval creation, choice creation, refinement creation, bounded wait, repeated pending instruction, terminal allow/deny/refine, and recovery.
- [ ] Implement handlers using injected config/transport/store dependencies.
- [ ] Ensure all pending results contain the explicit mandatory wait instruction and no response topic.
- [ ] Run focused tests.

### Task 4: MCP stdio wrapper

**Files:** `src/mcp-server.mjs`, `src/cli.mjs`, `src/index.mjs`, `package.json`, `package-lock.json`, `test/cli.test.mjs`

- [ ] Add failing CLI test for `nofax mcp` dispatch without ordinary stdout text.
- [ ] Add `@modelcontextprotocol/server@2.0.0` and `zod@4.4.3`.
- [ ] Register `nofax_notify`, `nofax_request_approval`, `nofax_request_choice`, `nofax_request_refinement`, `nofax_wait_for_response`, `nofax_get_request`, and `nofax_list_pending` with server instructions enforcing the wait contract.
- [ ] Serve via `serveStdio(() => buildServer())` for current and legacy-compatible stdio negotiation.
- [ ] Update exports/check script and run focused tests + syntax checks.

### Task 5: Refine Shortcut and public docs

**Files:** `README.md`, `SECURITY.md`, `docs/architecture.md`, `CHANGELOG.md`

- [ ] Document the one-time `Nofax Refine` iOS Shortcut: receive JSON input, ask for text, POST to `callbackUrl`.
- [ ] Document the exact Codexify stdio configuration with `toolTimeoutSec: 270` and explain repeated wait semantics.
- [ ] Document that universal unsolicited model wakeup is not claimed; durable polling is the portable path.
- [ ] Update version/roadmap/security notes.

### Task 6: Release qualification

- [ ] Run full `npm test`.
- [ ] Run `npm run check`.
- [ ] Run `npm pack --dry-run`.
- [ ] Open a PR, verify Node 20/22/24 CI, then squash merge only if green.
- [ ] Verify merged `main` CI before declaring v0.2 ready for phone/Codexify live testing.
