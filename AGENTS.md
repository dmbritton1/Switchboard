# Switchboard contributor guidance

## Setup

- Use Node 22.18 or newer.
- Run `npm install`. `accounts.json` is optional: a missing file starts the
  app in first-run mode with a linking screen instead of the session grid.
  Copy `accounts.example.json` to `accounts.json` only if you want
  hand-written entries instead of (or alongside) linking through the UI.

## Required verification

- Run `npm test` before completion. While iterating, run the focused relevant
  `node --test` command first.

## Architecture

The application flows from the browser through the HTTP/SSE server to the
Registry and git worktrees, then into a provider adapter.

## Code ownership

- `src/server.ts` owns HTTP commands and session/worktree lifecycle.
- `src/sessions.ts` owns Registry state and persistence.
- `src/agents/` owns provider adapters and Codex runtime preflight.
- `src/accounts.ts` owns `accounts.json` reads and writes.
- `src/link.ts` owns the login child process and the pending-link state machine.
- `web/` renders browser state and command failures.
- `test/` covers those boundaries offline.
- `src/handoff.ts` owns the transcript render and the successor's opening prompt.
- `src/relay.ts` owns cross-session messaging rules and open-channel state.
- `src/overlap.ts` owns the changed-path cache and the overlap computation.

## Safety boundaries

- Each session has one dedicated git worktree.
- Codex uses the fixed `workspace-write` sandbox. SDK sessions use `never`;
  app-server sessions use fixed `on-request` and the `user` reviewer for the
  approved interaction phase.
  Mirror Claude's Allow/Deny and per-request Auto behavior, without switching
  to blanket bypass or session-wide grants.
- Settings must never expose the Codex sandbox mode or approval policy. The
  `settings` command rejects unknown keys for this reason; keep it strict.
- Treat account environment values as launch-only secrets: never persist, log,
  return over SSE, or render them.
- Preserve the target repository's Codex configuration and instructions.
- Keep `sandboxMode: 'workspace-write'` and the transport's fixed approval
  policy (`never` for SDK, `on-request` for app-server) as mandatory overrides. Per-session Codex settings may be explicit or omitted
  (omitted means inherit), may change only while a session is stopped, and must
  never expose or weaken the sandbox or replace the fixed transport policy.
- Codex lifecycle items occupy one stable row from `running` through terminal
  `ok` or `error`. Reasoning summaries and todo status are separate entries;
  do not persist or expose raw reasoning.
- Tool detail is redacted before Registry admission, bounded to 32 KiB per item
  and 2 MiB globally, evicted least-recently-updated, omitted from SSE, and
  read lazily only by session/item ID. Do not persist or expose raw reasoning
  or absolute attachment paths.
- Supported PNG, JPEG, and WebP uploads use SDK `local_image`; other files stay
  as worktree-relative text references. Preserve retryable draft and pending
  attachment behavior when an upload or send fails.
- Treat SDK usage as last-turn data and account pace as an estimate; never
  present either as a provider rate or plan limit.
- `accounts.json` is co-owned. The app may only append entries it creates and
  remove entries by name; it must never write an in-memory array wholesale,
  and must never adopt a concurrent hand edit into the running process.
- Only ever delete a credential directory that is exactly the app-managed
  `<accountsRoot>/<name>`. A directory named by a hand-written entry is never
  removed.
- The pasted authorization code goes to the login child's stdin only — never
  logged, never in the SSE snapshot, never persisted.
- Link tests must never bind port 1455, open a browser, or spawn a real
  `claude`/`codex` binary.
- Handoff renders a transcript to disk. Reasoning is never included, and
  `.switchboard/` is excluded from the outstanding-work commit so a handoff
  document can never reach a merge target.
- Relay channels are process-local and keyed by session pair. Never persist them
  or move them onto `Session`: a channel names two live handles, and a restart
  forces every session to `stopped`.
- A relay tool never takes a sender. The sending session's identity comes from
  the closure the server built in launch(), never from a tool argument.
- Overlap is advisory. It must never gate a merge, an edit, or a relay, and UI
  copy must say "also changed in" rather than anything implying a lock.
- The path cache is process-local and carries its own TTL. That TTL is a rate
  limit, not a freshness preference: `/status` is polled every four seconds per
  visible card, and collecting on each call would spawn git hundreds of times a
  minute.
- Path collection applies `CONVERSATION_INPUTS`. Without it a pasted upload
  registers as overlapping work.

## Test isolation

Tests use the fake Codex executable through the real SDK boundary, a temporary
`CODEX_HOME`, and local temporary files. Do not add paid, networked, or real
account tests to `npm test`.

`npm run evaluate:codex-app-server` is an optional, manual no-turn probe of the
installed local app-server. It may initialize and read auth state without
refresh, but must not create a thread or start a turn. Its recorded decision is
SDK-only; do not add a hybrid or replacement transport without a later approved
design and implementation plan.

## Change discipline

Keep fixes inside the requested phase. In particular, do not pull Phase 2
features into a Phase 1 change. Do not create `.codex/config.toml`: Phase 1
needs no repository setting that belongs there.
