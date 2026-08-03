# Usage Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each Claude account's real claude.ai plan rate-limit utilization instead of a guess derived from `budget` in `accounts.json`.

**Architecture:** A standalone probe starts a `query()` whose prompt stream never yields, calls the SDK's experimental usage control request, and closes it — no prompt, no model turn, no token spend. The server refreshes every Claude account on a 5-minute interval into the existing `Usage` object, and the SSE snapshot gains `limits`, `limitsError`, and a single unified `load` fraction that both the meter and the account-picker rank on. Codex accounts and any Claude account whose probe fails keep today's estimate, unchanged.

**Tech Stack:** Node 22.18+ running TypeScript directly (no build step), `node --test`, `@anthropic-ai/claude-agent-sdk@0.3.220`, vanilla browser JS.

## Global Constraints

- Node >= 22.18. TypeScript runs directly; there is no build step and no transpile config to update.
- `npm test` must stay hermetic: no network, no real account, no paid call, no model turn. The probe is never invoked for real inside `node --test`.
- Do not upgrade, add, or remove any dependency. `@anthropic-ai/claude-agent-sdk` stays pinned at `0.3.220`.
- The SDK method is literally named `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`. Type it as declared; do not rename or wrap it in a compatibility shim.
- Every failure in this feature is soft. A failed probe must never block session creation, produce a session error, raise a toast, or change a session's status.
- Account `env` values are launch-only secrets: never persist, log, return over SSE, or render them. `limitsError` is produced by the Claude adapter against the user's own account and is the only new string that reaches the browser.
- Limits are never written to `state.json`. That file's shape stays `{ sessions, usage }`.
- `web/lib.js` is pure and tested; `web/app.js` is DOM and untested. New decision logic goes in `lib.js`.
- The refresh interval belongs to the entry-point block at the bottom of `src/server.ts`, never inside `createServer` — tests import `createServer` directly.
- Follow the existing comment style: explain *why* a non-obvious choice was made, and mark deliberate shortcuts with a `ponytail:` comment.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/types.ts` | Modify | Declare `AccountLimits`, the shared shape crossing adapter → server → browser. |
| `src/agents/claude.ts` | Modify | Add `probeLimits(env)`. This file already owns the SDK import; nothing else in the repo talks to it. |
| `src/usage.ts` | Modify | Store per-account limits/error alongside token samples; teach `freestAccount` an optional `load`. |
| `src/server.ts` | Modify | `refreshLimits()` pass, `snapshot()` gains `limits`/`limitsError`/`load`, entry-point interval. |
| `web/lib.js` | Modify | `accountView(a)` — all the estimate-vs-real branching, pure. |
| `web/app.js` | Modify | `accountMeter`/`accountPanel` render `accountView`; account picker sorts on `load`. |
| `test/usage.test.ts` | Modify | Limits storage, `freestAccount` load override. |
| `test/server.test.ts` | Modify | `refreshLimits` with a fake probe; `load` selection. |
| `test/ui.test.ts` | Modify | `accountView` both branches. |
| `README.md` | Modify | Retract "no CLI exposes those". |

---

### Task 1: The `AccountLimits` type and the probe

**Files:**
- Modify: `src/types.ts` (append after the `AdapterEvent` union)
- Modify: `src/agents/claude.ts` (append at end of file)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `type AccountLimits = { fiveHour: LimitWindow | null; sevenDay: LimitWindow | null; subscription: string | null }`
  - `type LimitWindow = { utilization: number; resetsAt: string }`
  - `probeLimits(env: Record<string, string>, timeoutMs?: number): Promise<AccountLimits>` — rejects on failure and on `rate_limits_available: false`.

This task has no unit test. `probeLimits` is a network call against the user's real account; a fake would prove nothing about it. It is verified by hand in Step 3 and again end-to-end in Task 6. Every later task consumes it through an injected parameter, so the rest of the feature is fully testable offline.

- [ ] **Step 1: Add the shared types**

In `src/types.ts`, after the `AdapterEvent` union:

```ts
/** One claude.ai plan rate-limit window. `utilization` is 0-100, not a
 *  fraction — that is the SDK's unit, kept as-is so a stray /100 is a visible
 *  bug rather than a plausible-looking number. */
export type LimitWindow = {
  utilization: number;
  /** ISO 8601, straight from the SDK. */
  resetsAt: string;
};

/** Real plan limits for one account. A window is null when the SDK reports it
 *  as null, which it does for windows that do not apply to the plan. */
export type AccountLimits = {
  fiveHour: LimitWindow | null;
  sevenDay: LimitWindow | null;
  /** 'pro' | 'max' | 'team' | 'enterprise', or null. Not an enum here: it is a
   *  display string and an unrecognized plan should render, not throw. */
  subscription: string | null;
};
```

- [ ] **Step 2: Write the probe**

In `src/agents/claude.ts`, add `AccountLimits` and `LimitWindow` to the existing `import type { ... } from '../types.ts'` list, then append at the end of the file:

```ts
/**
 * Real claude.ai plan limits for one account, or a rejection.
 *
 * The SDK exposes this only on a live `Query`, but a Query does not need a
 * session: the prompt stream below never yields, so the CLI starts, answers the
 * control request, and is closed again without a prompt, a model turn, or a
 * token of spend. That is what makes idle accounts pollable — which is the
 * whole point, since "which account is freest" has to be answerable *before* a
 * session exists.
 *
 * Deliberately does not reuse a running session's Query. That would mean
 * threading a method through AgentHandle and the registry and would still need
 * this standalone path for idle accounts.
 *
 * Rejects rather than returning null so the caller has one failure channel:
 * a thrown error, a timeout, and `rate_limits_available: false` all mean the
 * same thing to every consumer — no real number for this account.
 */
export async function probeLimits(
  env: Record<string, string>,
  timeoutMs = 30_000,
): Promise<AccountLimits> {
  const q = query({
    // Never yields: the SDK pulls, gets nothing, and no turn is ever started.
    prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
      await new Promise<never>(() => {});
    })(),
    options: { env: { ...process.env, ...env } as Options['env'] },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const usage = await Promise.race([
      q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(),
      new Promise<never>((_, reject) => {
        // A hung CLI must not wedge the refresh loop forever.
        timer = setTimeout(() => reject(new Error('usage probe timed out')), timeoutMs);
      }),
    ]);
    if (!usage.rate_limits_available || !usage.rate_limits) {
      // API key, Bedrock, Vertex, or a token without the profile scope. Not an
      // error the user can act on, but not a number either.
      throw new Error('plan rate limits are not available for this account');
    }
    const win = (w: { utilization: number | null; resets_at: string | null } | null | undefined) =>
      (w && typeof w.utilization === 'number' && w.resets_at
        ? { utilization: w.utilization, resetsAt: w.resets_at }
        : null);
    return {
      fiveHour: win(usage.rate_limits.five_hour),
      sevenDay: win(usage.rate_limits.seven_day),
      subscription: usage.subscription_type,
    };
  } finally {
    clearTimeout(timer);
    // Releases the child process. Without this the node event loop stays alive.
    q.close();
  }
}
```

- [ ] **Step 3: Verify the probe by hand against the real account**

This is the only place the probe runs for real. Create the throwaway script **inside the repo** (the SDK resolves from `node_modules`, so `/tmp` fails with `ERR_MODULE_NOT_FOUND`):

```bash
cat > probe.tmp.ts <<'EOF'
import { probeLimits } from './src/agents/claude.ts';
console.log(await probeLimits({}));
console.log(await probeLimits({}));
setTimeout(() => { console.log('LEAKED: still alive'); process.exit(1); }, 3000).unref();
EOF
node probe.tmp.ts; echo "exit=$?"; rm -f probe.tmp.ts
```

Expected: two `AccountLimits` objects with a numeric `fiveHour.utilization`, an ISO `resetsAt`, a `subscription` string, then `exit=0` with **no** `LEAKED` line. `exit=0` with no `LEAKED` is the real assertion — it proves `q.close()` released the child, which is what keeps a 5-minute interval from accumulating orphaned CLI processes.

If the account is an API-key/Bedrock/Vertex setup this rejects with "plan rate limits are not available" — that is correct behaviour, and the rest of the plan still works (every account just keeps the estimate).

- [ ] **Step 4: Confirm the suite is untouched**

Run: `npm test`
Expected: PASS, same count as before. Nothing imports `probeLimits` yet.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/agents/claude.ts
git commit -m "feat: probe real claude.ai plan limits for an account"
```

---

### Task 2: Store limits in `Usage`

**Files:**
- Modify: `src/usage.ts`
- Test: `test/usage.test.ts`

**Interfaces:**
- Consumes: `AccountLimits` from Task 1.
- Produces:
  - `Usage.setLimits(account: string, limits: AccountLimits | null, error: string | null): void`
  - `Usage.getLimits(account: string): { limits: AccountLimits | null; error: string | null }`
  - `Usage.freestAccount(accounts: { name: string; budget: number; load?: number }[], now?: number): string` — `load` wins over `pace` when present.

`Usage` gets no SDK import and no probe knowledge. It receives numbers.

- [ ] **Step 1: Write the failing tests**

Append to `test/usage.test.ts`:

```ts
const limits = (five: number, seven: number) => ({
  fiveHour: { utilization: five, resetsAt: '2026-08-03T19:10:00Z' },
  sevenDay: { utilization: seven, resetsAt: '2026-08-10T08:00:00Z' },
  subscription: 'pro',
});

test('getLimits on an unprobed account is empty, not undefined', () => {
  const u = new Usage();
  assert.deepEqual(u.getLimits('main'), { limits: null, error: null });
});

test('setLimits stores limits and a later success clears a previous error', () => {
  const u = new Usage();
  u.setLimits('main', null, 'logged out');
  assert.deepEqual(u.getLimits('main'), { limits: null, error: 'logged out' });

  u.setLimits('main', limits(11, 1), null);
  assert.deepEqual(u.getLimits('main'), { limits: limits(11, 1), error: null });
});

test('limits are not persisted: a percentage is wrong the moment we are not running', () => {
  const u = new Usage();
  u.record('main', 100, 100, 0);
  u.setLimits('main', limits(11, 1), null);
  assert.deepEqual(u.toJSON(), { main: [{ t: 0, tokens: 200 }] });
});

test('freestAccount prefers a supplied load over pace', () => {
  const u = new Usage();
  // 'real' has burned 90% of its budget locally but the plan says it is idle;
  // 'est' looks clean locally. The real number has to win.
  u.record('real', 900, 0, 0);
  const freest = u.freestAccount(
    [{ name: 'real', budget: 1000, load: 0.05 }, { name: 'est', budget: 1000 }],
    0,
  );
  assert.equal(freest, 'real');
});

test('freestAccount falls back to pace for accounts with no load', () => {
  const u = new Usage();
  u.record('busy', 800, 0, 0);
  const freest = u.freestAccount(
    [{ name: 'busy', budget: 1000 }, { name: 'quiet', budget: 1000 }],
    0,
  );
  assert.equal(freest, 'quiet');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/usage.test.ts`
Expected: FAIL — `u.setLimits is not a function`, `u.getLimits is not a function`, and the `load` test picking `est`.

- [ ] **Step 3: Implement**

In `src/usage.ts`, add the import at the top:

```ts
import type { AccountLimits } from './types.ts';
```

Add a field beside `#samples`:

```ts
  /** Real plan limits per account, or why there are none. Deliberately not in
   *  toJSON(): a utilization percentage is wrong the moment this process is not
   *  running, and it is re-fetched about two seconds after startup. */
  #limits = new Map<string, { limits: AccountLimits | null; error: string | null }>();
```

Add the two methods:

```ts
  setLimits(account: string, limits: AccountLimits | null, error: string | null): void {
    this.#limits.set(account, { limits, error });
  }

  getLimits(account: string): { limits: AccountLimits | null; error: string | null } {
    return this.#limits.get(account) ?? { limits: null, error: null };
  }
```

Replace `freestAccount` with:

```ts
  /**
   * `load` is the caller's already-resolved fraction (real plan utilization);
   * `pace` is the local estimate. Taking the override here rather than letting
   * callers rank for themselves is what keeps this from disagreeing with the
   * account picker in web/app.js, which ranks on the same server-computed number.
   */
  freestAccount(
    accounts: { name: string; budget: number; load?: number }[],
    now = Date.now(),
  ): string {
    if (accounts.length === 0) throw new Error('no accounts configured');
    const load = (a: { name: string; budget: number; load?: number }) =>
      a.load ?? this.pace(a.name, a.budget, now);
    let best = accounts[0];
    let bestLoad = load(best);
    for (const a of accounts.slice(1)) {
      const l = load(a);
      if (l < bestLoad) { best = a; bestLoad = l; }
    }
    return best.name;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/usage.test.ts`
Expected: PASS, including the pre-existing pace/persistence tests.

- [ ] **Step 5: Commit**

```bash
git add src/usage.ts test/usage.test.ts
git commit -m "feat: hold per-account plan limits in Usage"
```

---

### Task 3: `refreshLimits` and the `load`/`limits` snapshot fields

**Files:**
- Modify: `src/server.ts` (`snapshot()` at ~line 172; new exported function above `createServer`)
- Test: `test/server.test.ts`

**Interfaces:**
- Consumes: `probeLimits` (Task 1), `Usage.setLimits`/`getLimits` (Task 2).
- Produces:
  - `export async function refreshLimits(usage: Usage, accounts: Account[], probe = probeLimits): Promise<void>`
  - `export function accountLoad(usage: Usage, a: Account): number`
  - `snapshot().accounts[i]` gains `limits: AccountLimits | null`, `limitsError: string | null`, `load: number`.

`probe` is a parameter with a default so tests inject a fake and never spawn a CLI.

- [ ] **Step 1: Write the failing tests**

Append to `test/server.test.ts`. `boot()` already exists in that file and returns a running server; these tests need only `Usage` and the two new exports, so add them at the end of the file and extend the existing import:

```ts
import { createServer, refreshLimits, accountLoad } from '../src/server.ts';
```

```ts
const fiveAndSeven = (five: number, seven: number) => ({
  fiveHour: { utilization: five, resetsAt: '2026-08-03T19:10:00Z' },
  sevenDay: { utilization: seven, resetsAt: '2026-08-10T08:00:00Z' },
  subscription: 'pro',
});

test('refreshLimits probes claude accounts only and stores the result', async () => {
  const usage = new Usage();
  const seen: Record<string, string>[] = [];
  await refreshLimits(usage, accounts, async (env) => {
    seen.push(env);
    return fiveAndSeven(11, 1);
  });

  assert.equal(seen.length, 1, 'the codex account must not be probed');
  assert.deepEqual(usage.getLimits('claude-main').limits, fiveAndSeven(11, 1));
  assert.deepEqual(usage.getLimits('codex'), { limits: null, error: null });
});

test('refreshLimits passes the account env through to the probe', async () => {
  const usage = new Usage();
  const withEnv = [{ name: 'alt', provider: 'claude' as const, budget: 1000, env: { CLAUDE_CONFIG_DIR: '/tmp/alt' } }];
  let got: Record<string, string> | null = null;
  await refreshLimits(usage, withEnv, async (env) => { got = env; return fiveAndSeven(3, 2); });
  assert.deepEqual(got, { CLAUDE_CONFIG_DIR: '/tmp/alt' });
});

test('a rejected probe records the reason and leaves limits null', async () => {
  const usage = new Usage();
  await refreshLimits(usage, accounts, async () => { throw new Error('logged out'); });
  assert.deepEqual(usage.getLimits('claude-main'), { limits: null, error: 'logged out' });
});

test('one account failing does not stop another from being probed', async () => {
  const usage = new Usage();
  const two = [
    { name: 'a', provider: 'claude' as const, budget: 1000, env: {} },
    { name: 'b', provider: 'claude' as const, budget: 1000, env: {} },
  ];
  await refreshLimits(usage, two, async (_env) => {
    if (_env.WHICH === 'a') throw new Error('nope');
    return fiveAndSeven(7, 7);
  });
  assert.equal(usage.getLimits('b').limits?.fiveHour?.utilization, 7);
});

test('accountLoad takes the worse of the two windows', () => {
  const usage = new Usage();
  usage.setLimits('claude-main', fiveAndSeven(5, 96), null);
  // A quiet 5h window must not hide a nearly-exhausted week.
  assert.equal(accountLoad(usage, accounts[0]), 0.96);
});

test('accountLoad falls back to pace without limits', () => {
  const usage = new Usage();
  usage.record('codex', 400, 0, Date.now());
  assert.equal(accountLoad(usage, accounts[1]), 0.4);
});

test('accountLoad prefers a real 5% over an estimated 40%', () => {
  const usage = new Usage();
  usage.setLimits('claude-main', fiveAndSeven(5, 5), null);
  usage.record('claude-main', 900, 0, Date.now());
  assert.equal(accountLoad(usage, accounts[0]), 0.05);
});

test('the snapshot carries limits, limitsError and load per account', async (t) => {
  const { url, usage } = await boot(t);
  usage.setLimits('claude-main', fiveAndSeven(11, 1), null);
  usage.setLimits('codex', null, 'not supported');

  const snap = await fetch(new URL('/state', url)).then((r) => r.json());
  const main = snap.accounts.find((a) => a.name === 'claude-main');
  const codex = snap.accounts.find((a) => a.name === 'codex');

  assert.deepEqual(main.limits, fiveAndSeven(11, 1));
  assert.equal(main.limitsError, null);
  assert.equal(main.load, 0.11);
  assert.equal(codex.limits, null);
  assert.equal(codex.limitsError, 'not supported');
  assert.equal(codex.load, 0);
});
```

> If `boot(t)` does not already return `usage` and a `/state` URL, adjust the last test to whatever `boot` exposes and the route the SSE snapshot is served on — read `boot()` and the route table at the top of `createServer` first. The assertions themselves do not change.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/server.test.ts`
Expected: FAIL — `refreshLimits is not a function` / `accountLoad is not a function`.

- [ ] **Step 3: Implement**

In `src/server.ts`, extend the existing claude adapter import:

```ts
import { claudeAdapter, probeLimits } from './agents/claude.ts';
```

and add `AccountLimits` to the `./types.ts` type import.

Above `createServer`, add:

```ts
/**
 * One fraction per account, so the meter and the New Session picker cannot
 * disagree. Real plan utilization when we have it, the local budget estimate
 * otherwise. `max` of the two windows: a 95%-consumed week has to outrank a
 * quiet five-hour window, and both are already 0-100 from the SDK.
 */
export function accountLoad(usage: Usage, a: Account): number {
  const { limits } = usage.getLimits(a.name);
  if (!limits) return usage.pace(a.name, a.budget);
  const pct = Math.max(limits.fiveHour?.utilization ?? 0, limits.sevenDay?.utilization ?? 0);
  return pct / 100;
}

/**
 * One refresh pass over every Claude account, concurrently.
 *
 * `probe` is a parameter so tests drive this with a fake and never spawn a CLI.
 * Every failure is swallowed into `limitsError`: a probe that throws must leave
 * the account showing exactly the estimate UI it shows today, never block a
 * session, and never take its neighbours down with it — hence allSettled and
 * the per-account try.
 */
export async function refreshLimits(
  usage: Usage,
  accounts: Account[],
  probe: (env: Record<string, string>) => Promise<AccountLimits> = probeLimits,
): Promise<void> {
  await Promise.allSettled(
    accounts
      .filter((a) => a.provider === 'claude')
      .map(async (a) => {
        try {
          usage.setLimits(a.name, await probe(a.env), null);
        } catch (err) {
          usage.setLimits(a.name, null, String((err as Error).message ?? err));
        }
      }),
  );
}
```

Then in `snapshot()`, replace the `accounts.map` body:

```ts
      accounts: accounts.map((a) => {
        const { limits, error } = usage.getLimits(a.name);
        return {
          name: a.name,
          provider: a.provider,
          budget: a.budget,
          pace: usage.pace(a.name, a.budget),
          limits,
          limitsError: error,
          load: accountLoad(usage, a),
        };
      }),
```

`pace` stays on the payload: the account panel still shows the estimate as the fallback line, and dropping it would be a second change riding along with this one.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/server.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS. No CLI is spawned — every test injects a fake probe.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts test/server.test.ts
git commit -m "feat: refresh and publish real plan limits per account"
```

---

### Task 4: `accountView` in `web/lib.js`

**Files:**
- Modify: `web/lib.js`
- Test: `test/ui.test.ts`

**Interfaces:**
- Consumes: the snapshot account shape from Task 3 (`{ name, provider, budget, pace, limits, limitsError, load }`).
- Produces: `accountView(a)` → `{ load, pct, real, title, budgetLine, note, windows }` where `windows` is `{ label, pct, resetsAt }[]`.

No DOM in this task. `lib.js` is imported by `node --test` directly, so it must stay free of `document`.

- [ ] **Step 1: Write the failing tests**

In `test/ui.test.ts`, add `accountView` to the existing import from `../web/lib.js`, then append:

```ts
const acct = (over = {}) => ({
  name: 'claude-main', provider: 'claude', budget: 2000000,
  pace: 0.4, limits: null, limitsError: null, load: 0.4, ...over,
});

test('accountView without limits reproduces the estimate wording exactly', () => {
  const v = accountView(acct());
  assert.equal(v.real, false);
  assert.equal(v.pct, 40);
  assert.equal(v.title, 'claude-main — ~40% of its 5h budget (estimate)');
  assert.equal(v.budgetLine, 'claude · ~40% of a 2,000,000 token budget · estimate');
  assert.match(v.note, /not a real plan limit/);
  assert.deepEqual(v.windows, []);
});

test('accountView with limits drops the estimate wording', () => {
  const v = accountView(acct({
    limits: {
      fiveHour: { utilization: 11, resetsAt: '2026-08-03T19:10:00Z' },
      sevenDay: { utilization: 1, resetsAt: '2026-08-10T08:00:00Z' },
      subscription: 'pro',
    },
    load: 0.11,
  }));
  assert.equal(v.real, true);
  assert.equal(v.pct, 11);
  assert.equal(v.title, 'claude-main — 11% of the 5h limit');
  assert.equal(v.budgetLine, 'claude · pro plan');
  assert.equal(v.note, '');
  assert.deepEqual(v.windows.map((w) => [w.label, w.pct]), [['5h', 11], ['7d', 1]]);
});

test('accountView reports the worse window as the headline number', () => {
  const v = accountView(acct({
    limits: {
      fiveHour: { utilization: 5, resetsAt: '2026-08-03T19:10:00Z' },
      sevenDay: { utilization: 96, resetsAt: '2026-08-10T08:00:00Z' },
      subscription: 'max',
    },
    load: 0.96,
  }));
  assert.equal(v.pct, 96);
  assert.equal(v.title, 'claude-main — 96% of the 7d limit');
});

test('accountView omits a window the plan does not report', () => {
  const v = accountView(acct({
    limits: { fiveHour: { utilization: 8, resetsAt: '2026-08-03T19:10:00Z' }, sevenDay: null, subscription: 'pro' },
    load: 0.08,
  }));
  assert.deepEqual(v.windows.map((w) => w.label), ['5h']);
});

test('accountView keeps a probe error out of the meter title', () => {
  const v = accountView(acct({ limitsError: 'logged out' }));
  assert.equal(v.real, false);
  assert.ok(!v.title.includes('logged out'), 'the error belongs in the panel, not the meter');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/ui.test.ts`
Expected: FAIL — `accountView is not a function`.

- [ ] **Step 3: Implement**

Append to `web/lib.js`:

```js
/**
 * Everything the meter and the account panel need to decide *what* to say,
 * with no DOM. The two branches are the point: an account with real plan
 * limits and one falling back to the local budget estimate must not be worded
 * the same, or an estimate reads as fact.
 *
 * The headline number is the worse of the two windows, matching the server's
 * `load` — a nearly-exhausted week must not hide behind a quiet 5h window.
 */
export function accountView(a) {
  const l = a.limits;
  if (!l) {
    const pct = Math.round(a.pace * 100);
    return {
      load: a.load ?? a.pace,
      pct,
      real: false,
      title: `${a.name} — ~${pct}% of its 5h budget (estimate)`,
      budgetLine: `${a.provider} · ~${pct}% of a ${a.budget.toLocaleString()} token budget · estimate`,
      note: 'Estimated from observed token spend against the budget in accounts.json — not a real plan limit.',
      windows: [],
    };
  }
  const windows = [
    l.fiveHour && { label: '5h', pct: l.fiveHour.utilization, resetsAt: l.fiveHour.resetsAt },
    l.sevenDay && { label: '7d', pct: l.sevenDay.utilization, resetsAt: l.sevenDay.resetsAt },
  ].filter(Boolean);
  const worst = windows.reduce((m, w) => (w.pct > m.pct ? w : m), windows[0] ?? { label: '5h', pct: 0 });
  return {
    load: a.load,
    pct: worst.pct,
    real: true,
    title: `${a.name} — ${worst.pct}% of the ${worst.label} limit`,
    budgetLine: `${a.provider} · ${l.subscription ?? 'unknown'} plan`,
    note: '',
    windows,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/ui.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/lib.js test/ui.test.ts
git commit -m "feat: accountView decides between real limits and the estimate"
```

---

### Task 5: Render it

**Files:**
- Modify: `web/app.js` (`accountMeter` ~line 84, `accountPanel` ~line 108, account picker ~line 1067)

**Interfaces:**
- Consumes: `accountView` (Task 4), the `load`/`limits`/`limitsError` snapshot fields (Task 3).
- Produces: nothing consumed by later tasks.

No new test: this is DOM assembly, which `test/ui.test.ts` does not cover by design — the decisions it renders are already tested in Task 4. Verified by eye in Task 6.

- [ ] **Step 1: Import `accountView`**

`web/app.js` already imports from `./lib.js`. Add `accountView` to that import list.

- [ ] **Step 2: Rewrite `accountMeter`**

Replace the whole function:

```js
function accountMeter(a) {
  const v = accountView(a);
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `meter${panel === a.name ? ' open' : ''}`;
  b.title = v.title;

  const name = document.createElement('span');
  name.textContent = a.name;

  const bar = document.createElement('span');
  bar.className = `bar ${v.load > 1 ? 'over' : ''}`;
  const fill = document.createElement('i');
  fill.style.width = `${Math.min(v.pct, 100)}%`;
  bar.append(fill);

  const num = document.createElement('span');
  num.textContent = `${v.pct}%`;

  b.append(name, bar, num);
  b.onclick = () => setPanel(a.name);
  return b;
}
```

- [ ] **Step 3: Rewrite `accountPanel`**

```js
function accountPanel(a) {
  const v = accountView(a);
  const box = document.createElement('div');
  const h = document.createElement('h3');
  h.textContent = a.name;

  const line = document.createElement('p');
  line.className = 'meta';
  line.textContent = v.budgetLine;
  box.append(h, line);

  for (const w of v.windows) {
    const row = document.createElement('p');
    row.className = 'meta';
    // Local time: a UTC reset timestamp is a small puzzle every single glance.
    row.textContent = `${w.label} · ${w.pct}% · resets ${new Date(w.resetsAt).toLocaleString()}`;
    box.append(row);
  }

  if (v.note) {
    const note = document.createElement('p');
    note.className = 'meta';
    note.textContent = v.note;
    box.append(note);
  }
  // Panel only: the meter stays a number, and a logged-out alt account should
  // not make every glance at the header look like a failure.
  if (a.limitsError) {
    const err = document.createElement('p');
    err.className = 'meta';
    err.textContent = `No real plan limits: ${a.limitsError}`;
    box.append(err);
  }
  return box;
}
```

- [ ] **Step 4: Rank the account picker on `load`**

At ~line 1067, change:

```js
  const freest = [...state.accounts].sort((a, b) => a.pace - b.pace)[0];
```

to:

```js
  // `load` is the server's one ranking number — real plan utilization where we
  // have it, the local estimate otherwise. Sorting on `pace` here would default
  // the dialog to a different account than the meters imply is freest.
  const freest = [...state.accounts].sort((a, b) => a.load - b.load)[0];
```

- [ ] **Step 5: Run the suite**

Run: `npm test`
Expected: PASS, unchanged.

- [ ] **Step 6: Commit**

```bash
git add web/app.js
git commit -m "feat: show real plan limits on the account meter and panel"
```

---

### Task 6: Refresh loop, docs, end-to-end verification

**Files:**
- Modify: `src/server.ts` (entry-point block at the bottom, ~line 643)
- Modify: `README.md` (the usage paragraph at ~line 99 and the Phase 2 list at ~line 173)

**Interfaces:**
- Consumes: `refreshLimits` (Task 3). Produces nothing.

- [ ] **Step 1: Start the interval in the entry point only**

In the `if (process.argv[1] === ...)` block at the bottom of `src/server.ts`, after `const registry = await Registry.load(...)`:

```ts
  // Entry point only, never inside createServer: test/server.test.ts imports
  // createServer directly, and an interval started there would leak a timer and
  // a CLI spawn into every server test.
  const REFRESH_MS = 5 * 60_000;
  let refreshing = false;
  const refresh = async () => {
    if (refreshing) return;      // a slow probe must not stack up passes
    refreshing = true;
    try { await refreshLimits(usage, accounts); } finally { refreshing = false; }
  };
  void refresh();
  // ponytail: unconditional timer — it does not check whether a browser is
  // connected. Gate it on live SSE clients if the spawns ever show up in a
  // profile.
  setInterval(() => void refresh(), REFRESH_MS).unref();
```

- [ ] **Step 2: Retract the README claim**

In `README.md`, replace the sentence that opens the usage paragraph:

> `Usage percentages are estimates from observed token spend against the `budget` in `accounts.json`, not real plan limits — no CLI exposes those.`

with:

```markdown
Claude accounts show their real claude.ai plan usage: Switchboard asks the
Agent SDK for the 5-hour and 7-day rate-limit windows every five minutes, using
each account's own launch environment. This costs no tokens — the probe starts
a session that is never given a prompt. The meter shows whichever window is
further along, so a nearly-exhausted week cannot hide behind a quiet afternoon.
The API is marked experimental by the SDK and may change.

Everything else falls back to an estimate from observed token spend against the
`budget` in `accounts.json`: Codex accounts, API-key/Bedrock/Vertex accounts
(where plan limits do not apply), and any account whose probe fails — the
account panel says which. Those estimates are labelled `~` and "estimate" in
the UI, and the two providers aren't measured identically:
```

Leave the rest of that paragraph — the `cache_creation_input_tokens` detail and the Codex `cached_input_tokens` caveat — exactly as it is; it now reads as the continuation of the estimate fallback.

In the Phase 2 list at the bottom, delete `improved usage reporting where supported, ` — this ships it.

- [ ] **Step 3: Full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: End-to-end verification against real accounts**

```bash
cp accounts.example.json accounts.json   # if not already present; edit paths
PORT=4712 npm start
```

Open `http://127.0.0.1:4712` and confirm:

1. Within ~3 seconds of startup, each Claude account's meter shows a real percentage and its tooltip has **no** `~` and no "(estimate)".
2. Clicking that meter opens a panel showing the plan name and both windows with local reset times.
3. A Codex account's meter and panel are unchanged — `~`, budget, and the estimate disclaimer.
4. New Session defaults to the account with the lowest `load`.
5. Cross-check one number against `/usage` in an interactive `claude` session on the same account. They should match within a percentage point.

Then leave the server running for **eleven minutes** (two refresh intervals) and check for orphaned children:

```bash
pgrep -fl 'claude' | grep -v 'npm start'
```

Expected: no growth in the count across the two intervals. This is the failure mode the design is most exposed to — a leaked child every five minutes.

Stop the server. Confirm it exits promptly (the `unref()`d interval must not hold it open).

- [ ] **Step 5: Commit**

```bash
git add src/server.ts README.md
git commit -m "feat: refresh plan limits every five minutes"
```

---

## Self-Review

**Spec coverage**

| Spec section | Task |
|---|---|
| Background / SDK method | Task 1 |
| The probe (`probeLimits`, never-yielding stream, close, timeout, rejects on `rate_limits_available: false`) | Task 1 |
| `AccountLimits` in `src/types.ts` | Task 1 |
| Cache in `Usage`, not persisted to `state.json` | Task 2 |
| `refreshLimits` with injected probe, concurrent, Claude-only | Task 3 |
| Interval in entry point, `unref`, no overlapping pass | Task 6 |
| Account selection via one server-side `load` | Tasks 3 (compute) + 5 (sort) |
| `freestAccount` load override | Task 2 |
| Server payload `limits` / `limitsError` | Task 3 |
| UI branching in `lib.js`, rendering in `app.js`, error in panel only | Tasks 4 + 5 |
| Soft failure everywhere | Task 3 (`allSettled` + per-account try), asserted in Task 3 Step 1 |
| 30s probe timeout | Task 1 |
| Tests: usage / server / ui | Tasks 2 / 3 / 4 |
| Manual verification incl. orphan check | Task 1 Step 3, Task 6 Step 4 |
| README retraction | Task 6 |
| Out of scope (Codex, `rate_limit_event`, `behaviors`, scheduling, `budget`) | Not implemented anywhere; `budget` and `pace` deliberately retained in Task 3 Step 3 |

**Placeholder scan:** none. Every code step carries real code; the one judgement call left to the implementer is flagged inline in Task 3 Step 1 (adapt the last test to `boot()`'s actual return shape) with the assertions specified regardless.

**Type consistency:** `AccountLimits`/`LimitWindow` declared once in Task 1 and used unchanged in Tasks 2, 3, 4. `setLimits`/`getLimits` signatures match between Task 2's implementation and Task 3's use. `accountLoad`/`refreshLimits` signatures match between Task 3's definition and Task 6's call. `accountView`'s seven returned fields are the same seven consumed in Task 5. The snapshot's `load` is produced in Task 3 and consumed in Tasks 4 and 5 under the same name.
