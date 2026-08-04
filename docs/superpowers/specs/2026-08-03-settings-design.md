# Settings — design

Give Switchboard a settings dialog: seven preferences, one store, no new
persistence mechanism.

Today every preference in the app is either a per-session toggle that resets
(auto-approve), a constant in a source file (`RESET_PACE`, `GRACE_MS`,
`TICK_MS`), or a field in `accounts.json` that needs a restart to take effect.
Nothing is settable from the UI. This adds the small subset that is worth
settling from the UI, and deliberately leaves the rest alone.

## What is in

Seven settings, grouped as the dialog groups them.

**Session defaults** — applied when a session is created.

- `autoApprove` — start new sessions with auto-approve already on. Today every
  session starts `auto: false` (`src/sessions.ts:44`) and the toggle is
  re-set by hand from the session's `⋯` menu each time. This is the setting
  that motivated the feature.
- `account` — which account the New dialog preselects. `null` means today's
  behavior: rank by usage and pick the freest.
- `branchPrefix` — prefilled into the New dialog's branch field, so a
  consistent `feat/` is typed once rather than every time.

**Notifications**

- `notifyOn` — which status transitions raise a browser notification, from
  `needs-you`, `done`, `stopped`. Default `['needs-you']`, today's behavior.

**Grid**

- `sort` — `blocked` (today), `newest`, or `account`.
- `collapseDone` — fold finished sessions out of the way.

**Behavior**

- `autoRequeue` — whether a Claude session that dies while its account is past
  its limit gets a resume queued automatically. Default `true`, today's
  behavior.

Every default reproduces current behavior exactly. A `state.json` that gains a
settings block behaves identically until something is changed.

## Why `notifyOn` matters more than it looks

`notify()` (`web/app.js:64`) fires only for sessions in `needs-you`. The README
records that Codex sessions never enter `needs-you` — they run with
`approvalPolicy: 'never'`, sandboxed to their worktree, and `decide()` on them
is a no-op.

Those two facts together mean **a Codex session never produces a notification,
ever.** It finishes, or it dies, in silence. Making the notify-on set
configurable is what closes that hole; `done` and `stopped` are the only
transitions a Codex session has.

## What is out, and why

- **Theme.** `web/style.css` defines 12 custom properties in `:root` and then
  hardcodes roughly forty more colors past them (`#e05555` appears six times,
  `#232323` four). A light theme is not a setting, it is authoring a second
  palette and hoisting every hardcoded color into a variable — more work than
  the other seven settings combined, for the one preference no pain was reported
  against. Revisit as its own change.
- **Notification sound.** A browser notification on macOS already makes a sound
  unless it has been silenced in Notification Center, where the user has better
  controls than this dialog would offer.
- **`GRACE_MS`** (`src/schedule.ts:13`), the 12-hour window in which a missed
  scheduled item still fires on startup. A knob nobody will turn.
- **`RESET_PACE`** (`src/usage.ts:8`), the Codex reset threshold. It is only
  meaningful relative to the `budget` it divides, and `budget` lives in
  `accounts.json`. Splitting a tuning pair across two stores is worse than
  leaving both in the file.
- **Worktree location.** Hardcoded to `<repo>/.claude/worktrees/<branch>`.
  Changing it does not migrate existing sessions, it orphans them.
- **Scheduler tick, listen port, upload cap.** No demand.
- **Account editing** — names, budgets, `env`, Codex `bin`. `accounts.json` is
  a launch-environment file whose values are treated as launch-only secrets
  (`AGENTS.md`); editing it from an unauthenticated local HTTP surface is a
  larger change than this one, and was explicitly not wanted.
- **Codex sandbox mode and approval policy.** Permanently out. `AGENTS.md`
  names both a safety boundary and forbids broadening either. A settings dialog
  is exactly the place that boundary would erode, so it does not appear there
  at any point.

## Storage

`state.json` becomes `{ sessions, usage, queue, settings }`. (The README still
describes it as `{ sessions, usage }`; `queue` was added by scheduling and the
README was not updated — `src/sessions.ts:232` is authoritative.)

```ts
export type Settings = {
  autoApprove: boolean;                          // false
  account: string | null;                        // null = freest
  branchPrefix: string;                          // ''
  notifyOn: ('needs-you' | 'done' | 'stopped')[];  // ['needs-you']
  sort: 'blocked' | 'newest' | 'account';        // 'blocked'
  collapseDone: boolean;                         // false
  autoRequeue: boolean;                          // true
};
```

One store rather than two. The alternative — client preferences in
`localStorage`, server preferences in `state.json` — was rejected because
`autoRequeue` is evaluated by the server when a session dies, with no browser
necessarily attached (`src/server.ts:181`), so a server-side store is required
regardless. Given one is required, a second buys nothing but a dialog that has
to know which half each field belongs to.

`Registry.load` defaults a missing `settings` key, the same tolerance it
already applies to `auto` (`src/sessions.ts:289`) and to a bare-array
`state.json` from an older build. Unknown keys in a stored block are dropped on
load, so downgrading does not corrupt the file — load is tolerant on purpose,
while the `settings` command below is strict. They are different trust
boundaries: the file is written by this app, the command is not.

Writes reuse the existing coalesced path: at most one write every two seconds,
no new persistence code.

## Server changes

- `src/sessions.ts` holds `settings`, exposes `setSettings(patch)` merging a
  partial over the current value and marking state dirty, and includes it in
  the SSE payload alongside sessions and usage.
- `src/server.ts` gains `case 'settings'`, which **validates before merging**:
  unknown key, wrong type, or an out-of-range enum is a 400 with a message,
  not a silent drop. This is the one place in the change not to be casual —
  `/command` is unauthenticated by design, and this endpoint now alters how
  agents launch.
- `create` sets the flag before launching:
  `if (settings.autoApprove) registry.setAuto(session.id, true)`. `launch`
  already reads it back out of the registry (`src/server.ts:309`), so nothing
  else changes.
- The auto-requeue predicate at `src/server.ts:181` gains
  `&& settings.autoRequeue`.

`account` and `branchPrefix` need no server logic at all. They only decide what
the New dialog preselects; `create` is still told which account to use by the
browser.

## Browser changes

- A `⚙` button in `#bar` beside `+ New`, opening `<dialog id="settings">`,
  built like `#new` and `#del` — `method="dialog"`, and `formnovalidate` on
  Cancel, without which Cancel silently does nothing while any required field
  is empty (the wart already documented at `web/index.html:93`).
- Save posts a single `{ cmd: 'settings', patch }` and retains a non-2xx
  response in the dialog, matching the established rule that command failures
  live in the relevant persistent surface rather than a transient toast.
- The dialog reads current values off the SSE state the UI already holds. It
  does not fetch.
- `ORDER` (`web/lib.js:5`) becomes one of three comparators selected by `sort`.

## The risk worth naming

`notify()` dedupes with a single `seenNeedsYou` set, rebuilt on every payload.
Adding `done` and `error` needs a seen-set per transition, and — critically —
those sets must be **seeded from the first payload after each SSE connect**
rather than starting empty.

`EventSource` reconnects on its own, and the server pushes full state on
connect. Without seeding, every reconnect notifies once per finished session on
the board. On a grid with a dozen completed sessions that is a dozen
notifications for work that finished hours ago, triggered by a dropped
connection the user never saw. This is the defect this feature ships with if
nobody looks for it.

## Testing

Four tests, in the existing offline suite, no new fixtures:

- A legacy `state.json` with no `settings` key loads with every default, and
  the resulting behavior matches the pre-settings behavior.
- `create` with `autoApprove` on produces a session whose `auto` is `true`
  before the adapter starts.
- With `autoRequeue` false, a Claude session that dies while its account is
  over limit queues nothing.
- A reconnect delivering a payload containing already-`done` sessions, with
  `done` in `notifyOn`, notifies for none of them.

The first three are server-side and hermetic. The fourth needs the seen-set
logic reachable from `web/lib.js`, which is where the browser logic that has
tests already lives.

## Not in this change

Per-session overrides of these defaults — a session that starts auto-approved
because the default said so still has its own toggle, but there is no
per-session settings surface and no inheritance chain. The README lists
"inherited-by-default per-session settings" under Phase 2; this design does not
begin it.
