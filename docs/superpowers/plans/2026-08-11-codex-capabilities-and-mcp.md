# Codex Capability Discovery and MCP Parity Implementation Plan

## Execution baseline — revised 2026-09-10

Screenshot support implemented 2026-09-10. Shared provider-neutral capture
handlers feed Claude wrappers and pinned MCP 1.30.0 stdio sidecars. The installed
0.153.4 runtime verified both screenshot tools available in a disposable thread
without starting a model turn.

Task 2's older launch-wide injection proposal is superseded: the supervisor
reads effective configuration with `config/read` for the exact worktree, then
adds dotted MCP keys to the existing thread start/resume config map. This keeps
account-sharing safe across repositories and preserves configured server names.
Explicit session network settings take precedence. Config read failure skips
injection with a catalog warning. The launcher is `/usr/bin/env -i` followed by
the absolute Node executable and sidecar paths, so account environment values
cannot reach Node or capture children. Fixed PATH and local HOME are the only
explicit sidecar environment. No configuration files are written.

Capability discovery is implemented for live app-server sessions as of 2026-09-10:
- Session-scoped skills, apps, and MCP tools with availability reasons, filtering,
  manual refresh, bounded caching, and notification invalidation.
- Server-resolved namespaced aliases; native skill/app inputs stay process-local.
  Selection is checked before admission and again before turn dispatch.
- Generated protocol checks cover the new read methods and native input shapes.

Command/discovery extensions implemented 2026-09-10:
- Slash autocomplete lists installed skills (including plugin-provided skills),
  apps, MCP tools and supported built-ins, with descriptions and disabled reasons.
- `/skills`, `/apps`, `/mcp` filter the catalog locally. `/compact` uses
  `thread/compact/start`, waits for its asynchronous turn lifecycle, preserves
  FIFO, and supports Stop; arguments and attachments are rejected before admission.
- New-session preview validates the selected account and canonical Git directory,
  then reads skills/apps without creating a thread. Threadless MCP discovery is
  intentionally omitted because process-global servers may belong to another
  repository; session discovery remains authoritative for MCP/screenshots.
- Catalog refresh clears stale UI selections and account/session changes discard
  in-flight results. Native paths remain server-only.

Usage-limit recovery is now implemented. Next: remaining real-account validation
and sustained reliability testing before the opt-in default changes. Interactive browser control
and plugin marketplace management remain outside this phase. The older detailed
checkboxes below are historical; this execution baseline is authoritative.

Use the current account supervisor and persisted transport, rather than
rebuilding the foundation. The installed runtime is SDK/CLI 0.153.4 and MCP 1.30.0 is now a pinned direct
dependency. The original checklists below are historical implementation detail;
the execution baseline above records the current behavior and remaining scope.

App-server start/resume must continue forcing workspace-write, on-request, and
the user reviewer. SDK sessions retain never. Keep the existing Codex FIFO and
its question behavior; do not replace Claude's handle interface. Update the
generated-contract checks for each newly admitted method while preserving
telemetry-only restrictions. Work in this order: capability catalog and alias
resolution (Tasks 3–4), then screenshot handlers/configuration (Tasks 1–2), then
Task 5's bounded live gate. Screenshot tools remain read-only; interactive
browser/simulator control is outside this plan.


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give app-server Codex sessions Claude-shaped discovery of commands, skills, apps, and MCP tools, plus Switchboard's browser and simulator screenshot capabilities.

**Architecture:** Build a lazy account/cwd-scoped capability catalog from stable app-server APIs and resolve every alias again on the server at send time. Refactor screenshot logic into provider-neutral handlers, expose those handlers through stable stdio MCP sidecars, and inject fixed sidecar configuration only in the app-server child argv.

**Tech Stack:** Node.js 22.18+, TypeScript, Codex app-server 0.153.4, `@modelcontextprotocol/sdk` 1.30.0, browser JavaScript, HTTP/SSE, node:test.

## Global Constraints

- Complete `2026-08-11-codex-app-server-foundation.md` and `2026-08-11-codex-interactions.md` first.
- Execute in an isolated worktree created with `superpowers:using-git-worktrees`.
- Pin `@modelcontextprotocol/sdk` to exactly `1.30.0` as a direct dependency.
- Use only `skills/list`, `app/list`, `app/installed`, and `mcpServerStatus/list` plus their invalidation notifications.
- Do not call experimental plugin marketplace APIs.
- Do not create or modify `.codex/config.toml` or any target-repository file.
- Preserve user and repository Codex configuration and instructions.
- Keep Codex sandbox fixed to `workspaceWrite`.
- Expose only browser and simulator `screenshot`; do not add interactive control.
- Never pass account secrets to an MCP sidecar.
- Keep `npm test` offline and run it before completion.

---

## File structure

- Create `src/agents/codex-capabilities.ts`: scoped catalog, cache invalidation, and server-side alias resolution.
- Create `src/agents/codex-mcp-config.ts`: safe ephemeral app-server config arguments.
- Create `src/agents/mcp/browser-server.ts` and `src/agents/mcp/simulator-server.ts`: stable stdio MCP entrypoints.
- Create `test/codex-capabilities.test.ts`, `test/codex-mcp-config.test.ts`, and `test/mcp-sidecars.test.ts`.
- Modify `src/agents/browser.ts` and `src/agents/simulator.ts` to export shared handlers.
- Modify `src/agents/claude.ts` to retain its current in-process MCP wrappers around those handlers.
- Modify `src/agents/codex-app-server-client.ts`, `src/agents/codex-app-server-supervisor.ts`, `src/agents/codex-app-server.ts`, `src/server.ts`, `web/lib.js`, `web/app.js`, `web/style.css`, and related tests.
- Modify `test/helpers/fake-app-server.ts`, `package.json`, `package-lock.json`, `accounts.example.json`, and `README.md`.

### Task 1: Share screenshot handlers and add stdio MCP sidecars

**Files:**
- Modify: `src/agents/browser.ts`
- Modify: `src/agents/simulator.ts`
- Modify: `src/agents/claude.ts`
- Create: `src/agents/mcp/browser-server.ts`
- Create: `src/agents/mcp/simulator-server.ts`
- Create: `test/mcp-sidecars.test.ts`
- Modify: `test/browser.test.ts`
- Modify: `test/simulator.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces:

```ts
export type ScreenshotToolResult = {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: 'image/png' })[];
  isError?: boolean;
};
export function browserScreenshot(args: { url: string; width?: number; height?: number }): Promise<ScreenshotToolResult>;
export function simulatorScreenshot(args: { device?: string }): Promise<ScreenshotToolResult>;
```

- [ ] **Step 1: Write provider-neutral handler tests**

Assert successful image results and existing invalid-URL, missing-Chrome,
invalid-device, and capture-failure text errors without importing either
provider SDK.

- [ ] **Step 2: Write real stdio MCP round-trip tests**

Spawn each entrypoint through `StdioClientTransport`, call `tools/list`, then
call `screenshot` against fake Chrome/xcrun fixtures. Assert the advertised
server/tool names are `switchboard_browser.screenshot` and
`switchboard_simulator.screenshot`, and that no other tool is present.

- [ ] **Step 3: Run the new tests and verify RED**

Run: `node --test test/mcp-sidecars.test.ts test/browser.test.ts test/simulator.test.ts`

Expected: FAIL because the shared handlers and stdio entrypoints do not exist.

- [ ] **Step 4: Pin the direct MCP dependency**

Run: `npm install --save-exact @modelcontextprotocol/sdk@1.30.0`

Expected: `package.json` and `package-lock.json` record `1.30.0` directly.

- [ ] **Step 5: Extract the shared tool results**

Keep `capturePage()` and `captureScreenshot()` unchanged. Move only MCP result
shaping into the exported functions above, and make the existing Claude
`createSdkMcpServer()` tools delegate to them.

- [ ] **Step 6: Implement stable stdio MCP entrypoints**

Create one `McpServer` with one `screenshot` tool per entrypoint, connect it to
`StdioServerTransport`, write protocol traffic only to stdout, and send any
sanitized startup diagnostic to stderr. Set `process.exitCode = 1` on a fatal
startup failure.

- [ ] **Step 7: Run focused tests**

Run: `node --test test/mcp-sidecars.test.ts test/browser.test.ts test/simulator.test.ts test/agents-claude.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src/agents/browser.ts src/agents/simulator.ts src/agents/claude.ts src/agents/mcp/browser-server.ts src/agents/mcp/simulator-server.ts test/mcp-sidecars.test.ts test/browser.test.ts test/simulator.test.ts test/agents-claude.test.ts
git commit -m "feat: add screenshot MCP sidecars"
```

### Task 2: Build safe ephemeral MCP configuration

**Files:**
- Create: `src/agents/codex-mcp-config.ts`
- Create: `test/codex-mcp-config.test.ts`
- Modify: `src/agents/codex-app-server-client.ts`
- Modify: `src/agents/codex-app-server-supervisor.ts`
- Modify: `test/codex-app-server-client.test.ts`
- Modify: `test/agents-codex-app-server.test.ts`

**Interfaces:**
- Produces:

```ts
export type InjectedMcpConfig = {
  args: string[];
  enabledNames: string[];
  warnings: string[];
};
export function injectedMcpConfig(options: {
  nodePath: string;
  browserEntry: string;
  simulatorEntry: string;
  platform: NodeJS.Platform;
  chromePath: string | null;
  networkAccessEnabled: boolean;
  configuredNames: ReadonlySet<string>;
}): InjectedMcpConfig;
```

- [ ] **Step 1: Write the availability matrix tests**

Cover browser enabled/disabled by Chrome and network policy, simulator enabled
only on macOS, both enabled, reserved-name collisions, paths containing quotes
and spaces, and deterministic argument ordering.

- [ ] **Step 2: Write launch-boundary tests**

Capture the fake app-server argv and environment. Assert the sidecars use the
absolute current Node executable and absolute entrypoints, configuration is
passed as repeated `-c` argv pairs, no shell is involved, and account launch
environment values are absent from sidecar environment declarations.

Also drive a short-lived, unmodified preflight app-server connection before the
production child. Assert it calls `mcpServerStatus/list` without Switchboard
overrides, closes cleanly, and supplies the configured-name set used for
collision detection.

- [ ] **Step 3: Run tests and verify RED**

Run: `node --test test/codex-mcp-config.test.ts test/codex-app-server-client.test.ts test/agents-codex-app-server.test.ts`

Expected: FAIL because the config builder is missing.

- [ ] **Step 4: Implement TOML scalar and array encoding**

Use private `tomlString(value)` and `tomlArray(values)` helpers that escape
control characters and never interpolate through a shell. Emit only these
fixed keys per sidecar: `command`, `args`, `enabled = true`, `required = false`,
and `enabled_tools = ["screenshot"]`.

- [ ] **Step 5: Apply availability and collision rules**

Skip `switchboard_browser` unless Chrome exists and effective network access is
enabled. Skip `switchboard_simulator` off macOS. If `configuredNames` already
contains a reserved name, leave the user's configuration untouched and return
a visible warning.

- [ ] **Step 6: Feed args into the supervised process**

Before each supervisor launch, initialize a short-lived app-server with no
Switchboard MCP overrides, page `mcpServerStatus/list`, and close it. Append the
filtered generated argv only to the production app-server spawn. Publish
sanitized warnings through account preflight state and keep sidecar failure
nonfatal. Add a filesystem assertion proving launch never writes
`.codex/config.toml`.

- [ ] **Step 7: Run focused tests**

Run: `node --test test/codex-mcp-config.test.ts test/codex-app-server-client.test.ts test/agents-codex-app-server.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/agents/codex-mcp-config.ts src/agents/codex-app-server-client.ts src/agents/codex-app-server-supervisor.ts test/codex-mcp-config.test.ts test/codex-app-server-client.test.ts test/agents-codex-app-server.test.ts
git commit -m "feat: inject Codex screenshot MCP servers"
```

### Task 3: Add the scoped capability catalog

**Files:**
- Create: `src/agents/codex-capabilities.ts`
- Create: `test/codex-capabilities.test.ts`
- Modify: `src/agents/codex-app-server-supervisor.ts`
- Modify: `test/helpers/fake-app-server.ts`
- Modify: `test/agents-codex-app-server.test.ts`

**Interfaces:**
- Produces:

```ts
export type CapabilityKind = 'command' | 'skill' | 'app' | 'mcp-tool';
export type Capability = {
  id: string;
  kind: CapabilityKind;
  alias: string;
  displayName: string;
  description: string | null;
  available: boolean;
  unavailableReason: string | null;
  native: Record<string, unknown>;
};
export class CodexCapabilityCatalog {
  list(input: { cwd: string; threadId?: string; force?: boolean }): Promise<{ revision: number; capabilities: Capability[] }>;
  resolve(idOrAlias: string, input: { cwd: string; threadId?: string }): Promise<Capability | null>;
  invalidate(input?: { cwd?: string; source?: CapabilityKind }): void;
}
```

- [ ] **Step 1: Write source and pagination tests**

Have the fake return multiple cwd results from `skills/list`, two pages from
`app/list`, one `app/installed` runtime snapshot, and two pages from
`mcpServerStatus/list`. Assert stable namespaced aliases, app installed/auth
status, MCP startup status, descriptions, and installed plugin-provided
skills/apps appearing through those stable APIs.

- [ ] **Step 2: Write cache and invalidation tests**

Prove account/cwd/thread isolation, lazy first read, cache reuse at one revision,
selective invalidation on skill/app/MCP notifications, and a forced refresh.
Assert no plugin marketplace method reaches the fake.

- [ ] **Step 3: Write collision and trust-boundary tests**

Cover duplicate bare suffixes, duplicate display names, unavailable entries,
malformed provider records, and resolution by opaque server-generated ID. The
catalog must retain native app URIs and MCP identifiers only on the server.

- [ ] **Step 4: Run tests and verify RED**

Run: `node --test test/codex-capabilities.test.ts test/agents-codex-app-server.test.ts`

Expected: FAIL because the catalog does not exist.

- [ ] **Step 5: Implement normalized paginated reads**

Read `skills/list` for the exact cwd set and join `app/installed` to the
paginated `app/list` results. Page `app/list` and `mcpServerStatus/list` until
their continuation tokens are absent. Build namespaced aliases `/skill:name`,
`/app:name`, and `/mcp:server.tool`; include `/compact`, `/skills`, `/apps`, and
`/mcp` command entries. Derive opaque IDs from source kind plus native identity,
never from browser input.

- [ ] **Step 6: Implement revision caching and invalidation**

Key caches by supervisor account identity plus canonical cwd and optional
thread ID. Increment the revision on exact `skills/changed`,
`app/list/updated`, and `mcpServer/startupStatus/updated` invalidation signals,
and coalesce concurrent reads for the same key. An invalid source record is
omitted and recorded as a sanitized catalog warning rather than failing the
turn.

- [ ] **Step 7: Run focused tests**

Run: `node --test test/codex-capabilities.test.ts test/agents-codex-app-server.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/agents/codex-capabilities.ts src/agents/codex-app-server-supervisor.ts test/codex-capabilities.test.ts test/agents-codex-app-server.test.ts test/helpers/fake-app-server.ts
git commit -m "feat: discover Codex capabilities"
```

### Task 4: Expose aliases and resolve native inputs server-side

**Files:**
- Modify: `src/server.ts`
- Modify: `src/agents/codex-app-server.ts`
- Modify: `web/lib.js`
- Modify: `web/app.js`
- Modify: `web/style.css`
- Modify: `test/server.test.ts`
- Modify: `test/ui-command.test.ts`
- Modify: `test/ui.test.ts`
- Modify: `test/agents-codex-app-server.test.ts`

**Interfaces:**
- Produces: `GET /capabilities?account=<name>&cwd=<path>` for new-session discovery and `GET /capabilities?sessionId=<id>` for existing sessions.
- Produces:

```ts
export type AliasExpansion =
  | { kind: 'turn'; displayText: string; input: Record<string, unknown>[] }
  | { kind: 'compact' }
  | { kind: 'filter'; filter: 'skill' | 'app' | 'mcp-tool' };
export function expandCodexAlias(text: string, capability: Capability): AliasExpansion;
```

- [ ] **Step 1: Write capability endpoint tests**

Assert Host protection, account existence, repository-path validation for a
new session, and server-derived worktree cwd/account for an existing session.
Reject requests that combine `sessionId` with browser-supplied account/cwd.

- [ ] **Step 2: Write exact alias expansion tests**

Assert `/skill:name` produces visible `$name` plus a native `skill` input,
`/app:name` produces visible `$name` plus a native `mention` containing the
server-held `app://` URI, `/mcp:server.tool` produces an explicit bounded tool
instruction, and `/compact` calls `thread/compact/start` without `turn/start`.

- [ ] **Step 3: Write menu behavior tests**

Cover typed capability entries, `/skills`/`/apps`/`/mcp` local filtering,
namespaced collision handling, a unique bare suffix, unavailable reasons,
catalog revision refresh, transcript preservation of entered slash text, and
safe rendering with `textContent`.

- [ ] **Step 4: Run tests and verify RED**

Run: `node --test test/server.test.ts test/ui-command.test.ts test/ui.test.ts test/agents-codex-app-server.test.ts`

Expected: FAIL on the endpoint, typed menu, and alias expansion.

- [ ] **Step 5: Implement the read-only endpoint**

For `sessionId`, derive account and cwd exclusively from Registry state. For a
new session, validate the named account and canonical selected repository path.
Return only public capability fields and `revision`; never return `native`.

- [ ] **Step 6: Resolve again inside the send command**

Treat the browser's selected ID as a hint. Resolve it from the current catalog,
require availability, then build native input from server-held fields. A stale
or ambiguous selection returns 409 with a refreshable error and never starts a
turn.

- [ ] **Step 7: Implement the typed menu and filters**

Update `commandMenu()` and `commandToken()` to accept capability objects while
retaining Claude string-command compatibility. Render kind, description, and
disabled reason; fetch lazily when a composer opens on `/` and when revision
invalidation is signaled.

- [ ] **Step 8: Run focused tests**

Run: `node --test test/server.test.ts test/ui-command.test.ts test/ui.test.ts test/agents-codex-app-server.test.ts`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/server.ts src/agents/codex-app-server.ts web/lib.js web/app.js web/style.css test/server.test.ts test/ui-command.test.ts test/ui.test.ts test/agents-codex-app-server.test.ts
git commit -m "feat: add Claude-shaped Codex capability menu"
```

### Task 5: Verify live sidecars and document the boundary

**Files:**
- Modify: `scripts/smoke-codex-app-server.ts`
- Modify: `test/codex-app-server-smoke.test.ts`
- Modify: `accounts.example.json`
- Modify: `README.md`

- [ ] **Step 1: Add opt-in smoke assertions**

In fixture mode, assert skill/app/MCP discovery, browser sidecar status, one
browser image result, reserved-name warning, and simulator image result on the
supported platform. In real mode, require explicit flags before either image
tool runs.

- [ ] **Step 2: Run smoke fixture tests**

Run: `node --test test/codex-app-server-smoke.test.ts test/mcp-sidecars.test.ts`

Expected: PASS without network or real accounts.

- [ ] **Step 3: Document configuration and exclusions**

Document capability scoping, slash mappings, sidecar prerequisites, collision
warnings, HTTP/HTTPS-only browser behavior, simulator/macOS availability, no
repository config writes, and the deferred plugin marketplace and interactive
control scopes.

- [ ] **Step 4: Run the complete offline suite**

Run: `npm test`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/smoke-codex-app-server.ts test/codex-app-server-smoke.test.ts accounts.example.json README.md
git commit -m "docs: explain Codex capability parity"
```
