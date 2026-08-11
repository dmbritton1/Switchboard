# Codex Interactive Requests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give app-server Codex sessions Claude-like approvals, `needs-you`, Auto behavior, sequential structured questions, and stable MCP elicitation.

**Architecture:** Normalize every user-blocking server request into a provider-neutral FIFO interaction queue. Keep upstream app-server requests atomic, expose only the queue head through Registry state, and make `serverRequest/resolved` the authoritative state transition.

**Tech Stack:** Node.js 22.18+, TypeScript, Codex app-server 0.147.0 protocol, browser JavaScript, HTTP/SSE, node:test.

## Global Constraints

- Complete `2026-08-11-codex-app-server-foundation.md` first.
- Execute in an isolated worktree created with `superpowers:using-git-worktrees`.
- Keep Codex sandbox fixed to `workspaceWrite`.
- Expose only Allow once, Deny, and the existing Auto toggle in the first release.
- Auto responds `accept` per request; never send `acceptForSession` from Auto.
- `tool/requestUserInput` is the only experimental server request accepted.
- Never persist raw question answers or MCP elicitation values.
- Keep `npm test` offline and run it before completion.

---

## File structure

- Create `src/agents/interactions.ts`: interaction queue and response types shared by adapters.
- Create `test/interactions.test.ts`: FIFO, stale response, Auto, and drain behavior.
- Modify `src/types.ts`, `src/sessions.ts`, `src/agents/claude.ts`, `src/agents/codex-app-server.ts`, `src/agents/codex-app-server-supervisor.ts`, `src/server.ts`.
- Modify `web/lib.js`, `web/app.js`, `web/style.css` and their tests.

### Task 1: Define provider-neutral interaction state

**Files:**
- Create: `src/agents/interactions.ts`
- Create: `test/interactions.test.ts`
- Modify: `src/types.ts`
- Modify: `src/sessions.ts`
- Test: `test/sessions.test.ts`

**Interfaces:**
- Produces:

```ts
export type InteractionOption = { label: string; description?: string; isOther?: boolean };
export type InteractionQuestion = {
  id: string;
  header: string;
  prompt: string;
  options: InteractionOption[];
  multiple: boolean;
};
export type PendingInteraction =
  | { kind: 'approval'; id: string; tool: string; summary: string }
  | { kind: 'questions'; id: string; questions: InteractionQuestion[]; expiresAt: number | null }
  | { kind: 'mcp-form'; id: string; title: string; schema: Record<string, unknown> }
  | { kind: 'mcp-url'; id: string; title: string; url: string };
export type InteractionResponse =
  | { id: string; kind: 'approval'; decision: 'allow' | 'deny' }
  | { id: string; kind: 'questions'; answers: Record<string, string[]> }
  | { id: string; kind: 'mcp-form'; action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }
  | { id: string; kind: 'mcp-url'; action: 'accept' | 'decline' | 'cancel' };
```

- [ ] **Step 1: Write Registry interaction tests**

Assert request sets `pending` and `needs-you`, a second request increments
`pendingCount`, resolving the head keeps `needs-you` until the next head is
resolved, stop clears everything, and restored sessions discard actionable
pending requests.

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test test/interactions.test.ts test/sessions.test.ts`

Expected: FAIL on missing interaction types and events.

- [ ] **Step 3: Replace approval-only adapter events**

Add:

```ts
| { type: 'interaction-requested'; interaction: PendingInteraction; pendingCount: number }
| { type: 'interaction-resolved'; id: string; next: PendingInteraction | null; pendingCount: number }
```

Replace `AgentHandle.decide()` with
`respond(response: InteractionResponse): void`. Update Claude and server
callers in the same compile unit so no adapter has a partial interface.

- [ ] **Step 4: Implement Registry transitions**

Store only the visible head and count on `Session`. On load, force
`pending = null` and `pendingCount = 0`; a live connection is required before
an interaction can be actionable. Preserve the current rule that pending state
outranks ordinary `working` events.

- [ ] **Step 5: Run focused tests**

Run: `node --test test/interactions.test.ts test/sessions.test.ts test/agents-claude.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/sessions.ts src/agents/interactions.ts src/agents/claude.ts test/interactions.test.ts test/sessions.test.ts test/agents-claude.test.ts
git commit -m "refactor: generalize pending interactions"
```

### Task 2: Implement Codex approval FIFO and Auto

**Files:**
- Modify: `src/agents/interactions.ts`
- Modify: `src/agents/codex-app-server.ts`
- Modify: `src/agents/codex-app-server-supervisor.ts`
- Modify: `test/interactions.test.ts`
- Modify: `test/agents-codex-app-server.test.ts`
- Modify: `test/helpers/fake-app-server.ts`

**Interfaces:**
- Consumes: `PendingInteraction`, `InteractionResponse`.
- Produces: `InteractionQueue.enqueue()`, `InteractionQueue.respond()`, `InteractionQueue.drain()`.

- [ ] **Step 1: Write pure FIFO tests**

Cover two concurrent requests, head-only response, wrong request ID, duplicate
response, server auto-resolution, and drain-on-stop. Require every upstream
promise to settle exactly once.

- [ ] **Step 2: Write app-server approval tests**

Have the fake emit command and file requests with interleaved lifecycle events.
Assert Allow sends `{ decision: 'accept' }`, Deny sends
`{ decision: 'decline' }`, and `serverRequest/resolved` advances the visible
head.

- [ ] **Step 3: Run tests and verify RED**

Run: `node --test test/interactions.test.ts test/agents-codex-app-server.test.ts`

Expected: FAIL because Codex server requests are not queued.

- [ ] **Step 4: Implement the queue**

Store each live server request as `{ publicInteraction, accept, decline,
cancel }`. Emit only the head. Do not remove it on browser submission; mark it
responding and remove it only after the matching resolution notification.

- [ ] **Step 5: Implement approval mapping**

Normalize command, file, and app-tool approval questions into
`kind: 'approval'`. Never expose policy amendments, session-wide acceptance, or
additional permissions. Decline unsupported permission-expansion requests.

- [ ] **Step 6: Implement Auto behavior**

When the session Auto flag is true, respond `{ decision: 'accept' }` immediately
and do not emit `interaction-requested`. Turning Auto off affects the next
request because no `acceptForSession` decision was sent.

- [ ] **Step 7: Run focused tests**

Run: `node --test test/interactions.test.ts test/agents-codex-app-server.test.ts test/agents-claude.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/agents/interactions.ts src/agents/codex-app-server.ts src/agents/codex-app-server-supervisor.ts test/interactions.test.ts test/agents-codex-app-server.test.ts test/helpers/fake-app-server.ts
git commit -m "feat: add Codex interactive approvals"
```

### Task 3: Normalize questions and MCP elicitation

**Files:**
- Create: `src/agents/codex-interactions.ts`
- Create: `test/codex-interactions.test.ts`
- Modify: `src/agents/codex-app-server.ts`
- Modify: `test/helpers/fake-app-server.ts`

**Interfaces:**
- Produces:

```ts
export function normalizeCodexServerRequest(
  method: string,
  id: string | number,
  params: unknown,
  now?: number,
): PendingInteraction | { kind: 'unsupported'; reason: string };
export function codexInteractionResult(
  interaction: PendingInteraction,
  response: InteractionResponse,
): unknown;
```

- [ ] **Step 1: Write question normalization tests**

Cover one and three questions, descriptions, multi-select, Other, malformed
question arrays, `autoResolutionMs`, and an app approval disguised as
`tool/requestUserInput`.

- [ ] **Step 2: Write MCP elicitation tests**

Cover form accept/decline/cancel, URL accept/decline/cancel, malformed schema,
and rejection of an unknown server-request method.

- [ ] **Step 3: Run tests and verify RED**

Run: `node --test test/codex-interactions.test.ts`

Expected: FAIL because the normalization module does not exist.

- [ ] **Step 4: Implement strict normalization**

Validate object/array/string/boolean fields without trusting vendor objects.
Convert numeric request IDs to stable string IDs for the browser while keeping
the original wire ID private in the queue. Compute
`expiresAt = now + autoResolutionMs` only for a finite positive timeout.

- [ ] **Step 5: Implement exact wire responses**

Questions return the generated-schema answer map, MCP forms return
`{ action, content, _meta: null }`, and MCP URL responses return the documented
action shape. Mismatched interaction/response kinds throw before a wire write.

- [ ] **Step 6: Add the experimental capability guard**

Enable `experimentalApi` only for app-server accounts with the rollout flag.
If the generated contract lacks `tool/requestUserInput`, initialize without the
flag and reject any unexpected occurrence. Stable MCP elicitation remains on.

- [ ] **Step 7: Run focused tests**

Run: `node --test test/codex-interactions.test.ts test/agents-codex-app-server.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/agents/codex-interactions.ts src/agents/codex-app-server.ts test/codex-interactions.test.ts test/agents-codex-app-server.test.ts test/helpers/fake-app-server.ts
git commit -m "feat: handle Codex structured requests"
```

### Task 4: Add response command and sequential UI

**Files:**
- Modify: `src/server.ts`
- Modify: `web/lib.js`
- Modify: `web/app.js`
- Modify: `web/style.css`
- Modify: `test/server.test.ts`
- Modify: `test/ui-command.test.ts`
- Modify: `test/ui.test.ts`

**Interfaces:**
- Produces: POST command `{ cmd: 'respond', id: sessionId, response: InteractionResponse }`.

- [ ] **Step 1: Write server command tests**

Assert request/session ID correlation, 400 for malformed response, 404 for no
live handle, 409 for stale interaction ID, and successful forwarding without
persisting raw response values.

- [ ] **Step 2: Write sequential UI state tests**

Define and test:

```js
questionDraft(pendingId, questions)
answerQuestion(draft, questionId, values)
moveQuestion(draft, delta)
questionSubmission(draft)
```

Cover Back/Next bounds, final-submit completeness, browser-state reset on a new
pending ID, and draft preservation across ordinary SSE renders.

- [ ] **Step 3: Run tests and verify RED**

Run: `node --test test/server.test.ts test/ui-command.test.ts test/ui.test.ts`

Expected: FAIL on the new command and UI helpers.

- [ ] **Step 4: Implement the server command**

Validate the tagged response, require it to match `session.pending.id`, call
`handle.respond()`, and return 202 without clearing Registry pending state.
Return 409 after an upstream auto-resolution.

- [ ] **Step 5: Implement approval rendering**

Keep current card and interrupt placement. Render Allow and Deny from
`kind: 'approval'`, disable buttons while the response POST is pending, and use
`textContent` for every provider string.

- [ ] **Step 6: Implement the question stepper**

Store drafts in a module-level `Map` keyed by pending ID. Render one question,
Back/Next, final Submit, multi-select controls when requested, Other input, and
an expiry countdown. Browser refresh intentionally restarts at question one.

- [ ] **Step 7: Implement MCP form and URL cards**

Render supported primitive schema fields sequentially. Mark sensitive input as
password, never place values into transcript state, and render URL mode as a
safe HTTP/HTTPS link plus Accept/Decline.

- [ ] **Step 8: Run focused tests**

Run: `node --test test/server.test.ts test/ui-command.test.ts test/ui.test.ts test/sessions.test.ts`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/server.ts web/lib.js web/app.js web/style.css test/server.test.ts test/ui-command.test.ts test/ui.test.ts
git commit -m "feat: render Codex pending interactions"
```

### Task 5: Verify interaction fallback and documentation

**Files:**
- Modify: `scripts/smoke-codex-app-server.ts`
- Modify: `test/codex-app-server-smoke.test.ts`
- Modify: `README.md`

**Interfaces:**
- Produces: opt-in approval/question smoke results and documented fallback behavior.

- [ ] **Step 1: Extend fake smoke coverage**

Prove command Allow, file Deny, Auto per-request acceptance, three sequential
questions sent as one answer map, MCP form decline, and stale auto-resolution.

- [ ] **Step 2: Add guarded live cases**

Add `--interactions` to the smoke command. Require
`SWITCHBOARD_ALLOW_PAID_CODEX_SMOKE=1`; print only boolean results.

- [ ] **Step 3: Document user behavior**

Update `README.md` for Codex `needs-you`, Auto, sequential questions, expiry,
MCP forms, and text fallback when the experimental question capability is
absent.

- [ ] **Step 4: Run full verification**

Run: `npm test`

Expected: 0 failures.

Run: `git diff --check`

Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add scripts/smoke-codex-app-server.ts test/codex-app-server-smoke.test.ts README.md
git commit -m "docs: document Codex interactions"
```
