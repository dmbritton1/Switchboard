# Overlap detection — design

Show which sessions have changed the same files, to both the agents and the
human. Two sessions on the same repo can only collide at merge time, and today
nothing says so until the merge conflicts.

This builds on session relay, which is already merged. It reads relay's channel
map and extends relay's `list_sessions` tool.

## Why this and not messaging

Relay lets agents coordinate, but coordination by announcement is advisory
locking implemented by language models: it depends on both agents remembering to
announce, both listening, and the announcement arriving before the other one
started. It fails silently, and it fails at exactly the moment it matters.

Overlap is computed rather than announced. Switchboard already knows every
session's worktree, so nothing has to be remembered by anybody. It works for
sessions that never message, for sessions whose account is rate-limited, and for
the session started an hour ago and forgotten.

It also keeps relay's pairwise design from getting expensive. Channels are keyed
by pair, so a session wanting to coordinate with three others opens three
channels and costs three approvals. Without overlap an agent has no way to know
which of the three matters, so the safe move is to message all of them. With it,
`list_sessions` distinguishes the session editing the same file from the two
that are not, and one channel replaces three.

## The two couplings

There are two ways sessions can be entangled, and conflating them loses the most
useful signal:

- **Implicit** — they have changed the same files, and may not know it.
- **Explicit** — they have an open relay channel. They are talking.

The alarming state is overlap *without* a channel. Two sessions both editing
`auth.ts` and talking about it is coordination working; two doing it in silence
is a merge conflict that has not happened yet. A badge that cannot tell those
apart is a badge that cries wolf on the healthy case.

So both are surfaced, and the pairing of the two is what makes either useful.

## What a session's changed set is

The union of two things, per session:

- **Uncommitted** — free. `worktreeStatus` (`src/worktree.ts:196`) already runs
  `git diff HEAD --numstat` and `git ls-files --others`; the numstat line is
  `added⇥removed⇥path` and the current code reads only the first two fields.
  Keeping the third costs nothing.
- **Committed** — `git diff --name-only <base>...HEAD`, one new invocation per
  session. `<base>` is the repo's currently checked-out branch, which is what
  `mergeWorktrees` merges into and therefore the branch a collision would
  actually happen on. Getting that name is `currentBranch(repo)`, one more call
  per repo, shared across every session in it.

The committed half is not optional. Two sessions that each *committed* a change
to the same file show as clean worktrees and still collide, which is precisely
the case worth warning about.

`CONVERSATION_INPUTS` (`src/merge.ts`) applies here exactly as it does to the
outstanding-work commit. Without it, every session that ever had a screenshot
pasted into it would overlap with every other on a `.switchboard-upload-…` path,
and the signal would be noise from the first day.

## Where the work happens

`/status?id=<session>` (`src/server.ts:1392`) is already polled per card by the
browser, throttled client-side. Path collection piggybacks on it, so the work
happens exactly as often as the card already refreshes and no more — no new
polling loop, no background timer.

The result is cached in a process-local map beside `channels` and `handles`
(`src/server.ts:470`), dropped when a session is deleted, the same lifecycle
relay's maps already have.

**The cache is also the rate limiter, and that is not optional.**
`STATUS_THROTTLE_MS` is 4000 (`web/app.js:442`), so each visible card polls
`/status` every four seconds — on a ten-session grid, recomputing paths on every
poll would mean roughly three hundred git invocations a minute. Each entry
therefore carries the time it was computed, and collection is skipped when the
entry is younger than a TTL of its own (30s), independent of how often `/status`
is called. Everything below that says "throttle window" means this TTL, not the
browser's poll interval.

**Overlap is asymmetric until the cache fills.** Overlap for session X is X's
paths intersected against the *cached* paths of the other same-repo sessions. A
session whose `/status` has not run yet is not in the cache, so X may show
nothing while Y already shows the collision. It converges within one throttle
window. For an advisory signal that is acceptable, but the UI must not imply
otherwise — this is "also changed in", never "locked by".

## What each consumer gets

`/status` gains two fields, both computed for the session being asked about:

- `talking` — the sessions with an open relay channel to this one. A map lookup,
  no git.
- `overlapping` — the same-repo sessions whose changed set intersects this one's,
  each with the shared paths.

### The card

The `.wt` line currently reads `+12 −3 · dirty` (`web/app.js:924`). It gains
badges, rendered **per pair** rather than per session:

| Pair state | Badge |
| --- | --- |
| Talking | `↔ feat/a` |
| Overlapping, no channel | `⚠ 3 files also in feat/b` |
| Both | `↔ feat/a` only — the overlap is already known to both |

So a card may read `+12 −3 · dirty · ↔ feat/a · ⚠ 3 files also in feat/b`:
talking to one session, silently colliding with another. The full path list goes
in the element's `title`, so hovering gives the detail without new UI.

Because `/status` is fetched by the card and written into its own element, none
of this touches the SSE snapshot.

**There is a second `/status` consumer.** `pollSidebarDiff` (`web/app.js:456`)
polls the *open* session on its own interval, independent of the grid, and
renders the same `+N −M · dirty` line into the sidebar where it stays visible on
all three tabs. Two consequences. First, the response shape change has two
readers, and the sidebar renderer must not break on the new fields. Second, the
open session's paths get refreshed on a timer whether or not its card is on
screen, which keeps the most relevant entry in the cache warm.

The sidebar is also the natural home for the detail if the card line proves
crowded — it concerns one session, has room, and is visible from every tab, so
it could carry the paths where the card carries only the count. Not built now;
noted because the option exists without new machinery.

### `list_sessions`

Each row gains the overlap with the calling session:

```
feat/login — working, on account claude-alt (id …) — also changed src/auth.ts, src/session.ts
```

That is what makes the tool worth calling, and it gives an agent something
specific to say if it decides to open a channel.

The relay server's `instructions` string (`src/agents/relay-tools.ts:27`) gains a
line saying other sessions may be editing the same files and that
`list_sessions` shows which. That is the whole of the make-the-agent-aware
mechanism, and it is deliberately the cheapest one: it costs a string, and it
turns an agent with no reason to ask into one that has been told there is a
reason.

It is not a guarantee. An agent that never calls `list_sessions` never learns
about the overlap. The escalation, if this proves insufficient in practice, is to
surface it at the moment of the edit — `canUseTool` fires on every `Edit`/`Write`
and knows the path, and a denial's message is this SDK's channel back into the
tool result. That is deliberately not built now; it costs a wasted tool call per
overlapping file and should not be paid before the free option has been shown to
fail.

### Staleness for agents

An agent may call `list_sessions` before the browser has polled the sessions it
asks about, leaving the cache cold and the tool silently reporting no overlap
where there is some. Since agents call it rarely, that path refreshes any entry
older than the same TTL — a handful of git invocations on an agent-initiated
action, in exchange for a tool that does not quietly lie.

This makes `relaySessions` (`src/server.ts:579`) return a promise. Its only
caller is an already-async tool handler.

Both the tool result and the tooltip list at most **10** paths and then say "and
N more"; two sessions can overlap on a great many files.

## Edge cases

**A missing worktree.** `/status` already does `worktreeStatus(cwd).catch(() =>
null)` and the card skips. Path collection does the same — and the session's
cached entry is dropped, or every other session goes on reporting overlap with a
worktree that no longer exists.

**Detached HEAD in the base repo.** `currentBranch(repo)` returns empty and the
committed half cannot be computed. Degrade to uncommitted-only rather than
failing the whole response: a partial advisory signal beats none, and
`mergeWorktrees` already treats detached HEAD as a thing that happens.

**Renames.** Two sessions renaming one file to different names read as not
overlapping. Noted and not solved; rename-aware overlap is a deeper hole than it
looks, and this signal is advisory.

**Cost.** Two git invocations per session per TTL window, not per `/status`
call — see the rate-limiting note above, which is what keeps a four-second poll
from turning into hundreds of subprocess spawns a minute. Pairwise intersection
is O(n²) in same-repo sessions and runs on every call, but it is set arithmetic
over cached data with no git in it. Trivial at ten sessions; worth a `ponytail:`
comment naming where that stops being true rather than pretending it never
does.

## Testing

Three layers, all offline:

- `changedPaths(cwd, base)` against a real temporary repo: a committed change and
  an uncommitted one, asserting the union — and asserting a
  `.switchboard-upload-…` file is **excluded**. That last assertion is what
  catches the exclusions being forgotten.
- The overlap computation as a **pure function** over path sets, with no git in
  sight, tested the way `handoffTargets` and `mentionMenu` are.
- `/status` and `list_sessions` end to end through `boot()` with real worktrees:
  two sessions touching one file report each other, a third on another repo does
  not, and a pair with an open channel renders as talking rather than colliding.

The pure-function split matters for the same reason it did in relay — it keeps
the interesting logic testable and leaves only plumbing behind the untested
boundary.

## Out of scope

- **Anything with teeth.** This never blocks a merge, never refuses an edit, and
  never claims a file. Claims and leases are a much larger build and depend on
  agents claiming before editing, which is the same reliability problem one level
  up.
- **Edit-time notification** (`canUseTool` denial), as above.
- **Region-level granularity.** Two sessions in different functions of one file
  count as overlapping. File-level is a superset of real conflicts and never a
  subset, which is the safe direction for a warning.
- **Injecting a note into an agent's turn** when overlap appears.
