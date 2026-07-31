# Switchboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local web app that launches coding-agent sessions across two Claude accounts and one Codex account, each in its own git worktree, and shows every session's status in one card grid you can answer from.

**Architecture:** One Node process owns every agent subprocess and all state. Two adapters (`agents/claude.ts`, `agents/codex.ts`) normalize vendor SDK events into one `AdapterEvent` union; `sessions.ts` applies those events to a `Session` record and notifies subscribers; `server.ts` pushes full state snapshots over Server-Sent Events and accepts commands over `POST`. The browser holds no state it cannot re-derive from a snapshot.

**Tech Stack:** Node 22.22.3 (runs `.ts` directly via type stripping — no build step, no bundler, no TypeScript dependency), `node:test`, `node:http`, `@anthropic-ai/claude-agent-sdk@0.3.220`, `@openai/codex-sdk@0.145.0`. Frontend is hand-written HTML/CSS/JS with no framework.

## Global Constraints

- Node >= 22.18. Run sources directly: `node src/server.ts`, `node --test test/*.test.ts`. Never add a build step, bundler, or `typescript` dependency.
- Exactly two runtime dependencies: `@anthropic-ai/claude-agent-sdk` and `@openai/codex-sdk`. Zero devDependencies.
- Type-stripping restriction: no `enum`, no `namespace`, no parameter properties, no `experimentalDecorators`. Type-only imports must use `import type`.
- ESM only. `package.json` has `"type": "module"`. Every relative import includes the `.ts` extension (`import { x } from './worktree.ts'`).
- Transport is SSE (`GET /events`) plus `POST /command`. No WebSocket, no `ws` dependency.
- Server binds `127.0.0.1:4711` only. Never `0.0.0.0`.
- Status values are exactly `'working' | 'needs-you' | 'done' | 'stopped'`. No other status strings anywhere.
- Worktree path convention is `<repo>/.claude/worktrees/<branch>`, matching the Claude desktop app.
- Codex sessions never enter `needs-you` — see Task 5.
- Commit after every task.

---

## File Structure

| File | Responsibility |
|---|---|
| `package.json` | ESM, deps, `test` and `start` scripts |
| `.gitignore` | `node_modules`, `accounts.json`, `state.json` |
| `src/types.ts` | `Status`, `Msg`, `ApprovalRequest`, `Session`, `AdapterEvent`, `AgentHandle`, `Adapter` |
| `src/worktree.ts` | Create a worktree; report branch / ±lines / dirty |
| `src/usage.ts` | Accumulate observed tokens per account; `freestAccount()` |
| `src/sessions.ts` | Registry: apply `AdapterEvent`s to `Session`s, persist, notify subscribers |
| `src/agents/claude.ts` | Claude Agent SDK → `AdapterEvent` |
| `src/agents/codex.ts` | Codex SDK → `AdapterEvent` |
| `src/server.ts` | `node:http`: static files, SSE, `POST /command`, `GET /repos` |
| `web/index.html`, `web/style.css`, `web/app.js` | Card grid + chat view |
| `test/*.test.ts` | Unit tests |
| `test/fixtures/*.json` | Recorded vendor event streams |
| `scripts/record-claude.ts` | Records a real Claude stream to a fixture |
| `accounts.example.json` | Committed template for the gitignored `accounts.json` |

---

### Task 1: Worktree module (with project scaffolding)

**Files:**
- Create: `package.json`, `.gitignore`, `src/types.ts`, `src/worktree.ts`, `test/worktree.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `createWorktree(repo: string, branch: string): Promise<string>` returning the worktree path; `worktreeStatus(cwd: string): Promise<{branch: string, added: number, removed: number, dirty: boolean}>`. Types in `src/types.ts` consumed by every later task.

- [ ] **Step 1: Create the scaffolding**

`package.json`:

```json
{
  "name": "switchboard",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "engines": { "node": ">=22.18" },
  "scripts": {
    "start": "node src/server.ts",
    "test": "node --test test/*.test.ts"
  },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "0.3.220",
    "@openai/codex-sdk": "0.145.0"
  }
}
```

`.gitignore`:

```
node_modules/
accounts.json
state.json
```

Run: `npm install`

- [ ] **Step 2: Write the shared types**

`src/types.ts`:

```ts
export type Status = 'working' | 'needs-you' | 'done' | 'stopped';

export type Msg =
  | { kind: 'user'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; summary: string; status: 'running' | 'ok' | 'error' }
  | { kind: 'error'; text: string };

export type ApprovalRequest = { id: string; tool: string; summary: string };

export type Session = {
  id: string;
  provider: 'claude' | 'codex';
  account: string;
  vendorSessionId: string | null;
  repo: string;
  cwd: string;
  branch: string;
  title: string;
  status: Status;
  transcript: Msg[];
  pending: ApprovalRequest | null;
  stoppedReason: string | null;
  startedAt: number;
  statusSince: number;
};

export type AdapterEvent =
  | { type: 'status'; status: Status }
  | { type: 'msg'; msg: Msg }
  | { type: 'approval'; request: ApprovalRequest }
  | { type: 'approval-resolved' }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'vendor-session-id'; id: string }
  | { type: 'stopped'; reason: string };

export type StartOpts = {
  cwd: string;
  prompt: string;
  env: Record<string, string>;
  resumeId?: string;
};

export type AgentHandle = {
  send(text: string): void;
  decide(allow: boolean): void;
  stop(): void;
};

export type Adapter = {
  start(opts: StartOpts, emit: (e: AdapterEvent) => void): AgentHandle;
};
```

- [ ] **Step 3: Write the failing test**

`test/worktree.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorktree, worktreeStatus } from '../src/worktree.ts';

const run = promisify(execFile);

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sb-'));
  await run('git', ['init', '-b', 'main'], { cwd: dir });
  await run('git', ['config', 'user.email', 't@t.t'], { cwd: dir });
  await run('git', ['config', 'user.name', 'T'], { cwd: dir });
  await writeFile(join(dir, 'a.txt'), 'one\ntwo\n');
  await run('git', ['add', '.'], { cwd: dir });
  await run('git', ['commit', '-m', 'init'], { cwd: dir });
  return dir;
}

test('createWorktree makes a branch at the app-standard path', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));

  const wt = await createWorktree(repo, 'feat/x');

  assert.equal(wt, join(repo, '.claude', 'worktrees', 'feat-x'));
  const { stdout } = await run('git', ['branch', '--show-current'], { cwd: wt });
  assert.equal(stdout.trim(), 'feat/x');
});

test('createWorktree rejects a branch that already exists', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));

  await createWorktree(repo, 'dup');
  await assert.rejects(() => createWorktree(repo, 'dup'), /already exists/i);
});

test('createWorktree rejects a path that is not a git repo', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sb-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  await assert.rejects(() => createWorktree(dir, 'x'), /not a git repository/i);
});

test('worktreeStatus reports clean, then dirty with line counts', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const wt = await createWorktree(repo, 'feat/y');

  const clean = await worktreeStatus(wt);
  assert.deepEqual(clean, { branch: 'feat/y', added: 0, removed: 0, dirty: false });

  await writeFile(join(wt, 'a.txt'), 'one\ntwo\nthree\n');
  const dirty = await worktreeStatus(wt);
  assert.equal(dirty.branch, 'feat/y');
  assert.equal(dirty.dirty, true);
  assert.equal(dirty.added, 1);
  assert.equal(dirty.removed, 0);
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `node --test test/worktree.test.ts`
Expected: FAIL — `Cannot find module '../src/worktree.ts'`

- [ ] **Step 5: Implement the module**

`src/worktree.ts`:

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const run = promisify(execFile);

/** Branch names become path segments; `feat/x` lives at `.claude/worktrees/feat-x`. */
function slug(branch: string): string {
  return branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

export async function createWorktree(repo: string, branch: string): Promise<string> {
  try {
    await run('git', ['rev-parse', '--git-dir'], { cwd: repo });
  } catch {
    throw new Error(`not a git repository: ${repo}`);
  }

  const path = join(repo, '.claude', 'worktrees', slug(branch));
  try {
    await run('git', ['worktree', 'add', '-b', branch, path], { cwd: repo });
  } catch (err) {
    const msg = String((err as { stderr?: string }).stderr ?? err);
    if (/already exists/i.test(msg)) throw new Error(`branch already exists: ${branch}`);
    throw new Error(msg.trim());
  }
  return path;
}

export async function worktreeStatus(cwd: string): Promise<{
  branch: string; added: number; removed: number; dirty: boolean;
}> {
  const [branch, stat, porcelain] = await Promise.all([
    run('git', ['branch', '--show-current'], { cwd }),
    run('git', ['diff', 'HEAD', '--numstat'], { cwd }),
    run('git', ['status', '--porcelain'], { cwd }),
  ]);

  let added = 0;
  let removed = 0;
  for (const line of stat.stdout.split('\n')) {
    const [a, r] = line.split('\t');
    // Binary files report `-`; skip rather than counting NaN.
    if (a && a !== '-') added += Number(a);
    if (r && r !== '-') removed += Number(r);
  }

  return {
    branch: branch.stdout.trim(),
    added,
    removed,
    dirty: porcelain.stdout.trim().length > 0,
  };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test test/worktree.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json .gitignore src/types.ts src/worktree.ts test/worktree.test.ts
git commit -m "feat: worktree create and status"
```

---

### Task 2: Usage tracking

**Files:**
- Create: `src/usage.ts`, `test/usage.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `class Usage` with `record(account: string, inputTokens: number, outputTokens: number, now?: number): void`, `pace(account: string, budget: number, now?: number): number` returning a 0..1+ fraction of the five-hour budget, and `freestAccount(accounts: {name: string, budget: number}[], now?: number): string`.

**Why a budget rather than a real limit:** no plan-limit percentage is available from either CLI. `budget` is a per-account knob in `accounts.json` that the user tunes until the number matches reality.

- [ ] **Step 1: Write the failing test**

`test/usage.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { Usage } from '../src/usage.ts';

const HOUR = 3600_000;

test('pace is the fraction of budget spent in the last five hours', () => {
  const u = new Usage();
  u.record('main', 100, 100, 0);
  assert.equal(u.pace('main', 1000, 0), 0.2);
});

test('pace ignores samples older than five hours', () => {
  const u = new Usage();
  u.record('main', 500, 500, 0);
  assert.equal(u.pace('main', 1000, 0), 1);
  assert.equal(u.pace('main', 1000, 6 * HOUR), 0);
});

test('pace of an account with no samples is zero', () => {
  const u = new Usage();
  assert.equal(u.pace('never-used', 1000, 0), 0);
});

test('freestAccount picks the lowest pace, not the lowest raw spend', () => {
  const u = new Usage();
  u.record('big', 400, 400, 0);    // 800 of 10000 = 0.08
  u.record('small', 100, 100, 0);  // 200 of 1000  = 0.20
  const freest = u.freestAccount(
    [{ name: 'big', budget: 10000 }, { name: 'small', budget: 1000 }],
    0,
  );
  assert.equal(freest, 'big');
});

test('freestAccount throws when given no accounts', () => {
  const u = new Usage();
  assert.throws(() => u.freestAccount([], 0), /no accounts/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/usage.test.ts`
Expected: FAIL — `Cannot find module '../src/usage.ts'`

- [ ] **Step 3: Implement the module**

`src/usage.ts`:

```ts
const WINDOW_MS = 5 * 3600_000;

type Sample = { t: number; tokens: number };

export class Usage {
  #samples = new Map<string, Sample[]>();

  record(account: string, inputTokens: number, outputTokens: number, now = Date.now()): void {
    const list = this.#samples.get(account) ?? [];
    list.push({ t: now, tokens: inputTokens + outputTokens });
    this.#samples.set(account, list);
  }

  /** Fraction of `budget` spent in the trailing five hours. Can exceed 1. */
  pace(account: string, budget: number, now = Date.now()): number {
    const list = this.#samples.get(account);
    if (!list || budget <= 0) return 0;
    const cutoff = now - WINDOW_MS;
    let total = 0;
    for (const s of list) if (s.t > cutoff) total += s.tokens;
    return total / budget;
  }

  freestAccount(accounts: { name: string; budget: number }[], now = Date.now()): string {
    if (accounts.length === 0) throw new Error('no accounts configured');
    let best = accounts[0];
    let bestPace = this.pace(best.name, best.budget, now);
    for (const a of accounts.slice(1)) {
      const p = this.pace(a.name, a.budget, now);
      if (p < bestPace) { best = a; bestPace = p; }
    }
    return best.name;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/usage.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/usage.ts test/usage.test.ts
git commit -m "feat: per-account usage pace and routing"
```

---

### Task 3: Session registry

**Files:**
- Create: `src/sessions.ts`, `test/sessions.test.ts`

**Interfaces:**
- Consumes: `Session`, `AdapterEvent`, `Msg`, `Status` from `src/types.ts`.
- Produces: `class Registry` with `create(init): Session`, `apply(id: string, e: AdapterEvent): void`, `get(id): Session | undefined`, `all(): Session[]`, `remove(id): void`, `subscribe(fn: () => void): () => void`, `save(): Promise<void>`, `static load(path: string): Promise<Registry>`.

The registry is the only place a `Session` is mutated. Adapters emit events; the registry decides what they mean.

- [ ] **Step 1: Write the failing test**

`test/sessions.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '../src/sessions.ts';

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
  reg.apply(id, { type: 'status', status: 'done' });
  assert.ok(reg.get(id)!.statusSince >= first);
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/sessions.test.ts`
Expected: FAIL — `Cannot find module '../src/sessions.ts'`

- [ ] **Step 3: Implement the module**

`src/sessions.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import type { AdapterEvent, Session } from './types.ts';

type Init = Pick<Session, 'provider' | 'account' | 'repo' | 'cwd' | 'branch' | 'title'>;

export class Registry {
  #sessions = new Map<string, Session>();
  #subs = new Set<() => void>();
  #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  create(init: Init): Session {
    const now = Date.now();
    const s: Session = {
      ...init,
      id: randomUUID(),
      vendorSessionId: null,
      status: 'working',
      transcript: [],
      pending: null,
      stoppedReason: null,
      startedAt: now,
      statusSince: now,
    };
    this.#sessions.set(s.id, s);
    this.#notify();
    return s;
  }

  get(id: string): Session | undefined {
    return this.#sessions.get(id);
  }

  all(): Session[] {
    return [...this.#sessions.values()];
  }

  remove(id: string): void {
    this.#sessions.delete(id);
    this.#notify();
  }

  apply(id: string, e: AdapterEvent): void {
    const s = this.#sessions.get(id);
    if (!s) return;
    // A stopped session is terminal until an explicit resume replaces it.
    if (s.status === 'stopped' && e.type !== 'vendor-session-id') return;

    switch (e.type) {
      case 'status':
        this.#setStatus(s, e.status);
        break;
      case 'msg':
        s.transcript.push(e.msg);
        break;
      case 'approval':
        s.pending = e.request;
        this.#setStatus(s, 'needs-you');
        break;
      case 'approval-resolved':
        s.pending = null;
        this.#setStatus(s, 'working');
        break;
      case 'vendor-session-id':
        s.vendorSessionId = e.id;
        break;
      case 'stopped':
        s.pending = null;
        s.stoppedReason = e.reason;
        this.#setStatus(s, 'stopped');
        break;
      case 'usage':
        break; // handled by the caller, which owns the Usage instance
    }
    this.#notify();
  }

  #setStatus(s: Session, status: Session['status']): void {
    if (s.status === status) return;
    s.status = status;
    s.statusSince = Date.now();
  }

  subscribe(fn: () => void): () => void {
    this.#subs.add(fn);
    return () => this.#subs.delete(fn);
  }

  #notify(): void {
    for (const fn of this.#subs) fn();
  }

  async save(): Promise<void> {
    if (this.#path === '/dev/null') return;
    await writeFile(this.#path, JSON.stringify(this.all(), null, 2));
  }

  static async load(path: string): Promise<Registry> {
    const reg = new Registry(path);
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch {
      return reg;
    }
    for (const s of JSON.parse(raw) as Session[]) {
      // Agents are children of this process; nothing survived the restart.
      reg.#sessions.set(s.id, {
        ...s,
        status: 'stopped',
        stoppedReason: s.stoppedReason ?? 'switchboard restarted',
        pending: null,
      });
    }
    return reg;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/sessions.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/sessions.ts test/sessions.test.ts
git commit -m "feat: session registry with restart persistence"
```

---

### Task 4: Claude adapter

**Files:**
- Create: `scripts/record-claude.ts`, `src/agents/claude.ts`, `test/agents-claude.test.ts`, `test/fixtures/claude-basic.json`

**Interfaces:**
- Consumes: `Adapter`, `AgentHandle`, `StartOpts`, `AdapterEvent` from `src/types.ts`.
- Produces: `claudeAdapter: Adapter`, plus the exported pure function `normalizeClaude(m: SDKMessage): AdapterEvent[]` that the tests drive directly.

The adapter splits in two on purpose: `normalizeClaude` is a pure message→events function that the fixtures test exhaustively, and `claudeAdapter.start` is the thin, untested plumbing around the SDK's streaming-input mode.

- [ ] **Step 1: Write the recorder and capture a real fixture**

`scripts/record-claude.ts`:

```ts
// Records one real Claude session's SDK messages to a fixture file.
// Usage: node scripts/record-claude.ts <out.json>
import { writeFile } from 'node:fs/promises';
import { query } from '@anthropic-ai/claude-agent-sdk';

const out = process.argv[2] ?? 'test/fixtures/claude-basic.json';
const messages: unknown[] = [];

const q = query({
  prompt: 'Run the shell command `echo switchboard`, then reply with only the word done.',
  options: { cwd: process.cwd(), permissionMode: 'bypassPermissions' },
});

for await (const m of q) messages.push(m);

await writeFile(out, JSON.stringify(messages, null, 2));
console.log(`recorded ${messages.length} messages to ${out}`);
```

Run: `node scripts/record-claude.ts test/fixtures/claude-basic.json`
Expected: a JSON array containing a `system`/`init` message, at least one `assistant` message with a `tool_use` block, a `user` message with the `tool_result`, and a final `result` message carrying `usage`.

Read the recorded file before writing the test — the assertions in Step 2 must match the real field names in it, not assumed ones.

- [ ] **Step 2: Write the failing test**

`test/agents-claude.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { readFile } from 'node:fs/promises';
import { normalizeClaude } from '../src/agents/claude.ts';
import type { AdapterEvent } from '../src/types.ts';

const fixture = JSON.parse(
  await readFile(new URL('./fixtures/claude-basic.json', import.meta.url), 'utf8'),
);

function replay(messages: unknown[]): AdapterEvent[] {
  return messages.flatMap((m) => normalizeClaude(m as never));
}

test('a recorded session yields text, a tool call, and a final done status', () => {
  const events = replay(fixture);

  assert.ok(events.some((e) => e.type === 'msg' && e.msg.kind === 'tool'),
    'expected at least one tool message');
  assert.ok(events.some((e) => e.type === 'msg' && e.msg.kind === 'text'),
    'expected at least one text message');
  assert.equal(events.at(-1)?.type, 'status');
  assert.deepEqual(events.at(-1), { type: 'status', status: 'done' });
});

test('the init message reports the vendor session id', () => {
  const events = replay(fixture);
  const first = events.find((e) => e.type === 'vendor-session-id');
  assert.ok(first, 'expected a vendor-session-id event');
});

test('the result message reports usage', () => {
  const events = replay(fixture);
  const usage = events.find((e) => e.type === 'usage');
  assert.ok(usage && usage.type === 'usage');
  assert.ok(usage.inputTokens > 0, 'expected non-zero input tokens');
});

test('an assistant text block becomes one text msg', () => {
  const events = normalizeClaude({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
  } as never);
  assert.deepEqual(events, [{ type: 'msg', msg: { kind: 'text', text: 'hello' } }]);
});

test('a tool_use block is summarized to one line', () => {
  const events = normalizeClaude({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls -la' } }],
    },
  } as never);
  assert.deepEqual(events, [
    { type: 'msg', msg: { kind: 'tool', name: 'Bash', summary: 'ls -la', status: 'running' } },
  ]);
});

test('an error result becomes an error msg and a stopped event', () => {
  const events = normalizeClaude({
    type: 'result', subtype: 'error_during_execution', is_error: true,
    result: 'boom', usage: { input_tokens: 1, output_tokens: 1 },
  } as never);
  assert.deepEqual(events.at(-1), { type: 'stopped', reason: 'boom' });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test test/agents-claude.test.ts`
Expected: FAIL — `Cannot find module '../src/agents/claude.ts'`

- [ ] **Step 4: Implement the adapter**

`src/agents/claude.ts`:

```ts
import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  Options, PermissionResult, SDKMessage, SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { Adapter, AdapterEvent, AgentHandle, StartOpts } from '../types.ts';

/** One line describing a tool call, for the transcript. */
function summarize(name: string, input: Record<string, unknown>): string {
  if (typeof input.command === 'string') return input.command;
  if (typeof input.file_path === 'string') return input.file_path;
  if (typeof input.pattern === 'string') return input.pattern;
  return name;
}

/** Pure: one SDK message in, zero or more normalized events out. */
export function normalizeClaude(m: SDKMessage): AdapterEvent[] {
  const out: AdapterEvent[] = [];

  if (m.type === 'system' && 'session_id' in m && m.session_id) {
    out.push({ type: 'vendor-session-id', id: m.session_id as string });
    return out;
  }

  if (m.type === 'assistant') {
    const content = (m as { message: { content: unknown } }).message.content;
    if (Array.isArray(content)) {
      for (const block of content as Record<string, unknown>[]) {
        if (block.type === 'text' && typeof block.text === 'string') {
          out.push({ type: 'msg', msg: { kind: 'text', text: block.text } });
        } else if (block.type === 'tool_use') {
          const name = String(block.name);
          out.push({
            type: 'msg',
            msg: {
              kind: 'tool',
              name,
              summary: summarize(name, (block.input ?? {}) as Record<string, unknown>),
              status: 'running',
            },
          });
        }
      }
    }
    return out;
  }

  if (m.type === 'result') {
    const r = m as unknown as {
      is_error?: boolean; result?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    if (r.usage) {
      out.push({
        type: 'usage',
        inputTokens: r.usage.input_tokens ?? 0,
        outputTokens: r.usage.output_tokens ?? 0,
      });
    }
    if (r.is_error) out.push({ type: 'stopped', reason: r.result ?? 'error' });
    else out.push({ type: 'status', status: 'done' });
    return out;
  }

  return out;
}

/** Async-iterable queue: the SDK pulls from this whenever we push a prompt. */
function inputQueue() {
  const buffer: SDKUserMessage[] = [];
  let wake: (() => void) | null = null;
  let closed = false;

  return {
    push(text: string) {
      buffer.push({
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
      } as SDKUserMessage);
      wake?.();
      wake = null;
    },
    close() {
      closed = true;
      wake?.();
      wake = null;
    },
    async *stream(): AsyncGenerator<SDKUserMessage> {
      while (true) {
        while (buffer.length) yield buffer.shift()!;
        if (closed) return;
        await new Promise<void>((r) => { wake = r; });
      }
    },
  };
}

export const claudeAdapter: Adapter = {
  start(opts: StartOpts, emit: (e: AdapterEvent) => void): AgentHandle {
    const input = inputQueue();
    let resolveApproval: ((r: PermissionResult) => void) | null = null;
    let approvalSeq = 0;

    const canUseTool = (
      toolName: string,
      toolInput: Record<string, unknown>,
    ): Promise<PermissionResult> => {
      const id = `a${++approvalSeq}`;
      emit({
        type: 'approval',
        request: { id, tool: toolName, summary: summarize(toolName, toolInput) },
      });
      return new Promise<PermissionResult>((resolve) => { resolveApproval = resolve; });
    };

    const options: Options = {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env } as Options['env'],
      canUseTool,
      ...(opts.resumeId ? { resume: opts.resumeId } : {}),
    };

    const q = query({ prompt: input.stream(), options });
    input.push(opts.prompt);

    (async () => {
      try {
        for await (const m of q) {
          emit({ type: 'status', status: 'working' });
          for (const e of normalizeClaude(m)) emit(e);
        }
        emit({ type: 'stopped', reason: 'session ended' });
      } catch (err) {
        emit({ type: 'stopped', reason: String((err as Error).message ?? err) });
      }
    })();

    return {
      send(text: string) {
        emit({ type: 'status', status: 'working' });
        input.push(text);
      },
      decide(allow: boolean) {
        const resolve = resolveApproval;
        resolveApproval = null;
        if (!resolve) return;
        emit({ type: 'approval-resolved' });
        resolve(allow
          ? { behavior: 'allow', updatedInput: {} }
          : { behavior: 'deny', message: 'denied from switchboard' });
      },
      stop() {
        input.close();
        void q.interrupt().catch(() => {});
      },
    };
  },
};
```

Note on the `emit({type:'status', status:'working'})` before each normalized message: the registry ignores a status change that matches the current status, so this is idempotent and costs nothing. It exists so a session that was `done` flips back to `working` the moment the next turn produces output.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/agents-claude.test.ts`
Expected: PASS, 6 tests. If the two fixture-driven assertions fail on field names, correct the *test* to match what Step 1 actually recorded — the fixture is ground truth.

- [ ] **Step 6: Commit**

```bash
git add scripts/record-claude.ts src/agents/claude.ts test/agents-claude.test.ts test/fixtures/claude-basic.json
git commit -m "feat: claude adapter with recorded-stream tests"
```

---

### Task 5: Codex adapter

**Files:**
- Create: `src/agents/codex.ts`, `test/agents-codex.test.ts`

**Interfaces:**
- Consumes: `Adapter`, `AgentHandle`, `StartOpts`, `AdapterEvent` from `src/types.ts`.
- Produces: `codexAdapter: Adapter` and the pure `normalizeCodex(e: ThreadEvent): AdapterEvent[]`.

**Codex has no interactive approvals.** `@openai/codex-sdk` exposes `approvalPolicy` as a *policy* fixed at thread start (`"never" | "on-request" | "on-failure" | "untrusted"`), and its `ThreadEvent` union contains no approval-request event and no method to answer one. Codex sessions therefore run with `approvalPolicy: 'never'` and `sandboxMode: 'workspace-write'`, scoped to their worktree, and never enter `needs-you`. `decide()` is a no-op for this adapter. Interactive approvals would require driving `codex app-server` JSON-RPC directly instead of the SDK; that is deferred.

- [ ] **Step 1: Write the failing test**

`test/agents-codex.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { normalizeCodex } from '../src/agents/codex.ts';

test('thread.started reports the vendor session id', () => {
  assert.deepEqual(
    normalizeCodex({ type: 'thread.started', thread_id: 'th_1' } as never),
    [{ type: 'vendor-session-id', id: 'th_1' }],
  );
});

test('turn.started sets working', () => {
  assert.deepEqual(
    normalizeCodex({ type: 'turn.started' } as never),
    [{ type: 'status', status: 'working' }],
  );
});

test('an agent_message item becomes a text msg', () => {
  assert.deepEqual(
    normalizeCodex({
      type: 'item.completed',
      item: { id: 'i1', type: 'agent_message', text: 'hello' },
    } as never),
    [{ type: 'msg', msg: { kind: 'text', text: 'hello' } }],
  );
});

test('a completed command_execution becomes an ok tool msg', () => {
  assert.deepEqual(
    normalizeCodex({
      type: 'item.completed',
      item: {
        id: 'i2', type: 'command_execution', command: 'ls -la',
        aggregated_output: '...', exit_code: 0, status: 'completed',
      },
    } as never),
    [{ type: 'msg', msg: { kind: 'tool', name: 'shell', summary: 'ls -la', status: 'ok' } }],
  );
});

test('a failed command_execution becomes an error tool msg', () => {
  const events = normalizeCodex({
    type: 'item.completed',
    item: {
      id: 'i3', type: 'command_execution', command: 'false',
      aggregated_output: '', exit_code: 1, status: 'failed',
    },
  } as never);
  assert.equal(events[0].type, 'msg');
  assert.deepEqual(events[0], {
    type: 'msg',
    msg: { kind: 'tool', name: 'shell', summary: 'false', status: 'error' },
  });
});

test('a file_change item lists the touched paths', () => {
  assert.deepEqual(
    normalizeCodex({
      type: 'item.completed',
      item: {
        id: 'i4', type: 'file_change', status: 'completed',
        changes: [{ path: 'a.ts', kind: 'update' }, { path: 'b.ts', kind: 'add' }],
      },
    } as never),
    [{ type: 'msg', msg: { kind: 'tool', name: 'edit', summary: 'a.ts, b.ts', status: 'ok' } }],
  );
});

test('item.started is ignored so items are only rendered once', () => {
  assert.deepEqual(
    normalizeCodex({
      type: 'item.started',
      item: { id: 'i5', type: 'agent_message', text: 'partial' },
    } as never),
    [],
  );
});

test('turn.completed reports usage and sets done', () => {
  assert.deepEqual(
    normalizeCodex({
      type: 'turn.completed',
      usage: {
        input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0,
        output_tokens: 5, reasoning_output_tokens: 0,
      },
    } as never),
    [
      { type: 'usage', inputTokens: 10, outputTokens: 5 },
      { type: 'status', status: 'done' },
    ],
  );
});

test('turn.failed stops the session with the error message', () => {
  assert.deepEqual(
    normalizeCodex({ type: 'turn.failed', error: { message: 'nope' } } as never),
    [{ type: 'stopped', reason: 'nope' }],
  );
});

test('a fatal error event stops the session', () => {
  assert.deepEqual(
    normalizeCodex({ type: 'error', message: 'fatal' } as never),
    [{ type: 'stopped', reason: 'fatal' }],
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/agents-codex.test.ts`
Expected: FAIL — `Cannot find module '../src/agents/codex.ts'`

- [ ] **Step 3: Implement the adapter**

`src/agents/codex.ts`:

```ts
import { Codex } from '@openai/codex-sdk';
import type { ThreadEvent, ThreadItem } from '@openai/codex-sdk';
import type { Adapter, AdapterEvent, AgentHandle, Msg, StartOpts } from '../types.ts';

function itemToMsg(item: ThreadItem): Msg | null {
  switch (item.type) {
    case 'agent_message':
      return { kind: 'text', text: item.text };
    case 'command_execution':
      return {
        kind: 'tool', name: 'shell', summary: item.command,
        status: item.status === 'failed' ? 'error' : 'ok',
      };
    case 'file_change':
      return {
        kind: 'tool', name: 'edit',
        summary: item.changes.map((c) => c.path).join(', '),
        status: item.status === 'failed' ? 'error' : 'ok',
      };
    case 'mcp_tool_call':
      return {
        kind: 'tool', name: item.tool, summary: `${item.server}.${item.tool}`,
        status: item.status === 'failed' ? 'error' : 'ok',
      };
    case 'web_search':
      return { kind: 'tool', name: 'search', summary: item.query, status: 'ok' };
    case 'error':
      return { kind: 'error', text: item.message };
    // Reasoning and todo lists are noise in a card grid.
    case 'reasoning':
    case 'todo_list':
      return null;
  }
}

/** Pure: one Codex thread event in, zero or more normalized events out. */
export function normalizeCodex(e: ThreadEvent): AdapterEvent[] {
  switch (e.type) {
    case 'thread.started':
      return [{ type: 'vendor-session-id', id: e.thread_id }];
    case 'turn.started':
      return [{ type: 'status', status: 'working' }];
    case 'turn.completed':
      return [
        { type: 'usage', inputTokens: e.usage.input_tokens, outputTokens: e.usage.output_tokens },
        { type: 'status', status: 'done' },
      ];
    case 'turn.failed':
      return [{ type: 'stopped', reason: e.error.message }];
    case 'error':
      return [{ type: 'stopped', reason: e.message }];
    case 'item.completed': {
      const msg = itemToMsg(e.item);
      return msg ? [{ type: 'msg', msg }] : [];
    }
    // Only completed items are rendered, so an item never appears twice.
    case 'item.started':
    case 'item.updated':
      return [];
  }
}

const CODEX_BIN = '/Applications/ChatGPT.app/Contents/Resources/codex';

export const codexAdapter: Adapter = {
  start(opts: StartOpts, emit: (e: AdapterEvent) => void): AgentHandle {
    const codex = new Codex({
      codexPathOverride: CODEX_BIN,
      env: { ...process.env, ...opts.env } as Record<string, string>,
    });

    const threadOptions = {
      workingDirectory: opts.cwd,
      sandboxMode: 'workspace-write' as const,
      // The SDK has no interactive approval callback; the sandbox is the boundary.
      approvalPolicy: 'never' as const,
    };

    const thread = opts.resumeId
      ? codex.resumeThread(opts.resumeId, threadOptions)
      : codex.startThread(threadOptions);

    const queue: string[] = [];
    let running = false;
    let stopped = false;

    async function drain(): Promise<void> {
      if (running || stopped) return;
      running = true;
      try {
        while (queue.length && !stopped) {
          const text = queue.shift()!;
          const { events } = await thread.runStreamed(text);
          for await (const e of events) {
            if (stopped) break;
            for (const ev of normalizeCodex(e)) emit(ev);
          }
        }
      } catch (err) {
        emit({ type: 'stopped', reason: String((err as Error).message ?? err) });
      } finally {
        running = false;
      }
    }

    queue.push(opts.prompt);
    void drain();

    return {
      send(text: string) {
        emit({ type: 'status', status: 'working' });
        queue.push(text);
        void drain();
      },
      // Codex approvals are policy, not interactive. Nothing to decide.
      decide() {},
      stop() {
        stopped = true;
        queue.length = 0;
        emit({ type: 'stopped', reason: 'stopped from switchboard' });
      },
    };
  },
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/agents-codex.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/agents/codex.ts test/agents-codex.test.ts
git commit -m "feat: codex adapter, sandbox-scoped with no interactive approvals"
```

---

### Task 6: HTTP server

**Files:**
- Create: `src/server.ts`, `accounts.example.json`, `test/server.test.ts`

**Interfaces:**
- Consumes: `Registry` from `src/sessions.ts`, `Usage` from `src/usage.ts`, `createWorktree`/`worktreeStatus` from `src/worktree.ts`, `claudeAdapter`, `codexAdapter`.
- Produces: `createServer(opts: {registry: Registry, usage: Usage, accounts: Account[], statePath: string}): http.Server` and `recentRepos(): Promise<string[]>`.

Routes:

| Route | Purpose |
|---|---|
| `GET /` `/app.js` `/style.css` | Static files from `web/` |
| `GET /events` | SSE. Sends a full snapshot on connect and on every registry change. |
| `GET /repos` | Repo paths decoded from `~/.claude/projects/` directory names |
| `POST /command` | `{cmd, ...}` — `create`, `send`, `decide`, `stop`, `resume`, `delete` |

- [ ] **Step 1: Write the accounts template**

`accounts.example.json`:

```json
[
  { "name": "claude-main", "provider": "claude", "budget": 2000000, "env": {} },
  { "name": "claude-alt", "provider": "claude", "budget": 2000000,
    "env": { "CLAUDE_CONFIG_DIR": "/Users/dwightbritton/.claude-alt" } },
  { "name": "codex", "provider": "codex", "budget": 2000000, "env": {} }
]
```

- [ ] **Step 2: Write the failing test**

`test/server.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '../src/sessions.ts';
import { Usage } from '../src/usage.ts';
import { createServer } from '../src/server.ts';

const accounts = [
  { name: 'claude-main', provider: 'claude' as const, budget: 1000, env: {} },
  { name: 'codex', provider: 'codex' as const, budget: 1000, env: {} },
];

async function boot(t: { after: (fn: () => void) => void }) {
  const dir = await mkdtemp(join(tmpdir(), 'sb-'));
  const registry = new Registry(join(dir, 'state.json'));
  const usage = new Usage();
  const server = createServer({ registry, usage, accounts, statePath: join(dir, 'state.json') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  t.after(() => { server.close(); return rm(dir, { recursive: true, force: true }); });
  return { base: `http://127.0.0.1:${port}`, registry };
}

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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test test/server.test.ts`
Expected: FAIL — `Cannot find module '../src/server.ts'`

- [ ] **Step 4: Implement the server**

`src/server.ts`:

```ts
import { createServer as httpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Server } from 'node:http';
import { readFile, readdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join, extname } from 'node:path';
import { Registry } from './sessions.ts';
import { Usage } from './usage.ts';
import { createWorktree, worktreeStatus } from './worktree.ts';
import { claudeAdapter } from './agents/claude.ts';
import { codexAdapter } from './agents/codex.ts';
import type { AgentHandle } from './types.ts';

const run = promisify(execFile);

export type Account = {
  name: string;
  provider: 'claude' | 'codex';
  budget: number;
  env: Record<string, string>;
};

const WEB = new URL('../web/', import.meta.url).pathname;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

/** Directory names under ~/.claude/projects decode back to repo paths. */
export async function recentRepos(): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(join(homedir(), '.claude', 'projects'));
  } catch {
    return [];
  }
  const repos = new Set<string>();
  for (const name of names) {
    // Worktree slugs contain the base repo path before the `--` separator.
    const base = name.split('--')[0];
    repos.add(base.replace(/^-/, '/').replaceAll('-', '/'));
  }
  return [...repos].sort();
}

export function createServer(opts: {
  registry: Registry;
  usage: Usage;
  accounts: Account[];
  statePath: string;
}): Server {
  const { registry, usage, accounts } = opts;
  const handles = new Map<string, AgentHandle>();

  function snapshot() {
    return {
      sessions: registry.all(),
      accounts: accounts.map((a) => ({
        name: a.name,
        provider: a.provider,
        pace: usage.pace(a.name, a.budget),
      })),
    };
  }

  function launch(sessionId: string, account: Account, cwd: string, prompt: string, resumeId?: string): void {
    const adapter = account.provider === 'claude' ? claudeAdapter : codexAdapter;
    const handle = adapter.start({ cwd, prompt, env: account.env, resumeId }, (e) => {
      if (e.type === 'usage') usage.record(account.name, e.inputTokens, e.outputTokens);
      registry.apply(sessionId, e);
    });
    handles.set(sessionId, handle);
  }

  async function command(body: Record<string, unknown>): Promise<{ status: number; json: unknown }> {
    switch (body.cmd) {
      case 'create': {
        const account = accounts.find((a) => a.name === body.account);
        if (!account) return { status: 400, json: { error: `unknown account: ${body.account}` } };
        let cwd: string;
        try {
          cwd = await createWorktree(String(body.repo), String(body.branch));
        } catch (err) {
          return { status: 400, json: { error: (err as Error).message } };
        }
        const session = registry.create({
          provider: account.provider,
          account: account.name,
          repo: String(body.repo),
          cwd,
          branch: String(body.branch),
          title: String(body.branch),
        });
        launch(session.id, account, cwd, String(body.prompt));
        return { status: 200, json: { id: session.id } };
      }

      case 'send': {
        const handle = handles.get(String(body.id));
        if (!handle) return { status: 404, json: { error: 'no live session' } };
        registry.apply(String(body.id), {
          type: 'msg', msg: { kind: 'user', text: String(body.text) },
        });
        handle.send(String(body.text));
        return { status: 200, json: { ok: true } };
      }

      case 'decide': {
        const handle = handles.get(String(body.id));
        if (!handle) return { status: 404, json: { error: 'no live session' } };
        handle.decide(Boolean(body.allow));
        return { status: 200, json: { ok: true } };
      }

      case 'stop': {
        handles.get(String(body.id))?.stop();
        handles.delete(String(body.id));
        return { status: 200, json: { ok: true } };
      }

      case 'resume': {
        const session = registry.get(String(body.id));
        if (!session) return { status: 404, json: { error: 'no such session' } };
        const account = accounts.find((a) => a.name === session.account);
        if (!account) return { status: 400, json: { error: 'account no longer configured' } };
        session.status = 'working';
        session.stoppedReason = null;
        launch(
          session.id, account, session.cwd, String(body.prompt ?? 'continue'),
          session.vendorSessionId ?? undefined,
        );
        return { status: 200, json: { ok: true } };
      }

      case 'delete': {
        const session = registry.get(String(body.id));
        handles.get(String(body.id))?.stop();
        handles.delete(String(body.id));
        if (session && body.removeWorktree) {
          await run('git', ['worktree', 'remove', '--force', session.cwd], { cwd: session.repo })
            .catch(() => rm(session.cwd, { recursive: true, force: true }));
        }
        registry.remove(String(body.id));
        return { status: 200, json: { ok: true } };
      }

      default:
        return { status: 400, json: { error: `unknown cmd: ${String(body.cmd)}` } };
    }
  }

  const server = httpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (url.pathname === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const push = () => res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
      push();
      const unsub = registry.subscribe(push);
      // Keeps proxies and sleeping laptops from dropping an idle stream.
      const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
      req.on('close', () => { unsub(); clearInterval(ping); });
      return;
    }

    if (url.pathname === '/repos') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(await recentRepos()));
      return;
    }

    if (url.pathname === '/status') {
      const id = url.searchParams.get('id') ?? '';
      const session = registry.get(id);
      if (!session) { res.writeHead(404).end('{}'); return; }
      const status = await worktreeStatus(session.cwd).catch(() => null);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(status));
      return;
    }

    if (url.pathname === '/command' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let result: { status: number; json: unknown };
      try {
        result = await command(JSON.parse(Buffer.concat(chunks).toString() || '{}'));
      } catch (err) {
        result = { status: 400, json: { error: (err as Error).message } };
      }
      res.writeHead(result.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result.json));
      await registry.save();
      return;
    }

    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    // Serve only the three known assets; never join user-controlled path segments.
    if (!['index.html', 'app.js', 'style.css'].includes(file)) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] });
    res.end(await readFile(join(WEB, file)));
  });

  return server;
}

// Entry point: only when run directly, so tests can import createServer freely.
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const statePath = new URL('../state.json', import.meta.url).pathname;
  const accounts = JSON.parse(
    await readFile(new URL('../accounts.json', import.meta.url), 'utf8'),
  ) as Account[];
  const registry = await Registry.load(statePath);
  const usage = new Usage();
  createServer({ registry, usage, accounts, statePath })
    .listen(4711, '127.0.0.1', () => console.log('switchboard on http://127.0.0.1:4711'));
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/server.test.ts`
Expected: PASS, 5 tests. `GET /` will fail until Task 7 creates `web/index.html` — create a one-line placeholder `<title>Switchboard</title>` now and let Task 7 replace it.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS, all tests from Tasks 1–6.

- [ ] **Step 7: Commit**

```bash
git add src/server.ts accounts.example.json test/server.test.ts web/index.html
git commit -m "feat: http server with SSE state push and command endpoint"
```

---

### Task 7: Web UI

**Files:**
- Create: `web/index.html`, `web/style.css`, `web/app.js`
- Modify: replace the Task 6 placeholder `web/index.html`

**Interfaces:**
- Consumes: `GET /events` snapshots (`{sessions, accounts}`), `POST /command`, `GET /repos`, `GET /status?id=`.
- Produces: no module exports. Verified manually.

No tests here, by design — a browser test asserting a card turned orange costs more than the bugs it catches.

- [ ] **Step 1: Write the shell**

`web/index.html`:

```html
<!doctype html>
<meta charset="utf-8">
<title>Switchboard</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/style.css">
<main id="grid"></main>
<section id="chat" hidden>
  <header><button id="back">← grid</button><h2 id="chat-title"></h2></header>
  <div id="transcript"></div>
  <form id="composer"><input id="prompt" placeholder="Message…" autocomplete="off"><button>Send</button></form>
</section>
<dialog id="new">
  <form method="dialog">
    <label>Repo <input name="repo" list="repos" required></label>
    <datalist id="repos"></datalist>
    <label>Branch <input name="branch" required placeholder="feat/thing"></label>
    <label>Account <select name="account"></select></label>
    <label>First prompt <textarea name="prompt" required rows="3"></textarea></label>
    <p id="new-error"></p>
    <menu><button value="cancel">Cancel</button><button id="create" value="create">Create</button></menu>
  </form>
</dialog>
<script type="module" src="/app.js"></script>
```

- [ ] **Step 2: Write the styles**

`web/style.css`:

```css
:root {
  color-scheme: dark;
  --bg: #111; --card: #1c1c1c; --fg: #eee; --dim: #888;
  --working: #35c46a; --needs: #d98324; --done: #4a8fe7; --stopped: #666;
}
body { margin: 0; padding: 1.5rem; background: var(--bg); color: var(--fg);
  font: 15px/1.4 ui-sans-serif, system-ui, sans-serif; }
#grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }
.accounts { grid-column: 1 / -1; display: grid; gap: 1rem;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); }
.card { background: var(--card); border-radius: 14px; padding: 1rem; cursor: pointer;
  border: 1px solid transparent; }
.card.needs-you { border-color: var(--needs); }
.status { font-weight: 600; text-transform: lowercase; }
.status.working { color: var(--working); }
.status.needs-you { color: var(--needs); }
.status.done { color: var(--done); }
.status.stopped { color: var(--stopped); }
.branch { font-weight: 700; margin: .4rem 0; word-break: break-word; }
.meta, .wt { color: var(--dim); font-size: .9em; }
.bar { height: 5px; border-radius: 3px; background: #333; overflow: hidden; margin: .4rem 0; }
.bar > i { display: block; height: 100%; background: var(--working); }
.bar.over > i { background: var(--needs); }
.approval { margin-top: .6rem; }
.approval button { margin-right: .4rem; }
#new-card { display: grid; place-content: center; color: var(--dim); min-height: 120px; }
#transcript { max-width: 60rem; }
.msg { padding: .5rem 0; border-bottom: 1px solid #222; white-space: pre-wrap; }
.msg.tool { color: var(--dim); font-family: ui-monospace, monospace; font-size: .9em; }
.msg.user { color: var(--done); }
.msg.error { color: #e05555; }
#composer { display: flex; gap: .5rem; margin-top: 1rem; max-width: 60rem; }
#prompt { flex: 1; padding: .6rem; background: var(--card); color: var(--fg);
  border: 1px solid #333; border-radius: 8px; }
```

- [ ] **Step 3: Write the client**

`web/app.js`:

```js
const ORDER = { 'needs-you': 0, working: 1, done: 2, stopped: 3 };
let state = { sessions: [], accounts: [] };
let openId = null;
let seenNeedsYou = new Set();

const $ = (sel) => document.querySelector(sel);

async function send(body) {
  const res = await fetch('/command', { method: 'POST', body: JSON.stringify(body) });
  return { ok: res.ok, data: await res.json() };
}

// EventSource reconnects on its own, so there is no backoff code to write.
const es = new EventSource('/events');
es.onmessage = (e) => {
  state = JSON.parse(e.data);
  notify();
  render();
};

function notify() {
  const needs = state.sessions.filter((s) => s.status === 'needs-you');
  document.title = needs.length ? `(${needs.length}) Switchboard` : 'Switchboard';
  if (document.hasFocus() || Notification.permission !== 'granted') return;
  for (const s of needs) {
    if (seenNeedsYou.has(s.id)) continue;
    seenNeedsYou.add(s.id);
    new Notification(`${s.branch} needs you`, { body: s.pending?.summary ?? '' });
  }
  seenNeedsYou = new Set(needs.map((s) => s.id));
}

function elapsed(since) {
  const m = Math.floor((Date.now() - since) / 60000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60}m`;
}

function render() {
  openId ? renderChat() : renderGrid();
}

function renderGrid() {
  $('#chat').hidden = true;
  const grid = $('#grid');
  grid.hidden = false;
  grid.replaceChildren();

  const accounts = document.createElement('div');
  accounts.className = 'accounts';
  for (const a of state.accounts) {
    const pct = Math.round(a.pace * 100);
    const el = document.createElement('div');
    el.className = 'card';
    el.innerHTML = `<div class="status">${a.name}</div>
      <div class="bar ${a.pace > 1 ? 'over' : ''}"><i style="width:${Math.min(pct, 100)}%"></i></div>
      <div class="meta">~${pct}% of 5h budget · estimate</div>`;
    accounts.append(el);
  }
  grid.append(accounts);

  const sorted = [...state.sessions].sort(
    (a, b) => ORDER[a.status] - ORDER[b.status] || b.statusSince - a.statusSince,
  );
  for (const s of sorted) grid.append(card(s));

  const add = document.createElement('div');
  add.className = 'card';
  add.id = 'new-card';
  add.textContent = '+ new worktree';
  add.onclick = openNew;
  grid.append(add);
}

function card(s) {
  const el = document.createElement('div');
  el.className = `card ${s.status}`;
  el.innerHTML = `
    <div class="status ${s.status}">${s.status} · ${elapsed(s.statusSince)}</div>
    <div class="branch">${s.branch}</div>
    <div class="meta">${s.account}</div>
    <div class="wt" data-wt></div>`;
  el.onclick = () => { openId = s.id; render(); };

  fetch(`/status?id=${s.id}`).then((r) => r.json()).then((wt) => {
    if (!wt) return;
    el.querySelector('[data-wt]').textContent =
      `+${wt.added} −${wt.removed} · ${wt.dirty ? 'dirty' : 'clean'}`;
  }).catch(() => {});

  if (s.pending) el.append(approval(s));
  if (s.status === 'stopped') el.append(resumeButton(s));
  return el;
}

function approval(s) {
  const box = document.createElement('div');
  box.className = 'approval';
  box.innerHTML = `<div class="wt">${s.pending.tool}: ${s.pending.summary}</div>`;
  for (const [label, allow] of [['Allow', true], ['Deny', false]]) {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = (e) => { e.stopPropagation(); send({ cmd: 'decide', id: s.id, allow }); };
    box.append(b);
  }
  return box;
}

function resumeButton(s) {
  const b = document.createElement('button');
  b.textContent = `Resume (${s.stoppedReason ?? 'stopped'})`;
  b.onclick = (e) => { e.stopPropagation(); send({ cmd: 'resume', id: s.id }); };
  return b;
}

function renderChat() {
  const s = state.sessions.find((x) => x.id === openId);
  if (!s) { openId = null; return renderGrid(); }
  $('#grid').hidden = true;
  $('#chat').hidden = false;
  $('#chat-title').textContent = `${s.branch} · ${s.account} · ${s.status}`;

  const t = $('#transcript');
  t.replaceChildren();
  for (const m of s.transcript) {
    const el = document.createElement('div');
    el.className = `msg ${m.kind}`;
    el.textContent = m.kind === 'tool' ? `${m.name}: ${m.summary}` : m.text;
    t.append(el);
  }
  if (s.pending) t.append(approval(s));
  t.scrollIntoView({ block: 'end' });
}

$('#back').onclick = () => { openId = null; render(); };

$('#composer').onsubmit = (e) => {
  e.preventDefault();
  const text = $('#prompt').value.trim();
  if (!text) return;
  $('#prompt').value = '';
  send({ cmd: 'send', id: openId, text });
};

async function openNew() {
  const repos = await fetch('/repos').then((r) => r.json());
  $('#repos').replaceChildren(...repos.map((r) => {
    const o = document.createElement('option');
    o.value = r;
    return o;
  }));

  const sel = document.querySelector('select[name=account]');
  const freest = [...state.accounts].sort((a, b) => a.pace - b.pace)[0];
  sel.replaceChildren(...state.accounts.map((a) => {
    const o = document.createElement('option');
    o.value = a.name;
    o.textContent = a.name;
    o.selected = a.name === freest?.name;
    return o;
  }));

  $('#new-error').textContent = '';
  $('#new').showModal();
}

$('#new').addEventListener('close', async (e) => {
  const dialog = e.target;
  if (dialog.returnValue !== 'create') return;
  const f = new FormData(dialog.querySelector('form'));
  const { ok, data } = await send({
    cmd: 'create',
    repo: f.get('repo'), branch: f.get('branch'),
    account: f.get('account'), prompt: f.get('prompt'),
  });
  if (!ok) {
    $('#new-error').textContent = data.error;
    dialog.showModal();
  }
});

if (Notification.permission === 'default') Notification.requestPermission();
setInterval(render, 30_000); // keeps the elapsed times honest
```

- [ ] **Step 4: Verify manually**

Run: `cp accounts.example.json accounts.json && npm start`
Open `http://127.0.0.1:4711`. Confirm: three account cards with usage bars, a `+ new worktree` tile, and no console errors.

- [ ] **Step 5: Commit**

```bash
git add web/
git commit -m "feat: card grid and chat view"
```

---

### Task 8: Second account, README, end-to-end run

**Files:**
- Create: `README.md`
- Modify: `accounts.json` (gitignored, local only)

**Interfaces:**
- Consumes: everything.
- Produces: a working install.

- [ ] **Step 1: Set up the second Claude account**

The two Claude accounts are only separable by config directory. Run:

```bash
CLAUDE_CONFIG_DIR=~/.claude-alt claude
```

Log in as the second account when prompted, then exit. Confirm `~/.claude-alt/.claude.json` exists and its `oauthAccount.emailAddress` differs from the one in `~/.claude.json`.

- [ ] **Step 2: Point accounts.json at it**

```bash
cp accounts.example.json accounts.json
```

Edit `accounts.json` so `claude-alt`'s `CLAUDE_CONFIG_DIR` is the absolute path to `~/.claude-alt`. Budgets start at 2000000 tokens per five hours and get tuned once you have seen a real day of use.

- [ ] **Step 3: Write the README**

`README.md`:

````markdown
# Switchboard

One window for coding-agent sessions across two Claude accounts and one Codex account.

## Setup

Requires Node >= 22.18 (runs TypeScript directly — there is no build step).

```bash
npm install
cp accounts.example.json accounts.json   # then edit the paths
npm start                                # http://127.0.0.1:4711
```

The second Claude account needs its own config directory:

```bash
CLAUDE_CONFIG_DIR=~/.claude-alt claude   # log in as the second account, then exit
```

Codex uses the binary inside ChatGPT.app and the existing `~/.codex/auth.json`.

## What it does

Each session runs in its own git worktree at `<repo>/.claude/worktrees/<branch>`.
Cards sort blocked-first: `needs-you`, `working`, `done`, `stopped`. Claude
permission prompts are answered from the card. Codex runs sandboxed to its
worktree and never prompts.

Usage percentages are estimates from observed token spend against the `budget`
in `accounts.json`, not real plan limits — no CLI exposes those.

## Tests

```bash
npm test
```

## Limits

- Only sessions started here are shown. Sessions from the Claude desktop app or
  ChatGPT.app are invisible to it.
- Agents are children of the server. Stopping it stops them; cards return as
  `stopped` with their transcripts and a Resume button.
- Codex approvals are policy, not interactive — `@openai/codex-sdk` has no
  approval callback.
````

- [ ] **Step 4: Run the whole suite**

Run: `npm test`
Expected: PASS, every test from Tasks 1–6.

- [ ] **Step 5: End-to-end verification**

Start the server and, in the browser:

1. Create a session on `claude-main` against a real repo with branch `sb/smoke` and the prompt `create a file called hello.txt containing the word hi`. Confirm the card appears as `working`.
2. Confirm a permission request appears on the card, and that clicking Allow returns it to `working`.
3. Confirm the card reaches `done` and the worktree line shows a non-zero diff.
4. Open the card, send `now delete that file`, and confirm the transcript grows.
5. Repeat step 1 on the `codex` account. Confirm it goes `working` → `done` and never shows an approval.
6. Restart the server. Confirm both cards return as `stopped` with transcripts intact, and that Resume puts one back to `working`.
7. Delete both sessions with "remove worktree" checked, then confirm `git worktree list` in the repo no longer lists them.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs: setup and limits"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| Launch on any of three accounts, each in a worktree | 1, 6, 8 |
| Card grid with status, branch, worktree diff | 7 |
| Answer permission prompts from the grid | 4, 6, 7 |
| Chat view with prompt box | 7 |
| Browser notification on `needs-you` | 7 |
| Approximate usage + auto-route to freest account | 2, 7 |
| Status observed, never inferred | 4, 5 |
| Restart survival via registry | 3, 6 |
| Per-provider failure isolation | 5, 6 |
| Worktree creation failures surface inline, no orphan session | 1, 6, 7 |
| Adapter fixture tests, worktree git tests, usage table test | 1, 2, 4, 5 |
| No UI tests | 7 |

**Deviations from the spec, both deliberate:**

1. **Transport is SSE + `POST`, not WebSocket.** The traffic is asymmetric — the server pushes state, the browser posts commands — which is exactly SSE's shape. It removes the `ws` dependency and `EventSource` reconnects on its own, so the spec's "reconnect with backoff" requirement is met by writing no code at all.
2. **Codex cannot answer approvals.** `@openai/codex-sdk@0.145.0` has `approvalPolicy` as a start-time policy and no approval event or answer method in `ThreadEvent`. The spec's claim that both vendors support interactive approval is wrong. Codex runs `sandboxMode: 'workspace-write'` scoped to its worktree with `approvalPolicy: 'never'` and never enters `needs-you`.

Both need to be corrected in the spec document.

**Placeholder scan:** none. Every code step contains complete, runnable code.

**Type consistency:** `Status`, `Msg`, `ApprovalRequest`, `Session`, `AdapterEvent`, `StartOpts`, `AgentHandle`, and `Adapter` are defined once in Task 1 and used unchanged in Tasks 3–7. `normalizeClaude`/`normalizeCodex` both return `AdapterEvent[]`. `createWorktree`/`worktreeStatus` signatures match their Task 6 call sites. `Usage.pace`/`freestAccount` match their server and client uses.
