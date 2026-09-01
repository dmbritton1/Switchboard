# Session Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Claude session message another session on the same repo, gated by an approval that opens a channel between the pair rather than approving each message.

**Architecture:** A pure `relay()` function owns the rules and the delivery; a channel map owns approval state; the server hands each Claude launch two closures (`relay`, `relayGate`) so the adapter can expose an in-process MCP server without ever seeing the Registry. Receiving needs nothing new — a relayed message is delivered through the same prompt path a typed follow-up uses, so this also covers Claude→Codex without touching Codex.

**Tech Stack:** TypeScript run directly on Node >= 22.18 (no build step, no typecheck), `node --test`, `@anthropic-ai/claude-agent-sdk` (`createSdkMcpServer`, `tool`, `zod`), plain-DOM browser code in `web/`.

**Spec:** `docs/superpowers/specs/2026-08-29-session-relay-design.md`

## Global Constraints

- Node >= 22.18. TypeScript runs directly; there is no build step and **no typecheck** — `npm test` is bare `node --test test/*.test.ts`, so tests are the only defect gate.
- Run `npm test` before claiming completion. While iterating, run the focused `node --test` command first.
- Tests must be offline: no paid, networked, or real-account tests. No test may bind port 1455, open a browser, or spawn a real `claude`/`codex` binary.
- Never persist, log, return over SSE, or render account environment values.
- Do not expose raw reasoning.
- Codex sessions keep `sandboxMode: 'workspace-write'` and `approvalPolicy: 'never'`. Do not add an interactive approval path, and do not register anything on the Codex adapter in this plan.
- Each session has exactly one dedicated git worktree.
- The checkpoint cap is **10** exchanges per channel.
- A channel is keyed by the **unordered pair** of session ids and binds both ends: approving a send approves the conversation it starts.
- `auto` means *never ask about relays* — it skips the opening approval and checkpoints alike.

---

### Task 1: The relay function and channel state

The rules and the delivery, with no adapter or HTTP involvement. Everything later in this plan is transport onto this.

Two things live here because they are read and written together: `relay()` decides and delivers, and the channel map records what was approved. Keeping the map beside the function rather than on `Session` matters — a channel is a property of a pair, and `Session` is persisted state that would outlive the handles that give a channel meaning.

**Files:**
- Create: `src/relay.ts`
- Modify: `src/types.ts` (two exported types)
- Test: `test/relay.test.ts`

**Interfaces:**
- Consumes: `Registry` from `src/sessions.ts`, `AgentHandle` and `Status` from `src/types.ts`.
- Also adds to `src/types.ts`, where every shared type in this codebase lives:
  - `export type RelayResult = { ok: true; queued: boolean } | { ok: false; reason: 'unknown-session' | 'self' | 'different-repo' | 'not-live' }`
  - `export type RelaySession = { id: string; branch: string; account: string; status: Status }`
- Produces:
  - `export const RELAY_CHECKPOINT = 10`
  - `export type Channels = Map<string, number>` — key is the unordered pair, value is exchanges since the channel was last opened. Presence of a key means the channel is open.
  - `export function channelKey(a: string, b: string): string`
  - `export function channelOpen(channels: Channels, a: string, b: string): boolean`
  - `export function dropChannels(channels: Channels, sessionId: string): void`
  - `export function relay(deps: { registry: Registry; handles: Map<string, AgentHandle>; channels: Channels }, from: string, to: string, text: string): RelayResult`

- [ ] **Step 1: Write the failing test**

Create `test/relay.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/relay.test.ts`
Expected: FAIL — `Cannot find module '../src/relay.ts'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/relay.ts`:

First add the two types to `src/types.ts`, after `StartOpts`:

```ts
export type RelayResult =
  | { ok: true; queued: boolean }
  | { ok: false; reason: 'unknown-session' | 'self' | 'different-repo' | 'not-live' };

/** One row of what a session may message: same repo, never itself. */
export type RelaySession = { id: string; branch: string; account: string; status: Status };
```

They live here rather than in `src/relay.ts` because `types.ts` is where this
codebase keeps shared types, and because `relay.ts` imports `Registry`, which
imports `types.ts` — defining them in `relay.ts` would put a cycle in the graph
for no gain.

Then create `src/relay.ts`:

```ts
import type { Registry } from './sessions.ts';
import type { AgentHandle, RelayResult } from './types.ts';

/**
 * Exchanges a channel carries before it closes itself and the next send has to
 * be approved again. The number is a judgement call, not a derived one: low
 * enough that an unattended pair cannot run far before asking, high enough that
 * a working exchange is not interrupted mid-thought.
 */
export const RELAY_CHECKPOINT = 10;

/**
 * Open channels, keyed by the unordered pair of session ids. A key's presence
 * means the pair may talk without a card; its value counts exchanges since the
 * channel was opened.
 *
 * Deliberately not a field on Session. A channel is a property of a pair rather
 * than of either end, and Session is persisted — a channel that outlived the
 * process would name handles that no longer exist.
 */
export type Channels = Map<string, number>;

export function channelKey(a: string, b: string): string {
  return a < b ? `${a} ${b}` : `${b} ${a}`;
}

export function channelOpen(channels: Channels, a: string, b: string): boolean {
  return channels.has(channelKey(a, b));
}

/** Called when a session goes away: a channel to a deleted session is a lie. */
export function dropChannels(channels: Channels, sessionId: string): void {
  for (const key of channels.keys()) {
    const [x, y] = key.split(' ');
    if (x === sessionId || y === sessionId) channels.delete(key);
  }
}

export type RelayDeps = {
  registry: Registry;
  handles: Map<string, AgentHandle>;
  channels: Channels;
};

/**
 * Delivers one message from one session to another, and records that the pair
 * is talking.
 *
 * It does not check whether the pair was approved. The gate runs in the
 * adapter's canUseTool before the tool executes, so by the time this is called
 * the human has already allowed this send — re-checking here would reject the
 * first message of every channel, which is the one the approval was for.
 */
export function relay(deps: RelayDeps, from: string, to: string, text: string): RelayResult {
  const { registry, handles, channels } = deps;
  const sender = registry.get(from);
  const target = registry.get(to);
  if (!sender || !target) return { ok: false, reason: 'unknown-session' };
  if (from === to) return { ok: false, reason: 'self' };
  // The boundary merge and push already enforce: same-repo sessions are the ones
  // whose work can collide, and the ones a cross-session message can be about.
  if (sender.repo !== target.repo) return { ok: false, reason: 'different-repo' };
  const handle = handles.get(to);
  // A stopped session cannot act on a message. Accepting one would strand it in
  // a transcript nobody reads.
  if (!handle) return { ok: false, reason: 'not-live' };

  // Codex marks a prompt queued until its turn ends; Claude's streaming input
  // takes it directly. Same call the send command makes.
  const queued = target.provider === 'codex';
  const promptId = registry.appendPrompt(to, text, queued ? 'queued' : 'sent');
  handle.send({ text, attachments: [] }, promptId);

  const key = channelKey(from, to);
  const count = (channels.get(key) ?? 0) + 1;
  if (count >= RELAY_CHECKPOINT) channels.delete(key);
  else channels.set(key, count);
  return { ok: true, queued };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/relay.test.ts`
Expected: PASS, all five tests.

- [ ] **Step 5: Commit**

```bash
git add src/relay.ts test/relay.test.ts
git commit -m "feat: relay a message between sessions on one repo"
```

---

### Task 2: Wire the callbacks through launch

`launch()` (`src/server.ts:538`) is the one place that knows both a session id and the Registry, and it already builds the object `adapter.start()` receives. Two closures go in there, so the adapter can relay without ever importing the Registry — the same separation `emit` already keeps.

`relayGate` is separate from `relay` because `canUseTool` runs *before* the tool does and therefore cannot learn from the send whether a card was needed.

**Files:**
- Modify: `src/types.ts` (`StartOpts`)
- Modify: `src/server.ts:463` (the channel map), `src/server.ts:538-546` (launch), `src/server.ts:1023-1041` (delete)
- Test: `test/server.test.ts`

**Interfaces:**
- Consumes: `relay`, `channelOpen`, `dropChannels`, `Channels` (Task 1).
- Produces: two optional fields on `StartOpts`:
  - `relay?: (target: string, text: string) => RelayResult`
  - `relayGate?: (target: string) => { ask: boolean; note?: string }`

- [ ] **Step 1: Write the failing test**

Add to `test/server.test.ts`. `fakeAdapter()` records every `StartOpts` in `starts`, which is how the callbacks are reached without a real agent:

```ts
test('launch hands a session relay callbacks scoped to itself', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const { adapter, starts } = fakeAdapter();
  const { base, registry } = await boot(t, adapter);

  const post = (body: Record<string, unknown>) => fetch(new URL('/command', base), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then((r) => r.json());

  const a = await post({ cmd: 'create', repo, branch: 'feat/a', account: 'claude-main', prompt: 'go' });
  const b = await post({ cmd: 'create', repo, branch: 'feat/b', account: 'claude-main', prompt: 'go' });

  const fromA = starts[0];
  assert.equal(typeof fromA.relay, 'function');
  assert.equal(typeof fromA.relayGate, 'function');

  // Closed channel: the first send is gated.
  assert.equal(fromA.relayGate!(b.id).ask, true);

  assert.deepEqual(fromA.relay!(b.id, 'ping'), { ok: true, queued: false });
  assert.equal(
    fromA.relayGate!(b.id).ask, false,
    'a successful send opens the channel, so the next one is not gated',
  );

  const transcript = registry.get(b.id)!.transcript;
  assert.equal((transcript.at(-1) as { text: string }).text, 'ping');
  assert.equal(registry.get(a.id)!.transcript.length, 1, 'the sender is untouched');
});

test('deleting a session drops its channels', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const { adapter, starts } = fakeAdapter();
  const { base } = await boot(t, adapter);

  const post = (body: Record<string, unknown>) => fetch(new URL('/command', base), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then((r) => r.json());

  const a = await post({ cmd: 'create', repo, branch: 'feat/a', account: 'claude-main', prompt: 'go' });
  const b = await post({ cmd: 'create', repo, branch: 'feat/b', account: 'claude-main', prompt: 'go' });
  starts[0].relay!(b.id, 'ping');
  assert.equal(starts[0].relayGate!(b.id).ask, false);

  await post({ cmd: 'delete', id: b.id });
  const c = await post({ cmd: 'create', repo, branch: 'feat/c', account: 'claude-main', prompt: 'go' });

  assert.equal(
    starts[0].relayGate!(c.id).ask, true,
    'a fresh pair is gated; the deleted session left no channel behind',
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/server.test.ts`
Expected: FAIL — `fromA.relay` is `undefined`, so the `typeof` assertion fails.

- [ ] **Step 3: Write minimal implementation**

In `src/types.ts`, extend `StartOpts` (add after `codexSettings`):

```ts
  /**
   * Cross-session messaging, provided by the server so the adapter can expose it
   * as a tool without knowing its own session id or reaching the Registry — the
   * same separation `emit` keeps. Absent means the provider has no relay tool.
   *
   * `relayGate` is separate because canUseTool runs before the tool does, and so
   * cannot learn from the send whether a card was needed.
   */
  relay?: (target: string, text: string) => RelayResult;
  relayGate?: (target: string) => { ask: boolean; note?: string };
```

In `src/server.ts`, add the imports:

```ts
import {
  channelKey, channelOpen, dropChannels, relay, RELAY_CHECKPOINT, type Channels,
} from './relay.ts';
```

Declare the map beside the handle map (`src/server.ts:463`):

```ts
  const handles = new Map<string, AgentHandle>();
  // Process-local like the handle map, and for the same reason: a channel names
  // two live sessions, and Registry.load forces every session to `stopped` on
  // start, so none could survive a restart in a usable form.
  const channels: Channels = new Map();
```

Declare the companion set beside it. A closed channel means "ask", but a first
send and a checkpoint are different questions, and the map alone cannot tell
them apart — a pair that never talked and a pair that just hit ten both have no
key:

```ts
  // Pairs that have talked before, so the card can say which question it is
  // asking. Never cleared on checkpoint, only when a session goes away.
  const seenChannels = new Set<string>();
```

In `launch()`, extend the `adapter.start()` argument (`src/server.ts:546`):

```ts
      const handle = adapter.start({
        cwd, prompt, promptId, env: account.env, resumeId, auto, codexSettings,
        relay: (target, text) => {
          const result = relay({ registry, handles, channels }, sessionId, target, text);
          if (result.ok) seenChannels.add(channelKey(sessionId, target));
          return result;
        },
        relayGate: (target) => {
          if (channelOpen(channels, sessionId, target)) return { ask: false };
          return seenChannels.has(channelKey(sessionId, target))
            ? { ask: true, note: `${RELAY_CHECKPOINT} messages exchanged — continue?` }
            : { ask: true };
        },
      }, (e) => {
```

In the `delete` case (`src/server.ts:1034`), after `registry.remove(...)`:

```ts
        dropChannels(channels, String(body.id));
        for (const key of [...seenChannels]) {
          const [x, y] = key.split(' ');
          if (x === String(body.id) || y === String(body.id)) seenChannels.delete(key);
        }
```

- [ ] **Step 4: Add the note test**

Append to `test/server.test.ts`:

```ts
test('the gate distinguishes a first send from a checkpoint', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const { adapter, starts } = fakeAdapter();
  const { base } = await boot(t, adapter);

  const post = (body: Record<string, unknown>) => fetch(new URL('/command', base), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then((r) => r.json());

  await post({ cmd: 'create', repo, branch: 'feat/a', account: 'claude-main', prompt: 'go' });
  const b = await post({ cmd: 'create', repo, branch: 'feat/b', account: 'claude-main', prompt: 'go' });

  assert.equal(starts[0].relayGate!(b.id).note, undefined, 'a first send needs no explanation');

  for (let i = 0; i < 10; i++) starts[0].relay!(b.id, `m${i}`);

  const gate = starts[0].relayGate!(b.id);
  assert.equal(gate.ask, true);
  assert.match(gate.note!, /continue\?/);
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/server.test.ts`
Expected: PASS, including every pre-existing server test.

- [ ] **Step 6: Run the full suite and commit**

```bash
npm test
git add src/types.ts src/server.ts test/server.test.ts
git commit -m "feat: hand each launch relay callbacks scoped to its session"
```

---

### Task 3: The MCP server and the approval card

The tools the agent actually sees, plus the one line that makes the approval card readable. They ship together because a card that renders as a bare tool name makes the tools untestable by hand.

**Files:**
- Modify: `src/agents/claude.ts:32-35` (the `mcpServers` map), `src/agents/claude.ts:42` (`summarize`), `src/agents/claude.ts:319-338` (`canUseTool`), `src/agents/claude.ts:341-350` (`options`)
- Create: `src/agents/relay-tools.ts`
- Test: `test/agents-claude.test.ts`

**Interfaces:**
- Consumes: `StartOpts.relay` and `StartOpts.relayGate` (Task 2).
- Produces: `export function relayServer(deps: { sessions: () => RelaySession[]; send: (target: string, text: string) => RelayResult })`, returning the value `createSdkMcpServer` returns. `RelaySession` and `RelayResult` come from `src/types.ts` (Task 1).

- [ ] **Step 1: Write the failing test**

`list_sessions` needs the session list, which the adapter does not have. Rather than a third callback, the server passes it through the same `relay` closure's owner — so this task adds `relaySessions` to `StartOpts` alongside the other two. Add to `test/agents-claude.test.ts`:

```ts
import { summarize } from '../src/agents/claude.ts';

test('the approval card names the target and the message', () => {
  assert.equal(
    summarize('mcp__relay__send_to_session', { session: 'feat/login', text: 'auth moved' }),
    '→ feat/login: auth moved',
  );
});

test('a relay summary survives a missing field', () => {
  assert.equal(summarize('mcp__relay__send_to_session', {}), 'mcp__relay__send_to_session');
});
```

`summarize` is currently module-private; export it.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/agents-claude.test.ts`
Expected: FAIL — `summarize` is not exported, so the import throws.

- [ ] **Step 3: Write the summarize case**

In `src/agents/claude.ts`, change `function summarize(` to `export function summarize(` and add this case immediately after the `AskUserQuestion` block, before the `input.command` check:

```ts
  // The message is the thing being approved, so it has to be on the card — the
  // generic fallthrough would show only the tool name.
  if (name.endsWith('__send_to_session')
    && typeof input.session === 'string' && typeof input.text === 'string') {
    return `→ ${input.session}: ${input.text}`;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/agents-claude.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the tools**

Create `src/agents/relay-tools.ts`:

```ts
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { RelayResult, RelaySession } from '../types.ts';

function describe(result: RelayResult, queuedNote: string): string {
  if (result.ok) return result.queued ? queuedNote : 'Delivered.';
  switch (result.reason) {
    case 'unknown-session': return 'No such session.';
    case 'self': return 'That is this session.';
    case 'different-repo': return 'That session is on a different repository.';
    case 'not-live': return 'That session is stopped and cannot receive messages.';
  }
}

/**
 * Cross-session messaging for one session. `sessions` and `send` are closures
 * the server built over that session's identity, so nothing here can name a
 * different sender — the tool takes a target, never a from.
 */
export function relayServer(deps: {
  sessions: () => RelaySession[];
  send: (target: string, text: string) => RelayResult;
}) {
  return createSdkMcpServer({
    name: 'relay',
    version: '0.1.0',
    instructions:
      'Other agent sessions working on this same repository, on their own git '
      + 'branches. Use this to coordinate — to say what you are changing, to ask '
      + 'what another session has already done, or to answer when one asks you.',
    tools: [
      tool(
        'list_sessions',
        'List the other sessions on this repository that you can message.',
        {},
        async () => {
          const rows = deps.sessions();
          if (!rows.length) {
            return { content: [{ type: 'text' as const, text: 'No other sessions on this repository.' }] };
          }
          return {
            content: [{
              type: 'text' as const,
              text: rows
                .map((s) => `${s.branch} — ${s.status}, on account ${s.account} (id ${s.id})`)
                .join('\n'),
            }],
          };
        },
      ),
      tool(
        'send_to_session',
        'Send a message to another session on this repository. It arrives as a '
          + 'prompt, so say who you are and what you need.',
        {
          session: z.string().describe('The target session id or branch, from list_sessions.'),
          text: z.string().describe('The message. Write it for another agent, not for a human.'),
        },
        async ({ session, text }) => {
          const result = deps.send(session, text);
          return {
            content: [{
              type: 'text' as const,
              text: describe(result, 'Queued — that session is mid-turn and will read it when the turn ends.'),
            }],
            ...(result.ok ? {} : { isError: true as const }),
          };
        },
      ),
    ],
  });
}
```

- [ ] **Step 6: Wire it into the adapter**

In `src/agents/claude.ts`, add the import:

```ts
import { relayServer } from './relay-tools.ts';
```

The module-level `mcpServers` const (line 32) stays as the machine-wide pair. Inside `start()`, build the per-launch map just before `const options: Options = {`:

```ts
    // Per launch, not module level: the relay tools close over this session's
    // own callbacks, so they cannot be shared the way the browser and simulator
    // servers are.
    const servers = opts.relay && opts.relaySessions
      ? { ...mcpServers, relay: relayServer({ sessions: opts.relaySessions, send: opts.relay }) }
      : mcpServers;
```

and change the `mcpServers` line inside `options` to use it:

```ts
      ...(Object.keys(servers).length ? { mcpServers: servers } : {}),
```

Add the gate to `canUseTool`, immediately after the `options` line and before the `auto` shortcut:

```ts
      // Relays are gated by the channel rather than by `auto`: the first send to
      // a pair asks, the pair then talks freely, and the checkpoint asks again.
      // A session with `auto` on skips both, which is what `auto` means here.
      const relayTarget = toolName.endsWith('__send_to_session') && typeof toolInput.session === 'string'
        ? toolInput.session
        : null;
      const gate = relayTarget && opts.relayGate ? opts.relayGate(relayTarget) : null;
      if (gate && !gate.ask) return Promise.resolve({ behavior: 'allow', updatedInput: toolInput });
```

and extend the request built below it so a checkpoint explains itself:

```ts
      const request = {
        id: `a${++approvalSeq}`,
        tool: toolName,
        summary: gate?.note
          ? `${summarize(toolName, toolInput, !options)} (${gate.note})`
          : summarize(toolName, toolInput, !options),
        ...(options ? { options } : {}),
      };
```

Add `relaySessions` to `StartOpts` in `src/types.ts`, beside the other two.
`RelaySession` is already declared in that file by Task 1, so no import is needed:

```ts
  /** The sessions this one may message: same repo, excluding itself. */
  relaySessions?: () => RelaySession[];
```

Provide it in `launch()` in `src/server.ts`, alongside `relay` and `relayGate`:

```ts
        relaySessions: () => registry.all()
          .filter((s) => s.id !== sessionId && s.repo === session?.repo)
          .map((s) => ({ id: s.id, branch: s.branch, account: s.account, status: s.status })),
```

- [ ] **Step 7: Test the tools and the gate**

Add to `test/agents-claude.test.ts`:

```ts
import { relayServer } from '../src/agents/relay-tools.ts';

test('relayServer exposes exactly the two relay tools', () => {
  const server = relayServer({ sessions: () => [], send: () => ({ ok: true, queued: false }) });
  assert.equal(server.name, 'relay');
});
```

and to `test/server.test.ts`:

```ts
test('relaySessions lists same-repo siblings and excludes the caller', async (t) => {
  const repo = await makeRepo();
  const other = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  t.after(() => rm(other, { recursive: true, force: true }));
  const { adapter, starts } = fakeAdapter();
  const { base } = await boot(t, adapter);

  const post = (body: Record<string, unknown>) => fetch(new URL('/command', base), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then((r) => r.json());

  await post({ cmd: 'create', repo, branch: 'feat/a', account: 'claude-main', prompt: 'go' });
  await post({ cmd: 'create', repo, branch: 'feat/b', account: 'claude-main', prompt: 'go' });
  await post({ cmd: 'create', repo: other, branch: 'feat/elsewhere', account: 'claude-main', prompt: 'go' });

  const listed = starts[0].relaySessions!().map((s) => s.branch);
  assert.deepEqual(listed, ['feat/b'], 'same repo only, self excluded');
});
```

- [ ] **Step 8: Run the full suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add src/agents/relay-tools.ts src/agents/claude.ts src/types.ts src/server.ts \
  test/agents-claude.test.ts test/server.test.ts
git commit -m "feat: expose relay tools to Claude sessions with a readable approval card"
```

---

### Task 4: The `@session` menu

Pure autocomplete. The decision — which sessions can be mentioned, and what text a pick inserts — is a function with no DOM in it, tested the way `commandMenu` and `handoffTargets` already are.

**Files:**
- Modify: `web/lib.js` (two new exports beside `handoffTargets`)
- Modify: `web/index.html:121` (a menu element beside `#cmd-menu`)
- Modify: `web/app.js` (its `lib.js` import block, plus a `wireMentionMenu` factory beside `wireCommandMenu` at line 1756 and one call beside line 1891)
- Test: `test/ui.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `export function mentionMenu(text, caret, sessions)` → `{ query, matches }` or `null` when no `@` mention is under the caret. `matches` are session objects.
  - `export function mentionInsert(session)` → the string a pick inserts.

- [ ] **Step 1: Write the failing test**

Add `mentionMenu` and `mentionInsert` to the `web/lib.js` import block at the top of `test/ui.test.ts`, then add:

```ts
const SESSIONS = [
  { id: 's1', branch: 'feat/login', account: 'claude-main', status: 'working', repo: '/r' },
  { id: 's2', branch: 'feat/auth', account: 'claude-alt', status: 'done', repo: '/r' },
];

test('the mention menu opens on @ and filters by branch', () => {
  assert.deepEqual(mentionMenu('@', 1, SESSIONS).matches.length, 2);
  assert.deepEqual(mentionMenu('ask @log', 8, SESSIONS).matches.map((s) => s.branch), ['feat/login']);
  assert.equal(mentionMenu('ask @zzz', 8, SESSIONS).matches.length, 0);
});

test('the mention menu stays shut without an @ under the caret', () => {
  assert.equal(mentionMenu('plain text', 10, SESSIONS), null);
  // Past the mention: the caret has moved on to ordinary prose.
  assert.equal(mentionMenu('@feat/login and then some', 25, SESSIONS), null);
});

test('a mention inserts text naming what the token is', () => {
  const inserted = mentionInsert(SESSIONS[0]);
  assert.match(inserted, /feat\/login/);
  assert.match(inserted, /send_to_session/,
    'the agent is told how to reach it rather than left to infer it from an @');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/ui.test.ts`
Expected: FAIL — `mentionMenu is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `web/lib.js`, after `handoffTargets`:

```js
/**
 * The `@` mention menu, the same shape commandMenu returns for slash commands:
 * `{ query, matches }`, or null when the caret is not inside a mention.
 *
 * A mention runs from an `@` to the caret with no whitespace between, so the
 * menu closes as soon as the sentence moves on.
 */
export function mentionMenu(text, caret, sessions) {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at === -1) return null;
  const query = before.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { query, matches: sessions.filter((s) => s.branch.includes(query)) };
}

/**
 * What picking a session inserts. Not just the branch name: the agent would be
 * left inferring that a name with an `@` in front means "go talk to that", and
 * that inference fails invisibly — an agent answering from its own knowledge
 * looks exactly like one that had nothing to say. One sentence removes the doubt.
 */
export function mentionInsert(session) {
  return `${session.branch} (another session on this repo — reach it with send_to_session)`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/ui.test.ts`
Expected: PASS — the three new tests, plus the pre-existing export-wiring test now covering both names.

- [ ] **Step 5: Add the menu element**

`web/index.html:121` holds the slash-command menu for the chat composer. Add a
sibling immediately after it:

```html
            <ul id="mention-menu" class="cmd-menu" role="listbox" aria-label="Sessions" hidden></ul>
```

It reuses the `cmd-menu` class deliberately: this is the same kind of popup in
the same place, and a second stylesheet rule for it would drift.

Only the chat composer gets one. The new-session dialog (`#new-cmd-menu`,
`web/index.html:219`) has no session to be relative to, so `@` means nothing
there.

- [ ] **Step 6: Wire a mention menu beside the command menu**

`wireCommandMenu({ field, box, mirror, menu, ids })` (`web/app.js:1756`) is
already a factory with two instances — the chat composer and the new-session
prompt. A sibling factory is this file's own pattern, not a workaround for it.

Write `wireMentionMenu` beside it. It is the command menu with the mirror
machinery removed: mentions need no coloured repaint behind the field, which is
what `box`, `mirror` and `paint` exist for.

```js
/**
 * Session autocomplete for the chat composer.
 *
 * A sibling of wireCommandMenu rather than a second mode inside it. The two
 * menus share a shape but nothing else, and folding them together would mean
 * editing a working, untested closure to add a case — where a mistake breaks
 * slash commands silently, since no test loads this file.
 *
 * `sessions()` is supplied by the caller because this factory must not know how
 * the grid stores state; it returns the sessions the open one may mention.
 */
function wireMentionMenu({ field, menu, ids, sessions }) {
  let matches = [];
  let index = 0;

  function close() {
    menu.hidden = true;
    matches = [];
    field.removeAttribute('aria-activedescendant');
    field.setAttribute('aria-expanded', 'false');
  }

  function highlight() {
    [...menu.children].forEach((li, i) => li.setAttribute('aria-selected', String(i === index)));
    field.setAttribute('aria-activedescendant', `${ids}-${index}`);
    menu.children[index]?.scrollIntoView({ block: 'nearest' });
  }

  function apply(session) {
    const caret = field.selectionStart ?? 0;
    const at = field.value.slice(0, caret).lastIndexOf('@');
    const inserted = mentionInsert(session);
    field.value = field.value.slice(0, at) + inserted + field.value.slice(caret);
    const end = at + inserted.length;
    field.setSelectionRange(end, end);
    close();
    field.focus();
  }

  function render() {
    const found = mentionMenu(field.value, field.selectionStart ?? 0, sessions());
    if (!found || !found.matches.length) { close(); return; }
    // Only reset the highlight when the list itself changed, so a caret move
    // does not throw away an arrow-key selection.
    const keys = found.matches.map((m) => m.id).join('\n');
    if (keys !== matches.map((m) => m.id).join('\n')) index = 0;
    matches = found.matches;

    menu.replaceChildren(...matches.map((session, i) => {
      const li = document.createElement('li');
      li.id = `${ids}-${i}`;
      li.setAttribute('role', 'option');
      const account = document.createElement('span');
      account.className = 'ns';
      account.textContent = ` ${session.account}`;
      li.append(`@${session.branch}`, account);
      // mousedown, not click: preventDefault keeps focus in the field so the
      // menu never races its own blur handler.
      li.addEventListener('mousedown', (e) => { e.preventDefault(); apply(session); });
      return li;
    }));
    menu.hidden = false;
    field.setAttribute('aria-expanded', 'true');
    highlight();
  }

  for (const evt of ['input', 'click', 'keyup']) field.addEventListener(evt, render);
  field.addEventListener('blur', close);

  field.addEventListener('keydown', (e) => {
    if (!matches.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      index = (index + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
      highlight();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      apply(matches[index]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });
}
```

Add `mentionMenu` and `mentionInsert` to the `lib.js` import block at the top of
`web/app.js`, and call the factory once beside the existing `wireCommandMenu`
calls (`web/app.js:1891`):

```js
wireMentionMenu({
  field: $('#prompt'), menu: $('#mention-menu'), ids: 'mention-opt',
  sessions: () => {
    const open = state.sessions.find((x) => x.id === state.selected);
    return open
      ? state.sessions.filter((x) => x.id !== open.id && x.repo === open.repo)
      : [];
  },
});
```

Check the name the composer's open session is actually held under before using
`state.selected` — read the surrounding code and use whatever the file already
uses for "the session the composer is writing to".

Both menus listen on the same field. They cannot both be open: `commandMenu`
returns null unless the caret is in a `/` token and `mentionMenu` returns null
unless it is in an `@` token, and a caret is in at most one of those.

There is no test for either step. `test/ui.test.ts` never loads `app.js` as
code — see the comment at its line 20. The tested part is `mentionMenu` and
`mentionInsert`; this is the DOM that calls them, verified by reading and by
using the composer. Check both menus by hand before committing: type `/` and
confirm commands still list, then type `@` and confirm sessions do.

- [ ] **Step 7: Run the full suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add web/lib.js web/index.html web/app.js test/ui.test.ts
git commit -m "feat: @ mention menu for naming another session in the composer"
```

---

### Task 5: Document the feature

`README.md` documents every user-facing surface and `AGENTS.md` carries code ownership and safety boundaries. A tool agents can call, gated by a card the user has to understand, needs both.

**Files:**
- Modify: `README.md`, `AGENTS.md`

- [ ] **Step 1: Add the README section**

Add after the handoff section (which ends with the paragraph beginning "Reasoning is never written to that file"):

```markdown
A Claude session can message another session on the same repository. It has two
tools: one lists the sessions it can reach, one sends to a chosen session. A
relayed message arrives the way a message you type does, so a session mid-turn
picks it up when that turn ends — and a Codex session can receive one even
though it cannot yet send.

Approval is per conversation rather than per message. The first send between a
pair raises the usual approval card showing the target and the message; once you
allow it, that pair exchanges freely. After ten messages the channel closes
itself and the next send asks again, which is where you decide whether the
exchange is still worth what it is spending. Denying leaves it closed.

`auto` means never ask about relays: a session with auto-approve on opens
channels and carries past checkpoints without a card. That is the one setting
that removes the loop protection, and an unattended pair spends two accounts
rather than one.

Typing `@` in the composer lists the other sessions on that repository and
inserts a short note naming what the session is, so the agent knows the name
refers to something it can reach. The mention itself sends nothing.
```

- [ ] **Step 2: Add the AGENTS.md lines**

Under "Code ownership":

```
- `src/relay.ts` owns cross-session messaging rules and open-channel state.
```

Under "Safety boundaries":

```
- Relay channels are process-local and keyed by session pair. Never persist them
  or move them onto `Session`: a channel names two live handles, and a restart
  forces every session to `stopped`.
- A relay tool never takes a sender. The sending session's identity comes from
  the closure the server built in launch(), never from a tool argument.
```

- [ ] **Step 3: Verify nothing contradicts**

Run: `grep -rn "auto-approve\|approval card" README.md AGENTS.md`
Expected: no statement that contradicts relays being gated by channel rather than by `auto`.

- [ ] **Step 4: Commit**

```bash
git add README.md AGENTS.md
git commit -m "docs: describe session relay"
```

---

## Deferred

Named in the spec's Out of Scope and deliberately not built here: Codex *sending* (needs `new Codex({ config: { mcp_servers: … } })` plus the unresolved question of whether an MCP tool can run under `approvalPolicy: 'never'`, and a server-side gate since Codex has no approval card); overlap detection; a tool for reading another session's transcript; and authenticating `/command`.
