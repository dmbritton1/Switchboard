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

Codex uses the binary inside ChatGPT.app (`/Applications/ChatGPT.app/Contents/Resources/codex`,
hardcoded in `src/agents/codex.ts`) and the existing `~/.codex/auth.json` — no separate
login step.

`accounts.json` and `state.json` are both gitignored; the app writes session
state to `state.json` next to the server on every command.

## What it does

Each session runs in its own git worktree at `<repo>/.claude/worktrees/<branch>`.
The grid sorts blocked-first: `needs-you`, `working`, `done`, `stopped`. Claude
permission prompts (Allow/Deny) are answered from the card or from the open chat
view. Codex runs sandboxed to its worktree with `approvalPolicy: 'never'` and
never enters `needs-you` — see Limits below.

Opening a card shows its transcript and a message box to keep steering the
agent. Each card also has a delete control with a "remove worktree" checkbox;
deleting always forgets the session, and checking the box additionally runs
`git worktree remove` (falling back to deleting the directory) on confirmation
— which **discards any uncommitted work in that worktree**.

Usage percentages are estimates from observed token spend against the `budget`
in `accounts.json`, not real plan limits — no CLI exposes those. The two
providers aren't measured identically: the Claude adapter folds
`cache_creation_input_tokens` and `cache_read_input_tokens` into the input
count (a recorded session showed 86 tokens counted before that fix, 38,012
after — cache tokens are most of real spend under prompt caching), while the
Codex adapter deliberately does not add `cached_input_tokens` or
`reasoning_output_tokens` on top of its totals, because those look like
subsets of the reported totals rather than separate counters — an assumption
noted in the code, not a confirmed one. Keep that in mind when tuning `budget`
per account.

## Tests

```bash
npm test
```

## Limits

- Only sessions started here are shown. Sessions from the Claude desktop app or
  ChatGPT.app are invisible to it.
- The server only answers requests whose `Host` header is `127.0.0.1` or
  `localhost` (`/command` also checks `Origin`), to close a DNS-rebinding hole:
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
  no-op. The Codex binary path (`CODEX_BIN` in `src/agents/codex.ts`) is also
  hardcoded to ChatGPT.app with no override env var or existence check, so a
  missing or relocated install fails with the SDK's own error, not an
  actionable one.
- Transport is SSE (`GET /events`) + `POST /command`, not WebSocket — the
  traffic is one-directional in each channel (server pushes state, browser
  posts commands), and `EventSource` reconnects on its own with no extra code.
- Tool-call outcomes are tracked but not shown: `src/sessions.ts` correlates
  each `tool-result` event and sets `ok`/`error` on the transcript entry, but
  the chat view renders every tool message as `name: summary` regardless of
  that status — a failed edit and a successful one look identical.
- Command failures are mostly silent in the UI: only the create-session dialog
  checks `/command`'s response and shows the error; send, decide, resume, and
  delete all fire-and-forget. Delete is the sharp edge — the server removes
  the session from the registry unconditionally, even when `removeWorktree`'s
  `git worktree remove`/`rm -rf` failed, so a failed delete can look identical
  to a successful one (the card just disappears) while the worktree is still
  on disk. If a delete looks suspicious, check `git worktree list` in the repo.
