# Layout — design

Switchboard's UI grew by accretion: every feature so far landed either as a new
top-level view or as another band above the grid. There are now three sibling
views (`#grid`, `#chat`, `#graph`) toggled by `hidden`, four things stacked above
the cards (notification bar, selection bar, accounts row, and — once scheduling
lands — a queue strip), and up to ten controls on a single card face.

This spec restructures those into a two-level hierarchy with one persistent
header. It adds no server routes and no new features. Its purpose is to give the
features that are already in flight, and the two specs that follow it, an obvious
place to land.

## Scope

**In:** the shell (header, panels, session tabs), card-face reduction, the
overflow menu, and where scheduling's four UI touchpoints go.

**Out, as their own specs:**

- **Diff view** — fills the Diff tab this spec reserves; needs a `git diff` route.
- **Filters** — fills a header slot; repo/account chips, worth building once
  fifteen sessions is routine rather than occasional.

Both are fill-ins because this layout already reserves their homes. Neither
requires revisiting the structure below.

## The organizing decisions

Recorded because they are what the rest of the spec follows from, and because the
obvious alternatives are all defensible:

- **Status is the triage axis.** Repo and account are labels on a card, not
  grouping. The grid keeps its current sort.
- **No persistent session rail.** Peripheral awareness is handled by an inline
  interrupt band in the session view, not by a list that is always on screen.
  Views stay mutually exclusive.
- **Global surfaces live in one header**, not as conditional bands that reflow
  the grid under the cursor.
- **A session's facets are tabs, not top-level views.** The commit graph is about
  one session; it was never a peer of the grid.

## Structure

```
┌─ header ─────────────────────────────────────────────────┐
│  Switchboard   [claude-main ▓▓▓░ 62%] [claude-alt ▓░ 18%] │
│                [codex ▓▓░ 34%]        [⏱ 3]    [+ New]   │
└──────────────────────────────────────────────────────────┘
┌─ view ───────────────────────────────────────────────────┐
│  grid  ──open──▶  session ( Chat | Diff | Graph )         │
│        ◀──back──                                          │
└──────────────────────────────────────────────────────────┘
```

The header is always mounted and never reflows the view below it. The view area
holds exactly one of: the grid, or one session.

`graphId` and `openId` collapse into `openId` plus `tab`. A session is open, and
you are looking at one of its facets.

## Header

Three zones: identity, account meters, actions.

**Account meters** replace the `.accounts` row that currently spans the grid's
first row. Compact — name, a short bar, percentage. They stay visible in the
session view: usage is the reason you would switch accounts mid-work, so hiding
it behind the grid is backwards. Clicking a meter opens a panel below the header
with that account's detail: pace, budget, and (once scheduling lands) its reset
time and the items queued against it.

**Queue badge** `⏱ n` — rendered only when the queue is non-empty, but in a fixed
slot, so its appearance does not move anything. Clicking it opens a panel listing
every queued item: trigger, target, state, and a `✕`. `missed` and `failed` rows
carry their reason inline. This is the scheduling spec's "queue strip",
relocated — and unlike the strip, it is reachable from the session view.

**`+ New`** opens the create-worktree dialog, which is today a card at the end of
the grid. Moving it makes the grid uniformly sessions and means creating one does
not require scrolling past fifteen cards.

**Notification bar** stays a dismissible band directly under the header. It is a
one-time setup prompt rather than a permanent surface, and it is the only element
allowed to push the view down — it disappears for good once permission is
granted.

Panels are mutually exclusive: opening the queue closes an open account panel.
One at a time, `Escape` closes it.

## Grid and cards

The grid keeps its current sort — `needs-you`, `working`, `done`, `stopped`, most
recent first within each. Repo and account appear as one label line.

```
┌──────────────────────────────────┐
│ ☐  needs-you · 4m            [⋯] │
│ feat/scheduling                  │
│ Switchboard · claude-main        │
│ +142 −18 · dirty                 │
│ ┌──────────────────────────────┐ │
│ │ Bash: rm -rf node_modules    │ │
│ │ [Allow]  [Deny]              │ │
│ └──────────────────────────────┘ │
└──────────────────────────────────┘
```

One contextual action per state, in the slot at the bottom:

| status | action slot |
|---|---|
| `needs-you` | the approval box — tool, summary, Allow / Deny |
| `working` | `Stop` |
| `stopped` | `Resume`; or `⏱ waiting for <account> to reset` when a reset-triggered resume is queued for it |
| `done` | empty |

**`⋯` menu** holds everything else: `Auto-approve` (a checked item, disabled with
its existing explanation for Codex sessions), `Graph`, `Schedule…`, `Open
worktree path`, and `Delete…`.

`Delete…` opens a confirm dialog with the "remove worktree" checkbox inside it.
That checkbox is currently loose on the card face, one misclick away from
discarding uncommitted work; it belongs inside the confirmation it modifies.

The **selection checkbox stays on the card face** — multi-select only works if
several cards can be checked without opening menus. The **selection bar** keeps
appearing in flow above the cards, with its current same-repo rules and server-
side check unchanged. It reflows the grid, which is correct: it is transient and
caused by an action the user just took.

Every future per-session control goes in the `⋯` menu. The card face does not
grow again.

## Session view

One header shared by all tabs, replacing the separate `#chat` and `#graph`
headers:

```
┌───────────────────────────────────────────────────────┐
│ ← grid │ feat/scheduling · claude-main · working  [⋯] │
│ ┌─────┬──────┬───────┐                                │
│ │Chat │ Diff │ Graph │                                │
│ └─────┴──────┴───────┘                                │
└───────────────────────────────────────────────────────┘
```

The header carries the same `⋯` menu and the same contextual action as the card —
one implementation, two mount points. `← grid` returns from any tab.

- **Chat** — the existing transcript, composer, attach button and drag-drop,
  unchanged. Gains the ⏱ schedule button beside Send.
- **Diff** — renders what `/status` already returns: files changed, `+n −m`,
  dirty/clean. The named slot for the diff spec.
- **Graph** — the existing commit-graph render, moved in verbatim. Its 2s poll
  runs only while the Graph tab is active; today it is a bare `setInterval` that
  fires whether or not the view is open.

**Inline interrupt.** When another session enters `needs-you` while you are in
this one, a band appears under the session header:

```
feat/other-thing needs you — Bash: rm -rf node_modules   [Allow] [Deny] [Open]
```

Answering dismisses the band and leaves you where you are. With several blocked,
the band shows the oldest and a `+2 more` link to the grid. This is the only
cross-session element in the session view.

Tab state is per-session and resets to Chat on open. You open a session to read
what it said, not to land on the tab you last used somewhere else.

## Scheduling's homes

The scheduling design's four UI touchpoints, mapped onto this layout:

| scheduling spec | lands as |
|---|---|
| Queue strip at top of grid | header `⏱ n` badge → panel; reachable from the session view, which the strip was not |
| `Run` select in the New dialog | unchanged — `Now` / `At a time…` / `When usage resets` |
| ⏱ button beside Send | unchanged, in the Chat tab's composer |
| "waiting for reset" on stopped cards | the card's action slot, replacing `Resume` |

One addition: **`Schedule…` in the `⋯` menu**, opening the same picker. That is
the entry point for scheduling against a session you are not currently reading,
which the scheduling spec had no path for.

The picker remains one `<dialog>` shared by every entry point, as specified
there.

## Client state

`web/app.js` keeps its current shape — module-level globals read by a single
`render()` that branches on `openId`. That pattern is honest at this size and is
not worth replacing. The changes are:

- `graphId` is removed; `openId` plus a new `tab` (`'chat' | 'diff' | 'graph'`)
  replaces it.
- `panel` — `null | 'queue' | <account name>`, the open header panel.
- `menuFor` — the session id whose `⋯` menu is open, or null.

`openId`, `selected`, `selectionMessage` and `scrolledFor` are unchanged. The
three view branches in `render()` become two.

## Error and degraded states

**Command failures.** `send`, `decide`, `resume`, `stop` and `delete` are all
fire-and-forget today, and their failures are invisible in the browser even
though the server returns real errors (a `send` to a session with no live agent
is a 404; a `resume` on a non-`stopped` session is a 409). This layout adds one
place to put them: a transient toast at the bottom of the view when `/command`
returns non-OK. It generalizes the mechanism `selectionMessage` already provides
for merge and push. The failures already happen — this only makes them visible.

**No sessions.** The grid shows a centered prompt pointing at `+ New`, rather
than a bare `+ new worktree` card on an otherwise empty page.

**SSE disconnected.** The header shows a `reconnecting…` marker. `EventSource`
retries on its own, but a frozen grid and an idle one are currently pixel-
identical.

## Testing

This spec does not add a browser test harness; that is a larger commitment than a
restructure warrants. Instead the restructure extracts the three pieces of real
logic out of the DOM builders into pure functions, covered by a plain `node:test`
file the way `merge.ts` and `usage.ts` already are:

- `sortSessions(sessions)` — status ordering plus the recency tiebreak, currently
  inline in `renderGrid`.
- `cardAction(session, queue)` — status to action slot, including the
  `waiting for reset` branch, the one case that reads two data sources.
- `selectionState(sessions, selected)` — the label text and whether Merge and
  Push are enabled. Currently inline in `selectionBar`, duplicating a rule the
  server also enforces.

The rest of the restructure is DOM assembly, verified by use. The server is
untouched, so the existing suite stands as a regression check that nothing
backend moved.

Manual checks after implementation:

- each of the four card states renders its correct action slot;
- header panels are mutually exclusive;
- the graph poll stops when the Graph tab is not active;
- `Escape` closes panel, then menu, then dialog, in that priority.

## Deliberately out of scope

- **A persistent session rail.** Considered and rejected: the inline interrupt
  band covers awareness of blocked sessions, which is the case that actually
  needs it, without a permanent column.
- **Grouping the grid by repo.** Status is the triage axis; repo is a label.
- **Tabbed top-level views** (`Sessions | Queue | Accounts`). Scales, but hides
  usage and the queue exactly when they should be glanceable.
- **Keyboard navigation** beyond `Escape`. Worth doing, not part of the
  restructure.
