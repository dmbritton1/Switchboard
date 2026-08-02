# Switchboard Codex Integration Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Switchboard's working Codex beta into a dependable, macOS-only local worker with deterministic runtime selection, pre-worktree readiness checks, durable prompt delivery state, actionable failures, visible browser command errors, and hermetic SDK-through-process tests.

**Architecture:** Keep `server.ts` as the owner of sessions and worktrees, keep the normalized provider `Adapter` boundary, and continue using `@openai/codex-sdk`. Add a Codex runtime resolver that produces a prepared runtime before worktree creation, refactor the Codex adapter into a runtime-bound factory, and persist prompt delivery transitions through the Registry. The browser uses one tested command helper and one explicit error-scope map so every command handles non-2xx responses.

**Tech Stack:** Node.js 22.18+ with native TypeScript execution, `node:test`, `@openai/codex-sdk` 0.145.0, the SDK-bundled Codex CLI, Node HTTP/SSE, browser ES modules, and git worktrees on macOS.

## Global Constraints

- Implement only Phase 1 from `docs/superpowers/specs/2026-08-01-codex-integration-design.md`. Do not add Phase 2 live item updates, detail payloads, structured image input, session model controls, or app-server transport.
- Keep `sandboxMode: 'workspace-write'` and `approvalPolicy: 'never'` as mandatory thread overrides. Never add a `danger-full-access` path or automatic permission escalation.
- Preserve the selected `CODEX_HOME`, user configuration, repository `.codex/config.toml`, `AGENTS.md`, skills, MCP configuration, model, reasoning effort, web-search mode, and repository network policy.
- Keep the implementation intentionally macOS-only. Return `codex_platform_unsupported` on other platforms.
- Normal `npm test` must remain hermetic: no OpenAI network calls, no paid model turns, and no reads or writes under the real `~/.codex`.
- Never persist account environment values or expose them in SSE, browser output, diagnostics, or public error text. Redact credential-shaped values before an error reaches the Registry.
- An explicit account `bin` is authoritative and fails closed. An invalid standard ChatGPT.app binary is diagnostic-only and falls back to the SDK-bundled CLI.
- Preflight failures must create neither a session nor a worktree. Failures after worktree creation must preserve the stopped session and worktree.
- Do not automatically replay a `sent` or `unsent` prompt.
- Keep changes backward-compatible with existing `state.json` files and existing accounts that omit `bin`.
- Preserve pre-existing unrelated worktree changes and untracked files; stage only the files named by the current task.

---

### Task 1: Add deterministic Codex runtime resolution and readiness checks

**Files:**
- Create: `src/agents/codex-runtime.ts`
- Create: `test/helpers/fake-codex.ts`
- Create: `test/codex-runtime.test.ts`
- Modify: `src/types.ts`
- Modify: `src/server.ts`

**Interfaces:**

Add the stable public failure vocabulary to `src/types.ts` so the runtime, adapter, server, Registry, and browser snapshot share one type without importing provider implementation code:

```ts
export type CodexFailureCode =
  | 'codex_platform_unsupported'
  | 'codex_binary_missing'
  | 'codex_binary_not_executable'
  | 'codex_version_unreadable'
  | 'codex_version_mismatch'
  | 'codex_auth_unavailable'
  | 'codex_start_failed'
  | 'codex_resume_failed'
  | 'codex_stream_failed'
  | 'codex_sandbox_denied'
  | 'codex_user_stopped';
```

Create these runtime contracts in `src/agents/codex-runtime.ts`:

```ts
export type CodexRuntimeSource = 'explicit' | 'chatgpt' | 'sdk';

export type PreparedCodexRuntime = {
  source: CodexRuntimeSource;
  commandPath: string;
  codexPathOverride?: string;
  version: string;
  env: Record<string, string>;
  diagnostics: string[];
};

export class CodexRuntimeError extends Error {
  constructor(
    readonly code: CodexFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'CodexRuntimeError';
  }
}

export type CodexRuntimeDeps = {
  platform?: NodeJS.Platform;
  chatgptPath?: string;
  bundledPath?: string;
  sdkVersion?: string;
  runFile?: (
    file: string,
    args: string[],
    options: { env: Record<string, string> },
  ) => Promise<{ stdout: string; stderr: string }>;
};

export async function prepareCodexRuntime(
  account: { bin?: string; env: Record<string, string> },
  deps?: CodexRuntimeDeps,
): Promise<PreparedCodexRuntime>;
```

The production defaults must resolve the installed SDK version from `@openai/codex-sdk/package.json`, resolve the bundled command from `@openai/codex/bin/codex.js`, and use `/Applications/ChatGPT.app/Contents/Resources/codex` as the standard app candidate. `commandPath` is always the executable used for `--version` and `login status`; `codexPathOverride` is omitted only for the SDK fallback so the SDK retains ownership of its bundled executable selection.

- [ ] **Step 1: Write the fake executable helper and failing resolver tests**

Create `test/helpers/fake-codex.ts` with a helper that writes a standalone executable into a test-owned temporary directory. It must never inspect the user's Codex configuration:

```ts
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function writeFakeCodex(
  dir: string,
  options: {
    version?: string;
    login?: 'ready' | 'logged-out' | 'unsupported';
  } = {},
): Promise<string> {
  const path = join(dir, 'fake-codex');
  const version = options.version ?? '0.145.0';
  const login = options.login ?? 'ready';
  const source = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('codex-cli ${version}\\n');
  process.exit(0);
}
if (args[0] === 'login' && args[1] === 'status') {
  const mode = ${JSON.stringify(login)};
  if (mode === 'ready') {
    process.stdout.write('Logged in using ChatGPT\\n');
    process.exit(0);
  }
  if (mode === 'unsupported') {
    process.stderr.write('error: unrecognized subcommand status\\n');
    process.exit(2);
  }
  process.stderr.write('Not logged in\\n');
  process.exit(1);
}
process.stderr.write('unexpected invocation: ' + args.join(' ') + '\\n');
process.exit(2);
`;
  await writeFile(path, source);
  await chmod(path, 0o755);
  return path;
}
```

Create `test/codex-runtime.test.ts`. Cover all required branches with separate tests:

```ts
test('an explicit compatible executable is authoritative', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'switchboard-codex-runtime-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = await writeFakeCodex(dir);

  const runtime = await prepareCodexRuntime(
    { bin, env: { CODEX_HOME: join(dir, 'codex-home') } },
    { platform: 'darwin', sdkVersion: '0.145.0' },
  );

  assert.equal(runtime.source, 'explicit');
  assert.equal(runtime.codexPathOverride, bin);
  assert.equal(runtime.version, '0.145.0');
  assert.equal(runtime.env.CODEX_HOME, join(dir, 'codex-home'));
});

test('an explicit version mismatch fails closed', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'switchboard-codex-runtime-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = await writeFakeCodex(dir, { version: '0.146.0' });

  await assert.rejects(
    prepareCodexRuntime({ bin, env: {} }, { platform: 'darwin', sdkVersion: '0.145.0' }),
    (error: unknown) =>
      error instanceof CodexRuntimeError && error.code === 'codex_version_mismatch',
  );
});

test('an incompatible ChatGPT.app candidate falls back to the SDK CLI', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'switchboard-codex-runtime-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const appDir = join(dir, 'app');
  await mkdir(appDir);
  const chatgptPath = await writeFakeCodex(appDir, { version: '0.146.0' });
  const bundledDir = join(dir, 'bundled');
  await mkdir(bundledDir);
  const bundledPath = await writeFakeCodex(bundledDir);

  const runtime = await prepareCodexRuntime(
    { env: {} },
    { platform: 'darwin', sdkVersion: '0.145.0', chatgptPath, bundledPath },
  );

  assert.equal(runtime.source, 'sdk');
  assert.equal(runtime.codexPathOverride, undefined);
  assert.match(runtime.diagnostics.join('\n'), /ChatGPT.*0\.146\.0.*0\.145\.0/);
});
```

Also add cases for: non-darwin platform, missing explicit path, explicit directory, non-executable explicit file, unreadable version, semver build metadata compatibility, logged-out authentication, unsupported `login status` deferral, compatible ChatGPT.app selection, SDK fallback selection, an invalid account environment shape, and proof that `login status` receives the same merged environment returned in `PreparedCodexRuntime`.

- [ ] **Step 2: Run the resolver tests and confirm the expected failure**

Run:

```bash
node --test test/codex-runtime.test.ts
```

Expected: FAIL because `src/agents/codex-runtime.ts`, `CodexRuntimeError`, and `prepareCodexRuntime` do not exist.

- [ ] **Step 3: Implement version comparison, candidate validation, authentication preflight, and redaction**

Implement strict candidate validation in `src/agents/codex-runtime.ts`:

```ts
const VERSION = /\bcodex(?:-cli)?\s+v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/i;
const CREDENTIAL_KEY = /(token|key|secret|password|authorization|credential)/i;

function publishedVersion(version: string): string {
  return version.split('+', 1)[0];
}

function parseVersion(output: string): string | null {
  return output.match(VERSION)?.[1] ?? null;
}

export function redactCodexText(text: string, env: Record<string, string>): string {
  let safe = text.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
  for (const [key, value] of Object.entries(env)) {
    if (value && CREDENTIAL_KEY.test(key)) safe = safe.replaceAll(value, '[REDACTED]');
  }
  return safe;
}
```

Use `lstat()` to distinguish a missing path, directory, and regular file. Require at least one execute bit for explicit and ChatGPT candidates. Run `--version` with `{ ...process.env, ...account.env }`, parse its combined safe output, and compare `publishedVersion(cliVersion)` to `publishedVersion(sdkVersion)`.

Build the launch environment without casting `undefined` values into `Record<string, string>`:

```ts
const env = Object.fromEntries(
  Object.entries({ ...process.env, ...account.env })
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
);
```

For `login status`, handle outcomes as follows:

```ts
const unsupported = /unrecognized subcommand|unknown subcommand|unexpected argument.*status/i;
const loggedOut = /not logged in|login required|authentication required|unauthorized/i;
```

- exit 0: ready;
- a recognized unsupported-subcommand response: append a safe diagnostic and allow startup;
- a recognized logged-out response: throw `codex_auth_unavailable`;
- any other nonzero result: throw `codex_auth_unavailable` with a safe login remediation.

Validate untrusted account JSON before spreading it: `env` must be a non-null, non-array object whose values are strings, and `bin`, when present, must be a nonempty string. Report invalid shape as `codex_start_failed`; never print the invalid value or object.

Public messages must name only the candidate path/version needed for remediation. Do not include the full environment, complete subprocess output, or stack trace.

Add `bin?: string` to `Account` in `src/server.ts`. Do not include `bin` in `snapshot().accounts`; it is launch configuration, not browser state.

- [ ] **Step 4: Run focused and full tests**

Run:

```bash
node --test test/codex-runtime.test.ts
npm test
```

Expected: all resolver cases pass and the existing suite remains green.

- [ ] **Step 5: Commit the runtime resolver**

```bash
git add src/agents/codex-runtime.ts src/types.ts src/server.ts test/helpers/fake-codex.ts test/codex-runtime.test.ts
git commit -m "feat: validate Codex runtime readiness"
```

---

### Task 2: Refactor the Codex adapter into a prepared-runtime factory

**Files:**
- Modify: `src/agents/codex.ts`
- Modify: `src/types.ts`
- Modify: `test/agents-codex.test.ts`
- Modify: `test/helpers/fake-codex.ts`
- Create: `test/agents-codex-process.test.ts`

**Interfaces:**

Replace the singleton `codexAdapter` with a factory whose environment and executable have already passed preflight:

```ts
export function createCodexAdapter(runtime: PreparedCodexRuntime): Adapter;
```

For this task's intermediate commit only, keep `codexAdapter` as a compatibility export created from the existing ChatGPT.app runtime so `src/server.ts` and its tests remain importable. Mark it `@deprecated` in its doc comment, add no new call sites, and remove the export and hardcoded path in Task 3 when the server begins preparing runtimes. The finished Phase 1 tree must contain no hardcoded adapter singleton.

Extend terminal adapter events without changing Claude behavior:

```ts
export type AdapterEvent =
  | { type: 'status'; status: Status }
  | { type: 'msg'; msg: Msg }
  | { type: 'approval'; request: ApprovalRequest }
  | { type: 'approval-resolved' }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'vendor-session-id'; id: string }
  | { type: 'tool-result'; id: string; ok: boolean }
  | { type: 'stopped'; reason: string; code?: CodexFailureCode };
```

- [ ] **Step 1: Make unknown events and stable failures fail the current tests**

Append these tests to `test/agents-codex.test.ts`:

```ts
test('an unknown future event is ignored', () => {
  assert.deepEqual(
    normalizeCodex({ type: 'future.event', payload: { value: 1 } } as never),
    [],
  );
});

test('turn.failed is assigned a stable stream failure code', () => {
  assert.deepEqual(
    normalizeCodex({ type: 'turn.failed', error: { message: 'nope' } } as never),
    [{ type: 'stopped', reason: 'nope', code: 'codex_stream_failed' }],
  );
});
```

Add a development-diagnostic test that temporarily sets `NODE_ENV=development`, captures `console.warn`, and proves the diagnostic contains only the unknown event type, not its payload. Restore both global values in `t.after()`.

Expected: the unknown event returns `undefined`, and the current terminal event has no code.

- [ ] **Step 2: Extend the fake CLI for real SDK process behavior**

Expand `writeFakeCodex()` so the generated executable supports the exact SDK transport:

- parse `exec --experimental-json`, `--cd`, `--sandbox`, `-c`, and optional `resume <thread-id>` arguments;
- read the prompt from stdin;
- append one JSON object per invocation to the path in `FAKE_CODEX_LOG`;
- emit valid JSONL events for `thread.started`, `turn.started`, completed text/shell/edit/MCP/search items, and `turn.completed`;
- on prompt `fail-stream`, emit a `turn.failed` event;
- on prompt `sandbox-denied`, emit a failed command item followed by `turn.failed` with `Operation not permitted by sandbox`;
- on prompt `unknown-event`, emit an unknown event between `turn.started` and `turn.completed`;
- on prompt `hold`, emit `turn.started` and remain alive until the SDK abort signal terminates the process.

The invocation log entry must use this shape so assertions do not depend on implementation prose:

```ts
type FakeInvocation = {
  argv: string[];
  prompt: string;
  cwd: string;
  codexHome: string | null;
};
```

Use only paths under each test's temporary directory for `FAKE_CODEX_LOG` and `CODEX_HOME`.

- [ ] **Step 3: Write failing SDK-through-process adapter tests**

Create `test/agents-codex-process.test.ts` with a `collect()` helper that starts `createCodexAdapter(runtime)`, records normalized events, and resolves when a predicate is satisfied. Test the actual installed SDK boundary, not a mocked `Codex` class.

Representative start test:

```ts
test('the prepared adapter starts through the real SDK with mandatory safety options', async (t) => {
  const fixture = await makeProcessFixture(t);
  const events: AdapterEvent[] = [];
  const adapter = createCodexAdapter(fixture.runtime);

  adapter.start(
    { cwd: fixture.cwd, prompt: 'basic', env: {} },
    (event) => events.push(event),
  );
  await waitFor(() => events.some((event) => event.type === 'status' && event.status === 'done'));

  const invocations = await fixture.readInvocations();
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].prompt, 'basic');
  assert.ok(invocations[0].argv.includes('--experimental-json'));
  assert.ok(invocations[0].argv.includes('workspace-write'));
  assert.ok(invocations[0].argv.includes('approval_policy="never"'));
  assert.equal(invocations[0].cwd, fixture.cwd);
  assert.equal(invocations[0].codexHome, fixture.codexHome);
  assert.ok(events.some((event) => event.type === 'vendor-session-id' && event.id === 'fake-thread'));
});
```

Add separate tests for:

- `resumeId` producing `resume fake-thread` in CLI arguments;
- text, shell, edit, MCP, and search normalization through JSONL;
- usage emission;
- FIFO follow-up execution;
- unknown future events not interrupting completion;
- malformed JSONL producing `codex_stream_failed` without an unhandled rejection;
- unexpected nonzero process exit producing `codex_stream_failed` with a sanitized reason;
- stream failure producing `codex_stream_failed`;
- sandbox denial producing a failed tool plus `codex_sandbox_denied`;
- `stop()` aborting `hold` exactly once and preserving `codex_user_stopped` rather than an abort error.

- [ ] **Step 4: Run focused tests and confirm the expected failure**

Run:

```bash
node --test test/agents-codex.test.ts test/agents-codex-process.test.ts
```

Expected: FAIL because `createCodexAdapter` does not exist and unknown events are not safely ignored.

- [ ] **Step 5: Implement the runtime-bound adapter and one terminal path**

Construct the SDK client only from the prepared runtime:

```ts
const codex = new Codex({
  ...(runtime.codexPathOverride
    ? { codexPathOverride: runtime.codexPathOverride }
    : {}),
  env: runtime.env,
});
```

Keep the thread options exact:

```ts
const threadOptions = {
  workingDirectory: opts.cwd,
  sandboxMode: 'workspace-write' as const,
  approvalPolicy: 'never' as const,
};
```

Add a default branch to `normalizeCodex()`:

```ts
default:
  if (process.env.NODE_ENV === 'development') {
    console.warn(`[codex] ignored event type: ${String((e as { type?: unknown }).type)}`);
  }
  return [];
```

Classify only public terminal errors, after redaction:

```ts
export function classifyCodexFailure(
  reason: string,
  fallback: 'codex_start_failed' | 'codex_resume_failed' | 'codex_stream_failed',
): CodexFailureCode {
  if (/not logged in|authentication|unauthorized|\b401\b/i.test(reason)) {
    return 'codex_auth_unavailable';
  }
  if (/sandbox|permission denied|operation not permitted|read-only file system/i.test(reason)) {
    return 'codex_sandbox_denied';
  }
  return fallback;
}
```

All terminal routes must pass through one idempotent `finish(reason, code)` function. Set the stopped flag before aborting or emitting, abort only once, and emit exactly one terminal event. Use `codex_start_failed` for failure before the first `turn.started`, `codex_resume_failed` for a resume failure before the first `turn.started`, and `codex_stream_failed` after a turn has started. A normalized `turn.failed` must call `finish()` instead of being emitted directly so process errors, SDK errors, and JSONL terminal events share the same semantics.

Keep Phase 1 completed-item-only behavior. Do not retain raw command output or MCP payloads.

Assert the fake CLI argument log contains no Switchboard-injected model, reasoning-effort, web-search, MCP, network, or repository-instruction override. The only configuration argument Switchboard adds in Phase 1 is `approval_policy="never"`; the SDK's `--sandbox workspace-write` and `--cd` arguments are the other mandatory boundaries.

- [ ] **Step 6: Run focused and full tests**

Run:

```bash
node --test test/agents-codex.test.ts test/agents-codex-process.test.ts
npm test
```

Expected: the adapter uses the fake process through the real SDK, every lifecycle test passes, and no existing Claude test changes behavior.

- [ ] **Step 7: Commit the adapter factory**

```bash
git add src/agents/codex.ts src/types.ts test/agents-codex.test.ts test/agents-codex-process.test.ts test/helpers/fake-codex.ts
git commit -m "refactor: bind Codex adapter to prepared runtime"
```

---

### Task 3: Put Codex preflight ahead of worktree creation and harden resume

**Files:**
- Modify: `src/server.ts`
- Modify: `src/agents/codex.ts`
- Modify: `src/sessions.ts`
- Modify: `src/types.ts`
- Modify: `test/server.test.ts`
- Modify: `test/sessions.test.ts`

**Interfaces:**

Add a provider preparation seam inside `src/server.ts`:

```ts
type PreparedProvider = {
  adapter: Adapter;
};

async function prepareProvider(account: Account): Promise<PreparedProvider> {
  if (account.provider === 'claude') return { adapter: claudeAdapter };
  const runtime = await prepareCodexRuntime({ bin: account.bin, env: account.env });
  return { adapter: createCodexAdapter(runtime) };
}
```

Change `launch()` to accept the already-prepared `Adapter`. It must return a normalized error if `adapter.start()` throws synchronously and must retain the existing handle-map terminal cleanup behavior.

Add persisted failure identity:

```ts
stoppedReason: string | null;
stoppedCode: CodexFailureCode | null;
```

Place both fields together in the existing `Session` type in `src/types.ts`.

Add a Registry method for a failed resume, because a stopped session's ordinary `apply()` guard intentionally rejects new events:

```ts
recordStoppedFailure(id: string, reason: string, code: CodexFailureCode): void;
```

This method keeps status `stopped`, updates `stoppedReason` and `stoppedCode`, appends one safe `{ kind: 'error' }` transcript message, advances `statusSince`, and notifies subscribers.

- [ ] **Step 1: Write failing server tests for ordering and error contracts**

In `test/server.test.ts`, add a helper that creates a temporary git repository and captures `git worktree list --porcelain`. Add these cases:

```ts
test('Codex preflight failure creates neither a session nor a worktree', async (t) => {
  const fixture = await bootCodex(t, { bin: join(tmpdir(), 'definitely-missing-codex') });
  const before = await fixture.worktrees();

  const response = await fixture.command({
    cmd: 'create', account: 'codex', repo: fixture.repo,
    branch: 'codex-preflight-failure', prompt: 'hello',
  });

  assert.equal(response.status, 400);
  assert.equal(response.data.code, 'codex_binary_missing');
  assert.deepEqual(fixture.registry.all(), []);
  assert.deepEqual(await fixture.worktrees(), before);
});

test('a failed Codex resume remains stopped and exposes a stable code', async (t) => {
  const fixture = await bootCodex(t);
  const created = await fixture.create('first');
  await fixture.waitForSession(created.id, (session) => session.status === 'done');
  await fixture.command({ cmd: 'stop', id: created.id });
  await chmod(fixture.bin, 0o644);

  const response = await fixture.command({ cmd: 'resume', id: created.id, prompt: 'continue' });

  assert.equal(response.status, 400);
  assert.equal(response.data.code, 'codex_binary_not_executable');
  assert.equal(fixture.registry.get(created.id)!.status, 'stopped');
  assert.equal(fixture.registry.get(created.id)!.stoppedCode, 'codex_binary_not_executable');
});
```

Also test:

- successful create with the fake executable returns a session and reaches `done`;
- first-turn launch failure preserves the created worktree and stopped session;
- missing worktree rejects resume before Registry revival;
- successful resume prepares the runtime again and reuses `vendorSessionId`;
- account `env` reaches the fake process but never appears in `/events` JSON;
- public error text redacts a credential value echoed by the fake process.
- a repository containing `AGENTS.md` and `.codex/config.toml` has byte-identical source files after preflight and a fake turn, and the CLI arguments contain no overrides for their non-safety settings.

- [ ] **Step 2: Add failing Registry tests for stopped codes and failed resume**

Append to `test/sessions.test.ts`:

```ts
test('a stopped event persists its stable code', () => {
  const { reg, id } = make();
  reg.apply(id, {
    type: 'stopped', reason: 'sandbox refused the command', code: 'codex_sandbox_denied',
  });
  assert.equal(reg.get(id)!.stoppedCode, 'codex_sandbox_denied');
});

test('recordStoppedFailure updates a terminal session without reviving it', () => {
  const { reg, id } = make();
  reg.apply(id, { type: 'stopped', reason: 'first failure' });
  reg.recordStoppedFailure(id, 'Codex login is unavailable', 'codex_auth_unavailable');

  const session = reg.get(id)!;
  assert.equal(session.status, 'stopped');
  assert.equal(session.stoppedCode, 'codex_auth_unavailable');
  assert.deepEqual(session.transcript.at(-1), {
    kind: 'error', text: 'Codex login is unavailable',
  });
});
```

- [ ] **Step 3: Run focused tests and confirm the expected failure**

Run:

```bash
node --test test/server.test.ts test/sessions.test.ts
```

Expected: FAIL because create still creates the worktree before Codex validation, and stopped sessions have no stable code or failed-resume update method.

- [ ] **Step 4: Implement prepare-before-mutate create and resume flows**

For create, preserve this order exactly:

```ts
const prepared = await prepareProvider(account);
const cwd = await createWorktree(String(body.repo), String(body.branch));
const session = registry.create({
  provider: account.provider,
  account: account.name,
  repo: String(body.repo),
  cwd,
  branch: String(body.branch),
  title: String(body.branch),
});
const launchError = launch(session.id, account, prepared.adapter, cwd, String(body.prompt));
```

Catch `CodexRuntimeError` around `prepareProvider()` and return:

```ts
{ status: 400, json: { error: error.message, code: error.code } }
```

For resume, validate the stopped session and worktree first, then call `prepareProvider()`, and only call `registry.revive()` after preparation succeeds. On a Codex readiness failure, call `recordStoppedFailure()` and return the same `{ error, code }` shape.

If `adapter.start()` throws after the worktree/session exists, call `registry.apply()` with `codex_start_failed` or `codex_resume_failed`, leave the worktree intact, and return a non-2xx response. Never remove a worktree as launch-failure cleanup.

Delete the deprecated `codexAdapter` compatibility export and the hardcoded ChatGPT.app constant from `src/agents/codex.ts`. `src/server.ts` must import only `createCodexAdapter` and `prepareCodexRuntime` for Codex launches.

Initialize `stoppedCode: null` in `Registry.create()`, clear it in `revive()`, persist it in ordinary saves, and default it to `null` when loading legacy state.

- [ ] **Step 5: Run focused and full tests**

Run:

```bash
node --test test/server.test.ts test/sessions.test.ts
npm test
```

Expected: readiness failures occur before worktree mutation, resume failures stay visible on stopped sessions, and the full suite passes offline.

- [ ] **Step 6: Commit server readiness integration**

```bash
git add src/server.ts src/agents/codex.ts src/sessions.ts src/types.ts test/server.test.ts test/sessions.test.ts
git commit -m "feat: preflight Codex before session launch"
```

---

### Task 4: Persist queued, sent, and unsent prompt delivery

**Files:**
- Modify: `src/types.ts`
- Modify: `src/sessions.ts`
- Modify: `src/server.ts`
- Modify: `src/agents/codex.ts`
- Modify: `test/sessions.test.ts`
- Modify: `test/server.test.ts`
- Modify: `test/agents-codex-process.test.ts`

**Interfaces:**

Normalize every newly accepted user prompt into this shape:

```ts
export type PromptDelivery = 'queued' | 'sent' | 'unsent';

export type Msg =
  | { kind: 'user'; id: string; text: string; delivery: PromptDelivery }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; summary: string; status: 'running' | 'ok' | 'error'; id?: string }
  | { kind: 'error'; text: string };
```

Extend the adapter contracts:

```ts
export type AdapterEvent =
  | { type: 'status'; status: Status }
  | { type: 'msg'; msg: Msg }
  | { type: 'approval'; request: ApprovalRequest }
  | { type: 'approval-resolved' }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'vendor-session-id'; id: string }
  | { type: 'tool-result'; id: string; ok: boolean }
  | { type: 'prompt-delivery'; id: string; delivery: 'sent' | 'unsent' }
  | { type: 'stopped'; reason: string; code?: CodexFailureCode };

export type StartOpts = {
  cwd: string;
  prompt: string;
  promptId?: string;
  env: Record<string, string>;
  resumeId?: string;
  auto?: boolean;
};

export type AgentHandle = {
  send(text: string, promptId?: string): void;
  decide(allow: boolean): void;
  setAuto(on: boolean): void;
  stop(): void;
};
```

Add Registry-owned prompt methods:

```ts
appendPrompt(id: string, text: string, delivery: PromptDelivery): string;
```

`appendPrompt()` generates the UUID, appends the user message, notifies subscribers, and returns the prompt ID. `apply({ type: 'prompt-delivery' })` finds that ID and changes only its delivery state.

- [ ] **Step 1: Write failing Registry migration and delivery tests**

Add to `test/sessions.test.ts`:

```ts
test('prompt delivery moves queued to sent by stable id', () => {
  const { reg, id } = make();
  const promptId = reg.appendPrompt(id, 'run the tests', 'queued');
  reg.apply(id, { type: 'prompt-delivery', id: promptId, delivery: 'sent' });

  assert.deepEqual(reg.get(id)!.transcript.at(-1), {
    kind: 'user', id: promptId, text: 'run the tests', delivery: 'sent',
  });
});

test('load migrates legacy and interrupted prompts without replaying them', async (t) => {
  const path = await writePromptMigrationState(t, [
    { kind: 'user', text: 'legacy' },
    { kind: 'user', id: 'queued-1', text: 'interrupted', delivery: 'queued' },
  ]);

  const loaded = (await Registry.load(path)).all()[0];
  const legacy = loaded.transcript[0];
  assert.equal(legacy.kind, 'user');
  assert.ok(legacy.kind === 'user');
  assert.equal(legacy.delivery, 'sent');
  assert.deepEqual(loaded.transcript[1], {
    kind: 'user', id: 'queued-1', text: 'interrupted', delivery: 'unsent',
  });
  assert.match((loaded.transcript.at(-1) as { text: string }).text, /1 queued prompt was not sent/);
});
```

Also test: unknown prompt IDs are ignored, multiple queued prompts are all converted on restart, the visible error has correct singular/plural count, and ordinary sent prompts remain sent.

- [ ] **Step 2: Write failing process and server queue tests**

In `test/agents-codex-process.test.ts`, hold the first prompt, enqueue two follow-ups, then stop. Assert adapter events occur in this order:

```ts
[
  { type: 'prompt-delivery', id: 'initial', delivery: 'sent' },
  { type: 'prompt-delivery', id: 'follow-1', delivery: 'unsent' },
  { type: 'prompt-delivery', id: 'follow-2', delivery: 'unsent' },
  { type: 'msg', msg: { kind: 'error', text: '2 queued prompts were not sent. Resend them manually if still needed.' } },
  { type: 'stopped', reason: 'Stopped by user.', code: 'codex_user_stopped' },
]
```

Filter unrelated `status` events before comparing, but do not reorder the delivery, visible error, and terminal events.

In `test/server.test.ts`, assert:

- Codex create appends its initial prompt as queued before returning HTTP 200;
- the adapter changes it to sent before the fake process invocation;
- a follow-up is persisted as queued before the `/command` response resolves;
- FIFO follow-ups become sent in order;
- stopping or failing an active turn retains queued follow-ups as unsent;
- unsent prompts do not appear in the fake invocation log after resume;
- Claude follow-ups continue to appear as delivered user transcript messages.

- [ ] **Step 3: Run focused tests and confirm the expected failure**

Run:

```bash
node --test test/sessions.test.ts test/agents-codex-process.test.ts test/server.test.ts
```

Expected: FAIL because prompts have no IDs/delivery state and the adapter currently discards its FIFO on failure or stop.

- [ ] **Step 4: Implement Registry prompt persistence and migration**

For every loaded user message, normalize legacy fields. Generate an ID only when absent, default absent delivery to `sent`, and turn persisted `queued` into `unsent`. Count only converted queued messages and append one error message after the migrated transcript:

```ts
let interruptedCount = 0;
const transcript = s.transcript.map((message) => {
  if (message.kind !== 'user') return message;
  const wasQueued = message.delivery === 'queued';
  if (wasQueued) interruptedCount++;
  return {
    kind: 'user' as const,
    id: message.id ?? randomUUID(),
    text: message.text,
    delivery: wasQueued ? 'unsent' as const : message.delivery ?? 'sent' as const,
  };
});
if (interruptedCount > 0) {
  transcript.push({ kind: 'error', text: unsentMessage(interruptedCount) });
}
```

Use exact visible wording:

```ts
function unsentMessage(count: number): string {
  const noun = count === 1 ? 'prompt was' : 'prompts were';
  return `${count} queued ${noun} not sent. Resend ${count === 1 ? 'it' : 'them'} manually if still needed.`;
}
```

Do not eagerly save during `Registry.load()`; the next normal state save writes the normalized shape.

- [ ] **Step 5: Implement queue ownership across server and adapter**

The server owns transcript acceptance:

```ts
const delivery = session.provider === 'codex' ? 'queued' : 'sent';
const promptId = registry.appendPrompt(session.id, String(body.text), delivery);
handle.send(String(body.text), promptId);
```

For Codex create/resume, call `appendPrompt(..., 'queued')` before `launch()` and pass the returned `promptId` in `StartOpts`. If launch fails synchronously, mark that prompt `unsent` before the terminal event. Claude create keeps its existing initial-transcript behavior; Claude follow-ups use the normalized delivered user-message shape.

Inside the Codex adapter, store FIFO entries as `{ text, promptId }`. Immediately before `thread.runStreamed()`, emit `sent` for that entry. The single `finish()` path must:

1. set terminal state;
2. remove entries still in the FIFO;
3. emit `unsent` for each remaining prompt ID in FIFO order;
4. emit one visible `Msg.error` with the count when nonzero;
5. abort the active process if needed;
6. emit one coded terminal event.

The active prompt remains `sent` even when its turn fails or is aborted. Resume enqueues only the explicit resume prompt; it never scans or replays transcript messages.

- [ ] **Step 6: Run focused and full tests**

Run:

```bash
node --test test/sessions.test.ts test/agents-codex-process.test.ts test/server.test.ts
npm test
```

Expected: all prompt transitions are durable and ordered, interrupted prompts remain visible as unsent, and normal tests remain fully offline.

- [ ] **Step 7: Commit durable prompt delivery**

```bash
git add src/types.ts src/sessions.ts src/server.ts src/agents/codex.ts test/sessions.test.ts test/server.test.ts test/agents-codex-process.test.ts
git commit -m "feat: persist Codex prompt delivery state"
```

---

### Task 5: Surface every browser command failure and render prompt delivery

**Files:**
- Create: `web/lib.js`
- Create: `test/ui-command.test.ts`
- Modify: `web/app.js`
- Modify: `web/index.html`
- Modify: `web/style.css`
- Modify: `src/server.ts`

**Interfaces:**

Create a side-effect-free browser module that Node tests can import:

```js
export const COMMAND_ERROR_SCOPE = Object.freeze({
  create: 'new-session',
  send: 'session',
  resume: 'session',
  stop: 'session',
  auto: 'session',
  decide: 'session',
  merge: 'selection',
  push: 'selection',
  delete: 'session',
});

export const CODEX_FAILURE_LABEL = Object.freeze({
  codex_platform_unsupported: 'Unsupported platform',
  codex_binary_missing: 'Codex executable missing',
  codex_binary_not_executable: 'Codex executable is not runnable',
  codex_version_unreadable: 'Codex version unavailable',
  codex_version_mismatch: 'Codex version mismatch',
  codex_auth_unavailable: 'Codex login unavailable',
  codex_start_failed: 'Codex failed to start',
  codex_resume_failed: 'Codex failed to resume',
  codex_stream_failed: 'Codex stream failed',
  codex_sandbox_denied: 'Blocked by worktree sandbox',
  codex_user_stopped: 'Stopped by you',
});

export async function postCommand(body, fetchImpl = fetch) {
  try {
    const response = await fetchImpl('/command', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    return { ok: response.ok, status: response.status, data };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: { error: `Switchboard request failed: ${error instanceof Error ? error.message : String(error)}` },
    };
  }
}

export function commandFailure(result) {
  if (result.ok) return '';
  return String(result.data?.error ?? `Command failed with HTTP ${result.status}`);
}

export function routedCommandFailure(cmd, result) {
  const message = commandFailure(result);
  if (!message) return null;
  return { scope: COMMAND_ERROR_SCOPE[cmd] ?? 'session', message };
}
```

- [ ] **Step 1: Write failing command-helper tests**

Create `test/ui-command.test.ts`:

```ts
test('every browser command has an explicit error scope', () => {
  assert.deepEqual(Object.keys(COMMAND_ERROR_SCOPE).sort(), [
    'auto', 'create', 'decide', 'delete', 'merge',
    'push', 'resume', 'send', 'stop',
  ]);
});

test('every stable Codex failure has a user-facing label', () => {
  assert.deepEqual(Object.keys(CODEX_FAILURE_LABEL).sort(), [
    'codex_auth_unavailable', 'codex_binary_missing',
    'codex_binary_not_executable', 'codex_platform_unsupported',
    'codex_resume_failed', 'codex_sandbox_denied', 'codex_start_failed',
    'codex_stream_failed', 'codex_user_stopped',
    'codex_version_mismatch', 'codex_version_unreadable',
  ]);
});

for (const cmd of Object.keys(COMMAND_ERROR_SCOPE)) {
  test(`${cmd} routes a non-2xx failure to its designated UI scope`, async () => {
    const result = await postCommand(
      { cmd },
      async () => new Response(JSON.stringify({ error: `${cmd} refused` }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.status, 409);
    assert.deepEqual(routedCommandFailure(cmd, result), {
      scope: COMMAND_ERROR_SCOPE[cmd],
      message: `${cmd} refused`,
    });
  });
}

test('network failures become visible command errors', async () => {
  const result = await postCommand(
    { cmd: 'send' },
    async () => { throw new Error('connection closed'); },
  );
  assert.equal(commandFailure(result), 'Switchboard request failed: connection closed');
});
```

- [ ] **Step 2: Run the UI tests and confirm the expected failure**

Run:

```bash
node --test test/ui-command.test.ts
```

Expected: FAIL because `web/lib.js` does not exist.

- [ ] **Step 3: Implement the helper and route every handler through it**

Import `postCommand`, `routedCommandFailure`, `CODEX_FAILURE_LABEL`, and `COMMAND_ERROR_SCOPE` at the top of `web/app.js`. Replace the current local `send()` helper.

Add a single `reportCommandFailure(cmd, result)` function in `web/app.js`. It must consume `routedCommandFailure(cmd, result)` and update the returned scope:

- `new-session`: write `#new-error`;
- `selection`: write `selectionMessage` and rerender the selection toolbar;
- `session`: write `#command-error` and retain it until a successful retry, explicit dismiss, or session change.

Make create, send, resume, stop, auto, decide, merge, push, and delete handlers `async`, await `postCommand()`, and stop their success-side UI mutation when the result is not ok. Preserve the existing merge/push success messages.

Add this persistent session error region to `web/index.html` near the chat/grid root:

```html
<p id="command-error" role="alert"></p>
```

Add a small dismiss button only when the error is nonempty. Clear the region when `openId` changes. Do not clear it merely because an SSE snapshot arrived.

Use `CODEX_FAILURE_LABEL[s.stoppedCode]` on stopped Codex cards and in the open chat header, with the sanitized `stoppedReason` as supporting/remediation text. Fall back to `stoppedReason` for legacy sessions with no code. This makes user stop, launch, authentication, resume, stream, sandbox, and runtime-readiness failures visually distinct without branching on raw SDK messages.

Add `lib.js` to the static asset allow-list and MIME handling in `src/server.ts`.

- [ ] **Step 4: Render only exceptional prompt delivery state**

In the user-message branch of the transcript renderer:

- render ordinary `sent` prompts exactly as today;
- add a muted `Queued` label for `queued`;
- add an error-colored `Not sent` label for `unsent`;
- use the persisted prompt ID only as a DOM key/data attribute, never as visible text.

Add CSS classes `.prompt-delivery`, `.prompt-delivery.queued`, and `.prompt-delivery.unsent`. Do not add a new top-level view or a delivery control.

Keep the Codex Auto checkbox disabled. Its title/help text must say that Codex uses a fixed worktree sandbox with non-interactive permissions.

- [ ] **Step 5: Add server/UI static coverage and run tests**

Extend `test/server.test.ts` to request `/lib.js` and assert status 200 plus JavaScript content type. Then run:

```bash
node --test test/ui-command.test.ts test/server.test.ts
npm test
```

Expected: every browser command has a tested error scope, the helper retains non-2xx and network failures, `lib.js` is served, and the full suite passes.

- [ ] **Step 6: Commit browser failure handling**

```bash
git add web/lib.js web/app.js web/index.html web/style.css src/server.ts test/ui-command.test.ts test/server.test.ts
git commit -m "fix: surface browser command failures"
```

---

### Task 6: Add Codex contributor guidance and complete Phase 1 verification

**Files:**
- Create: `AGENTS.md`
- Modify: `README.md`
- Modify: `accounts.example.json`

- [ ] **Step 1: Write repository guidance that Codex will load automatically**

Create root `AGENTS.md` with these concrete sections:

- setup: Node 22.18+, `npm install`, `cp accounts.example.json accounts.json`;
- architecture: browser → HTTP/SSE server → Registry/worktrees → provider adapter;
- safety boundaries: one worktree per session, fixed Codex workspace-write sandbox, never-approve policy, no secret persistence;
- code ownership: `src/server.ts`, `src/sessions.ts`, `src/agents/`, `web/`, and `test/` responsibilities;
- required verification: run focused `node --test` while iterating and `npm test` before completion;
- test isolation: fake Codex only, temporary `CODEX_HOME`, no paid/networked tests;
- change discipline: preserve target repository Codex configuration and do not implement Phase 2 behavior under a Phase 1 fix.

Do not create `.codex/config.toml`; Phase 1 needs no repository setting that belongs there.

- [ ] **Step 2: Update setup and limitations documentation**

Keep the active Codex entry in `accounts.example.json` on automatic runtime selection so a machine-specific path is not copied by default:

```json
[
  { "name": "claude-main", "provider": "claude", "budget": 2000000, "env": {} },
  { "name": "claude-alt", "provider": "claude", "budget": 2000000,
    "env": { "CLAUDE_CONFIG_DIR": "/absolute/path/to/.claude-alt" } },
  { "name": "codex", "provider": "codex", "budget": 2000000, "env": {} }
]
```

Show the optional explicit form in the README, where `/absolute/path/to/codex` is clearly documentation rather than a live account:

```json
{ "name": "codex", "provider": "codex", "budget": 2000000,
  "bin": "/absolute/path/to/codex", "env": {} }
```

Document in `README.md`:

- Codex runtime order: explicit account `bin`, compatible standard ChatGPT.app binary, SDK-bundled fallback;
- exact-version compatibility and actionable preflight behavior;
- `codex login status` readiness and `CODEX_HOME` account override support;
- fixed non-interactive permission model;
- preserved user/project configuration;
- queued/sent/unsent meaning and no automatic replay;
- stable failure visibility;
- hermetic `npm test` fake-process coverage;
- macOS-only scope;
- Phase 2 omissions as current limitations.

Remove obsolete README statements that the ChatGPT.app path is always hardcoded, errors are mostly silent, or tests stop at pure event normalization.

- [ ] **Step 3: Run specification coverage checks**

Run:

```bash
rg -n "codex_platform_unsupported|codex_binary_missing|codex_binary_not_executable|codex_version_unreadable|codex_version_mismatch|codex_auth_unavailable|codex_start_failed|codex_resume_failed|codex_stream_failed|codex_sandbox_denied|codex_user_stopped" src test
rg -n "danger-full-access|approvalPolicy|sandboxMode" src README.md AGENTS.md
rg -n "TODO|TBD|FIXME" src test web README.md AGENTS.md
```

Expected:

- every stable Codex code appears in implementation or focused coverage;
- the only Codex runtime policy is workspace-write plus never-approve;
- no unfinished TODO marker remains in Phase 1 files.

Review the Phase 1 acceptance list in the design specification line by line. If implementation behavior differs, fix the implementation; do not silently weaken the approved behavior and do not mark Phase 2 complete.

- [ ] **Step 4: Run the complete offline verification contract**

Run:

```bash
npm test
git diff --check
git status --short
```

Expected:

- `npm test` exits 0 with resolver, real-SDK/fake-process, create, follow-up, cancellation, resume, persistence, and browser-command coverage;
- no test contacts OpenAI or the real `~/.codex`;
- `git diff --check` reports no whitespace errors;
- `git status --short` shows the intended Phase 1 changes plus any pre-existing unrelated user files, which remain unstaged and untouched.

- [ ] **Step 5: Perform a final requirements review**

Verify all of the following before claiming Phase 1 complete:

- compatible runtime selected before worktree creation;
- explicit binary failures fail closed with stable codes;
- ChatGPT.app mismatch falls back to SDK CLI;
- auth preflight uses the selected launch environment;
- repository/user Codex configuration remains inherited;
- start/resume/stream/sandbox/user-stop failures remain distinguishable;
- prompt queue state survives failure and restart without replay;
- all browser commands await and display non-2xx results;
- account environment values are absent from state, SSE, logs, and errors;
- the normal test suite covers the SDK-to-process boundary offline;
- the root `AGENTS.md` is useful and accurate;
- no Phase 2 feature was pulled forward.

- [ ] **Step 6: Commit documentation and verification updates**

```bash
git add AGENTS.md README.md accounts.example.json
git commit -m "docs: document hardened Codex workflow"
```

---

## Phase 1 Completion Boundary

Completing every task above means Phase 1 of the approved specification is complete. It does not mean the entire Codex roadmap is 100% complete. Phase 2 still owns live item lifecycle rendering, bounded/redacted details, reasoning/todo presentation, structured local-image input, inherited-by-default per-session settings, improved usage reporting where supported, and the SDK-versus-app-server interactive-approval evaluation.

After Phase 1 is implemented and verified, reinspect the then-current `@openai/codex-sdk` API and adapter behavior before writing the separate Phase 2 implementation plan.
