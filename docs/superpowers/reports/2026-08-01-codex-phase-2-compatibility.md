> Historical SDK integration report. Current app-server rollout evidence and
> default decision are in [the 2026-09-11 rollout gate](2026-09-11-codex-rollout-gate.md).
> Do not use this older version baseline to assess current app-server readiness.

# Codex Phase 2 compatibility report

## Phase 1 gate

PASS. `npm test` completed 167/167 tests on the Phase 1 tree when the offline server tests were allowed to bind ephemeral loopback ports.

The authoritative Phase 1 interfaces are present with the planned equivalent behavior:

- `prepareCodexRuntime(account, deps?)`: returns `Promise<PreparedCodexRuntime>`.
- `createCodexAdapter(runtime: PreparedCodexRuntime): Adapter`.
- `Registry.appendPrompt(sessionId, text, delivery): string`.
- `AgentHandle.send(text, promptId?): void`.
- `PromptDelivery = 'queued' | 'sent' | 'unsent'`.
- `Session.stoppedCode: CodexFailureCode | null`.

The ChatGPT application candidate is defined only in the Phase 1 runtime resolver; the production adapter receives a prepared runtime and contains no hardcoded binary path.

## Installed runtime

- `@openai/codex-sdk`: `0.145.0`.
- SDK-bundled `@openai/codex` and `codex-cli`: `0.145.0`.
- Platform: macOS (`Darwin 25.5.0`, arm64).
- Verification runtime: Node.js `v25.9.0`, satisfying the repository's Node 22.18+ requirement.

The installed SDK types expose `ItemStartedEvent`, `ItemUpdatedEvent`, `ItemCompletedEvent`, structured `local_image` input, `runStreamed()`, `startThread()`, `resumeThread()`, and optional `ThreadOptions` fields `model`, `modelReasoningEffort`, `networkAccessEnabled`, and `webSearchMode`. `TurnOptions.signal` supports cancellation. The installed TypeScript surface has no interactive approval callback.

The installed CLI supports default `stdio://` app-server transport and version-specific `app-server generate-ts`. A schema generated from 0.145.0 without running a model turn contains thread start/resume, turn start/interrupt, `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, and `serverRequest/resolved` types.

## Official surface

The current [Codex SDK documentation](https://developers.openai.com/codex/sdk/) documents starting a TypeScript thread, continuing it by calling `run()` again, and resuming it by thread ID. The linked official [TypeScript SDK source documentation](https://github.com/openai/codex/tree/main/sdk/typescript) documents `runStreamed()` lifecycle events and structured `local_image` entries. The exact installed 0.145.0 declarations remain authoritative for the optional thread settings used by this plan. Neither the current TypeScript documentation nor the installed declarations exposes an approval callback, so the bounded app-server evaluation remains necessary.

The current [Codex app-server documentation](https://developers.openai.com/codex/app-server/) documents newline-delimited JSON-RPC over default `stdio://`, with the `jsonrpc` header omitted, and states that generated TypeScript/JSON schemas are specific to the CLI version that produced them. Its stable surface includes thread and turn lifecycle methods plus server-initiated command-execution and file-change approval requests. Command decisions are `accept`, `acceptForSession`, `decline`, `cancel`, or an exec-policy amendment; file decisions are `accept`, `acceptForSession`, `decline`, or `cancel`.

Phase 2 will omit `initialize.params.capabilities.experimentalApi`. This excludes experimental methods and fields, including experimental thread item/turn pagination and background-terminal/process operations, command approval `additionalPermissions`, dynamic tools, and app/connector MCP tool approvals. WebSocket transport is explicitly experimental and unsupported, so the probe remains stdio-only. Stable MCP coverage is `mcpServer/elicitation/request` and its `serverRequest/resolved` notification, not the experimental app-tool approval flow. The installed CLI still labels the app-server command and schema generator experimental at the command-line level; this does not authorize production use, and Task 8 remains a no-turn compatibility probe plus decision record.

## Plan adjustments

Task 8 now names the observed stable MCP contract precisely:

- `AppServerEvidence.mcpApprovalObserved` became `mcpElicitationObserved`.
- The fake and tests must use stable `mcpServer/elicitation/request` plus `serverRequest/resolved`.
- Experimental app/connector MCP tool approval is explicitly excluded from the probe and recorded as such in the decision matrix.

No Phase 1 interface, production adapter path, sandbox, approval-policy, or transport change was required.

## Decision

PASS. Tasks 1-9 can execute against the observed Phase 1 interfaces and installed 0.145.0 SDK/CLI. Production remains SDK-based, Task 8 remains isolated from production code, and any transport change still requires the later evidence and separate authorization specified by the plan.
