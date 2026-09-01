# Overlap Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show which sessions have changed the same files — to agents through relay's `list_sessions`, and to the human as badges on the session card.

**Architecture:** A `changedPaths()` git helper collects a session's committed and uncommitted file set; a process-local cache holds one entry per session with the time it was computed, which is what keeps a four-second poll from spawning hundreds of subprocesses; a pure `overlaps()` function intersects cached sets across same-repo sessions. Two consumers read the result — the `/status` response the card already fetches, and the `relaySessions` closure that feeds `list_sessions`.

**Tech Stack:** TypeScript run directly on Node >= 22.18 (no build step, no typecheck), `node --test`, `node:child_process` git invocations, plain-DOM browser code in `web/`.

**Spec:** `docs/superpowers/specs/2026-08-30-overlap-detection-design.md`

## Global Constraints

- Node >= 22.18. TypeScript runs directly; there is no build step and **no typecheck** — `npm test` is bare `node --test test/*.test.ts`, so tests are the only defect gate.
- Run `npm test` before claiming completion. While iterating, run the focused `node --test` command first.
- Tests must be offline: no paid, networked, or real-account tests. No test may bind port 1455, open a browser, or spawn a real `claude`/`codex` binary.
- Never persist, log, return over SSE, or render account environment values.
- `CONVERSATION_INPUTS` (`src/merge.ts:44`) must be applied to every git invocation that collects paths. Without it a pasted upload registers as an overlap.
- The path cache TTL is **30000 ms**. `STATUS_THROTTLE_MS` is 4000 (`web/app.js:442`), so the cache — not the poll rate — is what bounds git work.
- At most **10** paths are listed anywhere, followed by "and N more".
- This feature is advisory. It never blocks a merge, never refuses an edit, and never claims a file. Wording is "also changed in", never "locked by".
- Channel state is process-local and never persisted. The path cache follows the same rule.

---

### Task 1: Collect a session's changed paths

The git half, isolated so it can be tested against a real repository with no server involved.

Two sources, unioned. The uncommitted set comes from calls `worktreeStatus` already makes and throws away; the committed set is a new invocation, and it is not optional — two sessions that each *committed* to the same file show as clean worktrees and still collide, which is the case most worth warning about.

**Files:**
- Modify: `src/worktree.ts` (a new exported function beside `worktreeStatus` at line 196)
- Test: `test/worktree.test.ts`

**Interfaces:**
- Consumes: `CONVERSATION_INPUTS` from `src/merge.ts`, already imported by `src/worktree.ts:5`. `base` is passed in rather than resolved here, so this function needs no repo path and stays testable against a bare worktree.
- Produces: `export async function changedPaths(cwd: string, base: string): Promise<string[]>` — worktree-relative paths this session has changed, committed and uncommitted, sorted and deduplicated. `base` is a branch name; an empty string means the committed half is skipped.

- [ ] **Step 1: Write the failing test**

Add to `test/worktree.test.ts`. It has a `makeRepo()` helper at line 12; use it.

```ts
test('changedPaths unions committed and uncommitted work', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const wt = await createWorktree(repo, 'feat/paths');

  await writeFile(join(wt, 'committed.txt'), 'done\n');
  await run('git', ['add', '.'], { cwd: wt });
  await run('git', ['commit', '-m', 'a commit'], { cwd: wt });
  await writeFile(join(wt, 'dirty.txt'), 'in progress\n');
  await writeFile(join(wt, 'a.txt'), 'modified\n');

  assert.deepEqual(
    await changedPaths(wt, 'main'),
    ['a.txt', 'committed.txt', 'dirty.txt'],
  );
});

test('changedPaths excludes conversation inputs', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const wt = await createWorktree(repo, 'feat/inputs');

  await writeFile(join(wt, 'real.txt'), 'work\n');
  // The name writeContainedUpload actually produces (src/upload.ts) — without
  // the exclusion every session that ever had a screenshot pasted into it would
  // register as overlapping with every other one.
  await writeFile(join(wt, '.switchboard-upload-0123456789abcdef0123456789abcdef-shot.png'), 'png\n');
  await mkdir(join(wt, '.switchboard'), { recursive: true });
  await writeFile(join(wt, '.switchboard', 'handoff.md'), '# Handoff\n');

  assert.deepEqual(await changedPaths(wt, 'main'), ['real.txt']);
});

test('changedPaths skips the committed half when there is no base branch', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const wt = await createWorktree(repo, 'feat/detached');

  await writeFile(join(wt, 'committed.txt'), 'done\n');
  await run('git', ['add', '.'], { cwd: wt });
  await run('git', ['commit', '-m', 'a commit'], { cwd: wt });
  await writeFile(join(wt, 'dirty.txt'), 'in progress\n');

  // A detached base repo yields '' from currentBranch. Degrade to the
  // uncommitted half rather than failing the whole status response.
  assert.deepEqual(await changedPaths(wt, ''), ['dirty.txt']);
});
```

Add `changedPaths` to the `../src/worktree.ts` import at the top of the file, and confirm `readFile` is not needed but `mkdir`, `writeFile`, `rm` and `join` are imported (they are, at `test/worktree.test.ts:5-7`).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/worktree.test.ts`
Expected: FAIL — `changedPaths is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `src/worktree.ts`, immediately after `worktreeStatus`:

```ts
/**
 * Every path this session has changed relative to `base`, committed work and
 * uncommitted work together.
 *
 * The committed half is not optional: two sessions that each committed a change
 * to one file have clean worktrees and still collide at merge, which is the
 * collision most worth warning about and the one a dirty-file check misses.
 *
 * `base` is a branch name — the base repo's currently checked-out branch, which
 * is what mergeWorktrees merges into. An empty string means the base repo is on
 * a detached HEAD; the committed half is skipped rather than failing, because a
 * partial advisory signal beats none.
 */
export async function changedPaths(cwd: string, base: string): Promise<string[]> {
  const SPEC = ['--', '.', ...CONVERSATION_INPUTS];
  const [tracked, untracked, committed] = await Promise.all([
    run('git', ['diff', 'HEAD', '--name-only', '-z', ...SPEC], { cwd }),
    run('git', ['ls-files', '--others', '--exclude-standard', '-z', ...SPEC], { cwd }),
    base
      ? run('git', ['diff', '--name-only', '-z', `${base}...HEAD`, ...SPEC], { cwd })
      : Promise.resolve({ stdout: '' }),
  ]);
  const paths = new Set<string>();
  for (const out of [tracked.stdout, untracked.stdout, committed.stdout]) {
    for (const rel of out.split('\0')) if (rel) paths.add(rel);
  }
  return [...paths].sort();
}
```

`-z` throughout, so a path containing a newline cannot split into two.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/worktree.test.ts`
Expected: PASS, including every pre-existing worktree test.

- [ ] **Step 5: Commit**

```bash
git add src/worktree.ts test/worktree.test.ts
git commit -m "feat: collect a session's committed and uncommitted changed paths"
```

---

### Task 2: The cache and the overlap computation

The decision layer, with no git and no HTTP in it. Both halves are pure or near-pure, so both are testable without a repository.

The cache is doing two jobs and the second is the load-bearing one: it holds paths for cross-session lookup, *and* its timestamp is what bounds git work. `/status` is polled every four seconds per visible card (`web/app.js:442`), so without a TTL of its own a ten-session grid would spawn roughly three hundred git processes a minute.

**Files:**
- Create: `src/overlap.ts`
- Test: `test/overlap.test.ts`

**Interfaces:**
- Consumes: `changedPaths` (Task 1) — injected, not imported, so the cache can be tested without git.
- Produces:
  - `export const PATH_TTL_MS = 30_000`
  - `export const MAX_LISTED_PATHS = 10`
  - `export type PathCache = Map<string, { paths: string[]; at: number }>`
  - `export function overlaps(cache: PathCache, self: string, others: { id: string; branch: string }[]): { id: string; branch: string; files: string[] }[]`
  - `export function summarizePaths(files: string[]): string`
  - `export async function refreshPaths(cache: PathCache, id: string, collect: () => Promise<string[]>, now: number): Promise<void>`
  - `export function dropPaths(cache: PathCache, id: string): void`

- [ ] **Step 1: Write the failing test**

Create `test/overlap.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import {
  MAX_LISTED_PATHS, PATH_TTL_MS, dropPaths, overlaps, refreshPaths, summarizePaths,
  type PathCache,
} from '../src/overlap.ts';

function cache(entries: Record<string, string[]>, at = 0): PathCache {
  return new Map(Object.entries(entries).map(([id, paths]) => [id, { paths, at }]));
}

test('overlaps reports only the shared paths, and only for sessions that share one', () => {
  const c = cache({
    a: ['src/auth.ts', 'src/only-a.ts'],
    b: ['src/auth.ts', 'src/session.ts'],
    d: ['docs/readme.md'],
  });

  assert.deepEqual(
    overlaps(c, 'a', [{ id: 'b', branch: 'feat/b' }, { id: 'd', branch: 'feat/d' }]),
    [{ id: 'b', branch: 'feat/b', files: ['src/auth.ts'] }],
  );
});

test('overlaps is silent about a session whose paths are not cached yet', () => {
  const c = cache({ a: ['src/auth.ts'] });

  assert.deepEqual(overlaps(c, 'a', [{ id: 'b', branch: 'feat/b' }]), []);
});

test('overlaps returns nothing when the caller itself is uncached', () => {
  const c = cache({ b: ['src/auth.ts'] });

  assert.deepEqual(overlaps(c, 'a', [{ id: 'b', branch: 'feat/b' }]), []);
});

test('summarizePaths caps the list and says how many it dropped', () => {
  const few = ['a.ts', 'b.ts'];
  assert.equal(summarizePaths(few), 'a.ts, b.ts');

  const many = Array.from({ length: MAX_LISTED_PATHS + 3 }, (_, i) => `f${i}.ts`);
  const out = summarizePaths(many);
  assert.match(out, /and 3 more$/);
  assert.equal(out.split(',').length, MAX_LISTED_PATHS + 1, 'ten paths plus the tail');
});

test('refreshPaths collects when the entry is missing or stale, and skips when it is fresh', async () => {
  const c: PathCache = new Map();
  let calls = 0;
  const collect = async () => { calls++; return ['src/auth.ts']; };

  await refreshPaths(c, 'a', collect, 1000);
  assert.equal(calls, 1, 'a missing entry is collected');

  await refreshPaths(c, 'a', collect, 1000 + PATH_TTL_MS - 1);
  assert.equal(calls, 1, 'a fresh entry is not recollected — this is the rate limit');

  await refreshPaths(c, 'a', collect, 1000 + PATH_TTL_MS);
  assert.equal(calls, 2, 'a stale entry is recollected');
});

test('refreshPaths leaves the previous entry alone when collection fails', async () => {
  const c: PathCache = new Map();
  await refreshPaths(c, 'a', async () => ['src/auth.ts'], 0);

  await refreshPaths(c, 'a', async () => { throw new Error('worktree is gone'); }, PATH_TTL_MS);

  assert.deepEqual(
    c.get('a')?.paths, ['src/auth.ts'],
    'a failed refresh must not blank an entry other sessions are reading',
  );
});

test('dropPaths forgets one session and leaves the rest', () => {
  const c = cache({ a: ['x.ts'], b: ['y.ts'] });
  dropPaths(c, 'a');
  assert.equal(c.has('a'), false);
  assert.equal(c.has('b'), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/overlap.test.ts`
Expected: FAIL — `Cannot find module '../src/overlap.ts'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/overlap.ts`:

```ts
/**
 * How long a session's collected paths stay usable before they are recollected.
 *
 * This is the rate limit, not a freshness preference. STATUS_THROTTLE_MS is 4000
 * (web/app.js), so every visible card asks for its session's status every four
 * seconds; recollecting on each of those would mean hundreds of git processes a
 * minute on a busy grid. The cache absorbs that, and the signal is advisory
 * enough that thirty seconds of staleness costs nothing.
 */
export const PATH_TTL_MS = 30_000;

/** Sessions can overlap on a great many files; nobody reads the eleventh. */
export const MAX_LISTED_PATHS = 10;

export type PathCache = Map<string, { paths: string[]; at: number }>;

export type Overlap = { id: string; branch: string; files: string[] };

/**
 * Which of `others` have changed a path `self` has also changed.
 *
 * A session missing from the cache is reported as no overlap rather than as an
 * error: entries fill in as each session's status is polled, so early on the
 * answer is legitimately incomplete. That makes the signal asymmetric for a
 * short while — one side may see a collision the other does not yet — which is
 * acceptable for a warning and unacceptable for anything with teeth.
 */
// ponytail: a linear scan per sibling, so O(n * paths) per call and O(n^2)
// across a grid where every card polls. Fine at ten sessions with a few hundred
// paths each; if a repo ever carries dozens of live sessions, invert it into a
// path -> sessions index built once per refresh instead.
export function overlaps(
  cache: PathCache, self: string, others: { id: string; branch: string }[],
): Overlap[] {
  const mine = cache.get(self);
  if (!mine) return [];
  const own = new Set(mine.paths);
  const out: Overlap[] = [];
  for (const other of others) {
    const theirs = cache.get(other.id);
    if (!theirs) continue;
    const files = theirs.paths.filter((p) => own.has(p));
    if (files.length) out.push({ id: other.id, branch: other.branch, files });
  }
  return out;
}

/** A path list for a card tooltip or a tool result, bounded so neither grows unread. */
export function summarizePaths(files: string[]): string {
  if (files.length <= MAX_LISTED_PATHS) return files.join(', ');
  const shown = files.slice(0, MAX_LISTED_PATHS).join(', ');
  return `${shown}, and ${files.length - MAX_LISTED_PATHS} more`;
}

/**
 * Recollect one session's paths if the entry is missing or older than the TTL.
 *
 * A failed collection keeps whatever was there: a worktree removed by hand
 * should not silently blank a set other sessions are intersecting against —
 * that would read as "no overlap" rather than "unknown", which is the wrong
 * direction to fail for a warning.
 */
export async function refreshPaths(
  cache: PathCache, id: string, collect: () => Promise<string[]>, now: number,
): Promise<void> {
  const entry = cache.get(id);
  if (entry && now - entry.at < PATH_TTL_MS) return;
  try {
    cache.set(id, { paths: await collect(), at: now });
  } catch {
    // Keep the stale entry. dropPaths is the deliberate forget.
  }
}

/** Called when a session goes away: paths for a deleted session are a lie. */
export function dropPaths(cache: PathCache, id: string): void {
  cache.delete(id);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/overlap.test.ts`
Expected: PASS, all seven tests.

- [ ] **Step 5: Commit**

```bash
git add src/overlap.ts test/overlap.test.ts
git commit -m "feat: cache session paths with a TTL and intersect them"
```

---

### Task 3: Serve both couplings from `/status`

Wire the cache into the server and extend the response the card already fetches. This is also where the second coupling — an open relay channel — is answered, which needs no git at all.

`/status` already costs four git invocations (`worktreeStatus` runs `branch --show-current`, `diff HEAD --numstat`, `status --porcelain` and `ls-files --others`), and the card poll is throttled as a batch to once per four seconds with every visible card then fetching (`web/app.js:475`). A ten-session grid is therefore already around 600 git invocations a minute before this feature adds anything.

Against that baseline this task adds three invocations per session per TTL window — about 60 a minute at ten sessions — provided `currentBranch` is resolved inside the refresh closure rather than before it. Resolved outside, it runs on every poll regardless of freshness and asks the same question once per session, which would be 150 a minute to learn one repo's branch name. The code below has it inside; that placement is the point.

**Files:**
- Modify: `src/server.ts` (imports; a cache beside `channels` at line 470; the `/status` route at line 1392; the `delete` case's cleanup)
- Test: `test/server.test.ts`

**Interfaces:**
- Consumes: `changedPaths` (Task 1); `PathCache`, `overlaps`, `refreshPaths`, `dropPaths` (Task 2); `channelOpen` and `channelKey` from `src/relay.ts`, already imported.
- Produces: `/status?id=<session>` returns `{ branch, added, removed, dirty, talking: { id, branch }[], overlapping: { id, branch, files: string[] }[] }`. The four existing fields are unchanged, so existing consumers keep working.

- [ ] **Step 1: Write the failing test**

Add to `test/server.test.ts`:

```ts
test('/status reports overlapping sessions on the same repo and ignores other repos', async (t) => {
  const repo = await makeRepo();
  const other = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  t.after(() => rm(other, { recursive: true, force: true }));
  const { adapter } = fakeAdapter();
  const { base, registry } = await boot(t, adapter);

  const post = (body: Record<string, unknown>) => fetch(new URL('/command', base), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then((r) => r.json());
  const status = (id: string) => fetch(new URL(`/status?id=${id}`, base)).then((r) => r.json());

  const a = await post({ cmd: 'create', repo, branch: 'feat/a', account: 'claude-main', prompt: 'go' });
  const b = await post({ cmd: 'create', repo, branch: 'feat/b', account: 'claude-main', prompt: 'go' });
  await post({ cmd: 'create', repo: other, branch: 'feat/elsewhere', account: 'claude-main', prompt: 'go' });

  // Both touch one shared file; each also touches one of its own.
  await writeFile(join(registry.get(a.id)!.cwd, 'shared.ts'), 'a\n');
  await writeFile(join(registry.get(a.id)!.cwd, 'only-a.ts'), 'a\n');
  await writeFile(join(registry.get(b.id)!.cwd, 'shared.ts'), 'b\n');

  // Prime the cache for both, then read A: overlap is computed against what is
  // cached, so B must have been collected before A can see it.
  await status(b.id);
  const seen = await status(a.id);

  assert.deepEqual(
    seen.overlapping,
    [{ id: b.id, branch: 'feat/b', files: ['shared.ts'] }],
    'same repo and shared path only',
  );
  assert.equal(seen.added !== undefined && seen.dirty !== undefined, true, 'existing fields survive');
});

test('/status reports an open relay channel as talking', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const { adapter, starts } = fakeAdapter();
  const { base } = await boot(t, adapter);

  const post = (body: Record<string, unknown>) => fetch(new URL('/command', base), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then((r) => r.json());
  const status = (id: string) => fetch(new URL(`/status?id=${id}`, base)).then((r) => r.json());

  const a = await post({ cmd: 'create', repo, branch: 'feat/a', account: 'claude-main', prompt: 'go' });
  const b = await post({ cmd: 'create', repo, branch: 'feat/b', account: 'claude-main', prompt: 'go' });

  assert.deepEqual((await status(a.id)).talking, [], 'no channel yet');

  starts[0].relay!(b.id, 'ping');

  assert.deepEqual(
    (await status(a.id)).talking, [{ id: b.id, branch: 'feat/b' }],
    'a successful relay opens the channel, which both ends can see',
  );
  assert.deepEqual(
    (await status(b.id)).talking, [{ id: a.id, branch: 'feat/a' }],
    'the channel is a pair, so it reads the same from either side',
  );
});

test('deleting a session drops its cached paths', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const { adapter } = fakeAdapter();
  const { base, registry } = await boot(t, adapter);

  const post = (body: Record<string, unknown>) => fetch(new URL('/command', base), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then((r) => r.json());
  const status = (id: string) => fetch(new URL(`/status?id=${id}`, base)).then((r) => r.json());

  const a = await post({ cmd: 'create', repo, branch: 'feat/a', account: 'claude-main', prompt: 'go' });
  const b = await post({ cmd: 'create', repo, branch: 'feat/b', account: 'claude-main', prompt: 'go' });
  await writeFile(join(registry.get(a.id)!.cwd, 'shared.ts'), 'a\n');
  await writeFile(join(registry.get(b.id)!.cwd, 'shared.ts'), 'b\n');
  await status(b.id);
  assert.equal((await status(a.id)).overlapping.length, 1, 'overlap is visible before the delete');

  await post({ cmd: 'delete', id: b.id });

  assert.deepEqual(
    (await status(a.id)).overlapping, [],
    'a deleted session leaves no paths behind to overlap with',
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/server.test.ts`
Expected: FAIL — `seen.overlapping` is `undefined`, so `assert.deepEqual` fails on the first test.

- [ ] **Step 3: Write minimal implementation**

Extend the imports in `src/server.ts`:

```ts
import { changedPaths, commitGraph, createWorktree, worktreeDiff, worktreeStatus } from './worktree.ts';
import { commitOutstanding, currentBranch, mergeWorktrees, pushRepo } from './merge.ts';
import { dropPaths, overlaps, refreshPaths, type PathCache } from './overlap.ts';
```

`src/server.ts:13` currently reads `import { commitOutstanding, mergeWorktrees, pushRepo } from './merge.ts';` — add `currentBranch` to that existing line rather than writing a second import from the same module.

Declare the cache beside `channels` (`src/server.ts:470`):

```ts
  // Paths each session has changed, with the time they were collected. Process-
  // local like the channel maps, and for the same reason — this describes live
  // worktrees, and Registry.load forces every session to `stopped` on start.
  const paths: PathCache = new Map();
```

Replace the `/status` route body (`src/server.ts:1392-1398`):

```ts
      if (url.pathname === '/status') {
        const id = url.searchParams.get('id') ?? '';
        const session = registry.get(id);
        if (!session) { res.writeHead(404).end('{}'); return; }
        const status = await worktreeStatus(session.cwd).catch(() => null);
        // Collected here rather than on a timer of its own: this route is
        // already polled per card, and refreshPaths' TTL is what stops a
        // four-second poll from spawning git on every call.
        //
        // currentBranch resolves INSIDE the closure, not before it. Outside, it
        // would run on every poll even when the paths are fresh — and it is the
        // same answer for every session in the repo, so a ten-session grid would
        // ask it 150 times a minute to learn one thing. Inside, it rides the TTL
        // that is already there and costs nothing when nothing is stale.
        await refreshPaths(paths, id, async () => changedPaths(
          session.cwd, await currentBranch(session.repo).catch(() => ''),
        ), Date.now());
        const siblings = registry.all()
          .filter((s) => s.id !== id && s.repo === session.repo)
          .map((s) => ({ id: s.id, branch: s.branch }));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(status && {
          ...status,
          talking: siblings.filter((s) => channelOpen(channels, id, s.id)),
          overlapping: overlaps(paths, id, siblings),
        }));
        return;
      }
```

`status` stays possibly-null exactly as before, so a missing worktree still serializes to `null` and the card skips.

In the `delete` case, beside the existing `dropChannels`/`dropSeen` calls:

```ts
        dropPaths(paths, String(body.id));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/server.test.ts`
Expected: PASS, including every pre-existing server test.

- [ ] **Step 5: Run the full suite and commit**

```bash
npm test
git add src/server.ts test/server.test.ts
git commit -m "feat: serve overlapping and talking sessions from /status"
```

---

### Task 4: Tell the agents

The agent-facing half. `list_sessions` gains the overlap, and the tool's instructions gain the line that gives an agent a reason to call it — which is the entire mechanism for making an agent aware, and deliberately the cheapest one available.

`relaySessions` becomes async so it can refresh a stale entry rather than reporting no overlap when the browser has not polled recently. Its only caller is an already-async tool handler.

Be aware what that costs: `changedPaths` is three git invocations, so a repo with five sessions is sixteen subprocess spawns on a single `list_sessions` call. The refresh runs in parallel for that reason. The cost is also bursty rather than constant — with the grid open most entries are fresh and the refresh is a no-op, while an agent working unattended finds everything stale and pays full price. That is the right shape (the cost lands exactly when the cached answer would otherwise be wrong), but it is not uniform.

**Files:**
- Modify: `src/types.ts` (`RelaySession` gains a field; `StartOpts.relaySessions` returns a promise)
- Modify: `src/server.ts` (the `relaySessions` closure at line 579)
- Modify: `src/agents/relay-tools.ts` (the `instructions` string at line 27; the `list_sessions` handler)
- Test: `test/server.test.ts`

**Interfaces:**
- Consumes: `overlaps`, `refreshPaths`, `summarizePaths`, `PATH_TTL_MS` (Task 2); `changedPaths` (Task 1); the `paths` cache (Task 3).
- Produces: `RelaySession` gains `files: string[]` — the paths this session shares with the caller, empty when none. `StartOpts.relaySessions?: () => Promise<RelaySession[]>`.

- [ ] **Step 1: Write the failing test**

Add to `test/server.test.ts`:

```ts
test('relaySessions annotates each sibling with the paths it shares with the caller', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const { adapter, starts } = fakeAdapter();
  const { base, registry } = await boot(t, adapter);

  const post = (body: Record<string, unknown>) => fetch(new URL('/command', base), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then((r) => r.json());

  const a = await post({ cmd: 'create', repo, branch: 'feat/a', account: 'claude-main', prompt: 'go' });
  const b = await post({ cmd: 'create', repo, branch: 'feat/b', account: 'claude-main', prompt: 'go' });
  await post({ cmd: 'create', repo, branch: 'feat/c', account: 'claude-main', prompt: 'go' });

  await writeFile(join(registry.get(a.id)!.cwd, 'shared.ts'), 'a\n');
  await writeFile(join(registry.get(b.id)!.cwd, 'shared.ts'), 'b\n');

  // No /status has run, so nothing is cached — the tool must collect for itself
  // rather than quietly reporting no overlap.
  const listed = await starts[0].relaySessions!();

  const byBranch = Object.fromEntries(listed.map((s) => [s.branch, s.files]));
  assert.deepEqual(byBranch['feat/b'], ['shared.ts']);
  assert.deepEqual(byBranch['feat/c'], [], 'a sibling with no shared path reports none');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/server.test.ts`
Expected: FAIL — `byBranch['feat/b']` is `undefined`, because `RelaySession` has no `files`.

- [ ] **Step 3: Write minimal implementation**

In `src/types.ts`, extend `RelaySession` and make the callback async:

```ts
/** One row of what a session may message: same repo, never itself. */
export type RelaySession = {
  id: string; branch: string; account: string; status: Status;
  /** Paths this session has also changed, from the caller's point of view. */
  files: string[];
};
```

```ts
  /** The sessions this one may message: same repo, excluding itself. */
  relaySessions?: () => Promise<RelaySession[]>;
```

Replace the `relaySessions` closure in `src/server.ts:579`:

```ts
        relaySessions: async () => {
          // `session` is read once at launch; without it there is no repo to scope
          // by and currentBranch would run against the server's own cwd.
          if (!session) return [];
          const siblings = registry.all().filter((s) => s.id !== sessionId && s.repo === session.repo);
          // Agents call this rarely, and a tool that reports no overlap because
          // nobody happened to open the card is a tool that quietly lies. Refresh
          // anything stale — refreshPaths skips whatever is already fresh.
          const base = await currentBranch(session.repo).catch(() => '');
          const now = Date.now();
          // In parallel, not a sequential loop: each refreshPaths is three git
          // invocations, so N sessions serialized is N round trips the agent
          // waits through for no benefit. refreshPaths is per-key and never
          // throws, so concurrent calls cannot interfere.
          await Promise.all(
            [...siblings, session].map((s) => refreshPaths(paths, s.id, () => changedPaths(s.cwd, base), now)),
          );
          const shared = new Map(
            overlaps(paths, sessionId, siblings.map((s) => ({ id: s.id, branch: s.branch })))
              .map((o) => [o.id, o.files]),
          );
          return siblings.map((s) => ({
            id: s.id, branch: s.branch, account: s.account, status: s.status,
            files: shared.get(s.id) ?? [],
          }));
        },
```

In `src/agents/relay-tools.ts`, extend the instructions (line 27) — this is the whole make-the-agent-aware mechanism:

```ts
    instructions:
      'Other agent sessions working on this same repository, on their own git '
      + 'branches. Use this to coordinate — to say what you are changing, to ask '
      + 'what another session has already done, or to answer when one asks you. '
      + 'Sessions here may be editing the same files you are; list_sessions says '
      + 'which, so check before making a large change to a shared file.',
```

and render the overlap in the `list_sessions` handler:

```ts
              text: rows
                .map((s) => {
                  const head = `${s.branch} — ${s.status}, on account ${s.account} (id ${s.id})`;
                  return s.files.length
                    ? `${head} — also changed ${summarizePaths(s.files)}`
                    : head;
                })
                .join('\n'),
```

with `import { summarizePaths } from '../overlap.ts';` at the top.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/server.test.ts && node --test test/agents-claude.test.ts`
Expected: PASS both.

- [ ] **Step 5: Run the full suite and commit**

```bash
npm test
git add src/types.ts src/server.ts src/agents/relay-tools.ts test/server.test.ts
git commit -m "feat: tell agents which sessions share their files"
```

---

### Task 5: Show both couplings on the card

The human-facing half. Two `/status` consumers read the response, and both must keep working.

The decision — which badge a pair earns — is a pure function in `web/lib.js`, tested there, because `test/ui.test.ts` never loads `web/app.js` as code (see the comment at its line 20). The DOM half is the rendering only.

The sidebar has **three** touch points, not one. `sidebarDiffText` is a cached string re-applied on every render, so a tooltip set only inside the poll would outlive the session it describes.

**Files:**
- Modify: `web/lib.js` (a new export beside `handoffTargets`)
- Modify: `web/app.js` — its `lib.js` import block; the card's `/status` handler at line 924; and all three sidebar sites: the `sidebarDiffText` declaration at line 454, `pollSidebarDiff` at line 456, the switch-reset at line 1066, and the re-render at line 1145
- Test: `test/ui.test.ts`

**Interfaces:**
- Consumes: the `/status` response shape from Task 3.
- Produces: `export function couplingBadges(status)` → `{ text: string, title: string }`, where `text` is what follows the existing `+N −M · dirty` and `title` is the tooltip. Both are `''` when there is nothing to show.

- [ ] **Step 1: Write the failing test**

Add `couplingBadges` to the `web/lib.js` import block at the top of `test/ui.test.ts`, then add:

```ts
test('couplingBadges shows a talking pair as talking, not as a collision', () => {
  const badges = couplingBadges({
    talking: [{ id: 'b', branch: 'feat/b' }],
    overlapping: [{ id: 'b', branch: 'feat/b', files: ['src/auth.ts'] }],
  });

  assert.match(badges.text, /↔ feat\/b/);
  assert.doesNotMatch(badges.text, /⚠/, 'a pair that is talking has already coordinated');
});

test('couplingBadges flags overlap only when the pair is not talking', () => {
  const badges = couplingBadges({
    talking: [],
    overlapping: [{ id: 'b', branch: 'feat/b', files: ['src/auth.ts', 'src/session.ts'] }],
  });

  assert.match(badges.text, /⚠ 2 files also in feat\/b/);
  assert.match(badges.title, /src\/auth\.ts/);
  assert.match(badges.title, /src\/session\.ts/);
});

test('couplingBadges reports each pair on its own terms', () => {
  const badges = couplingBadges({
    talking: [{ id: 'a', branch: 'feat/a' }],
    overlapping: [{ id: 'b', branch: 'feat/b', files: ['src/auth.ts'] }],
  });

  assert.match(badges.text, /↔ feat\/a/);
  assert.match(badges.text, /⚠ 1 file also in feat\/b/);
});

test('couplingBadges is empty when there is nothing to say', () => {
  assert.deepEqual(couplingBadges({ talking: [], overlapping: [] }), { text: '', title: '' });
  assert.deepEqual(couplingBadges(null), { text: '', title: '' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/ui.test.ts`
Expected: FAIL — `couplingBadges is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `web/lib.js`, after `handoffTargets`:

```js
/**
 * The coupling badges for one session's /status response: `text` follows the
 * existing `+N −M · dirty`, `title` is the tooltip.
 *
 * Talking wins over overlapping for a given pair. Two sessions editing one file
 * and talking about it is coordination working; the same two in silence is a
 * merge conflict that has not happened yet, and only the second is worth a
 * warning. Flagging both would cry wolf on the healthy case.
 *
 * Advisory throughout: "also in", never "locked by". Nothing here prevents
 * anything, and wording that implies otherwise would be a lie.
 */
export function couplingBadges(status) {
  const talking = status?.talking ?? [];
  const overlapping = status?.overlapping ?? [];
  const talkingIds = new Set(talking.map((t) => t.id));
  const silent = overlapping.filter((o) => !talkingIds.has(o.id));

  const parts = [
    ...talking.map((t) => `↔ ${t.branch}`),
    ...silent.map((o) => `⚠ ${o.files.length} file${o.files.length === 1 ? '' : 's'} also in ${o.branch}`),
  ];
  const title = silent
    .map((o) => `${o.branch}: ${o.files.join(', ')}`)
    .join('\n');
  return { text: parts.join(' · '), title };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/ui.test.ts`
Expected: PASS — the four new tests, plus the pre-existing export-wiring test now covering `couplingBadges`.

- [ ] **Step 5: Render it in both consumers**

Add `couplingBadges` to the `lib.js` import block in `web/app.js`.

In the card's `/status` handler (`web/app.js:924`), append the badges and set the tooltip:

```js
    fetch(`/status?id=${s.id}`).then((r) => r.json()).then((data) => {
      if (!data) return;
      const live = document.querySelector(`.card[data-id="${s.id}"] > .wt`);
      if (!live) return;
      const badges = couplingBadges(data);
      live.textContent = `+${data.added} −${data.removed} · ${data.dirty ? 'dirty' : 'clean'}`
        + (badges.text ? ` · ${badges.text}` : '');
      if (badges.title) live.title = badges.title;
      else live.removeAttribute('title');
    }).catch(() => {});
```

The sidebar needs all three of its sites changed together, because the poll is not the only thing that writes that element.

Declare a cached title beside the cached text (`web/app.js:454`):

```js
let sidebarDiffText = '';
// Cached beside the text and restored with it: #sidebar-diffstat is rewritten on
// every render (see below), so a title set only by the poll would outlive the
// session it describes and hang the previous session's file list on the next one.
let sidebarDiffTitle = '';
```

In `pollSidebarDiff` (`web/app.js:456`), set both:

```js
    const badges = d ? couplingBadges(d) : { text: '', title: '' };
    sidebarDiffText = d
      ? `+${d.added} −${d.removed} · ${d.dirty ? 'dirty' : 'clean'}${badges.text ? ` · ${badges.text}` : ''}`
      : '';
    sidebarDiffTitle = badges.title;
    applySidebarDiff(sidebarDiffText, sidebarDiffTitle);
```

In the switch-reset (`web/app.js:1066`), clear it alongside the text:

```js
    sidebarDiffFor = null; sidebarDiffText = ''; sidebarDiffTitle = '';
    diffOpen.clear(); lastDiffText = '';
```

And at the re-render (`web/app.js:1145`), restore or clear both — this is the site that would otherwise leave a stale tooltip on a session it does not belong to:

```js
  const mine = sidebarDiffFor === s.id;
  applySidebarDiff(mine ? sidebarDiffText : '', mine ? sidebarDiffTitle : '');
```

with one small helper so the three sites cannot drift:

```js
/** The element is written from three places; keeping them in one function is
 *  what stops a title outliving the text it belongs to. */
function applySidebarDiff(text, title) {
  const el = $('#sidebar-diffstat');
  el.textContent = text;
  if (title) el.title = title;
  else el.removeAttribute('title');
}
```

Neither renderer may throw when `talking`/`overlapping` are absent — `couplingBadges` already returns empties for that, which is what the fourth test pins.

There is no test for this step. `test/ui.test.ts` never loads `app.js`, so reading is the verification. Check specifically: the card's selector still matches the element it did before; both renderers clear `title` rather than leaving a stale one; `applySidebarDiff` is used at all three sidebar sites and none writes the element directly; and switching sessions leaves neither the text nor the tooltip of the session you left.

- [ ] **Step 6: Run the full suite and commit**

```bash
npm test
git add web/lib.js web/app.js test/ui.test.ts
git commit -m "feat: show talking and overlapping sessions on the card"
```

---

### Task 6: Document the feature

**Files:**
- Modify: `README.md`, `AGENTS.md`

- [ ] **Step 1: Add the README section**

Add after the relay section (which ends with the paragraph beginning "Typing `@` in the composer"):

```markdown
Sessions on one repository are also checked against each other for overlapping
work. A session's card shows `↔ feat/other` when the two have an open relay
channel, and `⚠ 3 files also in feat/other` when they have changed the same
files without one — the second is the one worth looking at, because it is a
merge conflict that has not happened yet. Hovering names the files. `list_sessions`
carries the same information to the agents, so one can see who is in the file it
is about to change and message just that session rather than all of them.

Overlap counts committed work as well as uncommitted: two sessions that each
committed a change to the same file have clean worktrees and still collide.
Pasted uploads and handoff documents are excluded, the same way they are
excluded from the outstanding-work commit.

It is advisory and nothing more. It never blocks a merge, never refuses an edit,
and never claims a file — it is "also changed in", not "locked by". The paths are
recollected at most every thirty seconds per session, so a badge can lag a change
by that much, and can briefly show on one side of a pair before the other.
```

- [ ] **Step 2: Add the AGENTS.md lines**

Under "Code ownership":

```
- `src/overlap.ts` owns the changed-path cache and the overlap computation.
```

Under "Safety boundaries":

```
- Overlap is advisory. It must never gate a merge, an edit, or a relay, and UI
  copy must say "also changed in" rather than anything implying a lock.
- The path cache is process-local and carries its own TTL. That TTL is a rate
  limit, not a freshness preference: `/status` is polled every four seconds per
  visible card, and collecting on each call would spawn git hundreds of times a
  minute.
- Path collection applies `CONVERSATION_INPUTS`. Without it a pasted upload
  registers as overlapping work.
```

- [ ] **Step 3: Verify nothing contradicts**

Run: `grep -n "advisory\|locked\|overlap" README.md AGENTS.md`
Expected: no statement claiming overlap prevents anything.

- [ ] **Step 4: Commit**

```bash
git add README.md AGENTS.md
git commit -m "docs: describe overlap detection"
```

---

## Deferred

Named in the spec's Out of Scope and deliberately not built here: anything with teeth (claims, leases, gating a merge); edit-time notification through a `canUseTool` denial; region-level granularity; and injecting a note into an agent's turn when overlap appears.
