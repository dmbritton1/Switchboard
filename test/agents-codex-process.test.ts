import assert from 'node:assert';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCodexAdapter, classifyCodexFailure } from '../src/agents/codex.ts';
import type { PreparedCodexRuntime } from '../src/agents/codex-runtime.ts';
import type { Adapter, AdapterEvent } from '../src/types.ts';
import { writeFakeCodex } from './helpers/fake-codex.ts';

type FakeInvocation = {
  argv: string[];
  prompt: string;
  cwd: string;
  codexHome: string | null;
};

type ProcessFixture = {
  cwd: string;
  codexHome: string;
  runtime: PreparedCodexRuntime;
  readInvocations(): Promise<FakeInvocation[]>;
  readHoldLifecycle(): Promise<string[]>;
};

async function makeProcessFixture(t: { after(fn: () => unknown): void }): Promise<ProcessFixture> {
  const dir = await mkdtemp(join(tmpdir(), 'switchboard-codex-process-'));
  const cwd = join(dir, 'workspace');
  const codexHome = join(dir, 'codex-home');
  const log = join(dir, 'fake-codex.jsonl');
  const holdLog = join(dir, 'fake-codex-hold.log');
  await Promise.all([mkdir(cwd), mkdir(codexHome), writeFile(log, ''), writeFile(holdLog, '')]);
  const bin = await writeFakeCodex(dir);
  t.after(() => rm(dir, { recursive: true, force: true }));

  return {
    cwd,
    codexHome,
    runtime: {
      source: 'explicit',
      commandPath: bin,
      codexPathOverride: bin,
      version: '0.145.0',
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
        CODEX_HOME: codexHome,
        FAKE_CODEX_LOG: log,
        FAKE_CODEX_HOLD_LOG: holdLog,
        FAKE_CODEX_SECRET: 'never-expose-me',
      },
      diagnostics: [],
    },
    async readInvocations() {
      const contents = await readFile(log, 'utf8');
      return contents.split('\n').filter(Boolean).map((line) => JSON.parse(line) as FakeInvocation);
    },
    async readHoldLifecycle() {
      return (await readFile(holdLog, 'utf8')).split('\n').filter(Boolean);
    },
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for Codex adapter event');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function collect(
  adapter: Adapter,
  fixture: ProcessFixture,
  prompt: string,
  predicate: (events: AdapterEvent[]) => boolean,
  resumeId?: string,
): Promise<{ events: AdapterEvent[]; handle: ReturnType<Adapter['start']> }> {
  const events: AdapterEvent[] = [];
  const handle = adapter.start(
    { cwd: fixture.cwd, prompt, env: {}, ...(resumeId ? { resumeId } : {}) },
    (event) => events.push(event),
  );
  await waitFor(() => predicate(events));
  return { events, handle };
}

function stopped(events: AdapterEvent[]): Extract<AdapterEvent, { type: 'stopped' }> {
  const event = events.find((candidate) => candidate.type === 'stopped');
  assert.ok(event, 'expected a stopped event');
  return event;
}

test('the prepared adapter starts through the real SDK with mandatory safety options', async (t) => {
  const fixture = await makeProcessFixture(t);
  const adapter = createCodexAdapter(fixture.runtime);
  const { events } = await collect(adapter, fixture, 'basic', (all) =>
    all.some((event) => event.type === 'status' && event.status === 'done'));

  const invocations = await fixture.readInvocations();
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].prompt, 'basic');
  assert.ok(invocations[0].argv.includes('--experimental-json'));
  assert.ok(invocations[0].argv.includes('workspace-write'));
  assert.ok(invocations[0].argv.includes('approval_policy="never"'));
  assert.equal(invocations[0].cwd, fixture.cwd);
  assert.equal(invocations[0].codexHome, fixture.codexHome);
  assert.ok(events.some((event) => event.type === 'vendor-session-id' && event.id === 'fake-thread'));
  assert.ok(!invocations[0].argv.some((arg) => /--model|reasoning|web_search|mcp|network|repo|instruction/i.test(arg)));
});

test('a resume id is passed to the SDK CLI', async (t) => {
  const fixture = await makeProcessFixture(t);
  await collect(createCodexAdapter(fixture.runtime), fixture, 'basic', (events) =>
    events.some((event) => event.type === 'status' && event.status === 'done'), 'fake-thread');

  const [invocation] = await fixture.readInvocations();
  assert.deepEqual(invocation.argv.slice(-2), ['resume', 'fake-thread']);
});

test('completed SDK JSONL items normalize without retaining raw tool payloads', async (t) => {
  const fixture = await makeProcessFixture(t);
  const { events } = await collect(createCodexAdapter(fixture.runtime), fixture, 'basic', (all) =>
    all.some((event) => event.type === 'status' && event.status === 'done'));

  assert.deepEqual(events.filter((event) => event.type === 'msg'), [
    { type: 'msg', msg: { kind: 'text', text: 'fake response: basic' } },
    { type: 'msg', msg: { kind: 'tool', name: 'shell', summary: 'echo shell', status: 'ok' } },
    { type: 'msg', msg: { kind: 'tool', name: 'edit', summary: 'fake.ts', status: 'ok' } },
    { type: 'msg', msg: { kind: 'tool', name: 'fake-tool', summary: 'fake-server.fake-tool', status: 'ok' } },
    { type: 'msg', msg: { kind: 'tool', name: 'search', summary: 'fake search', status: 'ok' } },
  ]);
});

test('completed SDK JSONL usage is emitted', async (t) => {
  const fixture = await makeProcessFixture(t);
  const { events } = await collect(createCodexAdapter(fixture.runtime), fixture, 'basic', (all) =>
    all.some((event) => event.type === 'status' && event.status === 'done'));

  assert.ok(events.some((event) => event.type === 'usage'
    && event.inputTokens === 11 && event.outputTokens === 5));
});

test('follow-up prompts execute in FIFO order', async (t) => {
  const fixture = await makeProcessFixture(t);
  const adapter = createCodexAdapter(fixture.runtime);
  const events: AdapterEvent[] = [];
  const handle = adapter.start({ cwd: fixture.cwd, prompt: 'first', env: {} }, (event) => events.push(event));
  handle.send('second');

  await waitFor(async () => (await fixture.readInvocations()).length === 2);
  const invocations = await fixture.readInvocations();
  assert.deepEqual(invocations.map((invocation) => invocation.prompt), ['first', 'second']);
  assert.equal(events.filter((event) => event.type === 'status' && event.status === 'done').length, 2);
});

test('an unknown future SDK event does not interrupt completion', async (t) => {
  const fixture = await makeProcessFixture(t);
  const { events } = await collect(createCodexAdapter(fixture.runtime), fixture, 'unknown-event', (all) =>
    all.some((event) => event.type === 'status' && event.status === 'done'));

  assert.equal(events.filter((event) => event.type === 'stopped').length, 0);
});

test('malformed SDK JSONL becomes one stream failure without an unhandled rejection', async (t) => {
  const fixture = await makeProcessFixture(t);
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));

  const { events } = await collect(createCodexAdapter(fixture.runtime), fixture, 'malformed-json', (all) =>
    all.some((event) => event.type === 'stopped'));
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(stopped(events).code, 'codex_stream_failed');
  assert.deepEqual(unhandled, []);
});

test('a nonzero SDK process exit becomes a redacted stream failure', async (t) => {
  const fixture = await makeProcessFixture(t);
  const { events } = await collect(createCodexAdapter(fixture.runtime), fixture, 'nonzero-exit', (all) =>
    all.some((event) => event.type === 'stopped'));

  const event = stopped(events);
  assert.equal(event.code, 'codex_stream_failed');
  assert.match(event.reason, /Codex Exec exited with code 7/);
  assert.ok(!event.reason.includes('never-expose-me'));
});

test('a stream failure event receives the stable stream failure code', async (t) => {
  const fixture = await makeProcessFixture(t);
  const { events } = await collect(createCodexAdapter(fixture.runtime), fixture, 'fail-stream', (all) =>
    all.some((event) => event.type === 'stopped'));

  assert.deepEqual(stopped(events), {
    type: 'stopped', reason: 'fake stream failure', code: 'codex_stream_failed',
  });
});

test('a sandbox denial reports its failed tool before a sandbox failure', async (t) => {
  const fixture = await makeProcessFixture(t);
  const { events } = await collect(createCodexAdapter(fixture.runtime), fixture, 'sandbox-denied', (all) =>
    all.some((event) => event.type === 'stopped'));

  assert.ok(events.some((event) => event.type === 'msg' && event.msg.kind === 'tool'
    && event.msg.name === 'shell' && event.msg.status === 'error'));
  assert.equal(stopped(events).code, 'codex_sandbox_denied');
});

test('a failure before a turn starts is classified by start or resume route', async (t) => {
  const fixture = await makeProcessFixture(t);
  const start = await collect(createCodexAdapter(fixture.runtime), fixture, 'startup-failure', (all) =>
    all.some((event) => event.type === 'stopped'));
  const resume = await collect(createCodexAdapter(fixture.runtime), fixture, 'startup-failure', (all) =>
    all.some((event) => event.type === 'stopped'), 'fake-thread');

  assert.equal(stopped(start.events).code, 'codex_start_failed');
  assert.equal(stopped(resume.events).code, 'codex_resume_failed');
});

test('stop aborts a holding SDK turn exactly once with the user-stopped code', async (t) => {
  const fixture = await makeProcessFixture(t);
  const adapter = createCodexAdapter(fixture.runtime);
  const { events, handle } = await collect(adapter, fixture, 'hold', (all) =>
    all.some((event) => event.type === 'status' && event.status === 'working'));
  await waitFor(async () => (await fixture.readHoldLifecycle()).includes('alive'));
  assert.deepEqual(await fixture.readHoldLifecycle(), ['started', 'alive']);
  handle.stop();
  handle.stop();
  await waitFor(() => events.some((event) => event.type === 'stopped'));
  await waitFor(async () => (await fixture.readHoldLifecycle()).includes('aborted'));

  assert.deepEqual(events.filter((event) => event.type === 'stopped'), [{
    type: 'stopped', reason: 'Stopped by user.', code: 'codex_user_stopped',
  }]);
  assert.deepEqual(await fixture.readHoldLifecycle(), ['started', 'alive', 'aborted']);
});

test('stop marks queued FIFO prompts unsent before the terminal Codex event', async (t) => {
  const fixture = await makeProcessFixture(t);
  const adapter = createCodexAdapter(fixture.runtime);
  const events: AdapterEvent[] = [];
  const handle = adapter.start(
    { cwd: fixture.cwd, prompt: 'hold', promptId: 'initial', env: {} },
    (event) => events.push(event),
  );
  await waitFor(() => events.some((event) => event.type === 'status' && event.status === 'working'));
  handle.send('follow one', 'follow-1');
  handle.send('follow two', 'follow-2');
  handle.stop();
  await waitFor(() => events.some((event) => event.type === 'stopped'));

  assert.deepEqual(events.filter((event) => event.type !== 'status' && event.type !== 'vendor-session-id'), [
    { type: 'prompt-delivery', id: 'initial', delivery: 'sent' },
    { type: 'prompt-delivery', id: 'follow-1', delivery: 'unsent' },
    { type: 'prompt-delivery', id: 'follow-2', delivery: 'unsent' },
    {
      type: 'msg',
      msg: { kind: 'error', text: '2 queued prompts were not sent. Resend them manually if still needed.' },
    },
    { type: 'stopped', reason: 'Stopped by user.', code: 'codex_user_stopped' },
  ]);
});

test('public Codex failure classification prefers auth and sandbox over fallback', () => {
  assert.equal(classifyCodexFailure('401 unauthorized', 'codex_stream_failed'), 'codex_auth_unavailable');
  assert.equal(classifyCodexFailure('Operation not permitted by sandbox', 'codex_stream_failed'), 'codex_sandbox_denied');
  assert.equal(classifyCodexFailure('other failure', 'codex_stream_failed'), 'codex_stream_failed');
});
