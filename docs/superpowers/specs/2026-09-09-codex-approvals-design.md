# Codex approvals and needs-you

Status: implemented and verified; see the 2026-09-09 approvals validation report.

## Scope

Add command/file approval handling to app-server-owned Codex sessions. Reuse
the existing approval card, interrupt strip, Allow/Deny controls, and Auto toggle.
Keep SDK sessions on their existing policy and behavior. Questions, MCP forms,
capability discovery, screenshot tools, and automatic usage recovery remain
separate milestones.

## Policy decision

The user approved mirroring Claude's existing policy and behavior. Claude keeps
normal SDK permission checks and implements per-request Allow/Deny and Auto;
it does not enable blanket bypass. App-server Codex sessions therefore use fixed
`on-request` with `workspace-write` and the explicit `user` reviewer. SDK Codex sessions retain `never`. No policy
or sandbox control is exposed in settings.

Allow accepts only the presented action once; Auto accepts pending and future
eligible command/file requests individually. Ordinary sandbox escalation can
be requested through the provider's approval mechanism, as with Claude's
permission callback; `workspace-write` remains the launch policy, not a claim
that an explicitly approved action can never exceed it. Session-wide grants,
policy amendments, remote-environment requests (the provider’s `local` marker is accepted), file grantRoot, and the separate
additional-permissions API remain unsupported. Deny declines the request.
Turning Auto off restores prompting for subsequent requests.

## Request lifecycle

Keep wire IDs and callbacks in the account supervisor, scoped to its process
generation, thread, and session. Reject malformed, unknown, or misrouted requests.
Only command and file approval methods become accepted in turn mode. Telemetry
mode continues rejecting every server request.

Maintain a FIFO per session. Expose one redacted approval and a pending count;
use a separate opaque public interaction ID so stale browser decisions cannot
answer a newer request. Ordinary working events cannot override needs-you.

Allow/Deny marks the head responding and disables its controls. Advance only
on the matching serverRequest/resolved notification. Duplicate responses,
out-of-order resolutions, and stale IDs cannot resolve another request. Keep
needs-you while further approvals remain. Auto handles each eligible request
through the same lifecycle and turning it off affects subsequent decisions.

Stop declines unresolved requests before interrupting the turn. Completion,
crash, account retirement, and restart clear actionable approval state. If a
wire response fails, retain existing fail-closed writer/process handling.
Never restore actionable approvals from persisted state.

## Integration

Extend the existing approval interface narrowly rather than replacing Claude's
question behavior with the full future interaction system. Add request identity
validation at the HTTP boundary, returning conflicts for stale decisions.
Render provider strings as text, redact before Registry admission, and omit raw
provider params, secrets, permission amendment payloads, and absolute paths.

Retain Claude behavior and SDK behavior. Update contributor guidance to state
the app-server-only policy exception explicitly and keep strict settings keys.

## Verification

Offline tests cover command/file mapping, FIFO, Allow/Deny, Auto toggling,
resolution correlation, stale UI decisions, wrong-session routing, malformed
requests, redaction, stop/crash cleanup, and legacy SDK/Claude behavior.
Generated-contract checks cover both accepted request/response shapes and the
resolution notification without weakening telemetry checks. Run npm test.

An authorized bounded live gate validates one command approval round trip,
Deny, and Stop while blocked, with temporary isolated repositories and sanitized evidence.
Live Allow cases must be limited to a reviewed harmless command.
