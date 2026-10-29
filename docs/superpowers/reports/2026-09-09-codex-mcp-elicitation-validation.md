# MCP forms and URL requests — validation

## Implemented

Stable MCP form and URL requests use the existing Codex interaction FIFO.
Forms support bounded text, numbers, integers, booleans, single-select enums,
and multi-select enums. Fields and options have opaque public IDs; raw values
are mapped back only when a valid response is submitted. Unsupported constraints,
nested schemas, and OpenAI form extensions are cancelled. Defaults are not
prefilled. Auto never answers elicitations.

Submit, Decline, and Cancel await upstream resolution. Stop cancels pending
requests. HTTP decisions require the current public ID; stale links and duplicate
submissions are rejected. Browser drafts survive updates and failed sends.
Values go directly to the provider, not the transcript or saved state.

URL requests expose an origin and a click-only link. Full URLs remain in the
live adapter. A current-request redirect uses no-store and no-referrer headers.
HTTPS and literal-loopback HTTP are allowed; credentials and other schemes are
rejected. No URL opens automatically. Nullable turn IDs are accepted only for
an active owning thread; supplied turn IDs must match that thread's active turn.

## Evidence

- Focused adapter, queue, supervisor, and UI tests: 413 passed.
- Focused contract, validation, and draft tests: 52 passed.
- HTTP test verified typed submission, duplicate rejection, saved-state exclusion,
  current URL redirection, cache policy, and stale-link rejection.
- Full `npm test`: **1,123 passed, zero failures** (82.2 seconds).
- Browser fixture: text, integer, boolean No, and enum fields retained values;
  Submit advanced to the URL request; Cancel cleared it and showed done.
  The URL was not opened. The browser tab was closed.
- JavaScript syntax checks and `git diff --check` passed.

## Live evidence and limitations

A temporary local stdio MCP fixture was injected only into the test child argv.
No account or repository configuration was changed. The live provider emitted
an empty form, the fixture's one-field form, and the fixture's URL request.
Both forms were explicitly accepted with synthetic data where applicable; the
URL was declined without opening it. Every response received an upstream
resolution notification. The turn subsequently ended with codex_stream_failed,
so that run did not establish successful overall live turn completion.

The initial test harness assumed a nonempty form and exited on the provider's
valid empty form. The harness was corrected; this was not a production UI error.
A further diagnostic run was rejected by automatic approval review because the
account usage limit had been reached. No workaround was attempted. The user subsequently authorized cleanup and a repeat diagnostic; the follow-up
results are recorded below.

## Authorized follow-up

The temporary browser test server was stopped gracefully and removal of its
fixture repository was verified. The production application was not restarted.

The repeated live run completed successfully: the provider's empty form and the
fixture's one-field form were accepted, the URL request was declined without
opening it, and all three requests received upstream resolution notifications.
The model then returned READY and the adapter reported done. The smoke harness
closed the handle and pool and removed its temporary repository before exiting
successfully. Its subsequent codex_user_stopped event is harness cleanup after
done, not a failed turn. The earlier stream failure did not recur; its cause was
not established, so no speculative production fix was made.

The follow-up full offline regression run passed: **1,123 tests, zero failures**
(79.1 seconds). `git diff --check` also passed.

Capability discovery remains the next milestone.
