import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '../src/sessions.ts';
import { Usage } from '../src/usage.ts';
import { Scheduler } from '../src/schedule.ts';

function make(): { reg: Registry; id: string } {
  const reg = new Registry('/dev/null');
  const s = reg.create({
    provider: 'claude', account: 'main', repo: '/r',
    cwd: '/r/.claude/worktrees/x', branch: 'x', title: 'x',
  });
  return { reg, id: s.id };
}

test('a new session starts working with an empty transcript', () => {
  const { reg, id } = make();
  const s = reg.get(id)!;
  assert.equal(s.status, 'working');
  assert.deepEqual(s.transcript, []);
  assert.equal(s.pending, null);
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

test('the queue round-trips through state.json', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sb-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');

  const sched = new Scheduler();
  sched.add({ kind: 'at', time: 123 }, {
    kind: 'create', repo: '/r', branch: 'b', account: 'main', prompt: 'go',
  });
  await new Registry(path, undefined, sched).save();

  const back = new Scheduler();
  await Registry.load(path, undefined, back);
  assert.equal(back.all().length, 1);
  assert.equal(back.all()[0].trigger.kind, 'at');
});

test('load restores a valid queued item and drops a malformed one', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sb-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');

  const valid = {
    id: 'v1',
    trigger: { kind: 'at', time: 123 },
    action: { kind: 'create', repo: '/r', branch: 'b', account: 'main', prompt: 'go' },
    createdAt: 100,
    state: 'waiting',
    error: null,
  };
  // Unrecognized trigger.kind — Scheduler.restore() rejects it outright.
  const malformed = {
    id: 'bad',
    trigger: { kind: 'bogus' },
    action: { kind: 'create', repo: '/r', branch: 'b', account: 'main', prompt: 'go' },
    createdAt: 100,
    state: 'waiting',
    error: null,
  };
  await writeFile(path, JSON.stringify({ sessions: [], usage: {}, queue: [valid, malformed] }));

  const sched = new Scheduler();
  await Registry.load(path, undefined, sched);
  assert.equal(sched.all().length, 1);
  assert.equal(sched.all()[0].id, 'v1');
});

test('a state.json with no queue key loads cleanly', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sb-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  await writeFile(path, JSON.stringify({ sessions: [], usage: {} }));

  const sched = new Scheduler();
  await Registry.load(path, undefined, sched);
  assert.equal(sched.all().length, 0);
});
