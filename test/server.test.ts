import { test } from 'node:test';
import assert from 'node:assert';
import { chmod, mkdir, mkdtemp, writeFile, rm, readFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { request as httpRequest } from 'node:http';
import { Registry } from '../src/sessions.ts';
import { Usage } from '../src/usage.ts';
import { Scheduler } from '../src/schedule.ts';
import { createServer, refreshLimits, accountLoad, shouldRequeue, parseSettingsPatch } from '../src/server.ts';
import { createWorktree } from '../src/worktree.ts';
import { writeFakeCodex } from './helpers/fake-codex.ts';
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

async function boot(
  t: { after: (fn: () => void) => void },
  adapter?: Adapter,
) {
  const dir = await mkdtemp(join(tmpdir(), 'sb-'));
  const registry = new Registry(join(dir, 'state.json'));
  const usage = new Usage();
  const scheduler = new Scheduler();
  // One adapter for every account rather than a claude/codex pair: since the
  // Codex runtime landed, the server resolves a provider through an async
  // `prepare` step instead of a lookup table, and a test that injects here
  // wants to observe launch()'s emit wiring, not provider selection.
  const prepare = adapter ? async () => ({ adapter }) : undefined;
  const server = createServer({ registry, usage, scheduler, accounts, prepare });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  t.after(() => { server.close(); return rm(dir, { recursive: true, force: true }); });
  return { base: `http://127.0.0.1:${port}`, registry, usage, scheduler, server };
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
  repo: string;
  bin: string;
  statePath: string;
  command(body: Record<string, unknown>): Promise<{ status: number; data: any }>;
  create(prompt: string): Promise<{ id: string }>;
  waitForSession(id: string, predicate: (session: NonNullable<ReturnType<Registry['get']>>) => boolean): Promise<void>;
  worktrees(): Promise<string>;
  invocations(): Promise<Array<{ argv: string[]; prompt: string; cwd: string; codexHome: string | null }>>;
  calls(): Promise<string[][]>;
};

async function bootCodex(
  t: { after: (fn: () => void) => void },
  options: { bin?: string; env?: Record<string, string> } = {},
): Promise<CodexFixture> {
  const dir = await mkdtemp(join(tmpdir(), 'sb-codex-server-'));
  const repo = join(dir, 'repo');
  const log = join(dir, 'fake-codex.jsonl');
  const callLog = join(dir, 'fake-codex-calls.jsonl');
  const codexHome = join(dir, 'codex-home');
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
const { appendFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
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
    env: { FAKE_CODEX_LOG: log, FAKE_CODEX_CALL_LOG: callLog, CODEX_HOME: codexHome, ...options.env },
  };
  const server = createServer({ registry, usage, scheduler: new Scheduler(), accounts: [account] });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  t.after(() => { server.close(); return rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  return {
    base, registry, repo, bin, statePath,
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
        .map((line) => JSON.parse(line) as { argv: string[]; prompt: string; cwd: string; codexHome: string | null });
    },
    async calls() {
      return (await readFile(callLog, 'utf8')).split('\n').filter(Boolean)
        .map((line) => JSON.parse(line) as string[]);
    },
  };
}

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

test('a successful Codex create finishes with the fake executable', async (t) => {
  const fixture = await bootCodex(t);
  const created = await fixture.create('first');
  await fixture.waitForSession(created.id, (session) => session.status === 'done');
  assert.equal(fixture.registry.get(created.id)!.vendorSessionId, 'fake-thread');
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
  assert.deepEqual(await res.json(), { path: 'uploads/notes.txt' });
  assert.equal(await readFile(join(wt, 'uploads', 'notes.txt'), 'utf8'), 'hello file');
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

test('a reset trigger takes its account from the action, not the client', async (t) => {
  const { base, scheduler } = await boot(t);
  await post(base, {
    cmd: 'schedule',
    trigger: { kind: 'reset', account: 'attacker-supplied' },
    action: { kind: 'create', repo: process.cwd(), branch: 'b', account: 'codex', prompt: 'go' },
  });
  assert.deepEqual(scheduler.all()[0].trigger, { kind: 'reset', account: 'codex' });
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
  const { base, registry, scheduler } = await boot(t);
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

test('overlapping ticks consult the scheduler once, not twice', async (t) => {
  const { registry, scheduler, server } = await boot(t);
  const s = registry.create({
    provider: 'claude', account: 'claude-main', repo: '/r',
    cwd: '/r/wt', branch: 'b', title: 'b',
  });
  scheduler.add({ kind: 'at', time: Date.now() - 1000 }, {
    kind: 'send', sessionId: s.id, text: 'hello',
  });

  // Count calls to due() rather than inspect end state: a doubled `send` to a
  // dead session ends up looking the same either way, so the thing worth
  // proving is that the scheduler is only consulted once per overlap.
  let calls = 0;
  const realDue = scheduler.due.bind(scheduler);
  scheduler.due = (now, ctx) => { calls++; return realDue(now, ctx); };

  // tick() yields at its first await (inside the loop's `command()` call, or
  // at the trailing save if nothing is due), so calling it twice back to back
  // without awaiting the first genuinely overlaps them — this is deterministic,
  // not a race to hope for: the first call's synchronous prefix (which sets the
  // in-flight guard and calls due()) always finishes before the second call's
  // synchronous prefix begins.
  const first = server.tick();
  const second = server.tick();
  await Promise.all([first, second]);

  assert.equal(calls, 1, 'the second, overlapping tick must skip rather than re-dispatch the same item');
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

// ---- refreshLimits / accountLoad / snapshot limits fields ----------------

const fiveAndSeven = (five: number, seven: number) => ({
  fiveHour: { utilization: five, resetsAt: '2026-08-03T19:10:00Z' },
  sevenDay: { utilization: seven, resetsAt: '2026-08-10T08:00:00Z' },
  subscription: 'pro',
});

test('refreshLimits probes claude accounts only and stores the result', async () => {
  const usage = new Usage();
  const seen: Record<string, string>[] = [];
  await refreshLimits(usage, accounts, async (env) => {
    seen.push(env);
    return fiveAndSeven(11, 1);
  });

  assert.equal(seen.length, 1, 'the codex account must not be probed');
  assert.deepEqual(usage.getLimits('claude-main').limits, fiveAndSeven(11, 1));
  assert.deepEqual(usage.getLimits('codex'), { limits: null, error: null });
});

test('refreshLimits passes the account env through to the probe', async () => {
  const usage = new Usage();
  const withEnv = [{ name: 'alt', provider: 'claude' as const, budget: 1000, env: { CLAUDE_CONFIG_DIR: '/tmp/alt' } }];
  let got: Record<string, string> | null = null;
  await refreshLimits(usage, withEnv, async (env) => { got = env; return fiveAndSeven(3, 2); });
  assert.deepEqual(got, { CLAUDE_CONFIG_DIR: '/tmp/alt' });
});

test('a rejected probe records the reason and leaves limits null', async () => {
  const usage = new Usage();
  await refreshLimits(usage, accounts, async () => { throw new Error('logged out'); });
  assert.deepEqual(usage.getLimits('claude-main'), { limits: null, error: 'logged out' });
});

test('one account failing does not stop another from being probed', async () => {
  const usage = new Usage();
  const two = [
    { name: 'a', provider: 'claude' as const, budget: 1000, env: { WHICH: 'a' } },
    { name: 'b', provider: 'claude' as const, budget: 1000, env: {} },
  ];
  await refreshLimits(usage, two, async (_env) => {
    if (_env.WHICH === 'a') throw new Error('nope');
    return fiveAndSeven(7, 7);
  });
  assert.equal(usage.getLimits('b').limits?.fiveHour?.utilization, 7);
});

test('accountLoad takes the worse of the two windows', () => {
  const usage = new Usage();
  usage.setLimits('claude-main', fiveAndSeven(5, 96), null);
  // A quiet 5h window must not hide a nearly-exhausted week.
  assert.equal(accountLoad(usage, accounts[0]), 0.96);
});

test('accountLoad falls back to pace without limits', () => {
  const usage = new Usage();
  usage.record('codex', 400, 0, Date.now());
  assert.equal(accountLoad(usage, accounts[1]), 0.4);
});

test('accountLoad prefers a real 5% over a 90% pace estimate', () => {
  const usage = new Usage();
  usage.setLimits('claude-main', fiveAndSeven(5, 5), null);
  usage.record('claude-main', 900, 0, Date.now());
  assert.equal(accountLoad(usage, accounts[0]), 0.05);
});

test('the snapshot carries limits, limitsError and load per account', async (t) => {
  const { base, usage } = await boot(t);
  usage.setLimits('claude-main', fiveAndSeven(11, 1), null);
  usage.setLimits('codex', null, 'not supported');
  // codex's budget is 1000 (see the `accounts` fixture above); recording spend
  // here means `load: 0` below can only pass if load actually tracks pace —
  // with no recorded spend at all, pace() (and a hardcoded 0) look identical.
  usage.record('codex', 400, 0, Date.now());

  const snap = await firstSnapshot(base);
  const main = snap.accounts.find((a: { name: string }) => a.name === 'claude-main');
  const codex = snap.accounts.find((a: { name: string }) => a.name === 'codex');

  assert.deepEqual(main.limits, fiveAndSeven(11, 1));
  assert.equal(main.limitsError, null);
  assert.equal(main.load, 0.11);
  assert.equal(codex.limits, null);
  assert.equal(codex.limitsError, 'not supported');
  assert.equal(codex.load, 0.4);

});
