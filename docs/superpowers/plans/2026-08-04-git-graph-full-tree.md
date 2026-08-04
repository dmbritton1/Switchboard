# Git Graph Full Tree Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Graph pane show every branch in the repository, with the selected session's branch visually distinct and any branch traceable on hover.

**Architecture:** `commitGraph` today spends one global `-400` commit budget newest-first, so trunk history starves every older branch out of the result entirely. It becomes two bounded `git log` calls — everything off-trunk, plus a bounded slice of trunk — concatenated without a re-sort, because the two sets are disjoint and no trunk commit can have an off-trunk parent. Each commit carries a `tier` (`own` / `trunk` / `other`) decided server-side; the browser styles by tier and attributes commits to branches with a pure function for hover-tracing.

**Tech Stack:** Node 22.18+, TypeScript run directly by Node (no build step), `node:test`, vanilla ES modules in `web/`, plain CSS.

## Global Constraints

- Node 22.18 or newer. Run `npm install`, and copy `accounts.example.json` to `accounts.json` before starting the app.
- `npm test` must pass before completion. While iterating, run the focused `node --test` command first.
- `src/server.ts` owns HTTP commands; `web/` renders browser state; `test/` covers those boundaries offline. Respect those ownership lines.
- Tests must stay offline: no paid, networked, or real-account tests in `npm test`. Use temporary directories and local git repositories only.
- The `/graph` handler must keep deriving both paths from the registered session, never from a client parameter. This is what stops `git log` being pointed at an arbitrary directory.
- `assignLanes` (`src/worktree.ts:52`) must not be modified. Its existing tests are the guard that lane layout was not disturbed.
- Design spec: `docs/superpowers/specs/2026-08-04-git-graph-full-tree-design.md`.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/merge.ts` | Merge/push; owns the definition of trunk | Export `currentBranch` (currently private, line 45) |
| `src/worktree.ts` | Git reads for the graph | `commitGraph` splits its budget and tiers commits; `GraphCommit` gains `tier` |
| `src/server.ts` | HTTP | `/graph` passes `session.repo` (line 848) |
| `web/lib.js` | Pure browser logic | New `attributeBranches(commits)` |
| `web/app.js` | DOM rendering | `drawGraph` / `refPill` / `renderGraphPane` style by tier; hover-to-trace |
| `web/style.css` | Styling | Three tier rules replace `.lane0`–`.lane5` (line 199) |
| `test/worktree.test.ts` | Backend coverage | Starvation, tiers, detached-HEAD fallback |
| `test/ui.test.ts` | Pure browser logic coverage | `attributeBranches` cases |

The `web/lib.js` (logic) / `web/app.js` (DOM) split is the codebase's existing pattern and is what makes the attribution function testable — `test/ui.test.ts` imports from `web/lib.js`. Do not put `attributeBranches` in `web/app.js`.

---

### Task 1: Split the commit budget and tier commits

The whole feature is invisible until the server sends tiered, unstarved data, so the `/graph` wiring is folded in here rather than split off.

**Files:**
- Modify: `src/merge.ts:45` (export `currentBranch`)
- Modify: `src/worktree.ts:31-34` (`GraphCommit`), `src/worktree.ts:69-84` (`commitGraph`)
- Modify: `src/server.ts:848`
- Test: `test/worktree.test.ts`

**Interfaces:**
- Consumes: `assignLanes` from `src/worktree.ts` (unchanged).
- Produces:
  - `export async function currentBranch(cwd: string): Promise<string>` — empty string on detached HEAD.
  - `export type Tier = 'own' | 'trunk' | 'other'`
  - `GraphCommit` gains `tier: Tier`.
  - `export async function commitGraph(cwd: string, repo?: string, limit?: number): Promise<GraphCommit[]>` — `repo` defaults to `cwd`, `limit` defaults to `400`. Note the new second parameter: any caller passing a positional limit must be updated.

- [ ] **Step 1: Write the failing tests**

Add to `test/worktree.test.ts`. The existing imports at the top of that file already cover `mkdtemp`, `writeFile`, `rm`, `join`, `tmpdir`, and `run`; add `currentBranch` is NOT needed here.

Add this helper below the existing `makeRepo` (near line 21). Two details are load-bearing, and both were arrived at by breaking them first:

- **Explicit commit dates.** Without them every commit in a test shares a timestamp and git's ordering becomes unstable, making the starvation assertion flaky.
- **The clock starts at the real current time**, not a fixed epoch. `makeRepo`'s `init` commit is dated by the real clock, so a hard-coded 2020 start would make the root commit the *newest* by date while remaining the oldest topologically — exactly the ordering confusion these tests exist to pin down.

```ts
// Starts from now so every commit here is dated after makeRepo's `init`.
let testClock = Math.floor(Date.now() / 1000);
async function commitAt(cwd: string, msg: string): Promise<void> {
  testClock += 60;
  const d = `${testClock} +0000`;
  await writeFile(join(cwd, `f${testClock}.txt`), msg);
  await run('git', ['add', '.'], { cwd });
  await run('git', ['commit', '-m', msg], {
    cwd, env: { ...process.env, GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d },
  });
}
```

Then the tests:

```ts
test('commitGraph keeps a stale branch that trunk history would starve out', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  // A branch forked early and then left alone, then trunk marches past the limit.
  const wt = await createWorktree(repo, 'stale');
  await commitAt(wt, 'stale work');
  for (let i = 0; i < 10; i++) await commitAt(repo, `main ${i}`);

  const graph = await commitGraph(wt, repo, 5);

  // The whole bug: with one global budget this branch vanished, ref and all.
  assert.ok(graph.some((c) => c.refs.includes('HEAD -> stale')), 'stale branch survives the limit');
  assert.equal(graph.find((c) => c.subject === 'stale work')?.tier, 'own');
  assert.ok(graph.some((c) => c.tier === 'trunk'), 'trunk history is still included');
});

test('commitGraph returns commits in topological order across the two calls', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const wt = await createWorktree(repo, 'side');
  await commitAt(wt, 'side work');
  for (let i = 0; i < 4; i++) await commitAt(repo, `main ${i}`);

  const graph = await commitGraph(wt, repo, 50);

  // assignLanes depends on this, so the concatenation must preserve it:
  // every parent present in the window appears after its child.
  const idx = new Map(graph.map((c, i) => [c.h, i]));
  for (const [i, c] of graph.entries()) {
    for (const ph of c.p) {
      if (idx.has(ph)) assert.ok(idx.get(ph)! > i, `parent ${ph} must follow child ${c.h}`);
    }
  }
});

test('commitGraph tiers another session branch as other', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const mine = await createWorktree(repo, 'mine');
  const theirs = await createWorktree(repo, 'theirs');
  await commitAt(mine, 'my work');
  await commitAt(theirs, 'their work');

  const graph = await commitGraph(mine, repo, 50);

  assert.equal(graph.find((c) => c.subject === 'my work')?.tier, 'own');
  assert.equal(graph.find((c) => c.subject === 'their work')?.tier, 'other');
  assert.equal(graph.find((c) => c.subject === 'init')?.tier, 'trunk');
});

test('commitGraph falls back to a single walk when the base repo is detached', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  await commitAt(repo, 'second');
  const { stdout } = await run('git', ['rev-parse', 'HEAD'], { cwd: repo });
  await run('git', ['checkout', '--detach', stdout.trim()], { cwd: repo });

  const graph = await commitGraph(repo, repo, 50);

  assert.ok(graph.length >= 2, 'still returns commits rather than throwing');
  assert.ok(graph.every((c) => c.tier === 'other'), 'no trunk to split on, so nothing is tiered');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
node --test test/worktree.test.ts
```

Expected: FAIL. The starvation and tier tests fail on `tier` being `undefined`; `commitGraph(wt, repo, 5)` currently reads `repo` as the `limit` argument.

- [ ] **Step 3: Export `currentBranch` from `src/merge.ts`**

Change line 45 from `async function currentBranch` to:

```ts
export async function currentBranch(cwd: string): Promise<string> {
  const { stdout } = await run('git', ['branch', '--show-current'], { cwd });
  return stdout.trim();
}
```

Nothing else in `src/merge.ts` changes — `mergeWorktrees` keeps calling it exactly as it does at line 72.

- [ ] **Step 4: Rewrite `commitGraph` in `src/worktree.ts`**

Add the import at the top of the file:

```ts
import { currentBranch } from './merge.ts';
```

This introduces no import cycle: `src/merge.ts` imports only node builtins.

Replace the `GraphCommit` type (lines 31-34) with:

```ts
/**
 * Which line of history a commit belongs to, for styling. Decided here rather
 * than in the browser because it is a reachability question and git already
 * knows the answer.
 */
export type Tier = 'own' | 'trunk' | 'other';

export type GraphCommit = {
  h: string; p: string[]; subject: string; author: string; when: string;
  refs: string[]; lane: number; row: number; tier: Tier;
};
```

Replace `commitGraph` (lines 65-84) with:

```ts
const GRAPH_FORMAT = '--format=%H%x00%P%x00%s%x00%an%x00%ar%x00%D';

function parseLog(stdout: string, tier: Tier) {
  return stdout.split('\n').filter(Boolean).map((line) => {
    const [h, p, subject, author, when, refs] = line.split('\0');
    return {
      h, subject, author, when, tier,
      p: p ? p.split(' ') : [],
      refs: refs.split(',').map((r) => r.trim()).filter(Boolean),
    };
  });
}

/**
 * Commits across every branch, laid out for drawing.
 *
 * `--all` with a single `-limit` looks like it reads the whole repo but does
 * not: the budget is global and spent newest-first, so trunk history eats it
 * and any branch whose tip is older than that window is dropped entirely,
 * ref and all. Instead the budget is split — everything off-trunk, plus a
 * bounded slice of trunk — so no branch can be starved by trunk's activity.
 *
 * The two results are concatenated and deliberately NOT re-sorted. They are
 * disjoint (one set is defined as unreachable from trunk, the other only as
 * reachable from it), and no trunk commit can have an off-trunk parent, or
 * that parent would be reachable from trunk. So every parent still follows
 * its child and assignLanes' topological requirement holds.
 *
 * Trunk is the base repo's checked-out branch — the same branch mergeWorktrees
 * merges into — so the graph's spine and the merge target cannot drift apart.
 */
export async function commitGraph(
  cwd: string, repo: string = cwd, limit = 400,
): Promise<GraphCommit[]> {
  const trunk = await currentBranch(repo).catch(() => '');
  // Detached HEAD: there is no trunk to split on, so fall back to one walk.
  if (!trunk) {
    const { stdout } = await run(
      'git', ['log', '--all', '--topo-order', `-${limit}`, GRAPH_FORMAT], { cwd },
    );
    return assignLanes(parseLog(stdout, 'other'));
  }

  const [off, spine, own] = await Promise.all([
    run('git', ['log', '--all', '--not', trunk, '--topo-order', `-${limit}`, GRAPH_FORMAT], { cwd }),
    run('git', ['log', trunk, '--topo-order', `-${limit}`, GRAPH_FORMAT], { cwd }),
    // Commits unique to this session's branch: the boundary is the fork point,
    // so the highlight covers the work done here, not the inherited ancestry.
    // An unborn HEAD has none, which is a legitimate empty answer, not an error.
    run('git', ['rev-list', 'HEAD', '--not', trunk], { cwd }).catch(() => ({ stdout: '' })),
  ]);

  const mine = new Set(own.stdout.split('\n').filter(Boolean));
  const commits = [...parseLog(off.stdout, 'other'), ...parseLog(spine.stdout, 'trunk')];
  for (const c of commits) if (mine.has(c.h)) c.tier = 'own';
  return assignLanes(commits);
}
```

- [ ] **Step 5: Pass the base repo from the `/graph` handler**

In `src/server.ts`, change line 848 from `commitGraph(session.cwd)` to:

```ts
        const commits = await commitGraph(session.cwd, session.repo).catch(() => []);
```

The comment above the handler about keying by session id still holds and stays as is — `session.repo` is registry state, not a client parameter.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
node --test test/worktree.test.ts
```

Expected: PASS, including the pre-existing `assignLanes` and `commitGraph reports refs and parents for a real merge` tests.

- [ ] **Step 7: Run the full suite**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/merge.ts src/worktree.ts src/server.ts test/worktree.test.ts
git commit -m "fix: give each branch its own commit budget in the graph"
```

---

### Task 2: Attribute commits to branches

**Files:**
- Modify: `web/lib.js` (append)
- Test: `test/ui.test.ts`

**Interfaces:**
- Consumes: commit objects as returned by `commitGraph` — `{ h, p, refs, tier }` is all this function reads.
- Produces: `export function attributeBranches(commits)` returning a `Map<string, string>` from commit hash to branch name. Commits on trunk, and commits reachable from no branch tip, are absent from the map.

- [ ] **Step 1: Write the failing test**

Add to `test/ui.test.ts`. Add `attributeBranches` to the existing import list from `../web/lib.js` at the top of the file.

```ts
const gc = (h, p, tier, refs = []) => ({ h, p, tier, refs });

test('attributeBranches walks each tip back to the trunk fork point', () => {
  const owner = attributeBranches([
    gc('f1', ['f0'], 'own', ['HEAD -> feat']),
    gc('f0', ['t9'], 'own', []),
    gc('b1', ['t9'], 'other', ['bugfix', 'tag: v1']),
    gc('t9', ['t8'], 'trunk', ['main']),
    gc('t8', [], 'trunk', []),
  ]);

  assert.equal(owner.get('f1'), 'feat');
  assert.equal(owner.get('f0'), 'feat', 'attribution continues past the tip');
  assert.equal(owner.get('b1'), 'bugfix', 'a tag is not a branch name');
  assert.equal(owner.get('t9'), undefined, 'the walk stops at trunk');
  assert.equal(owner.get('t8'), undefined);
});

test('attributeBranches gives a shared commit to the first tip that claims it', () => {
  const owner = attributeBranches([
    gc('a', ['s'], 'own', ['HEAD -> a-branch']),
    gc('b', ['s'], 'other', ['b-branch']),
    gc('s', [], 'other', []),
  ]);

  assert.equal(owner.get('a'), 'a-branch');
  assert.equal(owner.get('b'), 'b-branch');
  assert.equal(owner.get('s'), 'a-branch', 'claimed once, by the branch listed first');
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node --test test/ui.test.ts
```

Expected: FAIL with a SyntaxError about `attributeBranches` not being exported by `../web/lib.js`.

- [ ] **Step 3: Implement `attributeBranches` in `web/lib.js`**

Append to `web/lib.js`:

```js
/**
 * Maps each commit to the branch whose line it sits on, for hover-tracing.
 *
 * git only reports a ref at a branch's tip, so every commit below it is
 * anonymous. Walking back from each tip recovers the rest. The first tip to
 * claim a commit keeps it — the same first-claimer-wins rule assignLanes
 * already applies to lanes — and the walk stops at trunk, which has its own
 * tier and needs no tracing.
 */
export function attributeBranches(commits) {
  const at = new Map(commits.map((c) => [c.h, c]));
  const owner = new Map();
  for (const c of commits) {
    const names = c.refs
      .filter((r) => !r.startsWith('tag: '))
      .map((r) => r.replace(/^HEAD -> /, ''))
      .filter((r) => r !== 'HEAD');
    for (const name of names) {
      const queue = [c.h];
      while (queue.length) {
        const h = queue.shift();
        const cur = at.get(h);
        // Missing parent (outside the window), already claimed, or trunk.
        if (!cur || owner.has(h) || cur.tier === 'trunk') continue;
        owner.set(h, name);
        queue.push(...cur.p);
      }
    }
  }
  return owner;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node --test test/ui.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/lib.js test/ui.test.ts
git commit -m "feat: attribute graph commits to their branch"
```

---

### Task 3: Render the three tiers

No new test: this task is DOM and CSS only, and the logic it depends on is already covered by Tasks 1 and 2. Verification is visual, via the running app.

**Files:**
- Modify: `web/app.js:942-970` (`renderGraphPane`), `web/app.js:980-1015` (`drawGraph`), `web/app.js:1017-1028` (`refPill`)
- Modify: `web/style.css:191-205` (graph block)

**Interfaces:**
- Consumes: `commitGraph`'s `tier` field (Task 1); `attributeBranches` (Task 2).
- Produces: every graph `path`, `circle`, and `.commit` row carries `data-branch`; tier styling lives on `tier-own` / `tier-trunk` / `tier-other` classes.

- [ ] **Step 1: Import `attributeBranches` in `web/app.js`**

Add `attributeBranches` to the existing import list from `./lib.js` at the top of `web/app.js` (lines 1-6).

- [ ] **Step 2: Pass attribution through `renderGraphPane`**

In `web/app.js`, replace the body of `renderGraphPane` after the empty-state early return (from `const width = drawGraph(graphCommits);` to the end of the function) with:

```js
  const owner = attributeBranches(graphCommits);
  const width = drawGraph(graphCommits, owner);
  rows.replaceChildren(...graphCommits.map((c) => {
    const row = document.createElement('div');
    row.className = 'commit';
    row.style.marginLeft = `${width + 14}px`;
    if (owner.has(c.h)) row.dataset.branch = owner.get(c.h);
    const hash = document.createElement('span');
    hash.className = 'hash';
    hash.textContent = c.h.slice(0, 7);
    row.append(hash);
    for (const r of c.refs) row.append(refPill(r, c.tier));
    const subject = document.createElement('span');
    subject.className = 'subject';
    subject.textContent = c.subject;
    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = `${c.author} · ${c.when}`;
    row.append(subject, when);
    return row;
  }));
```

- [ ] **Step 3: Style `drawGraph` by tier**

Replace `drawGraph` (lines 980-1015) with:

```js
function drawGraph(commits, owner) {
  const at = new Map(commits.map((c) => [c.h, c]));
  const svg = $('#graph-svg');
  const width = PAD * 2 + Math.max(0, ...commits.map((c) => c.lane)) * LANE;
  svg.setAttribute('width', width);
  svg.setAttribute('height', commits.length * ROW);
  svg.replaceChildren();
  const x = (c) => PAD + c.lane * LANE;
  const y = (c) => ROW / 2 + c.row * ROW;
  const branch = (c) => owner.get(c.h) ?? '';

  for (const c of commits) {
    for (const [i, ph] of c.p.entries()) {
      const p = at.get(ph);
      // Parent outside the fetched window: its line simply ends at the bottom.
      if (!p) continue;
      const [x1, y1, x2, y2] = [x(c), y(c), x(p), y(p)];
      // The line holds its own lane and only swings across near the parent, so a
      // merge reads as an interchange instead of a diagonal cutting the map.
      const bend = Math.max(y1, y2 - ROW);
      const d = x1 === x2
        ? `M${x1},${y1}V${y2}`
        : `M${x1},${y1}V${bend}C${x1},${y2} ${x2},${bend} ${x2},${y2}`;
      // A merge's second parent is drawn in the parent's tier, not the child's:
      // that line belongs to the branch being merged in.
      const from = i ? p : c;
      svg.append(svgEl('path', { d, class: `tier-${from.tier}`, 'data-branch': branch(from) }));
    }
  }
  for (const c of commits) {
    const head = c.refs.some((r) => r.startsWith('HEAD'));
    svg.append(svgEl('circle', {
      cx: x(c), cy: y(c), r: head ? DOT + 1.5 : DOT,
      class: `tier-${c.tier}${c.p.length > 1 ? ' merge' : ''}${head ? ' head' : ''}`,
      'data-branch': branch(c),
    }));
  }
  return width;
}
```

- [ ] **Step 4: Key `refPill` off tier**

Replace `refPill` (lines 1017-1028) with:

```js
function refPill(raw, tier) {
  const tag = raw.startsWith('tag: ');
  const name = raw.replace(/^tag: /, '').replace(/^HEAD -> /, '');
  const pill = document.createElement('span');
  pill.className = `ref tier-${tier}${tag ? ' tag' : ''}`
    + (!tag && name.includes('/') ? ' remote' : '') + (raw.startsWith('HEAD') ? ' head' : '');
  // Branch and tag names come from the repo, so they go in as text, never markup.
  const label = document.createElement('span');
  label.textContent = name;
  pill.append(label);
  return pill;
}
```

- [ ] **Step 5: Replace the lane palette in `web/style.css`**

Replace the comment block and the two `.lane*` lines (lines 192-200, from `/* Read as a transit map:` through the `.lane3 ... .lane5` line) with:

```css
/* Read as a transit map: a branch is a line, a commit is a stop, a merge is the
   interchange where two lines join. Three tiers rather than a per-lane palette:
   lanes are reused as branches close, so a lane colour renamed itself mid-graph
   and said nothing about which branch you were looking at. Tier does. Weight
   carries the ranking as well as hue, so the three stay apart when several grey
   branches run side by side. */
#pane-graph { --row: 34px; }
#graph-map { position: relative; }
#graph-svg { position: absolute; top: 0; left: 0; overflow: visible; }
.tier-own { color: var(--done); }
.tier-trunk { color: var(--dim); }
.tier-other { color: var(--stopped); }
#graph-svg path.tier-own { stroke-width: 3; }
#graph-svg path.tier-other { stroke-width: 2; }
```

Leave the following lines (`#graph-svg path`, `#graph-svg circle`, `.merge`, `.head`) exactly as they are. The base `#graph-svg path` rule still supplies fill, linecap, and the default 2.5 weight that trunk keeps; the two `path.tier-*` rules override only stroke-width, and they win on **specificity** — `#graph-svg path.tier-own` (one id, one class, one element) outranks `#graph-svg path` (one id, one element) — not on source order. They stay correct wherever in the block they sit.

- [ ] **Step 6: Verify in the running app**

```bash
npm start
```

Open the app, open a session, and select the Graph tab. Confirm: every branch in the repo appears (compare against `git branch -a` in that repo); the session's own commits are blue; trunk is mid-grey; other branches are darker grey; branch name pills still appear at each tip.

- [ ] **Step 7: Run the full suite**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add web/app.js web/style.css
git commit -m "feat: colour the commit graph by tier instead of lane"
```

---

### Task 4: Hover to trace a branch

**Files:**
- Modify: `web/app.js` (`renderGraphPane`)
- Modify: `web/style.css` (graph block)

**Interfaces:**
- Consumes: the `data-branch` attributes added in Task 3.
- Produces: no exported surface. Hovering a commit row adds `.tracing` to `#graph-map` and `.traced` to every element of that branch.

- [ ] **Step 1: Add the trace handler to `web/app.js`**

Add this function immediately above `renderGraphPane`:

```js
/**
 * Lights up one branch across the whole graph. Elements are compared by
 * dataset rather than matched with a selector, because a branch name is
 * arbitrary repo text and would otherwise need escaping to be safe in one.
 */
function traceBranch(name) {
  const map = $('#graph-map');
  map.classList.toggle('tracing', Boolean(name));
  for (const el of map.querySelectorAll('[data-branch]')) {
    el.classList.toggle('traced', Boolean(name) && el.dataset.branch === name);
  }
}
```

- [ ] **Step 2: Wire the handler to each row**

In `renderGraphPane`, directly after the `if (owner.has(c.h)) row.dataset.branch = owner.get(c.h);` line added in Task 3, insert:

```js
    row.onmouseenter = () => traceBranch(owner.get(c.h) ?? '');
    row.onmouseleave = () => traceBranch('');
```

- [ ] **Step 3: Add the trace styling to `web/style.css`**

Add directly below the `#graph-svg path.tier-other` rule from Task 3:

```css
/* Tracing one branch: everything not on it recedes rather than disappears, so
   the traced line is read in context instead of floating on its own. */
#graph-map.tracing [data-branch]:not(.traced) { opacity: .2; }
#graph-map.tracing .traced { opacity: 1; }
```

- [ ] **Step 4: Verify in the running app**

```bash
npm start
```

Open the Graph tab in a repo with at least two non-trunk branches. Hover a commit row: that branch's line, dots, and tip pill stay full strength while the rest of the graph fades. Move off the row: everything returns. Hover a trunk commit: nothing fades, because trunk commits are unattributed.

- [ ] **Step 5: Run the full suite**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/app.js web/style.css
git commit -m "feat: trace a branch through the graph on hover"
```

---

## Deferred

Named here so it is not re-litigated during implementation. From the spec's "Known cost": retiring the six-colour palette means several non-selected branches all render grey, so adjacent lines are harder to tell apart than they are today. Hover-to-trace (Task 4) is the mitigation. If that proves insufficient in practice, the fix is to let `tier-other` keep a `lane % 6` hue at low saturation — a knob, not a redesign. Do not build it as part of this plan.
