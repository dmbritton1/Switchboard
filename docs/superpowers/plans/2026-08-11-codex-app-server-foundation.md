# Codex App-Server Foundation Implementation Plan

## Status update — 2026-09-09

Historical implementation proposal, superseded by the implemented telemetry
foundation and `2026-08-29-codex-app-server-turn-transport.md`. Do not execute
its original extraction/version-pin steps again. The runtime is now 0.153.4,
with one account-scoped supervisor and immutable per-session transport.
Start/resume/interrupt and live lifecycle checks are complete. App-server
approvals and structured questions extend that implementation; SDK is still
the default. See `2026-08-11-codex-interactions.md` for the current boundaries.
The remaining text preserves the original proposal, including historical pins.


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a production-quality, opt-in Codex app-server transport while preserving SDK ownership and resume behavior for every legacy Codex session.

**Architecture:** Pin Codex SDK/CLI 0.147.0, validate its generated protocol, extract the proven JSONL client into production code, and place one supervised app-server process behind each opted-in Codex account. Persist the chosen transport on every session and route all later work through that immutable choice.

**Tech Stack:** Node.js 22.18+, TypeScript executed directly by Node, `@openai/codex-sdk` 0.147.0, newline-delimited JSON-RPC over stdio, HTTP/SSE, node:test.

## Global Constraints

- Execute in an isolated worktree created with `superpowers:using-git-worktrees`; do not implement in the user's dirty primary checkout.
- Use Node 22.18 or newer.
- Pin `@openai/codex-sdk` to exactly `0.147.0`.
- Keep Codex sandbox fixed to `workspaceWrite`; do not add a sandbox setting.
- Do not expose approval policy in Switchboard settings.
- Never let SDK and app-server own the same vendor thread.
- Preserve target repository Codex configuration and instructions.
- Never persist, log, return over SSE, or render account environment values or raw child stderr.
- Keep `npm test` offline; real-account smoke checks remain opt-in.
- Run `npm test` before completing this plan.

---

## File structure

- Create `src/agents/codex-app-server-contract.ts`: pinned version and required-method checks.
- Create `src/agents/codex-app-server-client.ts`: generic stdio request/response transport.
- Create `src/agents/codex-app-server-supervisor.ts`: one initialized child per account and thread routing.
- Create `src/agents/codex-app-server.ts`: app-server `Adapter` implementation and event normalization.
- Create `src/agents/codex-provider.ts`: SDK/app-server selection and supervisor ownership.
- Create `test/codex-app-server-contract.test.ts`, `test/codex-app-server-client.test.ts`, `test/agents-codex-app-server.test.ts`.
- Modify `scripts/codex-app-server-probe.ts` to use the production client.
- Modify `test/helpers/fake-app-server.ts` to cover concurrent production sessions.
- Modify `src/types.ts`, `src/sessions.ts`, `src/server.ts`, `package.json`, `package-lock.json`, `accounts.example.json`, and `README.md`.

### Task 1: Pin and validate the app-server protocol

**Files:**
- Create: `src/agents/codex-app-server-contract.ts`
- Create: `test/codex-app-server-contract.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `test/helpers/fake-app-server.ts`

**Interfaces:**
- Produces: `CODEX_APP_SERVER_VERSION`, `REQUIRED_CLIENT_METHODS`, `REQUIRED_SERVER_METHODS`, `REQUIRED_NOTIFICATIONS`, and `verifyGeneratedContract(command, env)`.

- [ ] **Step 1: Write the contract test**

```ts
test('the pinned CLI exposes the production app-server contract', async () => {
  const result = await verifyGeneratedContract(fakeCommand, env());
  assert.equal(result.version, CODEX_APP_SERVER_VERSION);
  assert.deepEqual(result.missing, []);
  assert.equal(result.experimentalUserInput, true);
});
```

- [ ] **Step 2: Run the new test and verify RED**

Run: `node --test test/codex-app-server-contract.test.ts`

Expected: FAIL because `codex-app-server-contract.ts` does not exist.

- [ ] **Step 3: Pin the dependency**

Run: `npm install --save-exact @openai/codex-sdk@0.147.0`

Expected: `package.json` and `package-lock.json` both record `0.147.0`.

- [ ] **Step 4: Implement the required method sets**

```ts
export const CODEX_APP_SERVER_VERSION = '0.147.0';
export const REQUIRED_CLIENT_METHODS = [
  'initialize', 'account/read', 'account/rateLimits/read',
  'thread/start', 'thread/resume', 'turn/start', 'turn/interrupt',
  'thread/compact/start', 'skills/list', 'app/list', 'app/installed',
  'mcpServerStatus/list',
] as const;
export const REQUIRED_SERVER_METHODS = [
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'mcpServer/elicitation/request',
  'tool/requestUserInput',
] as const;
export const REQUIRED_NOTIFICATIONS = [
  'thread/started', 'turn/started', 'item/started', 'item/completed',
  'turn/plan/updated', 'turn/completed', 'serverRequest/resolved',
  'skills/changed', 'app/list/updated',
  'mcpServer/startupStatus/updated', 'account/updated',
  'account/rateLimits/updated',
] as const;
```

Implement `verifyGeneratedContract()` with `mkdtemp()`, `execFile(command,
['app-server', 'generate-ts', '--out', dir])`, recursive generated-file reads,
exact string membership checks, and `rm(dir, { recursive: true, force: true })`
in `finally`. Redact the thrown message through `redactValues()` before it can
reach a caller.

- [ ] **Step 5: Extend the fake generator**

Make `test/helpers/fake-app-server.ts` emit all arrays above and support
`FAKE_APP_SERVER_SCHEMA_OMIT=<method>` for one-method omission tests.

- [ ] **Step 6: Prove GREEN and omission failures**

Run: `node --test test/codex-app-server-contract.test.ts test/app-server-probe.test.ts`

Expected: PASS, including one subtest per omitted required method.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/agents/codex-app-server-contract.ts test/codex-app-server-contract.test.ts test/helpers/fake-app-server.ts
git commit -m "build: pin Codex app-server protocol"
```

### Task 2: Extract the production stdio client

**Files:**
- Create: `src/agents/codex-app-server-client.ts`
- Create: `test/codex-app-server-client.test.ts`
- Modify: `scripts/codex-app-server-probe.ts`
- Modify: `test/helpers/fake-app-server.ts`

**Interfaces:**
- Produces:

```ts
export type AppServerMessage = {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};
export type AppServerClientOptions = {
  command: string;
  args: string[];
  env: Record<string, string>;
  requestTimeoutMs?: number;
  onNotification(method: string, params: unknown): void;
  onServerRequest(request: Required<Pick<AppServerMessage, 'id' | 'method'>> & { params?: unknown }): void;
  onExit(error: Error): void;
};
export class AppServerClient {
  request<T>(method: string, params: unknown): Promise<T>;
  notify(method: string, params?: unknown): void;
  respond(id: string | number, result: unknown): void;
  respondError(id: string | number, code: number, message: string): void;
  close(): Promise<void>;
}
```

- [ ] **Step 1: Write framing and correlation tests**

Add tests for initialization, two out-of-order responses, interleaved
notifications, a server request whose numeric ID equals a client request ID,
and omission of the `jsonrpc` member.

- [ ] **Step 2: Write terminal-path tests**

Add tests for malformed JSON, unknown response ID, child exit, request timeout,
SIGTERM-to-SIGKILL escalation, idempotent `close()`, and absence of a known
stderr secret in every public error.

- [ ] **Step 3: Run the focused tests and verify RED**

Run: `node --test test/codex-app-server-client.test.ts`

Expected: FAIL because `AppServerClient` is not defined.

- [ ] **Step 4: Move the proven transport core into production**

Implement the interface above using `spawn(..., { stdio: ['pipe','pipe','pipe'] })`,
`readline.createInterface()`, a monotonically increasing client ID, separate
response and server-request paths, five-second default timeouts, bounded child
termination, and consumed/discarded stderr.

- [ ] **Step 5: Make every terminal path settle once**

Use one private `#fail(error)` that stores the terminal error, rejects and
clears all pending requests, invokes `onExit` once, and prevents later writes.
Server requests must never enter the pending client-response map.

- [ ] **Step 6: Replace the probe's private client**

Refactor `scripts/codex-app-server-probe.ts` to instantiate
`AppServerClient`. Keep its evidence object and no-turn real mode unchanged.

- [ ] **Step 7: Run focused and regression tests**

Run: `node --test test/codex-app-server-client.test.ts test/app-server-probe.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/agents/codex-app-server-client.ts scripts/codex-app-server-probe.ts test/codex-app-server-client.test.ts test/app-server-probe.test.ts test/helpers/fake-app-server.ts
git commit -m "feat: add Codex app-server client"
```

### Task 3: Add the account supervisor and app-server adapter

**Files:**
- Create: `src/agents/codex-app-server-supervisor.ts`
- Create: `src/agents/codex-app-server.ts`
- Create: `test/agents-codex-app-server.test.ts`
- Modify: `test/helpers/fake-app-server.ts`
- Modify: `src/types.ts`
- Modify: `web/lib.js`
- Modify: `test/ui-command.test.ts`

**Interfaces:**
- Produces:

```ts
export type AppServerSupervisorOptions = {
  runtime: PreparedCodexRuntime;
  onFatal(error: Error, sessionIds: string[]): void;
};
export class CodexAppServerSupervisor {
  initialize(): Promise<void>;
  adapter(sessionId: string): Adapter;
  shutdown(): Promise<void>;
}
```

- [ ] **Step 1: Write lifecycle normalization tests**

Drive fake `thread/started`, `turn/started`, item lifecycle, token usage, plan,
turn completion, failure, and interrupt events through a real stdio child.
Assert the same provider-neutral `AdapterEvent` shapes emitted by the SDK
adapter where the semantics overlap.

- [ ] **Step 2: Write multiplexing and crash tests**

Start two adapters through one supervisor, interleave their thread events, and
assert exact session routing. Crash the fake child and assert `onFatal` receives
both active session IDs once and no turn is replayed after restart.

- [ ] **Step 3: Run the focused tests and verify RED**

Run: `node --test test/agents-codex-app-server.test.ts`

Expected: FAIL because the supervisor and adapter do not exist.

- [ ] **Step 4: Implement initialization and routing**

Initialize with:

```ts
await client.request('initialize', {
  clientInfo: { name: 'switchboard', title: 'Switchboard', version: '0.1.0' },
  capabilities: null,
});
client.notify('initialized');
```

Maintain `threadId -> sessionId`, `sessionId -> emit`, and `sessionId -> active
turnId` maps. Ignore unknown notifications, but route every known lifecycle
notification only after validating its thread ID.

- [ ] **Step 5: Implement Adapter lifecycle**

`start()` sends `thread/start` or `thread/resume`, always with the session
worktree, `workspaceWrite`, fixed provider settings, and the supplied Codex
thread settings. It then sends `turn/start`. `send()` queues follow-ups FIFO,
`stop()` sends `turn/interrupt`, and `setAuto()` stores the current session flag
for the interaction plan.

- [ ] **Step 6: Normalize items and failures**

Map command, file, MCP, web search, reasoning, plan, agent message, error, and
usage events to current `AdapterEvent` shapes. Add failure codes
`codex_app_server_unavailable`, `codex_protocol_mismatch`,
`codex_app_server_initialization_failed`, `codex_transport_crashed`, and
`codex_request_timed_out` to `CodexFailureCode` and browser labels. Reuse the
existing `codex_auth_unavailable` and `codex_user_stopped` codes for the
authentication and user-interruption cases.

- [ ] **Step 7: Run focused tests**

Run: `node --test test/agents-codex-app-server.test.ts test/agents-codex.test.ts test/agents-codex-process.test.ts`

Expected: PASS for both transports.

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/agents/codex-app-server-supervisor.ts src/agents/codex-app-server.ts web/lib.js test/agents-codex-app-server.test.ts test/helpers/fake-app-server.ts test/ui-command.test.ts
git commit -m "feat: supervise Codex app-server sessions"
```

### Task 4: Persist immutable transport ownership and route the server

**Files:**
- Create: `src/agents/codex-provider.ts`
- Modify: `src/types.ts`
- Modify: `src/sessions.ts`
- Modify: `src/server.ts`
- Modify: `accounts.example.json`
- Test: `test/sessions.test.ts`
- Test: `test/server.test.ts`

**Interfaces:**
- Produces:

```ts
export type CodexTransport = 'sdk' | 'app-server';
export class CodexProviderPool {
  prepare(account: Account, transport: CodexTransport, sessionId: string): Promise<Adapter>;
  close(): Promise<void>;
}
```

- [ ] **Step 1: Write Registry migration tests**

Assert that new Codex sessions persist an explicit transport, restored legacy
Codex sessions without the field become `sdk`, Claude sessions never gain the
field, and attempts to change transport after `vendorSessionId` assignment are
rejected.

- [ ] **Step 2: Write server routing tests**

Use fake SDK and app-server providers to prove new sessions copy the account
transport, resume uses the session transport after account configuration
changes, and app-server preflight failure never creates an SDK-owned fallback.

- [ ] **Step 3: Run the tests and verify RED**

Run: `node --test test/sessions.test.ts test/server.test.ts`

Expected: FAIL on missing transport fields and provider routing.

- [ ] **Step 4: Add the persisted fields and migration**

Add `codexTransport?: CodexTransport` and `codexRuntimeVersion?: string` to
`Session`. Extend Registry `Init`, creation, restore coercion, and public
projection. Default only restored legacy Codex sessions to `sdk`.

- [ ] **Step 5: Add account rollout configuration**

Extend `Account` with `codexTransport?: CodexTransport`. Validate the value at
startup; use `sdk` when omitted during the initial rollout. Add both examples to
`accounts.example.json` without exposing a UI setting.

- [ ] **Step 6: Route through the provider pool**

Replace the standalone Codex `prepareProvider()` path with
`CodexProviderPool`. Pass the prospective session ID into app-server adapter
creation, persist transport before launch, and close all supervisors from the
HTTP server's `close` event.

- [ ] **Step 7: Run focused tests**

Run: `node --test test/sessions.test.ts test/server.test.ts test/codex-runtime.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/sessions.ts src/server.ts src/agents/codex-provider.ts accounts.example.json test/sessions.test.ts test/server.test.ts
git commit -m "feat: route Codex sessions by persisted transport"
```

### Task 5: Add opt-in live gates and document the foundation

**Files:**
- Create: `scripts/smoke-codex-app-server.ts`
- Create: `test/codex-app-server-smoke.test.ts`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `docs/superpowers/reports/2026-08-01-codex-app-server-decision.md`

**Interfaces:**
- Produces: `npm run smoke:codex-app-server -- --account <name>` and an updated transport decision record.

- [ ] **Step 1: Write fake smoke tests**

Cover initialize, account read, new thread, first turn, follow-up, supervisor
restart, resume, interrupt, and clean shutdown. Assert the script refuses real
mode unless `SWITCHBOARD_ALLOW_PAID_CODEX_SMOKE=1` is set.

- [ ] **Step 2: Run the smoke test and verify RED**

Run: `node --test test/codex-app-server-smoke.test.ts`

Expected: FAIL because the smoke script does not exist.

- [ ] **Step 3: Implement the smoke command**

Reuse `prepareCodexRuntime`, `verifyGeneratedContract`, and
`CodexAppServerSupervisor`. Print booleans and opaque runtime/thread IDs only;
do not print account data, prompts, stderr, or environment values.

- [ ] **Step 4: Add the package script**

```json
"smoke:codex-app-server": "node scripts/smoke-codex-app-server.ts"
```

- [ ] **Step 5: Update documentation**

Document account opt-in, immutable session ownership, rollback-for-new-sessions
only, the paid-smoke guard, and the fact that current production default remains
SDK at the end of this foundation plan.

- [ ] **Step 6: Run full verification**

Run: `npm test`

Expected: 0 failures.

Run: `git diff --check`

Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add scripts/smoke-codex-app-server.ts test/codex-app-server-smoke.test.ts package.json README.md docs/superpowers/reports/2026-08-01-codex-app-server-decision.md
git commit -m "test: gate Codex app-server rollout"
```
