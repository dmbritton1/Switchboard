# App-server rollout gate — started 2026-09-11

Decision: **keep SDK as the new-session default; app-server remains opt-in.**
The required soak is 20 successful turns, including five successful resumes,
across at least seven calendar days. Prior feature reports are supporting
compatibility evidence, not a substitute for a dated soak log.

## Current matrix

| Check | Evidence |
| --- | --- |
| Pinned runtime | SDK/CLI 0.153.4 |
| Lifecycle / telemetry / restart / resume / graceful interrupt / no replay / cleanup | Passed live 2026-09-11, production transport smoke |
| Command Allow/Deny / structured questions | Passed live 2026-09-09, linked feature reports |
| Browser screenshot through model | Passed live 2026-09-11; successful screenshot tool result and correct image text |
| Context compaction | Passed live 2026-09-11 |
| File approval | Passed live 2026-09-11: one approval, exact synthetic file written outside session sandbox, fixture cleaned |
| Simulator screenshot | Unavailable: zero available devices and zero booted iOS simulators; fixture coverage exists |
| SDK resume across upgrade | Passed: disposable conversation created with SDK/CLI 0.145.0 resumed through production 0.153.4 adapter; same thread and retained history |
| Recovery failure through automatic successful resume | Added deterministic HTTP/coordinator/Usage/Scheduler integration test; no real account exhausted |
| Seven-day soak | Tabled at user request; no recurring checks scheduled |

## Soak log

Only the standard four-completion lifecycle runs count here, keeping daily
counts comparable. Successful feature probes are excluded from these totals.
No prompts, answers, account identities, or environment values belong in this log.

| Local date (America/New_York) | Completed turns | Successful resumes | Protocol mismatches | Uncontained crashes | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| 2026-09-11 | 4 | 1 | 0 | 0 | All production lifecycle smoke checks true; clean shutdown |

Current totals: **4 turns, 1 resume, 1 calendar day**. Multi-day execution is
tabled at user request; there is no scheduled completion date.
The initial lifecycle run did not collect pending-request latency; later runs
must record timing summaries when requests occur, using null for no observations.
Recovery outcomes are deterministic-fixture observations; do not induce real
account exhaustion to obtain live reset evidence.

## Follow-up procedure

At most once per new local date, run the production bounded real-account
transport smoke with its explicit paid guard, in disposable worktrees. Use the
configured Codex account without printing its name or environment. Record only
sanitized booleans, counts, dates, elapsed time, start/crash/mismatch counts,
request timing summaries, and cleanup outcome. Stop on a failed run and report
it; do not replay failed work, consume reset credits, weaken policy, migrate
sessions, or change the default. Use the existing account configuration.

After seven distinct dates and at least 20 completions/five resumes, reassess all
matrix rows and publish a rollout recommendation. The cross-version legacy SDK resume gate has now passed.


## Scheduling status

No recurring check was created. Automatic approval review rejected the proposed
daily real-account automation because recurring usage consumption requires
explicit user approval. The user subsequently tabled multi-day work. Do not
schedule or run recurring checks unless the user explicitly resumes that work.

## Test and fixture notes

The new end-to-end recovery test uses the real HTTP server, coordinator, Usage,
and Scheduler, with fake provider boundaries. It verifies future-boundary waiting,
a fresh still-blocked read, fresh available capacity, exactly one successful resume,
and no duplicate replay. Ten related focused tests passed.

The first unrestricted file-change fixture lived under the writable temporary
area and did not request approval, so it does not count as approval evidence.
The subsequent outside-sandbox fixture did request approval and passed.
Temporary repositories, worktrees, local HTTP servers, and the outside-sandbox
file fixture were cleaned by the validation harness. No production restart or
transport-default change was needed for these test/documentation changes.

The initial sandbox-only full suite was invalid as a product assessment because
localhost listen calls were denied (EPERM). The authorized pre-live rerun passed
all 1,161 tests in 95.1 seconds. Final post-test-addition results are recorded below.

Final verification: `npm test` passed **1,162 tests, zero failures**, in 83.0
seconds after the new recovery integration test. `git diff --check` passed.
All five bounded live probe processes exited successfully after cleanup; the
first file probe's missing approval remains explicitly excluded from that gate.


## Immediate rollout closeout

The remaining cross-version check passed with two short synthetic turns. A
separately installed SDK/CLI 0.145.0 created a disposable conversation, then the
production 0.153.4 SDK adapter resumed its exact thread and recalled the previous
synthetic marker. Both used workspace-write and never approvals, with a test-only
gpt-5.6-sol/low setting compatible with the older runtime. No account or repository
configuration was changed. Temporary old dependencies and worktrees were removed.

A fresh simulator inventory found zero available devices and zero booted devices.
No simulator was created, booted, erased, or installed. This conditional live gate
remains unavailable, with existing fake-xcrun/image transport coverage retained.

All currently available one-off rollout checks are complete. The default remains
SDK because the multi-day gate is tabled, not passed. Interactive browser and
simulator design has not begun; the user requested a report before that stage.

Closeout verification: all **1,162 tests passed**, zero failures, in 78.3 seconds.
`git diff --check` passed. The production dependency pin, account configuration,
fixed policies, and SDK default remain unchanged; no production restart needed.
