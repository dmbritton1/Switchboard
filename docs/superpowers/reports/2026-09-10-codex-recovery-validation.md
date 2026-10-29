# Automatic usage-limit recovery validation — 2026-09-10

App-server turns map only structured `usageLimitExceeded` to the public stopped
code `codex_usage_limited`. Other failures, SDK sessions, and manual Stop do not
enter automatic recovery. Pending interactions are cleared before stopped state.

With existing Auto-requeue enabled at failure, the server requests fresh account
limits and enqueues one visible `continue` resume only when all reached windows
have future reset times and no non-resettable block exists. Existing queue items
are preserved. Candidate tokens reject late results after Stop, deletion, manual
resume, or disabling recovery; duplicate terminal events cannot recreate work.

The existing scheduler still requires fresh authoritative capacity, blocks busy
accounts, and releases at most one reset item per account per pass. Persisted
snapshots never grant capacity. Old in-flight telemetry reads are drained before
boundary/recovery reads; concurrent boundary calls coalesce. Failed resume
attempts retain their queue entries for failure reporting. Deleted dispatch items
are rechecked before execution.

Validation:
- Structured failure paths and fake stdio transport, including duplicate terminal
  events; raw provider detail and absolute paths remain private.
- Adapter/scheduler focused run: 199 passed before the added stdio regression.
- Coordinator/scheduler/UI focused run: 168 passed.
- Supervisor freshness regression verified failing before the fix; 95 passed.
- HTTP recovery/cancellation/failed-resume regressions: 7 passed.
- No paid model turn or intentional real-account limit exhaustion was used.

App-server remains opt-in. Remaining roadmap work is live compatibility and
sustained-reliability validation before considering a default change.

Final verification completed 2026-09-11: `npm test` passed all 1,161 tests with
zero failures in 82.8 seconds after the queue-retention fix. `git diff --check`
passed. All six sessions were confirmed stopped before restarting Switchboard;
the restarted server served the recovery UI module successfully over HTTP.
No active session was interrupted and no account setting was changed.
