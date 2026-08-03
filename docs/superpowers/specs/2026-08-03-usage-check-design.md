# Usage check — design

Replace the guessed usage percentage with the real one, for Claude accounts.

Today every account meter shows `pace()`: observed token spend divided by the
`budget` in `accounts.json`. The README calls this an estimate and says no CLI
exposes the real plan limits. That is no longer true.

## Background: the real numbers are available

`@anthropic-ai/claude-agent-sdk@0.3.220` exposes on the `Query` object:

```ts
usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET():
  Promise<SDKControlGetUsageResponse>;
```

(`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:2444`)

Verified against this machine's account, with a `query()` whose prompt stream
never yields — no prompt sent, no model turn, no token spend:

```
subscription_type: "pro"    rate_limits_available: true
five_hour: { utilization: 11, resets_at: "2026-08-03T19:10:00Z" }
seven_day: { utilization:  1, resets_at: "2026-08-10T08:00:00Z" }
```

Round trip ~2.2s, dominated by spawning the CLI. A second probe minutes later
read 14%, so the value tracks live spend rather than being cached per process.
`q.close()` releases the child; a script doing two probes and nothing else exits
on its own.

Three properties matter for the design:

- It needs a running CLI, but **not** a running session. Idle accounts can be
  polled. This is what makes "which account is freest" answerable before a
  session exists.
- It respects the launch environment, so an account's `env.CLAUDE_CONFIG_DIR`
  yields that account's limits.
- `rate_limits_available` is false for API-key, Bedrock, and Vertex sessions.
  The estimate has to survive as a fallback, not be deleted.

The scheduling design (`2026-08-01-scheduling-design.md`, not yet implemented)
notes that `rate_limit_event` streams the same utilization during a live
session. That is a cheaper source, but only while a session runs, so it cannot
replace the probe. It is out of scope here.

## The probe

New export in `src/agents/claude.ts` — that file already owns the SDK import,
and this is the only other thing in the codebase that talks to it:

```ts
export type AccountLimits = {
  fiveHour: { utilization: number; resetsAt: string } | null;
  sevenDay: { utilization: number; resetsAt: string } | null;
  subscription: string | null;
};

export function probeLimits(env: Record<string, string>): Promise<AccountLimits>;
```

It starts a `query()` with a never-yielding prompt stream and the account's
`env`, awaits the usage call, and closes the query in a `finally`. It rejects
when the call fails and when `rate_limits_available` is false — both are "no
real number for this account", and the caller treats them identically.

It deliberately does not reuse a live session's `Query`. Doing so would mean
threading a method through `AgentHandle` and the registry, and would still need
the standalone path for idle accounts. One path, no adapter surface change.

`AccountLimits` is declared in `src/types.ts` alongside the other shared types
and imported by the adapter, so `src/server.ts` and `src/usage.ts` never import
from `src/agents/`.

## Cache and refresh

`Usage` (`src/usage.ts`) already owns per-account usage state, so it holds this
too:

```ts
setLimits(account: string, limits: AccountLimits | null, error: string | null): void;
getLimits(account: string): { limits: AccountLimits | null; error: string | null };
```

`src/server.ts` exports `refreshLimits(usage, accounts, probe)`: one pass that
probes every Claude account concurrently and writes each result into `Usage`.
It takes the probe as a parameter so tests can drive it with a fake and never
spawn a CLI.

The 5-minute `setInterval` that calls it lives in the entry-point block at the
bottom of `src/server.ts`, **not** inside `createServer`. `createServer` is
imported directly by `test/server.test.ts`; an interval started there would
leak a timer and a CLI spawn into every server test.

The interval is unconditional — it does not check whether a browser is
connected. Three accounts at ~2.2s every five minutes is not worth the
connection-tracking code, and an unconditional timer means the first page load
after an idle period shows a fresh number instead of triggering a two-second
wait. It is `unref()`d so it never holds the process open, and a refresh
already in flight is not started again.

Limits are **not** written to `state.json`. They are re-fetched two seconds
after startup, and a persisted utilization percentage is wrong the moment the
process is not running. `state.json`'s shape is unchanged by this work.

## Account selection

`Usage.freestAccount` has no production caller — only tests. The New Session
dialog picks the default account itself, at `web/app.js:1067`, by sorting the
snapshot on `a.pace`. Ranking therefore has to change where it actually
happens, and there must not end up being two rules.

One number, computed once, server-side. `snapshot()` emits `load` per account:

- Claude account with limits: `max(fiveHour, sevenDay) / 100`. A weekly window
  at 95% has to outrank a quiet five-hour window; taking the max is what makes
  the two comparable to a `pace()` fraction.
- Anything else: `pace(name, budget)`, exactly as today.

`web/app.js` sorts on `load` instead of `pace`. `Usage.freestAccount` takes an
optional per-account `load` and prefers it when present, so the one remaining
caller-less ranking function cannot silently disagree with the UI if something
starts using it.

`Usage` gains no knowledge of the SDK — it receives numbers. A real utilization
and an estimated pace are both "fraction of this account's headroom consumed",
which is close enough to rank on; they are not claimed to be equally accurate,
which is why the UI labels them differently.

`freestAccount`'s tie-break stays first-listed-wins.

## Server payload

The `accounts` array on the SSE state gains two fields per account:

```ts
{ name, provider, budget, pace,          // unchanged
  limits: AccountLimits | null,          // null unless real numbers exist
  limitsError: string | null }           // why not, when limits is null
```

`limitsError` carries the probe's failure message. It is generated by the
Claude adapter against the user's own account, so it cannot leak a Codex
account value; the existing `redactAccountValue` path is untouched. It is
rendered only in the account panel, never on the meter.

## UI

The repo splits browser code into `web/lib.js` (pure, covered by
`test/ui.test.ts`) and `web/app.js` (DOM, untested). The branching this feature
needs is decision logic, so it goes in `lib.js` behind one function:

```js
export function accountView(a)
// → { load, pct, real, title, budgetLine, note, windows }
```

`app.js` then stays dumb:

- `accountMeter` — reads `pct`, `title`, and `load` (for the `over` class and
  the fill width) off `accountView`. With real limits the title reads
  `<name> — 11% of the 5h limit`, dropping the `~` and the word "estimate";
  without them it is byte-for-byte today's string.
- `accountPanel` — renders `budgetLine`, `note`, and `windows` (each window's
  label, percentage, and reset time as local time), plus `limitsError` when
  there is one. Error text appears in the panel only, never on the meter.

The bar still fills from a 0–1 fraction, now `load`. The `over` threshold is
unchanged.

## Failure handling

Every failure is soft. A probe that throws, times out, or reports
`rate_limits_available: false` leaves that account showing exactly the estimate
UI it shows today, with the reason in the panel. No toast, no session error, no
blocked session creation — a session must still be startable when claude.ai is
unreachable.

The probe gets a 30-second timeout so a hung CLI cannot wedge the refresh loop.

## Testing

`test/usage.test.ts`:

- `setLimits(null, err)` then `getLimits` returns the error, and a later
  successful `setLimits` clears it.
- `freestAccount` prefers a supplied `load` over `pace`, and falls back to
  `pace` for accounts without one.

`test/server.test.ts`:

- `refreshLimits` with a fake probe writes limits for Claude accounts and never
  calls the probe for a Codex account.
- A probe that rejects leaves `limits: null` and a non-null `limitsError`.
- `snapshot()`'s `load` is `max(fiveHour, sevenDay)/100` for an account with
  limits and `pace` for one without — a 5% five-hour window with a 96% weekly
  window must outrank a 40% estimated account.

`test/ui.test.ts`:

- `accountView` with limits produces the real title and no estimate wording.
- `accountView` without limits reproduces today's estimate strings exactly.

The probe itself is a network call and gets no unit test; nothing fake would
prove anything about it. The implementation plan carries one manual
verification instead: run the server, confirm the meter shows a real
percentage, and confirm no orphaned `claude` child processes accumulate across
two refresh intervals.

`npm test` stays hermetic and offline.

## Out of scope

- **Codex.** Whether `@openai/codex-sdk` exposes anything equivalent is not
  investigated here; Codex accounts keep the budget estimate unchanged.
- **`rate_limit_event`.** Streaming utilization from live sessions to cut probe
  latency is a later refinement.
- **The other `SDKControlGetUsageResponse` fields.** `behaviors` (per-skill and
  per-MCP attribution), `extra_usage` credits, `model_scoped` windows, and
  `session.total_cost_usd` are all read and all discarded. Two windows are what
  the meter needs.
- **Scheduling.** Queueing work until a window resets is its own design.
- **`budget` in `accounts.json`.** Still required, still used for Codex and for
  Claude fallback. Not deprecated by this change.
