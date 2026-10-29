# Structured questions validation — 2026-09-09

## Delivered

App-server Codex requests now use the existing approval FIFO for structured
questions. The UI displays one question at a time, supports option selection,
typed alternatives and free-text-only protocol requests, and masks secret inputs.
The provider receives one complete answer map when the last question is answered.
Skip or Stop discards partial answers and submits an empty answer map.

Auto does not answer questions. Each displayed question gets a new public ID;
stale and duplicate submissions are rejected. Raw provider IDs, option labels,
and accumulated answers remain in the process-local queue. Answers bypass the
Switchboard transcript and saved state. Browser drafts live only in memory,
survive failed submissions and SSE updates, and expire after submission or
resolution. The provider can still include information in its subsequent output;
this change does not promise to erase provider-generated text or provider storage.

Turn connections enable experimental API fields with attestation disabled, and
turn child argv enables `features.default_mode_request_user_input=true`.
Telemetry-only processes keep their original profile. No user/repository config
file, account transport setting, or running application was changed.

## Evidence

- Focused queue, adapter, supervisor, generated contract, and UI tests: 455 passed.
- After adding the normal-mode tool flag, focused adapter/supervisor/contract
  checks: 314 passed.
- Final `npm test`: **1,116 passed, zero failures** (103.9 seconds).
- `node --check web/app.js`, `node --check web/questions.js`, and
  `git diff --check`: passed.
- Browser fixture: option selection advanced from question 1 to question 2;
  typed draft and focus survived repeated SSE updates; final submission cleared
  the question and showed done. The isolated server and temporary repository
  were cleaned up. Masked inputs and failed-send draft retention have offline
  coverage; they were not separately exercised visually.
- Live SDK/CLI 0.153.4, configured account, temporary isolated repository:
  two questions with two suggested options each and typed alternatives were
  received sequentially with Auto on. Two synthetic answers were submitted
  atomically, the responding state was observed, serverRequest/resolved arrived,
  and the model completed with READY. No shell or external tool was requested.

The first live prompts reported the question tool unavailable. Inspection found
the default-mode feature disabled; the turn-only override enables it. A subsequent
probe explained that the model-facing tool requires options for each question.
The successful live probe used options plus typed alternatives. Nullable options
are supported by the generated transport and offline fixture, but a live
free-text-only request was not generated. The protocol has no multi-select flag;
this implementation does not invent one. MCP elicitation remains unsupported.

## Plan updates

The interactions plan now describes the implemented queue and typed question
contract, with MCP elicitation as its remaining milestone. Foundation and SDK
integration plans are marked historical. Capability and recovery plans describe
the current 0.153.4 baseline, completed prerequisites, and the remaining work.
