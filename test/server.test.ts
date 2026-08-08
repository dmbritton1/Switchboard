import { test } from 'node:test';
import assert from 'node:assert';
import { chmod, mkdir, mkdtemp, writeFile, realpath, rm, readFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { request as httpRequest } from 'node:http';
import { Registry, type RegistryOptions } from '../src/sessions.ts';
import { Usage } from '../src/usage.ts';
import { createServer } from '../src/server.ts';
import { resolveAgentPrompt } from '../src/prompt-input.ts';
import { createWorktree } from '../src/worktree.ts';
import { writeFakeCodex } from './helpers/fake-codex.ts';

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
  registryOptions?: RegistryOptions,
  serverHooks: { beforeUploadWrite?: (target: string) => Promise<void> } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'sb-'));
  const registry = new Registry(join(dir, 'state.json'), undefined, registryOptions);
  const usage = new Usage();
  const server = createServer({ registry, usage, accounts, ...serverHooks } as Parameters<typeof createServer>[0]);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  t.after(() => { server.close(); return rm(dir, { recursive: true, force: true }); });
  return { base: `http://127.0.0.1:${port}`, registry };
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
    registry, usage, accounts: [account],
    ...(options.resolvePrompt ? { resolvePrompt: options.resolvePrompt } : {}),
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

test('GET /events opens an SSE stream with an immediate snapshot', async (t) => {
  const { base, registry } = await boot(t);
  registry.create({
    provider: 'claude', account: 'claude-main', repo: '/r',
    cwd: '/r/wt', branch: 'b', title: 'a title',
  });

  const res = await fetch(`${base}/events`);
  assert.equal(res.headers.get('content-type'), 'text/event-stream');

  const reader = res.body!.getReader();
  const chunk = new TextDecoder().decode((await reader.read()).value);
  assert.match(chunk, /^data: /m);
  const payload = JSON.parse(chunk.replace(/^data: /, '').trim());
  assert.equal(payload.sessions.length, 1);
  assert.equal(payload.sessions[0].title, 'a title');
  assert.equal(payload.accounts[0].name, 'claude-main');
  await reader.cancel();
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

test('POST /upload cannot be redirected by swapping its parent after validation', async (t) => {
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
  const wt = await mkdtemp(join(tmpdir(), 'sb-wt-race-'));
  const outside = await mkdtemp(join(tmpdir(), 'sb-outside-race-'));
  t.after(() => rm(wt, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await mkdir(join(wt, 'uploads'));
  const s = registry.create({
    provider: 'claude', account: 'claude-main', repo: '/r',
    cwd: wt, branch: 'b', title: 't',
  });

  const upload = fetch(`${base}/upload?id=${s.id}&name=notes.txt`, {
    method: 'POST', body: 'bound payload',
  });
  await Promise.race([
    opened,
    upload.then(() => { throw new Error('upload wrote before the deterministic race barrier'); }),
  ]);
  await rm(join(wt, 'uploads'), { recursive: true });
  await symlink(outside, join(wt, 'uploads'));
  release();
  const response = await upload;

  assert.equal(response.status, 200);
  await assert.rejects(stat(join(outside, 'notes.txt')),
    'the swapped outside directory must not receive even an empty file');
  const { path } = await response.json() as { path: string };
  assert.equal(await readFile(join(wt, path), 'utf8'), 'bound payload');
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
