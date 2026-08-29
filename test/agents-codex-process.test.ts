import assert from 'node:assert';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCodexAdapter, classifyCodexFailure } from '../src/agents/codex.ts';
import { MAX_CODEX_DETAIL_BYTES } from '../src/agents/codex-detail.ts';
import type { PreparedCodexRuntime } from '../src/agents/codex-runtime.ts';
import { resolveAgentPrompt } from '../src/prompt-input.ts';
import { Registry } from '../src/sessions.ts';
import type { Adapter, AdapterEvent } from '../src/types.ts';
import { writeFakeCodex } from './helpers/fake-codex.ts';

type FakeInvocation = {
  argv: string[];
  prompt: string;
  cwd: string;
  codexHome: string | null;
  imageBytes: string[];
};

type ProcessFixture = {
  cwd: string;
  codexHome: string;
  runtime: PreparedCodexRuntime;
  release(): Promise<void>;
  readInvocations(): Promise<FakeInvocation[]>;
  readHoldLifecycle(): Promise<string[]>;
};

async function makeProcessFixture(t: { after(fn: () => unknown): void }): Promise<ProcessFixture> {
  const dir = await mkdtemp(join(tmpdir(), 'switchboard-codex-process-'));
  const cwd = join(dir, 'workspace');
  const codexHome = join(dir, 'codex-home');
  const log = join(dir, 'fake-codex.jsonl');
  const holdLog = join(dir, 'fake-codex-hold.log');
  const releaseFile = join(dir, 'fake-codex-release');
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
        FAKE_CODEX_RELEASE_FILE: releaseFile,
        FAKE_CODEX_SECRET: 'never-expose-me',
      },
      diagnostics: [],
    },
    async readInvocations() {
      const contents = await readFile(log, 'utf8');
      return contents.split('\n').filter(Boolean).map((line) => JSON.parse(line) as FakeInvocation);
    },
    async release() {
      await writeFile(releaseFile, 'release');
    },
    async readHoldLifecycle() {
      return (await readFile(holdLog, 'utf8')).split('\n').filter(Boolean);
    },
  };
}

/**
 * Polls until `predicate` holds. The deadline is a hang detector, not a
 * performance assertion: a passing test returns on the first true poll, so a
 * generous deadline costs nothing and a tight one only measures how loaded the
 * machine is. At 2s this was the single largest source of suite flakiness —
 * `npm test` runs 22 files at CPU-count concurrency and several of them spawn
 * real child processes, so a wait that takes 30ms alone can take seconds under
 * that contention.
 */
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
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
    { cwd: fixture.cwd, prompt: { text: prompt, attachments: [] }, env: {}, ...(resumeId ? { resumeId } : {}) },
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

test('the prepared adapter forwards only explicit thread settings below fixed safety options', async (t) => {
  const fixture = await makeProcessFixture(t);
  const adapter = createCodexAdapter(fixture.runtime);
  await collect(adapter, fixture, 'configured', (all) =>
    all.some((event) => event.type === 'status' && event.status === 'done'));

  const inherited = (await fixture.readInvocations())[0].argv;
  assert.ok(!inherited.some((arg) => /--model|reasoning_effort|web_search|network_access/i.test(arg)));

  const events: AdapterEvent[] = [];
  adapter.start({
    cwd: fixture.cwd, env: {}, prompt: { text: 'explicit-settings', attachments: [] },
    codexSettings: {
      model: 'gpt-5.3-codex', modelReasoningEffort: 'high', webSearchMode: 'live', networkAccessEnabled: false,
    },
  }, (event) => events.push(event));
  await waitFor(() => events.some((event) => event.type === 'status' && event.status === 'done'));

  const explicit = (await fixture.readInvocations())[1].argv.join(' ');
  assert.match(explicit, /gpt-5\.3-codex/);
  assert.match(explicit, /model_reasoning_effort="high"/);
  assert.match(explicit, /web_search="live"/);
  assert.match(explicit, /sandbox_workspace_write\.network_access=false/);
  assert.match(explicit, /workspace-write/);
  assert.match(explicit, /approval_policy="never"/);
});

test('a resume id is passed to the SDK CLI', async (t) => {
  const fixture = await makeProcessFixture(t);
  await collect(createCodexAdapter(fixture.runtime), fixture, 'basic', (events) =>
    events.some((event) => event.type === 'status' && event.status === 'done'), 'fake-thread');

  const [invocation] = await fixture.readInvocations();
  assert.deepEqual(invocation.argv.slice(-2), ['resume', 'fake-thread']);
});

test('PNG, JPEG, and WebP attachments reach the real SDK as native image arguments', async (t) => {
  const fixture = await makeProcessFixture(t);
  const paths = {
    png: join(fixture.cwd, 'screen.png'),
    jpeg: join(fixture.cwd, 'photo.jpeg'),
    webp: join(fixture.cwd, 'diagram.webp'),
    file: join(fixture.cwd, 'notes.txt'),
  };
  await Promise.all([
    writeFile(paths.png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    writeFile(paths.jpeg, Buffer.from([0xff, 0xd8, 0xff])),
    writeFile(paths.webp, Buffer.from('RIFF0000WEBP')),
    writeFile(paths.file, 'notes'),
  ]);
  const events: AdapterEvent[] = [];

  createCodexAdapter(fixture.runtime).start({
    cwd: fixture.cwd,
    env: {},
    prompt: {
      text: 'Inspect the attachments',
      attachments: [
        { name: 'screen.png', relativePath: 'screen.png', absolutePath: paths.png, kind: 'image' },
        { name: 'photo.jpeg', relativePath: 'photo.jpeg', absolutePath: paths.jpeg, kind: 'image' },
        { name: 'diagram.webp', relativePath: 'diagram.webp', absolutePath: paths.webp, kind: 'image' },
        { name: 'notes.txt', relativePath: 'notes.txt', absolutePath: paths.file, kind: 'file' },
      ],
    },
  }, (event) => events.push(event));
  await waitFor(() => events.some((event) => event.type === 'status' && event.status === 'done'));

  const [invocation] = await fixture.readInvocations();
  assert.equal(invocation.prompt, 'Inspect the attachments\nAttached file: notes.txt');
  const imagePaths = invocation.argv.flatMap((arg, index, argv) =>
    arg === '--image' ? [argv[index + 1]] : []);
  assert.equal(imagePaths.length, 3);
  assert.ok(imagePaths.every((path) => !Object.values(paths).includes(path)),
    'the SDK must receive private snapshots, not mutable worktree paths');
  assert.deepEqual(invocation.imageBytes, [
    '89504e470d0a1a0a', 'ffd8ff', Buffer.from('RIFF0000WEBP').toString('hex'),
  ]);
  for (const path of imagePaths) {
    await waitFor(() => stat(path).then(() => false, () => true));
    await assert.rejects(stat(path), 'successful turns clean image snapshots');
  }
  assert.ok(!invocation.argv.includes(paths.file), 'ordinary files belong in prompt text, not --image');
});

test('a failed Codex turn cleans its private image snapshot', async (t) => {
  const fixture = await makeProcessFixture(t);
  const imagePath = join(fixture.cwd, 'failure.png');
  await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const prompt = await resolveAgentPrompt(fixture.cwd, 'startup-failure', ['failure.png']);
  const events: AdapterEvent[] = [];

  createCodexAdapter(fixture.runtime).start({ cwd: fixture.cwd, env: {}, prompt }, (event) => events.push(event));
  await waitFor(() => events.some((event) => event.type === 'stopped'));
  const [invocation] = await fixture.readInvocations();
  const snapshotPath = invocation.argv[invocation.argv.indexOf('--image') + 1];

  assert.notEqual(snapshotPath, imagePath);
  await waitFor(() => stat(snapshotPath).then(() => false, () => true));
  await assert.rejects(stat(snapshotPath), 'failed turns clean image snapshots');
});

test('stopping an in-flight Codex image turn cleans its private snapshot', async (t) => {
  const fixture = await makeProcessFixture(t);
  const imagePath = join(fixture.cwd, 'hold.png');
  await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const prompt = await resolveAgentPrompt(fixture.cwd, 'hold', ['hold.png']);
  const events: AdapterEvent[] = [];
  const handle = createCodexAdapter(fixture.runtime).start(
    { cwd: fixture.cwd, env: {}, prompt }, (event) => events.push(event),
  );
  await waitFor(async () => (await fixture.readInvocations()).length === 1);
  const [invocation] = await fixture.readInvocations();
  const snapshotPath = invocation.argv[invocation.argv.indexOf('--image') + 1];
  assert.notEqual(snapshotPath, imagePath);
  assert.ok((await stat(snapshotPath)).isFile(), 'snapshot stays available for the live SDK turn');
  await waitFor(async () => (await fixture.readHoldLifecycle()).includes('alive'));

  handle.stop();
  await waitFor(async () => (await fixture.readHoldLifecycle()).includes('aborted'));
  await waitFor(() => stat(snapshotPath).then(() => false, () => true));
  await assert.rejects(stat(snapshotPath), 'stopping the turn cleans its image snapshot');
});

test('a queued image swapped to a symlink is rejected before the SDK invocation', async (t) => {
  const fixture = await makeProcessFixture(t);
  const imagePath = join(fixture.cwd, 'queued.png');
  const outsidePath = join(fixture.cwd, '..', 'outside.png');
  await Promise.all([
    writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    writeFile(outsidePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  ]);
  const queuedPrompt = await resolveAgentPrompt(fixture.cwd, 'Inspect it', ['queued.png']);
  const events: AdapterEvent[] = [];
  const handle = createCodexAdapter(fixture.runtime).start({
    cwd: fixture.cwd, env: {},
    prompt: { text: 'releasable-hold', attachments: [] },
  }, (event) => events.push(event));
  await waitFor(async () => (await fixture.readInvocations()).length === 1);
  handle.send(queuedPrompt, 'queued-image');
  await rm(imagePath);
  await symlink(outsidePath, imagePath);
  await fixture.release();

  await waitFor(async () => (await fixture.readInvocations()).length > 1
    || events.some((event) => event.type === 'stopped'));
  assert.equal((await fixture.readInvocations()).length, 1,
    'an unsafe swapped path must never reach Codex --image');
  assert.deepEqual(events.filter((event) =>
    event.type === 'prompt-delivery' && event.id === 'queued-image'), [
    { type: 'prompt-delivery', id: 'queued-image', delivery: 'unsent' },
  ]);
  const failure = stopped(events);
  assert.equal(failure.reason, 'Attachment 1 must be a regular file, not a symbolic link.');
  assert.ok(!failure.reason.includes(imagePath));
  assert.ok(!failure.reason.includes(outsidePath));
});

test('completed SDK JSONL items normalize into append-only text and tool upserts', async (t) => {
  const fixture = await makeProcessFixture(t);
  const { events } = await collect(createCodexAdapter(fixture.runtime), fixture, 'basic', (all) =>
    all.some((event) => event.type === 'status' && event.status === 'done'));

  const serialized = JSON.stringify(events);
  assert.ok(!serialized.includes('never-expose-me'), 'account secret must not survive into any event');

  assert.deepEqual(events.filter((event) => event.type === 'msg'), [
    { type: 'msg', msg: { kind: 'text', text: 'fake response: basic' } },
  ]);
  assert.deepEqual(events.filter((event) => event.type === 'upsert-msg').map((event) =>
    event.type === 'upsert-msg' && event.msg.kind === 'tool'
      ? { id: event.msg.id, name: event.msg.name, status: event.msg.status }
      : null), [
    { id: 'command-1', name: 'shell', status: 'ok' },
    { id: 'file-1', name: 'edit', status: 'ok' },
    { id: 'mcp-1', name: 'fake-tool', status: 'ok' },
    { id: 'search-1', name: 'search', status: 'ok' },
  ]);
});

test('rich SDK lifecycles update one Registry row per item with safe bounded detail', async (t) => {
  const fixture = await makeProcessFixture(t);
  const registry = new Registry('/dev/null');
  const session = registry.create({
    provider: 'codex', account: 'fake', repo: fixture.cwd, cwd: fixture.cwd,
    branch: 'codex/rich-lifecycle', title: 'Rich lifecycle',
  });
  const events: AdapterEvent[] = [];
  createCodexAdapter(fixture.runtime).start(
    { cwd: fixture.cwd, prompt: { text: 'rich-lifecycle', attachments: [] }, env: {} },
    (event) => {
      events.push(event);
      registry.apply(session.id, event);
    },
  );
  await waitFor(() => events.some((event) => event.type === 'status' && event.status === 'done'));

  const upserts = events.filter((event) => event.type === 'upsert-msg');
  const detailEvents = upserts.filter((event) => event.msg.kind === 'tool' && event.msg.detail !== undefined);
  assert.ok(detailEvents.length > 0);
  for (const event of detailEvents) {
    assert.equal(Buffer.byteLength(event.msg.kind === 'tool' ? event.msg.detail! : '', 'utf8')
      <= MAX_CODEX_DETAIL_BYTES, true);
    assert.doesNotMatch(event.msg.kind === 'tool' ? event.msg.detail! : '', /never-expose-me/);
  }

  const transcript = registry.get(session.id)!.transcript;
  assert.doesNotMatch(JSON.stringify(transcript), /never-expose-me/);
  assert.doesNotMatch(JSON.stringify(registry.publicSessions()), /never-expose-me/);
  for (const id of ['rich-command', 'rich-mcp', 'rich-file', 'rich-search', 'rich-reasoning', 'rich-todo']) {
    assert.equal(transcript.filter((message) => 'id' in message && message.id === id).length, 1, id);
  }

  const command = transcript.find((message) => message.kind === 'tool' && message.id === 'rich-command');
  assert.ok(command?.kind === 'tool');
  assert.equal(command.status, 'ok');
  assert.equal(command.summary, 'npm test [REDACTED]');
  assert.equal(command.detail, 'all command output [REDACTED]');

  const mcp = transcript.find((message) => message.kind === 'tool' && message.id === 'rich-mcp');
  assert.ok(mcp?.kind === 'tool');
  assert.equal(mcp.status, 'ok');
  assert.equal(mcp.detailTruncated, true);
  assert.match(mcp.detail ?? '', /\n\[truncated\]$/);
  assert.match(mcp.detail ?? '', /\[REDACTED\]/);
  assert.doesNotMatch(mcp.detail ?? '', /never-expose-me/);

  assert.deepEqual(transcript.find((message) => message.kind === 'reasoning'), {
    kind: 'reasoning', id: 'rich-reasoning', text: 'Verified the lifecycle [REDACTED]',
  });
  assert.deepEqual(transcript.find((message) => message.kind === 'todo'), {
    kind: 'todo', id: 'rich-todo', items: [
      { text: 'Inspect events [REDACTED]', completed: true },
      { text: 'Run tests [REDACTED]', completed: true },
    ],
  });
  assert.deepEqual(transcript.filter((message) => message.kind === 'text'), [
    { kind: 'text', text: 'rich lifecycle response' },
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
  const handle = adapter.start(
    { cwd: fixture.cwd, prompt: { text: 'first', attachments: [] }, env: {} },
    (event) => events.push(event),
  );
  handle.send({ text: 'second', attachments: [] });

  // Wait for both things this test asserts on, not just the first. The
  // invocation log is written when a turn starts; the `done` event arrives when
  // it finishes, through a separate async path. Waiting only for two log
  // entries can therefore return with the second `done` still in flight, which
  // fails the count below under load.
  const doneCount = () => events.filter((e) => e.type === 'status' && e.status === 'done').length;
  await waitFor(async () => (await fixture.readInvocations()).length === 2 && doneCount() === 2);
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

  assert.ok(events.some((event) => event.type === 'upsert-msg' && event.msg.kind === 'tool'
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
    { cwd: fixture.cwd, prompt: { text: 'hold', attachments: [] }, promptId: 'initial', env: {} },
    (event) => events.push(event),
  );
  await waitFor(() => events.some((event) => event.type === 'status' && event.status === 'working'));
  handle.send({ text: 'follow one', attachments: [] }, 'follow-1');
  handle.send({ text: 'follow two', attachments: [] }, 'follow-2');
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
