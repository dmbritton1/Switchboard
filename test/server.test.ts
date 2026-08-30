import { test } from 'node:test';
import assert from 'node:assert';
import {
  chmod, mkdir, mkdtemp, writeFile, readdir, realpath, rename, rm, readFile, stat, symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { request as httpRequest } from 'node:http';
import { Registry, type RegistryOptions } from '../src/sessions.ts';
import { Usage } from '../src/usage.ts';
import { Scheduler } from '../src/schedule.ts';
import { createServer, refreshLimits, accountLoad, shouldRequeue, parseSettingsPatch, type Account } from '../src/server.ts';
import { resolveAgentPrompt } from '../src/prompt-input.ts';
import { createWorktree } from '../src/worktree.ts';
import { createAccountLimitCoordinator, type AccountLimitCoordinator } from '../src/account-limits.ts';
import { resetScheduleView } from '../web/lib.js';
import { writeFakeCodex } from './helpers/fake-codex.ts';
import { writeFakeLoginCli } from './helpers/fake-login.ts';
import { createAccountStore, type Account } from '../src/accounts.ts';
import { Linker, type PublicLink } from '../src/link.ts';
import type { Adapter, AdapterEvent, StartOpts } from '../src/types.ts';

const run = promisify(execFile);

// `fetch` implements the Fetch spec's forbidden-header-name list, which includes
// `Host` — there is no way to send a spoofed Host header through fetch(). node:http's
// request() has no such restriction, so the Host-guard tests below use it directly.
function rawRequest(
  url: URL,
  opts: { method: string; headers: Record<string, string>; body?: string },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: opts.method, headers: opts.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

const accounts = [
  { name: 'claude-main', provider: 'claude' as const, budget: 1000, env: {} },
  { name: 'codex', provider: 'codex' as const, budget: 1000, env: {} },
];

function fakeLimitCoordinator(options: {
  eligibility?: ReturnType<AccountLimitCoordinator['codexResetEligibility']>;
  release?: (account: string) => Promise<{ ready: boolean; reason: string }>;
} = {}): AccountLimitCoordinator & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    start: async () => {},
    reconcile: async () => {},
    codexResetEligibility: () => options.eligibility ?? { eligible: false, reason: 'no fresh Codex usage window' },
    releaseCodexAfterFreshRead: async (account) => {
      reads.push(account);
      return options.release ? options.release(account) : { ready: false, reason: 'still limited' };
    },
    close: async () => {},
  };
}

function realEligibilityCoordinator(usage: Usage, now: number): AccountLimitCoordinator {
  const coordinator = createAccountLimitCoordinator({ accounts, usage, onChange: () => {}, now: () => now });
  return {
    start: async () => {},
    reconcile: async () => {},
    codexResetEligibility: (account, at) => coordinator.codexResetEligibility(account, at),
    releaseCodexAfterFreshRead: async () => ({ ready: false, reason: 'not used by creation tests' }),
    close: async () => {},
  };
}

test('account telemetry starts asynchronously after HTTP listen and cleans up with server close', async () => {
  const registry = new Registry('/tmp/switchboard-coordinator-test.json');
  const usage = new Usage();
  const order: string[] = [];
  let closes = 0;
  let poolCloses = 0;
  let cleared: unknown = null;
  let intervalDelay = 0;
  const limitCoordinator: AccountLimitCoordinator = {
    start: async () => { order.push('telemetry-start'); },
    reconcile: async () => {},
    codexResetEligibility: () => ({ eligible: false, reason: 'not used' }),
    releaseCodexAfterFreshRead: async () => ({ ready: false, reason: 'not used' }),
    close: async () => { closes += 1; },
  };
  const timer = { id: 'limit-reconcile' };
  const server = createServer({
    registry, usage, accounts, limitCoordinator,
    codexPool: { close: async () => { poolCloses += 1; } },
    limitLifecycle: {
      setInterval: (_callback: () => void, delay: number) => { intervalDelay = delay; return timer; },
      clearInterval: (handle: unknown) => { cleared = handle; },
    },
  });
  assert.deepEqual(order, [], 'construction must not start telemetry');
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => {
    order.push('http-listening');
    resolve();
  }));
  await Promise.resolve();
  assert.deepEqual(order, ['http-listening', 'telemetry-start']);
  assert.equal(intervalDelay, 5 * 60_000);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await Promise.resolve();
  assert.equal(cleared, timer);
  assert.equal(closes, 1);
  assert.equal(poolCloses, 1);
});

test('account telemetry reconciliation never overlaps the initial or prior pass', async () => {
  const registry = new Registry('/tmp/switchboard-coordinator-overlap-test.json');
  const usage = new Usage();
  let resolveStart!: () => void;
  let resolveReconcile!: () => void;
  const startGate = new Promise<void>((resolve) => { resolveStart = resolve; });
  let reconcileGate = new Promise<void>((resolve) => { resolveReconcile = resolve; });
  let starts = 0;
  let reconciles = 0;
  let interval!: () => void;
  const limitCoordinator: AccountLimitCoordinator = {
    start: async () => { starts += 1; await startGate; },
    reconcile: async () => { reconciles += 1; await reconcileGate; },
    codexResetEligibility: () => ({ eligible: false, reason: 'not used' }),
    releaseCodexAfterFreshRead: async () => ({ ready: false, reason: 'not used' }),
    close: async () => {},
  };
  const server = createServer({
    registry, usage, accounts, limitCoordinator,
    limitLifecycle: {
      setInterval: (callback: () => void) => { interval = callback; return 1; },
      clearInterval: () => {},
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  await Promise.resolve();
  assert.equal(starts, 1);
  interval();
  assert.equal(reconciles, 0, 'the initial read is still active');
  resolveStart();
  await new Promise((resolve) => setTimeout(resolve, 0));

  interval();
  assert.equal(reconciles, 1);
  interval();
  assert.equal(reconciles, 1, 'a previous reconcile is still active');
  resolveReconcile();
  await new Promise((resolve) => setTimeout(resolve, 0));

  reconcileGate = Promise.resolve();
  interval();
  assert.equal(reconciles, 2);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

async function boot(
  t: { after: (fn: () => void) => void },
  adapterOrOptions?: Adapter | RegistryOptions,
  serverHooks: {
    beforeUploadRootPin?: () => Promise<void>;
    beforeUploadWrite?: (target: string) => Promise<void>;
    beforeWorktreeRemoval?: (cwd: string) => Promise<void>;
    limitCoordinator?: AccountLimitCoordinator;
    accounts?: Account[];
    usage?: Usage;
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'sb-'));
  const adapter = adapterOrOptions && typeof (adapterOrOptions as Adapter).start === 'function'
    ? adapterOrOptions as Adapter
    : undefined;
  const registryOptions = adapter ? undefined : adapterOrOptions as RegistryOptions | undefined;
  const registry = new Registry(join(dir, 'state.json'), undefined, registryOptions);
  const usage = serverHooks.usage ?? new Usage();
  const scheduler = new Scheduler();
  // One adapter for every account rather than a claude/codex pair: since the
  // Codex runtime landed, the server resolves a provider through an async
  // `prepare` step instead of a lookup table, and a test that injects here
  // wants to observe launch()'s emit wiring, not provider selection.
  const prepare = adapter ? async () => ({ adapter }) : undefined;
  const testAccounts = serverHooks.accounts ?? accounts;
  const {
    accounts: _accounts, usage: _usage, ...createServerHooks
  } = serverHooks;
  const server = createServer({
    registry, usage, scheduler, accounts: testAccounts, prepare, ...createServerHooks,
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  t.after(() => { server.close(); return rm(dir, { recursive: true, force: true }); });
  return { base: `http://127.0.0.1:${port}`, registry, usage, scheduler, server };
}

/**
 * Like boot(), but with account linking wired up: a real Linker pointed at a
 * fake login CLI (test/helpers/fake-login.ts) so link-start spawns a real
 * child process and never a real `claude`/`codex` binary, and a real
 * accountStore over a temp accounts.json.
 *
 * The Linker's `accounts` getter and createServer's `accounts` option share
 * the exact same array reference — mirroring the entry point in src/server.ts
 * — so link-confirm's `accounts.push(account)` is immediately visible to the
 * Linker's own duplicate-identity check and suggestName().
 */
async function bootLinking(
  t: { after: (fn: () => void) => void },
  options: { mode?: 'ok' | 'no-prompt' | 'bad-code' | 'no-url' | 'slow'; email?: string | null } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'sb-link-'));
  const accountsPath = join(dir, 'accounts.json');
  await writeFile(accountsPath, '[]\n');
  const bin = await writeFakeLoginCli(dir, { provider: 'claude', mode: options.mode, email: options.email });
  const registry = new Registry(join(dir, 'state.json'));
  const usage = new Usage();
  const scheduler = new Scheduler();
  const linkAccounts: Account[] = [];
  const accountsRoot = join(dir, 'accounts');
  const linker = new Linker({
    accountsRoot,
    accounts: () => linkAccounts,
    spawnLogin: (provider, env) => spawn(bin, provider === 'claude' ? ['auth', 'login'] : ['login'], {
      env: { ...process.env, ...env },
    }),
    claudeBin: bin,
    urlTimeoutMs: 5_000,
    overallTimeoutMs: 10_000,
  });
  const accountStore = createAccountStore(accountsPath);
  // Sessions started against a linked account (unlink's in-use tests) must
  // never spawn a real claude/codex binary — reuses the same fakeAdapter()
  // boot() uses below, just wired through the `prepare` seam instead.
  const { adapter } = fakeAdapter();
  const server = createServer({
    registry, usage, scheduler, accounts: linkAccounts, accountStore, linker,
    prepare: async () => ({ adapter }),
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  const base = `http://127.0.0.1:${port}`;
  t.after(() => { server.close(); return rm(dir, { recursive: true, force: true }); });
  return {
    base, registry, usage, scheduler, server, linker, accountsPath, accountsRoot, accounts: linkAccounts,
    accountStore, tmp: dir,
  };
}

/** Resolves once `linker.snapshot()` satisfies `predicate`, or rejects after 5s. */
function untilLink(linker: Linker, predicate: (link: PublicLink | null) => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = () => {
      if (!predicate(linker.snapshot())) return;
      unsub(); clearTimeout(timer); resolve();
    };
    const timer = setTimeout(() => { unsub(); reject(new Error('timed out waiting for link phase')); }, 5_000);
    const unsub = linker.subscribe(check);
    check();
  });
}

/**
 * A minimal fake `Adapter` for tests that need to drive `launch()`'s real
 * emit callback in src/server.ts — the wiring that calls `usage.noteLimit()`
 * and `shouldRequeue()` — without spawning a real Claude/Codex subprocess.
 * `start()` captures the emit callback so the test can fire events into it
 * whenever it likes, and records the `opts` it was called with in `starts`
 * so a test can assert on what launch() actually passed (e.g. `auto`) rather
 * than just the registry's end state. `stop()` emits `stopped` itself,
 * matching the real adapters (both re-enter the emit callback from their
 * own stop()).
 */
function fakeAdapter(): { adapter: Adapter; emit: (e: AdapterEvent) => void; starts: StartOpts[] } {
  let cb: ((e: AdapterEvent) => void) | null = null;
  const starts: StartOpts[] = [];
  const adapter: Adapter = {
    start(opts, emit) {
      starts.push(opts);
      cb = emit;
      return {
        send() {},
        decide() {},
        setAuto() {},
        stop() { cb?.({ type: 'stopped', reason: 'stopped by handle' }); },
      };
    },
  };
  return { adapter, emit: (e) => cb?.(e), starts };
}

/** The snapshot the browser actually receives: /events pushes it on connect. */
async function firstSnapshot(base: string): Promise<any> {
  const res = await fetch(new URL('/events', base));
  const reader = res.body!.getReader();
  const { value } = await reader.read();
  await reader.cancel();
  const text = new TextDecoder().decode(value);
  return JSON.parse(text.replace(/^data: /, '').trim());
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for Codex session');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

type CodexFixture = Awaited<ReturnType<typeof boot>> & {
  usage: Usage;
  repo: string;
  bin: string;
  statePath: string;
  command(body: Record<string, unknown>): Promise<{ status: number; data: any }>;
  create(prompt: string): Promise<{ id: string }>;
  waitForSession(id: string, predicate: (session: NonNullable<ReturnType<Registry['get']>>) => boolean): Promise<void>;
  worktrees(): Promise<string>;
  invocations(): Promise<Array<{
    argv: string[]; prompt: string; cwd: string; codexHome: string | null; imageBytes: string[];
  }>>;
  calls(): Promise<string[][]>;
  preflightGate?: {
    enable: string;
    started: string;
    release: string;
    count(): Promise<number>;
  };
};

async function bootCodex(
  t: { after: (fn: () => void) => void },
  options: {
    bin?: string;
    env?: Record<string, string>;
    resolvePrompt?: typeof resolveAgentPrompt;
    gatedPreflight?: boolean;
    beforeWorktreeRemoval?: (cwd: string) => Promise<void>;
  } = {},
): Promise<CodexFixture> {
  const dir = await mkdtemp(join(tmpdir(), 'sb-codex-server-'));
  const repo = join(dir, 'repo');
  const log = join(dir, 'fake-codex.jsonl');
  const callLog = join(dir, 'fake-codex-calls.jsonl');
  const codexHome = join(dir, 'codex-home');
  const preflightGate = options.gatedPreflight ? {
    enable: join(dir, 'preflight-enabled'),
    started: join(dir, 'preflight-started.log'),
    release: join(dir, 'preflight-release'),
    async count() {
      return readFile(this.started, 'utf8').then((text) => text.split('\n').filter(Boolean).length, () => 0);
    },
  } : undefined;
  await run('git', ['init', '-b', 'main', repo]);
  await run('git', ['config', 'user.email', 't@t.t'], { cwd: repo });
  await run('git', ['config', 'user.name', 'T'], { cwd: repo });
  await writeFile(join(repo, 'a.txt'), 'one\n');
  await run('git', ['add', '.'], { cwd: repo });
  await run('git', ['commit', '-m', 'init'], { cwd: repo });
  await Promise.all([writeFile(log, ''), writeFile(callLog, ''), mkdir(codexHome)]);
  const fakeBin = options.bin ? undefined : await writeFakeCodex(dir);
  const bin = options.bin ?? join(dir, 'recording-codex');
  if (fakeBin) {
    await writeFile(bin, `#!/usr/bin/env node
const { appendFileSync, existsSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
if (process.argv.includes('--version')
  && process.env.FAKE_CODEX_PREFLIGHT_ENABLE
  && existsSync(process.env.FAKE_CODEX_PREFLIGHT_ENABLE)) {
  appendFileSync(process.env.FAKE_CODEX_PREFLIGHT_STARTED, 'started\\n');
  while (!existsSync(process.env.FAKE_CODEX_PREFLIGHT_RELEASE)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}
appendFileSync(process.env.FAKE_CODEX_CALL_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
const result = spawnSync(${JSON.stringify(fakeBin)}, process.argv.slice(2), { stdio: 'inherit', env: process.env });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
`);
    await chmod(bin, 0o755);
  }
  const statePath = join(dir, 'state.json');
  const registry = new Registry(statePath);
  const usage = new Usage();
  const account = {
    name: 'codex', provider: 'codex' as const, budget: 1000,
    bin,
    env: {
      FAKE_CODEX_LOG: log, FAKE_CODEX_CALL_LOG: callLog, CODEX_HOME: codexHome,
      ...(preflightGate ? {
        FAKE_CODEX_PREFLIGHT_ENABLE: preflightGate.enable,
        FAKE_CODEX_PREFLIGHT_STARTED: preflightGate.started,
        FAKE_CODEX_PREFLIGHT_RELEASE: preflightGate.release,
      } : {}),
      ...options.env,
    },
  };
  const server = createServer({
    registry, usage, scheduler: new Scheduler(), accounts: [account],
    ...(options.resolvePrompt ? { resolvePrompt: options.resolvePrompt } : {}),
    ...(options.beforeWorktreeRemoval ? { beforeWorktreeRemoval: options.beforeWorktreeRemoval } : {}),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  t.after(() => { server.close(); return rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  return {
    base, registry, usage, repo, bin, statePath, ...(preflightGate ? { preflightGate } : {}),
    async command(body) {
      const response = await fetch(`${base}/command`, { method: 'POST', body: JSON.stringify(body) });
      return { status: response.status, data: await response.json() };
    },
    async create(prompt) {
      const response = await this.command({ cmd: 'create', account: 'codex', repo, branch: `codex-${prompt}`, prompt });
      assert.equal(response.status, 200);
      return response.data;
    },
    async waitForSession(id, predicate) {
      await waitFor(() => {
        const session = registry.get(id);
        return Boolean(session && predicate(session));
      });
    },
    async worktrees() {
      return (await run('git', ['worktree', 'list', '--porcelain'], { cwd: repo })).stdout;
    },
    async invocations() {
      return (await readFile(log, 'utf8')).split('\n').filter(Boolean)
        .map((line) => JSON.parse(line) as {
          argv: string[]; prompt: string; cwd: string; codexHome: string | null; imageBytes: string[];
        });
    },
    async calls() {
      return (await readFile(callLog, 'utf8')).split('\n').filter(Boolean)
        .map((line) => JSON.parse(line) as string[]);
    },
  };
}

test('Codex account pace records only input and output totals', async (t) => {
  const fixture = await bootCodex(t);
  const calls: Array<[string, number, number]> = [];
  fixture.usage.record = (account, inputTokens, outputTokens) => {
    calls.push([account, inputTokens, outputTokens]);
  };

  const created = await fixture.create('usage');
  await fixture.waitForSession(created.id, (session) => session.status === 'done');

  assert.deepEqual(calls, [['codex', 11, 5]]);
});

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
  assert.equal(await fixture.worktrees(), before);
});

test('Codex create preflight errors redact long ordinary launch-environment values', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sb-preflight-redaction-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bad-version-codex');
  await writeFile(bin, `#!/usr/bin/env node
if (process.argv.includes('--version')) {
  process.stdout.write('workspace customer-internal-42 has no readable version\\n');
  process.exit(0);
}
process.exit(2);
`);
  await chmod(bin, 0o755);
  const fixture = await bootCodex(t, {
    bin, env: { WORKSPACE_LABEL: 'customer-internal-42' },
  });

  const response = await fixture.command({
    cmd: 'create', account: 'codex', repo: fixture.repo, branch: 'redacted-preflight', prompt: 'hello',
  });

  assert.equal(response.status, 400);
  assert.ok(!JSON.stringify(response.data).includes('customer-internal-42'));
  assert.match(response.data.error, /workspace \[REDACTED\]/);
  assert.deepEqual(fixture.registry.all(), []);
});

test('a successful Codex create finishes with the fake executable', async (t) => {
  const fixture = await bootCodex(t);
  const created = await fixture.create('first');
  await fixture.waitForSession(created.id, (session) => session.status === 'done');
  assert.equal(fixture.registry.get(created.id)!.vendorSessionId, 'fake-thread');
});

test('Codex create persists only supplied settings, updates stopped sessions, and reuses them on resume', async (t) => {
  const fixture = await bootCodex(t);
  const created = await fixture.command({
    cmd: 'create', account: 'codex', repo: fixture.repo, branch: 'codex-settings', prompt: 'first',
    codexSettings: { model: 'gpt-5.3-codex', networkAccessEnabled: false },
  });
  assert.equal(created.status, 200);
  await fixture.waitForSession(created.data.id, (session) => session.status === 'done');
  assert.deepEqual(fixture.registry.get(created.data.id)!.codexSettings, {
    model: 'gpt-5.3-codex', networkAccessEnabled: false,
  });
  assert.doesNotMatch(JSON.stringify(fixture.registry.publicSessions()), /modelReasoningEffort|webSearchMode/);

  await fixture.command({ cmd: 'stop', id: created.data.id });
  await fixture.waitForSession(created.data.id, (session) => session.status === 'stopped');
  const change = await fixture.command({
    cmd: 'codex-settings', id: created.data.id, codexSettings: { webSearchMode: 'cached' },
  });
  assert.equal(change.status, 200);
  assert.deepEqual(fixture.registry.get(created.data.id)!.codexSettings, { webSearchMode: 'cached' });

  assert.equal((await fixture.command({ cmd: 'resume', id: created.data.id, prompt: 'continue' })).status, 200);
  await fixture.waitForSession(created.data.id, (session) => session.status === 'done');
  const resumed = (await fixture.invocations()).at(-1)!.argv.join(' ');
  assert.match(resumed, /web_search="cached"/);
  assert.ok(!/network_access_enabled|model_reasoning_effort/.test(resumed));
});

test('Codex settings reject non-Codex, live, and malformed changes', async (t) => {
  const { base, registry } = await boot(t);
  const claude = registry.create({
    provider: 'claude', account: 'claude-main', repo: '/r', cwd: '/r/claude', branch: 'claude', title: 'claude',
  });
  for (const body of [{ cmd: 'codex-settings', id: claude.id, codexSettings: {} }]) {
    const response = await fetch(`${base}/command`, { method: 'POST', body: JSON.stringify(body) });
    assert.equal(response.status, 409);
  }
  for (const status of ['working', 'done', 'needs-you'] as const) {
    const codex = registry.create({
      provider: 'codex', account: 'codex', repo: '/r', cwd: `/r/${status}`, branch: status, title: status,
    });
    if (status === 'needs-you') {
      registry.apply(codex.id, { type: 'approval', request: { id: 'p', tool: 'tool', summary: 'wait' } });
    } else if (status === 'done') {
      registry.apply(codex.id, { type: 'status', status });
    }
    const response = await fetch(`${base}/command`, {
      method: 'POST', body: JSON.stringify({ cmd: 'codex-settings', id: codex.id, codexSettings: {} }),
    });
    assert.equal(response.status, 409, status);
  }
  const stopped = registry.create({
    provider: 'codex', account: 'codex', repo: '/r', cwd: '/r/stopped', branch: 'stopped', title: 'stopped',
  });
  registry.apply(stopped.id, { type: 'stopped', reason: 'stopped' });
  const malformed = await fetch(`${base}/command`, {
    method: 'POST',
    body: JSON.stringify({ cmd: 'codex-settings', id: stopped.id, codexSettings: { networkAccessEnabled: 'false' } }),
  });
  assert.equal(malformed.status, 400);
  const create = await fetch(`${base}/command`, {
    method: 'POST',
    body: JSON.stringify({ cmd: 'create', account: 'claude-main', repo: '/r', branch: 'bad', prompt: 'no', codexSettings: {} }),
  });
  assert.equal(create.status, 400);
  assert.equal(registry.all().length, 5);
});

test('Codex send validates attachments, persists only names, and resumes without replaying them', async (t) => {
  const fixture = await bootCodex(t);
  const created = await fixture.create('first');
  await fixture.waitForSession(created.id, (session) => session.status === 'done');
  const session = fixture.registry.get(created.id)!;
  await mkdir(join(session.cwd, 'uploads'));
  const imagePath = join(session.cwd, 'uploads', 'screen.png');
  const filePath = join(session.cwd, 'uploads', 'notes.txt');
  await Promise.all([
    writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    writeFile(filePath, 'server notes'),
  ]);

  const sent = await fixture.command({
    cmd: 'send', id: created.id, text: 'Review these',
    attachments: ['uploads/screen.png', 'uploads/notes.txt'],
  });
  assert.equal(sent.status, 200);
  await waitFor(async () => (await fixture.invocations()).length === 2);

  const attachmentMessage = session.transcript.find(
    (message) => message.kind === 'user' && message.text === 'Review these',
  );
  assert.ok(attachmentMessage?.kind === 'user');
  assert.deepEqual(attachmentMessage.attachments, ['screen.png', 'notes.txt']);
  const persisted = await readFile(fixture.statePath, 'utf8');
  const persistedState = JSON.parse(persisted) as { sessions: Array<{ transcript: unknown[] }> };
  assert.ok(JSON.stringify(persistedState.sessions[0].transcript).includes(
    '"attachments":["screen.png","notes.txt"]',
  ));
  assert.ok(!persisted.includes(imagePath));
  assert.ok(!persisted.includes(filePath));

  const eventsResponse = await fetch(`${fixture.base}/events`);
  const reader = eventsResponse.body!.getReader();
  const firstEvent = new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  assert.match(firstEvent, /"attachments":\["screen\.png","notes\.txt"\]/);
  assert.ok(!firstEvent.includes(imagePath));
  assert.ok(!firstEvent.includes(filePath));

  const [, attachmentInvocation] = await fixture.invocations();
  assert.equal(attachmentInvocation.prompt, 'Review these\nAttached file: uploads/notes.txt');
  const [snapshotPath] = attachmentInvocation.argv.flatMap((arg, index, argv) =>
    arg === '--image' ? [argv[index + 1]] : []);
  assert.notEqual(snapshotPath, await realpath(imagePath));
  assert.deepEqual(attachmentInvocation.imageBytes, ['89504e470d0a1a0a']);
  await fixture.waitForSession(created.id, (current) => current.status === 'done');
  await waitFor(() => stat(snapshotPath).then(() => false, () => true));
  await assert.rejects(stat(snapshotPath), 'the server-visible Codex lifecycle cleans private image snapshots');

  assert.equal((await fixture.command({ cmd: 'stop', id: created.id })).status, 200);
  const resumed = await fixture.command({ cmd: 'resume', id: created.id, prompt: 'Continue cleanly' });
  assert.equal(resumed.status, 200);
  await waitFor(async () => (await fixture.invocations()).length === 3);
  const resumeInvocation = (await fixture.invocations())[2];
  assert.equal(resumeInvocation.prompt, 'Continue cleanly');
  assert.ok(!resumeInvocation.argv.includes('--image'), 'resume must not replay prior image attachments');
});

test('invalid attachment paths neither append a prompt nor call the live handle', async (t) => {
  const fixture = await bootCodex(t);
  const created = await fixture.create('first');
  await fixture.waitForSession(created.id, (session) => session.status === 'done');
  const session = fixture.registry.get(created.id)!;
  await writeFile(join(session.cwd, 'real.txt'), 'real');
  await symlink('real.txt', join(session.cwd, 'link.txt'));
  const transcriptLength = session.transcript.length;

  for (const attachments of [
    ['missing.txt'],
    ['../outside.txt'],
    ['link.txt'],
  ]) {
    const response = await fixture.command({
      cmd: 'send', id: created.id, text: 'must not be accepted', attachments,
    });
    assert.equal(response.status, 400, attachments[0]);
    assert.equal(session.transcript.length, transcriptLength, attachments[0]);
  }

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal((await fixture.invocations()).length, 1, 'validation failures never call handle.send');
});

test('an unreadable image returns a path-free 400 and appends nothing', async (t) => {
  const fixture = await bootCodex(t);
  const created = await fixture.create('first');
  await fixture.waitForSession(created.id, (session) => session.status === 'done');
  const session = fixture.registry.get(created.id)!;
  const imagePath = join(session.cwd, 'customer-secret.png');
  await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  await chmod(imagePath, 0o000);
  const transcriptLength = session.transcript.length;

  const response = await fixture.command({
    cmd: 'send', id: created.id, text: 'inspect', attachments: ['customer-secret.png'],
  });

  assert.equal(response.status, 400);
  assert.equal(response.data.error, 'Attachment 1 could not be read.');
  assert.ok(!JSON.stringify(response.data).includes(imagePath));
  assert.ok(!JSON.stringify(response.data).includes('customer-secret.png'));
  assert.equal(session.transcript.length, transcriptLength);
});

test('send stopped during attachment resolution does not append or call the stale handle', async (t) => {
  let enterResolution!: () => void;
  let releaseResolution!: () => void;
  const entered = new Promise<void>((resolve) => { enterResolution = resolve; });
  const released = new Promise<void>((resolve) => { releaseResolution = resolve; });
  const fixture = await bootCodex(t, {
    resolvePrompt: async (...args) => {
      enterResolution();
      await released;
      return resolveAgentPrompt(...args);
    },
  });
  const created = await fixture.create('first');
  await fixture.waitForSession(created.id, (session) => session.status === 'done');
  const session = fixture.registry.get(created.id)!;
  await writeFile(join(session.cwd, 'notes.txt'), 'notes');
  const transcriptLength = session.transcript.length;
  const send = fixture.command({
    cmd: 'send', id: created.id, text: 'read', attachments: ['notes.txt'],
  });

  const resolverWasEntered = await Promise.race([
    entered.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 250)),
  ]);
  assert.equal(resolverWasEntered, true, 'the test resolver must control the validation await');
  assert.equal((await fixture.command({ cmd: 'stop', id: created.id })).status, 200);
  releaseResolution();
  const response = await send;

  assert.notEqual(response.status, 200);
  assert.equal(session.transcript.length, transcriptLength);
  assert.equal((await fixture.invocations()).length, 1);
});

test('Codex create persists its written initial prompt as queued before the response', async (t) => {
  const fixture = await bootCodex(t);
  const deliveries: string[] = [];
  const unsubscribe = fixture.registry.subscribe(() => {
    const prompt = fixture.registry.all()[0]?.transcript.find((msg) => msg.kind === 'user');
    if (prompt?.kind === 'user') deliveries.push(prompt.delivery);
  });
  const response = await fixture.command({
    cmd: 'create', account: 'codex', repo: fixture.repo, branch: 'codex-hold', prompt: 'hold',
  });
  unsubscribe();

  assert.equal(response.status, 200);
  assert.deepEqual(deliveries.slice(0, 2), ['queued', 'sent']);
});

test('Codex follow-ups persist queued then become sent in FIFO order', async (t) => {
  const fixture = await bootCodex(t);
  const created = await fixture.create('hold');
  await fixture.waitForSession(created.id, (session) => session.status === 'working');
  const first = await fixture.command({ cmd: 'send', id: created.id, text: 'first follow-up' });
  const second = await fixture.command({ cmd: 'send', id: created.id, text: 'second follow-up' });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(fixture.registry.get(created.id)!.transcript.slice(-2).map((msg) =>
    msg.kind === 'user' && ({ text: msg.text, delivery: msg.delivery })), [
    { text: 'first follow-up', delivery: 'queued' },
    { text: 'second follow-up', delivery: 'queued' },
  ]);

  await fixture.command({ cmd: 'stop', id: created.id });
  await fixture.waitForSession(created.id, (session) => session.status === 'stopped');
  assert.deepEqual(fixture.registry.get(created.id)!.transcript
    .filter((msg) => msg.kind === 'user')
    .map((msg) => ({ text: msg.text, delivery: msg.delivery })), [
    { text: 'hold', delivery: 'sent' },
    { text: 'first follow-up', delivery: 'unsent' },
    { text: 'second follow-up', delivery: 'unsent' },
  ]);
});

test('a failed active Codex turn leaves queued follow-ups unsent and resume does not replay them', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sb-codex-delivery-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, 'slow-failing-codex');
  await writeFile(bin, `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write('codex-cli 0.145.0\\n'); process.exit(0); }
if (args[0] === 'login' && args[1] === 'status') { process.stdout.write('Logged in using ChatGPT\\n'); process.exit(0); }
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ argv: args, prompt, cwd: args[args.indexOf('--cd') + 1], codexHome: process.env.CODEX_HOME ?? null }) + '\\n');
  const emit = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
  emit({ type: 'thread.started', thread_id: 'fake-thread' });
  emit({ type: 'turn.started' });
  if (prompt === 'fail after delay') {
    setTimeout(() => emit({ type: 'turn.failed', error: { message: 'delayed failure' } }), 200);
    return;
  }
  emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
});
`);
  await chmod(bin, 0o755);

  const fixture = await bootCodex(t, { bin });
  const create = await fixture.command({
    cmd: 'create', account: 'codex', repo: fixture.repo, branch: 'codex-delayed-failure', prompt: 'fail after delay',
  });
  assert.equal(create.status, 200, JSON.stringify(create.data));
  const created = create.data as { id: string };
  await fixture.waitForSession(created.id, (session) => session.status === 'working');
  await fixture.command({ cmd: 'send', id: created.id, text: 'queued one' });
  await fixture.command({ cmd: 'send', id: created.id, text: 'queued two' });
  await fixture.waitForSession(created.id, (session) => session.status === 'stopped');

  assert.deepEqual(fixture.registry.get(created.id)!.transcript
    .filter((msg) => msg.kind === 'user')
    .map((msg) => ({ text: msg.text, delivery: msg.delivery })), [
    { text: 'fail after delay', delivery: 'sent' },
    { text: 'queued one', delivery: 'unsent' },
    { text: 'queued two', delivery: 'unsent' },
  ]);

  const resumed = await fixture.command({ cmd: 'resume', id: created.id, prompt: 'resume once' });
  assert.equal(resumed.status, 200);
  await fixture.waitForSession(created.id, (session) => session.status === 'done');
  await fixture.command({ cmd: 'send', id: created.id, text: 'delivered one' });
  await fixture.command({ cmd: 'send', id: created.id, text: 'delivered two' });
  await waitFor(async () => (await fixture.invocations()).length === 4);
  await fixture.waitForSession(created.id, (session) => session.transcript
    .filter((msg) => msg.kind === 'user' && msg.text.startsWith('delivered'))
    .every((msg) => msg.kind === 'user' && msg.delivery === 'sent'));
  assert.deepEqual((await fixture.invocations()).map((invocation) => invocation.prompt), [
    'fail after delay', 'resume once', 'delivered one', 'delivered two',
  ]);
});

test('a first-turn Codex launch failure keeps its stopped session and worktree', async (t) => {
  const fixture = await bootCodex(t, { env: { FAKE_CODEX_SECRET: 'launch-secret' } });
  const response = await fixture.command({
    cmd: 'create', account: 'codex', repo: fixture.repo,
    branch: 'codex-startup-failure', prompt: 'startup-failure',
  });
  assert.equal(response.status, 200);
  await fixture.waitForSession(response.data.id, (session) => session.status === 'stopped');
  const session = fixture.registry.get(response.data.id)!;
  assert.equal(session.stoppedCode, 'codex_start_failed');
  assert.ok((await stat(session.cwd)).isDirectory());
  assert.ok(!JSON.stringify(session).includes('launch-secret'));
  const events = await fetch(`${fixture.base}/events`);
  const reader = events.body!.getReader();
  const payload = new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  assert.ok(!payload.includes('launch-secret'), 'public failure text must redact process credentials');
});

test('a failed Codex resume remains stopped and exposes a stable code', async (t) => {
  const fixture = await bootCodex(t);
  const created = await fixture.create('first');
  await fixture.waitForSession(created.id, (session) => session.status === 'done');
  await fixture.command({ cmd: 'stop', id: created.id });
  await fixture.waitForSession(created.id, (session) => session.status === 'stopped');
  await chmod(fixture.bin, 0o644);

  const response = await fixture.command({ cmd: 'resume', id: created.id, prompt: 'continue' });

  assert.equal(response.status, 400);
  assert.equal(response.data.code, 'codex_binary_not_executable');
  assert.equal(fixture.registry.get(created.id)!.status, 'stopped');
  assert.equal(fixture.registry.get(created.id)!.stoppedCode, 'codex_binary_not_executable');
});

test('Codex resume preflight errors redact ordinary launch values from every public boundary', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sb-resume-preflight-redaction-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fake = await writeFakeCodex(dir);
  const marker = join(dir, 'break-version');
  const bin = join(dir, 'stateful-codex');
  await writeFile(bin, `#!/usr/bin/env node
const { existsSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
if (process.argv.includes('--version') && existsSync(${JSON.stringify(marker)})) {
  process.stdout.write('workspace customer-internal-42 has no readable version\\n');
  process.exit(0);
}
const result = spawnSync(${JSON.stringify(fake)}, process.argv.slice(2), { stdio: 'inherit', env: process.env });
process.exit(result.status ?? 1);
`);
  await chmod(bin, 0o755);
  const fixture = await bootCodex(t, {
    bin, env: { WORKSPACE_LABEL: 'customer-internal-42' },
  });
  const created = await fixture.create('first');
  await fixture.waitForSession(created.id, (session) => session.status === 'done');
  await fixture.command({ cmd: 'stop', id: created.id });
  await fixture.waitForSession(created.id, (session) => session.status === 'stopped');
  await writeFile(marker, 'broken');

  const response = await fixture.command({ cmd: 'resume', id: created.id });
  const sessionText = JSON.stringify(fixture.registry.get(created.id));
  const events = await fetch(`${fixture.base}/events`);
  const reader = events.body!.getReader();
  const payload = new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  const persisted = await readFile(fixture.statePath, 'utf8');

  assert.equal(response.status, 400);
  for (const text of [JSON.stringify(response.data), sessionText, payload, persisted]) {
    assert.ok(!text.includes('customer-internal-42'));
  }
  assert.match(response.data.error, /workspace \[REDACTED\]/);
});

test('a missing worktree rejects Codex resume before Registry revival', async (t) => {
  const fixture = await bootCodex(t);
  const created = await fixture.create('first');
  await fixture.waitForSession(created.id, (session) => session.status === 'done');
  await fixture.command({ cmd: 'stop', id: created.id });
  await fixture.waitForSession(created.id, (session) => session.status === 'stopped');
  const session = fixture.registry.get(created.id)!;
  await rm(session.cwd, { recursive: true, force: true });

  const response = await fixture.command({ cmd: 'resume', id: created.id, prompt: 'continue' });
  const reason = `worktree is gone: ${session.cwd} — delete this session, or recreate the worktree`;
  assert.equal(response.status, 409);
  assert.deepEqual(response.data, { error: reason, code: 'codex_resume_failed' });
  assert.equal(fixture.registry.get(created.id)!.status, 'stopped');
  assert.equal(fixture.registry.get(created.id)!.stoppedReason, reason);
  assert.equal(fixture.registry.get(created.id)!.stoppedCode, 'codex_resume_failed');
  assert.deepEqual(fixture.registry.get(created.id)!.transcript.at(-1), {
    kind: 'error', text: reason,
  });

  const reloaded = (await Registry.load(fixture.statePath)).get(created.id)!;
  assert.equal(reloaded.status, 'stopped');
  assert.equal(reloaded.stoppedReason, reason);
  assert.equal(reloaded.stoppedCode, 'codex_resume_failed');
});

test('a successful Codex resume prepares again and reuses its vendor session id', async (t) => {
  const fixture = await bootCodex(t);
  const created = await fixture.create('first');
  await fixture.waitForSession(created.id, (session) => session.status === 'done');
  await fixture.command({ cmd: 'stop', id: created.id });
  await fixture.waitForSession(created.id, (session) => session.status === 'stopped');

  const response = await fixture.command({ cmd: 'resume', id: created.id, prompt: 'continue' });
  assert.equal(response.status, 200);
  await fixture.waitForSession(created.id, (session) => session.status === 'done');
  const invocations = await fixture.invocations();
  assert.equal((await fixture.calls()).filter((args) => args.includes('--version')).length, 2);
  assert.ok(invocations.at(-1)!.argv.includes('resume'));
  assert.equal(invocations.at(-1)!.argv.at(-1), 'fake-thread');
});

test('concurrent Codex resumes reserve one session before preflight', async (t) => {
  const fixture = await bootCodex(t, { gatedPreflight: true });
  const created = await fixture.create('first');
  await fixture.waitForSession(created.id, (session) => session.status === 'done');
  await fixture.command({ cmd: 'stop', id: created.id });
  await fixture.waitForSession(created.id, (session) => session.status === 'stopped');
  const gate = fixture.preflightGate!;
  await writeFile(gate.enable, 'enabled');

  const first = fixture.command({ cmd: 'resume', id: created.id, prompt: 'first resume' });
  await waitFor(() => gate.count().then((count) => count === 1));
  const second = fixture.command({ cmd: 'resume', id: created.id, prompt: 'second resume' });
  const firstObservable = await Promise.race([
    second.then((response) => ({ kind: 'response' as const, response })),
    waitFor(() => gate.count().then((count) => count === 2), 1_000).then(() => ({ kind: 'two-preflights' as const })),
  ]);
  await writeFile(gate.release, 'release');
  const responses = await Promise.all([first, second]);

  assert.equal(firstObservable.kind, 'response', 'the duplicate must be rejected before starting another preflight');
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  assert.equal(await gate.count(), 1, 'only the reserved resume may run readiness checks');
  await waitFor(async () => (await fixture.invocations()).length === 2);
  assert.deepEqual((await fixture.invocations()).map((invocation) => invocation.prompt), ['first', 'first resume']);
});

test('deleting a Codex session during gated resume prevents its later launch', async (t) => {
  const fixture = await bootCodex(t, { gatedPreflight: true });
  const created = await fixture.create('first');
  await fixture.waitForSession(created.id, (session) => session.status === 'done');
  await fixture.command({ cmd: 'stop', id: created.id });
  await fixture.waitForSession(created.id, (session) => session.status === 'stopped');
  const gate = fixture.preflightGate!;
  await writeFile(gate.enable, 'enabled');

  const resume = fixture.command({ cmd: 'resume', id: created.id, prompt: 'must not launch' });
  await waitFor(() => gate.count().then((count) => count === 1));
  assert.equal((await fixture.command({ cmd: 'delete', id: created.id })).status, 200);
  await writeFile(gate.release, 'release');
  const response = await resume;

  assert.equal(response.status, 409);
  assert.equal(fixture.registry.get(created.id), undefined);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual((await fixture.invocations()).map((invocation) => invocation.prompt), ['first']);
});

// The test above deletes without removeWorktree, so delete has no await and
// never overlaps resume. removeWorktree is the branch that awaits, and it used
// to deregister the session only after that await — leaving resume's final
// identity guard looking at a session that delete had already committed to
// destroying, with the worktree about to be removed under the new agent.
test('deleting a Codex worktree during gated resume prevents an orphaned launch', async (t) => {
  let removing!: () => void;
  let releaseRemoval!: () => void;
  const reachedRemoval = new Promise<void>((resolve) => { removing = resolve; });
  const removalHeld = new Promise<void>((resolve) => { releaseRemoval = resolve; });
  const fixture = await bootCodex(t, {
    gatedPreflight: true,
    beforeWorktreeRemoval: async () => { removing(); await removalHeld; },
  });
  const created = await fixture.create('first');
  await fixture.waitForSession(created.id, (session) => session.status === 'done');
  await fixture.command({ cmd: 'stop', id: created.id });
  await fixture.waitForSession(created.id, (session) => session.status === 'stopped');
  const gate = fixture.preflightGate!;
  await writeFile(gate.enable, 'enabled');

  const resume = fixture.command({ cmd: 'resume', id: created.id, prompt: 'must not launch' });
  await waitFor(() => gate.count().then((count) => count === 1));
  const deletion = fixture.command({ cmd: 'delete', id: created.id, removeWorktree: true });
  // Delete is now parked mid-removal. Releasing resume here runs its final guard
  // inside that window — the exact interleaving the old ordering lost.
  await reachedRemoval;
  await writeFile(gate.release, 'release');
  const response = await resume;
  releaseRemoval();

  assert.equal(response.status, 409);
  assert.equal((await deletion).status, 200);
  assert.equal(fixture.registry.get(created.id), undefined);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual((await fixture.invocations()).map((invocation) => invocation.prompt), ['first'],
    'no agent may be launched into a worktree that delete is removing');
});

test('Codex account environment reaches its process but not public event JSON', async (t) => {
  const fixture = await bootCodex(t, { env: { CODEX_TOKEN: 'event-secret' } });
  const created = await fixture.create('first');
  await fixture.waitForSession(created.id, (session) => session.status === 'done');
  const events = await fetch(`${fixture.base}/events`);
  const reader = events.body!.getReader();
  const payload = new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();

  assert.equal((await fixture.invocations())[0].codexHome, join(dirname(fixture.repo), 'codex-home'));
  assert.ok(!payload.includes('event-secret'));
});

test('Codex item errors redact every account environment value before persistence', async (t) => {
  const fixture = await bootCodex(t, { env: { WORKSPACE_LABEL: 'customer-internal-42' } });
  const created = await fixture.create('non-credential-env-echo');
  await fixture.waitForSession(created.id, (session) => session.status === 'done');
  const session = fixture.registry.get(created.id)!;
  const error = session.transcript.find((msg) => msg.kind === 'error');

  assert.deepEqual(error, { kind: 'error', text: 'fake backend error for workspace [REDACTED]' });
  assert.ok(!JSON.stringify(session.transcript).includes('customer-internal-42'));

  const events = await fetch(`${fixture.base}/events`);
  const reader = events.body!.getReader();
  const payload = new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  assert.match(payload, /fake backend error for workspace \[REDACTED\]/);
  assert.ok(!payload.includes('customer-internal-42'));
});

test('a short account environment value does not redact ordinary transcript text', async (t) => {
  const fixture = await bootCodex(t, { env: { WORKSPACE_LABEL: 'info' } });
  const created = await fixture.create('non-credential-env-echo');
  await fixture.waitForSession(created.id, (session) => session.status === 'done');

  assert.deepEqual(fixture.registry.get(created.id)!.transcript.find((msg) => msg.kind === 'error'),
    { kind: 'error', text: 'fake backend error for workspace info' });
});

test('Codex lifecycle upserts redact long ordinary launch values before Registry admission', async (t) => {
  const secret = 'customer-internal-42';
  const fixture = await bootCodex(t, { env: { WORKSPACE_LABEL: secret } });
  const created = await fixture.create('ordinary-env-rich-lifecycle');
  await fixture.waitForSession(created.id, (session) => session.status === 'done');
  await fixture.registry.save();
  const session = fixture.registry.get(created.id)!;
  const transcriptText = JSON.stringify(session.transcript);
  const command = session.transcript.find((message) => message.kind === 'tool' && message.id === 'rich-command');
  const mcp = session.transcript.find((message) => message.kind === 'tool' && message.id === 'rich-mcp');
  const reasoning = session.transcript.find((message) => message.kind === 'reasoning');
  const todo = session.transcript.find((message) => message.kind === 'todo');

  assert.ok(command?.kind === 'tool');
  assert.deepEqual({ id: command.id, name: command.name, summary: command.summary }, {
    id: 'rich-command', name: 'shell', summary: 'npm test [REDACTED]',
  });
  assert.ok(mcp?.kind === 'tool');
  assert.deepEqual({ id: mcp.id, name: mcp.name, summary: mcp.summary }, {
    id: 'rich-mcp', name: 'rich-[REDACTED]', summary: 'fake-[REDACTED].rich-[REDACTED]',
  });
  assert.deepEqual(reasoning, {
    kind: 'reasoning', id: 'rich-reasoning', text: 'Verified the lifecycle [REDACTED]',
  });
  assert.deepEqual(todo, {
    kind: 'todo', id: 'rich-todo', items: [
      { text: 'Inspect events [REDACTED]', completed: true },
      { text: 'Run tests [REDACTED]', completed: true },
    ],
  });
  assert.ok(!transcriptText.includes(secret));

  for (const item of ['rich-command', 'rich-mcp', 'rich-file']) {
    const response = await fetch(`${fixture.base}/detail?session=${created.id}&item=${item}`);
    assert.equal(response.status, 200);
    const detail = JSON.stringify(await response.json());
    assert.ok(!detail.includes(secret), item);
    assert.match(detail, /\[REDACTED\]/, item);
  }
  const events = await fetch(`${fixture.base}/events`);
  const reader = events.body!.getReader();
  const payload = new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  assert.ok(!payload.includes(secret));
  assert.ok(!await readFile(fixture.statePath, 'utf8').then((text) => text.includes(secret)));
});

test('a vendor session id that matches an account value is still resumable', async (t) => {
  const fixture = await bootCodex(t, { env: { THREAD_LABEL: 'fake-thread' } });
  const created = await fixture.create('first');
  await fixture.waitForSession(created.id, (session) => session.status === 'done');
  assert.equal(fixture.registry.get(created.id)!.vendorSessionId, 'fake-thread');

  await fixture.command({ cmd: 'stop', id: created.id });
  await fixture.waitForSession(created.id, (session) => session.status === 'stopped');
  assert.equal((await fixture.command({ cmd: 'resume', id: created.id })).status, 200);
  await waitFor(async () => (await fixture.invocations()).length === 2);

  const resumed = (await fixture.invocations())[1].argv;
  assert.deepEqual(resumed.slice(resumed.indexOf('resume'), resumed.indexOf('resume') + 2),
    ['resume', 'fake-thread']);
});

test('Codex preserves repository instructions and leaves non-safety configuration to the repo', async (t) => {
  const fixture = await bootCodex(t);
  const agents = join(fixture.repo, 'AGENTS.md');
  const configDir = join(fixture.repo, '.codex');
  const config = join(configDir, 'config.toml');
  await run('git', ['worktree', 'prune'], { cwd: fixture.repo });
  await writeFile(agents, 'project instructions\\n');
  await mkdir(configDir);
  await writeFile(config, 'model = "repo-choice"\\n');
  await run('git', ['add', 'AGENTS.md', '.codex/config.toml'], { cwd: fixture.repo });
  await run('git', ['commit', '-m', 'add Codex config'], { cwd: fixture.repo });
  const before = await Promise.all([readFile(agents), readFile(config)]);

  const created = await fixture.create('configured');
  await fixture.waitForSession(created.id, (session) => session.status === 'done');

  assert.deepEqual(await Promise.all([readFile(agents), readFile(config)]), before);
  const args = (await fixture.invocations()).at(-1)!.argv;
  assert.ok(!args.filter((_, index) => args[index - 1] !== '--cd')
    .some((arg) => /--model|reasoning|web_search|mcp|network|repo|instruction/i.test(arg)));
});

test('GET / serves the app shell', async (t) => {
  const { base } = await boot(t);
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  assert.match(await res.text(), /<title>Switchboard<\/title>/);
});

test('the fonts are served, and the allowlist is still exact-match', async (t) => {
  const { base } = await boot(t);
  for (const name of ['inter.woff2', 'garamond.woff2']) {
    const res = await fetch(`${base}/${name}`);
    assert.equal(res.status, 200, name);
    assert.equal(res.headers.get('content-type'), 'font/woff2');
    // wOF2 — a real font, not an HTML error page with a font content-type.
    const bytes = new Uint8Array(await res.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 4)], [0x77, 0x4f, 0x46, 0x32]);
  }
  // The fonts are flat in web/ precisely so no path segment is ever joined.
  // Paths use encoded separators not dots, since fetch normalizes plain /../
  // away before the server sees it; these survive to test the allowlist guard.
  for (const path of ['/fonts/inter.woff2', '/..%2fpackage.json', '/web%2f..%2finter.woff2']) {
    assert.equal((await fetch(`${base}${path}`)).status, 404, path);
  }
});

test('GET /events opens an SSE stream with an immediate snapshot', async (t) => {
  const { base, registry } = await boot(t);
  registry.create({
    provider: 'claude', account: 'claude-main', repo: '/r',
    cwd: '/r/wt', branch: 'b', title: 'a title',
  });

  const res = await fetch(`${base}/events`);
  assert.equal(res.headers.get('content-type'), 'text/event-stream');

  const reader = res.body!.getReader();
  // try/finally, not a bare await at the end: if the assertion throws, an
  // uncancelled reader leaves the SSE fetch open, and boot()'s t.after
  // (server.close()) waits for that connection to end before it resolves — so
  // node --test hangs on a failure here instead of reporting one.
  try {
    const chunk = new TextDecoder().decode((await reader.read()).value);
    assert.match(chunk, /^data: /m);
    const payload = JSON.parse(chunk.replace(/^data: /, '').trim());
    assert.equal(payload.sessions.length, 1);
    assert.equal(payload.sessions[0].title, 'a title');
    assert.equal(payload.accounts[0].name, 'claude-main');
  } finally {
    await reader.cancel();
  }
});

test('the SSE snapshot carries the current settings', async (t) => {
  const { base, registry } = await boot(t);
  registry.setSettings({ sort: 'newest' });
  const snap = await firstSnapshot(base);
  assert.equal(snap.settings.sort, 'newest');
  assert.equal(snap.settings.autoApprove, false);
});

test('POST /command settings applies a valid patch and rejects an invalid one before mutating', async (t) => {
  // parseSettingsPatch and Registry.setSettings each have their own unit
  // tests, but nothing else exercises the wiring between them: that the
  // `settings` case reads `body.patch` (not `body` itself), and that a 400
  // short-circuits before setSettings ever runs.
  const { base, registry } = await boot(t);
  const ok = await fetch(`${base}/command`, {
    method: 'POST',
    body: JSON.stringify({ cmd: 'settings', patch: { sort: 'newest' } }),
  });
  assert.equal(ok.status, 200);
  assert.equal(registry.settings().sort, 'newest');

  const bad = await fetch(`${base}/command`, {
    method: 'POST',
    body: JSON.stringify({ cmd: 'settings', patch: { sandboxMode: 'danger-full-access' } }),
  });
  assert.equal(bad.status, 400);
  assert.equal(registry.settings().sort, 'newest', 'the 400 must short-circuit before setSettings runs');
});

test('SSE projects tool metadata while GET /detail lazily returns the body', async (t) => {
  const { base, registry } = await boot(t);
  const session = registry.create({
    provider: 'codex', account: 'codex', repo: '/r',
    cwd: '/r/wt', branch: 'b', title: 'detail',
  });
  registry.apply(session.id, { type: 'upsert-msg', msg: {
    kind: 'tool', id: 'cmd-1', name: 'shell', summary: 'command', status: 'ok',
    detail: 'DETAIL_SENTINEL', detailTruncated: false,
  } });

  const events = await fetch(`${base}/events`);
  const reader = events.body!.getReader();
  try {
    const chunk = new TextDecoder().decode((await reader.read()).value);
    assert.doesNotMatch(chunk, /DETAIL_SENTINEL/);
    const payload = JSON.parse(chunk.replace(/^data: /, '').trim());
    assert.deepEqual(payload.sessions[0].transcript[0], {
      kind: 'tool', id: 'cmd-1', name: 'shell', summary: 'command', status: 'ok',
      detailAvailable: true, detailTruncated: false, detailEvicted: false, detailRevision: 1,
    });
  } finally {
    await reader.cancel();
  }

  const response = await fetch(
    `${base}/detail?session=${encodeURIComponent(session.id)}&item=${encodeURIComponent('cmd-1')}`,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {
    text: 'DETAIL_SENTINEL', truncated: false, evicted: false, revision: 1,
  });
});

test('GET /detail returns 404 for unknown session, item, and non-tool ids', async (t) => {
  const { base, registry } = await boot(t);
  const session = registry.create({
    provider: 'codex', account: 'codex', repo: '/r',
    cwd: '/r/wt', branch: 'b', title: 'detail',
  });
  registry.apply(session.id, {
    type: 'upsert-msg', msg: { kind: 'reasoning', id: 'reasoning-1', text: 'summary' },
  });

  for (const query of [
    `session=missing&item=reasoning-1`,
    `session=${encodeURIComponent(session.id)}&item=missing`,
    `session=${encodeURIComponent(session.id)}&item=reasoning-1`,
  ]) {
    const response = await fetch(`${base}/detail?${query}`);
    assert.equal(response.status, 404, query);
  }
});

test('GET /detail returns metadata for evicted and never-populated tool bodies', async (t) => {
  const { base, registry } = await boot(t, { maxTotalDetailBytes: 5 });
  const session = registry.create({
    provider: 'codex', account: 'codex', repo: '/r',
    cwd: '/r/wt', branch: 'b', title: 'detail',
  });
  registry.apply(session.id, { type: 'upsert-msg', msg: {
    kind: 'tool', id: 'evicted', name: 'shell', summary: 'large', status: 'ok', detail: '123456',
  } });
  registry.apply(session.id, { type: 'upsert-msg', msg: {
    kind: 'tool', id: 'empty', name: 'shell', summary: 'running', status: 'running',
  } });

  const evicted = await fetch(
    `${base}/detail?session=${encodeURIComponent(session.id)}&item=evicted`,
  );
  assert.equal(evicted.status, 200);
  assert.deepEqual(await evicted.json(), {
    text: null, truncated: false, evicted: true, revision: 2,
  });

  const empty = await fetch(
    `${base}/detail?session=${encodeURIComponent(session.id)}&item=empty`,
  );
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), {
    text: null, truncated: false, evicted: false, revision: 0,
  });
});

test('GET /detail ignores a client path and resolves only Registry keys', async (t) => {
  const { base, registry } = await boot(t);
  const dir = await mkdtemp(join(tmpdir(), 'sb-client-detail-path-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const clientPath = join(dir, 'secret.txt');
  await writeFile(clientPath, 'PATH_SENTINEL');
  const session = registry.create({
    provider: 'codex', account: 'codex', repo: '/r',
    cwd: '/r/wt', branch: 'b', title: 'detail',
  });
  registry.apply(session.id, { type: 'upsert-msg', msg: {
    kind: 'tool', id: 'empty', name: 'shell', summary: 'running', status: 'running',
  } });

  const response = await fetch(
    `${base}/detail?session=${encodeURIComponent(session.id)}&item=empty&path=${encodeURIComponent(clientPath)}`,
  );
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.doesNotMatch(body, /PATH_SENTINEL/);
  assert.deepEqual(JSON.parse(body), {
    text: null, truncated: false, evicted: false, revision: 0,
  });
});

test('GET /detail with a foreign Host is rejected', async (t) => {
  const { base } = await boot(t);
  const response = await rawRequest(new URL(`${base}/detail`), {
    method: 'GET', headers: { host: 'evil.example:9999' },
  });
  assert.equal(response.status, 403);
});

test('POST /command with an unknown cmd is a 400', async (t) => {
  const { base } = await boot(t);
  const res = await fetch(`${base}/command`, {
    method: 'POST',
    body: JSON.stringify({ cmd: 'nonsense' }),
  });
  assert.equal(res.status, 400);
});

test('POST /command create rejects a repo that is not a git repo', async (t) => {
  const { base, registry } = await boot(t);
  const res = await fetch(`${base}/command`, {
    method: 'POST',
    body: JSON.stringify({
      cmd: 'create', repo: '/definitely/not/a/repo',
      branch: 'x', account: 'claude-main', prompt: 'hi',
    }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /not a git repository/i);
  assert.equal(registry.all().length, 0, 'no orphan session may be created');
});

test('POST /command with a mismatched Origin is rejected and has no effect', async (t) => {
  const { base, registry } = await boot(t);
  const s = registry.create({
    provider: 'claude', account: 'claude-main', repo: '/r',
    cwd: '/r/wt', branch: 'b', title: 't',
  });
  const res = await fetch(`${base}/command`, {
    method: 'POST',
    headers: { origin: 'https://evil.example' },
    body: JSON.stringify({ cmd: 'delete', id: s.id, removeWorktree: false }),
  });
  assert.equal(res.status, 403);
  assert.equal(registry.all().length, 1, 'a rejected request must not have deleted the session');
});

test('POST /command with a foreign Host is rejected and has no effect', async (t) => {
  const { base, registry } = await boot(t);
  const s = registry.create({
    provider: 'claude', account: 'claude-main', repo: '/r',
    cwd: '/r/wt', branch: 'b', title: 't',
  });
  const res = await rawRequest(new URL(`${base}/command`), {
    method: 'POST',
    headers: { host: 'evil.example:9999', 'content-type': 'application/json' },
    body: JSON.stringify({ cmd: 'delete', id: s.id, removeWorktree: false }),
  });
  assert.equal(res.status, 403);
  assert.equal(registry.all().length, 1, 'a rejected request must not have deleted the session');
});

test('GET /events with a foreign Host is rejected', async (t) => {
  const { base } = await boot(t);
  const res = await rawRequest(new URL(`${base}/events`), {
    method: 'GET',
    headers: { host: 'evil.example:9999' },
  });
  assert.equal(res.status, 403);
});

test('GET /repos with a foreign Host is rejected', async (t) => {
  const { base } = await boot(t);
  const res = await rawRequest(new URL(`${base}/repos`), {
    method: 'GET',
    headers: { host: 'evil.example:9999' },
  });
  assert.equal(res.status, 403, '/repos returns decoded local repo paths; it needs the guard too');
});

test('POST /command send to a session with no live agent is not a 200', async (t) => {
  const { base, registry } = await boot(t);
  const s = registry.create({
    provider: 'claude', account: 'claude-main', repo: '/r',
    cwd: '/r/wt', branch: 'b', title: 't',
  });
  registry.apply(s.id, { type: 'stopped', reason: 'exit 1' });

  const res = await fetch(`${base}/command`, {
    method: 'POST',
    body: JSON.stringify({ cmd: 'send', id: s.id, text: 'hi' }),
  });
  assert.equal(res.status, 404, 'a 200 here means the prompt was silently dropped');
  assert.deepEqual(registry.get(s.id)!.transcript, [], 'and nothing was appended');
});

test('POST /command resume is rejected unless the session is stopped', async (t) => {
  const { base, registry } = await boot(t);
  const s = registry.create({
    provider: 'claude', account: 'claude-main', repo: '/r',
    cwd: '/r/wt', branch: 'b', title: 't',
  });
  assert.equal(registry.get(s.id)!.status, 'working');

  const res = await fetch(`${base}/command`, {
    method: 'POST',
    body: JSON.stringify({ cmd: 'resume', id: s.id }),
  });
  assert.equal(res.status, 409, 'resume must not launch a second agent into a live worktree');
  assert.equal(registry.get(s.id)!.status, 'working', 'and must not have revived anything');
});

test('POST /command delete removes the session', async (t) => {
  const { base, registry } = await boot(t);
  const s = registry.create({
    provider: 'claude', account: 'claude-main', repo: '/r',
    cwd: '/r/wt', branch: 'b', title: 't',
  });
  const res = await fetch(`${base}/command`, {
    method: 'POST',
    body: JSON.stringify({ cmd: 'delete', id: s.id, removeWorktree: false }),
  });
  assert.equal(res.status, 200);
  assert.equal(registry.all().length, 0);
});

// ---- merge / push --------------------------------------------------------

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sb-'));
  await run('git', ['init', '-b', 'main'], { cwd: dir });
  await run('git', ['config', 'user.email', 't@t.t'], { cwd: dir });
  await run('git', ['config', 'user.name', 'T'], { cwd: dir });
  await writeFile(join(dir, 'a.txt'), 'one\n');
  await run('git', ['add', '.'], { cwd: dir });
  await run('git', ['commit', '-m', 'init'], { cwd: dir });
  return dir;
}

test('POST /command merge rejects worktrees selected from two different repos', async (t) => {
  const { base, registry } = await boot(t);
  const a = registry.create({
    provider: 'claude', account: 'claude-main', repo: '/repo-a',
    cwd: '/repo-a/wt', branch: 'x', title: 'x',
  });
  const b = registry.create({
    provider: 'claude', account: 'claude-main', repo: '/repo-b',
    cwd: '/repo-b/wt', branch: 'y', title: 'y',
  });
  registry.apply(a.id, { type: 'stopped', reason: 'done' });
  registry.apply(b.id, { type: 'stopped', reason: 'done' });

  const res = await fetch(`${base}/command`, {
    method: 'POST',
    body: JSON.stringify({ cmd: 'merge', ids: [a.id, b.id] }),
  });

  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /different repos/i);
});

test('POST /command merge rejects a session that is still working', async (t) => {
  const { base, registry } = await boot(t);
  const s = registry.create({
    provider: 'claude', account: 'claude-main', repo: '/r',
    cwd: '/r/wt', branch: 'b', title: 't',
  });
  assert.equal(registry.get(s.id)!.status, 'working');

  const res = await fetch(`${base}/command`, {
    method: 'POST',
    body: JSON.stringify({ cmd: 'merge', ids: [s.id] }),
  });

  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /still running/i);
});

test('POST /command push rejects worktrees selected from two different repos', async (t) => {
  const { base, registry } = await boot(t);
  const a = registry.create({
    provider: 'claude', account: 'claude-main', repo: '/repo-a',
    cwd: '/repo-a/wt', branch: 'x', title: 'x',
  });
  const b = registry.create({
    provider: 'claude', account: 'claude-main', repo: '/repo-b',
    cwd: '/repo-b/wt', branch: 'y', title: 'y',
  });

  const res = await fetch(`${base}/command`, {
    method: 'POST',
    body: JSON.stringify({ cmd: 'push', ids: [a.id, b.id] }),
  });

  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /different repos/i);
});

test('POST /command merge then push: end to end against a real repo and remote', async (t) => {
  const { base, registry } = await boot(t);
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const remote = await mkdtemp(join(tmpdir(), 'sb-remote-'));
  t.after(() => rm(remote, { recursive: true, force: true }));
  await run('git', ['init', '--bare', '-b', 'main'], { cwd: remote });
  await run('git', ['remote', 'add', 'origin', remote], { cwd: repo });

  const cwd = await createWorktree(repo, 'feat/ship');
  await writeFile(join(cwd, 'ship.txt'), 'payload\n');
  // Left uncommitted on purpose: merge is supposed to pick up outstanding work.

  const s = registry.create({
    provider: 'claude', account: 'claude-main', repo, cwd, branch: 'feat/ship', title: 'feat/ship',
  });
  registry.apply(s.id, { type: 'stopped', reason: 'done' });

  const mergeRes = await fetch(`${base}/command`, {
    method: 'POST',
    body: JSON.stringify({ cmd: 'merge', ids: [s.id] }),
  });
  assert.equal(mergeRes.status, 200);
  const mergeBody = await mergeRes.json();
  assert.deepEqual(mergeBody.merged, ['feat/ship']);
  assert.equal(mergeBody.target, 'main');

  const pushRes = await fetch(`${base}/command`, {
    method: 'POST',
    body: JSON.stringify({ cmd: 'push', ids: [s.id] }),
  });
  assert.equal(pushRes.status, 200);

  // `cwd: remote` would fail here: git refuses to run inside a bare repo via
  // plain cwd discovery (safe.bareRepository) unless told explicitly.
  const { stdout } = await run('git', ['--git-dir=' + remote, 'show', 'main:ship.txt']);
  assert.equal(stdout, 'payload\n', 'the merged file should have reached the remote');
});

test('POST /upload writes the file into the session worktree', async (t) => {
  const { base, registry } = await boot(t);
  const wt = await mkdtemp(join(tmpdir(), 'sb-wt-'));
  t.after(() => rm(wt, { recursive: true, force: true }));
  const s = registry.create({
    provider: 'claude', account: 'claude-main', repo: '/r',
    cwd: wt, branch: 'b', title: 't',
  });

  const res = await fetch(`${base}/upload?id=${s.id}&name=notes.txt`, {
    method: 'POST',
    body: 'hello file',
  });

  assert.equal(res.status, 200);
  const body = await res.json() as { path: string };
  assert.match(body.path, /^\.switchboard-upload-[0-9a-f]{32}-notes\.txt$/);
  assert.equal(await readFile(join(wt, body.path), 'utf8'), 'hello file');
});

test('POST /upload rejects a filename that escapes the worktree', async (t) => {
  const { base, registry } = await boot(t);
  const wt = await mkdtemp(join(tmpdir(), 'sb-wt-'));
  t.after(() => rm(wt, { recursive: true, force: true }));
  const s = registry.create({
    provider: 'claude', account: 'claude-main', repo: '/r',
    cwd: wt, branch: 'b', title: 't',
  });
  // Unique so a leftover file from an earlier run can never make this pass.
  const escapee = `escaped-${s.id}.txt`;

  const res = await fetch(
    `${base}/upload?id=${s.id}&name=${encodeURIComponent(`../${escapee}`)}`,
    { method: 'POST', body: 'pwned' },
  );

  assert.equal(res.status, 400);
  await assert.rejects(
    stat(join(dirname(wt), escapee)),
    'a rejected name must not have written anything outside the worktree',
  );
});

test('POST /upload refuses to follow a symlinked uploads directory', async (t) => {
  const { base, registry } = await boot(t);
  const wt = await mkdtemp(join(tmpdir(), 'sb-wt-'));
  t.after(() => rm(wt, { recursive: true, force: true }));
  const outside = await mkdtemp(join(tmpdir(), 'sb-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  // Simulates a tracked symlink materialized by `git worktree add` from an
  // untrusted branch: uploads/ points somewhere outside the worktree entirely.
  await symlink(outside, join(wt, 'uploads'));
  const s = registry.create({
    provider: 'claude', account: 'claude-main', repo: '/r',
    cwd: wt, branch: 'b', title: 't',
  });

  const res = await fetch(`${base}/upload?id=${s.id}&name=notes.txt`, {
    method: 'POST',
    body: 'pwned',
  });

  assert.equal(res.status, 400);
  await assert.rejects(
    stat(join(outside, 'notes.txt')),
    'a refused upload must not have written anything into the symlink target',
  );
});

// Two predecessors of this test proved nothing. The first swapped `wt/uploads`,
// a directory the upload path stopped using once uploads moved to a direct child
// of the root. The second swapped the root after open(), where the pre-existing
// target-inode check already returns 409 on its own. The window that was really
// unguarded is earlier: between the lstat() that validates the root and the point
// the root's identity is pinned, a swap there gets the attacker's directory
// pinned as if it were the worktree, and every later check then agrees with it.
test('POST /upload refuses when the worktree root is swapped before its identity is pinned', async (t) => {
  let atPin!: () => void;
  let releasePin!: () => void;
  const reachedPin = new Promise<void>((resolve) => { atPin = resolve; });
  const pinHeld = new Promise<void>((resolve) => { releasePin = resolve; });
  const { base, registry } = await boot(t, undefined, {
    beforeUploadRootPin: async () => { atPin(); await pinHeld; },
  });
  // realpath() up front: macOS resolves /var to /private/var and the server works
  // from the canonical root, so the swap has to land on the path it resolved.
  const wt = await realpath(await mkdtemp(join(tmpdir(), 'sb-wt-pin-race-')));
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'sb-outside-pin-race-')));
  const moved = `${wt}-moved`;
  t.after(() => rm(moved, { recursive: true, force: true }));
  t.after(() => rm(wt, { recursive: true, force: true }));
  const s = registry.create({
    provider: 'claude', account: 'claude-main', repo: '/r',
    cwd: wt, branch: 'b', title: 't',
  });

  const upload = fetch(`${base}/upload?id=${s.id}&name=notes.txt`, {
    method: 'POST', body: 'must never land under a foreign root',
  });
  await Promise.race([
    reachedPin,
    upload.then(() => { throw new Error('the root was pinned before the deterministic barrier'); }),
  ]);
  // A real directory before and after, so only a dev/ino comparison against the
  // validating lstat() catches it — re-reading the root here pins the swap.
  await rename(wt, moved);
  await rename(outside, wt);
  releasePin();
  const response = await upload;

  assert.equal(response.status, 409);
  assert.deepEqual(await readdir(wt), [],
    'the directory swapped in as the root must receive no file at all');
  assert.deepEqual(await readdir(moved), [],
    'and the refusal happens before open(), so the real worktree gets nothing either');
});

test('POST /upload writes through its opened file, never a swapped outside symlink', async (t) => {
  let reached!: (target: string) => void;
  let release!: () => void;
  const opened = new Promise<string>((resolve) => { reached = resolve; });
  const continueWrite = new Promise<void>((resolve) => { release = resolve; });
  const { base, registry } = await boot(t, undefined, {
    beforeUploadWrite: async (target) => {
      reached(target);
      await continueWrite;
    },
  });
  const wt = await mkdtemp(join(tmpdir(), 'sb-wt-leaf-race-'));
  const outside = join(dirname(wt), `outside-${Date.now()}-${Math.random()}.txt`);
  t.after(() => rm(wt, { recursive: true, force: true }));
  t.after(() => rm(outside, { force: true }));
  await writeFile(outside, 'outside sentinel');
  await mkdir(join(wt, 'uploads'));
  const s = registry.create({
    provider: 'claude', account: 'claude-main', repo: '/r',
    cwd: wt, branch: 'b', title: 't',
  });

  const upload = fetch(`${base}/upload?id=${s.id}&name=notes.txt`, {
    method: 'POST', body: 'must stay contained',
  });
  const target = await Promise.race([
    opened,
    upload.then(() => { throw new Error('upload wrote before the deterministic race barrier'); }),
  ]);
  await rm(target, { force: true });
  await symlink(outside, target);
  release();
  const response = await upload;

  assert.equal(response.status, 409);
  assert.equal(await readFile(outside, 'utf8'), 'outside sentinel');
});

test('POST /command auto sets the flag on a stopped session, which has no live handle', async (t) => {
  const { base, registry } = await boot(t);
  const s = registry.create({
    provider: 'claude', account: 'claude-main', repo: '/r',
    cwd: '/r/wt', branch: 'b', title: 't',
  });
  registry.apply(s.id, { type: 'stopped', reason: 'done' });
  assert.equal(registry.get(s.id)!.auto, false, 'sessions start off, not on');

  const res = await fetch(`${base}/command`, {
    method: 'POST',
    body: JSON.stringify({ cmd: 'auto', id: s.id, auto: true }),
  });

  assert.equal(res.status, 200);
  // The point of setting it registry-side: no handle exists here, and the flag
  // still has to stick so the next resume() launches with auto already on.
  assert.equal(registry.get(s.id)!.auto, true);
});

test('GET /graph returns the laid-out commits for a session', async (t) => {
  const { base, registry } = await boot(t);
  const dir = await mkdtemp(join(tmpdir(), 'sb-repo-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await run('git', ['init', '-b', 'main'], { cwd: dir });
  await run('git', ['config', 'user.email', 't@t.t'], { cwd: dir });
  await run('git', ['config', 'user.name', 'T'], { cwd: dir });
  await writeFile(join(dir, 'a.txt'), 'one\n');
  await run('git', ['add', '.'], { cwd: dir });
  await run('git', ['commit', '-m', 'init'], { cwd: dir });

  const s = registry.create({
    provider: 'claude', account: 'claude-main', repo: dir,
    cwd: dir, branch: 'main', title: 't',
  });

  const res = await fetch(`${base}/graph?id=${s.id}`);
  assert.equal(res.status, 200);
  const commits = await res.json();
  assert.equal(commits.length, 1);
  assert.equal(commits[0].subject, 'init');
  assert.equal(commits[0].lane, 0);
  assert.ok(commits[0].refs.includes('HEAD -> main'));
});

test('GET /graph for an unknown session is a 404, not a crash', async (t) => {
  const { base } = await boot(t);
  const res = await fetch(`${base}/graph?id=nope`);
  assert.equal(res.status, 404);
});

test('GET /graph is behind the Host guard like every other route', async (t) => {
  const { base } = await boot(t);
  const res = await rawRequest(new URL(`${base}/graph?id=nope`), {
    method: 'GET', headers: { Host: 'evil.example' },
  });
  assert.equal(res.status, 403);
});

// ---- schedule / unschedule ------------------------------------------------

function post(base: string, body: unknown) {
  return fetch(`${base}/command`, { method: 'POST', body: JSON.stringify(body) });
}

test('scheduling a create returns an id and puts it in the queue', async (t) => {
  const { base, scheduler } = await boot(t);
  const res = await post(base, {
    cmd: 'schedule',
    trigger: { kind: 'at', time: Date.now() + 3600_000 },
    action: { kind: 'create', repo: process.cwd(), branch: 'b', account: 'claude-main', prompt: 'go' },
  });
  assert.equal(res.status, 200);
  assert.ok((await res.json()).id);
  assert.equal(scheduler.all().length, 1);
});

test('scheduling a Codex create preserves its inherited-by-default thread settings', async (t) => {
  const { base, scheduler } = await boot(t);
  const res = await post(base, {
    cmd: 'schedule',
    trigger: { kind: 'at', time: Date.now() + 3600_000 },
    action: {
      kind: 'create', repo: process.cwd(), branch: 'b', account: 'codex', prompt: 'go',
      codexSettings: { modelReasoningEffort: 'high', networkAccessEnabled: false },
    },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(scheduler.all()[0].action, {
    kind: 'create', repo: process.cwd(), branch: 'b', account: 'codex', prompt: 'go',
    codexSettings: { modelReasoningEffort: 'high', networkAccessEnabled: false },
  });
});

test('a reset trigger takes its account from the action, not the client', async (t) => {
  const { base, scheduler } = await boot(t, undefined, {
    limitCoordinator: fakeLimitCoordinator({ eligibility: { eligible: true, resetsAt: Date.now() + 3600_000 } }),
  });
  await post(base, {
    cmd: 'schedule',
    trigger: { kind: 'reset', account: 'attacker-supplied' },
    action: { kind: 'create', repo: process.cwd(), branch: 'b', account: 'codex', prompt: 'go' },
  });
  assert.deepEqual(scheduler.all()[0].trigger, { kind: 'reset', account: 'codex' });
  assert.equal((scheduler.all()[0].action as unknown as { resetProvider?: string }).resetProvider, 'codex');
});

test('a Codex reset schedule requires fresh provider eligibility while Claude reset schedules remain available', async (t) => {
  const unavailable = fakeLimitCoordinator({ eligibility: { eligible: false, reason: 'no fresh Codex usage window' } });
  const { base, scheduler } = await boot(t, undefined, { limitCoordinator: unavailable });

  const codex = await post(base, {
    cmd: 'schedule', trigger: { kind: 'reset' },
    action: { kind: 'create', repo: process.cwd(), branch: 'codex-reset', account: 'codex', prompt: 'go' },
  });
  assert.equal(codex.status, 400);
  assert.deepEqual(await codex.json(), {
    error: 'Codex reset scheduling is unavailable: no fresh Codex usage window',
  });

  const claude = await post(base, {
    cmd: 'schedule', trigger: { kind: 'reset' },
    action: { kind: 'create', repo: process.cwd(), branch: 'claude-reset', account: 'claude-main', prompt: 'go' },
  });
  assert.equal(claude.status, 200);
  assert.deepEqual(scheduler.all().map((item) => item.trigger), [{ kind: 'reset', account: 'claude-main' }]);
  assert.equal((scheduler.all()[0].action as unknown as { resetProvider?: string }).resetProvider, 'claude');
});

test('Codex reset schedule reports real authoritative ineligibility states', async (t) => {
  const now = Date.now();
  const window = (usedPercent: number, resetsAt: number | null) => ({
    id: 'default:primary', label: '5h', usedPercent, windowDurationMins: 300,
    resetsAt, reached: usedPercent >= 100,
  });
  const cases = [
    { name: 'absent', arrange: (_usage: Usage) => {}, reason: 'no fresh authoritative limit snapshot' },
    {
      name: 'stale',
      arrange: (usage: Usage) => {
        usage.setLimitSnapshot('codex', { plan: 'pro', windows: [window(100, now + 3600_000)], blocks: [], fetchedAt: now, authoritative: true, fresh: true });
        usage.failLimitSnapshot('codex', 'temporarily unavailable');
      },
      reason: 'no fresh authoritative limit snapshot',
    },
    {
      name: 'unsupported', arrange: (usage: Usage) => usage.failLimitSnapshot('codex', 'managed ChatGPT auth required'),
      reason: 'no fresh authoritative limit snapshot',
    },
    {
      name: 'not-reached',
      arrange: (usage: Usage) => usage.setLimitSnapshot('codex', { plan: 'pro', windows: [window(99, now + 3600_000)], blocks: [], fetchedAt: now, authoritative: true, fresh: true }),
      reason: 'no reached limit window',
    },
    {
      name: 'null-reset',
      arrange: (usage: Usage) => usage.setLimitSnapshot('codex', { plan: 'pro', windows: [window(100, null)], blocks: [], fetchedAt: now, authoritative: true, fresh: true }),
      reason: 'a reached limit window has no future reset',
    },
    {
      name: 'past-reset',
      arrange: (usage: Usage) => usage.setLimitSnapshot('codex', { plan: 'pro', windows: [window(100, now - 1)], blocks: [], fetchedAt: now, authoritative: true, fresh: true }),
      reason: 'a reached limit window has no future reset',
    },
    {
      name: 'credit-block',
      arrange: (usage: Usage) => usage.setLimitSnapshot('codex', { plan: 'pro', windows: [window(100, now + 3600_000)], blocks: [{ id: 'default', reason: 'workspace_owner_credits_depleted', resettable: false }], fetchedAt: now, authoritative: true, fresh: true }),
      reason: 'a provider block cannot be reset automatically',
    },
    {
      name: 'workspace-block',
      arrange: (usage: Usage) => usage.setLimitSnapshot('codex', { plan: 'pro', windows: [window(100, now + 3600_000)], blocks: [{ id: 'default', reason: 'workspace_member_usage_limit_reached', resettable: false }], fetchedAt: now, authoritative: true, fresh: true }),
      reason: 'a provider block cannot be reset automatically',
    },
    {
      name: 'spend-block',
      arrange: (usage: Usage) => usage.setLimitSnapshot('codex', { plan: 'pro', windows: [window(100, now + 3600_000)], blocks: [{ id: 'default', reason: 'spend_control_reached', resettable: false }], fetchedAt: now, authoritative: true, fresh: true }),
      reason: 'a provider block cannot be reset automatically',
    },
  ] as const;

  for (const entry of cases) {
    const usage = new Usage();
    entry.arrange(usage);
    const limitCoordinator = realEligibilityCoordinator(usage, now);
    const { base, scheduler } = await boot(t, undefined, { limitCoordinator, usage });
    const res = await post(base, {
      cmd: 'schedule', trigger: { kind: 'reset' },
      action: { kind: 'create', repo: process.cwd(), branch: `blocked-${entry.name}`, account: 'codex', prompt: 'go' },
    });
    assert.equal(res.status, 400, entry.name);
    assert.deepEqual(await res.json(), { error: `Codex reset scheduling is unavailable: ${entry.reason}` });
    assert.equal(scheduler.all().length, 0, `${entry.name} must not create reset work`);
  }
});

test('eligible Codex reset scheduling ignores a browser-supplied reset timestamp', async (t) => {
  const now = Date.now();
  const providerReset = now + 3600_000;
  const browserReset = now + 99 * 3600_000;
  const usage = new Usage();
  usage.setLimitSnapshot('codex', {
    plan: 'pro', fetchedAt: now, authoritative: true, fresh: true, blocks: [],
    windows: [{ id: 'default:primary', label: '5h', usedPercent: 100, windowDurationMins: 300, resetsAt: providerReset, reached: true }],
  });
  const limitCoordinator = realEligibilityCoordinator(usage, now);
  const { base, scheduler } = await boot(t, undefined, { limitCoordinator, usage });

  const res = await post(base, {
    cmd: 'schedule', trigger: { kind: 'reset', time: browserReset },
    action: { kind: 'create', repo: process.cwd(), branch: 'eligible-reset', account: 'codex', prompt: 'go' },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(scheduler.all()[0].trigger, { kind: 'reset', account: 'codex' });
  assert.equal(Object.hasOwn(scheduler.all()[0].trigger, 'time'), false);
});

test('scheduling rejects an unknown account', async (t) => {
  const { base } = await boot(t);
  const res = await post(base, {
    cmd: 'schedule',
    trigger: { kind: 'at', time: Date.now() },
    action: { kind: 'create', repo: process.cwd(), branch: 'b', account: 'nope', prompt: 'go' },
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /unknown account/);
});

test('scheduling rejects a repo that is not a directory', async (t) => {
  const { base } = await boot(t);
  const res = await post(base, {
    cmd: 'schedule',
    trigger: { kind: 'at', time: Date.now() },
    action: { kind: 'create', repo: '/no/such/place', branch: 'b', account: 'claude-main', prompt: 'go' },
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /not a directory/);
});

test('scheduling rejects a non-numeric time', async (t) => {
  const { base } = await boot(t);
  const res = await post(base, {
    cmd: 'schedule',
    trigger: { kind: 'at', time: 'tomorrow' },
    action: { kind: 'create', repo: process.cwd(), branch: 'b', account: 'claude-main', prompt: 'go' },
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /timestamp/);
});

// Number(t.time) would happily coerce [] -> 0 and null -> 0 into a "valid"
// finite timestamp, scheduling a nonsense-time item instead of rejecting the
// request. A typeof guard is the only thing standing between this and a
// silently-accepted garbage trigger.
test('scheduling rejects a time that is coercible to a number but is not one', async (t) => {
  const { base } = await boot(t);
  for (const time of [[], null, [5000]]) {
    const res = await post(base, {
      cmd: 'schedule',
      trigger: { kind: 'at', time },
      action: { kind: 'create', repo: process.cwd(), branch: 'b', account: 'claude-main', prompt: 'go' },
    });
    assert.equal(res.status, 400, `time=${JSON.stringify(time)} must be rejected`);
    assert.match((await res.json()).error, /timestamp/);
  }
});

// String({}) is the non-empty, non-blank string '[object Object]' — it would
// sail past a truthiness check and get scheduled as a real branch name or
// prompt body. A typeof guard rejects the wrong-shaped field outright.
test('scheduling rejects an object-valued branch or prompt', async (t) => {
  const { base } = await boot(t);
  const at = { kind: 'at', time: Date.now() };

  const badBranch = await post(base, {
    cmd: 'schedule', trigger: at,
    action: { kind: 'create', repo: process.cwd(), branch: {}, account: 'claude-main', prompt: 'go' },
  });
  assert.equal(badBranch.status, 400);
  assert.match((await badBranch.json()).error, /branch/);

  const badPrompt = await post(base, {
    cmd: 'schedule', trigger: at,
    action: { kind: 'create', repo: process.cwd(), branch: 'b', account: 'claude-main', prompt: {} },
  });
  assert.equal(badPrompt.status, 400);
  assert.match((await badPrompt.json()).error, /prompt/);
});

test('scheduling rejects an empty prompt and a missing branch', async (t) => {
  const { base } = await boot(t);
  const at = { kind: 'at', time: Date.now() };
  const base_ = { repo: process.cwd(), account: 'claude-main' };

  const noPrompt = await post(base, {
    cmd: 'schedule', trigger: at, action: { kind: 'create', ...base_, branch: 'b', prompt: '  ' },
  });
  assert.equal(noPrompt.status, 400);

  const noBranch = await post(base, {
    cmd: 'schedule', trigger: at, action: { kind: 'create', ...base_, branch: '', prompt: 'go' },
  });
  assert.equal(noBranch.status, 400);
});

test('scheduling a send rejects an unknown session', async (t) => {
  const { base } = await boot(t);
  const res = await post(base, {
    cmd: 'schedule',
    trigger: { kind: 'at', time: Date.now() },
    action: { kind: 'send', sessionId: 'nope', text: 'hi' },
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /no such session/);
});

// The other half of the design guarantee: a reset trigger on a send/resume
// action takes its account from the target session, not from the client —
// same rule as the create case, covered here so it isn't only proven for one
// of the two action shapes that can carry a reset trigger.
test('a reset trigger on a send takes its account from the target session, not the client', async (t) => {
  const { base, registry, scheduler } = await boot(t, undefined, {
    limitCoordinator: fakeLimitCoordinator({ eligibility: { eligible: true, resetsAt: Date.now() + 3600_000 } }),
  });
  const s = registry.create({
    provider: 'codex', account: 'codex', repo: '/r',
    cwd: '/r/wt', branch: 'b', title: 't',
  });

  await post(base, {
    cmd: 'schedule',
    trigger: { kind: 'reset', account: 'attacker-supplied' },
    action: { kind: 'send', sessionId: s.id, text: 'hi' },
  });
  assert.deepEqual(scheduler.all()[0].trigger, { kind: 'reset', account: 'codex' });
});

test('unschedule removes the item', async (t) => {
  const { base, scheduler } = await boot(t);
  const { id } = await (await post(base, {
    cmd: 'schedule',
    trigger: { kind: 'at', time: Date.now() + 3600_000 },
    action: { kind: 'create', repo: process.cwd(), branch: 'b', account: 'claude-main', prompt: 'go' },
  })).json();

  const res = await post(base, { cmd: 'unschedule', itemId: id });
  assert.equal(res.status, 200);
  assert.equal(scheduler.all().length, 0);
});

test('the SSE snapshot carries the queue', async (t) => {
  const { base, scheduler } = await boot(t);
  scheduler.add({ kind: 'at', time: 1 }, {
    kind: 'create', repo: '/r', branch: 'b', account: 'claude-main', prompt: 'go',
  });

  const res = await fetch(`${base}/events`);
  const reader = res.body!.getReader();
  // try/finally, not a bare await at the end: if the assertion throws, an
  // uncancelled reader leaves the SSE fetch open, and boot()'s t.after
  // (server.close()) waits for that connection to end before it resolves —
  // node:test's after-hooks run in registration order (FIFO), so a t.after
  // registered here would run after boot()'s and still hang. finally runs
  // synchronously as the test unwinds, before any after-hook, so the
  // connection is always closed and a failure reports instead of hanging.
  try {
    const chunk = new TextDecoder().decode((await reader.read()).value);
    const payload = JSON.parse(chunk.replace(/^data: /, '').trim());
    assert.equal(payload.queue.length, 1);
  } finally {
    await reader.cancel();
  }
});

// The test above only proves the *first* frame (sent on connect) carries the
// queue — it would pass even if scheduling never pushed again. This is the
// live-update case: an already-open tab must see a `schedule` command without
// reloading, which needs the Scheduler to notify its own subscribers the way
// Registry does, not just get read by the next unrelated push.
test('scheduling an item pushes a second SSE frame carrying it, without a reload', async (t) => {
  const { base } = await boot(t);

  const res = await fetch(`${base}/events`);
  const reader = res.body!.getReader();
  // Same try/finally discipline as the test above: an uncancelled reader on a
  // thrown assertion hangs node --test instead of failing it (bit us in Task 5).
  try {
    await reader.read(); // the initial snapshot; queue is empty, not asserted here

    const posted = post(base, {
      cmd: 'schedule',
      trigger: { kind: 'at', time: Date.now() + 3600_000 },
      action: { kind: 'create', repo: process.cwd(), branch: 'b', account: 'claude-main', prompt: 'go' },
    });
    const chunk = new TextDecoder().decode((await reader.read()).value);
    await posted;
    const payload = JSON.parse(chunk.replace(/^data: /, '').trim());
    assert.equal(payload.queue.length, 1);
    assert.equal(payload.queue[0].action.branch, 'b');
  } finally {
    await reader.cancel();
  }
});

test('POST /command resume on a session whose worktree is gone reports that, not an SDK error', async (t) => {
  const { base, registry } = await boot(t);
  const gone = join(tmpdir(), `sb-not-here-${Date.now()}`);
  const s = registry.create({
    provider: 'claude', account: 'claude-main', repo: '/r',
    cwd: gone, branch: 'b', title: 't',
  });
  registry.apply(s.id, { type: 'stopped', reason: 'done' });

  const res = await fetch(`${base}/command`, {
    method: 'POST',
    body: JSON.stringify({ cmd: 'resume', id: s.id }),
  });

  assert.equal(res.status, 409);
  // Spawning into a missing cwd surfaces as a bogus "native binary does not
  // match this platform" from the SDK, which sends you debugging the wrong thing.
  assert.match((await res.json()).error, /worktree is gone/);
  assert.equal(registry.get(s.id)!.status, 'stopped', 'and the session must not have been revived');
});

test('a due item fires through command() and leaves the queue', async (t) => {
  const { base, registry, scheduler, server } = await boot(t);
  const s = registry.create({
    provider: 'claude', account: 'claude-main', repo: '/r',
    cwd: '/r/wt', branch: 'b', title: 'b',
  });
  // A `send` to a session with no live agent is a 404 from command(), which is
  // exactly the failure path we want to observe — no agent is spawned in tests.
  const item = scheduler.add({ kind: 'at', time: Date.now() - 1000 }, {
    kind: 'send', sessionId: s.id, text: 'hello',
  });

  await server.tick();
  assert.equal(scheduler.all()[0].state, 'failed');
  assert.match(scheduler.all()[0].error ?? '', /no live session/);
  assert.equal(scheduler.all()[0].id, item.id, 'a failed item stays visible, it is not dropped');
});

test('an item whose time has not come is left alone', async (t) => {
  const { registry, scheduler, server } = await boot(t);
  const s = registry.create({
    provider: 'claude', account: 'claude-main', repo: '/r',
    cwd: '/r/wt', branch: 'b', title: 'b',
  });
  scheduler.add({ kind: 'at', time: Date.now() + 3600_000 }, {
    kind: 'send', sessionId: s.id, text: 'hello',
  });

  await server.tick();
  assert.equal(scheduler.all()[0].state, 'waiting');
});

test('a reset item does not fire while its account is rate limited', async (t) => {
  const { registry, scheduler, server, usage } = await boot(t);
  const s = registry.create({
    provider: 'claude', account: 'claude-main', repo: '/r',
    cwd: '/r/wt', branch: 'b', title: 'b',
  });
  // registry.create() starts a session `working`, which would make the account
  // busy() and block the item for the wrong reason. Park it first so the only
  // thing under test is the rate limit.
  registry.apply(s.id, { type: 'stopped', reason: 'parked for the test' });
  usage.noteLimit('claude-main', 'rejected', Date.now() + 3600_000);
  scheduler.add({ kind: 'reset', account: 'claude-main' }, {
    kind: 'send', sessionId: s.id, text: 'hello',
  });

  await server.tick();
  assert.equal(scheduler.all()[0].state, 'waiting');

  usage.noteLimit('claude-main', 'allowed', null);
  await server.tick();
  assert.equal(scheduler.all()[0].state, 'failed', 'it fired once the limit cleared');
});

test('a reset item waits while its account has a working session', async (t) => {
  const { registry, scheduler, server } = await boot(t);
  const busy = registry.create({
    provider: 'claude', account: 'claude-main', repo: '/r',
    cwd: '/r/wt', branch: 'busy', title: 'busy',
  });
  assert.equal(busy.status, 'working', 'created sessions start working');

  const target = registry.create({
    provider: 'claude', account: 'claude-main', repo: '/r',
    cwd: '/r/wt2', branch: 'b', title: 'b',
  });
  // Park the target, so `busy` is true because of the *other* session and the
  // test can't pass for the wrong reason.
  registry.apply(target.id, { type: 'stopped', reason: 'parked for the test' });
  scheduler.add({ kind: 'reset', account: 'claude-main' }, {
    kind: 'send', sessionId: target.id, text: 'hello',
  });

  await server.tick();
  assert.equal(scheduler.all()[0].state, 'waiting');

  // Retire the busy session and it goes through.
  registry.apply(busy.id, { type: 'stopped', reason: 'done' });
  await server.tick();
  assert.equal(scheduler.all()[0].state, 'failed', 'fired once the account went idle');
});

test('a restored Codex reset item waits for a current-process boundary read before firing', async (t) => {
  const releases = [{ ready: false, reason: 'read failed' }, { ready: true, reason: 'available' }];
  const limitCoordinator = fakeLimitCoordinator({ release: async () => releases.shift()! });
  const { registry, scheduler, server } = await boot(t, undefined, { limitCoordinator });
  const target = registry.create({
    provider: 'codex', account: 'codex', repo: '/r', cwd: '/r/wt', branch: 'restore', title: 'restore',
  });
  registry.apply(target.id, { type: 'stopped', reason: 'restored' });
  scheduler.restore([{
    id: 'restored-codex-reset', trigger: { kind: 'reset', account: 'codex' },
    action: { kind: 'send', sessionId: target.id, text: 'continue' }, createdAt: 0, state: 'waiting', error: null,
  }]);

  await server.tick();
  assert.deepEqual(limitCoordinator.reads, ['codex']);
  assert.equal(scheduler.all()[0].state, 'waiting', 'a failed boundary read leaves persisted work retryable');

  await server.tick();
  assert.deepEqual(limitCoordinator.reads, ['codex', 'codex']);
  assert.equal(scheduler.all()[0].state, 'failed', 'only a ready post-read state releases the action');
});

test('restored reset items fail closed when create or send/resume accounts mismatch their trigger', async (t) => {
  const limitCoordinator = fakeLimitCoordinator({ release: async () => ({ ready: true, reason: 'available' }) });
  const { registry, scheduler, server } = await boot(t, undefined, { limitCoordinator });
  const codex = registry.create({
    provider: 'codex', account: 'codex', repo: '/r', cwd: '/r/codex', branch: 'codex', title: 'codex',
  });
  registry.apply(codex.id, { type: 'stopped', reason: 'restored' });
  scheduler.restore([
    {
      id: 'create-mismatch', trigger: { kind: 'reset', account: 'claude-main' },
      action: {
        kind: 'create', repo: '/r', branch: 'create', account: 'codex', prompt: 'go', resetProvider: 'codex',
      },
      createdAt: 0, state: 'waiting', error: null,
    },
    {
      id: 'send-mismatch', trigger: { kind: 'reset', account: 'claude-main' },
      action: { kind: 'send', sessionId: codex.id, text: 'continue' },
      createdAt: 1, state: 'waiting', error: null,
    },
    {
      id: 'resume-mismatch', trigger: { kind: 'reset', account: 'claude-main' },
      action: { kind: 'resume', sessionId: codex.id, prompt: 'continue' },
      createdAt: 2, state: 'waiting', error: null,
    },
    {
      id: 'missing-session', trigger: { kind: 'reset', account: 'codex' },
      action: { kind: 'resume', sessionId: 'missing', prompt: 'continue' },
      createdAt: 3, state: 'waiting', error: null,
    },
  ]);

  await server.tick();
  assert.deepEqual(limitCoordinator.reads, [], 'invalid restored work must not consume either provider path');
  assert.deepEqual(scheduler.all().map((item) => [item.id, item.state, item.error]), [
    ['create-mismatch', 'failed', 'scheduled reset account no longer matches its action'],
    ['send-mismatch', 'failed', 'scheduled reset account no longer matches its action'],
    ['resume-mismatch', 'failed', 'scheduled reset account no longer matches its action'],
    ['missing-session', 'failed', 'scheduled reset action no longer has an account'],
  ]);
});

test('restored reset-create fails closed when Codex origin now maps to same-name Claude config', async (t) => {
  const configured: Account[] = [{ name: 'shared', provider: 'claude', budget: 1000, env: {} }];
  const limitCoordinator = fakeLimitCoordinator({ release: async () => ({ ready: true, reason: 'available' }) });
  const { scheduler, server } = await boot(t, undefined, { accounts: configured, limitCoordinator });
  scheduler.restore([{
    id: 'create-codex-now-claude', trigger: { kind: 'reset', account: 'shared' },
    action: {
      kind: 'create', repo: '/r', branch: 'codex', account: 'shared', prompt: 'go', resetProvider: 'codex',
    },
    createdAt: 0, state: 'waiting', error: null,
  }]);

  await server.tick();
  assert.deepEqual(limitCoordinator.reads, []);
  assert.deepEqual(scheduler.all().map((item) => [item.state, item.error]), [
    ['failed', 'scheduled reset provider changed or is missing — reschedule this item'],
  ]);
});

test('restored reset-create fails closed when Claude origin now maps to same-name Codex config', async (t) => {
  const configured: Account[] = [{ name: 'shared', provider: 'codex', budget: 1000, env: {} }];
  const limitCoordinator = fakeLimitCoordinator({ release: async () => ({ ready: false, reason: 'still limited' }) });
  const { scheduler, server } = await boot(t, undefined, { accounts: configured, limitCoordinator });
  scheduler.restore([{
    id: 'create-claude-now-codex', trigger: { kind: 'reset', account: 'shared' },
    action: {
      kind: 'create', repo: '/r', branch: 'claude', account: 'shared', prompt: 'go', resetProvider: 'claude',
    },
    createdAt: 0, state: 'waiting', error: null,
  }]);

  await server.tick();
  assert.deepEqual(limitCoordinator.reads, [], 'provider mismatch must fail before the Codex boundary read');
  assert.deepEqual(scheduler.all().map((item) => [item.state, item.error]), [
    ['failed', 'scheduled reset provider changed or is missing — reschedule this item'],
  ]);
});

test('restored same-provider reset-create reaches the Codex boundary path', async (t) => {
  const configured: Account[] = [{ name: 'shared', provider: 'codex', budget: 1000, env: {} }];
  const limitCoordinator = fakeLimitCoordinator({ release: async () => ({ ready: false, reason: 'still limited' }) });
  const { scheduler, server } = await boot(t, undefined, { accounts: configured, limitCoordinator });
  scheduler.restore([{
    id: 'create-codex-still-codex', trigger: { kind: 'reset', account: 'shared' },
    action: {
      kind: 'create', repo: '/r', branch: 'codex', account: 'shared', prompt: 'go', resetProvider: 'codex',
    },
    createdAt: 0, state: 'waiting', error: null,
  }]);

  await server.tick();
  assert.deepEqual(limitCoordinator.reads, ['shared']);
  assert.deepEqual(scheduler.all().map((item) => [item.state, item.error]), [['waiting', null]]);
});

test('legacy restored reset-create without provider identity fails closed with reschedule guidance', async (t) => {
  const configured: Account[] = [{ name: 'shared', provider: 'codex', budget: 1000, env: {} }];
  const limitCoordinator = fakeLimitCoordinator({ release: async () => ({ ready: false, reason: 'still limited' }) });
  const { scheduler, server } = await boot(t, undefined, { accounts: configured, limitCoordinator });
  scheduler.restore([{
    id: 'legacy-create', trigger: { kind: 'reset', account: 'shared' },
    action: { kind: 'create', repo: '/r', branch: 'legacy', account: 'shared', prompt: 'go' },
    createdAt: 0, state: 'waiting', error: null,
  }]);

  await server.tick();
  assert.deepEqual(limitCoordinator.reads, []);
  assert.deepEqual(scheduler.all().map((item) => [item.state, item.error]), [
    ['failed', 'scheduled reset provider changed or is missing — reschedule this item'],
  ]);
});

test('restored Codex session fails closed when the same account name is now configured as Claude', async (t) => {
  const configured: Account[] = [{ name: 'shared', provider: 'claude', budget: 1000, env: {} }];
  const { registry, scheduler, server } = await boot(t, undefined, { accounts: configured });
  const session = registry.create({
    provider: 'codex', account: 'shared', repo: '/r', cwd: '/r/codex', branch: 'codex', title: 'codex',
  });
  registry.apply(session.id, { type: 'stopped', reason: 'restored' });
  scheduler.restore([{
    id: 'codex-now-claude', trigger: { kind: 'reset', account: 'shared' },
    action: { kind: 'send', sessionId: session.id, text: 'continue' },
    createdAt: 0, state: 'waiting', error: null,
  }]);

  await server.tick();
  assert.deepEqual(scheduler.all().map((item) => [item.state, item.error]), [
    ['failed', 'scheduled reset provider no longer matches its action'],
  ]);
});

test('restored Claude session fails closed when the same account name is now configured as Codex', async (t) => {
  const configured: Account[] = [{ name: 'shared', provider: 'codex', budget: 1000, env: {} }];
  const limitCoordinator = fakeLimitCoordinator({ release: async () => ({ ready: true, reason: 'available' }) });
  const { registry, scheduler, server } = await boot(t, undefined, { accounts: configured, limitCoordinator });
  const session = registry.create({
    provider: 'claude', account: 'shared', repo: '/r', cwd: '/r/claude', branch: 'claude', title: 'claude',
  });
  registry.apply(session.id, { type: 'stopped', reason: 'restored' });
  scheduler.restore([{
    id: 'claude-now-codex', trigger: { kind: 'reset', account: 'shared' },
    action: { kind: 'resume', sessionId: session.id, prompt: 'continue' },
    createdAt: 0, state: 'waiting', error: null,
  }]);

  await server.tick();
  assert.deepEqual(limitCoordinator.reads, [], 'a provider mismatch must fail before the Codex boundary read');
  assert.deepEqual(scheduler.all().map((item) => [item.state, item.error]), [
    ['failed', 'scheduled reset provider no longer matches its action'],
  ]);
});

test('restored send remains waiting after the correct same-provider Codex boundary path', async (t) => {
  const configured: Account[] = [{ name: 'shared', provider: 'codex', budget: 1000, env: {} }];
  const limitCoordinator = fakeLimitCoordinator({ release: async () => ({ ready: false, reason: 'still limited' }) });
  const { registry, scheduler, server } = await boot(t, undefined, { accounts: configured, limitCoordinator });
  const session = registry.create({
    provider: 'codex', account: 'shared', repo: '/r', cwd: '/r/codex', branch: 'codex', title: 'codex',
  });
  registry.apply(session.id, { type: 'stopped', reason: 'restored' });
  scheduler.restore([{
    id: 'codex-still-codex', trigger: { kind: 'reset', account: 'shared' },
    action: { kind: 'send', sessionId: session.id, text: 'continue' },
    createdAt: 0, state: 'waiting', error: null,
  }]);

  await server.tick();
  assert.deepEqual(limitCoordinator.reads, ['shared']);
  assert.deepEqual(scheduler.all().map((item) => [item.state, item.error]), [['waiting', null]]);
});

test('Codex reset boundary reads batch by account and release only the oldest waiting item', async (t) => {
  const limitCoordinator = fakeLimitCoordinator({ release: async () => ({ ready: true, reason: 'available' }) });
  const { registry, scheduler, server } = await boot(t, undefined, { limitCoordinator });
  const first = registry.create({ provider: 'codex', account: 'codex', repo: '/r', cwd: '/r/one', branch: 'one', title: 'one' });
  const second = registry.create({ provider: 'codex', account: 'codex', repo: '/r', cwd: '/r/two', branch: 'two', title: 'two' });
  registry.apply(first.id, { type: 'stopped', reason: 'parked' });
  registry.apply(second.id, { type: 'stopped', reason: 'parked' });
  const oldest = scheduler.add({ kind: 'reset', account: 'codex' }, { kind: 'send', sessionId: first.id, text: 'one' }, 0);
  const newest = scheduler.add({ kind: 'reset', account: 'codex' }, { kind: 'send', sessionId: second.id, text: 'two' }, 1);

  await server.tick();
  assert.deepEqual(limitCoordinator.reads, ['codex']);
  assert.equal(scheduler.all().find((item) => item.id === oldest.id)!.state, 'failed');
  assert.equal(scheduler.all().find((item) => item.id === newest.id)!.state, 'waiting');
});

test('Codex reset reads run concurrently across accounts and skip busy accounts', async (t) => {
  let releaseReads!: () => void;
  const readsStarted = new Promise<void>((resolve) => { releaseReads = resolve; });
  const readOrder: string[] = [];
  const limitCoordinator = fakeLimitCoordinator({ release: async (account) => {
    readOrder.push(account);
    if (readOrder.length === 2) releaseReads();
    await readsStarted;
    return { ready: false, reason: 'still limited' };
  } });
  const twoCodex: Account[] = [
    { name: 'codex-a', provider: 'codex', budget: 1000, env: {} },
    { name: 'codex-b', provider: 'codex', budget: 1000, env: {} },
  ];
  const { registry, scheduler, server } = await boot(t, undefined, { limitCoordinator, accounts: twoCodex });
  const first = registry.create({ provider: 'codex', account: 'codex-a', repo: '/r', cwd: '/r/a', branch: 'a', title: 'a' });
  const second = registry.create({ provider: 'codex', account: 'codex-b', repo: '/r', cwd: '/r/b', branch: 'b', title: 'b' });
  registry.apply(first.id, { type: 'stopped', reason: 'parked' });
  registry.apply(second.id, { type: 'stopped', reason: 'parked' });
  scheduler.add({ kind: 'reset', account: 'codex-a' }, { kind: 'send', sessionId: first.id, text: 'a' });
  scheduler.add({ kind: 'reset', account: 'codex-b' }, { kind: 'send', sessionId: second.id, text: 'b' });

  await server.tick();
  assert.deepEqual(readOrder, ['codex-a', 'codex-b']);

  const busy = registry.create({ provider: 'codex', account: 'codex-a', repo: '/r', cwd: '/r/busy', branch: 'busy', title: 'busy' });
  scheduler.add({ kind: 'reset', account: 'codex-a' }, { kind: 'send', sessionId: busy.id, text: 'later' });
  // The waiting item above shares an account that has just become busy.
  await server.tick();
  assert.equal(readOrder.filter((name) => name === 'codex-a').length, 1, 'busy accounts do not spend a boundary read');
});

test('timed work dispatches before a hung Codex boundary read and the reset item remains waiting', async (t) => {
  let startRead!: () => void;
  const readStarted = new Promise<void>((resolve) => { startRead = resolve; });
  let settleRead!: () => void;
  const hungRead = new Promise<{ ready: boolean; reason: string }>((resolve) => { settleRead = () => resolve({ ready: false, reason: 'timed out' }); });
  const limitCoordinator = fakeLimitCoordinator({ release: async () => { startRead(); return hungRead; } });
  const { registry, scheduler, server } = await boot(t, undefined, { limitCoordinator });
  const timed = registry.create({ provider: 'claude', account: 'claude-main', repo: '/r', cwd: '/r/timed', branch: 'timed', title: 'timed' });
  const reset = registry.create({ provider: 'codex', account: 'codex', repo: '/r', cwd: '/r/reset', branch: 'reset', title: 'reset' });
  registry.apply(timed.id, { type: 'stopped', reason: 'parked' });
  registry.apply(reset.id, { type: 'stopped', reason: 'parked' });
  const timedItem = scheduler.add({ kind: 'at', time: Date.now() - 1 }, { kind: 'send', sessionId: timed.id, text: 'now' });
  const resetItem = scheduler.add({ kind: 'reset', account: 'codex' }, { kind: 'send', sessionId: reset.id, text: 'later' });

  const ticking = server.tick();
  await readStarted;
  assert.equal(scheduler.all().find((item) => item.id === timedItem.id)!.state, 'failed');
  assert.equal(scheduler.all().find((item) => item.id === resetItem.id)!.state, 'waiting');
  settleRead();
  await ticking;
});

test('one tick performs two scheduler scans while an overlapping tick adds no scan or duplicate dispatch', async (t) => {
  const { adapter, starts } = fakeAdapter();
  const { scheduler, server } = await boot(t, adapter);
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  scheduler.add({ kind: 'at', time: Date.now() - 1000 }, {
    kind: 'create', repo, branch: 'one-tick', account: 'claude-main', prompt: 'hello',
  });

  let calls = 0;
  const realDue = scheduler.due.bind(scheduler);
  scheduler.due = (now, ctx) => { calls++; return realDue(now, ctx); };

  const first = server.tick();
  const second = server.tick();
  await Promise.all([first, second]);

  assert.equal(calls, 2, 'one legitimate tick has a timed scan and a reset scan');
  assert.equal(starts.length, 1, 'the overlapping tick must not dispatch the timed action twice');
  assert.deepEqual(scheduler.all(), []);
});

test('a queued send whose target went stopped by fire time is dispatched as a resume, not a 404 send', async (t) => {
  const { registry, scheduler, server } = await boot(t);
  const s = registry.create({
    provider: 'claude', account: 'claude-main', repo: '/r',
    cwd: '/r/wt', branch: 'b', title: 'b',
  });
  registry.apply(s.id, { type: 'stopped', reason: 'parked for the test' });
  scheduler.add({ kind: 'at', time: Date.now() - 1000 }, {
    kind: 'send', sessionId: s.id, text: 'hello',
  });

  await server.tick();
  // A `send` to a stopped session would fail with "no live session" (404). A
  // `resume` against this fake cwd instead fails with "worktree is gone"
  // (409) before ever touching an adapter — that specific error is the proof
  // the downgrade happened, not a coincidental other failure.
  assert.equal(scheduler.all()[0].state, 'failed');
  assert.match(scheduler.all()[0].error ?? '', /worktree is gone/);
});

test('a self-inflicted stop during a limit window is requeued', () => {
  const now = 1000;
  assert.equal(shouldRequeue(true, now + 3600_000, now, true), true);
});

test('a stop we caused is never requeued', () => {
  // Stop and Delete both drop the handle before calling stop(), so `dead` is
  // falsy on the resulting event. Pressing Stop must not resurrect the session.
  const now = 1000;
  assert.equal(shouldRequeue(false, now + 3600_000, now, true), false);
});

test('a stop with no known limit is not requeued', () => {
  const now = 1000;
  assert.equal(shouldRequeue(true, null, now, true), false);
});

test('a stop after the window already rolled is not requeued', () => {
  const now = 1000;
  assert.equal(shouldRequeue(true, now - 1, now, true), false);
});

test('shouldRequeue returns false when autoRequeue is off', () => {
  const now = Date.now();
  // Every other condition is satisfied; only the setting says no.
  assert.equal(shouldRequeue(true, now + 3600_000, now, false), false);
});

test('a created session inherits autoApprove from settings', async (t) => {
  // bootCodex rather than boot: a real `create` runs createWorktree, which
  // needs an actual git repo, and bootCodex is the fixture in this file that
  // builds one (plus the fake codex binary, so nothing real is spawned).
  const fixture = await bootCodex(t);
  fixture.registry.setSettings({ autoApprove: true });
  const { id } = await fixture.create('auto-on');
  assert.equal(fixture.registry.get(id)!.auto, true);
});

test('a created session is not auto-approved by default', async (t) => {
  const fixture = await bootCodex(t);
  const { id } = await fixture.create('auto-off');
  assert.equal(fixture.registry.get(id)!.auto, false);
});

// The two tests above only check the registry's end state, which is `auto:
// true` regardless of whether `setAuto()` runs before or after `launch()` in
// `case 'create'` — it's called unconditionally and synchronously either way,
// so swapping those two lines would regress behavior (a resumed prompt asks
// for approval once before the toggle takes effect) without failing them.
// This test asserts on what `adapter.start()` was actually called with:
// launch() reads `auto` off the registry at call time and hands it to
// start(), so proving start() received `auto: true` IS the ordering
// assertion. It fails if `setAuto()` moves after `launch()`. Ordering here is
// load-bearing — do not "simplify" this back into an end-state check.
test('setAuto runs before launch, so start() itself receives auto: true', async (t) => {
  const { adapter, starts } = fakeAdapter();
  const { base, registry } = await boot(t, adapter);
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));

  registry.setSettings({ autoApprove: true });
  const res = await fetch(`${base}/command`, {
    method: 'POST',
    body: JSON.stringify({ cmd: 'create', repo, branch: 'auto-order', account: 'claude-main', prompt: 'hi' }),
  });
  assert.equal(res.status, 200);

  assert.equal(starts.length, 1);
  assert.equal(starts[0].auto, true);
});

// ---- parseSettingsPatch ---------------------------------------------------

test('parseSettingsPatch accepts a valid partial', () => {
  const out = parseSettingsPatch({ autoApprove: true, sort: 'newest' });
  assert.deepEqual(out, { patch: { autoApprove: true, sort: 'newest' } });
});

test('parseSettingsPatch accepts an empty patch', () => {
  assert.deepEqual(parseSettingsPatch({}), { patch: {} });
});

test('parseSettingsPatch rejects an unknown key', () => {
  const out = parseSettingsPatch({ sandboxMode: 'danger-full-access' });
  assert.deepEqual(out, { error: 'unknown setting: sandboxMode' });
});

test('parseSettingsPatch rejects a wrong type', () => {
  assert.deepEqual(parseSettingsPatch({ autoApprove: 'yes' }), { error: 'autoApprove must be a boolean' });
});

test('parseSettingsPatch rejects an out-of-range enum', () => {
  assert.deepEqual(parseSettingsPatch({ sort: 'sideways' }), { error: 'sort must be one of: blocked, newest, account' });
});

test('parseSettingsPatch rejects a bad notifyOn member', () => {
  assert.deepEqual(
    parseSettingsPatch({ notifyOn: ['done', 'exploded'] }),
    { error: 'notifyOn must contain only: needs-you, done, stopped' },
  );
});

test('parseSettingsPatch rejects a non-object body', () => {
  assert.deepEqual(parseSettingsPatch(null), { error: 'patch must be an object' });
  assert.deepEqual(parseSettingsPatch([1]), { error: 'patch must be an object' });
});

// ---- auto-requeue wiring --------------------------------------------------
//
// shouldRequeue() above is a well-tested pure function, but nothing above
// proves it is ever actually *called* from launch()'s emit callback — the
// automatic half of the feature, which a user never triggers by hand and so
// cannot notice is broken. These two drive a real session through the real
// `create` -> launch() -> emit path with a fake adapter standing in for the
// subprocess.

test('a session that dies on its own during a rate limit is requeued for when the account resets', async (t) => {
  const { adapter, emit } = fakeAdapter();
  const { base, scheduler } = await boot(t, adapter);
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));

  const res = await fetch(`${base}/command`, {
    method: 'POST',
    body: JSON.stringify({ cmd: 'create', repo, branch: 'b', account: 'claude-main', prompt: 'hi' }),
  });
  assert.equal(res.status, 200);
  const { id } = await res.json();

  const resetsAt = Date.now() + 3600_000;
  emit({ type: 'rate-limit', status: 'rejected', resetsAt });
  // The adapter died on its own (no `stop` command called first), so the
  // handle is still in the map when this fires — the `dead` case.
  emit({ type: 'stopped', reason: 'rate limited' });

  const queued = scheduler.all();
  assert.equal(queued.length, 1, 'a reset-triggered resume should now be queued');
  assert.deepEqual(queued[0].trigger, { kind: 'reset', account: 'claude-main' });
  assert.deepEqual(queued[0].action, { kind: 'resume', sessionId: id, prompt: 'continue' });
});

test('a session stopped via the stop command is never requeued, even past the limit', async (t) => {
  const { adapter, emit } = fakeAdapter();
  const { base, scheduler } = await boot(t, adapter);
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));

  const res = await fetch(`${base}/command`, {
    method: 'POST',
    body: JSON.stringify({ cmd: 'create', repo, branch: 'b', account: 'claude-main', prompt: 'hi' }),
  });
  const { id } = await res.json();

  // Account is past its limit at the time the user presses Stop.
  emit({ type: 'rate-limit', status: 'rejected', resetsAt: Date.now() + 3600_000 });

  const stopRes = await fetch(`${base}/command`, {
    method: 'POST',
    body: JSON.stringify({ cmd: 'stop', id }),
  });
  assert.equal(stopRes.status, 200);

  assert.deepEqual(scheduler.all(), [], 'a deliberate Stop must not resurrect the session');
});

test('a Codex SDK failure never creates reset recovery work from a fresh provider snapshot or UsageLimitExceeded text', async (t) => {
  const { adapter, emit } = fakeAdapter();
  const { base, registry, scheduler, usage } = await boot(t, adapter);
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  registry.setSettings({ autoRequeue: true });
  usage.noteLimit('codex', 'rejected', Date.now() + 3600_000);
  assert.ok((usage.resetAt('codex') ?? 0) > Date.now(), 'the legacy requeue condition must be active');
  usage.setLimitSnapshot('codex', {
    plan: 'pro', fetchedAt: Date.now(), authoritative: true, fresh: true, blocks: [],
    windows: [{ id: 'five-hour', label: '5h', usedPercent: 100, windowDurationMins: 300, resetsAt: Date.now() + 3600_000, reached: true }],
  });

  const res = await post(base, {
    cmd: 'create', repo, branch: 'codex-no-recovery', account: 'codex', prompt: 'go',
  });
  assert.equal(res.status, 200);
  emit({ type: 'stopped', reason: 'UsageLimitExceeded: provider said no' });
  assert.deepEqual(scheduler.all(), [], 'SDK error text and snapshots must not become automatic Codex recovery');
});

// ---- refreshLimits / accountLoad / generic snapshot fields ----------------

const limitSnapshot = (windows = [
  { id: '5h', label: '5h', usedPercent: 11, windowDurationMins: 300, resetsAt: 10 * 3600_000, reached: false },
  { id: '7d', label: '7d', usedPercent: 1, windowDurationMins: 10_080, resetsAt: 20 * 3600_000, reached: false },
], blocks: Array<{ id: string; reason: 'rate_limit_reached'; resettable: boolean }> = []) => ({
  plan: 'pro', windows, blocks, fetchedAt: 0, authoritative: true as const, fresh: true,
});

test('refreshLimits probes claude accounts only and stores a generic snapshot', async () => {
  const usage = new Usage();
  const seen: Record<string, string>[] = [];
  await refreshLimits(usage, accounts, async (env) => {
    seen.push(env);
    return limitSnapshot();
  });

  assert.equal(seen.length, 1, 'the codex account must not be probed');
  assert.deepEqual(usage.getLimitSnapshot('claude-main').snapshot, limitSnapshot());
  assert.deepEqual(usage.getLimitSnapshot('codex'), { snapshot: null, error: null });
});

test('refreshLimits passes the account env through to the probe', async () => {
  const usage = new Usage();
  const withEnv = [{ name: 'alt', provider: 'claude' as const, budget: 1000, env: { CLAUDE_CONFIG_DIR: '/tmp/alt' } }];
  let got: Record<string, string> | null = null;
  await refreshLimits(usage, withEnv, async (env) => { got = env; return limitSnapshot(); });
  assert.deepEqual(got, { CLAUDE_CONFIG_DIR: '/tmp/alt' });
});

test('a failed provider probe exposes a stable path-free error over SSE', async (t) => {
  const { base, usage } = await boot(t);
  const secret = 'claude-account-secret';
  const providerPath = '/private/provider/claude-probe.stderr';
  await refreshLimits(usage, [{
    name: 'claude-main', provider: 'claude', budget: 1000, env: { CLAUDE_TOKEN: secret },
  }], async () => {
    throw new Error(`provider rejected ${secret}: see ${providerPath}`);
  });

  const snap = await firstSnapshot(base);
  const account = snap.accounts.find((a: { name: string }) => a.name === 'claude-main');
  const publicSnapshot = JSON.stringify(snap);
  assert.equal(account.limits, null);
  assert.equal(account.limitsError, 'Unable to refresh account limits. Check that this account is signed in.');
  assert.ok(!publicSnapshot.includes(secret), 'account environment values must not reach SSE');
  assert.ok(!publicSnapshot.includes(providerPath), 'provider absolute paths must not reach SSE');
});

test('one account failing does not stop another from being probed', async () => {
  const usage = new Usage();
  const two = [
    { name: 'a', provider: 'claude' as const, budget: 1000, env: { WHICH: 'a' } },
    { name: 'b', provider: 'claude' as const, budget: 1000, env: {} },
  ];
  await refreshLimits(usage, two, async (_env) => {
    if (_env.WHICH === 'a') throw new Error('nope');
    return limitSnapshot([
      { id: '5h', label: '5h', usedPercent: 7, windowDurationMins: 300, resetsAt: 10 * 3600_000, reached: false },
    ]);
  });
  assert.equal(usage.getLimitSnapshot('b').snapshot?.windows[0].usedPercent, 7);
});

test('accountLoad uses the maximum utilization across arbitrary windows', () => {
  const usage = new Usage();
  usage.setLimitSnapshot('claude-main', limitSnapshot([
    { id: 'monthly', label: 'Monthly', usedPercent: 5, windowDurationMins: 43_200, resetsAt: null, reached: false },
    { id: 'burst', label: 'Burst', usedPercent: 96, windowDurationMins: null, resetsAt: null, reached: false },
  ]));
  assert.equal(accountLoad(usage, accounts[0]), 0.96);
});

test('accountLoad returns full load for any fresh authoritative block', () => {
  const usage = new Usage();
  usage.setLimitSnapshot('claude-main', limitSnapshot([
    { id: '5h', label: '5h', usedPercent: 5, windowDurationMins: 300, resetsAt: null, reached: false },
  ], [{ id: 'default', reason: 'rate_limit_reached', resettable: true }]));
  assert.equal(accountLoad(usage, accounts[0]), 1);
});

test('accountLoad falls back to pace without a fresh snapshot', () => {
  const usage = new Usage();
  usage.record('codex', 400, 0, Date.now());
  assert.equal(accountLoad(usage, accounts[1]), 0.4);
});

test('accountLoad prefers a fresh provider 5% over a 90% pace estimate', () => {
  const usage = new Usage();
  usage.setLimitSnapshot('claude-main', limitSnapshot([
    { id: '5h', label: '5h', usedPercent: 5, windowDurationMins: 300, resetsAt: null, reached: false },
  ]));
  usage.record('claude-main', 900, 0, Date.now());
  assert.equal(accountLoad(usage, accounts[0]), 0.05);
});

test('the SSE snapshot carries the exact browser limit shape without legacy aliases', async (t) => {
  const limitCoordinator = fakeLimitCoordinator({
    eligibility: { eligible: false, reason: 'Codex needs a fresh usage window.' },
  });
  const { base, usage } = await boot(t, undefined, { limitCoordinator });
  usage.setLimitSnapshot('claude-main', limitSnapshot());
  usage.failLimitSnapshot('codex', 'not supported');
  // codex's budget is 1000 (see the `accounts` fixture above); recording spend
  // here means `load: 0` below can only pass if load actually tracks pace —
  // with no recorded spend at all, pace() (and a hardcoded 0) look identical.
  usage.record('codex', 400, 0, Date.now());

  const snap = await firstSnapshot(base);
  const main = snap.accounts.find((a: { name: string }) => a.name === 'claude-main');
  const codex = snap.accounts.find((a: { name: string }) => a.name === 'codex');

  assert.deepEqual(Object.keys(main).sort(), [
    'budget', 'limits', 'limitsError', 'load', 'name', 'pace', 'provider', 'resetScheduling',
  ]);
  assert.deepEqual(main.limits, limitSnapshot());
  assert.equal(main.limitsError, null);
  assert.equal(main.load, 0.11);
  assert.equal(codex.limits, null);
  assert.equal(codex.limitsError, 'not supported');
  assert.equal(codex.load, 0.4);
  assert.equal('limitSnapshot' in main, false);
  assert.equal('limitSnapshotError' in main, false);
});

test('SSE reset scheduling projects eligible and ineligible Codex while Claude stays enabled', async (t) => {
  const eligibleReset = Date.now() + 3_600_000;
  const eligible = await boot(t, undefined, {
    limitCoordinator: fakeLimitCoordinator({ eligibility: { eligible: true, resetsAt: eligibleReset } }),
  });
  const eligibleSnap = await firstSnapshot(eligible.base);
  const eligibleCodex = eligibleSnap.accounts.find((a: { name: string }) => a.name === 'codex');
  assert.deepEqual(
    eligibleCodex.resetScheduling,
    { eligible: true, resetsAt: eligibleReset, reason: '' },
  );
  assert.deepEqual(resetScheduleView(eligibleCodex), { enabled: true, reason: '' });
  const eligibleClaude = eligibleSnap.accounts.find((a: { name: string }) => a.name === 'claude-main');
  assert.deepEqual(
    eligibleClaude.resetScheduling,
    { eligible: true, resetsAt: null, reason: '' },
  );
  assert.deepEqual(resetScheduleView(eligibleClaude), { enabled: true, reason: '' });

  const ineligible = await boot(t, undefined, {
    limitCoordinator: fakeLimitCoordinator({ eligibility: { eligible: false, reason: 'Sign in to Codex first.' } }),
  });
  const ineligibleSnap = await firstSnapshot(ineligible.base);
  const ineligibleCodex = ineligibleSnap.accounts.find((a: { name: string }) => a.name === 'codex');
  assert.deepEqual(
    ineligibleCodex.resetScheduling,
    { eligible: false, resetsAt: null, reason: 'Sign in to Codex first.' },
  );
  assert.deepEqual(resetScheduleView(ineligibleCodex), {
    enabled: false,
    reason: 'Sign in to Codex first.',
  });
  const ineligibleClaude = ineligibleSnap.accounts.find((a: { name: string }) => a.name === 'claude-main');
  assert.deepEqual(
    ineligibleClaude.resetScheduling,
    { eligible: true, resetsAt: null, reason: '' },
  );
  assert.deepEqual(resetScheduleView(ineligibleClaude), { enabled: true, reason: '' });
});

test('the SSE snapshot falls back to local pace after a previously successful provider snapshot becomes stale', async (t) => {
  const { base, usage } = await boot(t);
  usage.setLimitSnapshot('codex', limitSnapshot([
    { id: '5h', label: '5h', usedPercent: 5, windowDurationMins: 300, resetsAt: null, reached: false },
  ]));
  usage.record('codex', 400, 0, Date.now());
  usage.failLimitSnapshot('codex', 'Codex account telemetry is temporarily unavailable. Using the local estimate.');

  const snap = await firstSnapshot(base);
  const codex = snap.accounts.find((account: { name: string }) => account.name === 'codex');
  assert.equal(codex.limits.fresh, false);
  assert.equal(codex.load, 0.4, 'stale authoritative data must not mask the local estimate');
});

test('GET /diff returns the worktree changes file by file', async (t) => {
  const { base, registry } = await boot(t);
  const dir = await mkdtemp(join(tmpdir(), 'sb-repo-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await run('git', ['init', '-b', 'main'], { cwd: dir });
  await run('git', ['config', 'user.email', 't@t.t'], { cwd: dir });
  await run('git', ['config', 'user.name', 'T'], { cwd: dir });
  await writeFile(join(dir, 'a.txt'), 'one\n');
  await run('git', ['add', '.'], { cwd: dir });
  await run('git', ['commit', '-m', 'init'], { cwd: dir });
  await writeFile(join(dir, 'a.txt'), 'one\ntwo\n');

  const s = registry.create({
    provider: 'claude', account: 'claude-main', repo: dir,
    cwd: dir, branch: 'main', title: 't',
  });

  const res = await fetch(`${base}/diff?id=${s.id}`);
  assert.equal(res.status, 200);
  const files = await res.json();
  assert.equal(files.length, 1);
  assert.equal(files[0].path, 'a.txt');
  assert.equal(files[0].added, 1);
  assert.match(files[0].patch, /^\+two$/m);
});

test('GET /diff for an unknown session is a 404, not a crash', async (t) => {
  const { base } = await boot(t);
  const res = await fetch(`${base}/diff?id=nope`);
  assert.equal(res.status, 404);
});

test('GET /diff is behind the Host guard like every other route', async (t) => {
  const { base } = await boot(t);
  const res = await rawRequest(new URL(`${base}/diff?id=nope`), {
    method: 'GET', headers: { Host: 'evil.example' },
  });
  assert.equal(res.status, 403);
});

// ---- account linking --------------------------------------------------

test('link commands are rejected when the account store seam is absent', async (t) => {
  // Every pre-existing server test constructs createServer without an
  // accountStore. Those tests must keep passing untouched, so linking has to
  // be off by default rather than reaching for a real accounts.json.
  const { base } = await boot(t);
  const res = await post(base, { cmd: 'link-start', provider: 'claude' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /not available/);
});

test('link-start rejects an unknown provider', async (t) => {
  const { base } = await bootLinking(t);
  const res = await post(base, { cmd: 'link-start', provider: 'gpt' });
  assert.equal(res.status, 400);
});

test('link-start refuses a second concurrent link', async (t) => {
  const { base } = await bootLinking(t);
  assert.equal((await post(base, { cmd: 'link-start', provider: 'claude' })).status, 200);
  const second = await post(base, { cmd: 'link-start', provider: 'claude' });
  assert.equal(second.status, 409);
  await post(base, { cmd: 'link-cancel' });
});

test('link-code and link-confirm 409 when out of phase', async (t) => {
  const { base } = await bootLinking(t);
  assert.equal((await post(base, { cmd: 'link-code', code: 'x' })).status, 409);
  assert.equal((await post(base, { cmd: 'link-confirm', name: 'a' })).status, 409);
});

test('link-cancel with nothing pending is a 200, not an error', async (t) => {
  const { base } = await bootLinking(t);
  assert.equal((await post(base, { cmd: 'link-cancel' })).status, 200);
});

test('a completed link appears in accounts.json and in the snapshot', async (t) => {
  const { base, linker, accountsPath } = await bootLinking(t, { mode: 'no-prompt', email: 'dwight@example.com' });
  await post(base, { cmd: 'link-start', provider: 'claude' });
  await untilLink(linker, (l) => l?.phase === 'naming');
  const res = await post(base, { cmd: 'link-confirm', name: 'claude-dwight' });
  assert.equal(res.status, 200);
  const written = JSON.parse(await readFile(accountsPath, 'utf8'));
  assert.deepEqual(written.map((a: { name: string }) => a.name), ['claude-dwight']);
  const snap = await firstSnapshot(base);
  assert.ok(snap.accounts.some((a: { name: string }) => a.name === 'claude-dwight'));
  assert.equal(snap.link, null);
});

// The AGENTS.md rule: account env values, which includes every credential
// directory path, must never reach the browser.
test('the snapshot never contains the staging path or the submitted code', async (t) => {
  const { base, linker } = await bootLinking(t, { mode: 'bad-code' });
  await post(base, { cmd: 'link-start', provider: 'claude' });
  await untilLink(linker, (l) => l?.codeRequested === true);
  const staging = linker.stagingDir();
  assert.ok(staging, 'expected a staging dir while awaiting a code');
  await post(base, { cmd: 'link-code', code: 'sentinel-secret-code' });
  await untilLink(linker, (l) => l?.phase === 'error');
  const serialized = JSON.stringify(await firstSnapshot(base));
  assert.ok(!serialized.includes('sentinel-secret-code'));
  assert.ok(!serialized.includes(staging));
});

// ---- unlink -------------------------------------------------------------

/** Full link-start + link-confirm against a fake login CLI, producing a real
 *  account entry in accounts.json and a real credential dir under the root. */
async function linkAccount(
  h: { base: string; linker: Linker },
  name: string,
): Promise<void> {
  await post(h.base, { cmd: 'link-start', provider: 'claude' });
  await untilLink(h.linker, (l) => l?.phase === 'naming');
  const res = await post(h.base, { cmd: 'link-confirm', name });
  assert.equal(res.status, 200);
}

/** Starts a real session (through a fake adapter — see bootLinking) on
 *  `account`, inside a scratch git repo, for unlink's in-use tests. */
async function startSession(h: { base: string }, account: string): Promise<string> {
  const repo = await makeRepo();
  const res = await post(h.base, {
    cmd: 'create', repo, branch: 'wip', account, prompt: 'hi',
  });
  assert.equal(res.status, 200);
  return (await res.json()).id as string;
}

test('unlink refuses while a session on the account is running', async (t) => {
  const h = await bootLinking(t, { mode: 'no-prompt' });
  await linkAccount(h, 'claude-x');
  await startSession(h, 'claude-x');
  const res = await post(h.base, { cmd: 'unlink', name: 'claude-x' });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /running/);
});

test('unlink refuses while a create is queued for the account', async (t) => {
  const h = await bootLinking(t, { mode: 'no-prompt' });
  await linkAccount(h, 'claude-x');
  const repo = await makeRepo();
  await post(h.base, {
    cmd: 'schedule',
    trigger: { kind: 'at', time: Date.now() + 3_600_000 },
    action: { kind: 'create', repo, branch: 'feat/x', account: 'claude-x', prompt: 'hi' },
  });
  const res = await post(h.base, { cmd: 'unlink', name: 'claude-x' });
  assert.equal(res.status, 409);
});

// The queued-item guard is `(trigger.kind === 'reset' && trigger.account ===
// name) || (action.kind === 'create' && action.account === name)` — two
// independent expressions. The test above only exercises the `create` half;
// this one isolates the `reset` half by giving the action a different,
// unrelated account, so it can't accidentally pass via the other clause.
test('unlink refuses while a reset trigger is queued for the account', async (t) => {
  const h = await bootLinking(t, { mode: 'no-prompt' });
  await linkAccount(h, 'claude-x');
  h.scheduler.add({ kind: 'reset', account: 'claude-x' }, {
    kind: 'send', sessionId: 'unrelated-session', text: 'hi',
  });
  const res = await post(h.base, { cmd: 'unlink', name: 'claude-x' });
  assert.equal(res.status, 409);
});

test('unlink succeeds over a stopped session, which then cannot resume', async (t) => {
  const h = await bootLinking(t, { mode: 'no-prompt' });
  await linkAccount(h, 'claude-x');
  const id = await startSession(h, 'claude-x');
  await post(h.base, { cmd: 'stop', id });
  assert.equal((await post(h.base, { cmd: 'unlink', name: 'claude-x' })).status, 200);
  const resumed = await post(h.base, { cmd: 'resume', id, prompt: 'again' });
  assert.equal(resumed.status, 400);
  assert.match((await resumed.json()).error, /no longer configured/);
  // The transcript is still readable — an unlinked account leaves a
  // read-only archive, it does not delete history.
  const snap = await firstSnapshot(h.base);
  assert.ok(snap.sessions.some((s: { id: string }) => s.id === id));
});

test('unlink removes the entry from accounts.json and its credential dir', async (t) => {
  const h = await bootLinking(t, { mode: 'no-prompt' });
  await linkAccount(h, 'claude-x');
  const dir = join(h.accountsRoot, 'claude-x');
  assert.ok(await stat(dir));
  assert.equal((await post(h.base, { cmd: 'unlink', name: 'claude-x' })).status, 200);
  assert.deepEqual(JSON.parse(await readFile(h.accountsPath, 'utf8')), []);
  await assert.rejects(() => stat(dir));
});

// The test standing between a bug and a user's real credentials.
test('unlink never deletes a directory outside the accounts root', async (t) => {
  const h = await bootLinking(t);
  const outside = join(h.tmp, 'my-own-claude-dir');
  await mkdir(outside, { recursive: true });
  // A hand-written entry, exactly like the README's claude-alt example.
  h.accounts.push({
    name: 'hand-written', provider: 'claude', budget: 1,
    env: { CLAUDE_CONFIG_DIR: outside },
  });
  await h.accountStore.append(h.accounts.at(-1)!);
  assert.equal((await post(h.base, { cmd: 'unlink', name: 'hand-written' })).status, 200);
  assert.deepEqual(JSON.parse(await readFile(h.accountsPath, 'utf8')), []);
  assert.ok(await stat(outside), "the user's own directory must survive");
});

// `join(root, name)` collapses `..` in `name`, so a hand-written entry named
// `../evil` whose env happens to equal that collapsed path must not pass the
// guard just because the two sides of the naive comparison are identical
// expressions. The guard must reject the *name* shape outright.
test('unlink guard rejects a name that could traverse outside the root via join()', async (t) => {
  const h = await bootLinking(t);
  const outside = join(h.accountsRoot, '..', 'evil'); // == join(accountsRoot, '../evil')
  await mkdir(outside, { recursive: true });
  h.accounts.push({
    name: '../evil', provider: 'claude', budget: 1,
    env: { CLAUDE_CONFIG_DIR: outside },
  });
  await h.accountStore.append(h.accounts.at(-1)!);
  const res = await post(h.base, { cmd: 'unlink', name: '../evil' });
  assert.equal(res.status, 200);
  assert.ok(await stat(outside), 'a directory outside the root must survive even when it equals join(root, name)');
});

// A directory whose path merely starts with the accounts root string (a
// sibling directory like `<root>-evil/`) must not pass a guard that only
// checks a prefix — the guard has to compare full resolved paths.
test('unlink guard is not fooled by a sibling directory sharing a path prefix', async (t) => {
  const h = await bootLinking(t);
  const outside = join(`${h.accountsRoot}-evil`, 'claude-x');
  await mkdir(outside, { recursive: true });
  h.accounts.push({ name: 'claude-x', provider: 'claude', budget: 1, env: { CLAUDE_CONFIG_DIR: outside } });
  await h.accountStore.append(h.accounts.at(-1)!);
  const res = await post(h.base, { cmd: 'unlink', name: 'claude-x' });
  assert.equal(res.status, 200);
  assert.ok(await stat(outside), 'a sibling directory sharing only a string prefix must survive');
});

test('unlink of an unknown account is a 404', async (t) => {
  const h = await bootLinking(t);
  assert.equal((await post(h.base, { cmd: 'unlink', name: 'nope' })).status, 404);
});
