# Scheduling — design

Two capabilities, one mechanism:

1. Schedule a chat to go out at a chosen day and time.
2. Queue a chat to run when an account's usage window resets — either queued by
   hand, or queued automatically when a session dies because the account hit its
   limit.

Both are one-shot. There is no recurrence, no cron expression, no next-occurrence
computation.

## Background: the reset signal is real

The Claude Agent SDK streams a `rate_limit_event` message
(`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:4237`) carrying:

```ts
type SDKRateLimitInfo = {
  status: 'allowed' | 'allowed_warning' | 'rejected';
  resetsAt?: number;
  rateLimitType?: 'five_hour' | 'seven_day' | ...;
  utilization?: number;
};
```

It is a member of the `SDKMessage` union, so it arrives through the existing
`for await (const m of q)` loop in `src/agents/claude.ts` with no new plumbing.
"When usage resets" is therefore an observed event, not an inference — for Claude.

The Codex SDK has no rate-limit concept anywhere in its types. Codex accounts fall
back to the local estimate described below.

## Data model

New file `src/schedule.ts`. New types in `src/types.ts`:

```ts
export type Trigger =
  | { kind: 'at'; time: number }            // epoch ms
  | { kind: 'reset'; account: string };     // when that account's window frees up

export type Action =
  | { kind: 'create'; repo: string; branch: string; account: string; prompt: string }
  | { kind: 'send';   sessionId: string; text: string }
  | { kind: 'resume'; sessionId: string; prompt: string };

export type Queued = {
  id: string;
  trigger: Trigger;
  action: Action;
  createdAt: number;
  state: 'waiting' | 'missed' | 'failed';
  error: string | null;
};
```

There is no `fired` state. A one-shot item that fires is removed from the queue.
`missed` and `failed` items stay in the list so the user can see what happened and
re-arm or delete them.

**The account an item belongs to** (needed for the drain rule) is
`action.account` for a `create`, and the target session's `account` for a `send`
or `resume`.

### Persistence

`state.json` becomes `{ sessions, usage, queue }`. `Registry` already owns the
single save/load path and already serializes `Usage` this way; the `Scheduler`
instance is handed to it the same way. `Registry.load` tolerates a missing or
malformed `queue` — dropping bad items rather than throwing — matching the
tolerance it already has for the legacy bare-array shape and for a `sessions`
value that isn't an array.

## Component boundaries

**`Scheduler` (`src/schedule.ts`) decides, it does not act.** It holds the item
list, serializes it, and answers `due(now, ctx)` with the items that should fire.
It launches nothing and imports no adapter — the only state it touches is its own
list (it marks overdue items `missed` as it scans). This is what makes it testable
against a fake clock.

`ctx` is what `due()` needs from the outside world, passed in rather than reached
for: for each account, whether it is free, and whether it currently has a session
in `working` or `needs-you`.

**`server.ts` owns firing.** A due item is routed straight back through the
existing `command()` function — a scheduled create is literally
`command({ cmd: 'create', repo, branch, account, prompt })`. There is no second
launch path to keep in sync with the first, and scheduled actions inherit
`command()`'s existing validation and error handling for free.

## Is the account free?

Checked in this order, by a helper on `Usage`:

1. `resetAt(account)` exists and `now < it` → **not free**. The account is known
   to be limited; do not consult the estimate.
2. `resetAt(account)` exists and `now >= it` → **free**. A reset time in the past
   means the window has rolled.
3. No timestamp at all (a Codex account, or a Claude account that has never hit a
   limit) → free when `pace(account, budget) < RESET_PACE`.

`RESET_PACE = 0.8` is a named constant carrying a `ponytail:` comment marking it
as a calibration knob. `pace()` is an estimate against a `budget` the user
hand-tuned in `accounts.json`, so the threshold that reads it has to be tunable
too.

### Storing the reset time

A new adapter event, emitted only by the Claude adapter:

```ts
| { type: 'rate-limit'; status: 'allowed' | 'allowed_warning' | 'rejected'; resetsAt: number | null }
```

`normalizeClaude` grows a branch for `m.type === 'rate_limit_event'` that emits
it. The reset timestamp is stored on `Usage`, not on a `Session`, because it is
per-account state — the same reason `pace()` lives there. Two new methods:

- `noteLimit(account, status, resetsAt)` — records the timestamp; a `status` of
  `'allowed'` clears the entry instead, so a stale limit does not linger and
  suppress the estimate fallback forever.
- `resetAt(account): number | null`.

`Usage.toJSON()` changes shape from a bare `Record<string, Sample[]>` to
`{ samples, resets }`. `restore()` accepts both shapes, so an existing
`state.json` keeps its usage history across the upgrade — the same
back-compatibility the file already implements twice.

**Unit normalization:** the SDK types `resetsAt` as `number` with no documented
unit. Normalize on ingest with `t < 1e12 ? t * 1000 : t` and a comment. This is
correct whether the SDK sends seconds or milliseconds, for any timestamp between
1970 and the year 33658.

## Firing

One `setInterval(TICK_MS)` in `createServer`, with `TICK_MS = 30_000`. It is
`unref()`'d and cleared on the server's `'close'` event, exactly like the existing
coalesced-save timer — for the same reasons documented there: the timer must never
be the reason the process stays alive, and a closed server must not fire into a
deleted state directory.

30-second granularity is deliberate: the UI picker is minute-resolution.

`due(now, ctx)` applies two rules.

**`at` items** fire at their time. If `now - time > GRACE_MS`, the item flips to
`missed` and does not fire. `GRACE_MS = 12 * 3600_000`, a named constant with a
`ponytail:` comment. This needs no special first-tick handling: a server that was
down and a laptop that slept are the same case, and both are covered by comparing
the item's time to the current clock on an ordinary tick.

**`reset` items** fire only when both hold:

- the account is free, per the three-step check above; and
- that account has no session currently in `working` or `needs-you`.

The second condition *is* the "one at a time per account" drain, with no queue
lock or in-flight bookkeeping: item 1 fires, its session goes to `working`, later
ticks see the account busy and skip, and when it reaches `done` or `stopped` the
next item fires. If the limit is hit again mid-drain, the remaining items simply
stay queued.

**The busy-check applies only to `reset` items.** A time-triggered item fires at
its time regardless of what else is running — the user asked for 3pm, and another
session being active does not change that. Two `at` items scheduled on the same
account at the same minute both fire; that is the user explicitly asking for it.

## Auto-requeue on a limit stop

In the emit callback inside `launch()`, on a `stopped` event, enqueue a
`reset`-triggered `resume` for the same session when **both** conditions hold:

- `dead` is truthy. This is the existing local in that callback, which already
  distinguishes "the agent died on its own" from "we killed it" — both the `stop`
  and `delete` commands remove the handle from the map *before* calling `stop()`.
  So pressing Stop never auto-requeues, and no new state is needed to tell the
  two apart.
- `usage.resetAt(account)` is non-null and greater than `now` — the account is
  currently past its limit. (Written explicitly rather than leaning on `null >
  now` being false.)

No parsing of error message strings, and no new per-session flag.

**Known false positive:** a session that stops for an unrelated reason *during* a
limit window will also be queued for auto-resume. This is accepted rather than
guarded, because the cost is visible and cheap — the item appears in the queue
strip and the user can delete it — while every available guard requires matching
on error text, which is exactly the brittleness this design avoids.

## HTTP surface

Two new commands in `command()`:

- `schedule` — body `{ trigger, action }`. Validates and adds.
- `unschedule` — body `{ itemId }`. Removes.

There is no list command. The queue rides the existing SSE snapshot: `snapshot()`
grows a `queue` field alongside `sessions` and `accounts`, so the browser gets
queue updates through the same push it already gets session updates through.

### Validation at schedule time

`schedule` is a trust boundary and validates before accepting:

- the account named in a `create` action exists in `accounts.json`;
- the session named in a `send` or `resume` action exists in the registry;
- an `at` trigger's `time` is a finite number;
- a `create` action's `repo` resolves to a real directory;
- the prompt/text is a non-empty string.

The point is that a typo surfaces when you schedule it, not at 3am.

Validation at *fire* time is `command()`'s own, unchanged. A scheduled `create`
whose branch has since been taken, or a `send` to a session with no live agent,
fails exactly as an interactive one would. The item's `state` becomes `'failed'`
with the error recorded, and it stays visible in the queue strip rather than
disappearing silently.

## UI

- **New worktree dialog** gains a `Run` `<select>`: `Now` / `At a time…` / `When
  usage resets`. Choosing a time reveals a native `<input type="datetime-local">`.
  Choosing "When usage resets" reveals nothing further — the account is already a
  field in that dialog.
- **Chat composer** gains a ⏱ button beside Send, opening the same picker. It
  turns the typed message into a scheduled `send`, or a scheduled `resume` when
  the session is `stopped`.
- **Queue strip** at the top of the grid: a `3 scheduled` header over one row per
  item showing its trigger, its target and a ✕ delete control. `missed` and
  `failed` rows show their reason inline. Rendered from the snapshot's new
  `queue` field.
- **Stopped cards** whose resume is queued show a `waiting for reset` line, read
  from that same snapshot data — no extra request.

The picker markup is one `<dialog>` shared by both entry points.

## Testing

`test/schedule.test.ts`, against a fake clock and a stub `ctx`:

- an `at` item before / exactly at / after its time;
- the grace boundary on both sides — just inside fires, just outside marks `missed`;
- a `reset` item with a future `resetsAt` (not due), a past one (due), and none at
  all (falls to pace, tested in both directions across `RESET_PACE`);
- the per-account drain: two `reset` items on one account, second held while the
  account has a `working` session, released when it does not;
- an `at` item firing while its account is busy — the busy-check must not apply;
- `toJSON` / `restore` round-trip, and `restore` of malformed input.

`test/usage.test.ts` gains: `noteLimit` / `resetAt`; a `'allowed'` status clearing
a stored reset; the seconds-vs-milliseconds normalization; and `restore` of both
the old bare-map shape and the new `{ samples, resets }` shape.

`test/agents-claude.test.ts` gains a `normalizeClaude` case for a
`rate_limit_event` message.

`test/server.test.ts` gains: `schedule` rejecting each invalid body above, and one
test that a due item fires through `command()` on a tick.

## Deliberately out of scope

- **A notification when an item fires.** The existing `needs-you` browser
  notification already covers the case that actually needs a human.
- **Timezone handling** beyond what `datetime-local` provides. It yields a local
  wall-clock string, converted to epoch ms once at schedule time. That is correct
  for one-shot items on a single machine, which is all Switchboard runs on.
- **Recurrence** in any form.
