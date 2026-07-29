# Switchboard — design

One window that runs coding agents across three accounts: two Claude, one Codex.
It launches them, shows what each one is doing, and lets you answer them without
leaving the window.

## Problem

Running three agents in parallel means three windows, three sets of permission
prompts, and no way to see which one is blocked on you. The cost isn't the
switching — it's that a session sits idle for ten minutes because nothing told
you it was waiting.

## Scope

In:

- Launch sessions on any of three accounts, each in its own git worktree.
- A card grid showing every session's status, branch, and worktree diff.
- Answer permission prompts from the grid; type prompts in a chat view.
- Browser notification when a session starts waiting on you.
- Approximate per-account usage, and auto-routing new sessions to the freest account.

Out:

- Sessions started outside Switchboard. It is the launcher; if it didn't start
  it, it doesn't show it.
- Worktree conflict detection, merge, rebase, delete-branch.
- Moving a running session between accounts.
- Any UI test.

## Environment

Established by inspection on 2026-07-28, not assumed:

- Claude sessions are JSONL under `~/.claude/projects/<path-slug>/<uuid>.jsonl`.
  Switchboard does not read them — but the directory names decode back to every
  repo path the user has worked in, which is free autocomplete for the repo field.
- `claude --print --input-format stream-json --output-format stream-json` is a
  full duplex session. `@anthropic-ai/claude-agent-sdk` wraps it, including the
  `canUseTool` permission callback.
- There is no `codex` on PATH. ChatGPT.app ships one at
  `/Applications/ChatGPT.app/Contents/Resources/codex`, with an `app-server`
  subcommand: JSON-RPC over stdio, plus `generate-ts` for typed bindings.
- `~/.claude.json` holds exactly one `oauthAccount`. The desktop app and the CLI
  share `~/.claude`, so the two Claude accounts are not currently separable.
  Account B requires a fresh `CLAUDE_CONFIG_DIR=~/.claude-alt` with its own login.
- The desktop app already places worktrees at `<repo>/.claude/worktrees/<branch>`
  (`~/Library/Application Support/Claude/git-worktrees.json`). Switchboard uses
  the same convention so the two coexist.
- Plan-limit percentages exist in the desktop app's `plan-usage-history.json`
  (`fh` = 5-hour %, `sd` = weekly %, tagged by org uuid), but that file belongs
  to the desktop app. Nothing equivalent exists CLI-side. Usage is therefore
  estimated from observed token spend and labeled as an estimate.

## Architecture

A single Node process owns all state. The browser is a renderer that holds
nothing it cannot re-derive from a fresh state push.

```
browser (card grid + chat view)
   ↕ WebSocket — server pushes state, browser sends commands
node core
   ├── sessions.ts     live registry + JSON persistence
   ├── agents/claude.ts  one subprocess per session, via the Agent SDK
   ├── agents/codex.ts   one app-server subprocess, N conversations, JSON-RPC
   ├── worktree.ts     create worktree; read branch, ±lines, dirty
   ├── usage.ts        accumulate tokens/cost per account; pick freest
   └── server.ts       HTTP + WebSocket
```

### The adapter interface

Both vendors normalize to one shape. Nothing above `agents/` knows which vendor
a session belongs to.

```ts
type Status = 'working' | 'needs-you' | 'done' | 'stopped'

type Session = {
  id: string
  provider: 'claude' | 'codex'
  account: string          // key into accounts.json
  cwd: string              // the worktree
  repo: string             // the base repo
  branch: string
  title: string
  status: Status
  transcript: Msg[]
  pending?: ApprovalRequest
  stoppedReason?: string
}

interface Adapter {
  start(opts: {account, cwd, prompt}): Promise<Session>
  resume(session: Session): Promise<Session>
  send(id: string, text: string): void
  decide(id: string, allow: boolean): void
  stop(id: string): void
}
```

`Msg` is normalized: text, a one-line collapsed tool call, or a diff. Vendor
event shapes stop at the adapter boundary.

### Status is observed, never inferred

Every status change comes from an event on a stream the process owns:

| Status | Source |
|---|---|
| `working` | turn started |
| `needs-you` | approval request received, still unanswered |
| `done` | turn ended, awaiting the next prompt |
| `stopped` | child process exited, or the server restarted |

There is no JSONL tailing, no timestamp heuristic, and no polling for liveness.
This is the entire reason the design refuses to show foreign sessions.

### Accounts

`accounts.json`, config rather than code:

```json
[
  {"name": "claude-main", "provider": "claude", "env": {}},
  {"name": "claude-alt",  "provider": "claude",
   "env": {"CLAUDE_CONFIG_DIR": "/Users/dwightbritton/.claude-alt"}},
  {"name": "codex", "provider": "codex",
   "bin": "/Applications/ChatGPT.app/Contents/Resources/codex"}
]
```

Setting up `~/.claude-alt` is a one-time manual step: run `claude` with that env
var set and log in as the second account. Switchboard detects the missing login
and says so on the account card rather than failing at launch.

### Persistence

The registry writes `{id, provider, account, repo, cwd, branch, title}` plus the
transcript to disk on change. Agents are children of the Node process and die
with it; on restart every card returns as `stopped` with its transcript intact
and a Resume button, which reattaches via `claude --resume <id>` or `codex
resume`. Detaching agents so they outlive their supervisor is a much larger
machine than a rare event justifies.

## Session lifecycle

**Create.** The `new worktree` tile asks for repo, branch, account, and a first
prompt. Repo autocompletes from `~/.claude/projects/` directory names. Account
defaults to whichever `usage.ts` reports as freest, and is overridable. Submit
creates the worktree at `<repo>/.claude/worktrees/<branch>`, launches the agent
in it, and sends the first prompt as one action — the card appears already
`working`.

**Grid.** Account row on top, session cards below, `new worktree` last. Sorted
`needs-you` → `working` → `done` → `stopped`, because the only job the grid has
is that a blocked session never needs to be found. Each card shows status and
elapsed time, branch, account, and one worktree line (`+142 −38 · clean`).

**Approve.** A pending approval renders on the card itself with allow/deny
buttons. The common interruption costs one click and never opens the chat view.
Both vendors block until answered — the Claude SDK's `canUseTool` callback and
Codex's app-server approval request — which is exactly the semantics a button
needs.

**Chat.** Clicking a card opens the transcript with a prompt box and the same
inline approve/deny. Escape returns to the grid.

**Notify.** A flip to `needs-you` while the tab is unfocused fires a browser
notification and bumps a count in the tab title.

**Delete.** Asks whether to remove the worktree too. Defaults to no.

## Worktrees

`worktree.ts` does two things: create one for a new session, and report status
for an existing one (branch, added/removed lines vs. the source branch, dirty or
clean). Creation failures — branch exists, path is not a repo, tree is dirty —
surface inline in the create dialog, and no session is created.

Conflict detection between worktrees is out of scope. It requires tracking each
worktree's changed file set, a refresh policy, and a definition of "clash" that
is more than "both touched the same file" to avoid being noise.

## Usage

`usage.ts` accumulates observed input/output tokens and cost per account from
the streams Switchboard already owns, and exposes two things: a per-account pace
estimate for the top row, clearly labeled an estimate, and `freestAccount()` for
routing new sessions. It depends on no official plan-limits source, because none
is available CLI-side.

If a stream turns out to carry real rate-limit data, `usage.ts` prefers it and
falls back to the estimate. That is an implementation detail behind one function,
not a change to this design.

## Failure handling

| What breaks | Behavior |
|---|---|
| Agent process exits | Card → `stopped` with exit code and last stderr line. Resume available. Never silently disappears. |
| Codex app-server won't start or isn't logged in | Codex accounts disabled with a banner naming the fix. Claude sessions unaffected. |
| `~/.claude-alt` not logged in | Account card shows the exact command to run. |
| Worktree creation fails | Inline error in the create dialog. Nothing created. |
| WebSocket drops | Browser reconnects with backoff and refetches full state. |
| Node process dies | Children die with it; registry restores every card as `stopped`. |
| Second instance launched | Port bind fails with a message saying one is already running. |

## Testing

`node:test`, no framework.

- **Adapters** — the only subtle code, and the easiest to test with nothing
  running. Record real `stream-json` and app-server output to fixtures, replay
  through the adapter, assert normalized events and status transitions. Every
  status bug lives in this seam.
- **worktree.ts** — real git in a temp dir: create, status on clean and dirty
  trees, and each failure case.
- **usage.ts** — pure function, table test.

Not tested: the UI and the WebSocket plumbing. A browser test asserting a card
turned orange costs more to maintain than the bugs it catches, and those bugs
are visible the moment the window is open.

## Deferred

- Moving a session to another account when one hits its limit. A session's
  history lives inside its account's config dir, so there is nothing to hand
  over; it would mean a fresh session with the transcript replayed as context.
  Revisit once the real frequency of hitting that wall is known.
- Worktree conflict flags, merge, and cleanup actions.
- Attaching to sessions started by the Claude desktop app or ChatGPT.app.
  `codex app-server daemon` and its `proxy` subcommand suggest this may be
  possible for Codex; unproven, and out of scope either way.
