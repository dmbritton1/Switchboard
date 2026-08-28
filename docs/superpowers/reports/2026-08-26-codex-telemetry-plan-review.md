# Pre-build review: Codex app-server parity spec + telemetry foundation plan

**Date:** 2026-08-26
**Reviewed:** `specs/2026-08-11-codex-app-server-parity-design.md`,
`plans/2026-08-26-codex-telemetry-foundation.md`
**Verdict:** Approach is sound; ship it. Eight items must be corrected in the plan
before Task 1, because each one is a wrong assumption the fake-process tests would
happily encode and lock in.

Every protocol claim below was checked against the vendored executable at
`node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex`
(`codex-cli 0.145.0`), not against online docs. Reproduce with:

```bash
B=node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex
CODEX_HOME=$(mktemp -d) $B app-server generate-ts --out /tmp/schema
```

## Verified — build on these

1. **The phase-one method set exists at 0.145.0.** `ClientRequest` contains
   `account/read` (params `GetAccountParams`) and `account/rateLimits/read`
   (params `undefined`); `ServerNotification` contains `account/updated` and
   `account/rateLimits/updated`. No version bump needed.
2. **`RateLimitWindow` matches the spec's window shape exactly:**
   `{ usedPercent: number, windowDurationMins: number | null, resetsAt: number | null }`.
   The generic `AccountLimitWindow` in Task 3 is a straight mapping.
3. **The sparse-update contract is real and documented in the generated type:**
   `AccountRateLimitsUpdatedNotification` — *"Clients should merge available values
   into the most recent `account/rateLimits/read` response or refetch that snapshot.
   Nullable account metadata may be unavailable in a rolling update and does not
   clear a previously observed value."* Task 4 Step 4 is correctly motivated.
4. **`telemetryAppServerArgs()` is valid as written.** `-c` is accepted both before
   and after the `app-server` subcommand, and `hooks={}`, `mcp_servers={}`,
   `otel.exporter="none"` all parse and start cleanly.
5. **Out-of-order responses are not hypothetical.** A logged-out run returned the
   `id: 3` error before the `id: 2` result. Task 2 Step 1 is testing a real behavior.
6. **Baseline is green:** `npm test` → 494 pass, 0 fail, ~34s. Start from there.

## Blocking corrections

### B1. Two different auth vocabularies, and the plan uses only one

`account/read` returns a tagged union:

```ts
Account = { type: "apiKey" } | { type: "chatgpt", email, planType }
        | { type: "amazonBedrock", usesCodexManagedCredentials }
```

`account/updated` returns a *different* enum:

```ts
AuthMode = "apikey" | "chatgpt" | "chatgptAuthTokens" | "headers"
         | "agentIdentity" | "personalAccessToken" | "bedrockApiKey"
```

Task 4 Step 1 lists `chatgpt`, `apiKey`, `amazonBedrock` and treats them as one
enum. Note `apiKey` vs `apikey` — a case-sensitive comparison against the wrong
list silently classifies a live account as unsupported. Normalize the two
vocabularies separately, and cover all seven `AuthMode` values.

### B2. Denying `account/chatgptAuthTokens/refresh` breaks external-auth accounts

Task 2 Step 6 answers every server request with `-32601`, calling out
"externally managed auth refresh" explicitly. The schema says why that is not free:

> `GetAccountParams.refreshToken` — *"In external auth mode this flag is ignored.
> Clients should refresh tokens themselves and call `account/login/start` with
> `chatgptAuthTokens`."*

So for an `authMode: "chatgptAuthTokens"` account, denying the refresh means
telemetry works until the token expires and then fails permanently, with a
sanitized error the user cannot act on.

Do not implement token refresh in phase one. Do classify `chatgptAuthTokens`
(and `headers`, `agentIdentity`, `personalAccessToken`) as **unsupported for
authoritative telemetry**, with the same estimate fallback and a reason string
that names the cause. Denying the request stays correct; pretending the account
is supported does not.

### B3. `reached` is not `usedPercent >= 100`

`RateLimitSnapshot` carries more blocking signals than the plan reads:

```ts
{ limitId, limitName, primary, secondary, credits, individualLimit,
  spendControlReached: boolean | null, planType,
  rateLimitReachedType: RateLimitReachedType | null }

RateLimitReachedType = "rate_limit_reached" | "workspace_owner_credits_depleted"
  | "workspace_member_credits_depleted" | "workspace_owner_usage_limit_reached"
  | "workspace_member_usage_limit_reached"
```

An account can be blocked below 100%. Since `reached` gates releasing real work,
Task 4 Step 2 must set it from `usedPercent >= 100 || rateLimitReachedType !== null
|| spendControlReached === true`.

Second half of this: a credits-depleted or spend-control block **has no reset
time**. Reset scheduling must be refused for those, not queued against a
`resetsAt` that will never clear it.

### B4. The sparse-update merge target is unspecified, and the multi-bucket case loses updates

A full read returns two views:

```ts
GetAccountRateLimitsResponse = {
  rateLimits: RateLimitSnapshot,                                  // legacy single bucket
  rateLimitsByLimitId: { [key: string]?: RateLimitSnapshot } | null,  // keyed by limit_id
  rateLimitResetCredits: RateLimitResetCreditsSummary | null,
}
```

The sparse notification carries **one** `RateLimitSnapshot`. Task 4 Step 2 says
prefer `rateLimitsByLimitId` when present; Task 4 Step 4 says merge the sparse
update "into the latest full response". Those combine badly: merging into
`rateLimits` while rendering from `rateLimitsByLimitId` updates nothing the user
sees, and nothing in the tests would catch it.

Specify: route the sparse snapshot by its `limitId` into the matching
`rateLimitsByLimitId` key. If `limitId` is null, or no key matches, **refetch**
instead of merging.

### B5. `limitId` is nullable, so the stable-ID scheme produces `null:primary`

Task 4 Step 2 builds IDs as `${limitId}:primary` / `${limitId}:secondary`, but
`limitId: string | null`, and the legacy `rateLimits` bucket is exactly where it
tends to be null. Give the legacy bucket an explicit ID (`default:primary`), and
state that a keyed bucket wins over the legacy bucket describing the same limit —
otherwise one window renders twice and `max(utilization)` ranking double-counts it.

### B6. `resetsAt` has no documented unit — do not assert one, reuse the existing heuristic

The generated type is a bare `number | null` with no unit comment. The plan says
"Confirm `resetsAt` is provider epoch seconds", but every phase-one test drives the
fake process, so the fake will simply encode whatever the plan assumed and the
assertion proves nothing.

`Usage.noteLimit()` (`src/usage.ts:47`) already solved this for the Claude SDK with
a plausible-seconds band. Reuse that helper for Codex rather than hard-coding
`* 1000`, and have the live smoke record the observed magnitude as evidence.

### B7. The reset gate as written breaks Claude auto-requeue

This is the highest-risk item. Task 6 Step 8:

> Build the existing `Ctx.free` exclusively from those authoritative results […]
> reset items must never fall back to local `Usage.free()`.

Today Claude reset items are created by auto-requeue at `src/server.ts:461` from
`usage.resetAt()`, which is populated by SDK rate-limit **events** (`noteLimit`) —
a completely separate channel from `probeLimits()`. A Claude account on an API key,
Bedrock, or a token without profile scope makes `probeLimits()` throw
(`src/agents/claude.ts:467`), so it has no authoritative snapshot, ever. Under the
new gate every one of its auto-requeue items is blocked forever.

That contradicts the plan's own global constraint: *"Preserve existing Claude
rate-limit events and Claude automatic requeue behavior."*

Fix: in phase one, route **Codex accounts only** through `releaseAfterFreshRead()`.
Claude accounts keep `usage.free()` unchanged. The same split applies to the
`parseSchedule()` 400 in Task 6 Step 7 and the disabled "When usage resets" control
in Task 7 Step 4 — otherwise Claude users lose a feature that works today.

### B8. An async `tick()` can stall timed items behind a hung provider read

Task 6 Step 8 puts provider reads inside `tick()`, under the existing `ticking`
lock (`src/server.ts:849-905`). Timed items correctly never consult `Ctx.free`
(`src/schedule.ts` `due()`), but after this change they still sit behind the await.
A wedged supervisor then delays "run this at 3pm" indefinitely.

Require: bound the boundary reads with a deadline (the client's 5s default is
fine), race them, and treat a timeout as *blocked* rather than waiting. Add a test
that a hung Codex read does not delay a due timed item.

## Smaller corrections

- **S1.** The spec calls the experimental request `tool/requestUserInput`; the real
  method is `item/tool/requestUserInput`. Full `ServerRequest` set to deny in phase
  one: `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`,
  `item/tool/requestUserInput`, `mcpServer/elicitation/request`,
  `item/permissions/requestApproval`, `item/tool/call`,
  `account/chatgptAuthTokens/refresh`, `attestation/generate`,
  `applyPatchApproval`, `execCommandApproval`. Name them in the test.
- **S2.** The server sends `remoteControl/status/changed` unsolicited immediately
  after `initialize`, and its params include the machine hostname (`serverName`)
  and an `installationId`. "Ignore unknown notifications" covers it, but make it an
  explicit test: this specific payload must never reach SSE or diagnostics.
- **S3.** Notification envelopes carry `emittedAtMs` beside `method`/`params`. The
  client's message validation must tolerate unknown top-level fields rather than
  treating them as malformed.
- **S4.** Real logged-out behavior, for the unsupported-account fixture:
  `account/read` → `{"account":null,"requiresOpenaiAuth":true}`;
  `account/rateLimits/read` → error `-32600`,
  `"codex account authentication required to read rate limits"`. Have the fake
  reproduce that pair exactly — note it is an *error response*, not an empty result.
- **S5.** Add `--strict-config` to `telemetryAppServerArgs()`. Verified: it rejects
  unknown keys (`Error: unknown configuration field 'x' in -c/--config override`)
  and accepts all three overrides. One flag turns "the override silently stopped
  working on a future CLI" into the preflight failure Task 1 Step 6 already wants.
- **S6.** `PlanType` is a closed enum including the literal `"unknown"`. `plan:
  string | null` is fine, but do not render `"unknown"` as a plan name.
- **S7.** Task 7 overstates the UI work. `accountView()` (`web/lib.js:721`) already
  returns a `windows` array and already titles `"% of the 5h limit"`. The change is
  how `windows` is built plus fresh/stale — not a rewrite.
- **S8.** The worktree instruction is necessary, not ceremonial: `src/worktree.ts`,
  `web/lib.js`, `web/style.css`, and `test/ui.test.ts` are dirty in the primary
  checkout right now, and Tasks 3/7 touch three of them.

## One thing the plan gets right that is worth not losing

Phase-one acceptance says an SDK turn failure must never trigger inferred recovery.
That is already true in the code — `shouldRequeue()` (`src/server.ts:229`) reads
`usage.resetAt()`, which only `noteLimit()` writes, and nothing writes it for Codex.
Task 3 Step 8's regression test is the right guard. Keep the new generic snapshot
out of `Usage#resets` and this property holds for free.

## Recommended order of changes before Task 1

1. Correct B1–B6 in the plan text (they are all normalizer/contract decisions that
   Tasks 1 and 4 encode into fixtures).
2. Correct B7 and B8 in Task 6 — provider-scoped gate, bounded reads.
3. Apply S1–S6 as test/arg details.
4. Then execute the plan as written. The task decomposition, TDD ordering, commit
   boundaries, and rollback boundary all hold up.
