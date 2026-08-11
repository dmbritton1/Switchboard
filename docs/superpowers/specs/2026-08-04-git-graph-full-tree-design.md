# Git graph, full tree — design

Make the Graph pane show every branch in the repository, and make the selected
session's branch legible within it.

The pane already intends to do this: `commitGraph` (`src/worktree.ts:69`) passes
`--all`, and `renderGraphPane` (`web/app.js:942`) draws every commit the server
returns. In a small repository it works. In a real one it silently collapses to
main plus whichever branch is recent, which is what prompted this work.

## The bug

`git log --all --topo-order -400` spends a *single global* commit budget,
newest-first. Trunk history wins that budget. Any branch whose tip is older than
the newest 400 commits is not truncated — it is absent, along with its ref.

Reproduced against a synthetic repository: one branch forked at the root, then
450 commits on main.

```
commits returned: 400
stale-session present? false
refs seen: HEAD -> main
```

Switchboard's own repository has ~156 commits, so the pane looks correct when
developing against it. Against a repository of any age, 400 commits of trunk may
only reach back a few weeks, and every branch older than that window disappears.
This is why the pane reads as "main and the selected branch".

## What is in

1. A per-branch commit budget, so no branch can be starved by trunk.
2. A `tier` on each commit distinguishing the selected branch, trunk, and
   everything else.
3. Three-tier rendering, replacing the recycled six-colour lane palette.
4. Client-side branch attribution and hover-to-trace.

## What is out

- Any change to `assignLanes`. Its lane assignment and lane-release behaviour
  are correct and stay exactly as they are.
- Any change to how the pane polls (`setInterval(loadGraph, 2000)`,
  `web/app.js:1043`) or to its Graph-tab guard.
- Per-file diffs, commit detail views, checkout/branch actions from the graph.
  The pane stays read-only.

## 1. Splitting the budget

`commitGraph` takes the base repository path in addition to the session cwd, and
issues two bounded calls instead of one:

```
A: git log --all --not <trunk> --topo-order -<limit>   # every off-trunk commit
B: git log       <trunk>       --topo-order -<limit>   # bounded trunk history
```

The result is `A ++ B`, concatenated. **No re-sort is required**, and this is
the load-bearing claim of the design, so it is worth stating precisely:

- The two sets are disjoint. `A` is defined as commits *not* reachable from
  trunk; `B` contains only commits reachable from trunk.
- A commit in `B` cannot have a parent in `A`. If it did, that parent would be
  reachable from trunk, contradicting `A`'s definition.
- Therefore every parent still appears after its child: within `A` and within
  `B` because git ordered each topologically, and across the boundary because
  all of `B` follows all of `A`.

`assignLanes` requires topological order and gets it, unchanged.

### Determining trunk

Trunk is **the base repository's currently checked-out branch** — the same
definition `mergeWorktrees` already uses when it picks a merge target
(`src/merge.ts:72`). `currentBranch` (`src/merge.ts:45`) is currently private and
becomes exported rather than duplicated, so the graph's notion of trunk and the
merge target cannot drift apart.

This deliberately avoids hard-coding `main`. A repository whose trunk is
`master`, `trunk`, or a release branch gets the correct split for free, and the
graph agrees with where the Merge button would actually land the work.

### Fallback

If the base repository is on a detached HEAD, `currentBranch` returns empty and
there is no trunk to split on. In that case `commitGraph` falls back to today's
single `git log --all --topo-order -<limit>` call and tiers every commit as
`other`. The pane degrades to current behaviour rather than erroring.

## 2. Tiering commits

`GraphCommit` gains one field:

```ts
tier: 'own' | 'trunk' | 'other'
```

Decided on the server, where the git facts already are, so the browser does no
reachability inference.

- `own` — commits unique to the selected branch, from one
  `git rev-list HEAD --not <trunk>` run in the session's cwd. The boundary is
  the fork point: this is the work done on the branch, not its inherited
  ancestry.
- `trunk` — commits that came from call `B`.
- `other` — commits from call `A` that are not `own`.

Where two sessions branched from one another their commit sets overlap, and the
descendant session claims the shared commits as `own`. This is uncommon and the
reading stays defensible — the highlight still means "not on trunk, and reachable
from here".

## 3. Rendering the three tiers

`drawGraph` (`web/app.js:980`) currently classes every path and circle
`lane${n % 6}`. That class becomes the tier:

- `own` — accent colour, full stroke weight.
- `trunk` — muted but clearly visible; the trunk stays readable as the spine.
- `other` — grey.

The existing merge rule is preserved verbatim in intent: a merge's second-parent
edge is drawn in the *parent's* tier, not the child's, because that line belongs
to the branch being merged in (`web/app.js:1002`).

`refPill` (`web/app.js:1017`) takes a tier instead of a lane. Branch and tag
pills keep their existing shapes, HEAD keeps its double ring; only the colour
source changes. Every branch therefore still carries its name at its tip.

The `.lane0`–`.lane5` rules in `web/style.css:199` are replaced by three tier
rules. The palette comment above them is updated: the view no longer reuses the
status palette as six recycled lane colours.

### Known cost

Retiring the six-colour palette means every non-selected branch renders the same
grey, so two adjacent branch lines are harder to tell apart than they are today.
Hover-to-trace below is the mitigation. If it proves insufficient in practice,
the fix is a knob rather than a redesign: let `other` keep its `lane % 6` hue at
low saturation. That is deliberately not built now.

## 4. Branch attribution and hover-to-trace

The browser already holds every commit and its parents, so attribution needs no
additional git call.

Attribution is a pure function, `attributeBranches(commits)`, and therefore
belongs in `web/lib.js` with the app's other pure helpers rather than in
`web/app.js`. That is the existing split — `web/lib.js` holds logic, `web/app.js`
holds DOM, and `test/ui.test.ts` imports from `web/lib.js` — and it is what makes
the function testable at all.

It walks ancestors from each commit that carries a branch ref. The first tip to
claim a commit owns it; the walk stops at `trunk`-tier commits. This is the same
first-claimer-wins rule `assignLanes` already applies to lanes
(`src/worktree.ts:57`), so neither file gains a new idiom.

Each commit row and each SVG element gets a `data-branch` attribute. On
`mouseenter` of a row, `traceBranch(name)` walks `#graph-map`'s `[data-branch]`
elements and toggles a `.traced` class by comparing `el.dataset.branch === name`
directly, rather than setting a container-level attribute and matching it with
a CSS attribute selector — a branch name is arbitrary repo text and would need
escaping to be safe inside a selector. `mouseleave` clears it the same way.

This composes with tier styling rather than replacing it, and it means a branch
scrolled away from its tip can still be identified on demand.

## 5. Server

The `/graph` handler (`src/server.ts:844`) passes `session.repo` alongside
`session.cwd`. Its existing safety property is unchanged and worth preserving
explicitly: both paths come from the registered session, never from a client
parameter, so this opens no way to point `git log` at an arbitrary directory.

The handler keeps its `.catch(() => [])`.

## Testing

In `test/worktree.test.ts`:

- **The starvation case.** Build the reproduction above — a branch forked early,
  then trunk commits past the limit — and assert the stale branch's tip is
  present with the right tier. Run it with a small `limit` so it stays fast.
  This is the test that fails if the budget split regresses.
- **Tier assignment.** Over the existing merge fixture: the session's own
  commits are `own`, trunk commits are `trunk`, a third branch is `other`.
- **Detached-HEAD fallback.** Returns commits rather than throwing.

In `test/ui.test.ts`, importing `attributeBranches` from `web/lib.js`:

- **Branch attribution.** Over a fixed commit array: each commit is attributed to
  the expected branch, the walk stops at trunk, and a commit reachable from two
  tips is claimed once.

Existing `assignLanes` tests are unchanged and must keep passing — they are the
guard that this work did not disturb lane layout.

`npm test` must pass, per `AGENTS.md`.

## Risks

- **Two git calls per poll instead of one**, every 2s while the Graph tab is
  open. Both are bounded by `limit`, and `--not <trunk>` is cheap because the
  off-trunk set is small. If this shows up, the answer is to back off the poll
  interval, not to re-merge the calls.
- **`limit` now bounds two sets rather than one**, so a graph can return up to
  ~2× the commits it does today. Row rendering is already linear in commit count
  and this is a constant factor.
