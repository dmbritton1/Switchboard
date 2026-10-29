# Codex app-server approvals validation — 2026-09-09

## Delivered

App-server sessions now mirror Claude’s per-request Allow/Deny and Auto behavior.
They use `workspace-write`, `on-request`, and an explicit `user` reviewer on both
start and resume. SDK sessions retain `never`; the default transport remains SDK.
No account rollout settings were changed.

Command and file approvals use the existing needs-you surfaces. Requests queue
in order with opaque public IDs, redacted summaries, pending counts, and a
responding state until upstream resolution. Stale and duplicate HTTP decisions
are rejected. Stop declines outstanding requests before interrupting. Auto is
available for app-server sessions and accepts requests individually.

Remote environments, file grantRoot, additional-permissions requests, questions,
and persistent policy grants remain unsupported. Approved command escalations
can exceed the launch sandbox, consistent with the user-approved policy.

## Verification

- Focused adapter/queue run: 179 passed.
- Focused HTTP/contract run: 245 passed.
- Full `npm test`: **1,108 passed, zero failures** (77.8 seconds).
- `node --check web/app.js` and `git diff --check`: passed.
- Live configured Codex 0.153.4, using isolated temporary repositories and only
  `printf SWITCHBOARD_APPROVAL_OK`: Allow published the responding state,
  received upstream resolution, and completed with READY. Deny resolved and
  completed with DENIED. Stop while waiting cleared the approval and returned
  `codex_user_stopped`; cleanup completed.

The live probe identified two integration gaps: inherited automatic reviewers
could bypass Switchboard, and local shell approvals carry `environmentId:
"local"`. Start/resume now force and validate the user reviewer; the approval
filter accepts the local marker while still rejecting remote environments.
A first non-interactive probe could not submit its decision because stdin was
closed; its timeout stopped the turn and cleanup completed. It was rerun with
an interactive input channel for the successful Allow check.

An earlier full run had one timing-sensitive telemetry auth-cycle fixture
failure. Its focused rerun and the final full suite both passed.
Live file-change approvals, Auto, and visual browser rendering were not separately
exercised; file approvals and Auto are covered through the real stdio fake,
Registry integration, and HTTP tests. No running app was restarted.
