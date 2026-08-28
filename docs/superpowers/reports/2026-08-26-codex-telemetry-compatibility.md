# Codex telemetry compatibility gate

## Scope and authority

This gate covers only the phase-one telemetry client. It never creates, reads,
resumes, or mutates an app-server thread; it never starts a turn, refreshes
authentication, consumes reset credits, or creates provider usage. Codex turns
remain owned by `@openai/codex-sdk`.

The pinned executable and generated `0.145.0` TypeScript contract are the code
authority. The [official Codex App Server documentation](https://learn.chatgpt.com/docs/app-server)
confirms the newline-delimited JSON-RPC stdio transport and the required
`initialize` request followed by `initialized` notification, but the generated
contract wins if that documentation and the pinned executable differ.

## Pinned compatibility surface

| Surface | Evidence |
| --- | --- |
| Version | `0.145.0` |
| Client methods | `initialize`, `account/read`, `account/rateLimits/read` |
| Telemetry notifications | `account/updated`, `account/rateLimits/updated` |
| Private notification | `remoteControl/status/changed` is ignored and never included in evidence |
| Safe launch profile | `--strict-config -c hooks={} -c mcp_servers={} -c otel.exporter="none" app-server --listen stdio://` |
| Managed account vocabulary | `account/read`: `chatgpt`, `apiKey`, `amazonBedrock`, or signed out; `account/updated`: `apikey`, `chatgpt`, `chatgptAuthTokens`, `headers`, `agentIdentity`, `personalAccessToken`, `bedrockApiKey` |
| Denied server requests | `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/tool/requestUserInput`, `mcpServer/elicitation/request`, `item/permissions/requestApproval`, `item/tool/call`, `account/chatgptAuthTokens/refresh`, `attestation/generate`, `applyPatchApproval`, `execCommandApproval` |

## Offline evidence

The fake app-server smoke test verifies the exact supported client call sequence:
`initialize`, `initialized`, `account/read` with `refreshToken: false`, one
`account/rateLimits/read`, then EOF. It records only version, contract and
launch-profile matches, account kind, observed auth mode, plan visibility,
window/block state, notification names, clean shutdown, and a reset value's
coarse `seconds-band`/`milliseconds-band`/`other`/`none` classification.

The fixture's supported rate limits use a seconds-band reset value. A pinned
logged-out `account/read` response followed by the exact `-32600` rate-limit
error fails closed. Private remote-control hostname and installation canaries
are absent from serialized smoke evidence. These results validate the fake and
the pinned offline contract; they do **not** establish how a real account will
behave.

## Live-account result

**Not run.** The optional `npm run evaluate:codex-telemetry` probe has not been
separately authorized against a real configured account. No conclusion about
live plan visibility, live windows, notification timing, or reset timestamp
units is drawn from the fake evidence.

## Rollback

Disable telemetry coordinator startup and remove provider snapshots from SSE.
Sessions need no migration because every Codex session and turn remains
SDK-owned; local pace, Claude's existing limit behavior, and manual resume stay
available.
