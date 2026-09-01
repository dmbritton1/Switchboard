# Session handoff — design

Move a session's work from an account that has run out to one that has not,
without losing what the first agent learned. The user picks a stopped or
finished session, picks another account, and gets a new session on a branch
descended from the first, opened onto a written account of everything that
happened before it.

## The pull model, and why the first agent writes nothing

The obvious design is a handoff *brief*: ask the outgoing agent to summarise
its own state, then open the new session with that summary as its prompt. The
outgoing agent knows what mattered, so the summary is better than anything the
app could assemble.

It also cannot be produced in the case the feature exists for. Handoff is worth
building because an account hit its usage window; an account that has hit its
usage window has no turn left to spend on a summary. The push model is
unavailable exactly when it is wanted.

Everything the successor needs is already at rest, and Switchboard already owns
both halves of it. `Session.transcript` is a provider-neutral `Msg[]` held in
the Registry and rehydrated from `state.json` on start (`src/sessions.ts:556`),
so it survives the account being rate-limited, the session being stopped, and
the process being restarted. The code is on the outgoing session's branch. Both
are static. Nothing has to be asked of the exhausted account at all.

So the successor pulls. Switchboard renders the transcript to a file inside the
new worktree, and the new session's opening prompt points at that file and at
the branch's own history. The successor reads what it needs, at its own pace,
on its own budget. The outgoing account spends nothing.

This is why handoff does not depend on an agent-to-agent message channel. A
channel exists to reach a *running* agent. A rate-limited session is frozen, and
for frozen state a file is both simpler and better: it can be re-read, skimmed
out of order, and grepped, none of which a delivered message allows.

## Flow

One server command, `handoff`, taking the source session, the target account,
and a branch name. Every check that can fail runs before anything is created:

1. Resolve source session A. Refuse when A is `working` or `needs-you`. This is
   the guard `merge` already applies (`src/server.ts:908`) for the same reason —
   a running agent's half-written files must not be committed underneath it.
2. Resolve the target account and `prepare()` it. Codex preflight failures
   (`CodexRuntimeError`) surface here, redacted, before a worktree exists.
3. Commit A's outstanding work.
4. Create B's worktree, branched from A's branch.
5. Write the rendered transcript into that worktree.
6. `registry.create`, `appendPrompt`, `launch` for B.
7. Stop A.

A is stopped last. Any failure above leaves the source session exactly as it
was, which matters more here than usual: the whole point of the feature is that
A's account is already in trouble, and a half-completed handoff that also
killed A would leave the work unreachable from either side.

Stopping A is not decoration. If A stays live and keeps editing, B is working
from a snapshot that is already stale, and the two branches diverge into a
conflicting merge. Stopping is reversible — Resume still works, and the
unlinking rules already treat stopped sessions as a readable archive
(`README.md:91`). Two live agents on related branches is the rung 2 problem,
and rung 2's coordination channel does not exist yet.

## The renderer

`src/handoff.ts`, new, exporting `renderHandoff(session, getDetail): string`.
It runs server-side with direct Registry access, so it can reach tool detail
bodies that the SSE snapshot deliberately omits.

Per message kind:

| Kind | Rendered as |
| --- | --- |
| `user` | `## You said`, then the text |
| `text` | the agent's prose, verbatim |
| `tool` | one line — name, summary, status — with `detail` inlined when held |
| `todo` | a markdown checklist |
| `error` | kept, marked as an error |
| `reasoning` | dropped |

Reasoning is dropped because the safety boundaries forbid exposing it
(`AGENTS.md`), and because it is the least useful thing a successor could read:
it is the outgoing agent's private deliberation about a state that has since
changed.

Tool detail is bounded to 32 KiB per item and 2 MiB globally and evicted
least-recently-updated, so on a long session the early tool output is often
already gone. Where `detailEvicted` is set the renderer emits an explicit
`_[detail evicted]_` marker rather than omitting the line. A successor reading a
confident-looking history with silent holes in it is worse than one reading a
history that says where its holes are.

Writing detail to disk leaks nothing new: account environment values are
redacted at Registry admission (`src/server.ts:186`), so what the renderer reads
is already what the UI is allowed to show.

## Worktree and branch

`createWorktree(repo, branch)` (`src/worktree.ts:14`) runs `git worktree add -b
<branch> <path>` with no start point, so it always branches from the base repo's
HEAD. It gains an optional third argument appended to that command; handoff
passes A's branch, and every existing caller is unaffected.

Branching from A is what makes the handoff a continuation rather than a
restart. The written transcript explains the intent; the branch carries the
code. Neither is much use alone.

A's worktree may hold uncommitted work, which a branch point would not capture.
`mergeWorktrees` already solves this — it commits outstanding changes before
merging (`src/merge.ts:96`) — so that block is extracted to an exported
`commitOutstanding(cwd, branch)` and called from both places rather than
duplicated into the new one.

### The exclusion, which is the same bug twice

That commit runs `git add -A -- . ':(exclude)uploads'`. The exclusion exists
because `/upload` drops pasted files into the worktree and every screenshot was
being committed into the branch and then permanently into the merge target;
there is a `ponytail:` comment recording the trade at `src/merge.ts:102`.

A handoff file written into the worktree is the same class of object — an input
to the conversation, not work product — and would land in the merge target the
same way. `.switchboard` joins the pathspec. Extracting `commitOutstanding`
first means it is one exclusion in one function, not two that can drift.

The file lives at `.switchboard/handoff.md` in B's worktree. Keeping it inside
the worktree means the successor reads it with ordinary file tools and the
prompt can name it by a relative path; absolute paths in transcripts are
already treated as a leak for attachments (`AGENTS.md`).

## Opening prompt

A fixed constant, not user-editable in this phase: the successor is told it is
continuing handed-off work, pointed at `.switchboard/handoff.md` for the
narrative, and at `git log` and the diff against its base for the code. Holding
it in one place keeps it tunable once real handoffs show what a successor
actually misses.

## UI

A "Hand off →" action on a `done` or `stopped` session card, opening a dialog
that picks the target account and a branch name honouring `branchPrefix`. It
posts `handoff` and, on success, the new session appears in the grid like any
other.

The action is absent on `working` and `needs-you` sessions rather than present
and failing, matching how the grid already treats merge.

## Error handling

Every validation failure returns 400 or 409 with nothing created: an unknown or
busy source session, an unknown target account, a Codex preflight failure, a
branch name already taken, a failed commit.

One exposure is accepted. If the file write fails after the worktree is
created, that worktree is orphaned. Today's `create` has exactly this shape
already — `createWorktree` succeeds, `launch` fails, the worktree remains — and
inventing a cleanup path here that the existing command does not have would
leave the two inconsistent for no gain. The orphan is visible in the graph and
removable by hand.

## Testing

Offline, through the simulator adapter, per the test isolation rules:

- `renderHandoff` over a transcript containing every `Msg` kind, asserting the
  evicted-detail marker appears and reasoning does not.
- A handoff end to end: the new session exists on the target account, its cwd
  contains `.switchboard/handoff.md`, `git rev-parse` confirms its branch
  descends from the source branch, and the source session is `stopped`.
- Handoff refused while the source is `working`.
- The existing `uploads` exclusion test extended to cover `.switchboard`, so a
  handoff file cannot reach a merge target.

## Out of scope

Named here so the boundary is explicit, not because they are unwanted:

- **Automatic handoff on rate limit.** The pull model makes this small — a
  trigger fires, the file is rendered, the session is created, with no waiting
  state machine — but it couples the work to the reset-queue's semantics and
  roughly doubles the test surface. Manual first, so a handoff can be exercised
  without burning an account's window.
- **Agent-written brief as enrichment.** When the source account is healthy it
  can still be asked for a summary, prepended to the rendered file. Strictly
  better when available, never available when most needed, so it is an addition
  to this design rather than part of it.
- **Agent-to-agent messaging.** Rung 2. Handoff deliberately does not depend on
  it.
- **Fresh-branch handoff.** Starting the successor from the repo's HEAD instead
  of the source branch, for "redo this differently" rather than "continue this".
  One more argument and one more dialog control if it is ever wanted.
