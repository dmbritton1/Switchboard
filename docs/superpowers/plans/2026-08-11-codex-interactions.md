# Codex interactions implementation plan

Revised 2026-09-09 against the installed SDK/CLI 0.153.4 and the current shared
account supervisor. This revision replaces the original 0.147.0 plan; do not
recreate its proposed provider-neutral queue or replace Claude's handle API.

## Current implementation

- [x] Command/file Allow and Deny, FIFO, responding state, opaque browser IDs.
- [x] Per-request Auto, needs-you, stop/crash cleanup, stale decision rejection.
- [x] Start/resume force workspace-write, on-request, and the user reviewer.
- [x] Structured questions use the same FIFO and resolution notification.
- [x] Sequential question display, choices, optional typed input, masked secret
  input, Skip, and atomic upstream submission of the complete answer map.
- [x] Browser drafts survive unrelated snapshots and failed HTTP submissions;
  successful submission, resolution, and Stop discard them.
- [x] Auto never answers or skips a question.
- [x] MCP form and URL elicitation with typed validation, stale-response guards,
  draft retention, explicit URL opening, and Auto exclusion.

Implementation boundaries:

- `src/agents/codex-approvals.ts`: the shared Codex approval/question FIFO;
  raw labels, question IDs, answers, and callbacks remain process-local.
- `src/agents/codex-questions.ts`: bounded validation, public redaction, and
  option-ID-to-provider-label mapping.
- `src/agents/codex-app-server-supervisor.ts`: generation/thread/turn routing;
  turn connections opt into experimental API fields, with attestation disabled.
  Turn processes also set `features.default_mode_request_user_input=true` so
  normal execution mode can expose the question tool. This is an argv override;
  it does not write user or repository configuration.
  Telemetry-only connections retain their original capabilities and deny policy.
- `src/agents/codex-app-server.ts`: normalize and enqueue requests, submit typed
  results, and clear state at lifecycle boundaries.
- `src/server.ts`: `answer-question` validates the current visible question ID;
  `decide` cannot answer a structured question. Answers bypass the transcript.
- `web/questions.js`: in-memory drafts and shared question controls used by
  the existing grid, session header, and interrupt strip.

The installed `ToolRequestUserInputQuestion` has `isOther`, `isSecret`, and
nullable options. It has no multi-select field. Present one selection or one
text answer per question. Do not infer multi-select from the response's array
shape. `isBlocking` replaces the deprecated `autoResolutionMs` scheduling hint;
Switchboard presents outstanding questions as needs-you and waits for the
provider's `serverRequest/resolved` rather than running a competing timeout.
A nonblocking question may be resolved by the provider while the user types.

Each displayed question has a new public request ID. Earlier submissions cannot
answer a later question in the same provider request. Partial answers are held
only in memory until the last answer; Skip and Stop send `{ answers: {} }` and
discard partial values. Resolution or transport failure discards the queue.
SDK Codex and Claude retain their existing behavior.

## MCP elicitation implementation

`src/agents/codex-elicitation.ts` validates the stable `form` and `url` modes.
Text, number/integer, boolean, and single/multiple enum fields are supported,
including bounds and the generated email/URI/date/date-time formats. Fields and
options have opaque browser IDs. Unknown constraints, nested structures, and
`openai/form`/`openaiForm` extensions are cancelled rather than rendered loosely.
Schema defaults are not prefilled; users explicitly provide the submitted data.

The existing FIFO keeps each elicitation visible until upstream resolution.
Auto never accepts, declines, or supplies values. Stop sends cancel; complete,
crash, and resolution discard actionable state. A nullable turn ID is accepted
only for an active owning thread; a supplied turn ID must match the active turn.
Idle, stopped, unowned, and stale-generation requests remain unsupported.

`respond-elicitation` sends validated values directly to the callback without
appending them to the transcript or saved state. The browser shares the existing
in-memory draft controller and restores values/focus across SSE updates.

URL requests show a redacted origin and a deliberate Open page link. The raw URL
remains in the adapter queue. `/elicitation-url` checks the current public ID and
responding state, then issues a no-store, no-referrer redirect. HTTPS is allowed;
HTTP is allowed only for literal loopback hosts. Credentials in URLs and other
schemes are rejected. The page is never opened automatically. Accept, Decline,
and Cancel are explicit user actions and do not grant session-wide permissions.

Capability discovery is now the next roadmap milestone. Broader OpenAI form
extensions and additional schema types require a separate design and verification.

## Verification commands

```sh
node --test test/codex-questions.test.ts test/codex-approvals.test.ts test/question-drafts.test.ts
node --test test/agents-codex-app-server.test.ts test/codex-app-server-supervisor.test.ts test/codex-app-server-contract.test.ts
node --test test/server.test.ts test/ui.test.ts
npm test
```

For current approval evidence see
`../reports/2026-09-09-codex-approvals-validation.md`. Structured-question evidence
is recorded separately so offline checks are not confused with live-provider
coverage. Capability/MCP discovery follows this completed interaction layer;
usage recovery and default cutover follow capabilities.
