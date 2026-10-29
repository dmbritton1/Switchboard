# Codex App-Server Turn Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in Codex app-server turn transport that reuses the merged
account-scoped telemetry process while preserving SDK ownership and resume
behavior for every legacy Codex session.

**Architecture:** Keep `@openai/codex-sdk` pinned to `0.145.0`, whose generated
contract already contains the required stable thread and turn methods. Refactor
the telemetry supervisor behind one shared provider pool per Codex account; the
pool starts in telemetry-only mode and can promote once, before the first
app-server session, to a turn-capable launch profile. Persist transport ownership
on each session, route all future work through that immutable choice, and keep
the production default on the SDK until the later live gate and soak period.

**Tech Stack:** Node.js 22.18+, TypeScript executed directly by Node,
`@openai/codex-sdk` 0.145.0, newline-delimited JSON-RPC over stdio, HTTP/SSE,
browser JavaScript, `node:test`.

**Spec:**
[`docs/superpowers/specs/2026-08-11-codex-app-server-parity-design.md`](../specs/2026-08-11-codex-app-server-parity-design.md)

## Scope and supersession

This plan implements phase two of the revised parity design: opt-in app-server
ownership for new Codex sessions. It supersedes Tasks 3-5 of
`docs/superpowers/plans/2026-08-11-codex-app-server-foundation.md`. Tasks 1-2 of
that older plan were replaced by the telemetry foundation already merged on
`main`; do not repeat them and do not upgrade to its proposed `0.147.0`.

This phase ends with:

- one shared app-server process owner per Codex account;
- opt-in app-server start, follow-up, resume, interrupt, and turn event
  normalization;
- immutable, persisted SDK/app-server ownership for every Codex session;
- an SDK default for new sessions and SDK migration for legacy stored sessions;
- deterministic fake-process coverage and a separately authorized paid smoke
  command.

This phase does **not** add interactive approvals, `needs-you`, structured
questions, MCP elicitation UI, capability discovery, injected browser/simulator
MCP sidecars, typed usage-limit recovery, automatic Codex requeue, or the
app-server default flip. With the interaction phase absent, app-server turns
continue using fixed `approvalPolicy: "never"`; every server request is answered
with a bounded unsupported response so no request can hang the child.

## Global Constraints

- Execute in an isolated worktree created with
  `superpowers:using-git-worktrees`; do not implement in the user's primary
  checkout.
- Use Node 22.18 or newer.
- Keep `@openai/codex-sdk` pinned exactly to `0.145.0`; upgrade only under a
  separate compatibility review if the installed generated contract stops
  matching.
- Keep one app-server process owner per Codex account. Telemetry and app-server
  sessions must share it; never create a second session-only child.
- Promotion from telemetry-only to turn-capable mode is one-way for the process
  lifetime. Close the telemetry child before relaunching it with the turn
  profile, mark its snapshot stale during the handoff, and never promote while
  an app-server turn is active.
- Keep Codex sandbox fixed to `workspace-write` and approval policy fixed to
  `never` in this phase. Do not expose either setting.
- The telemetry profile keeps empty hooks, empty MCP servers, and disabled OTel.
  The turn profile preserves user and repository hooks/MCP configuration and
  disables OTel only. Neither profile writes `.codex/config.toml`.
- Preserve target repository Codex configuration, instructions, worktree
  isolation, and current per-thread model/reasoning/web/network settings.
- Never use `thread/shellCommand` or any account/login/config mutation method.
- Never let SDK and app-server open or resume the same vendor thread.
- Never replay an interrupted app-server turn. Prompts not handed to
  `turn/start` become `unsent`; a prompt handed to `turn/start` stays `sent`
  even if the response is lost.
- Never persist, log, return over SSE, or render account environment values,
  raw child stderr, raw reasoning, or absolute attachment paths.
- Keep provider account snapshots process-local.
- Keep `npm test` offline. Real-account turn checks require the explicit paid
  smoke guard and are never part of `npm test`.
- Run focused tests during each red/green cycle and `npm test` before
  completion.

---

## Target file map

### New production files

- `src/agents/codex-app-server.ts` — app-server `Adapter`, prompt conversion,
  turn FIFO, and lifecycle normalization.
- `src/agents/codex-provider.ts` — one runtime/supervisor entry per Codex
  account, shared by telemetry and session preparation.
- `scripts/codex-app-server-transport-smoke.ts` — guarded live start,
  follow-up, resume, and interrupt smoke command.

### New test files

- `test/agents-codex-app-server.test.ts` — app-server adapter normalization,
  FIFO, interruption, crash, and multi-session routing.
- `test/codex-provider.test.ts` — single-process ownership, mode promotion,
  runtime caching, and transport selection.
- `test/codex-app-server-transport-smoke.test.ts` — fake smoke evidence and paid
  guard.

### Existing files to modify

- `src/agents/codex-app-server-contract.ts`
- `src/agents/codex-app-server-supervisor.ts`
- `src/account-limits.ts`
- `src/accounts.ts`
- `src/types.ts`
- `src/sessions.ts`
- `src/server.ts`
- `test/helpers/fake-app-server.ts`
- `test/codex-app-server-contract.test.ts`
- `test/codex-app-server-supervisor.test.ts`
- `test/account-limits.test.ts`
- `test/accounts.test.ts`
- `test/sessions.test.ts`
- `test/server.test.ts`
- `test/ui-command.test.ts`
- `web/lib.js`
- `accounts.example.json`
- `package.json`
- `README.md`
- `docs/superpowers/reports/2026-08-01-codex-app-server-decision.md`

---

### Task 1: Add a version-matched turn contract and launch profile

**Files:**

- Modify: `src/agents/codex-app-server-contract.ts`
- Modify: `test/codex-app-server-contract.test.ts`
- Modify: `test/helpers/fake-app-server.ts`

**Interfaces:**

- Consumes: the existing generated-schema verifier and telemetry method sets.
- Produces:

```ts
export type CodexAppServerMode = 'telemetry' | 'turns';

export const TURN_CLIENT_METHODS = [
  'thread/start',
  'thread/resume',
  'turn/start',
  'turn/interrupt',
] as const;

export const TURN_NOTIFICATIONS = [
  'error',
  'thread/started',
  'thread/tokenUsage/updated',
  'turn/started',
  'turn/plan/updated',
  'item/started',
  'item/completed',
  'turn/completed',
] as const;

export function appServerArgs(mode: CodexAppServerMode): string[];
export function verifyAppServerContract(
  runtime: PreparedCodexRuntime,
  mode: CodexAppServerMode,
  deps?: ContractDeps,
): Promise<void>;
```

- [ ] **Step 1: Write RED tests for the two method profiles**

  Extend `test/codex-app-server-contract.test.ts` to assert the arrays above,
  retain the existing telemetry arrays unchanged, and prove that
  `verifyAppServerContract(runtime, 'turns')` rejects when any required turn
  method or notification is missing. Keep the exact ten-member
  `DENIED_SERVER_METHODS` check in both modes.

```ts
assert.deepEqual(TURN_CLIENT_METHODS, [
  'thread/start', 'thread/resume', 'turn/start', 'turn/interrupt',
]);
assert.deepEqual(TURN_NOTIFICATIONS, [
  'error', 'thread/started', 'thread/tokenUsage/updated', 'turn/started',
  'turn/plan/updated', 'item/started', 'item/completed', 'turn/completed',
]);
```

- [ ] **Step 2: Write RED launch-profile tests**

  Assert the exact process arguments:

```ts
assert.deepEqual(appServerArgs('telemetry'), [
  '--strict-config',
  '-c', 'hooks={}',
  '-c', 'mcp_servers={}',
  '-c', 'otel.exporter="none"',
  'app-server', '--listen', 'stdio://',
]);
assert.deepEqual(appServerArgs('turns'), [
  '--strict-config',
  '-c', 'otel.exporter="none"',
  'app-server', '--listen', 'stdio://',
]);
```

  Extend the fake launch recorder to prove the turn profile does not contain
  `hooks={}` or `mcp_servers={}` and therefore preserves inherited hooks/MCP
  configuration. Both profiles must reject unknown config keys under
  `--strict-config`.

- [ ] **Step 3: Write RED shape tests for thread and turn traffic**

  Extend the fake generator with the exact pinned `0.145.0` fields used by this
  phase and assert the verifier checks them:

```ts
type ThreadStartParams = {
  model?: string | null;
  cwd?: string | null;
  approvalPolicy?: 'never' | unknown;
  sandbox?: 'workspace-write' | unknown;
  config?: Record<string, unknown> | null;
};
type ThreadResumeParams = ThreadStartParams & { threadId: string };
type TurnStartParams = {
  threadId: string;
  clientUserMessageId?: string | null;
  input: unknown[];
};
type TurnInterruptParams = { threadId: string; turnId: string };
```

  Require `UserInput` text and `localImage`, `ThreadItem` agent-message,
  reasoning, plan, command, file-change, MCP, web-search, error, and compaction
  variants; `Turn.status` values; `Turn.error.codexErrorInfo`; last-turn token
  usage fields; and thread/turn/item routing IDs.

- [ ] **Step 4: Run the focused test and verify RED**

  Run:

  `node --test test/codex-app-server-contract.test.ts`

  Expected: FAIL because turn-profile exports and shape verification do not
  exist.

- [ ] **Step 5: Generalize the verifier without weakening telemetry**

  Rename `telemetryAppServerArgs()` to `appServerArgs(mode)` and keep a
  compatibility export if the telemetry smoke still imports the old name.
  Generate the schema once per `commandPath + version`, validate the full pinned
  server-request union on every pass, and cache profile verification separately
  so telemetry startup cannot claim the turn surface was checked.

  Keep `CODEX_TELEMETRY_VERSION = '0.145.0'` as the single pinned runtime
  version. Do not copy generated files into the repository and do not add a
  dependency upgrade.

- [ ] **Step 6: Extend the fake generated contract**

  Add the turn methods, notifications, and minimal generated files used by Step
  3. Continue supporting `FAKE_APP_SERVER_SCHEMA_OMIT=<member>` and exact
  unknown-server-request rejection. The fake must preserve all telemetry
  contract fixtures so the existing no-turn gate remains meaningful.

- [ ] **Step 7: Prove GREEN and telemetry compatibility**

  Run:

  `node --test test/codex-app-server-contract.test.ts test/app-server-probe.test.ts test/codex-app-server-supervisor.test.ts`

  Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/agents/codex-app-server-contract.ts test/codex-app-server-contract.test.ts test/helpers/fake-app-server.ts
git commit -m "build: lock Codex turn transport contract"
```

---

### Task 2: Share one promotable supervisor through a Codex provider pool

**Files:**

- Create: `src/agents/codex-provider.ts`
- Create: `test/codex-provider.test.ts`
- Modify: `src/agents/codex-app-server-supervisor.ts`
- Modify: `test/codex-app-server-supervisor.test.ts`
- Modify: `src/account-limits.ts`
- Modify: `test/account-limits.test.ts`
- Modify: `test/helpers/fake-app-server.ts`

**Interfaces:**

- Consumes: `CodexAppServerMode`, `appServerArgs()`,
  `verifyAppServerContract()`, `prepareCodexRuntime()`, and the existing
  telemetry reconciliation API.
- Produces:

```ts
export type CodexTransport = 'sdk' | 'app-server';

export type CodexLimitListener = {
  onSnapshot(snapshot: AccountLimitSnapshot): void;
  onStale(reason: string): void;
};

export type CodexSessionRoute = {
  onNotification(method: string, params: unknown): void;
  onFatal(reason: string, code: CodexFailureCode): void;
};

export class CodexAppServerSupervisor {
  subscribe(listener: CodexLimitListener): () => void;
  start(): Promise<void>;
  ensureTurnTransport(): Promise<void>;
  registerSession(sessionId: string, route: CodexSessionRoute): () => void;
  bindThread(sessionId: string, threadId: string): void;
  requestForSession<T>(
    sessionId: string,
    method: 'thread/start' | 'thread/resume' | 'turn/start' | 'turn/interrupt',
    params: unknown,
  ): Promise<T>;
  reconcile(): Promise<AccountLimitSnapshot>;
  readAtResetBoundary(now?: number): Promise<AccountLimitSnapshot>;
  close(): Promise<void>;
}

export class CodexProviderPool {
  limits(account: Account, listener: CodexLimitListener): Promise<CodexLimitSupervisor>;
  prepare(
    account: Account,
    transport: CodexTransport,
    sessionId: string,
  ): Promise<{ adapter: Adapter; runtimeVersion: string }>;
  close(): Promise<void>;
}
```

- [ ] **Step 1: Write RED supervisor-promotion tests**

  Start telemetry, assert one child uses the telemetry profile, then call
  `ensureTurnTransport()`. Assert the old child closes cleanly, listeners
  receive a stale transition, exactly one replacement child starts with the
  turn profile, telemetry reconciles again through that replacement, and a
  second promotion is a no-op.

  Add concurrent promotion/read coverage: a reconciliation racing promotion
  must settle with a sanitized unavailable error or the replacement snapshot;
  it must never write to the retired child or launch two replacements.

- [ ] **Step 2: Write RED session-routing and crash tests**

  Register two session routes, bind distinct thread IDs, interleave item and
  turn notifications, and assert exact routing. Account notifications continue
  to reach telemetry only. Private and unknown notifications reach neither
  Registry nor diagnostics.

  Crash the child with two active routes. Assert each route receives exactly
  one `codex_transport_crashed`, the limit listener becomes stale, the
  supervisor restarts in turn mode, and no session method is replayed after
  restart.

- [ ] **Step 3: Write RED provider-pool ownership tests**

  Cover these cases in `test/codex-provider.test.ts`:

  - two telemetry callers for one account share one runtime and supervisor;
  - telemetry followed by an app-server adapter promotes the same supervisor;
  - two app-server sessions share one turn-capable child and receive distinct
    adapters;
  - an SDK session uses `createCodexAdapter(runtime)` without promoting the
    telemetry child;
  - two configured Codex accounts never share a runtime or child;
  - `close()` settles all supervisors once;
  - an app-server contract/preflight failure never returns an SDK adapter.

- [ ] **Step 4: Run focused tests and verify RED**

  Run:

  `node --test test/codex-app-server-supervisor.test.ts test/codex-provider.test.ts test/account-limits.test.ts`

  Expected: FAIL on the missing listener, promotion, routing, and provider-pool
  APIs.

- [ ] **Step 5: Refactor supervisor observers and mode ownership**

  Replace constructor-owned `onSnapshot`/`onStale` callbacks with a listener
  set. Preserve exception isolation for every listener. Track the current
  profile as `'telemetry' | 'turns'`, pass it to contract verification and
  launch arguments, and make promotion a serialized close/relaunch operation.

  Promotion must clear ready/read state, preserve restart backoff ownership,
  mark the prior snapshot stale, and permanently select `'turns'`. Reject
  promotion if a session route already has an active turn; this indicates a
  programming error because adapters promote before registration.

- [ ] **Step 6: Add explicit session request allowlisting and routing**

  `requestForSession()` rejects unless the supervisor is in turn mode, the
  session is registered, and the method is one of the four turn-client methods.
  `bindThread()` rejects duplicate ownership. Route only notifications carrying
  a bound `threadId`; do not infer ownership from turn or item IDs.

  Continue answering every member of `DENIED_SERVER_METHODS` with JSON-RPC
  error `-32601`. Use copy that says the interaction is unavailable in the
  current Switchboard phase, and preserve the external-token telemetry latch
  for `account/chatgptAuthTokens/refresh`.

- [ ] **Step 7: Implement the provider pool**

  Cache one `PreparedCodexRuntime` promise and one supervisor per account name.
  `limits()` subscribes the coordinator listener and returns the same
  supervisor. `prepare(..., 'sdk', ...)` returns the existing SDK adapter.
  `prepare(..., 'app-server', ...)` verifies/promotes the supervisor and returns
  `createCodexAppServerAdapter(supervisor, sessionId)`; Task 3 supplies that
  function, so use an injectable adapter factory in this task's tests until
  Task 3 lands.

- [ ] **Step 8: Make account limits consume the shared pool**

  Replace `AccountLimitCoordinator`'s private supervisor/runtime maps with an
  injected `CodexProviderPool` limit surface. Keep the existing factory seam for
  tests by wrapping it in a fake pool. The coordinator still owns cadence,
  snapshot validation, reset-boundary timeout, and public error wording; the
  pool owns child lifetime.

  `AccountLimitCoordinator.close()` unsubscribes its listeners but does not
  close an externally supplied pool. The application entry point closes the
  shared pool once from the HTTP server close path.

- [ ] **Step 9: Prove GREEN**

  Run:

  `node --test test/codex-app-server-supervisor.test.ts test/codex-provider.test.ts test/account-limits.test.ts test/codex-limits.test.ts`

  Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/agents/codex-provider.ts src/agents/codex-app-server-supervisor.ts src/account-limits.ts test/codex-provider.test.ts test/codex-app-server-supervisor.test.ts test/account-limits.test.ts test/helpers/fake-app-server.ts
git commit -m "refactor: share the Codex app-server supervisor"
```

---

### Task 3: Implement the app-server Adapter and normalize turn events

**Files:**

- Create: `src/agents/codex-app-server.ts`
- Create: `test/agents-codex-app-server.test.ts`
- Modify: `src/agents/codex-provider.ts`
- Modify: `src/types.ts`
- Modify: `src/agents/codex.ts`
- Modify: `test/agents-codex.test.ts`
- Modify: `test/helpers/fake-app-server.ts`
- Modify: `web/lib.js`
- Modify: `test/ui-command.test.ts`

**Interfaces:**

- Consumes: the supervisor session API from Task 2, `snapshotCodexPrompt()`,
  `safeCodexDetail()`, `redactCodexText()`, and current provider-neutral
  `AdapterEvent` shapes.
- Produces:

```ts
export function codexAppServerPromptInput(prompt: AgentPrompt): Array<
  | { type: 'text'; text: string; text_elements: [] }
  | { type: 'localImage'; path: string }
>;

export function normalizeCodexAppServerItem(
  phase: 'started' | 'completed',
  item: unknown,
  env?: Record<string, string>,
): AdapterEvent[];

export function createCodexAppServerAdapter(
  supervisor: CodexAppServerSupervisor,
  sessionId: string,
  runtimeVersion: string,
): Adapter;
```

- [ ] **Step 1: Write RED prompt-conversion tests**

  Assert plain text includes `text_elements: []`, supported images become
  `localImage`, non-image files remain worktree-relative text references, and
  absolute file paths never enter text inputs. Reuse the same upload snapshot
  and cleanup behavior as the SDK adapter.

```ts
assert.deepEqual(codexAppServerPromptInput(prompt), [
  { type: 'text', text: 'inspect this\nAttached file: notes.txt', text_elements: [] },
  { type: 'localImage', path: '/validated/worktree/image.png' },
]);
```

- [ ] **Step 2: Write RED item and plan normalization tests**

  Cover `agentMessage`, `reasoning`, `plan`, `commandExecution`, `fileChange`,
  `mcpToolCall`, `webSearch`, error, and context-compaction items. Match the SDK
  adapter's stable tool rows, detail redaction, and bounded detail admission.
  Emit reasoning summaries only; ignore raw reasoning content/deltas. Convert
  `turn/plan/updated` steps to the existing `TodoMsg` shape with one stable ID.

  Ignore `userMessage`, unknown item variants, thread paths, and raw response
  notifications. Never emit absolute item paths as summaries.

- [ ] **Step 3: Write RED turn FIFO and delivery tests**

  Start a new thread and queue two prompts. Assert:

  - `thread/start` includes `cwd`, `approvalPolicy: 'never'`,
    `sandbox: 'workspace-write'`, optional model, and only validated settings in
    `config`;
  - `turn/start` begins only after the thread response binds its ID;
  - model reasoning effort is sent as `effort`, while web-search and workspace
    network settings use `config.web_search` and
    `config.sandbox_workspace_write.network_access`;
  - prompt delivery changes from `queued` to `sent` immediately before
    `turn/start` is written;
  - the second prompt waits for the first `turn/completed`;
  - completed turns emit last-turn usage and `done` before the next queued turn
    returns to `working`;
  - a thread response whose cwd, sandbox, or approval policy differs from the
    mandatory values fails closed before a turn starts.

- [ ] **Step 4: Write RED resume, interrupt, and crash tests**

  Assert resume uses only `thread/resume` with the stored vendor thread ID and
  never calls `thread/start`. `stop()` sends one `turn/interrupt` for the active
  turn, marks queued prompts unsent, and emits one `codex_user_stopped` even when
  the interrupted completion arrives later.

  On transport crash, mark prompts still in the local FIFO unsent, emit one
  `codex_transport_crashed`, detach the route, and do not replay the active or
  queued work after supervisor restart. A request timeout maps to
  `codex_request_timed_out`; initialization/preflight failures map to their
  stable codes.

- [ ] **Step 5: Write RED multi-session integration tests**

  Drive two adapters through the real fake stdio child, interleave their item,
  usage, plan, and completion notifications, and assert each Registry receives
  only its own events. Stopping one session must not stop the other or the
  account telemetry stream.

- [ ] **Step 6: Run the focused tests and verify RED**

  Run:

  `node --test test/agents-codex-app-server.test.ts test/agents-codex.test.ts test/ui-command.test.ts`

  Expected: FAIL because the app-server adapter and new failure labels do not
  exist.

- [ ] **Step 7: Refactor shared Codex normalization helpers**

  Extract only the item-status, detail-redaction, and failure-label logic that
  both transports actually share. Keep wire-specific input and event parsing in
  separate files: SDK `local_image` and app-server `localImage` must not share a
  falsely generic type.

  Add these codes to `CodexFailureCode` and browser copy:

```ts
type AppServerTransportFailureCode =
  | 'codex_app_server_unavailable'
  | 'codex_protocol_mismatch'
  | 'codex_app_server_initialization_failed'
  | 'codex_transport_crashed'
  | 'codex_request_timed_out';
```

  Reuse `codex_auth_unavailable`, `codex_sandbox_denied`,
  `codex_start_failed`, `codex_resume_failed`, `codex_stream_failed`, and
  `codex_user_stopped` where their meanings remain exact. Do not add
  `codex_usage_limited` until the recovery phase.

- [ ] **Step 8: Implement thread setup and turn draining**

  Register the session route before starting or resuming a thread. Validate the
  response, bind the thread ID once, emit `vendor-session-id`, then drain one
  prompt at a time. Track the active turn ID from the `turn/start` response and
  ignore stale notifications for earlier completed/failed turns.

  A completed status emits the latest matching `tokenUsage.last` fields and
  `done`. An interrupted status is terminal only when it was not initiated by
  the already-settled user stop path. A failed status uses the redacted
  `Turn.error.message`; retain `codexErrorInfo` only inside the adapter long
  enough to classify the failure, and do not expose or persist its additional
  details.

- [ ] **Step 9: Extend the fake app-server for concurrent threads**

  Replace the fake's single hard-coded thread/turn IDs with maps. Add modes for
  mismatched thread safety fields, timeout, crash after accepted turn, duplicate
  completion, out-of-order unrelated-session notifications, and queued prompt
  shutdown. Preserve every existing telemetry fixture and probe test.

- [ ] **Step 10: Prove GREEN**

  Run:

  `node --test test/agents-codex-app-server.test.ts test/agents-codex.test.ts test/agents-codex-process.test.ts test/ui-command.test.ts`

  Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add src/agents/codex-app-server.ts src/agents/codex-provider.ts src/agents/codex.ts src/types.ts web/lib.js test/agents-codex-app-server.test.ts test/agents-codex.test.ts test/helpers/fake-app-server.ts test/ui-command.test.ts
git commit -m "feat: run opt-in Codex app-server turns"
```

---

### Task 4: Persist immutable transport ownership and route every session

**Files:**

- Modify: `src/accounts.ts`
- Modify: `src/types.ts`
- Modify: `src/sessions.ts`
- Modify: `src/server.ts`
- Modify: `src/account-limits.ts`
- Modify: `accounts.example.json`
- Modify: `test/accounts.test.ts`
- Modify: `test/sessions.test.ts`
- Modify: `test/server.test.ts`
- Modify: `test/account-limits.test.ts`

**Interfaces:**

- Consumes: `CodexTransport`, `CodexProviderPool.prepare()`, and the current
  server launch/resume flow.
- Produces:

```ts
export type Account = {
  name: string;
  provider: 'claude' | 'codex';
  budget: number;
  env: Record<string, string>;
  bin?: string;
  identity?: string;
  codexTransport?: CodexTransport;
};

export type Session = {
  // existing fields
  codexTransport?: CodexTransport;
  codexRuntimeVersion?: string;
};
```

- [ ] **Step 1: Write RED account-validation tests**

  Assert `loadAccounts()` accepts `codexTransport: 'sdk'` and
  `'app-server'` only on Codex entries, rejects unknown values, and rejects the
  field on Claude entries. An omitted Codex value resolves to `'sdk'` for new
  sessions during this rollout. Linked Codex accounts omit the field and
  therefore remain SDK-default.

- [ ] **Step 2: Write RED Registry migration and immutability tests**

  Cover:

  - newly created Codex sessions persist an explicit transport;
  - restored legacy Codex sessions with no field become `sdk`;
  - restored app-server sessions retain app-server and runtime version;
  - Claude sessions never gain Codex transport fields;
  - malformed stored transport remains stopped and non-resumable rather than
    being coerced to SDK;
  - transport cannot change after creation, especially after a vendor thread ID
    exists;
  - runtime version can be recorded once before vendor-thread assignment and is
    diagnostic only.

- [ ] **Step 3: Write RED server routing tests**

  Use an injected fake `CodexProviderPool` to prove:

  - create copies the resolved account transport into the session before
    provider preflight;
  - scheduled create uses the account transport at fire time and persists it;
  - send reuses the live handle and cannot alter transport;
  - resume uses the stored session transport even after account configuration
    changes;
  - an app-server preparation failure returns a stable error and never asks for
    an SDK adapter;
  - legacy SDK vendor IDs are passed only to the SDK adapter;
  - app-server vendor IDs are passed only to the app-server adapter;
  - deleting/stopping a session detaches its app-server route without closing
    the shared account process;
  - server close shuts the provider pool and limit coordinator exactly once.

- [ ] **Step 4: Run focused tests and verify RED**

  Run:

  `node --test test/accounts.test.ts test/sessions.test.ts test/server.test.ts test/account-limits.test.ts`

  Expected: FAIL on missing account/session fields and provider-pool routing.

- [ ] **Step 5: Validate account transport at the file boundary**

  Replace the unchecked `parsed as Account[]` return with per-entry validation
  for the new transport field while preserving the existing account-linking
  behavior. Error text may name the entry and invalid field but must not include
  environment values.

- [ ] **Step 6: Persist transport and runtime metadata safely**

  Extend `Registry.create()` to require an explicit transport for Codex and
  reject it for Claude. During load, distinguish a genuinely absent legacy
  field from an invalid present value. Preserve an invalid session record and
  mark it non-resumable with an actionable stopped reason; never silently route
  it through SDK.

  Add a Registry method that records `codexRuntimeVersion` only while the
  session has no vendor thread ID. Do not expose a transport mutation command.

- [ ] **Step 7: Route preparation through the shared provider pool**

  Change the server's provider-preparation seam to accept
  `{ sessionId, transport }`. Claude still returns `claudeAdapter`. Codex calls
  `codexPool.prepare(account, session.codexTransport, session.id)`, records the
  returned runtime version before launch, and never falls back across
  transports.

  Construct one pool at the application entry point and inject the same object
  into `createAccountLimitCoordinator()` and `createServer()`. Attach exactly
  one close owner to the HTTP server.

- [ ] **Step 8: Add rollout examples without a browser setting**

  Add one Codex account example with `"codexTransport": "app-server"` and
  explain that omission or `"sdk"` keeps the current default. Do not expose
  sandbox, approval policy, or transport as a general Settings command; the
  transport switch is an account-level rollout control for future sessions.

- [ ] **Step 9: Prove GREEN and persistence isolation**

  Run:

  `node --test test/accounts.test.ts test/sessions.test.ts test/server.test.ts test/account-limits.test.ts test/schedule.test.ts`

  Expected: PASS, including existing telemetry/reset scheduling and SDK resume
  tests.

- [ ] **Step 10: Commit**

```bash
git add src/accounts.ts src/types.ts src/sessions.ts src/server.ts src/account-limits.ts accounts.example.json test/accounts.test.ts test/sessions.test.ts test/server.test.ts test/account-limits.test.ts
git commit -m "feat: persist Codex transport ownership"
```

---

### Task 5: Add the guarded live transport gate and document rollout

**Files:**

- Create: `scripts/codex-app-server-transport-smoke.ts`
- Create: `test/codex-app-server-transport-smoke.test.ts`
- Modify: `scripts/codex-app-server-probe.ts`
- Modify: `test/app-server-probe.test.ts`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `docs/superpowers/reports/2026-08-01-codex-app-server-decision.md`

**Interfaces:**

- Consumes: `CodexProviderPool`, the production app-server adapter, and an
  explicitly selected configured Codex account.
- Produces:

```text
npm run smoke:codex-app-server-transport -- --account <account-name>
```

- [ ] **Step 1: Write RED fake smoke tests**

  Drive the production provider pool and adapter through the fake executable.
  Assert evidence for initialization, telemetry continuity, new thread, first
  turn, follow-up, clean process restart, resume, interrupt, multi-session
  routing, no replay, and clean shutdown.

  Evidence contains booleans, the pinned version, and opaque fixture IDs only.
  Assert serialized output excludes prompt text, account identity, environment
  secrets, stderr, absolute paths, item details, and raw protocol responses.

- [ ] **Step 2: Write RED paid-guard and account-selection tests**

  Real mode must refuse to start unless
  `SWITCHBOARD_ALLOW_PAID_CODEX_SMOKE=1` is present and `--account` names one
  configured Codex account. The guard is checked before provider startup,
  worktree creation, thread creation, or any turn request.

- [ ] **Step 3: Run the focused test and verify RED**

  Run:

  `node --test test/codex-app-server-transport-smoke.test.ts test/app-server-probe.test.ts`

  Expected: FAIL because the guarded transport smoke command does not exist.

- [ ] **Step 4: Implement deterministic and guarded real modes**

  Fake mode uses temporary local worktrees and the fake process. Real mode uses
  one temporary worktree and bounded prompts that request no file or tool use.
  It performs a first turn, follow-up, process restart, resume, and an interrupt
  case; it never intentionally reaches a usage limit or exercises approvals,
  questions, MCP, browser, or simulator features.

  Clean the temporary worktree in `finally`. Print only sanitized evidence and
  leave the compatibility report unchanged when any gate fails.

- [ ] **Step 5: Preserve the existing no-turn evaluator**

  Keep `npm run evaluate:codex-app-server` and
  `npm run evaluate:codex-telemetry` no-turn. Refactor shared schema/observer
  helpers only when doing so does not change their evidence or launch profile.
  The new paid command must be a separate package script.

- [ ] **Step 6: Document opt-in behavior and rollback**

  Update README and the decision report with:

  - the SDK default and account-level app-server opt-in;
  - immutable per-session ownership;
  - fixed workspace-write/never safety policy for this phase;
  - app-server start/follow-up/resume/interrupt support;
  - interaction, capability, MCP-sidecar, usage-recovery, and default-cutover
    deferrals;
  - rollback changing future sessions only;
  - the paid smoke guard and the fact that it consumes real Codex turns.

  Record the deterministic fake result. Record the real gate as `Not run` until
  the user separately authorizes and executes it; do not infer live parity from
  fake evidence.

- [ ] **Step 7: Add the package script**

```json
{
  "smoke:codex-app-server-transport": "node scripts/codex-app-server-transport-smoke.ts"
}
```

- [ ] **Step 8: Run the phase verification matrix**

  Run:

  `node --test test/codex-app-server-contract.test.ts test/codex-app-server-client.test.ts test/codex-app-server-supervisor.test.ts test/codex-provider.test.ts test/agents-codex-app-server.test.ts test/codex-app-server-transport-smoke.test.ts test/account-limits.test.ts test/server.test.ts test/sessions.test.ts`

  Expected: PASS.

  Run:

  `npm test`

  Expected: 0 failures.

  Run:

  `git diff --check`

  Expected: no output.

- [ ] **Step 9: Review the phase safety invariants**

  Inspect the final diff and prove:

  - one app-server child per Codex account;
  - SDK/app-server ownership never crosses;
  - no app-server turn is replayed after failure;
  - fixed worktree sandbox and never-approval policy are present on every
    app-server thread start/resume;
  - no absolute attachment path crosses Registry/SSE;
  - no account environment value or raw stderr enters public errors;
  - no automatic Codex usage recovery exists yet;
  - no real-account command is part of `npm test`.

- [ ] **Step 10: Commit**

```bash
git add scripts/codex-app-server-transport-smoke.ts scripts/codex-app-server-probe.ts package.json README.md docs/superpowers/reports/2026-08-01-codex-app-server-decision.md test/codex-app-server-transport-smoke.test.ts test/app-server-probe.test.ts
git commit -m "test: gate Codex app-server turns"
```

---

## Acceptance criteria

The phase is complete only when all of the following are true:

- Every Codex account has at most one supervised app-server child.
- Telemetry-only accounts retain the side-effect-free telemetry launch profile.
- The first app-server session promotes that account to a turn-capable profile
  without creating a second child or losing telemetry ownership.
- New sessions default to SDK unless their Codex account explicitly opts into
  app-server.
- Every Codex session persists immutable transport ownership; legacy sessions
  resume through SDK.
- App-server sessions start, accept FIFO follow-ups, resume, interrupt, and
  normalize current tool/plan/usage events through the existing Registry.
- App-server preflight, timeout, malformed protocol, and crash failures are
  sanitized, stable, and never fall back to SDK.
- Active or queued work is never replayed automatically after an app-server
  transport failure.
- Existing telemetry meters and fresh reset-boundary scheduling continue to
  work for SDK and app-server accounts.
- Interactive requests remain explicitly unsupported and cannot hang a child.
- The complete offline suite passes.
- The guarded real transport smoke remains separately authorized and its result
  is recorded without overstating unmeasured features.

## Follow-on plans after this phase

After this plan passes its offline and authorized live gate, revise and execute
these plans in order against the shared supervisor and persisted transport:

1. `2026-08-11-codex-interactions.md` — approvals, `needs-you`, structured
   questions, and MCP elicitation.
2. `2026-08-11-codex-capabilities-and-mcp.md` — skills/apps/MCP discovery and
   browser/simulator screenshot sidecars.
3. The recovery portion of `2026-08-11-codex-limits-and-cutover.md` — typed
   `usageLimitExceeded`, exact one-time reset requeue, full live matrix, soak,
   and the new-session default flip.
