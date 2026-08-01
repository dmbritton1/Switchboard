# Scheduling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user schedule a chat to run at a chosen day and time, or queue it to run when an account's usage window resets — including automatically re-queuing a session that a rate limit killed.

**Architecture:** A new `Scheduler` (`src/schedule.ts`) holds a list of one-shot queued items and answers `due(now, ctx)`. It launches nothing. A 30-second tick in `server.ts` feeds each due item straight back through the *existing* `command()` function, so a scheduled create is literally `command({ cmd: 'create', ... })` and there is no second launch path. "Usage has reset" comes from the Claude SDK's `rate_limit_event` (a real `resetsAt` timestamp), stored on `Usage` next to `pace()`, falling back to the local `pace()` estimate for Codex and for accounts that have never been limited.

**Tech Stack:** Node >= 22.18 running TypeScript directly (no build step), `node:test` + `node:assert`, `@anthropic-ai/claude-agent-sdk` 0.3.220, vanilla DOM in `web/app.js`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-01-scheduling-design.md`

## Global Constraints

- **No new dependencies.** Everything here is stdlib or already installed.
- **No build step.** Node runs the `.ts` files directly. All intra-project imports carry the `.ts` extension (e.g. `import { Usage } from './usage.ts'`).
- **Tests are `node --test test/*.test.ts`**, using `node:test` + `node:assert`. Run with `npm test`.
- **All time values passed between modules are epoch milliseconds.** Functions that read the clock take a trailing `now = Date.now()` parameter so tests can inject one — this is the existing convention in `src/usage.ts`.
- **Deliberate simplifications get a `ponytail:` comment** naming the ceiling and the upgrade path.
- **Scheduled items are one-shot.** No recurrence anywhere.
- Two named constants, each living with the code that reads it: `RESET_PACE = 0.8` in `src/usage.ts` (Task 1) and `GRACE_MS = 12 * 3600_000` in `src/schedule.ts` (Task 3).

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/usage.ts` (modify) | Per-account capacity. Gains the stored reset timestamp and the `free()` verdict. | 1 |
| `test/usage.test.ts` (modify) | Covers the above. | 1 |
| `src/types.ts` (modify) | Gains the `rate-limit` adapter event, then `Trigger` / `Action` / `Queued`. | 2, 3 |
| `src/agents/claude.ts` (modify) | Emits `rate-limit` from the SDK's `rate_limit_event`. | 2 |
| `src/sessions.ts` (modify) | Ignores `rate-limit` in `apply()`; persists the queue. | 2, 4 |
| `src/schedule.ts` (create) | Holds queued items, decides which are due. Imports no adapter, launches nothing. | 3 |
| `test/schedule.test.ts` (create) | Covers `due()` against a fake clock and a stub ctx. | 3 |
| `src/server.ts` (modify) | Records rate limits, owns the `schedule`/`unschedule` commands, the tick, and auto-requeue. | 2, 4, 5, 6, 7 |
| `test/server.test.ts` (modify) | Covers validation, the tick, and auto-requeue. | 5, 6, 7 |
| `web/index.html`, `web/app.js`, `web/style.css` (modify) | The when-picker and the queue strip. | 8 |

---

### Task 1: `Usage` learns when an account is limited

Pure data. Nothing else in the app changes yet.

**Files:**
- Modify: `src/usage.ts`
- Test: `test/usage.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `Usage.noteLimit(account: string, status: 'allowed' | 'allowed_warning' | 'rejected', resetsAt: number | null): void`
  - `Usage.resetAt(account: string): number | null`
  - `Usage.free(account: string, budget: number, now?: number): boolean`
  - `Usage.toJSON(): { samples: Record<string, Sample[]>; resets: Record<string, number> }` — **shape change**
  - exported `const RESET_PACE = 0.8`

- [ ] **Step 1: Write the failing tests**

Append to `test/usage.test.ts`:

```ts
test('a rejected rate limit stores its reset time; allowed clears it', () => {
  const u = new Usage();
  u.noteLimit('main', 'rejected', 5 * HOUR);
  assert.equal(u.resetAt('main'), 5 * HOUR);

  u.noteLimit('main', 'allowed', null);
  assert.equal(u.resetAt('main'), null);
});

test('allowed_warning clears a stored limit — a warning still means allowed', () => {
  const u = new Usage();
  u.noteLimit('main', 'rejected', 5 * HOUR);
  u.noteLimit('main', 'allowed_warning', 5 * HOUR);
  assert.equal(u.resetAt('main'), null,
    'a warning means there is still room; storing its resetsAt would block work that is allowed');
});

test('a rejection with no reset time stores nothing', () => {
  const u = new Usage();
  u.noteLimit('main', 'rejected', null);
  assert.equal(u.resetAt('main'), null);
});

test('resetsAt in seconds is normalized to milliseconds', () => {
  const u = new Usage();
  // The SDK types resetsAt as a bare `number` with no documented unit.
  u.noteLimit('sec', 'rejected', 1_800_000_000);        // seconds
  u.noteLimit('ms', 'rejected', 1_800_000_000_000);     // milliseconds
  assert.equal(u.resetAt('sec'), 1_800_000_000_000);
  assert.equal(u.resetAt('ms'), 1_800_000_000_000);
});

test('free() prefers a known reset time over the pace estimate', () => {
  const u = new Usage();
  u.noteLimit('main', 'rejected', 5 * HOUR);
  // No samples at all, so pace() is 0 — but a known future reset must win.
  assert.equal(u.free('main', 1000, 4 * HOUR), false);
  assert.equal(u.free('main', 1000, 5 * HOUR), true, 'now === resetsAt means the window has rolled');
  assert.equal(u.free('main', 1000, 6 * HOUR), true);
});

test('free() falls back to the pace estimate when no reset time is known', () => {
  const u = new Usage();
  u.record('busy', 450, 450, 0);   // 900 of 1000 = 0.90, over RESET_PACE
  u.record('calm', 350, 350, 0);   // 700 of 1000 = 0.70, under RESET_PACE
  assert.equal(u.free('busy', 1000, 0), false);
  assert.equal(u.free('calm', 1000, 0), true);
});

test('toJSON/restore round-trips both samples and resets', () => {
  const u = new Usage();
  u.record('main', 100, 100, 0);
  u.noteLimit('main', 'rejected', 5 * HOUR);

  const back = new Usage();
  back.restore(JSON.parse(JSON.stringify(u.toJSON())), 0);
  assert.equal(back.pace('main', 1000, 0), 0.2);
  assert.equal(back.resetAt('main'), 5 * HOUR);
});

test('restore still accepts the old bare account-to-samples map', () => {
  // state.json written before resets existed is a bare map, not { samples, resets }.
  const u = new Usage();
  u.restore({ main: [{ t: 0, tokens: 200 }] }, 0);
  assert.equal(u.pace('main', 1000, 0), 0.2);
  assert.equal(u.resetAt('main'), null);
});

test('restore ignores a malformed resets block', () => {
  const u = new Usage();
  u.restore({ samples: {}, resets: { a: 'soon', b: NaN, c: 5 * HOUR } }, 0);
  assert.equal(u.resetAt('a'), null);
  assert.equal(u.resetAt('b'), null);
  assert.equal(u.resetAt('c'), 5 * HOUR);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `u.noteLimit is not a function`.

- [ ] **Step 3: Implement it**

In `src/usage.ts`, add the constant below the existing `WINDOW_MS`:

```ts
/** ponytail: calibration knob. `budget` in accounts.json is hand-tuned per
 *  account, so the threshold that reads pace() has to be tunable too. Lower it
 *  if queued work keeps re-hitting the limit; raise it if items sit too long. */
export const RESET_PACE = 0.8;
```

Add the field beside `#samples`:

```ts
  /** account -> epoch ms at which its window rolls. Only set while the account is
   *  actually rejected; an `allowed` event deletes the entry so a stale limit
   *  can't suppress the pace fallback forever. */
  #resets = new Map<string, number>();
```

Add the three methods:

```ts
  /** Records what the provider said about this account's rate limit. Only a
   *  `rejected` status stores a reset time: `allowed_warning` means there is
   *  still room, so storing its resetsAt would block work that is allowed. */
  noteLimit(
    account: string,
    status: 'allowed' | 'allowed_warning' | 'rejected',
    resetsAt: number | null,
  ): void {
    if (status !== 'rejected' || resetsAt === null || !Number.isFinite(resetsAt)) {
      this.#resets.delete(account);
      return;
    }
    // The SDK types resetsAt as a bare `number` with no documented unit. This is
    // correct either way for any timestamp between 1970 and the year 33658.
    this.#resets.set(account, resetsAt < 1e12 ? resetsAt * 1000 : resetsAt);
  }

  resetAt(account: string): number | null {
    return this.#resets.get(account) ?? null;
  }

  /** Is there room to start work on this account right now? A known reset time
   *  is authoritative — the provider told us. Only when we have none (a Codex
   *  account, whose SDK reports no rate limits at all, or a Claude account that
   *  has never been rejected) do we fall back to the local estimate. */
  free(account: string, budget: number, now = Date.now()): boolean {
    const reset = this.#resets.get(account);
    if (reset !== undefined) return now >= reset;
    return this.pace(account, budget, now) < RESET_PACE;
  }
```

Replace `toJSON`:

```ts
  /** Serialized into state.json alongside sessions so pace and known limits
   *  survive a restart. */
  toJSON(): { samples: Record<string, Sample[]>; resets: Record<string, number> } {
    return {
      samples: Object.fromEntries(this.#samples),
      resets: Object.fromEntries(this.#resets),
    };
  }
```

Replace `restore`:

```ts
  /** Inverse of toJSON(). Tolerates anything: state.json is user-editable and may
   *  predate usage persistence entirely, so bad input is dropped, not thrown on. */
  restore(data: unknown, now = Date.now()): void {
    if (!data || typeof data !== 'object') return;
    const d = data as Record<string, unknown>;
    // Two shapes to read. The old one is a bare account -> Sample[] map; the new
    // one is { samples, resets }. An account can't be mistaken for the new shape
    // because its value is an array, and `samples` never is.
    const isNew = !!d.samples && typeof d.samples === 'object' && !Array.isArray(d.samples);
    const samples = (isNew ? d.samples : d) as Record<string, unknown>;

    const cutoff = now - WINDOW_MS;
    for (const [account, list] of Object.entries(samples)) {
      if (!Array.isArray(list)) continue;
      const kept = (list as Sample[]).filter(
        (s) => s && typeof s.t === 'number' && typeof s.tokens === 'number' && s.t > cutoff,
      );
      if (kept.length) this.#samples.set(account, kept);
    }

    if (isNew && d.resets && typeof d.resets === 'object') {
      for (const [account, t] of Object.entries(d.resets as Record<string, unknown>)) {
        if (typeof t === 'number' && Number.isFinite(t)) this.#resets.set(account, t);
      }
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — all of `test/usage.test.ts`, including the pre-existing tests. The existing `record prunes samples...` test asserts on `u.toJSON().main`, which the shape change breaks; update that one assertion to `u.toJSON().samples.main` (two occurrences in that test).

- [ ] **Step 5: Commit**

```bash
git add src/usage.ts test/usage.test.ts
git commit -m "feat: Usage tracks per-account rate-limit reset times"
```

---

### Task 2: The Claude adapter reports rate limits, end to end

After this task the app knows, at any moment, whether an account is past its limit — but nothing uses that knowledge yet.

**Files:**
- Modify: `src/types.ts` (add one `AdapterEvent` member)
- Modify: `src/agents/claude.ts` (one branch in `normalizeClaude`)
- Modify: `src/sessions.ts` (one `case` in `apply`)
- Modify: `src/server.ts:158` (one line in `launch`'s emit callback)
- Test: `test/agents-claude.test.ts`

**Interfaces:**
- Consumes: `Usage.noteLimit(account, status, resetsAt)` from Task 1.
- Produces: `AdapterEvent` member `{ type: 'rate-limit'; status: 'allowed' | 'allowed_warning' | 'rejected'; resetsAt: number | null }`.

- [ ] **Step 1: Write the failing test**

Append to `test/agents-claude.test.ts`:

```ts
test('a rate_limit_event becomes a rate-limit adapter event', () => {
  const events = replay([{
    type: 'rate_limit_event',
    rate_limit_info: { status: 'rejected', resetsAt: 1_800_000_000, rateLimitType: 'five_hour' },
    uuid: 'u1',
    session_id: 's1',
  }]);
  assert.deepEqual(events, [
    { type: 'rate-limit', status: 'rejected', resetsAt: 1_800_000_000 },
  ]);
});

test('a rate_limit_event with no resetsAt reports null rather than undefined', () => {
  const events = replay([{
    type: 'rate_limit_event',
    rate_limit_info: { status: 'allowed' },
    uuid: 'u1',
    session_id: 's1',
  }]);
  assert.deepEqual(events, [{ type: 'rate-limit', status: 'allowed', resetsAt: null }]);
});

test('a rate_limit_event does not report a vendor session id', () => {
  // It carries session_id like almost every SDK message. Only subtype:'init'
  // system messages are meant to report session identity — see normalizeClaude.
  const events = replay([{
    type: 'rate_limit_event',
    rate_limit_info: { status: 'allowed' },
    uuid: 'u1',
    session_id: 's1',
  }]);
  assert.ok(!events.some((e) => e.type === 'vendor-session-id'));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `normalizeClaude` returns `[]` for that message, so `deepEqual` reports an empty array.

- [ ] **Step 3: Implement it**

In `src/types.ts`, add to the `AdapterEvent` union, after the `usage` member:

```ts
  // Claude only. The Codex SDK has no rate-limit concept anywhere in its types,
  // so a Codex account never produces this and falls back to the pace estimate.
  | { type: 'rate-limit'; status: 'allowed' | 'allowed_warning' | 'rejected'; resetsAt: number | null }
```

In `src/agents/claude.ts`, add this branch in `normalizeClaude` immediately after the `m.type === 'system'` block:

```ts
  // SDKRateLimitEvent (sdk.d.ts) is a member of the SDKMessage union, so it
  // arrives through the same for-await loop as everything else — the real reset
  // timestamp costs no extra plumbing. The status is passed through as reported;
  // deciding what a rejection means is Usage#noteLimit's job, not this one's.
  if (m.type === 'rate_limit_event') {
    const info = (m as { rate_limit_info?: { status?: string; resetsAt?: number } }).rate_limit_info;
    if (info?.status) {
      out.push({
        type: 'rate-limit',
        status: info.status as 'allowed' | 'allowed_warning' | 'rejected',
        resetsAt: typeof info.resetsAt === 'number' ? info.resetsAt : null,
      });
    }
    return out;
  }
```

In `src/sessions.ts`, add a case to the switch in `apply()`, next to the existing `usage` case:

```ts
      case 'rate-limit':
        break; // per-account, not per-session — handled by the caller, which owns Usage
```

In `src/server.ts`, inside `launch()`'s emit callback, beside the existing usage line:

```ts
      if (e.type === 'usage') usage.record(account.name, e.inputTokens, e.outputTokens);
      if (e.type === 'rate-limit') usage.noteLimit(account.name, e.status, e.resetsAt);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, whole suite.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/agents/claude.ts src/sessions.ts src/server.ts test/agents-claude.test.ts
git commit -m "feat: surface Claude rate-limit events into Usage"
```

---

### Task 3: The `Scheduler`

A self-contained module: it holds items and decides which are due. It imports no adapter and launches nothing, which is what makes it testable against a fake clock. Nothing calls it yet.

**Files:**
- Modify: `src/types.ts`
- Create: `src/schedule.ts`
- Test: `test/schedule.test.ts` (create)

**Interfaces:**
- Consumes: nothing at runtime.
- Produces:
  - types `Trigger`, `Action`, `Queued` in `src/types.ts`
  - `type Ctx = { free(account: string): boolean; busy(account: string): boolean }`
  - `class Scheduler` with `add(trigger, action, now?): Queued`, `remove(id): void`, `fail(id, error): void`, `all(): Queued[]`, `due(now, ctx): Queued[]`, `toJSON(): Queued[]`, `restore(data: unknown): void`
  - exported `const GRACE_MS = 12 * 3600_000`

- [ ] **Step 1: Add the types**

In `src/types.ts`, append:

```ts
export type Trigger =
  /** Fire at this wall-clock moment (epoch ms). */
  | { kind: 'at'; time: number }
  /** Fire once this account's usage window has room again. */
  | { kind: 'reset'; account: string };

export type Action =
  | { kind: 'create'; repo: string; branch: string; account: string; prompt: string }
  | { kind: 'send'; sessionId: string; text: string }
  | { kind: 'resume'; sessionId: string; prompt: string };

/** A one-shot queued chat. There is no `fired` state: an item that fires is
 *  removed. `missed` and `failed` stick around so the user can see what happened
 *  and re-arm or delete them. */
export type Queued = {
  id: string;
  trigger: Trigger;
  action: Action;
  createdAt: number;
  state: 'waiting' | 'missed' | 'failed';
  error: string | null;
};
```

- [ ] **Step 2: Write the failing tests**

Create `test/schedule.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { Scheduler, GRACE_MS } from '../src/schedule.ts';
import type { Ctx } from '../src/schedule.ts';
import type { Action } from '../src/types.ts';

const HOUR = 3600_000;

/** Every account free and idle unless the test says otherwise. */
function ctx(over: Partial<Ctx> = {}): Ctx {
  return { free: () => true, busy: () => false, ...over };
}

const CREATE: Action = {
  kind: 'create', repo: '/r', branch: 'b', account: 'main', prompt: 'go',
};

test('an at-item is not due before its time, and is due at and after it', () => {
  const s = new Scheduler();
  s.add({ kind: 'at', time: 10 * HOUR }, CREATE, 0);

  assert.equal(s.due(9 * HOUR, ctx()).length, 0);
  assert.equal(s.due(10 * HOUR, ctx()).length, 1);
  assert.equal(s.due(11 * HOUR, ctx()).length, 1);
});

test('an at-item overdue by more than the grace window is marked missed, not fired', () => {
  const s = new Scheduler();
  s.add({ kind: 'at', time: 0 }, CREATE, 0);

  assert.equal(s.due(GRACE_MS, ctx()).length, 1, 'exactly at the boundary still fires');

  const s2 = new Scheduler();
  s2.add({ kind: 'at', time: 0 }, CREATE, 0);
  assert.equal(s2.due(GRACE_MS + 1, ctx()).length, 0);
  assert.equal(s2.all()[0].state, 'missed');
});

test('a missed item stays in the list and is never reconsidered', () => {
  const s = new Scheduler();
  s.add({ kind: 'at', time: 0 }, CREATE, 0);
  s.due(GRACE_MS + 1, ctx());

  assert.equal(s.all().length, 1);
  assert.equal(s.due(GRACE_MS + 2, ctx()).length, 0, 'only `waiting` items are ever due');
});

test('an at-item fires even when its account is busy', () => {
  // The user asked for a time. Another session running does not change that.
  const s = new Scheduler();
  s.add({ kind: 'at', time: 0 }, CREATE, 0);
  assert.equal(s.due(0, ctx({ busy: () => true })).length, 1);
});

test('a reset-item waits until the account is free', () => {
  const s = new Scheduler();
  s.add({ kind: 'reset', account: 'main' }, CREATE, 0);

  assert.equal(s.due(HOUR, ctx({ free: () => false })).length, 0);
  assert.equal(s.due(HOUR, ctx({ free: () => true })).length, 1);
});

test('a reset-item waits while its account has a session running', () => {
  const s = new Scheduler();
  s.add({ kind: 'reset', account: 'main' }, CREATE, 0);

  assert.equal(s.due(HOUR, ctx({ busy: () => true })).length, 0);
  assert.equal(s.due(HOUR, ctx({ busy: () => false })).length, 1);
});

test('two reset-items on one account drain one at a time, oldest first', () => {
  const s = new Scheduler();
  const first = s.add({ kind: 'reset', account: 'main' }, CREATE, 0);
  const second = s.add({ kind: 'reset', account: 'main' }, CREATE, 1);

  const batch = s.due(HOUR, ctx());
  assert.equal(batch.length, 1, 'a fresh window must not be blown by both at once');
  assert.equal(batch[0].id, first.id);

  // The caller removes a fired item; the next tick releases the second.
  s.remove(first.id);
  assert.equal(s.due(2 * HOUR, ctx())[0].id, second.id);
});

test('reset-items on different accounts drain in the same pass', () => {
  const s = new Scheduler();
  s.add({ kind: 'reset', account: 'a' }, { ...CREATE, account: 'a' }, 0);
  s.add({ kind: 'reset', account: 'b' }, { ...CREATE, account: 'b' }, 0);
  assert.equal(s.due(HOUR, ctx()).length, 2, 'one busy account must not serialize another');
});

test('free/busy are asked about the trigger account, not a global', () => {
  const s = new Scheduler();
  s.add({ kind: 'reset', account: 'b' }, CREATE, 0);
  const asked: string[] = [];
  s.due(HOUR, ctx({ free: (a) => { asked.push(a); return true; } }));
  assert.deepEqual(asked, ['b']);
});

test('fail() takes an item out of contention and records why', () => {
  const s = new Scheduler();
  const item = s.add({ kind: 'at', time: 0 }, CREATE, 0);
  s.fail(item.id, 'branch already exists');

  assert.equal(s.all()[0].state, 'failed');
  assert.equal(s.all()[0].error, 'branch already exists');
  assert.equal(s.due(HOUR, ctx()).length, 0);
});

test('toJSON/restore round-trips the queue', () => {
  const s = new Scheduler();
  const item = s.add({ kind: 'at', time: 10 * HOUR }, CREATE, 0);

  const back = new Scheduler();
  back.restore(JSON.parse(JSON.stringify(s.toJSON())));
  assert.equal(back.all().length, 1);
  assert.equal(back.all()[0].id, item.id);
  assert.equal(back.due(10 * HOUR, ctx()).length, 1);
});

test('restore drops malformed items rather than throwing', () => {
  // state.json is hand-editable, so treat it as untrusted.
  const s = new Scheduler();
  s.restore('not an array');
  s.restore([null, {}, { id: 7 }, { id: 'ok', trigger: { kind: 'at', time: 0 } }]);
  assert.equal(s.all().length, 0, 'an item with no action is not usable');
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/schedule.ts'`.

- [ ] **Step 4: Implement `src/schedule.ts`**

```ts
import { randomUUID } from 'node:crypto';
import type { Action, Queued, Trigger } from './types.ts';

/**
 * How late a timed item may still fire. The server kills every agent when it
 * stops, so a scheduled time routinely passes while Switchboard is down or the
 * laptop is asleep; firing on the next start is almost always what "run this"
 * meant. Past this window it isn't — a week-old item firing on boot is noise.
 *
 * ponytail: one constant, no per-item override. Add one if you start scheduling
 * things further out than this.
 */
export const GRACE_MS = 12 * 3600_000;

/** What `due()` needs to know about the world, passed in rather than reached
 *  for — this is what keeps the Scheduler testable with a fake clock. */
export type Ctx = {
  /** Is there room to start work on this account right now? */
  free(account: string): boolean;
  /** Does this account have a session in `working` or `needs-you`? */
  busy(account: string): boolean;
};

/**
 * The queue of one-shot scheduled chats.
 *
 * It decides, it does not act: `due()` returns the items that should fire and
 * the caller runs them (through the server's existing `command()`), then calls
 * `remove()` on success or `fail()` on error. The only state this class touches
 * is its own list.
 */
export class Scheduler {
  #items = new Map<string, Queued>();

  add(trigger: Trigger, action: Action, now = Date.now()): Queued {
    const item: Queued = {
      id: randomUUID(), trigger, action, createdAt: now, state: 'waiting', error: null,
    };
    this.#items.set(item.id, item);
    return item;
  }

  remove(id: string): void {
    this.#items.delete(id);
  }

  fail(id: string, error: string): void {
    const item = this.#items.get(id);
    if (!item) return;
    item.state = 'failed';
    item.error = error;
  }

  all(): Queued[] {
    return [...this.#items.values()];
  }

  /**
   * The items that should fire now. Marks overdue timed items `missed` as it
   * scans — the one piece of state it mutates.
   *
   * Map iteration is insertion order, so a per-account drain is FIFO: the oldest
   * queued item on an account goes first.
   */
  due(now: number, ctx: Ctx): Queued[] {
    const out: Queued[] = [];
    // Accounts already claimed in this same pass. Without it, two reset-items on
    // one account both fire before either has had a chance to reach `working`,
    // and a freshly reset window is spent in seconds.
    const claimed = new Set<string>();

    for (const item of this.#items.values()) {
      if (item.state !== 'waiting') continue;

      if (item.trigger.kind === 'at') {
        if (now < item.trigger.time) continue;
        if (now - item.trigger.time > GRACE_MS) {
          item.state = 'missed';
          item.error = `overdue by more than ${GRACE_MS / 3600_000}h`;
          continue;
        }
        // Deliberately no free/busy check: the user named a time.
        out.push(item);
        continue;
      }

      const account = item.trigger.account;
      if (claimed.has(account)) continue;
      if (!ctx.free(account) || ctx.busy(account)) continue;
      claimed.add(account);
      out.push(item);
    }
    return out;
  }

  toJSON(): Queued[] {
    return this.all();
  }

  /** Inverse of toJSON(). state.json is hand-editable, so anything that isn't a
   *  usable item is dropped rather than thrown on — the same tolerance
   *  Registry.load already applies to `sessions`. */
  restore(data: unknown): void {
    if (!Array.isArray(data)) return;
    for (const raw of data as Queued[]) {
      if (!raw || typeof raw.id !== 'string') continue;
      if (!raw.trigger || typeof raw.trigger !== 'object') continue;
      if (!raw.action || typeof raw.action !== 'object') continue;
      this.#items.set(raw.id, raw);
    }
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, whole suite.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/schedule.ts test/schedule.test.ts
git commit -m "feat: add the Scheduler queue and its due() rules"
```

---

### Task 4: Persist the queue in `state.json`

**Files:**
- Modify: `src/sessions.ts` (constructor, `#writeNow`, `load`)
- Modify: `src/server.ts:528-535` (the entry point)
- Test: `test/sessions.test.ts`

**Interfaces:**
- Consumes: `Scheduler` from Task 3, with `toJSON()` / `restore()`.
- Produces: `new Registry(path, usage?, scheduler?)` and `Registry.load(path, usage?, scheduler?)`. `state.json` is now `{ sessions, usage, queue }`.

- [ ] **Step 1: Write the failing test**

Append to `test/sessions.test.ts` (it already imports `Registry`, `mkdtemp`, `join`, `tmpdir`, `rm`; add `import { Scheduler } from '../src/schedule.ts';` at the top):

```ts
test('the queue round-trips through state.json', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sb-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');

  const sched = new Scheduler();
  sched.add({ kind: 'at', time: 123 }, {
    kind: 'create', repo: '/r', branch: 'b', account: 'main', prompt: 'go',
  });
  await new Registry(path, undefined, sched).save();

  const back = new Scheduler();
  await Registry.load(path, undefined, back);
  assert.equal(back.all().length, 1);
  assert.equal(back.all()[0].trigger.kind, 'at');
});

test('a state.json with no queue key loads cleanly', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sb-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  await writeFile(path, JSON.stringify({ sessions: [], usage: {} }));

  const sched = new Scheduler();
  await Registry.load(path, undefined, sched);
  assert.equal(sched.all().length, 0);
});
```

If `writeFile` isn't already imported in that test file, add it to the `node:fs/promises` import.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — the restored scheduler is empty, because `save()` never wrote a `queue` key.

- [ ] **Step 3: Implement it**

In `src/sessions.ts`, add the import and field:

```ts
import type { Scheduler } from './schedule.ts';
```

```ts
  // Optional for the same reason #usage is: tests that only care about sessions
  // shouldn't have to build one. The Registry owns the single save/load path, so
  // persisting the queue means handing it the Scheduler rather than inventing a
  // second state file.
  #scheduler: Scheduler | undefined;
```

Update the constructor:

```ts
  constructor(path: string, usage?: Usage, scheduler?: Scheduler) {
    this.#path = path;
    this.#usage = usage;
    this.#scheduler = scheduler;
  }
```

Update `#writeNow`'s state object:

```ts
    const state = {
      sessions: this.all(),
      usage: this.#usage?.toJSON() ?? {},
      queue: this.#scheduler?.toJSON() ?? [],
    };
```

Update `load`'s signature and add the restore call beside the usage one:

```ts
  static async load(path: string, usage?: Usage, scheduler?: Scheduler): Promise<Registry> {
    const reg = new Registry(path, usage, scheduler);
```

```ts
      if (isNew) {
        usage?.restore((parsed as { usage?: unknown }).usage);
        // Absent in any state.json written before scheduling existed; restore()
        // drops a non-array, so the missing key needs no special case here.
        scheduler?.restore((parsed as { queue?: unknown }).queue);
      }
```

In `src/server.ts`'s entry point at the bottom:

```ts
  const usage = new Usage();
  const scheduler = new Scheduler();
  const registry = await Registry.load(statePath, usage, scheduler);
  createServer({ registry, usage, scheduler, accounts })
    .listen(4711, '127.0.0.1', () => console.log('switchboard on http://127.0.0.1:4711'));
```

Add `import { Scheduler } from './schedule.ts';` at the top of `src/server.ts`, and add `scheduler: Scheduler` to `createServer`'s options type and its destructure:

```ts
export function createServer(opts: {
  registry: Registry;
  usage: Usage;
  scheduler: Scheduler;
  accounts: Account[];
}): Server {
  const { registry, usage, scheduler, accounts } = opts;
```

`test/server.test.ts`'s `boot()` helper must now pass one. Update it:

```ts
  const registry = new Registry(join(dir, 'state.json'));
  const usage = new Usage();
  const scheduler = new Scheduler();
  const server = createServer({ registry, usage, scheduler, accounts });
```

...with `import { Scheduler } from '../src/schedule.ts';` added, and return `scheduler` alongside `base` and `registry` so later tasks' tests can reach it:

```ts
  return { base: `http://127.0.0.1:${port}`, registry, usage, scheduler, server };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, whole suite.

- [ ] **Step 5: Commit**

```bash
git add src/sessions.ts src/server.ts test/sessions.test.ts test/server.test.ts
git commit -m "feat: persist the scheduled queue in state.json"
```

---

### Task 5: `schedule` and `unschedule` commands

**Files:**
- Modify: `src/server.ts` (`snapshot()`, `command()`)
- Test: `test/server.test.ts`

**Interfaces:**
- Consumes: `Scheduler.add/remove/all` (Task 3), `Usage` (Task 1).
- Produces:
  - `POST /command { cmd: 'schedule', trigger, action }` → `200 { id }` or `400 { error }`
  - `POST /command { cmd: 'unschedule', itemId }` → `200 { ok: true }`
  - the SSE snapshot gains a `queue` field

**Wire shape note:** a `reset` trigger is sent by the client as bare `{ kind: 'reset' }`. The server fills in `account` from the action — derived, never trusted — so a mismatch between "which account is limited" and "which account this work runs on" is impossible by construction.

- [ ] **Step 1: Write the failing tests**

Append to `test/server.test.ts`. `post()` here is a small helper; if the file already has an equivalent, use that instead:

```ts
function post(base: string, body: unknown) {
  return fetch(`${base}/command`, { method: 'POST', body: JSON.stringify(body) });
}

test('scheduling a create returns an id and puts it in the queue', async (t) => {
  const { base, scheduler } = await boot(t);
  const res = await post(base, {
    cmd: 'schedule',
    trigger: { kind: 'at', time: Date.now() + 3600_000 },
    action: { kind: 'create', repo: process.cwd(), branch: 'b', account: 'claude-main', prompt: 'go' },
  });
  assert.equal(res.status, 200);
  assert.ok((await res.json()).id);
  assert.equal(scheduler.all().length, 1);
});

test('a reset trigger takes its account from the action, not the client', async (t) => {
  const { base, scheduler } = await boot(t);
  await post(base, {
    cmd: 'schedule',
    trigger: { kind: 'reset', account: 'attacker-supplied' },
    action: { kind: 'create', repo: process.cwd(), branch: 'b', account: 'codex', prompt: 'go' },
  });
  assert.deepEqual(scheduler.all()[0].trigger, { kind: 'reset', account: 'codex' });
});

test('scheduling rejects an unknown account', async (t) => {
  const { base } = await boot(t);
  const res = await post(base, {
    cmd: 'schedule',
    trigger: { kind: 'at', time: Date.now() },
    action: { kind: 'create', repo: process.cwd(), branch: 'b', account: 'nope', prompt: 'go' },
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /unknown account/);
});

test('scheduling rejects a repo that is not a directory', async (t) => {
  const { base } = await boot(t);
  const res = await post(base, {
    cmd: 'schedule',
    trigger: { kind: 'at', time: Date.now() },
    action: { kind: 'create', repo: '/no/such/place', branch: 'b', account: 'claude-main', prompt: 'go' },
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /not a directory/);
});

test('scheduling rejects a non-numeric time', async (t) => {
  const { base } = await boot(t);
  const res = await post(base, {
    cmd: 'schedule',
    trigger: { kind: 'at', time: 'tomorrow' },
    action: { kind: 'create', repo: process.cwd(), branch: 'b', account: 'claude-main', prompt: 'go' },
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /timestamp/);
});

test('scheduling rejects an empty prompt and a missing branch', async (t) => {
  const { base } = await boot(t);
  const at = { kind: 'at', time: Date.now() };
  const base_ = { repo: process.cwd(), account: 'claude-main' };

  const noPrompt = await post(base, {
    cmd: 'schedule', trigger: at, action: { kind: 'create', ...base_, branch: 'b', prompt: '  ' },
  });
  assert.equal(noPrompt.status, 400);

  const noBranch = await post(base, {
    cmd: 'schedule', trigger: at, action: { kind: 'create', ...base_, branch: '', prompt: 'go' },
  });
  assert.equal(noBranch.status, 400);
});

test('scheduling a send rejects an unknown session', async (t) => {
  const { base } = await boot(t);
  const res = await post(base, {
    cmd: 'schedule',
    trigger: { kind: 'at', time: Date.now() },
    action: { kind: 'send', sessionId: 'nope', text: 'hi' },
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /no such session/);
});

test('unschedule removes the item', async (t) => {
  const { base, scheduler } = await boot(t);
  const { id } = await (await post(base, {
    cmd: 'schedule',
    trigger: { kind: 'at', time: Date.now() + 3600_000 },
    action: { kind: 'create', repo: process.cwd(), branch: 'b', account: 'claude-main', prompt: 'go' },
  })).json();

  const res = await post(base, { cmd: 'unschedule', itemId: id });
  assert.equal(res.status, 200);
  assert.equal(scheduler.all().length, 0);
});

test('the SSE snapshot carries the queue', async (t) => {
  const { base, scheduler } = await boot(t);
  scheduler.add({ kind: 'at', time: 1 }, {
    kind: 'create', repo: '/r', branch: 'b', account: 'claude-main', prompt: 'go',
  });

  const res = await fetch(`${base}/events`);
  const reader = res.body!.getReader();
  const chunk = new TextDecoder().decode((await reader.read()).value);
  const payload = JSON.parse(chunk.replace(/^data: /, '').trim());
  assert.equal(payload.queue.length, 1);
  await reader.cancel();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `unknown cmd: schedule` (400 with the wrong error), and `payload.queue` is `undefined`.

- [ ] **Step 3: Implement it**

In `src/server.ts`, add `queue` to `snapshot()`:

```ts
  function snapshot() {
    return {
      sessions: registry.all(),
      queue: scheduler.all(),
      accounts: accounts.map((a) => ({
        name: a.name,
        provider: a.provider,
        pace: usage.pace(a.name, a.budget),
      })),
    };
  }
```

Add the parser above `command()`. It is a trust boundary, so it validates rather than coerces:

```ts
  /**
   * Validates a `schedule` body into a (trigger, action) pair.
   *
   * The action is parsed first so a `reset` trigger can take its account from
   * it rather than from the client — the account whose window we wait on is by
   * definition the account the work runs on, and deriving it makes the two
   * impossible to get out of step.
   *
   * Everything here is checked at schedule time so a typo surfaces now rather
   * than at 3am. Fire-time validation is `command()`'s own and is unchanged.
   */
  async function parseSchedule(
    body: Record<string, unknown>,
  ): Promise<{ trigger: Trigger; action: Action } | { error: string }> {
    const t = body.trigger as Record<string, unknown> | undefined;
    const a = body.action as Record<string, unknown> | undefined;
    if (!t || !a) return { error: 'schedule needs a trigger and an action' };

    let action: Action;
    let account: string;

    if (a.kind === 'create') {
      const found = accounts.find((x) => x.name === a.account);
      if (!found) return { error: `unknown account: ${String(a.account)}` };
      const repo = String(a.repo ?? '');
      if (!(await stat(repo).then((s) => s.isDirectory(), () => false))) {
        return { error: `not a directory: ${repo}` };
      }
      const branch = String(a.branch ?? '').trim();
      if (!branch) return { error: 'branch is required' };
      const prompt = String(a.prompt ?? '').trim();
      if (!prompt) return { error: 'prompt is required' };
      action = { kind: 'create', repo, branch, account: found.name, prompt };
      account = found.name;
    } else if (a.kind === 'send' || a.kind === 'resume') {
      const sessionId = String(a.sessionId ?? '');
      const session = registry.get(sessionId);
      if (!session) return { error: `no such session: ${sessionId}` };
      const text = String((a.kind === 'send' ? a.text : a.prompt) ?? '').trim();
      if (!text) return { error: 'message is required' };
      action = a.kind === 'send'
        ? { kind: 'send', sessionId, text }
        : { kind: 'resume', sessionId, prompt: text };
      account = session.account;
    } else {
      return { error: `unknown action: ${String(a.kind)}` };
    }

    if (t.kind === 'at') {
      const time = Number(t.time);
      if (!Number.isFinite(time)) return { error: 'trigger.time must be a timestamp' };
      return { trigger: { kind: 'at', time }, action };
    }
    if (t.kind === 'reset') return { trigger: { kind: 'reset', account }, action };
    return { error: `unknown trigger: ${String(t.kind)}` };
  }
```

Add the two cases to `command()`'s switch, before `default`:

```ts
      case 'schedule': {
        const parsed = await parseSchedule(body);
        if ('error' in parsed) return { status: 400, json: { error: parsed.error } };
        const item = scheduler.add(parsed.trigger, parsed.action);
        return { status: 200, json: { id: item.id } };
      }

      case 'unschedule': {
        scheduler.remove(String(body.itemId));
        return { status: 200, json: { ok: true } };
      }
```

Add the type import at the top of `src/server.ts`:

```ts
import type { Action, AgentHandle, Session, Trigger } from './types.ts';
```

**Note:** `command()` mutates the scheduler but the coalesced save subscribes to `registry`, not the scheduler. The `/command` handler already calls `await registry.save()` before responding, which writes the queue too — so this needs no extra wiring.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, whole suite.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts test/server.test.ts
git commit -m "feat: schedule and unschedule commands"
```

---

### Task 6: The tick fires due items

**Files:**
- Modify: `src/server.ts`
- Test: `test/server.test.ts`

**Interfaces:**
- Consumes: `Scheduler.due/remove/fail`, `Usage.free`, `command()`.
- Produces: `server.tick(): Promise<void>` attached to the returned `Server`, so tests can drive one pass without waiting on a real timer.

- [ ] **Step 1: Write the failing tests**

Append to `test/server.test.ts`:

```ts
test('a due item fires through command() and leaves the queue', async (t) => {
  const { base, registry, scheduler, server } = await boot(t);
  const s = registry.create({
    provider: 'claude', account: 'claude-main', repo: '/r',
    cwd: '/r/wt', branch: 'b', title: 'b',
  });
  // A `send` to a session with no live agent is a 404 from command(), which is
  // exactly the failure path we want to observe — no agent is spawned in tests.
  const item = scheduler.add({ kind: 'at', time: Date.now() - 1000 }, {
    kind: 'send', sessionId: s.id, text: 'hello',
  });

  await server.tick();
  assert.equal(scheduler.all()[0].state, 'failed');
  assert.match(scheduler.all()[0].error ?? '', /no live session/);
  assert.equal(scheduler.all()[0].id, item.id, 'a failed item stays visible, it is not dropped');
});

test('an item whose time has not come is left alone', async (t) => {
  const { registry, scheduler, server } = await boot(t);
  const s = registry.create({
    provider: 'claude', account: 'claude-main', repo: '/r',
    cwd: '/r/wt', branch: 'b', title: 'b',
  });
  scheduler.add({ kind: 'at', time: Date.now() + 3600_000 }, {
    kind: 'send', sessionId: s.id, text: 'hello',
  });

  await server.tick();
  assert.equal(scheduler.all()[0].state, 'waiting');
});

test('a reset item does not fire while its account is rate limited', async (t) => {
  const { registry, scheduler, server, usage } = await boot(t);
  const s = registry.create({
    provider: 'claude', account: 'claude-main', repo: '/r',
    cwd: '/r/wt', branch: 'b', title: 'b',
  });
  // registry.create() starts a session `working`, which would make the account
  // busy() and block the item for the wrong reason. Park it first so the only
  // thing under test is the rate limit.
  registry.apply(s.id, { type: 'stopped', reason: 'parked for the test' });
  usage.noteLimit('claude-main', 'rejected', Date.now() + 3600_000);
  scheduler.add({ kind: 'reset', account: 'claude-main' }, {
    kind: 'send', sessionId: s.id, text: 'hello',
  });

  await server.tick();
  assert.equal(scheduler.all()[0].state, 'waiting');

  usage.noteLimit('claude-main', 'allowed', null);
  await server.tick();
  assert.equal(scheduler.all()[0].state, 'failed', 'it fired once the limit cleared');
});

test('a reset item waits while its account has a working session', async (t) => {
  const { registry, scheduler, server } = await boot(t);
  const busy = registry.create({
    provider: 'claude', account: 'claude-main', repo: '/r',
    cwd: '/r/wt', branch: 'busy', title: 'busy',
  });
  assert.equal(busy.status, 'working', 'created sessions start working');

  const target = registry.create({
    provider: 'claude', account: 'claude-main', repo: '/r',
    cwd: '/r/wt2', branch: 'b', title: 'b',
  });
  // Park the target, so `busy` is true because of the *other* session and the
  // test can't pass for the wrong reason.
  registry.apply(target.id, { type: 'stopped', reason: 'parked for the test' });
  scheduler.add({ kind: 'reset', account: 'claude-main' }, {
    kind: 'send', sessionId: target.id, text: 'hello',
  });

  await server.tick();
  assert.equal(scheduler.all()[0].state, 'waiting');

  // Retire the busy session and it goes through.
  registry.apply(busy.id, { type: 'stopped', reason: 'done' });
  await server.tick();
  assert.equal(scheduler.all()[0].state, 'failed', 'fired once the account went idle');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `server.tick is not a function`.

- [ ] **Step 3: Implement it**

In `src/server.ts`, add the constant near `MAX_UPLOAD`:

```ts
/** How often the scheduler is checked. Coarse on purpose: the UI picker is
 *  minute-resolution, so a finer tick would buy nothing. */
const TICK_MS = 30_000;
```

Add the tick function inside `createServer`, after `command()`:

```ts
  /**
   * One scheduler pass. Every due item is routed back through `command()` — a
   * scheduled create is literally the same code path as a create from the
   * dialog, so there is no second launch path to keep in sync, and scheduled
   * actions inherit `command()`'s validation and 404/409 handling for free.
   *
   * Saves unconditionally at the end, not only when something fired: `due()`
   * marks overdue items `missed`, and that transition has to survive a restart.
   * The registry's coalesced save subscribes to registry changes only, and a
   * scheduler-only change is not one.
   */
  async function tick(): Promise<void> {
    const ctx: Ctx = {
      free: (name) => {
        const a = accounts.find((x) => x.name === name);
        // An account dropped from accounts.json can never be free — its work
        // cannot run at all, and command() will say so if the item ever fires.
        return a ? usage.free(a.name, a.budget) : false;
      },
      busy: (name) => registry.all().some(
        (s) => s.account === name && (s.status === 'working' || s.status === 'needs-you'),
      ),
    };

    for (const item of scheduler.due(Date.now(), ctx)) {
      let result: { status: number; json: unknown };
      try {
        result = await command(toCommand(item.action));
      } catch (err) {
        result = { status: 500, json: { error: String((err as Error).message ?? err) } };
      }
      if (result.status === 200) scheduler.remove(item.id);
      else scheduler.fail(item.id, String((result.json as { error?: string }).error ?? 'failed'));
    }
    await registry.save().catch(() => {});
  }
```

Add the plain mapping function at module scope, below `recentRepos()`:

```ts
/** A queued action as the `command()` body that performs it. */
function toCommand(a: Action): Record<string, unknown> {
  if (a.kind === 'create') {
    return { cmd: 'create', repo: a.repo, branch: a.branch, account: a.account, prompt: a.prompt };
  }
  if (a.kind === 'send') return { cmd: 'send', id: a.sessionId, text: a.text };
  return { cmd: 'resume', id: a.sessionId, prompt: a.prompt };
}
```

Task 4 already added `import { Scheduler } from './schedule.ts';`. **Replace** that line with:

```ts
import { Scheduler, type Ctx } from './schedule.ts';
```

Wire the timer beside the existing save timer, just before `return server`:

```ts
  // unref()'d and cleared on close for the same reasons as the save timer above:
  // it must never be the reason the process stays alive, and a closed server
  // must not fire a create into an already-deleted state directory.
  const tickTimer = setInterval(() => { void tick().catch(() => {}); }, TICK_MS).unref();
  server.on('close', () => clearInterval(tickTimer));

  // Exposed so tests can drive exactly one pass instead of racing a 30s timer.
  (server as Server & { tick: () => Promise<void> }).tick = tick;

  return server;
```

Change `createServer`'s return type so callers see it:

```ts
export function createServer(opts: {
  registry: Registry;
  usage: Usage;
  scheduler: Scheduler;
  accounts: Account[];
}): Server & { tick: () => Promise<void> } {
```

and end with:

```ts
  return server as Server & { tick: () => Promise<void> };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, whole suite.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts test/server.test.ts
git commit -m "feat: tick the scheduler and fire due items through command()"
```

---

### Task 7: Auto-requeue a session a rate limit killed

**Files:**
- Modify: `src/server.ts` (the `stopped` branch of `launch()`'s emit callback)
- Test: `test/server.test.ts`

**Interfaces:**
- Consumes: `Usage.resetAt` (Task 1), `Scheduler.add` (Task 3), the `dead` local already in `launch()`.
- Produces: no new API. A limit-killed session gains a queued `{ trigger: reset, action: resume }` item.

**Why `dead`:** both the `stop` and `delete` commands remove the handle from the map *before* calling `stop()`, so by the time the resulting `stopped` event re-enters this callback, `handles.get(sessionId)` is `undefined`. A truthy `dead` therefore means the agent died on its own. Pressing Stop never auto-requeues, and no new per-session flag is needed to tell the two apart.

- [ ] **Step 1: Write the failing test**

The emit callback is only reachable by launching a real agent, which tests don't do. Extract the decision into a pure, exported function and test that directly.

Add `shouldRequeue` to the existing `createServer` import at the **top** of `test/server.test.ts` (an `import` cannot go mid-file):

```ts
import { createServer, shouldRequeue } from '../src/server.ts';
```

Then append the tests:

```ts
test('a self-inflicted stop during a limit window is requeued', () => {
  const now = 1000;
  assert.equal(shouldRequeue(true, now + 3600_000, now), true);
});

test('a stop we caused is never requeued', () => {
  // Stop and Delete both drop the handle before calling stop(), so `dead` is
  // falsy on the resulting event. Pressing Stop must not resurrect the session.
  const now = 1000;
  assert.equal(shouldRequeue(false, now + 3600_000, now), false);
});

test('a stop with no known limit is not requeued', () => {
  const now = 1000;
  assert.equal(shouldRequeue(true, null, now), false);
});

test('a stop after the window already rolled is not requeued', () => {
  const now = 1000;
  assert.equal(shouldRequeue(true, now - 1, now), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `shouldRequeue is not a function` / import error.

- [ ] **Step 3: Implement it**

In `src/server.ts`, add at module scope below `toCommand()`:

```ts
/**
 * Should a `stopped` session be auto-queued for a resume once its account's
 * window rolls?
 *
 * `agentDied` is the `dead` local from launch()'s emit callback: truthy only
 * when the agent ended on its own, because both the stop and delete commands
 * remove the handle before calling stop(). `resetAt` is Usage's stored reset
 * time; a non-null value in the future is exactly "this account is past its
 * limit right now".
 *
 * ponytail: this will occasionally requeue a session that died of something
 * unrelated during a limit window. Accepted on purpose — the item is visible in
 * the queue strip and one click deletes it, whereas every tighter test means
 * matching on provider error text, which is the brittleness this avoids.
 */
export function shouldRequeue(agentDied: boolean, resetAt: number | null, now: number): boolean {
  return agentDied && resetAt !== null && resetAt > now;
}
```

In `launch()`'s emit callback, extend the `stopped` branch:

```ts
      const dead = handles.get(sessionId);
      handles.delete(sessionId);
      registry.apply(sessionId, e);
      if (shouldRequeue(Boolean(dead), usage.resetAt(account.name), Date.now())) {
        scheduler.add(
          { kind: 'reset', account: account.name },
          { kind: 'resume', sessionId, prompt: 'continue' },
        );
      }
      dead?.stop();
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, whole suite.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts test/server.test.ts
git commit -m "feat: auto-queue a resume when a rate limit kills a session"
```

---

### Task 8: The UI

**Files:**
- Modify: `web/index.html`
- Modify: `web/app.js`
- Modify: `web/style.css`

**Interfaces:**
- Consumes: `POST /command { cmd: 'schedule' | 'unschedule' }` (Task 5), the snapshot's `queue` field (Task 5), the `Queued` shape (Task 3).
- Produces: no API.

There is no test step — this codebase has no browser test harness, and adding one is out of scope. Step 5 is a manual verification checklist instead.

- [ ] **Step 1: Markup**

In `web/index.html`, add a field to the `#new` form immediately after the Account field's closing `</div>`:

```html
    <div class="field">
      <label for="when-select">Run</label>
      <div class="select-wrap"><select id="when-select" name="when">
        <option value="now">Now</option>
        <option value="at">At a time…</option>
        <option value="reset">When usage resets</option>
      </select></div>
      <!-- Native picker: no date library, and it hands back a local wall-clock
           string that `new Date()` parses as local time, which is what the user
           meant. -->
      <input id="when-at" name="at" type="datetime-local" hidden>
    </div>
```

Add a schedule button to the composer, before the Send button:

```html
    <input id="prompt" placeholder="Message…" autocomplete="off">
    <button id="schedule-btn" type="button" title="Schedule this message">⏱</button>
    <button>Send</button>
```

Add the shared picker dialog beside `<dialog id="new">`:

```html
<dialog id="when-dialog">
  <form method="dialog">
    <h2>Schedule message</h2>
    <div class="field">
      <label for="when2-select">Run</label>
      <div class="select-wrap"><select id="when2-select" name="when">
        <option value="at">At a time…</option>
        <option value="reset">When usage resets</option>
      </select></div>
      <input id="when2-at" name="at" type="datetime-local">
    </div>
    <menu><button value="cancel" formnovalidate>Cancel</button><button value="ok">Schedule</button></menu>
  </form>
</dialog>
```

- [ ] **Step 2: Wire the New-worktree dialog**

In `web/app.js`, seed the queue in the initial state so the first render before any SSE message doesn't throw:

```js
let state = { sessions: [], accounts: [], queue: [] };
```

Add the reveal handler at module scope, next to the other one-off wiring near `$('#back').onclick`:

```js
// The datetime input is only meaningful for the "at" choice; `required` is set
// with it so an empty value can't be submitted, and cleared with it so the
// other two choices don't trip the form's own validation.
function bindWhen(selectSel, inputSel) {
  const sel = $(selectSel);
  const at = $(inputSel);
  const sync = () => {
    at.hidden = sel.value !== 'at';
    at.required = sel.value === 'at';
  };
  sel.onchange = sync;
  sync();
}
bindWhen('#when-select', '#when-at');
bindWhen('#when2-select', '#when2-at');
```

Replace the body of the `$('#new')` close handler's post-`create` section:

```js
  const f = new FormData(dialog.querySelector('form'));
  const action = {
    kind: 'create',
    repo: f.get('repo'), branch: f.get('branch'),
    account: f.get('account'), prompt: f.get('prompt'),
  };
  const when = f.get('when');
  const body = when === 'now'
    ? { cmd: 'create', ...action }
    : { cmd: 'schedule', trigger: triggerFor(when, f.get('at')), action };

  const { ok, data } = await send(body);
  if (!ok) {
    $('#new-error').textContent = data.error;
    dialog.showModal();
  }
```

`{ cmd: 'create', ...action }` spreads a harmless extra `kind: 'create'` key into the create body; `command()`'s `create` case reads only the fields it names, so it is ignored.

Add the trigger helper above it:

```js
// The server derives a reset trigger's account from the action, so the client
// never sends one. An invalid or empty datetime yields NaN, which the server
// rejects with a message the dialog already knows how to show.
function triggerFor(when, at) {
  return when === 'reset'
    ? { kind: 'reset' }
    : { kind: 'at', time: new Date(at).getTime() };
}
```

- [ ] **Step 3: Wire the composer button**

Add near the `#composer` submit handler:

```js
$('#schedule-btn').onclick = () => {
  const text = $('#prompt').value.trim();
  if (!text) return;
  $('#when-dialog').showModal();
};

$('#when-dialog').addEventListener('close', async (e) => {
  const dialog = e.target;
  // Same returnValue discipline as the #new dialog: Escape closes without
  // setting one, and an unconsumed 'ok' would re-fire on the next Escape.
  const ok = dialog.returnValue === 'ok';
  dialog.returnValue = '';
  if (!ok || !openId) return;

  const text = $('#prompt').value.trim();
  if (!text) return;
  const session = state.sessions.find((s) => s.id === openId);
  // A stopped session has no live agent for a `send` to reach, so schedule the
  // resume that will bring it back instead.
  const action = session?.status === 'stopped'
    ? { kind: 'resume', sessionId: openId, prompt: text }
    : { kind: 'send', sessionId: openId, text };

  const f = new FormData(dialog.querySelector('form'));
  const { ok: sent } = await send({
    cmd: 'schedule', trigger: triggerFor(f.get('when'), f.get('at')), action,
  });
  if (sent) $('#prompt').value = '';
});
```

- [ ] **Step 4: The queue strip and the card line**

Add the render functions above `renderGrid`:

```js
function whenLabel(t) {
  return t.kind === 'reset'
    ? `when ${t.account} resets`
    : new Date(t.time).toLocaleString([], {
        weekday: 'short', hour: 'numeric', minute: '2-digit',
      });
}

function whatLabel(a, sessions) {
  if (a.kind === 'create') return `new worktree ${a.branch}`;
  const branch = sessions.find((s) => s.id === a.sessionId)?.branch ?? 'a session';
  return a.kind === 'send' ? `message ${branch}` : `resume ${branch}`;
}

/** The strip above the grid listing everything queued. Rendered from the SSE
 *  snapshot's `queue`, so it stays live with no extra request. */
function queueStrip() {
  const el = document.createElement('div');
  el.id = 'queue-strip';

  const head = document.createElement('div');
  head.className = 'queue-head';
  head.textContent = `${state.queue.length} scheduled`;
  el.append(head);

  for (const q of state.queue) {
    const row = document.createElement('div');
    row.className = `queue-row ${q.state}`;

    const label = document.createElement('span');
    label.textContent = q.state === 'waiting'
      ? `${whenLabel(q.trigger)} · ${whatLabel(q.action, state.sessions)}`
      : `${q.state}: ${whatLabel(q.action, state.sessions)} — ${q.error ?? ''}`;

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'ghost';
    del.textContent = '✕';
    del.title = 'Remove';
    del.onclick = () => send({ cmd: 'unschedule', itemId: q.id });

    row.append(label, del);
    el.append(row);
  }
  return el;
}
```

In `renderGrid`, append it right after the `selectionBar()` line:

```js
  if (selected.size) grid.append(selectionBar());
  if (state.queue.length) grid.append(queueStrip());
```

In `card(s, fetchStatus)`, immediately after the existing `el.append(head, branch, meta, wt);` line, add the waiting line:

```js
  // A session whose resume is queued reads as plain `stopped` otherwise, which
  // looks like something the user has to act on. It doesn't.
  const queued = state.queue.some(
    (q) => q.state === 'waiting' && q.trigger.kind === 'reset'
      && q.action.kind !== 'create' && q.action.sessionId === s.id,
  );
  if (queued) {
    const wait = document.createElement('div');
    wait.className = 'meta';
    wait.textContent = '⏱ waiting for reset';
    el.append(wait);
  }
```

- [ ] **Step 5: Styles**

Append to `web/style.css`, below the `#selection-bar` rules it mirrors:

```css
#queue-strip { grid-column: 1 / -1; background: var(--card); border-radius: 14px;
  padding: .8rem 1rem; display: grid; gap: .4rem; }
.queue-head { color: var(--dim); font-size: .85em; }
.queue-row { display: flex; align-items: center; gap: .5rem; font-size: .9em; }
.queue-row > span { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.queue-row.missed, .queue-row.failed { color: var(--needs); }
.queue-row button { padding: .1rem .45rem; border-radius: 6px; border: 1px solid var(--line);
  background: #232323; color: var(--dim); font: inherit; cursor: pointer; }
.queue-row button:hover { color: var(--fg); border-color: var(--needs); }
#schedule-btn { padding: .4rem .6rem; border-radius: 8px; border: 1px solid var(--line);
  background: #232323; color: var(--fg); font: inherit; cursor: pointer; }
#when-dialog input[type=datetime-local] { width: 100%; }
```

- [ ] **Step 6: Verify by hand**

Run `npm start`, open `http://127.0.0.1:4711`, and confirm each:

1. **New worktree → Run** defaults to `Now`; the datetime field is hidden. Creating works exactly as before.
2. Switching Run to `At a time…` reveals the datetime field; leaving it empty and submitting is blocked by the browser's own validation.
3. Scheduling a create for ~1 minute out shows a `1 scheduled` strip with the weekday/time and `new worktree <branch>`. Within about 90 seconds the strip empties and the worktree card appears.
4. Switching Run to `When usage resets` hides the datetime field and schedules an item reading `when <account> resets`.
5. The ✕ on a queue row removes it immediately.
6. In an open chat, typing a message and pressing ⏱ opens the dialog; scheduling clears the message box and adds a `message <branch>` row.
7. Scheduling something for a time already more than 12 hours past (edit `state.json`'s `queue[0].trigger.time` and restart) produces a `missed:` row on the next tick rather than firing.
8. Reload the page: the strip is still there. Restart the server: it is still there.

- [ ] **Step 7: Commit**

```bash
git add web/index.html web/app.js web/style.css
git commit -m "feat: schedule chats from the UI and show the queue"
```

---

### Task 9: Document it in the README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a Scheduling section**

Insert after the "What it does" section:

```markdown
## Scheduling

Every card can be started later instead of now. The New worktree dialog's **Run**
field takes `Now`, `At a time…` (a native date-time picker) or `When usage
resets`; the ⏱ button beside the chat composer schedules the message you have
typed the same way. Queued items show in a strip above the grid and can be
removed from there.

`When usage resets` is a real signal for Claude accounts, not a guess: the Agent
SDK streams a `rate_limit_event` carrying the timestamp at which the window
rolls, and that timestamp is stored per account. The Codex SDK reports no rate
limits at all, so a Codex account falls back to the same estimate the account
bars show — the item fires once the trailing-5h pace drops below `RESET_PACE`
(0.8 of the account's `budget`, in `src/usage.ts`). That fallback is only as good
as the budget you tuned in `accounts.json`, same caveat as the bars.

When a session dies while its account is past its limit, a resume is queued
automatically for when the window rolls; the card reads `waiting for reset`
instead of a bare `stopped`. Stopping a session yourself never queues anything.
Items waiting on one account fire one at a time, so a freshly reset window is not
spent all at once — items waiting on a clock fire at their time regardless of
what else is running.

Scheduled items are one-shot; there is no recurrence. A time that passes while
Switchboard is down fires on the next start if it is less than 12 hours late
(`GRACE_MS` in `src/schedule.ts`), and is marked `missed` if it is older than
that. The queue lives in `state.json` alongside the sessions.
```

- [ ] **Step 2: Add the scheduling caveat to Limits**

Append to the `Limits` list:

```markdown
- The scheduler ticks every 30 seconds and only runs while the server does — a
  scheduled item is not an OS-level cron job, and nothing fires with Switchboard
  closed. The auto-requeue heuristic is deliberately loose: any agent that dies
  on its own while its account is past its limit gets a resume queued, including
  one that died of something unrelated. That shows up as a visible queue row you
  can delete, which is the trade made to avoid matching on provider error text.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: describe scheduling in the README"
```

---

## Self-Review

**Spec coverage** — every section maps to a task:

| Spec section | Task |
|---|---|
| Background: the reset signal is real | 2 |
| Data model (`Trigger`/`Action`/`Queued`) | 3 |
| Persistence (`state.json` gains `queue`) | 4 |
| Component boundaries (Scheduler decides, server acts) | 3, 6 |
| Is the account free? (3-step check, `RESET_PACE`) | 1 |
| Storing the reset time + unit normalization | 1, 2 |
| Firing: tick, `at` + `GRACE_MS`, `reset` + drain | 3, 6 |
| Auto-requeue on a limit stop | 7 |
| HTTP surface + schedule-time validation | 5 |
| UI (dialog, composer, strip, card line) | 8 |
| Testing | 1, 2, 3, 4, 5, 6, 7 |

**Deviation from the spec, deliberate:** the spec's `Ctx` was going to include an
`accountOf(item)` helper. It is gone — a `reset` trigger already names its
account, so `due()` reads `item.trigger.account` directly and `Ctx` is two
functions. An item whose target session vanished is caught at fire time by
`command()`'s existing 404, which sets the item `failed` with a real message.

**Deviation from the spec, deliberate:** the spec did not pin the wire shape of a
`reset` trigger. Task 5 has the client send bare `{ kind: 'reset' }` and the
server derive `account` from the action, so the stored `Trigger` still matches
the spec while a client/action mismatch becomes impossible.
