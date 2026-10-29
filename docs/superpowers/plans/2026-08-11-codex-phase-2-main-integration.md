# Codex Phase 2 Main Integration Plan

## Status update — 2026-09-09

Historical SDK integration plan, not the remaining app-server roadmap. Do not
repeat these branch merges or use its SDK-only transport decision to undo the
implemented opt-in app-server path. The runtime is now 0.153.4. SDK sessions
retain never approvals; app-server sessions force workspace-write, on-request,
and the user reviewer. Approvals and structured questions are implemented;
MCP elicitation, capability discovery, screenshot tools, usage recovery, and
default rollout remain. Follow the revised interactions/capabilities/recovery
plans. The original integration details below are retained as history.


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate the completed Codex Phase 2 implementation with current `main` while preserving every newer Switchboard and Claude feature, then merge the verified result into `main` without losing the user's uncommitted work.

**Architecture:** Merge current `main` into the isolated `codex/codex-integration-phase-2` worktree. Treat current `main` as authoritative for provider-neutral application behavior and the Phase 2 branch as authoritative for Codex prompt safety, lifecycle upserts, bounded lazy details, native images, Codex thread settings, last-turn usage, and the SDK-only transport decision. Resolve each ownership boundary independently and use the union of both branches' tests as the executable contract.

**Tech Stack:** Node.js 22.18+, TypeScript executed directly by Node, `@openai/codex-sdk` 0.145.0, `@anthropic-ai/claude-agent-sdk` 0.3.220, browser JavaScript, HTTP/SSE, git worktrees.

## Global Constraints

- Keep Codex fixed to `sandboxMode: 'workspace-write'` and `approvalPolicy: 'never'`; expose neither setting in the UI.
- Preserve target repository and user Codex configuration except for the fixed worktree safety overrides.
- Never persist, log, return through SSE, or render account environment values or adapter-only absolute attachment paths.
- Keep `npm test` offline and hermetic; the app-server evaluation remains optional and no-turn.
- Preserve all current `main` behavior: scheduling, settings, Claude plan usage, questions, slash commands, browser/simulator MCP servers, themes, current composer, Diff, Graph, merge, and push.
- Preserve the user's uncommitted files in the primary `main` checkout.

---

### Task 1: Merge histories and establish the union test contract

**Files:**
- Modify through merge: all paths changed on both branches
- Preserve: every test file present on either branch

**Interfaces:**
- Consumes: current `main` at the merge-time SHA and Phase 2 commit `227753a`
- Produces: one conflict-resolved integration tree on `codex/codex-integration-phase-2`

- [ ] **Step 1: Record both branch tips, status, and the merge base**

Run `git status --short`, `git rev-parse HEAD main`, and `git merge-base HEAD main`; require the integration worktree to be clean.

- [ ] **Step 2: Merge current `main` without committing**

Run `git merge --no-commit --no-ff main`. Keep all non-conflicting additions from both histories.

- [ ] **Step 3: Resolve documentation and non-production conflicts**

Combine `AGENTS.md` and `README.md`; retain current-main docs plus Phase 2 behavior, verification, and SDK-only decision. Preserve every plan, spec, report, font, and newly added provider-neutral source/test file.

- [ ] **Step 4: Restore the union of test expectations**

For conflicted tests, start from current `main` and add the Phase 2 cases for lifecycle, prompt safety, details, native images, settings, app-server probing, and usage. Do not discard a test merely because the other branch lacks its feature.

- [ ] **Step 5: Run the full suite to establish RED**

Run `npm test`. Expected: failures identify unresolved type, adapter, server, Registry, or UI integration boundaries; no test file is syntactically lost.

### Task 2: Reconcile shared types, Registry state, and provider adapters

**Files:**
- Modify: `src/types.ts`
- Modify: `src/sessions.ts`
- Modify: `src/agents/claude.ts`
- Modify: `src/agents/codex.ts`
- Modify as needed: `src/agents/codex-runtime.ts`, `src/agents/codex-detail.ts`, `src/agents/codex-settings.ts`, `src/prompt-input.ts`, `src/upload.ts`
- Test: `test/sessions.test.ts`, `test/agents-claude.test.ts`, `test/agents-codex.test.ts`, `test/agents-codex-process.test.ts`, `test/codex-detail.test.ts`, `test/codex-settings.test.ts`, `test/prompt-input.test.ts`

**Interfaces:**
- Produces: provider-neutral `AgentPrompt`, rich public/private transcript types, Claude question/rate/slash events, Codex upserts/settings/usage, and backward-compatible Registry persistence

- [ ] **Step 1: Define the union type model**

Keep current settings/scheduler/question contracts and add Phase 2 `AgentPrompt`, `CodexThreadSettings`, `ToolMsg`, `ReasoningMsg`, `TodoMsg`, `TurnUsage`, public detail projection, and `upsert-msg`. Retain `rate-limit`, `slash-commands`, prompt delivery, and question answer support.

- [ ] **Step 2: Reconcile Registry persistence and projection**

Preserve current settings, usage, scheduler, restart migration, question correlation, and result truncation. Add Codex upserts, globally bounded detail LRU, lazy detail reads, public SSE projection, attachment-name persistence, explicit Codex settings, and last-turn usage replacement.

- [ ] **Step 3: Reconcile Claude adapter behavior**

Keep current browser/simulator MCP injection, `AskUserQuestion`, approval FIFO, slash commands, rate limits, and tool-result output. Accept `AgentPrompt` and deliver every attachment to Claude as a worktree-relative text reference.

- [ ] **Step 4: Preserve the reviewed Codex adapter**

Keep Phase 2 native-image snapshots, lifecycle normalization, redaction, FIFO delivery, cancellation, settings, fixed safety options, cleanup, and stable failures. Do not add interactive approval behavior.

- [ ] **Step 5: Run focused provider and Registry tests**

Run `node --test test/agents-claude.test.ts test/agents-codex.test.ts test/agents-codex-process.test.ts test/codex-runtime.test.ts test/codex-detail.test.ts test/codex-settings.test.ts test/prompt-input.test.ts test/sessions.test.ts` and require zero failures.

### Task 3: Reconcile server lifecycle, commands, uploads, and scheduling

**Files:**
- Modify: `src/server.ts`
- Preserve: `src/schedule.ts`, `src/usage.ts`, `src/worktree.ts`, `src/merge.ts`
- Test: `test/server.test.ts`, `test/schedule.test.ts`, `test/usage.test.ts`, `test/worktree.test.ts`, `test/merge.test.ts`

**Interfaces:**
- Consumes: union Registry and adapter contracts from Task 2
- Produces: current HTTP/SSE command surface plus secure Phase 2 Codex input and detail routes

- [ ] **Step 1: Restore current-main server behavior**

Keep scheduling, settings, notifications, Claude limit refresh, Diff, Graph, merge/push, Host/Origin guards, slash-command snapshots, and current worktree lifecycle.

- [ ] **Step 2: Add Phase 2 launch and prompt resolution**

Integrate Codex settings validation, contained attachment resolution, native-image preparation, name-only transcript persistence, sanitized preflight errors, and resume reservations without weakening current command validation.

- [ ] **Step 3: Add bounded detail projection and route**

Use `Registry.publicSessions()` in SSE and restore `GET /detail` keyed only by Registry session/item IDs.

- [ ] **Step 4: Keep hardened uploads**

Use the Phase 2 exclusive/no-follow upload writer and retain current-main upload exclusion from worktree diff and merge behavior.

- [ ] **Step 5: Run focused server tests**

Run `node --test test/server.test.ts test/schedule.test.ts test/usage.test.ts test/worktree.test.ts test/merge.test.ts` with loopback binding allowed; require zero failures.

### Task 4: Reconcile the current UI with rich Codex behavior

**Files:**
- Modify: `web/app.js`
- Modify: `web/lib.js`
- Modify: `web/index.html`
- Modify: `web/style.css`
- Test: `test/ui.test.ts`, `test/ui-command.test.ts`, `test/palette.test.ts`

**Interfaces:**
- Consumes: current SSE snapshot plus Phase 2 public transcript/detail/settings/attachment fields
- Produces: current visual design and navigation with rich Codex transcript and native attachment controls

- [ ] **Step 1: Preserve current-main shell and interactions**

Keep themes, fixed sidebar, centered/folded chat, unified composer, paste/drag chips, stop/send button, scheduling, Diff, Graph, approvals/questions, settings, selection, and notifications.

- [ ] **Step 2: Add rich transcript projection and lazy details**

Integrate Phase 2 running tool rows, terminal states, reasoning, todos, detail expansion, revision-aware caching, request deduplication, and stale-session protection using DOM `textContent` only.

- [ ] **Step 3: Adapt current attachments to secure server input**

Send attachment relative paths separately from written prompt text, persist/render basename-only transcript metadata, retain draft and chips on failure, and clear them only after accepted delivery.

- [ ] **Step 4: Add Codex thread settings and usage display**

Expose only model, reasoning effort, web-search mode, and network access for Codex creation/stopped resume; keep safety fields absent. Render SDK-backed last-turn usage separately from estimated account pace.

- [ ] **Step 5: Run focused UI tests**

Run `node --test test/ui.test.ts test/ui-command.test.ts test/palette.test.ts` and require zero failures.

### Task 5: Verify, document, and merge into main safely

**Files:**
- Modify: `README.md`, `AGENTS.md`, integration status in the Phase 2 design
- Preserve externally: uncommitted files in `/Users/dwightbritton/Developer/Switchboard`

**Interfaces:**
- Produces: a verified merge commit on the Phase 2 branch and then on `main`

- [ ] **Step 1: Run complete verification**

Run `npm test`, `git diff --check`, Phase 2 security scans, and inspect `git status --short`. Require zero test failures and no unresolved markers.

- [ ] **Step 2: Commit the integration merge**

Create the merge commit on `codex/codex-integration-phase-2` with both histories as parents.

- [ ] **Step 3: Preserve the primary checkout's tracked uncommitted changes**

Record its exact diff, stash only the overlapping tracked files with an explicit label, and leave untracked `.claude/` worktree data untouched.

- [ ] **Step 4: Merge the verified branch into `main`**

Fast-forward or merge `codex/codex-integration-phase-2` from the primary checkout, then reapply the tracked user changes. Resolve any reapplication conflict in favor of preserving both the integrated behavior and the user's diff.

- [ ] **Step 5: Verify final `main` including restored user changes**

Run `npm test`, compare the restored tracked diff to the pre-merge copy, and report the final branch, test count, and remaining user changes.
