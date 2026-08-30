import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '../src/sessions.ts';
import {
  RELAY_CHECKPOINT, channelKey, channelOpen, dropChannels, relay, type Channels,
} from '../src/relay.ts';
import type { AgentHandle } from '../src/types.ts';
// RelayResult and RelaySession live in src/types.ts; this file only needs the runtime exports.

async function registry(t: { after: (fn: () => void) => void }): Promise<Registry> {
  const dir = await mkdtemp(join(tmpdir(), 'sb-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return new Registry(join(dir, 'state.json'));
}

function fakeHandle(): AgentHandle & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    send(prompt) { sent.push(prompt.text); },
    decide() {}, setAuto() {}, stop() {},
  };
}

function make(reg: Registry, branch: string, repo = '/repo') {
  return reg.create({
    provider: 'claude', account: 'claude-main', repo,
    cwd: `${repo}/.claude/worktrees/${branch}`, branch, title: branch,
  });
}

test('channelKey is order-independent', () => {
  assert.equal(channelKey('a', 'b'), channelKey('b', 'a'));
  assert.notEqual(channelKey('a', 'b'), channelKey('a', 'c'));
});

test('relay delivers to a live session and opens the channel', async (t) => {
  const reg = await registry(t);
  const a = make(reg, 'feat/a');
  const b = make(reg, 'feat/b');
  const handle = fakeHandle();
  const channels: Channels = new Map();

  const result = relay(
    { registry: reg, handles: new Map([[b.id, handle]]), channels }, a.id, b.id, 'ping',
  );

  assert.deepEqual(result, { ok: true, queued: false });
  assert.deepEqual(handle.sent, ['ping']);
  assert.ok(channelOpen(channels, a.id, b.id), 'a successful relay opens the channel');
  const transcript = reg.get(b.id)!.transcript;
  assert.equal(transcript.at(-1)?.kind, 'user');
  assert.equal((transcript.at(-1) as { text: string }).text, 'ping');
});

test('relay refuses an unknown target, itself, a different repo, and a dead session', async (t) => {
  const reg = await registry(t);
  const a = make(reg, 'feat/a');
  const b = make(reg, 'feat/b');
  const other = make(reg, 'feat/c', '/other-repo');
  const handles = new Map<string, AgentHandle>([[b.id, fakeHandle()], [other.id, fakeHandle()]]);
  const deps = { registry: reg, handles, channels: new Map() as Channels };

  assert.deepEqual(relay(deps, a.id, 'nope', 'x'), { ok: false, reason: 'unknown-session' });
  assert.deepEqual(relay(deps, a.id, a.id, 'x'), { ok: false, reason: 'self' });
  assert.deepEqual(relay(deps, a.id, other.id, 'x'), { ok: false, reason: 'different-repo' });

  handles.delete(b.id);
  assert.deepEqual(relay(deps, a.id, b.id, 'x'), { ok: false, reason: 'not-live' });
  assert.equal(reg.get(b.id)!.transcript.length, 0, 'a refused relay appends nothing');
});

test('the channel closes once the checkpoint is crossed', async (t) => {
  const reg = await registry(t);
  const a = make(reg, 'feat/a');
  const b = make(reg, 'feat/b');
  const deps = {
    registry: reg, handles: new Map([[b.id, fakeHandle()]]), channels: new Map() as Channels,
  };

  for (let i = 0; i < RELAY_CHECKPOINT; i++) {
    assert.equal(relay(deps, a.id, b.id, `m${i}`).ok, true);
  }

  assert.equal(
    channelOpen(deps.channels, a.id, b.id), false,
    'crossing the checkpoint closes the channel so the next send is gated again',
  );
});

test('dropChannels removes every channel naming a session', async (t) => {
  const reg = await registry(t);
  const a = make(reg, 'feat/a');
  const b = make(reg, 'feat/b');
  const c = make(reg, 'feat/c');
  const channels: Channels = new Map([
    [channelKey(a.id, b.id), 1],
    [channelKey(b.id, c.id), 1],
  ]);

  dropChannels(channels, a.id);

  assert.equal(channelOpen(channels, a.id, b.id), false);
  assert.equal(channelOpen(channels, b.id, c.id), true, 'unrelated channels survive');
});
