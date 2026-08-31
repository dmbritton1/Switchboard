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
version matches the installed SDK (apart from build metadata); otherwise
preflight fails before a worktree or session is created with an actionable
error. A mismatched ChatGPT.app binary is skipped in favor of the SDK fallback.
Switchboard is intentionally macOS-only.

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
`workspace-write` sandbox and `never` approval policy. Rollback changes future
sessions by changing the account entry; it never transfers an existing vendor
thread between transports. Approvals and other interactions, capability
discovery, browser/simulator MCP sidecars, automatic Codex usage recovery, and
an app-server default cutover remain deferred. Codex sessions never
auto-requeue in this phase.

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
overrides: `sandboxMode: 'workspace-write'` and `approvalPolicy: 'never'`.
There are no interactive Codex approvals.

Unlinking (from the account's row in Settings → Accounts) refuses while a
session on the account is `working` or `needs-you`, or while any queued item
names it — those are live or promised work on credentials about to disappear.
It's allowed over `done`/`stopped` sessions, which turn into a read-only
archive: transcripts, diffs, merge, push and delete keep working; only Resume
stops, since there is no account left to launch into. Unlinking deletes the
credential directory only when it is exactly the one Switchboard created for
that name (`~/.switchboard/accounts/<name>/`) — a hand-written entry like the
`claude-alt` one above, pointing at `~/.claude-alt`, is never touched.

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
the session view. Codex runs sandboxed to its worktree with
`approvalPolicy: 'never'` and never enters `needs-you` — see Limits below.

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
`⏱ waiting for reset` below the status. Codex sessions never auto-requeue,
because automatic recovery of an SDK-owned Codex failure is deferred until a
future app-server turn transport is approved. Stopping a session yourself never
queues anything. Items waiting on one account fire one at a time, so a freshly
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

`notifyOn` closes a real gap: Codex sessions never enter `needs-you` (they
run with `approvalPolicy: 'never'` and no interactive approval — see Limits
below), so before this setting existed a Codex session produced no browser
notification, ever. `done` and `stopped` are the only transitions a Codex
session has to notify on.

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
(`never`) are also deliberately not settable, and must not become settable —
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
- Codex approvals are policy, not interactive — `@openai/codex-sdk` has no
  approval callback, only a start-of-thread `approvalPolicy`. Codex sessions run
  with `approvalPolicy: 'never'` and are sandboxed to their own worktree
  (`sandboxMode: 'workspace-write'`) instead; `decide()` on a Codex session is a
  no-op. Runtime preflight validates a selected macOS binary and compatibility
  before creating a worktree, and normally checks readiness with `codex login
  status`: recognized logged-out errors fail with actionable remediation. If a
  compatible CLI does not support that subcommand, preflight records a
  diagnostic and defers authentication checking until Codex starts. Launch,
  resume, stream, sandbox, authentication, and user-stop failures use
  persistent session errors with stable codes and actionable remediation rather
  than a transient toast.
- Every written initial prompt is displayed for both Claude and Codex. Codex
  prompts are marked `queued`, then `sent` immediately before delivery; queued
  prompts left by a failure, stop, or restart become `unsent` and remain visible.
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
  queued, including one that died of something unrelated. Codex sessions never
  auto-requeue, since the Codex SDK reports no rate-limit signal. The visible
  queue row for an auto-requeue is one you can delete, which is the trade made to
  avoid matching on provider error text.

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
`sandboxMode: 'workspace-write'`, and `approvalPolicy: 'never'` are mandatory
overrides and are not settings users can weaken.

The session shows the SDK's last-turn usage fields when available. Account pace
remains an estimate from observed input/output spend against the local account
budget, not a provider rate-limit or plan-limit reading.

The no-turn app-server evaluators remain limited to real, installed-`0.145.0`
schema-generation, initialization, authentication-state, and clean shutdown;
they never create a thread or spend a turn. The deterministic transport fake
proves the opt-in app-server path separately, while the paid transport gate is
currently not run. SDK remains the default and the hybrid path remains rejected.
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
