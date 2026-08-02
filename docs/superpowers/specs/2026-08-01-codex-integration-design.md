# Switchboard Codex integration — design

Switchboard already runs real Codex SDK threads, streams their events, resumes
them after a restart, and confines each agent to its own git worktree. This
design turns that functional beta into a dependable local Codex worker first,
then adds richer Codex capabilities without prematurely replacing the SDK.

## Problem

The core coding loop exists, but several boundaries are implicit or brittle:

- The Codex executable is a hardcoded binary inside ChatGPT.app, while the SDK
  and app may ship different CLI versions.
- A missing binary, incompatible version, or authentication problem is only
  discovered after Switchboard has started creating session state.
- Codex has no interactive approval callback through the installed SDK.
  Switchboard uses `approvalPolicy: 'never'`, but the resulting limitations are
  not consistently surfaced to the user.
- Browser commands other than session creation mostly discard non-2xx errors.
- Codex tests exercise pure event normalization, not process launch, streaming,
  follow-up queuing, cancellation, or resume through the real SDK boundary.
- The transcript ignores in-progress item events and collapses useful tool
  results to one line.
- Uploads are file paths in text prompts even when the SDK supports structured
  local-image input.
- Switchboard has no repository-level `AGENTS.md`, so Codex must infer this
  project's working agreements from source and README prose.

The result is useful for ordinary local edits and tests, but it is not yet
predictable enough to call a hardened integration.

## Outcome

Deliver the work in two phases:

1. **Dependable core.** Keep the TypeScript Codex SDK and the existing worktree
   safety model. Make runtime selection, lifecycle behavior, failures, queued
   prompts, configuration precedence, and offline verification explicit.
2. **Richer Codex experience.** Add live tool progress, bounded details, native
   image input, and optional per-session settings. Evaluate app-server only for
   interactive approvals that the SDK cannot provide.

Completing both phases means 100% completion of this specification and roughly
90–95% of the desired local Codex worker experience. It does not mean parity
with every Codex app, cloud, connector, or external-session feature.

## Scope

### Phase 1: dependable core

- Resolve and validate a compatible Codex CLI before creating a worktree.
- Keep the existing SDK and adapter boundary.
- Remain intentionally macOS-only.
- Preserve target-repository and user Codex configuration.
- Keep Codex non-interactive and worktree-scoped.
- Normalize and display actionable runtime, authentication, resume, stream,
  queue, and sandbox failures.
- Make every browser command surface a non-2xx response.
- Add hermetic SDK-through-process coverage to normal `npm test`.
- Add repository guidance for Codex contributors.

### Phase 2: richer experience

- Represent the full started → updated → completed lifecycle of tool items.
- Show bounded, redacted command and MCP details.
- Show reasoning summaries and todo progress separately from primary messages.
- Send image uploads using structured SDK input.
- Add inherited-by-default Codex thread controls.
- Improve usage and rate-limit reporting only where the SDK exposes reliable
  data.
- Run a time-boxed SDK-versus-app-server approval evaluation.

### Out of scope

- Windows or Linux runtime discovery.
- A paid or networked smoke test in `npm test`.
- Importing sessions started in ChatGPT.app, Codex CLI, IDE, or cloud.
- Cloud task orchestration, connectors, or full Codex-app UI parity.
- Silently granting `danger-full-access`.
- Automatically replaying an ambiguously failed prompt.
- Replacing the SDK before the Phase 2 approval evaluation proves that doing so
  is necessary and maintainable.

## Product and SDK constraints

The installed `@openai/codex-sdk` is the integration API. It starts, continues,
streams, and resumes local Codex threads. The SDK itself wraps a Codex CLI and
ships a version-matched CLI dependency. Switchboard must therefore treat the
SDK and executable as a compatibility pair, not independent moving parts.

Thread options passed by Switchboard take precedence over overlapping global or
project configuration. Phase 1 uses that precedence only for the safety boundary:

```ts
{
  workingDirectory: worktree,
  sandboxMode: 'workspace-write',
  approvalPolicy: 'never',
}
```

The installed SDK exposes no interactive approval callback. Phase 1 does not
simulate one. Operations outside the sandbox either succeed under existing
Codex configuration or fail visibly.

Relevant product references:

- <https://developers.openai.com/codex/sdk/>
- <https://developers.openai.com/codex/config-advanced/>
- <https://developers.openai.com/codex/guides/agents-md/>
- <https://developers.openai.com/codex/mcp/>

## Architecture

The current normalized adapter boundary stays in place:

```text
browser
   ↕ SSE snapshots + HTTP commands
server.ts
   ├── Registry and persisted Session state
   ├── worktree creation/status/merge/push
   └── provider adapter
         └── Codex SDK
               └── resolved Codex CLI process
```

`server.ts` remains responsible for session ownership and worktree lifecycle.
Codex-specific runtime selection, client creation, thread lifecycle, and event
translation remain below `src/agents/`.

Phase 1 adds three focused units.

### Codex runtime resolver

A new runtime module resolves a usable executable and returns a prepared runtime
description containing its source, version, and the SDK construction options.
It does not start a model turn.

Resolution order is deterministic:

1. **Explicit account binary.** If a Codex account has `bin`, that path is
   authoritative. It must exist, be a regular executable file, report a
   parseable Codex version, and be compatible with the installed SDK. Failure is
   an account error; Switchboard does not silently ignore an explicit choice.
2. **Standard macOS ChatGPT binary.** Check
   `/Applications/ChatGPT.app/Contents/Resources/codex`. Use it only if it passes
   the same compatibility check. An incompatible app binary is recorded as a
   diagnostic and skipped.
3. **SDK-bundled CLI.** Instantiate `Codex` without `codexPathOverride`. This is
   the version-aligned fallback shipped with the SDK dependency.

Compatibility is strict for an explicit override: its reported published Codex
version must match the SDK package version, ignoring only semver build metadata.
The standard ChatGPT binary follows the same rule but falls back rather than
blocking the account. This prevents an SDK typed against one JSONL schema from
silently decoding a different CLI schema.

The resolver is macOS-only by design. A non-macOS platform receives a stable
unsupported-platform error rather than speculative path discovery.

### Codex adapter factory

Refactor the current hardwired adapter internals into a factory that accepts a
prepared runtime. Production code still exports a normal `Adapter`. Tests can
provide an explicit fake executable while continuing to use the real installed
SDK.

The adapter continues to own:

- `startThread` versus `resumeThread`
- FIFO turn delivery
- event streaming
- cancellation through `AbortController`
- normalized transcript/status/usage events
- idempotent terminal Stop behavior

Runtime resolution and SDK client construction are separate so path/version
failures can occur before a worktree exists and so process behavior can be
tested without a paid turn.

### Readiness and error layer

Before worktree creation, the selected provider performs a preflight and returns
a prepared launch. For Codex, preflight checks everything that can be checked
without starting a turn:

- supported platform
- binary resolution
- file type and executable permission for an override
- reported version compatibility
- configuration/environment shape
- recognizable authentication state using `codex login status`

Authentication is not defined as “`~/.codex/auth.json` exists.” Preflight runs
the resolved CLI's `login status` command with the same launch environment the
SDK will receive. A successful status is ready; a recognized logged-out status
is `codex_auth_unavailable`. If an older compatible CLI does not support the
status subcommand, preflight records a diagnostic and defers authentication to
the first turn. A selected `CODEX_HOME`, environment credential, or platform
credential store may be valid, and a later authentication failure is normalized
from the SDK/CLI error.

## Launch and resume flow

Session creation becomes:

```text
validate account and request
→ prepare provider runtime
→ create git worktree
→ create Registry session
→ construct SDK client and thread
→ enqueue first prompt
→ stream normalized events
```

A preflight failure creates neither a worktree nor a session. A failure after
worktree creation keeps both the worktree and a stopped session card; automatic
cleanup is forbidden because the process may already have written files.

Resume becomes:

```text
validate stopped session
→ verify worktree still exists
→ prepare provider runtime again
→ revive Registry session
→ resume stored vendor thread ID
→ enqueue resume prompt
```

If preflight or worktree validation fails, the session remains stopped. The
error is returned to the browser and shown on both the card and chat view.

## Configuration and instruction precedence

Codex behavior is assembled in this order:

1. Build the CLI launch environment from the server environment plus explicit
   account overrides. This selects `CODEX_HOME` and any supported credential
   source before Codex reads configuration.
2. Load global configuration under the selected `CODEX_HOME`.
3. Load the target repository's `AGENTS.md`, skills, MCP configuration, and
   `.codex/config.toml` hierarchy.
4. In Phase 2, apply only explicit per-session Codex settings; omitted fields
   continue to inherit.
5. Apply Switchboard's mandatory thread safety overrides: working directory,
   workspace-write sandbox, and never-approve policy.

Phase 1 does not inject generic instructions into target repositories and does
not override their model, reasoning effort, MCP servers, web-search mode, or
workspace network setting. A repository may explicitly opt into workspace
network access through its own Codex configuration. Switchboard never silently
enables it.

Account environment values are launch-only configuration. They are never:

- persisted to `state.json`
- included in SSE snapshots
- rendered in the browser
- copied verbatim into an error or diagnostic

The existing environment inheritance required by local tools remains, while
Codex's configured shell-environment policy remains authoritative for tool
subprocesses.

The Switchboard repository gains a root `AGENTS.md` that records setup,
architectural boundaries, the required `npm test` command, and verification
expectations. A project `.codex/config.toml` is added only if implementation
requires a concrete repository setting; an empty policy file is not a
deliverable.

## Permissions

Phase 1 deliberately stays non-interactive:

- `sandboxMode` is always `workspace-write`.
- `approvalPolicy` is always `never`.
- The Codex Auto checkbox remains disabled and explains the policy.
- A sandbox-denied command becomes a visible failed tool/error item.
- Switchboard does not relaunch a turn with broader permissions.
- Switchboard never changes a target repository's network configuration.

Git metadata may be outside the worktree's writable boundary. The agent is not
required to commit. Switchboard's existing Merge action remains the supported
path: it commits outstanding worktree changes, merges them into the base
repository, and can then push through the server-owned workflow.

Interactive permissions are a Phase 2 transport question, not a Phase 1
facsimile.

## Prompt delivery and queue semantics

An HTTP 200 from `send` means Switchboard accepted the prompt, not necessarily
that Codex has begun that turn. Delivery state must therefore be observable.

User transcript messages gain an optional delivery state:

```ts
type PromptDelivery = 'queued' | 'sent' | 'unsent'

type UserMsg = {
  kind: 'user'
  id: string
  text: string
  delivery: PromptDelivery
}
```

Existing persisted user messages without these fields load as `sent` for
backward compatibility.

For Codex:

1. The initial create prompt and every accepted follow-up are appended as user
   messages. Accepting a follow-up appends it as `queued` before responding to
   the browser.
2. Dequeuing it immediately before `runStreamed` marks it `sent`.
3. Completing or failing that active turn does not change `sent`; the CLI may
   have consumed some or all of it.
4. If an active turn fails or the user presses Stop, prompts still in the FIFO
   are marked `unsent`, retained in the transcript, and counted in a visible
   error message.
5. Unsent prompts are never replayed automatically. The user may copy/resend one
   after resume.
6. On server restart, any persisted `queued` prompt is changed to `unsent`
   alongside the session's transition to stopped.

This closes the current gap where queued follow-ups disappear when a stream
fails or the supervising process exits.

## Normalized event behavior

### Phase 1

Phase 1 preserves the compact completed-item transcript:

- `thread.started` stores the vendor thread ID.
- `turn.started` sets working.
- `item.completed` creates one normalized text, shell, edit, MCP, search, or
  error message.
- `turn.completed` records usage and sets done.
- `turn.failed` or fatal `error` stops the session with a sanitized reason.
- Unknown future event types are ignored without stopping the stream and are
  logged only in development diagnostics.

Stop initiated by the user and stop caused by an agent/runtime failure are
distinct persisted reasons. An abort thrown as the consequence of a user Stop
must not overwrite that reason.

### Phase 2

Tool messages use their Codex item ID as a stable key:

- `item.started` inserts a `running` entry.
- `item.updated` updates the existing entry.
- `item.completed` changes it to `ok` or `error`.

The Registry performs an upsert by item ID, so one Codex item renders once.
Command output, MCP results, and error detail are stored separately from the
one-line summary. Detail has a fixed byte limit, a visible truncation marker,
and credential redaction before persistence or SSE delivery.

Reasoning summaries and todo lists are separate message kinds or session
metadata, not fake tool calls. Switchboard does not request or display hidden
raw reasoning.

## Attachments and structured input

Phase 1 retains the existing upload behavior: files are copied into the session
worktree and their relative paths are inserted into the prompt.

Phase 2 classifies uploaded files at send time:

- Supported images become SDK `local_image` input entries alongside a text
  entry.
- Other files remain worktree-relative path references inside the text prompt.
- The server, not the browser, resolves the stored relative path to an absolute
  path inside the session worktree.
- Existing filename, size, traversal, and symlink protections remain.
- A missing or escaped image path rejects the send before the SDK is called.

Transcript text continues showing the user's written prompt and attachment
names; absolute filesystem paths are not added to browser-visible history.

## Optional Codex thread settings

Phase 2 adds an optional Codex section to new-session configuration:

```ts
type CodexThreadSettings = {
  model?: string
  modelReasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  webSearchMode?: 'disabled' | 'cached' | 'live'
  networkAccessEnabled?: boolean
}
```

Every omitted field means “inherit Codex configuration.” Switchboard must not
materialize inherited defaults into a session, because doing so would freeze a
user or repository default that may legitimately change later.

Explicit settings are persisted with the session and passed again on resume.
They apply at thread start/resume, not in the middle of an active turn. Changing
them while a thread is live is disabled; a stopped session may change them and
use the new values on resume.

The Phase 1 safety overrides remain mandatory even when settings are present.
There is no `danger-full-access` control.

## Error contract

Codex-facing failures use stable internal codes and actionable public messages.
The browser does not branch on raw SDK text.

| Code | Meaning | Required behavior |
|---|---|---|
| `codex_platform_unsupported` | Host is not supported by this design | Reject preflight. |
| `codex_binary_missing` | Explicit binary does not exist | Reject before worktree creation. |
| `codex_binary_not_executable` | Explicit path is not an executable file | Reject before worktree creation. |
| `codex_version_unreadable` | `--version` cannot be parsed | Reject explicit override; skip standard app candidate. |
| `codex_version_mismatch` | CLI and SDK versions are incompatible | Reject explicit override; skip standard app candidate. |
| `codex_auth_unavailable` | No supported authentication is usable | Reject when known, otherwise stop the created session. |
| `codex_start_failed` | New thread/first turn cannot start | Keep worktree; session becomes stopped. |
| `codex_resume_failed` | Stored thread cannot resume | Session remains stopped. |
| `codex_stream_failed` | Active event stream fails | Stop session; mark remaining prompts unsent. |
| `codex_sandbox_denied` | Requested action exceeds the permission boundary | Show failed action and remediation without escalation. |
| `codex_user_stopped` | User intentionally stopped the adapter | Stop once; mark remaining prompts unsent. |

Public errors include the relevant safe path/version and a remediation where
one exists. They never include tokens, authorization headers, complete process
environments, or unredacted tool payloads.

All browser commands await `/command` and surface a non-2xx response in the
relevant dialog, card, chat, or selection toolbar. Fire-and-forget error loss is
removed for create, send, resume, stop, auto, decide, merge, push, and delete,
even though some commands are primarily Claude or provider-neutral.

## Persistence and migration

`state.json` remains backward compatible.

- Missing prompt IDs/delivery fields load as delivered legacy messages.
- Missing Codex settings mean inherit.
- A loaded session still becomes stopped because no child process survived.
- Persisted `queued` prompts become `unsent` during load.
- Existing vendor thread IDs remain valid inputs to `resumeThread`.
- Runtime diagnostics are recomputed, not persisted as authority; app and SDK
  versions can change between launches.

No migration rewrites `state.json` eagerly. The next ordinary save writes the
new shape.

## Browser behavior

Phase 1 adds no new top-level view.

- The creation dialog shows preflight errors without creating a card.
- A stopped Codex card distinguishes user stop, launch failure, authentication
  failure, stream failure, and missing worktree.
- Chat renders queued/sent/unsent delivery state only where it differs from the
  normal sent state.
- Command errors stay visible until the user retries, dismisses them, or changes
  session.
- The disabled Codex Auto control continues explaining that the worktree
  sandbox, rather than an interactive prompt, is the boundary.

Phase 2 adds collapsible detail to tool rows and optional controls to the new
session dialog. Defaults remain visually and semantically “inherit.”

## Offline verification

Normal `npm test` owns the complete automated verification contract. It never
contacts OpenAI, spends a model turn, or writes to the real `~/.codex`.

### Runtime resolver tests

- explicit compatible executable
- explicit missing path
- explicit directory/non-executable path
- unreadable version output
- explicit version mismatch
- compatible standard ChatGPT candidate
- incompatible standard candidate falling back to SDK bundle
- macOS-only rejection behavior
- environment and error redaction

### SDK-through-fake-CLI integration tests

A temporary executable implements the subset of `codex exec --json` behavior
used by the installed SDK. The test points `codexPathOverride` at it and
therefore exercises the real SDK's process spawning and JSONL parser.

Scenarios cover:

- new thread launch and `thread.started` capture
- assistant, shell, file-change, MCP, search, usage, and failure events
- sequential follow-up delivery
- queued prompt delivery-state transitions
- queued prompts becoming unsent after failure
- cancellation and idempotent Stop
- resume with the stored thread ID
- malformed JSONL and unexpected process exit
- unknown future events not killing an otherwise valid stream

The fake CLI records safe invocation metadata in its temporary directory so
tests can assert new versus resume arguments and call ordering.

### Server and Registry tests

- preflight failure creates neither worktree nor session
- post-worktree start failure retains a stopped session and worktree
- resume validation failure leaves the session stopped
- restart converts queued prompts to unsent
- every command returns its error path
- persisted state never contains account environment values

### Browser command tests

Extract the small request/error helper from `web/app.js` so it can be exercised
with a mocked `fetch` under `node:test`, without a browser dependency. Verify
that create, send, resume, stop, auto, decide, merge, push, and delete retain and
display a non-2xx response in their designated UI status target. These are
behavior tests of the command boundary, not pixel or layout tests.

### Phase 2 tests

- started/updated/completed upserts produce one tool item
- detail truncation and redaction occur before persistence
- image input resolves only within the worktree
- inherited settings remain omitted
- explicit settings survive save/load/resume
- safety overrides win over conflicting per-session values

All existing tests remain passing. The project continues supporting Node
`>=22.18`; the suite must pass with the runtime used by `npm test`.

## Phase 2 approval evaluation

Interactive approvals are the only reason contemplated for replacing or
supplementing the SDK transport. The evaluation is a bounded prototype, not an
open-ended rewrite.

Compare the current SDK with Codex app-server on:

- documented approval request and response semantics
- new thread, follow-up, resume, and cancellation behavior
- event-schema stability and typed bindings
- authentication reuse
- MCP approval behavior
- process ownership and crash recovery
- testability with a fake transport
- migration cost for existing vendor thread IDs

The decision record must choose one of three outcomes:

1. Keep SDK-only because interactive approvals remain unnecessary or unstable.
2. Add a narrow app-server approval bridge while retaining SDK turns, only if
   the two transports can safely share thread state.
3. Replace the Codex adapter transport with app-server because a prototype proves
   complete lifecycle parity and lower long-term complexity.

No production transport change occurs without the working prototype and decision
record.

## Definition of done

### Phase 1

Phase 1 is complete when:

- Compatible runtime selection is deterministic and no longer depends on one
  hardcoded app path.
- SDK/CLI mismatch cannot silently enter a session.
- Preflight failures leave no worktree or session behind.
- Failures after worktree creation retain recoverable state.
- Every accepted prompt is either sent or visibly marked unsent.
- Every browser command surfaces a non-2xx response.
- Target-repository Codex configuration remains intact except for the three
  mandatory safety overrides.
- No account credential or environment value reaches persisted/browser state.
- The fake-CLI integration suite passes through the real SDK under normal
  `npm test`.
- Repository setup and verification rules exist in `AGENTS.md` and README.

### Phase 2

Phase 2 is complete when:

- One Codex item renders once while progressing through running to terminal
  state.
- Tool details are useful, bounded, redacted, and persisted safely.
- Supported images reach the SDK as structured local-image input.
- Omitted settings inherit; explicit settings persist and resume deterministically.
- Safety overrides cannot be weakened through session settings.
- Usage/rate-limit additions are backed by SDK data, not inferred strings.
- The approval evaluation has a working prototype, a decision record, and no
  unresolved production transport ambiguity.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| SDK updates change CLI invocation or JSONL schema | Pin SDK version; run fake-CLI tests on every update; reject incompatible overrides. |
| SDK-bundled CLI does not reuse the expected authentication | Preflight supported auth sources; normalize runtime auth errors; allow a validated explicit binary. |
| Strict version checks reject a usable app binary | Fall back automatically for the standard app candidate; explicit overrides fail loudly because they are authoritative. |
| Detailed tool output leaks credentials or grows state without bound | Redact and truncate before Registry persistence or SSE delivery. |
| Per-session settings unexpectedly override repo policy | Omitted means inherit; display explicit overrides; keep safety fields outside user control. |
| App-server evaluation expands into a rewrite | Time-box it and require a decision record before production transport work. |
| Queue tracking expands provider-neutral types | Keep delivery metadata backward compatible and optional; implement only the events required to prevent silent Codex prompt loss. |

## Implementation order

This design produces two implementation plans, not one oversized execution
plan. Write and execute the Phase 1 plan first. Reinspect the installed SDK and
the completed Phase 1 adapter before writing the Phase 2 plan, because SDK
capabilities and event shapes are allowed to change between phases.

Across those plans, preserve this dependency order:

1. Runtime resolver, error types, and account schema.
2. Preflight integration before worktree creation.
3. Adapter factory and fake CLI harness.
4. Prompt delivery persistence and lifecycle errors.
5. Browser command error handling and documentation.
6. Phase 1 verification and compatibility cleanup.
7. Phase 2 event lifecycle and bounded details.
8. Structured images and optional settings.
9. Usage improvements where supported.
10. Approval transport prototype and decision record.
