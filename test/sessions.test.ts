import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry, type RegistryOptions } from '../src/sessions.ts';
import type { AdapterEvent } from '../src/types.ts';
import { Usage } from '../src/usage.ts';

function make(options?: RegistryOptions): { reg: Registry; id: string } {
  const reg = new Registry('/dev/null', undefined, options);
  const s = reg.create({
    provider: 'claude', account: 'main', repo: '/r',
    cwd: '/r/.claude/worktrees/x', branch: 'x', title: 'x',
  });
  return { reg, id: s.id };
}

function makeTwo(options?: RegistryOptions): { reg: Registry; first: string; second: string } {
  const reg = new Registry('/dev/null', undefined, options);
  const first = reg.create({
    provider: 'codex', account: 'codex', repo: '/r',
    cwd: '/r/first', branch: 'first', title: 'first',
  }).id;
  const second = reg.create({
    provider: 'codex', account: 'codex', repo: '/r',
    cwd: '/r/second', branch: 'second', title: 'second',
  }).id;
  return { reg, first, second };
}

async function writePromptMigrationState(
  t: { after(fn: () => unknown): void },
  transcript: unknown[],
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sb-prompt-migration-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  await writeFile(path, JSON.stringify({ sessions: [{
    id: 'prompt-migration', provider: 'codex', account: 'codex', vendorSessionId: null,
    repo: '/r', cwd: '/r/wt', branch: 'b', title: 'prompt migration', status: 'working',
    transcript, pending: null, stoppedReason: null, startedAt: 1, statusSince: 1,
  }] }));
  return path;
}

test('a new session starts working with an empty transcript', () => {
  const { reg, id } = make();
  const s = reg.get(id)!;
  assert.equal(s.status, 'working');
  assert.deepEqual(s.transcript, []);
  assert.equal(s.pending, null);
  assert.equal(s.lastUsage, null);
});

test('usage events replace a session’s SDK-backed last-turn usage', () => {
  const { reg, id } = make();
  reg.apply(id, {
    type: 'usage', inputTokens: 10, outputTokens: 5,
    cachedInputTokens: 3, cacheWriteInputTokens: 7, reasoningOutputTokens: 2,
  });

  assert.deepEqual(reg.get(id)!.lastUsage, {
    inputTokens: 10, outputTokens: 5,
    cachedInputTokens: 3, cacheWriteInputTokens: 7, reasoningOutputTokens: 2,
  });
});

test('Codex settings persist only explicit values and legacy sessions inherit them', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sb-codex-settings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  const registry = new Registry(path);
  const configured = registry.create({
    provider: 'codex', account: 'codex', repo: '/r', cwd: '/r/configured',
    branch: 'configured', title: 'configured',
    codexSettings: { model: 'gpt-5.3-codex', networkAccessEnabled: false },
  });
  const inherited = registry.create({
    provider: 'codex', account: 'codex', repo: '/r', cwd: '/r/inherited',
    branch: 'inherited', title: 'inherited',
  });

  registry.setCodexSettings(configured.id, { webSearchMode: 'cached' });
  await registry.save();
  const stored = await readFile(path, 'utf8');
  assert.match(stored, /"webSearchMode": "cached"/);
  assert.doesNotMatch(stored, /"modelReasoningEffort"|"networkAccessEnabled"/);

  const loaded = await Registry.load(path);
  assert.deepEqual(loaded.get(configured.id)!.codexSettings, { webSearchMode: 'cached' });
  assert.equal(loaded.get(inherited.id)!.codexSettings, undefined);
  assert.equal(loaded.publicSessions().find((s) => s.id === inherited.id)!.codexSettings, undefined);
});

test('load drops invalid or non-Codex persisted settings so they cannot reach an adapter', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sb-codex-settings-load-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  await writeFile(path, JSON.stringify({ sessions: [
    {
      id: 'invalid-codex', provider: 'codex', account: 'codex', vendorSessionId: null,
      repo: '/r', cwd: '/r/invalid', branch: 'invalid', title: 'invalid', status: 'done', auto: false,
      codexSettings: { modelReasoningEffort: 'maximum', networkAccessEnabled: 'false' },
      transcript: [], pending: null, stoppedReason: null, stoppedCode: null, startedAt: 1, statusSince: 1,
    },
    {
      id: 'claude-settings', provider: 'claude', account: 'claude', vendorSessionId: null,
      repo: '/r', cwd: '/r/claude', branch: 'claude', title: 'claude', status: 'done', auto: false,
      codexSettings: { model: 'gpt-5.3-codex' },
      transcript: [], pending: null, stoppedReason: null, stoppedCode: null, startedAt: 1, statusSince: 1,
    },
  ] }));

  const loaded = await Registry.load(path);
  assert.equal(loaded.get('invalid-codex')!.codexSettings, undefined);
  assert.equal(loaded.get('claude-settings')!.codexSettings, undefined);
});

test('prompt delivery moves queued to sent by stable id', () => {
  const { reg, id } = make();
  const promptId = reg.appendPrompt(id, 'run the tests', 'queued');
  reg.apply(id, { type: 'prompt-delivery', id: promptId, delivery: 'sent' });

  assert.deepEqual(reg.get(id)!.transcript.at(-1), {
    kind: 'user', id: promptId, text: 'run the tests', delivery: 'sent',
  });
});

test('unknown prompt delivery ids leave accepted prompts unchanged', () => {
  const { reg, id } = make();
  const promptId = reg.appendPrompt(id, 'keep this delivery', 'queued');
  reg.apply(id, { type: 'prompt-delivery', id: 'not-a-prompt', delivery: 'sent' });

  assert.deepEqual(reg.get(id)!.transcript.at(-1), {
    kind: 'user', id: promptId, text: 'keep this delivery', delivery: 'queued',
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
  assert.ok(legacy.id, 'legacy prompts receive a durable ID');
  assert.deepEqual(loaded.transcript[1], {
    kind: 'user', id: 'queued-1', text: 'interrupted', delivery: 'unsent',
  });
  assert.match((loaded.transcript.at(-1) as { text: string }).text, /1 queued prompt was not sent/);
});

test('load converts every queued prompt to unsent and preserves sent prompts', async (t) => {
  const path = await writePromptMigrationState(t, [
    { kind: 'user', id: 'sent-1', text: 'already delivered', delivery: 'sent' },
    { kind: 'user', id: 'queued-1', text: 'first interrupted', delivery: 'queued' },
    { kind: 'user', id: 'queued-2', text: 'second interrupted', delivery: 'queued' },
  ]);

  const loaded = (await Registry.load(path)).all()[0];
  assert.deepEqual(loaded.transcript.slice(0, 3), [
    { kind: 'user', id: 'sent-1', text: 'already delivered', delivery: 'sent' },
    { kind: 'user', id: 'queued-1', text: 'first interrupted', delivery: 'unsent' },
    { kind: 'user', id: 'queued-2', text: 'second interrupted', delivery: 'unsent' },
  ]);
  assert.deepEqual(loaded.transcript.at(-1), {
    kind: 'error', text: '2 queued prompts were not sent. Resend them manually if still needed.',
  });
});

test('attachment names survive Registry save, reload, and public projection', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sb-attachment-reload-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  const registry = new Registry(path);
  const session = registry.create({
    provider: 'codex', account: 'codex', repo: '/r', cwd: '/r/wt',
    branch: 'attachments', title: 'attachments',
  });
  registry.appendPrompt(session.id, 'Inspect these', 'sent', ['screen.png', 'notes.txt']);
  await registry.save();

  const loaded = await Registry.load(path);
  const message = loaded.get(session.id)!.transcript[0];
  assert.ok(message.kind === 'user');
  assert.deepEqual(message.attachments, ['screen.png', 'notes.txt']);
  const publicMessage = loaded.publicSessions()[0].transcript[0];
  assert.ok(publicMessage.kind === 'user');
  assert.deepEqual(publicMessage.attachments, ['screen.png', 'notes.txt']);
});

test('load drops malformed and path-bearing attachment values but preserves safe names', async (t) => {
  const path = await writePromptMigrationState(t, [
    {
      kind: 'user', id: 'safe-prompt', text: 'inspect', delivery: 'sent',
      attachments: [
        'screen.png', '../secret.txt', '/tmp/secret.txt', 'nested/file.txt',
        'folder\\secret.txt', '', '.', '..', 42, null,
      ],
    },
    {
      kind: 'user', id: 'malformed-array', text: 'inspect', delivery: 'sent',
      attachments: 'screen.png',
    },
  ]);

  const loaded = await Registry.load(path);
  const [safe, malformed] = loaded.all()[0].transcript;
  assert.ok(safe.kind === 'user');
  assert.deepEqual(safe.attachments, ['screen.png']);
  assert.ok(malformed.kind === 'user');
  assert.equal('attachments' in malformed, false);
  assert.ok(!JSON.stringify(loaded.publicSessions()).includes('secret.txt'));
});

test('load ignores malformed transcript entries without losing the valid session', async (t) => {
  const path = await writePromptMigrationState(t, [
    null,
    'not a transcript message',
    { kind: 'user', text: 'legacy prompt' },
    { kind: 'text', text: 'kept response' },
  ]);

  const loaded = await Registry.load(path);
  assert.equal(loaded.all().length, 1);
  assert.equal(loaded.all()[0].transcript.length, 2);
  const [legacy, response] = loaded.all()[0].transcript;
  assert.equal(legacy.kind, 'user');
  assert.ok(legacy.kind === 'user');
  assert.equal(legacy.text, 'legacy prompt');
  assert.equal(legacy.delivery, 'sent');
  assert.ok(legacy.id);
  assert.deepEqual(response, { kind: 'text', text: 'kept response' });
});

test('an approval event sets needs-you and stores the request', () => {
  const { reg, id } = make();
  reg.apply(id, { type: 'approval', request: { id: 'a1', tool: 'Bash', summary: 'rm -rf dist' } });
  const s = reg.get(id)!;
  assert.equal(s.status, 'needs-you');
  assert.deepEqual(s.pending, { id: 'a1', tool: 'Bash', summary: 'rm -rf dist' });
});

test('a pending approval is not clobbered by a working status event', () => {
  const { reg, id } = make();
  reg.apply(id, { type: 'approval', request: { id: 'a1', tool: 'Bash', summary: 'x' } });

  // The Claude adapter emits this on every SDK message and every send(), both of
  // which run while canUseTool() is still blocked on the user.
  reg.apply(id, { type: 'status', status: 'working' });
  assert.equal(reg.get(id)!.status, 'needs-you', 'a blocked session must stay needs-you');
  assert.deepEqual(reg.get(id)!.pending, { id: 'a1', tool: 'Bash', summary: 'x' });

  // Once the approval is resolved, status events take effect again.
  reg.apply(id, { type: 'approval-resolved' });
  reg.apply(id, { type: 'status', status: 'done' });
  assert.equal(reg.get(id)!.status, 'done');
});

test('resolving an approval clears pending and returns to working', () => {
  const { reg, id } = make();
  reg.apply(id, { type: 'approval', request: { id: 'a1', tool: 'Bash', summary: 'x' } });
  reg.apply(id, { type: 'approval-resolved' });
  const s = reg.get(id)!;
  assert.equal(s.status, 'working');
  assert.equal(s.pending, null);
});

test('a stopped event records the reason and never reverts', () => {
  const { reg, id } = make();
  reg.apply(id, { type: 'stopped', reason: 'exit 1' });
  reg.apply(id, { type: 'status', status: 'working' });
  const s = reg.get(id)!;
  assert.equal(s.status, 'stopped');
  assert.equal(s.stoppedReason, 'exit 1');
});

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

test('statusSince advances only when the status actually changes', () => {
  const { reg, id } = make();
  const first = reg.get(id)!.statusSince;
  reg.apply(id, { type: 'status', status: 'working' });
  assert.equal(reg.get(id)!.statusSince, first);
  // Busy-wait to ensure next Date.now() returns a different millisecond
  const target = Date.now();
  while (Date.now() === target) {}
  reg.apply(id, { type: 'status', status: 'done' });
  assert.notEqual(reg.get(id)!.statusSince, first);
});

test('subscribers are notified on every apply', () => {
  const { reg, id } = make();
  let calls = 0;
  const unsub = reg.subscribe(() => { calls++; });
  reg.apply(id, { type: 'msg', msg: { kind: 'text', text: 'hi' } });
  assert.equal(calls, 1);
  unsub();
  reg.apply(id, { type: 'msg', msg: { kind: 'text', text: 'again' } });
  assert.equal(calls, 1);
});

test('a saved registry reloads with sessions marked stopped', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sb-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');

  const reg = new Registry(path);
  const s = reg.create({
    provider: 'codex', account: 'codex', repo: '/r',
    cwd: '/r/wt', branch: 'b', title: 'title',
  });
  reg.apply(s.id, { type: 'msg', msg: { kind: 'text', text: 'hello' } });
  await reg.save();

  const back = await Registry.load(path);
  const loaded = back.get(s.id)!;
  assert.equal(loaded.title, 'title');
  assert.equal(loaded.status, 'stopped');
  assert.equal(loaded.stoppedReason, 'switchboard restarted');
  assert.deepEqual(loaded.transcript, [{ kind: 'text', text: 'hello' }]);
});

test('a reloaded session updates statusSince to restart time', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sb-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');

  const reg = new Registry(path);
  const s = reg.create({
    provider: 'claude', account: 'main', repo: '/r',
    cwd: '/r/wt', branch: 'b', title: 'title',
  });
  const originalStatusSince = s.statusSince;
  await reg.save();

  // Busy-wait to ensure next Date.now() returns a different millisecond
  const target = Date.now();
  while (Date.now() === target) {}

  const before = Date.now();
  const back = await Registry.load(path);
  const after = Date.now();
  const loaded = back.get(s.id)!;
  assert.ok(loaded.statusSince >= before, 'statusSince should be at or after reload time');
  assert.notEqual(loaded.statusSince, originalStatusSince, 'statusSince should have changed');
});

test('a tool-result event updates the matching tool message and ignores unknown ids', () => {
  const { reg, id } = make();
  reg.apply(id, {
    type: 'msg',
    msg: { kind: 'tool', name: 'Bash', summary: 'ls', status: 'running', id: 't1' },
  });

  reg.apply(id, { type: 'tool-result', id: 'nope', ok: true });
  assert.deepEqual(reg.get(id)!.transcript[0], {
    kind: 'tool', name: 'Bash', summary: 'ls', status: 'running', id: 't1',
  });

  reg.apply(id, { type: 'tool-result', id: 't1', ok: false });
  assert.deepEqual(reg.get(id)!.transcript[0], {
    kind: 'tool', name: 'Bash', summary: 'ls', status: 'error', id: 't1',
  });
});

test('concurrent saves all resolve and leave valid, parseable state', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sb-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');

  const reg = new Registry(path);
  const s = reg.create({
    provider: 'claude', account: 'main', repo: '/r',
    cwd: '/r/wt', branch: 'b', title: 'title',
  });

  const results = await Promise.allSettled([reg.save(), reg.save(), reg.save(), reg.save()]);
  assert.ok(
    results.every((r) => r.status === 'fulfilled'),
    `every concurrent save should resolve, got: ${JSON.stringify(results)}`,
  );

  const parsed = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(parsed.sessions.length, 1);
  assert.equal(parsed.sessions[0].id, s.id);
  assert.equal(parsed.sessions[0].title, 'title');
});

test('usage samples are persisted alongside sessions and restored on load', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sb-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');

  const usage = new Usage();
  const reg = new Registry(path, usage);
  reg.create({
    provider: 'claude', account: 'main', repo: '/r', cwd: '/r/wt', branch: 'b', title: 't',
  });
  usage.record('main', 300, 100);
  await reg.save();

  const back = new Usage();
  const reloaded = await Registry.load(path, back);
  assert.equal(reloaded.all().length, 1);
  assert.equal(back.pace('main', 1000), 0.4, 'pace must survive a restart');
});

test('a pre-usage state.json (a bare session array) still loads', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sb-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');

  // The shape state.json had before usage was persisted.
  await writeFile(path, JSON.stringify([{
    id: 'old-1', provider: 'claude', account: 'main', vendorSessionId: null,
    repo: '/r', cwd: '/r/wt', branch: 'b', title: 'old title', status: 'working',
    transcript: [{ kind: 'text', text: 'hello' }], pending: null, stoppedReason: null,
    startedAt: 1, statusSince: 1,
  }]));

  const usage = new Usage();
  const reg = await Registry.load(path, usage);
  const loaded = reg.get('old-1')!;
  assert.equal(loaded.title, 'old title');
  assert.equal(loaded.status, 'stopped');
  assert.deepEqual(loaded.transcript, [{ kind: 'text', text: 'hello' }]);
  assert.equal(loaded.lastUsage, null);
  assert.equal(usage.pace('main', 1000), 0, 'no usage history to restore, but no crash');
});

test('revive clears stopped state and notifies subscribers', () => {
  const { reg, id } = make();
  reg.apply(id, { type: 'stopped', reason: 'exit 1' });
  assert.equal(reg.get(id)!.status, 'stopped');

  let calls = 0;
  const unsub = reg.subscribe(() => { calls++; });
  reg.revive(id);
  unsub();

  const s = reg.get(id)!;
  assert.equal(s.status, 'working');
  assert.equal(s.stoppedReason, null);
  assert.equal(s.stoppedCode, null);
  assert.equal(s.pending, null);
  assert.equal(calls, 1, 'revive should notify subscribers');
});

test('a corrupted state.json returns an empty registry instead of crashing', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sb-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');

  await writeFile(path, '{invalid json');

  const reg = await Registry.load(path);
  assert.deepEqual(reg.all(), [], 'should return empty registry for corrupted file');
});

test('a state.json of the right syntax but the wrong shape loads as empty', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sb-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');

  // `sessions` as a string used to be iterated character by character into garbage
  // sessions keyed on `undefined`. The file is hand-editable; it gets no trust.
  for (const content of ['null', '42', '{"sessions":"nope"}', '{"sessions":[{"no":"id"}]}']) {
    await writeFile(path, content);
    const reg = await Registry.load(path, new Usage());
    assert.deepEqual(reg.all(), [], `${content} should load as empty`);
  }
});

test('upsert-msg keeps one lifecycle row per kind and id', () => {
  const { reg, id } = make();
  reg.apply(id, { type: 'upsert-msg', msg: {
    kind: 'tool', id: 'item-1', name: 'shell', summary: 'npm test', status: 'running',
  } });
  reg.apply(id, { type: 'upsert-msg', msg: {
    kind: 'tool', id: 'item-1', name: 'shell', summary: 'npm test', status: 'ok',
    detail: '84 tests passed', detailTruncated: false,
  } });

  assert.deepEqual(reg.get(id)!.transcript, [{
    kind: 'tool', id: 'item-1', name: 'shell', summary: 'npm test', status: 'ok',
    detail: '84 tests passed', detailTruncated: false,
    detailEvicted: false, detailRevision: 1,
  }]);
});

test('upsert identity requires both kind and id while preserving row order', () => {
  const { reg, id } = make();
  reg.apply(id, { type: 'upsert-msg', msg: {
    kind: 'tool', id: 'shared', name: 'shell', summary: 'first', status: 'running',
  } });
  reg.apply(id, { type: 'upsert-msg', msg: {
    kind: 'todo', id: 'shared', items: [{ text: 'one', completed: false }],
  } });
  reg.apply(id, { type: 'upsert-msg', msg: {
    kind: 'tool', id: 'other', name: 'shell', summary: 'other', status: 'ok',
  } });
  reg.apply(id, { type: 'upsert-msg', msg: {
    kind: 'tool', id: 'shared', name: 'shell', summary: 'finished', status: 'ok',
  } });

  assert.deepEqual(reg.get(id)!.transcript, [
    { kind: 'tool', id: 'shared', name: 'shell', summary: 'finished', status: 'ok' },
    { kind: 'todo', id: 'shared', items: [{ text: 'one', completed: false }] },
    { kind: 'tool', id: 'other', name: 'shell', summary: 'other', status: 'ok' },
  ]);
});

test('upsert replaces reasoning and todo bodies rather than appending or merging', () => {
  const { reg, id } = make();
  reg.apply(id, { type: 'upsert-msg', msg: { kind: 'reasoning', id: 'r1', text: 'draft' } });
  reg.apply(id, { type: 'upsert-msg', msg: {
    kind: 'todo', id: 't1', items: [{ text: 'first', completed: false }],
  } });
  reg.apply(id, { type: 'upsert-msg', msg: { kind: 'reasoning', id: 'r1', text: 'final' } });
  reg.apply(id, { type: 'upsert-msg', msg: {
    kind: 'todo', id: 't1', items: [{ text: 'replacement', completed: true }],
  } });

  assert.deepEqual(reg.get(id)!.transcript, [
    { kind: 'reasoning', id: 'r1', text: 'final' },
    { kind: 'todo', id: 't1', items: [{ text: 'replacement', completed: true }] },
  ]);
});

test('legacy msg events remain append-only', () => {
  const { reg, id } = make();
  reg.apply(id, { type: 'msg', msg: { kind: 'text', text: 'same' } });
  reg.apply(id, { type: 'msg', msg: { kind: 'text', text: 'same' } });
  assert.deepEqual(reg.get(id)!.transcript, [
    { kind: 'text', text: 'same' },
    { kind: 'text', text: 'same' },
  ]);
});

test('a detail-bearing legacy msg event cannot bypass the global detail budget', () => {
  const { reg, id } = make({ maxTotalDetailBytes: 5 });
  const defensiveEvent = {
    type: 'msg',
    msg: {
      kind: 'tool', id: 'legacy-tool', name: 'shell', summary: 'legacy', status: 'ok',
      detail: '123456', detailTruncated: false,
    },
  } as AdapterEvent;

  reg.apply(id, defensiveEvent);

  assert.deepEqual(reg.getToolDetail(id, 'legacy-tool'), {
    text: null, truncated: false, evicted: true, revision: 2,
  });
  assert.deepEqual(reg.get(id)!.transcript, [{
    kind: 'tool', id: 'legacy-tool', name: 'shell', summary: 'legacy', status: 'ok',
    detailTruncated: false, detailEvicted: true, detailRevision: 2,
  }]);
});

test('detail budget evicts the least-recently-updated whole body across sessions', () => {
  const { reg, first, second } = makeTwo({ maxTotalDetailBytes: 10 });
  reg.apply(first, { type: 'upsert-msg', msg: {
    kind: 'tool', id: 'old', name: 'shell', summary: 'old', status: 'ok',
    detail: 'aaaaaa', detailTruncated: false,
  } });
  reg.apply(second, { type: 'upsert-msg', msg: {
    kind: 'tool', id: 'new', name: 'shell', summary: 'new', status: 'ok',
    detail: 'bbbbbb', detailTruncated: false,
  } });

  assert.deepEqual(reg.getToolDetail(first, 'old'), {
    text: null, truncated: false, evicted: true, revision: 3,
  });
  assert.deepEqual(reg.getToolDetail(second, 'new'), {
    text: 'bbbbbb', truncated: false, evicted: false, revision: 2,
  });
  assert.deepEqual(reg.get(first)!.transcript[0], {
    kind: 'tool', id: 'old', name: 'shell', summary: 'old', status: 'ok',
    detailTruncated: false, detailEvicted: true, detailRevision: 3,
  }, 'eviction removes the whole body without losing its summary or status');
});

test('upserting an older detail touches it so the other body is evicted', () => {
  const { reg, first, second } = makeTwo({ maxTotalDetailBytes: 12 });
  reg.apply(first, { type: 'upsert-msg', msg: {
    kind: 'tool', id: 'first', name: 'shell', summary: 'first', status: 'ok', detail: 'aaaaaa',
  } });
  reg.apply(second, { type: 'upsert-msg', msg: {
    kind: 'tool', id: 'second', name: 'shell', summary: 'second', status: 'ok', detail: 'bbbbbb',
  } });
  reg.apply(first, { type: 'upsert-msg', msg: {
    kind: 'tool', id: 'first', name: 'shell', summary: 'touched', status: 'ok', detail: 'aaaaaa',
  } });
  reg.apply(first, { type: 'upsert-msg', msg: {
    kind: 'tool', id: 'third', name: 'shell', summary: 'third', status: 'ok', detail: 'cccccc',
  } });

  assert.equal(reg.getToolDetail(first, 'first')!.text, 'aaaaaa');
  assert.deepEqual(reg.getToolDetail(second, 'second'), {
    text: null, truncated: false, evicted: true, revision: 5,
  });
  assert.equal(reg.getToolDetail(first, 'third')!.text, 'cccccc');
});

test('detail budget counts UTF-8 bytes instead of characters', () => {
  const { reg, first, second } = makeTwo({ maxTotalDetailBytes: 5 });
  reg.apply(first, { type: 'upsert-msg', msg: {
    kind: 'tool', id: 'emoji', name: 'shell', summary: 'emoji', status: 'ok', detail: '🙂',
  } });
  reg.apply(second, { type: 'upsert-msg', msg: {
    kind: 'tool', id: 'ascii', name: 'shell', summary: 'ascii', status: 'ok', detail: 'aa',
  } });

  assert.equal(reg.getToolDetail(first, 'emoji')!.text, null);
  assert.equal(reg.getToolDetail(first, 'emoji')!.evicted, true);
  assert.equal(reg.getToolDetail(second, 'ascii')!.text, 'aa');
});

test('load seeds legacy detail revisions and enforces the global budget', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sb-detail-migration-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  const base = {
    provider: 'codex', account: 'codex', vendorSessionId: null, repo: '/r',
    branch: 'b', title: 'legacy', status: 'working', pending: null,
    stoppedReason: null, startedAt: 1, statusSince: 1,
  };
  await writeFile(path, JSON.stringify({ sessions: [
    { ...base, id: 'first', cwd: '/r/first', transcript: [{
      kind: 'tool', id: 'old', name: 'shell', summary: 'old', status: 'ok', detail: 'aaaaaa',
    }] },
    { ...base, id: 'second', cwd: '/r/second', transcript: [{
      kind: 'tool', id: 'new', name: 'shell', summary: 'new', status: 'ok', detail: 'bbbbbb',
    }] },
  ] }));

  const reg = await Registry.load(path, undefined, { maxTotalDetailBytes: 10 });
  assert.deepEqual(reg.getToolDetail('first', 'old'), {
    text: null, truncated: false, evicted: true, revision: 3,
  });
  assert.deepEqual(reg.getToolDetail('second', 'new'), {
    text: 'bbbbbb', truncated: false, evicted: false, revision: 2,
  });
});

test('publicSessions exposes detail metadata without bodies or mutating storage', () => {
  const { reg, id } = make();
  reg.apply(id, { type: 'upsert-msg', msg: {
    kind: 'tool', id: 'with', name: 'shell', summary: 'with', status: 'ok',
    detail: 'private body', detailTruncated: true,
  } });
  reg.apply(id, { type: 'upsert-msg', msg: {
    kind: 'tool', id: 'without', name: 'shell', summary: 'without', status: 'running',
  } });

  const publicSession = reg.publicSessions()[0];
  assert.deepEqual(publicSession.transcript, [
    {
      kind: 'tool', id: 'with', name: 'shell', summary: 'with', status: 'ok',
      detailAvailable: true, detailTruncated: true, detailEvicted: false, detailRevision: 1,
    },
    {
      kind: 'tool', id: 'without', name: 'shell', summary: 'without', status: 'running',
      detailAvailable: false, detailTruncated: false, detailEvicted: false, detailRevision: 0,
    },
  ]);
  assert.equal(JSON.stringify(publicSession).includes('private body'), false);
  assert.equal(reg.getToolDetail(id, 'with')!.text, 'private body', 'projection must not mutate Registry state');
});

test('getToolDetail only resolves tool entries with the matching id', () => {
  const { reg, id } = make();
  reg.apply(id, { type: 'upsert-msg', msg: { kind: 'reasoning', id: 'shared', text: 'summary' } });
  assert.equal(reg.getToolDetail(id, 'shared'), null);
  assert.equal(reg.getToolDetail('missing-session', 'shared'), null);
});
