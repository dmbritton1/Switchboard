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
- Treat account environment values as launch-only secrets: never persist, log,
  return over SSE, or render them.
- Preserve the target repository's Codex configuration and instructions.
- Keep `sandboxMode: 'workspace-write'` and `approvalPolicy: 'never'` as
  mandatory overrides. Per-session Codex settings may be explicit or omitted
  (omitted means inherit), but they must never expose or weaken either policy.
- Tool detail is redacted before Registry admission, bounded to 32 KiB per item
  and 2 MiB globally, evicted least-recently-updated, omitted from SSE, and
  read lazily only by session/item ID. Do not persist or expose raw reasoning
  or absolute attachment paths.
- Supported PNG, JPEG, and WebP uploads use SDK `local_image`; other files stay
  as worktree-relative text references. Preserve retryable draft and pending
  attachment behavior when an upload or send fails.
- Treat SDK usage as last-turn data and account pace as an estimate; never
  present either as a provider rate or plan limit.

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
