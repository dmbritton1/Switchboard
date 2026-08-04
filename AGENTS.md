# Switchboard contributor guidance

## Setup

- Use Node 22.18 or newer.
- Run `npm install`, then copy `accounts.example.json` to `accounts.json` before
  starting the app.

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
- `web/` renders browser state and command failures.
- `test/` covers those boundaries offline.

## Safety boundaries

- Each session has one dedicated git worktree.
- Codex always uses the fixed `workspace-write` sandbox and `never` approval
  policy. Do not broaden either policy or add an interactive approval path in
  Phase 1 fixes.
- Settings must never expose the Codex sandbox mode or approval policy. The
  `settings` command rejects unknown keys for this reason; keep it strict.
- Treat account environment values as launch-only secrets: never persist, log,
  return over SSE, or render them.
- Preserve the target repository's Codex configuration and instructions.

## Test isolation

Tests use the fake Codex executable through the real SDK boundary, a temporary
`CODEX_HOME`, and local temporary files. Do not add paid, networked, or real
account tests to `npm test`.

## Change discipline

Keep fixes inside the requested phase. In particular, do not pull Phase 2
features into a Phase 1 change. Do not create `.codex/config.toml`: Phase 1
needs no repository setting that belongs there.
