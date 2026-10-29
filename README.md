# Switchboard

One window for coding-agent sessions across two Claude accounts and one Codex account.

## Setup

Requires Node >= 22.18 (runs TypeScript directly — there is no build step).

```bash
npm install
npm start   # http://127.0.0.1:4711
```

`accounts.json` is optional. With none present (or an empty one), the app
opens on a linking screen instead of the session grid; once at least one
account exists, add more from Settings → Accounts. Either way, linking is
browser-driven: click "Link Claude account" or "Link Codex account", approve
in the tab that opens, and — for Claude — paste back the code the callback
page gives you; Codex completes on its own once you approve, because `codex
login` runs a localhost callback server. That callback binds a fixed port
(1455), so two Codex links can never run concurrently; Switchboard extends the
same one-at-a-time rule to Claude too, as a deliberate simplicity choice
rather than a port constraint, so only one link can run at a time, globally,
regardless of provider. Once the provider confirms who you signed in as, name
the account (a name is
suggested from the email) and it's ready to use immediately — no restart.

Linked credentials land in their own directory under
`~/.switchboard/accounts/<name>/`, and the account's `env` is pointed at it
(`CLAUDE_CONFIG_DIR` or `CODEX_HOME`). Account names are constrained to
lowercase letters, digits and hyphens (max 32 characters) because the name
becomes that directory's path segment. `budget` isn't set from the UI —
linked accounts default to 2,000,000 and retuning it is still a file edit,
same as everything below.

`accounts.json` is co-owned: Switchboard only ever appends an entry it just
created or removes one by name, and never rewrites the file wholesale from
its in-memory copy — so a hand edit made while the app is running survives.
Hand edits still take effect on restart; links take effect immediately. The
shape below remains fully supported and is exactly what a link produces —
`accounts.example.json` still documents it for hand-editing:

```bash
cp accounts.example.json accounts.json   # then edit the paths
```

The second Claude account needs its own config directory. Log in once, interactively:

```bash
CLAUDE_CONFIG_DIR=~/.claude-alt claude   # log in as the second account, then exit
```

Confirm `~/.claude-alt/.claude.json` exists and its `oauthAccount.emailAddress`
differs from `~/.claude.json`'s. Then point `accounts.json`'s `claude-alt` entry
at it with an absolute path:

```json
{ "name": "claude-alt", "provider": "claude", "budget": 2000000,
  "env": { "CLAUDE_CONFIG_DIR": "/absolute/path/to/.claude-alt" } }
```

Codex selects its runtime deterministically: an explicit account `bin`, then a
compatible standard ChatGPT.app binary, then the SDK-bundled CLI fallback. An
explicit path is authoritative and must be an executable whose exact published
version matches the installed SDK (apart from build metadata). Create preflight
runs after Switchboard owns the new session and worktree; a failure retains that
stopped pair with an actionable error for diagnosis or retry. Handoff preflight
runs before either source or successor state changes, so a failure leaves the
handoff atomic. A mismatched ChatGPT.app binary is skipped in favor of the SDK
fallback. Switchboard is intentionally macOS-only.

The usual account uses automatic selection and the SDK transport:

```json
{ "name": "codex", "provider": "codex", "budget": 2000000, "env": {} }
```

`codexTransport` is an account-level rollout control for future Codex
sessions only. Omit it (or set it to `"sdk"`) to keep the SDK default; set it
to `"app-server"` only for an opted-in account. Each session saves its chosen
transport at creation and always resumes through that same transport, so
changing the account affects future sessions rather than migrating existing
vendor threads. It is not a browser setting.

Opted-in app-server sessions use the same account-scoped process as telemetry,
but every session retains immutable SDK or app-server ownership. App-server
sessions support start, follow-up, resume, and interrupt with the fixed
`workspace-write` sandbox and `on-request` approvals routed to the user. Rollback changes future
sessions by changing the account entry; it never transfers an existing vendor
thread between transports. Capability discovery, browser/simulator screenshots,
and automatic usage-limit recovery are implemented. App-server remains opt-in;
the new-session default has not changed. SDK sessions do not auto-requeue.

An optional explicit binary is documentation for a local account, not a
portable default:

```json
{ "name": "codex", "provider": "codex", "budget": 2000000,
  "bin": "/absolute/path/to/codex", "env": {} }
```

Run `codex login status` to check the selected account. Account `env` may set
`CODEX_HOME` (or another supported credential source); preflight runs login
status with that same launch environment. Switchboard preserves user and target
repository Codex configuration, applying only its fixed worktree safety
overrides: `workspace-write`, with `never` approvals for SDK sessions and
`on-request` plus the `user` reviewer for app-server sessions. App-server command
and file-change approvals use Allow/Deny and Auto, like Claude. Auto accepts
each request individually; it does not grant lasting permissions. An approved
escalation may run outside the launch sandbox. Session-wide grants, policy
amendments, and additional-permissions requests are unsupported.

Unlinking (from the account's row in Settings → Accounts) refuses while a
session on the account is `working` or `needs-you`, or while any queued item
names it — those are live or promised work on credentials about to disappear.
It's allowed over `done`/`stopped` sessions, which turn into a read-only
archive: transcripts, diffs, merge, push and delete keep working; only Resume
stops, since there is no account left to launch into. Unlinking deletes the
credential directory only when it is exactly the one Switchboard created for
that name (`~/.switchboard/accounts/<name>/`) — a hand-written entry like the
`claude-alt` one above, pointing at `~/.claude-alt`, is never touched.

"Hand off…" (in a session's menu) moves work to another account. It is offered
on `done` and `stopped` sessions only — handing off commits the source
worktree, and a `working` agent's half-written files must not be captured
underneath it. Pick a target account and a branch name, and Switchboard commits
whatever the source left outstanding, branches the new session's worktree from
the source branch, and opens the new session onto
`.switchboard/handoff.md` — the previous session's prompts, actions and replies,
rendered to markdown. The successor reads that for itself, so the account being
handed away from spends nothing; it works when that account is out of budget,
which is the case handoff exists for.

Reasoning is never written to that file, and `.switchboard/` is excluded from
the outstanding-work commit the same way pasted uploads are, so a handoff
document can never reach a merge target. The source session is stopped — Resume still
works, but leaving it running would let it edit a branch the new session is
already based on.

A Claude session can message another session on the same repository. It has two
tools: one lists the sessions it can reach, one sends to a chosen session. A
relayed message arrives the way a message you type does, so a session mid-turn
picks it up when that turn ends — and a Codex session can receive one even
though it cannot yet send.

Approval is per conversation rather than per message. The first send between a
pair raises the usual approval card showing the target and the message; once you
allow it, that pair exchanges freely. After ten messages the channel closes
itself and the next send asks again, which is where you decide whether the
exchange is still worth what it is spending. Denying leaves it closed.

`auto` means never ask about relays: a session with auto-approve on opens
channels and carries past checkpoints without a card. That is the one setting
that removes the loop protection, and an unattended pair spends two accounts
rather than one.

Typing `@` in the composer lists the other sessions on that repository and
inserts a short note naming what the session is, so the agent knows the name
refers to something it can reach. The mention itself sends nothing.

Sessions on one repository are also checked against each other for overlapping
work. A session's card shows `↔ feat/other` when the two have an open relay
channel, and `⚠ 3 files also in feat/other` when they have changed the same
files without one — the second is the one worth looking at, because it is a
merge conflict that has not happened yet. Hovering names the files, capped at ten
with "and N more" if there are more; the badge count is the true total. An agent
learns about overlap through `list_sessions`, which it must call to find out — there
is no push, injection, or interrupt, so an agent that never calls the tool never learns.
With that information, a session can see who is in the file it is about to change and
message just that session rather than all of them.

Overlap counts committed work as well as uncommitted: two sessions that each
committed a change to the same file have clean worktrees and still collide.
Pasted uploads and handoff documents are excluded, the same way they are
excluded from the outstanding-work commit.

It is advisory and nothing more. It never blocks a merge, never refuses an edit,
and never claims a file — it is "also changed in", not "locked by". The paths are
recollected at most every thirty seconds per session, so a badge can lag a change
by that much, and can briefly show on one side of a pair before the other.

`accounts.json` and `state.json` are both gitignored. The app writes to
`state.json` next to the server on every command and, coalesced to at most one
write every two seconds, on any other state change — so a session that runs to
completion unattended is still on disk. Usage samples are saved alongside the
sessions, which is why account pace survives a restart. `state.json` is
`{ sessions, usage, queue, settings }`; a file from an older build (a bare
session array) still loads, minus usage history.

## What it does

Each session runs in its own git worktree at `<repo>/.claude/worktrees/<branch>`.
The grid sorts blocked-first: `needs-you`, `working`, `done`, `stopped`. Claude
permission prompts (Allow/Deny) are answered from the card, from the open
session's own header (visible on whichever of its tabs you're on), or — for a
*different* session while one is already open — from an interrupt band inside
the session view. App-server Codex approvals use these same surfaces and enter
`needs-you`. Concurrent requests queue in order; a submitted decision remains
disabled until Codex confirms resolution. Stop declines outstanding requests.
SDK Codex sessions retain `never` and have no interactive approvals.

App-server Codex supports structured questions in the same surfaces. Its turn
process enables the runtime’s normal-mode question feature. Questions
appear one at a time with choice buttons, typed input when supported, and masked
input for secret answers. Auto never answers them. The final answer submits the
whole request; Skip discards the request's partial answers. Drafts survive UI
updates and failed submissions, but disappear after resolution or Stop. Answers
are delivered to Codex without being appended to Switchboard's transcript or
saved state.

Connected MCP tools can request forms or a page visit. Forms support text,
numbers, booleans, and selection lists with Submit, Decline, and Cancel controls.
Auto never supplies these values. Drafts survive failed submissions and updates;
submitted values bypass the Switchboard transcript and saved state. URL requests
show the destination origin and open only when clicked; full URLs stay in the
live adapter until that redirect. Unsupported schemas and extended OpenAI form
modes are cancelled. MCP schema defaults are not automatically filled in.

When Claude asks a question (`AskUserQuestion`), the same three places show the
question text and one button per option instead of Allow/Deny; the pick is
recorded in the transcript and handed back to the agent as the tool result.
`Skip` declines the question, after which the agent re-asks in prose and the
message box answers it. Questions ignore auto-approve — auto-approving one
would answer it "the user did not answer" and the question would flash past.

Opening a card opens a session view with Chat, Diff and Graph tabs, sharing
one header that carries a `⋯` menu and the single action the session's state
calls for. Chat is the transcript and message box for steering the agent; tool
calls show their outcome (`ok`/`error`) once it is known. A `working` session's
card action is a Stop button; a blocked (`needs-you`) session's card slot is
Allow/Deny instead, so Stop for it lives in the `⋯` menu. Either way, Stop
halts the agent and leaves the session `stopped` with a Resume button; nothing
is deleted.

Deleting a session is reached through its `⋯` menu's Delete… item, which opens
a confirmation dialog with a "remove worktree" checkbox; deleting always
forgets the session, and checking the box additionally runs
`git worktree remove` (falling back to deleting the directory) on confirmation
— which **discards any uncommitted work in that worktree**.

Claude accounts show their real claude.ai plan usage: Switchboard asks the
Agent SDK for the 5-hour and 7-day rate-limit windows every five minutes, using
each account's own launch environment. This costs no tokens — the probe starts
a session that is never given a prompt. The meter badge always headlines the
5-hour window (falling back to 7-day only for a plan that doesn't report one);
tap it open for both numbers, so a nearly-exhausted week is never hidden, just
not the badge's headline. The bar's fill/color and the New Session picker's
"freest account" ranking still use the worse of the two windows, so a
nearly-exhausted week still counts against an account there even though the
badge reads a quiet 5h number. The API is marked experimental by the SDK and
may change.

Everything else falls back to an estimate from observed token spend against the
`budget` in `accounts.json`: Codex accounts, API-key/Bedrock/Vertex accounts
(where plan limits do not apply), and any account whose probe fails — the
account panel says which. Those estimates are labelled `~` and "estimate" in
the UI, and the two providers aren't measured identically: the Claude adapter folds
`cache_creation_input_tokens` and `cache_read_input_tokens` into the input
count (a recorded session showed 86 tokens counted before that fix, 38,012
after — cache tokens are most of real spend under prompt caching), while the
Codex adapter deliberately does not add `cached_input_tokens` or
`reasoning_output_tokens` on top of its totals, because those look like
subsets of the reported totals rather than separate counters — an assumption
noted in the code, not a confirmed one. Keep that in mind when tuning `budget`
per account.

Codex accounts with managed ChatGPT authentication also show provider plan
windows through a separate app-server telemetry process. The shortest window is
the meter headline, so a reported five-hour window is the five-hour reading;
expanded account panels retain every provider window and the plan name. This
process is shared with opted-in app-server sessions; SDK-default and legacy SDK
sessions continue to use the SDK. If telemetry is unavailable, unsupported, or fails
after a successful read, its process-local snapshot becomes stale and the UI
falls back to the clearly labelled local token-pace estimate. Provider snapshots
are never written to `state.json`.

## Scheduling

Cards can be created for later instead of now, and messages can be scheduled into
an existing session. The New worktree dialog's **Run** field takes `Now`, `At a
time…` (a native date-time picker) or `When usage resets`; the ⏱ button beside
the chat composer schedules a message the same way. Queued items show in a strip
above the grid and can be removed from there.

`When usage resets` remains a real event/pace path for Claude accounts: the
Agent SDK streams a `rate_limit_event` carrying the timestamp at which the
window rolls, and its existing `Usage.resetAt()`/`Usage.free()` behavior is
unchanged. For Codex, scheduling is available only from fresh, resettable
provider windows and Switchboard performs a new authoritative read when work
reaches that reset boundary before releasing it. Credit depletion,
workspace-usage limits, and spend-control blocks have no authoritative reset
time in this phase, so their work remains manually resumable rather than being
released automatically.

When a Claude session dies while its account is past its limit, a resume is
queued automatically for when the window rolls; the card appends a line reading
`⏱ waiting for reset` below the status. With automatic recovery enabled,
Codex app-server sessions queue one `continue` resume only after a structured
usage-limit failure and a fresh read confirming a future reset. Multiple reached
windows must all clear before release. Other failures and SDK sessions do not
auto-requeue. Stopping a session yourself never queues anything. Items waiting on one account fire one at a time, so a freshly
reset window is not spent all at once — items waiting on a clock fire at their
time regardless of what else is running.

Scheduled items are one-shot; there is no recurrence. A time that passes while
Switchboard is down fires on the next start if it is less than 12 hours late
(`GRACE_MS` in `src/schedule.ts`), and is marked `missed` if it is older than
that. The queue lives in `state.json` alongside the sessions.

## Settings

The `⚙` button opens a dialog for seven preferences: `autoApprove` (new
sessions start with auto-approve already on, instead of prompting on the
first tool call — recorded for Codex sessions too, though their SDK has no
interactive approval to skip), `account` (which account the New dialog
preselects; `null` ranks by usage and picks the freest, and a pinned account
that has since been removed from `accounts.json` falls back to freest the
same way), `branchPrefix` (prefilled into the New dialog's branch field),
`notifyOn` (which status transitions raise a browser notification, chosen
from `needs-you`, `done`, `stopped`), `sort` (grid order — `blocked` puts
blocked sessions first, then running, then finished; `newest` is flat
recency; `account` groups by account, blocked-first within each group),
`collapseDone` (hides finished sessions, but deliberately not `stopped`
ones — those carry a Resume button and unfinished work), and `autoRequeue`
(whether a Claude session that dies while its account is past its limit
still gets a resume queued automatically; turning it off disables the
auto-resume behavior described under Scheduling above). Every default
reproduces the behavior the app had before settings existed, so an empty or
missing settings block changes nothing.

`notifyOn` supports approval notifications for Claude and app-server Codex.
SDK Codex sessions notify on `done` and `stopped`, since they have no
interactive approval callback.

Settings live in `state.json` alongside `sessions`, `usage`, and `queue`, and
the file is meant to be hand-editable: on load, an invalid or unknown-typed
value falls back to its default rather than throwing, and an unrecognized
key is dropped. The `settings` HTTP command is deliberately stricter — it
rejects an unknown key or a wrong-typed value with a 400 — because that file
is written only by this app, while the command is an unauthenticated
localhost POST that now changes how agents launch; a client sending
`sandboxMode`, for instance, should learn it was rejected rather than believe
it took effect.

Theme and notification sound are deliberately not settings. Theme was cut
because `web/style.css` is dark-only: twelve custom properties in `:root`
plus roughly forty more hardcoded colors past them, so a light theme means
authoring a second palette, not wiring up a toggle. Sound was cut because
macOS Notification Center already controls it, and better than this dialog
could. Codex's sandbox mode (`workspace-write`) and approval policy
(`never` for SDK, `on-request` for app-server) are deliberately not settable, and must not become settable —
see Safety boundaries in `AGENTS.md`.

## Tests

```bash
npm test
```

The normal suite is hermetic: it uses a fake Codex process, a temporary
`CODEX_HOME`, and the real SDK process boundary. It does not contact OpenAI,
spend a model turn, or read a real Codex account.

The optional compatibility smoke check is manual-only. It launches the selected
Codex account's app-server with the telemetry safety profile, verifies the
pinned protocol contract, initializes it, reads account state without refreshing
credentials, reads rate limits, observes only naturally occurring notifications
for a short bounded period, and shuts it down. It never creates or reads a
thread, starts a turn, refreshes auth, consumes reset credits, or produces
usage:

```bash
npm run evaluate:codex-telemetry
```

Its one-line JSON output is intentionally redacted: it records only safe
compatibility evidence such as window presence and reset-timestamp magnitude,
not email addresses, tokens, raw provider responses, machine identifiers,
paths, or account environment values. Running it against a real configured
account is optional and requires separate operator intent; it is not part of
`npm test`.

The separate transport smoke drives the production provider pool and adapter
against a deterministic fake child in the offline suite. A real run consumes
Codex turns and is refused before starting a provider, worktree, thread, or
turn unless both an explicitly configured Codex account and the paid guard are
provided:

```bash
SWITCHBOARD_ALLOW_PAID_CODEX_SMOKE=1 \
  npm run smoke:codex-app-server-transport -- --account <configured-codex-account>
```

It uses bounded no-tool prompts, cleans its temporary worktree in `finally`,
and prints only sanitized evidence. It is not part of `npm test`; do not run it
without intentionally authorizing those paid turns.

## Limits

- Only sessions started here are shown. Sessions from the Claude desktop app or
  ChatGPT.app are invisible to it.
- The server only answers requests whose `Host` header is `127.0.0.1` or
  `localhost` — every route, with no exemptions, since even the read-only ones
  return local repo paths and transcripts (`/command` also checks `Origin`), to
  close a DNS-rebinding hole:
  it runs unauthenticated and a POST can create worktrees, launch processes, and
  delete directories. Practically, this means the app is not reachable from a
  LAN IP, a custom hostname, or another device — only from a browser on the same
  machine hitting `127.0.0.1`/`localhost` directly. That's deliberate, not a bug.
- Agents are children of the server process. Stopping or restarting the server
  kills them; on restart, `Registry.load` brings every saved session back as
  `stopped` with its transcript intact but `pending` cleared — nothing is
  actually still running. The Resume button relaunches the agent (passing the
  vendor session id, so Claude/Codex can pick the conversation back up) and the
  card moves to `working` once the adapter starts producing events again.
- SDK Codex has no approval callback, only a start-of-thread `approvalPolicy`.
  SDK Codex sessions run
  with `approvalPolicy: 'never'` and are sandboxed to their own worktree
  (`sandboxMode: 'workspace-write'`) instead; `decide()` on an SDK Codex session is a
  no-op. Runtime preflight validates a selected macOS binary and compatibility.
  Create preflight runs after Switchboard owns the stopped session and worktree,
  retaining that pair on failure; handoff preflight is failure-atomic before
  source or successor mutation. It normally checks readiness with `codex login
  status`: recognized logged-out errors fail with actionable remediation. If a
  compatible CLI does not support that subcommand, preflight records a
  diagnostic and defers authentication checking until Codex starts. Launch,
  resume, stream, sandbox, authentication, and user-stop failures use
  persistent session errors with stable codes and actionable remediation rather
  than a transient toast.
- Every written initial prompt is displayed for both Claude and Codex. Codex
  prompts are marked `queued`, then `sent` once the child acknowledges the
  accepted stdin write; queued prompts left by a failure, stop, or restart become
  `unsent` and remain visible.
  They are never replayed automatically: copy or resend them after resume if
  still needed.
- Transport is SSE (`GET /events`) + `POST /command`, not WebSocket — the
  traffic is one-directional in each channel (server pushes state, browser
  posts commands), and `EventSource` reconnects on its own with no extra code.
- All browser commands await `/command` and retain non-2xx responses in their
  relevant persistent surface (session, queue, dialog, or selection toolbar).
  This replaces the old transient session-error toast. The server rejects the
  dangerous cases rather than pretending — a `send` to a session with no live
  agent is a 404, not a 200 with the prompt dropped, and a `resume` on a session
  that is not `stopped` is a 409 rather than a second agent launched into the
  same worktree. Delete's actual risk is stale
  bookkeeping, not lost work: if `git worktree remove --force` fails, the fallback already
  `rm -rf`s the directory before the session is removed from the registry
  unconditionally — so a vanished card means git's own worktree registration
  for that path is now orphaned, not that data survived. `git worktree list`
  shows the stale entry; `git worktree prune` clears it. (The one case a
  delete leaves the card in place is when that `rm -rf` fallback fails too.)
- The scheduler ticks every 30 seconds and only runs while the server does — a
  scheduled item is not an OS-level cron job, and nothing fires with Switchboard
  closed. The auto-requeue heuristic applies only to Claude accounts: any Claude
  session that dies on its own while its account is past its limit gets a resume
  queued, including one that died of something unrelated. Codex app-server
  recovery instead requires the structured usage-limit error and fresh reset
  eligibility. SDK sessions remain outside automatic recovery. The visible queue
  row can be deleted; turning recovery on later does not replay old failures.

## Codex Phase 2 behavior

Codex tool activity is one live row per item: it changes from `running` to
`ok` or `error` instead of adding duplicate rows. Command, edit, and MCP detail
is redacted before storage, capped at 32 KiB per item and 2 MiB across all
sessions. When the global cap is exceeded, Switchboard evicts whole detail
bodies in least-recently-updated order. The row and its eviction metadata stay
visible. Detail bodies are persisted but omitted from SSE; the browser fetches
the already-redacted body lazily by session and item ID, refreshes it only when
its revision changes, and keeps an expanded row open across transcript rebuilds.

Reasoning summaries and todo status are separate transcript entries. They are
not raw hidden reasoning. PNG, JPEG, and WebP uploads become native SDK
`local_image` input. Other uploaded files remain worktree-relative path
references in the text input; absolute paths never enter browser history. A
rejected send keeps its draft and pending attachments so it can be retried, and
a failed upload remains visible until retried, dismissed, or the operator moves
to another session.

Codex thread settings are optional. Omitted settings inherit the selected
Codex/user/repository configuration; only explicit settings are saved and used
again on resume. Settings cannot be changed during an active turn, but a
stopped session can update them for its next resume. The worktree directory,
`workspace-write` sandbox, and transport-specific approval policy are mandatory
overrides and are not browser settings. App-server sessions also force the
`user` reviewer so inherited automatic review cannot bypass Switchboard's cards.

The session shows the SDK's last-turn usage fields when available. Account pace
remains an estimate from observed input/output spend against the local account
budget, not a provider rate-limit or plan-limit reading.

The no-turn app-server evaluators remain limited to real, installed-`0.153.4`
schema-generation, initialization, authentication-state, and clean shutdown;
they never create a thread or spend a turn. The deterministic transport fake
proves the opt-in app-server path separately. The September 9 live validation
initially found runtime compatibility, canonical-path resume, and immediate-stop
issues. The fixes upgrade the pinned runtime to `0.153.4`, preserve canonical
worktree identity on resume, and retry only a bounded transient interrupt
rejection. Live telemetry and the strengthened lifecycle gate subsequently
passed with inherited `gpt-6-astra` settings, including sibling continuity after Stop. See the
[live validation report](docs/superpowers/reports/2026-09-09-codex-app-server-live-validation.md).
SDK remains the default and the hybrid path remains rejected.
See
[`docs/superpowers/reports/2026-08-01-codex-app-server-decision.md`](docs/superpowers/reports/2026-08-01-codex-app-server-decision.md).
Fake evidence does not establish live parity and does not cover deferred
interactions, capabilities, sidecars, recovery, or a production-default flip.

## Verification

```bash
npm test
```

The normal suite is offline and uses fake Codex processes. The optional bounded
no-turn evaluator uses the installed local Codex app-server, initializes it,
reads auth state without refresh, and shuts it down; it does not create a
thread or spend a model turn:

```bash
npm run evaluate:codex-app-server
```

### Codex capability discovery

Live Codex app-server sessions expose a **Capabilities** button in the composer.
Search skills, apps, and MCP tools, inspect availability, refresh the inventory,
and select an entry to insert a `/skill:…`, `/app:…`, or `/mcp:…` alias.
The server resolves the selection in that session's account and worktree and
checks it again before dispatch. Skills and apps use native Codex inputs;
MCP selections add an explicit tool request to the prompt. Unavailable selections
are rejected without sending. Native paths and app identifiers are not included
in the public catalog. Type `/` to search skills (including plugin-provided
skills), apps, MCP tools, and built-in commands in the composer. `/skills`,
`/apps`, and `/mcp` open filtered lists. `/compact` compacts context through the
app-server and holds subsequent prompts until it finishes; it accepts no
arguments or attachments.

The new-session dialog offers **Preview capabilities** for an app-server account
and an existing Git repository. Preview reads skills and account apps without
creating a session. MCP and screenshot availability is discovered after session
creation, when the worktree's servers are known. Refresh clears stale selections;
unavailable entries explain why they cannot be selected.

### Codex screenshot tools

App-server sessions can discover `switchboard_browser.screenshot` and
`switchboard_simulator.screenshot` through **Capabilities**. Browser screenshots
accept HTTP/HTTPS URLs and optional viewport dimensions. They use an installed
Chromium-family browser with a temporary profile and require network access in
the effective worktree/session settings. Simulator screenshots require macOS
and a booted iOS Simulator; an optional device name or UDID selects the device.

The tools capture images only. They do not click, type, boot devices, or install
apps. Configuration is added to thread start/resume in memory, preserving user
MCP servers and repository files. A conflicting server name is left untouched,
and the catalog shows a warning. Sidecars run with a clean environment and do
not receive account launch secrets. Existing sessions need to be stopped and
resumed after the Switchboard server loads this update.
