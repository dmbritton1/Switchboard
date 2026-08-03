# Switchboard

One window for coding-agent sessions across two Claude accounts and one Codex account.

## Setup

Requires Node >= 22.18 (runs TypeScript directly — there is no build step).

```bash
npm install
cp accounts.example.json accounts.json   # then edit the paths
npm start                                # http://127.0.0.1:4711
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

The usual account uses automatic selection:

```json
{ "name": "codex", "provider": "codex", "budget": 2000000, "env": {} }
```

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

`accounts.json` and `state.json` are both gitignored. The app writes to
`state.json` next to the server on every command and, coalesced to at most one
write every two seconds, on any other state change — so a session that runs to
completion unattended is still on disk. Usage samples are saved alongside the
sessions, which is why account pace survives a restart. `state.json` is
`{ sessions, usage }`; a file from an older build (a bare session array) still
loads, minus usage history.

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
a session that is never given a prompt. The meter shows whichever window is
further along, so a nearly-exhausted week cannot hide behind a quiet afternoon.
The API is marked experimental by the SDK and may change.

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

## Scheduling

Cards can be created for later instead of now, and messages can be scheduled into
an existing session. The New worktree dialog's **Run** field takes `Now`, `At a
time…` (a native date-time picker) or `When usage resets`; the ⏱ button beside
the chat composer schedules a message the same way. Queued items show in a strip
above the grid and can be removed from there.

`When usage resets` is a real signal for Claude accounts, not a guess: the Agent
SDK streams a `rate_limit_event` carrying the timestamp at which the window
rolls, and that timestamp is stored per account. The Codex SDK reports no rate
limits at all, so a Codex account falls back to the same estimate the account
bars show — the item fires once the trailing-5h token pace (tokens spent ÷
`budget`) drops below `RESET_PACE` (0.8, in `src/usage.ts`). That fallback is only
as good as the budget you tuned in `accounts.json`, same caveat as the bars.

When a Claude session dies while its account is past its limit, a resume is
queued automatically for when the window rolls; the card appends a line reading
`⏱ waiting for reset` below the status. Codex sessions never auto-requeue,
because the Codex SDK reports no rate-limit signal. Stopping a session yourself
never queues anything. Items waiting on one account fire one at a time, so a
freshly reset window is not spent all at once — items waiting on a clock fire at
their time regardless of what else is running.

Scheduled items are one-shot; there is no recurrence. A time that passes while
Switchboard is down fires on the next start if it is less than 12 hours late
(`GRACE_MS` in `src/schedule.ts`), and is marked `missed` if it is older than
that. The queue lives in `state.json` alongside the sessions.

## Tests

```bash
npm test
```

The normal suite is hermetic: it uses a fake Codex process, a temporary
`CODEX_HOME`, and the real SDK process boundary. It does not contact OpenAI,
spend a model turn, or read a real Codex account.

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

Phase 2 remains intentionally out of scope: live item lifecycle rendering,
bounded/redacted tool details, reasoning and todo presentation, structured
local-image input, inherited-by-default per-session settings, and the
SDK-versus-app-server interactive-approval
evaluation.
