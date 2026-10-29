# Codex app-server live validation — September 9, 2026

## Initial decision (superseded by the fixes below)

**Partially passed; not a production-default or full interaction-parity gate.**
Validation used main at `06f8997`, pinned Codex `0.145.0`, and the configured
ChatGPT-backed account. The user authorized live telemetry and guarded session
validation. No account, repository Codex configuration, transport default, or
runtime dependency was changed.

## Live telemetry

`npm run evaluate:codex-telemetry` passed with:

- Matching generated contract and telemetry launch profile.
- ChatGPT authentication, visible plan, and usable provider windows.
- No blocking limit state; reset timestamps in the seconds band.
- No forbidden methods and clean shutdown.

No notifications arrived during the bounded observation interval. This does
not establish live notification delivery or behavior at an actual reset boundary.
No raw account snapshots or account environment values are recorded here.

## Live turn transport

The production smoke harness was invoked with the configured account and its
paid guard. With inherited settings, it timed out waiting for the first turn.
A diagnostic run through the same production provider pool and adapter showed
that thread creation and prompt dispatch succeeded, followed by a provider 400:
the inherited `gpt-6-astra` model requires a newer Codex version.

A test-only `gpt-5.4` override was rejected as unsupported for this ChatGPT
account. The pinned runtime's model cache then identified `gpt-5.6-sol` as an
available model. With that explicit override applied only to smoke adapter
start options, the harness returned true for initialization, telemetry
continuity, thread creation, first turn, follow-up, process restart, resume,
interrupt, no replay, and clean shutdown. Three short response turns completed.
Temporary repositories/worktrees were cleaned by the harness.

**The interrupt boolean is insufficient evidence of graceful interruption.**
The diagnostic trace also contained a `codex_transport_crashed` event for a
sibling route while the interrupted route ultimately reported
`codex_user_stopped`. A focused reproduction confirmed:

- Stop approximately 10 ms after prompt dispatch: `turn/start` succeeds,
  `turn/interrupt` rejects with `AppServerRequestError`, and the adapter retires
  the shared generation before reporting user stop.
- Stop approximately 1.5 seconds after prompt dispatch: user stop succeeds
  without an observed RPC error.

This points to a startup timing race, but the exact provider rejection and
required synchronization are not yet established. The fallback prevents a
writer from being left alive, at the cost of retiring sibling routes. Do not
describe the current immediate-stop smoke result as a successful graceful
interrupt round trip. The harness's no-replay observation covers the queued
prompt becoming unsent; this run did not deliberately crash a live active turn.

The harness also waits for its observation deadline after terminal failure,
which hid the model rejection behind a generic first-turn timeout.

## Offline verification and prior timeout

- Focused rerun of `a short account environment value does not redact ordinary
  transcript text`: passed.
- `npm test`: **1,096 passed, zero failed**, exit 0, approximately 79 seconds.
- The previous full-suite timeout was not reproduced. Its helper allows two
  seconds for session completion and includes real fake-child startup; the
  fixture emits the relevant response without an intentional delay. Timing
  sensitivity is plausible, but no root cause or fix is claimed.

Production code and test timeouts were left unchanged.

## Required next work

1. Resolve the `gpt-6-astra`/pinned-runtime incompatibility. Updating the runtime
   requires revalidating its generated contract and safety launch profiles;
   alternatively, explicitly selecting a supported model avoids this particular
   incompatibility. Neither setting change was made during validation.
2. Diagnose and fix the immediate-stop race with an offline regression. Preserve
   fail-closed writer settlement and never weaken sandbox or approval policy.
3. Strengthen the live smoke to distinguish graceful interrupt acknowledgement
   from forced retirement, verify sibling continuity, and fail promptly on a
   terminal session error without exposing provider diagnostics.
4. Rerun the live lifecycle gate after those changes before beginning the
   interaction phase. Full-suite timing remains a watch item rather than a
   demonstrated production defect.

Approvals, questions, capability discovery, sidecars, automatic usage recovery,
and the new-session default cutover remain outside this validation.

## Follow-up fixes and live result

The user subsequently authorized fixes. The pinned SDK/CLI is now `0.153.4`.
The installed executable passes both the telemetry and turn generated-contract
checks. The stable schema adds `bedrockAccessKeys`; it remains unsupported for
ChatGPT limit scheduling, with the same explicit Bedrock explanation as the
existing Bedrock authentication mode. No extra methods or permissions were enabled.

The inherited `gpt-6-astra` configuration now completes real turns. Resume also
exposed a canonical-path difference: the top-level response cwd and stored
thread cwd can use different spellings for the same macOS directory. The
adapter compares filesystem canonical paths when spellings differ, still
rejecting a different directory or an unreadable path and enforcing the same
sandbox and approval policy. Offline coverage exercises both a valid alias and
a different existing directory.

The immediate-stop rejection was identified precisely as RPC code `-32600`
with message `no active turn to interrupt`. The client retains only a boolean
classification and discards raw diagnostic data. The adapter retries only that
exact rejection, at 20/40/80/160/320 ms intervals (six total attempts). Persistent
rejection and all other failures retain fail-closed generation retirement.
Offline regressions verify exact classification, bounded retries, and fallback.
No prompt or turn is replayed by this retry.

The smoke now fails promptly on terminal session errors, requires an actual
successful interrupt RPC, and sends another prompt through a sibling handle
after interruption. Its two live sessions have separate temporary worktrees.
A fake user-stopped event without an interrupt acknowledgement fails the gate.

The final live run on `0.153.4` with inherited model settings passed:

- Initialization and telemetry continuity through promotion.
- New thread, first turn, follow-up, process restart, and resume.
- Immediate interrupt: two transient rejections, then successful acknowledgement
  and an interrupted terminal notification, without retiring the shared process.
- A subsequent sibling turn completed successfully.
- Queued prompt remained unsent; clean shutdown and temporary-worktree cleanup.

Live telemetry separately passed with usable plan/windows and clean shutdown.
The bounded observation still did not witness unsolicited limit notifications;
actual usage exhaustion and reset-boundary behavior remain offline-tested.

A suite-load failure in the generator termination test was traced to killing
the fake child before its SIGTERM handler was ready. That test now waits for a
readiness marker before advancing a controlled timeout, and still verifies real
SIGTERM handling, forced termination, and process reaping. Production timeout
values were not increased. The earlier server redaction timeout has not recurred.

SDK remains the default, existing transport ownership is preserved, and no
account settings or repository Codex configuration were edited. This completes
the basic live lifecycle gate; it does not enable or validate deferred
interactions, tools, automatic usage recovery, or a production-default cutover.

Final verification: `npm test` passed **1,100 tests, zero failures**, exit 0
(approximately 80 seconds). The generator-readiness test passed again after
its cleanup/readiness ordering was tightened. `git diff --check` passed.
