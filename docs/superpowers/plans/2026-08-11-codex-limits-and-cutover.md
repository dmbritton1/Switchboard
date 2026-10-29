# Codex Limits, Requeue, and Cutover Implementation Plan

## Execution baseline — revised 2026-09-10

Tasks 1–4 are implemented. Authoritative limits, usage display, reset scheduling,
and typed automatic usage-limit recovery are available for app-server sessions.
SDK sessions remain outside automatic recovery; Claude retains its existing
heuristic. App-server remains opt-in: no account migration or default flip occurred.

Recovery uses only the structured `usageLimitExceeded` variant, captured while
Auto-requeue is enabled. It forces a bounded fresh account read and queues one
visible `continue` resume only for future resettable reached windows. Multiple
reached windows must all clear; release still requires a fresh authoritative read.
Pre-existing account reads are drained before boundary/recovery reads, and
concurrent boundary calls coalesce. No provider snapshots are persisted.

Stop, deletion, manual resume, changed account/session identity, disabled recovery,
and existing queue items prevent a late enqueue. Failed resume attempts retain
queue entries so the scheduler can show their errors. User-deleted items are not
recreated by duplicate terminal events. Fixed workspace-write/on-request/user
reviewer policy remains mandatory, with SDK never approvals unchanged.

The 2026-09-11 rollout report records live lifecycle, model screenshot,
compaction, file approval, and current-runtime SDK resume evidence. The soak has
one dated day (four lifecycle completions and one resume); multi-day testing is
tabled at user request with no automation scheduled. Cross-version SDK resume
from 0.145.0 to 0.153.4 passed with retained thread identity and history. No iOS
simulator device is installed, so its conditional live capture gate is unavailable.
See `../reports/2026-09-11-codex-rollout-gate.md` for current evidence.

Next execute Task 5's remaining live compatibility and sustained-reliability
validation before considering the new-session default change. Do not intentionally
exhaust a real account; deterministic failure fixtures validate recovery. The
older detailed checklists below are historical implementation guidance; this
baseline describes current scope.


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render authoritative Codex plan and rate-limit windows, recover exactly once from `UsageLimitExceeded`, and make app-server the new-session default only after a recorded compatibility gate and soak period.

**Architecture:** Replace Claude-specific limit fields with a provider-neutral in-memory snapshot, normalize Codex account RPCs and notifications at the supervisor, and require fresh authoritative capacity before the scheduler releases reset work. Keep transport ownership immutable, and put the final default flip behind measurable live evidence rather than runtime fallback.

**Tech Stack:** Node.js 22.18+, TypeScript, Codex app-server 0.153.4, HTTP/SSE, browser JavaScript, node:test.

## Global Constraints

- Complete the foundation, interactions, and capability/MCP plans first.
- Execute in an isolated worktree created with `superpowers:using-git-worktrees`.
- Never infer authoritative Codex capacity from local token pace or error text.
- Do not persist provider limit snapshots or use a persisted reset timestamp to release restored work.
- Keep local token pace visible only as a labeled estimate.
- Create at most one automatic reset resume per qualifying turn failure.
- User Stop never queues a resume, and enabling Auto later is not retroactive.
- Keep app-server opt-in until every live gate in Task 5 is recorded as passing.
- Preserve immutable session transport ownership and explicit SDK account override.
- Keep `npm test` offline and run it before completion.

---

## File structure

- Create `src/agents/codex-limits.ts`: strict account/rate-limit normalization.
- Create `test/codex-limits.test.ts`: account modes, units, windows, and malformed data.
- Modify `src/types.ts`, `src/usage.ts`, `src/schedule.ts`, `src/sessions.ts`, and `src/server.ts`.
- Modify `src/agents/codex-app-server-supervisor.ts`, `src/agents/codex-app-server.ts`, and their fake/tests.
- Modify `web/lib.js`, `web/app.js`, `web/style.css`, `web/index.html`, and UI tests.
- Modify `scripts/codex-app-server-transport-smoke.ts`, `test/codex-app-server-transport-smoke.test.ts`, `accounts.example.json`, `README.md`, and the compatibility report.

### Task 1: Generalize the in-memory account limit model

**Files:**
- Modify: `src/types.ts`
- Modify: `src/usage.ts`
- Modify: `src/server.ts`
- Modify: `test/usage.test.ts`
- Modify: `test/server.test.ts`
- Modify: `test/state.test.ts`

**Interfaces:**
- Produces:

```ts
export type AccountLimitWindow = {
  id: string;
  label: string;
  usedPercent: number;
  windowDurationMins: number;
  resetsAt: number;
  reached: boolean;
};
export type AccountLimitSnapshot = {
  plan: string | null;
  windows: AccountLimitWindow[];
  fetchedAt: number;
  authoritative: boolean;
};
```

- [ ] **Step 1: Write provider-neutral Usage tests**

Cover no snapshot, Claude five-hour and seven-day normalization, arbitrary
Codex windows, highest-utilization ranking, shortest applicable headline,
latest reached-window reset, stale/non-authoritative state, and clearing an
account error after a successful read.

- [ ] **Step 2: Write persistence exclusion tests**

Set a complete snapshot containing plan and reset times, serialize `Usage`, and
assert none of those snapshot fields appear. Restore persisted samples/resets
and assert the provider snapshot remains absent and non-authoritative.

- [ ] **Step 3: Run tests and verify RED**

Run: `node --test test/usage.test.ts test/server.test.ts test/state.test.ts`

Expected: FAIL because `AccountLimitSnapshot` and its Usage methods are absent.

- [ ] **Step 4: Add the new Usage API**

Implement:

```ts
setLimitSnapshot(account: string, snapshot: AccountLimitSnapshot | null, error: string | null): void;
getLimitSnapshot(account: string): { snapshot: AccountLimitSnapshot | null; error: string | null };
markLimitsStale(account: string): void;
authoritativeResetAt(account: string, now?: number): number | null;
```

`authoritativeResetAt()` returns the latest future `resetsAt` among every
reached window only when `authoritative` is true. Keep the existing local
sample and Claude rejected-event persistence behavior until reset scheduling is
migrated in Task 3.

- [ ] **Step 5: Normalize current Claude reads into the new shape**

Map the current five-hour and seven-day values to stable IDs, labels, duration
minutes, millisecond timestamps, reached flags, and plan. Do not change Claude
probe cadence or error wording in this task.

- [ ] **Step 6: Update server ranking and snapshots**

Rank accounts with real windows by the maximum `usedPercent`; use local pace
only when no authoritative window exists. Return the provider-neutral snapshot
to the browser and label every estimate explicitly.

- [ ] **Step 7: Run focused tests**

Run: `node --test test/usage.test.ts test/server.test.ts test/state.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/usage.ts src/server.ts test/usage.test.ts test/server.test.ts test/state.test.ts
git commit -m "refactor: generalize account limits"
```

### Task 2: Wire authoritative Codex account telemetry

**Files:**
- Create: `src/agents/codex-limits.ts`
- Create: `test/codex-limits.test.ts`
- Modify: `src/agents/codex-app-server-supervisor.ts`
- Modify: `src/agents/codex-app-server.ts`
- Modify: `test/helpers/fake-app-server.ts`
- Modify: `test/agents-codex-app-server.test.ts`
- Modify: `src/server.ts`
- Modify: `test/server.test.ts`

**Interfaces:**
- Produces:

```ts
export function normalizeCodexAccount(input: unknown): { plan: string | null; supportsRateLimits: boolean };
export function normalizeCodexRateLimits(input: unknown, plan: string | null, now?: number): AccountLimitSnapshot;

export class CodexAppServerSupervisor {
  readLimits(): Promise<AccountLimitSnapshot>;
}
```

- [ ] **Step 1: Write strict normalization tests**

Cover ChatGPT and API-key authentication, absent plan, the single-bucket
fallback and `rateLimitsByLimitId`, primary and secondary windows,
seconds-to-milliseconds conversion confirmed by the generated contract,
`usedPercent`, reached classifications, past resets, unknown window labels,
and malformed objects.

- [ ] **Step 2: Write RPC and notification tests**

Assert supervisor initialization calls `account/read` and
`account/rateLimits/read`, `account/updated` refreshes plan, and
`account/rateLimits/updated` replaces windows. A telemetry read failure must not
stop an ordinary turn or expose the account environment.

- [ ] **Step 3: Run tests and verify RED**

Run: `node --test test/codex-limits.test.ts test/agents-codex-app-server.test.ts test/server.test.ts`

Expected: FAIL because Codex limit normalization and reads do not exist.

- [ ] **Step 4: Implement account-mode gating**

Only successful ChatGPT-backed account data can produce
`authoritative: true`. API-key-only, logged-out, and unsupported responses
return a sanitized error and no release-eligible snapshot.

- [ ] **Step 5: Implement multi-window normalization**

Validate every field against the pinned generated schema, prefer
`rateLimitsByLimitId` over the backward-compatible single-bucket view, and
expand each bucket's primary/secondary values into stable window IDs. Convert
timestamps once at the adapter edge, preserve every valid window, and sort by
duration then ID for stable display. Derive `reached` only from the generated
`rateLimitReachedType` semantics; do not synthesize a reset for missing provider
data.

- [ ] **Step 6: Add refresh ownership and cadence**

The account supervisor performs a coordinated read at initialization, on
relevant notifications, on explicit `readLimits()`, and no more than once per
five-minute periodic refresh. Coalesce concurrent callers and publish results
to `Usage` through one server callback.

- [ ] **Step 7: Run focused tests**

Run: `node --test test/codex-limits.test.ts test/agents-codex-app-server.test.ts test/server.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/agents/codex-limits.ts src/agents/codex-app-server-supervisor.ts src/agents/codex-app-server.ts src/server.ts test/codex-limits.test.ts test/agents-codex-app-server.test.ts test/server.test.ts test/helpers/fake-app-server.ts
git commit -m "feat: read Codex plan limits"
```

### Task 3: Add typed usage-limit recovery and fresh reset release

**Files:**
- Modify: `src/types.ts`
- Modify: `src/usage.ts`
- Modify: `src/schedule.ts`
- Modify: `src/sessions.ts`
- Modify: `src/server.ts`
- Modify: `src/agents/codex-app-server.ts`
- Modify: `test/usage.test.ts`
- Modify: `test/schedule.test.ts`
- Modify: `test/sessions.test.ts`
- Modify: `test/server.test.ts`
- Modify: `test/agents-codex-app-server.test.ts`
- Modify: `test/helpers/fake-app-server.ts`

**Interfaces:**
- Produces typed adapter failure code `codex_usage_limited`.
- Produces:

```ts
export function shouldRequeueCodex(input: {
  agentDied: boolean;
  userStopped: boolean;
  failureCode: string | null;
  autoRequeue: boolean;
  snapshot: AccountLimitSnapshot | null;
  now: number;
  alreadyQueued: boolean;
}): boolean;

export class Scheduler {
  findResetResume(sessionId: string): Queued | null;
  addResetResume(account: string, sessionId: string, prompt: 'continue', now?: number): Queued;
}
```

- [ ] **Step 1: Write typed failure and deduplication tests**

Drive `codexErrorInfo: UsageLimitExceeded` through the fake and assert the
session stops with `codex_usage_limited`. Cover duplicate failure/completion
notifications, user Stop, Auto disabled, Auto enabled later, an existing reset
item, and an immediate refresh that fails or reports no future reached reset.

- [ ] **Step 2: Write multi-window blocking tests**

Assert one failure with two reached windows queues exactly one visible
`continue` resume at the later required reset. Later notifications may move its
effective release boundary without creating a second item.

- [ ] **Step 3: Write restart freshness tests**

Restore a reset queue item plus persisted old reset data. Assert it cannot fire
until a current-process authoritative refresh succeeds and reports capacity.
Assert an account still blocked at the boundary stays waiting.

- [ ] **Step 4: Run tests and verify RED**

Run: `node --test test/usage.test.ts test/schedule.test.ts test/sessions.test.ts test/server.test.ts test/agents-codex-app-server.test.ts`

Expected: FAIL on typed failure, one-shot enqueue, and freshness gating.

- [ ] **Step 5: Normalize the typed failure**

Map only the structured app-server error variant to
`codex_usage_limited`; never match human-readable error text. Clear pending
interactions before the Registry reaches stopped state.

- [ ] **Step 6: Refresh before making the enqueue decision**

On a qualifying agent-ended path, await the account supervisor's immediate
limit read. Enqueue only if `shouldRequeueCodex()` sees a fresh authoritative
snapshot with a future reached-window reset and no prior item for that failed
turn/session.

- [ ] **Step 7: Make reset release a two-stage server operation**

Before each scheduler pass, find accounts with waiting reset items whose known
boundary is due, refresh those accounts, then call `Scheduler.due()` with a
synchronous context derived from the fresh snapshots. `free(account)` must
return false for Codex reset work when current-process authoritative state is
missing, stale, reached, or failed to refresh.

- [ ] **Step 8: Preserve scheduler invariants**

Keep one reset item per account per pass, busy-account blocking, visible
waiting state, deletion finality, and command-path validation. Do not interrupt
a successful active turn in response to a limit notification.

- [ ] **Step 9: Run focused tests**

Run: `node --test test/usage.test.ts test/schedule.test.ts test/sessions.test.ts test/server.test.ts test/agents-codex-app-server.test.ts`

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/types.ts src/usage.ts src/schedule.ts src/sessions.ts src/server.ts src/agents/codex-app-server.ts test/usage.test.ts test/schedule.test.ts test/sessions.test.ts test/server.test.ts test/agents-codex-app-server.test.ts test/helpers/fake-app-server.ts
git commit -m "feat: requeue Codex usage limits safely"
```

### Task 4: Render all windows and scheduling eligibility

**Files:**
- Modify: `web/lib.js`
- Modify: `web/app.js`
- Modify: `web/style.css`
- Modify: `web/index.html`
- Modify: `test/ui.test.ts`
- Modify: `test/ui-command.test.ts`
- Modify: `test/server.test.ts`

- [ ] **Step 1: Write account view tests**

Cover shortest-window headline, expanded rows for every window, local reset
formatting, maximum-utilization ranking, plan label, reached treatment, stale
telemetry, API-key estimate wording, and a sanitized telemetry error.

- [ ] **Step 2: Write scheduling control tests**

Assert `When usage resets` is enabled only with a current authoritative future
reset, and disabled with a concrete explanation for API-key, unsupported,
stale, no reached window, and failed-refresh states. Cover the automatic
`waiting for reset` queue treatment for Codex.

- [ ] **Step 3: Run tests and verify RED**

Run: `node --test test/ui.test.ts test/ui-command.test.ts test/server.test.ts`

Expected: FAIL because the UI still assumes Claude's two fixed windows.

- [ ] **Step 4: Implement provider-neutral account rendering**

Use a sorted window array, headline the shortest applicable window, show all
windows in the account panel, and retain the highest utilization for account
ranking. Render provider plan/window strings with `textContent`.

- [ ] **Step 5: Implement eligibility explanations**

Have server state include `resetScheduling: { enabled, reason }`; do not make
the browser infer authority from percentages. Update the hint that currently
says Codex has no rate-limit signal.

- [ ] **Step 6: Run focused tests**

Run: `node --test test/ui.test.ts test/ui-command.test.ts test/server.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add web/lib.js web/app.js web/style.css web/index.html test/ui.test.ts test/ui-command.test.ts test/server.test.ts
git commit -m "feat: show Codex plan windows"
```

### Task 5: Pass the live gate and flip only the new-session default

**Files:**
- Modify: `scripts/codex-app-server-transport-smoke.ts`
- Modify: `test/codex-app-server-transport-smoke.test.ts`
- Modify: `docs/superpowers/reports/2026-08-01-codex-phase-2-compatibility.md`
- Modify: `accounts.example.json`
- Modify: `src/server.ts`
- Modify: `test/server.test.ts`
- Modify: `test/sessions.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Extend the deterministic smoke fixture**

Cover account/plan/rate-limit reads and updates, multi-window rendering data,
typed `UsageLimitExceeded`, one reset resume, and a fresh-capacity release. Do
not intentionally exhaust a real account.

- [ ] **Step 2: Run the complete offline suite before live work**

Run: `npm test`

Expected: PASS.

- [ ] **Step 3: Run and record the opt-in live compatibility matrix**

Using explicit real-account flags outside `npm test`, record pinned-version
initialization/auth/plan/clean shutdown; new turn/follow-up/restart/resume;
command and file approval; guarded structured question; browser screenshot;
simulator screenshot when available; and legacy SDK resume after the dependency
upgrade.

- [ ] **Step 4: Complete the soak gate**

Record at least 20 successful app-server turns, including five resumes, across
at least seven calendar days. Require zero protocol mismatches and zero
supervisor crashes that escape account-scoped containment. Record starts,
crashes, protocol mismatches, pending-request latency, and requeue outcomes
without prompts, answers, secrets, or raw account identifiers.

- [ ] **Step 5: Stop here if any gate is unmet**

Leave the account default as `sdk`, publish the failed gate in the compatibility
report, and keep opt-in app-server sessions available for remediation. This is
the required rollback state, not a silent SDK fallback for an app-server
session.

- [ ] **Step 6: After every gate passes, write the default-flip test**

Assert an account with no explicit `codexTransport` creates new sessions as
`app-server`, an explicit `sdk` override remains SDK, a restored legacy session
with no persisted session transport remains SDK, and changing the account
setting never changes an existing session.

- [ ] **Step 7: Run the focused test and verify RED**

Run: `node --test test/sessions.test.ts test/server.test.ts`

Expected: FAIL only on the new-account default assertion.

- [ ] **Step 8: Flip the account default without migrating sessions**

Change the new-session account transport resolver in `src/server.ts` so an
omitted account transport is `app-server`. Keep the Registry migration rule
that an old persisted session with no transport is `sdk`, and keep the explicit
account-level SDK override documented.

- [ ] **Step 9: Run complete verification**

Run: `npm test`

Expected: PASS.

- [ ] **Step 10: Commit the evidence and default together**

```bash
git add scripts/codex-app-server-transport-smoke.ts test/codex-app-server-transport-smoke.test.ts docs/superpowers/reports/2026-08-01-codex-phase-2-compatibility.md accounts.example.json src/server.ts test/server.test.ts test/sessions.test.ts README.md
git commit -m "feat: default new Codex sessions to app-server"
```

### Task 6: Final program verification

**Files:**
- Verify all files changed by the four Codex app-server plans.

- [ ] **Step 1: Run protocol and fake-boundary coverage**

Run: `node --test test/codex-app-server-contract.test.ts test/codex-app-server-client.test.ts test/agents-codex-app-server.test.ts test/codex-approvals.test.ts test/codex-questions.test.ts test/codex-elicitation.test.ts test/codex-capabilities.test.ts test/mcp-sidecars.test.ts test/codex-limits.test.ts test/codex-app-server-transport-smoke.test.ts`

Expected: PASS.

- [ ] **Step 2: Run all offline tests**

Run: `npm test`

Expected: PASS.

- [ ] **Step 3: Review safety invariants**

Confirm fixed `workspaceWrite`, strict settings keys, immutable transport,
dedicated worktrees, no repository Codex config writes, no plugin marketplace
calls, no `thread/shellCommand`, no raw secrets/answers in state or SSE, and no
interactive browser/simulator tools.

- [ ] **Step 4: Review acceptance criteria against recorded evidence**

Link every design acceptance criterion to an offline test and, where required,
one live matrix row. SDK removal is explicitly excluded and requires a separate
cleanup decision after no SDK sessions remain.

- [ ] **Step 5: Commit final documentation corrections, if any**

```bash
git add README.md docs/superpowers/reports/2026-08-01-codex-phase-2-compatibility.md
git commit -m "docs: close Codex app-server parity rollout"
```
