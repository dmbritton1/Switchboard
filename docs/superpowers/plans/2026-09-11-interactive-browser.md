# Interactive Browser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver isolated browser testing with persistent profiles and a live manual-control panel for Claude and Codex app-server sessions.

**Architecture:** A server-owned testing service serializes actions and owns processes. Session-bound provider wrappers and the viewer use that service; no adapter owns an independent interactive browser. The browser backend uses Playwright and a compatible pinned Chromium build.

**Tech Stack:** Node >=22.18, TypeScript, node:test, Playwright, Chromium CDP frames, existing MCP SDK and plain web UI.

**Spec:** `docs/superpowers/specs/2026-09-11-interactive-app-testing-design.md`

## Global Constraints

- Each Switchboard session gets its own browser process and persistent profile.
- Testing starts in the background.
- Legacy SDK-owned Codex sessions retain their transport.
- Preserve fixed Codex sandbox/approval policies, per-request Allow/Deny/Auto, account-secret isolation, and repository configuration.
- Do not expose arbitrary JavaScript evaluation, shell execution, or raw CDP commands.
- No automatic replay of mutations with uncertain outcomes.
- Profiles remain outside repositories; frames and credentials never enter Registry persistence or SSE snapshots.
- Multi-day rollout work remains tabled; do not change default transport.
- Existing uncommitted work belongs to the ongoing app-server program. Do not reset it or indiscriminately stage it. At execution start inspect git state and the worktree skill before choosing isolation; an isolated checkout must include the required current implementation.

## Files and boundaries

Create `src/testing/types.ts` for shared contracts, `control.ts` for serialization,
`profiles.ts` for managed disk ownership, `service.ts` for session lifetime,
`browser-driver.ts` for Playwright, `browser-tools.ts` for validated operations,
`bridge.ts` for local MCP transport, and `routes.ts` for viewer HTTP handling.
Create corresponding `test/testing-*.test.ts` and `test/helpers/fake-testing.ts`.
Create `web/testing.js` for panel state and `web/testing.css` for presentation.
Integrate at `src/server.ts`, provider launch types in `src/types.ts`,
`src/agents/claude.ts`, `browser.ts`, `codex-app-server-supervisor.ts`,
`codex-mcp-config.ts`, and `src/agents/mcp/browser-server.ts`.

## Task 1: Establish browser feasibility and a tested dependency pair

**Files:** Create `scripts/smoke-interactive-browser.ts`; update `package.json`, `package-lock.json` only after the probe passes. Create `docs/superpowers/reports/2026-09-11-interactive-browser-feasibility.md`.

**Interfaces:** Produces a verified Playwright/Chromium version pair and a manual no-model smoke command. This task is a gate, not permission to adopt arbitrary latest dependencies.

- [ ] Inspect current official Playwright launch, persistent-context, CDPSession, locator, and screenshot APIs and Node requirements. Resolve one Node-22-compatible release in a disposable directory.
- [ ] Serve a temporary local form containing an input, popup link, console-error button, and cookie counter. Launch with a disposable persistent profile and sanitized environment. Use this probe sequence:

```ts
const context = await chromium.launchPersistentContext(profile, {headless: true});
const page = context.pages()[0] ?? await context.newPage();
await page.goto(fixtureUrl);
await page.getByRole('textbox').fill('unsaved value');
const cdp = await context.newCDPSession(page);
cdp.on('Page.screencastFrame', event => {
  frames.push(event.data);
  void cdp.send('Page.screencastFrameAck', {sessionId: event.sessionId});
});
await cdp.send('Page.startScreencast', {format: 'jpeg', quality: 70});
await cdp.send('Page.stopScreencast');
assert.equal(await page.getByRole('textbox').inputValue(), 'unsaved value');
await context.close();
```

- [ ] Verify frame receipt, coordinate click and typing, reopen profile cookie retention, popups, dialog handling, and cleanup in `finally`. Fail the probe if a helper process or server remains running. Bound each operation to 30 seconds.
- [ ] Record exact versions and outcomes. Pin the passing Playwright dependency; make browser installation an explicit setup command, never a hidden startup download. Keep this smoke outside `npm test`.

## Task 2: Implement serialized ownership and takeover

**Files:** Create `src/testing/types.ts`, `src/testing/control.ts`, `test/testing-control.test.ts`.

**Interfaces:** Export these contracts; later tasks import rather than redeclare them:

```ts
export type Surface = 'browser' | 'ios';
export type ControlState = 'agent' | 'takeover-pending' | 'human' | 'stopped' | 'failed';
export type Lease = {sessionId: string; generation: string};
export type Observation = {generation: number; pageId: string; revision: number};
export interface Control {
  state: ControlState;
  run<T>(actor: 'agent' | 'human', mutation: boolean, job: () => Promise<T>): Promise<T>;
  take(): Promise<void>;
  giveBack(): void;
  stop(): Promise<void>;
}
export function createControl(): Control;
```

- [ ] Add a deferred-job test for takeover, rejection of pending/new agent mutations, and exactly-once execution. Representative assertion:

```ts
const c = createControl();
await c.take();
await assert.rejects(c.run('agent', true, async () => 'clicked'), /human control/);
assert.equal(await c.run('human', true, async () => 'clicked'), 'clicked');
c.giveBack();
assert.equal(c.state, 'agent');
```

- [ ] Run `node --test test/testing-control.test.ts`; confirm failures exercise missing behavior.
- [ ] Implement a FIFO queue capped at 32 pending actions, 30-second action deadlines, and a five-second stop deadline. On takeover reject queued agent mutations. On timeout fail the control instance, reject queued actions, and require driver teardown before replacement; Promise timeout alone does not stop underlying I/O.
- [ ] Test stop during an active action, queue saturation, mutation timeout without replay, and idempotent cleanup. Run the focused command until passing.
- [ ] Review the isolated diff; commit only this task's owned changes if git permissions permit.

## Task 3: Own profiles and live session generations

**Files:** Create `src/testing/profiles.ts`, `src/testing/service.ts`, `test/testing-profiles.test.ts`, `test/testing-service.test.ts`.

**Interfaces:** `createTestingService({root, browserFactory})` exposes `bind(sessionId,cwd): Lease`, `assertLease(lease): void`, `stop(lease): Promise<void>`, `deleteProfile(sessionId): Promise<void>`, `resetBrowser(lease): Promise<void>`, and `close(): Promise<void>`. Driver factory is `({profile,cwd}) => Promise<BrowserDriver>`; define BrowserDriver in Task 4 before connecting the backend. Factory injection allows fake handles here.

- [ ] Write isolation, stale-lease, cookie-directory retention, symlink escape, and exact-directory deletion tests. Use random managed directory names instead of session IDs as paths:

```ts
const a = service.bind('a', fixtureCwd);
await service.stop(a);
const b = service.bind('a', fixtureCwd);
assert.notEqual(a.generation, b.generation);
assert.throws(() => service.assertLease(a), /stale/);
service.assertLease(b);
```

- [ ] Run `node --test test/testing-profiles.test.ts test/testing-service.test.ts`.
- [ ] Store an atomic versioned profile index under the configured app-managed testing root, with owner-only directory/file modes. Persist only opaque profile associations; never live leases. Realpath-check the root and reject symlinks before deletion. Serialize bind/reset/delete per session, require teardown before opening the same profile again, and remove orphan metadata only through explicit owned cleanup.
- [ ] Inject fake process handles and verify failed starts, duplicate stop, server close, and deletion after partial cleanup. Run focused tests, then review/commit this task's diff.

## Task 4: Browser operations with fresh observations

**Files:** Create `src/testing/browser-driver.ts`, `src/testing/browser-tools.ts`, `test/testing-browser.test.ts`, `test/helpers/fake-testing.ts`.

**Interfaces:** Export `BrowserDriver` with `execute(action: BrowserAction): Promise<BrowserResult>`, `subscribeFrames(listener: (frame: BrowserFrame) => void): () => void`, and `close(): Promise<void>`. Define validated discriminated `BrowserAction` variants for open, tabs, select, close, navigate, inspect, click, fill, key, scroll, resize, screenshot, errors, and dialog. BrowserFrame is `{pageId,revision,width,height,jpeg}`. BrowserResult contains bounded public text/element references and optional image data, never native paths.

- [ ] Test HTTP(S) validation, stale element references, popup ownership, dialog state, viewport changes, and redacted/bounded console collection. Example:

```ts
const old = await driver.execute({type:'inspect'});
await driver.execute({type:'navigate', direction:'reload'});
await assert.rejects(driver.execute({type:'click', ref:old.elements[0].ref}), /inspect again/);
```

- [ ] Run `node --test test/testing-browser.test.ts`.
- [ ] Map validated operations to Playwright locators/input APIs. Maintain opaque references to observed elements scoped to the document; require fresh inspection after return-control. Reject non-HTTP(S) navigation, privileged popup destinations, unsupported uploads/downloads, and arbitrary evaluation. Attach console listeners at page creation; cap 100 entries and 32 KiB serialized details, redact before admission.
- [ ] Use generation checks before dispatch and after awaits. Do not retry mutations after Playwright timeout. Close the affected driver when command completion is uncertain. Keep screenshot compatibility in the existing one-shot helper.
- [ ] Implement frames with one pending frame per viewer, maximum 10 FPS, 2 MiB/frame, 3000px dimensions, immediate CDP acknowledgement, and no buffering when hidden. Verify frame-loop teardown and fake-browser failures; review/commit passing task changes.

## Task 5: Session-bound provider bridges and lifecycle integration

**Files:** Create `src/testing/bridge.ts`, `test/testing-bridge.test.ts`; modify `src/types.ts`, `src/server.ts`, `src/agents/claude.ts`, `src/agents/browser.ts`, `src/agents/codex-app-server-supervisor.ts`, `src/agents/codex-mcp-config.ts`, `src/agents/mcp/browser-server.ts`; extend existing provider/config/server tests.

**Interfaces:** `createTestingBridge(service)` produces `bind(lease): {endpoint,credential}`, `revoke(lease)`, `close()`. Internal request shape is `{operation,args}`; identity comes exclusively from the credential. Launch options gain a server-provided testing binding. Claude uses an in-process wrapper factory; Codex uses the credential-bound stdio client. Both call the same validated operations.

- [ ] Write denial tests for wrong credential, wrong generation, stale sidecar after resume, missing network permission, reserved MCP name collisions, and account env exposure:

```ts
await service.stop(lease);
assert.equal((await callBridge(oldCredential, {operation:'tabs',args:{}})).status, 403);
assert.equal(JSON.stringify(publicSnapshot).includes(oldCredential), false);
```

- [ ] Run `node --test test/testing-bridge.test.ts test/codex-mcp-config.test.ts test/mcp-sidecars.test.ts`.
- [ ] Implement an owner-only Unix socket bridge on macOS with random per-generation credentials, bounded request bodies, and no TCP debug listener exposed. Pass bridge credentials through a dedicated startup channel; do not include them in model-visible arguments, command logs, transcripts, or SSE. Preserve the sanitized sidecar launch environment.
- [ ] Bind only after session ownership is established; revoke immediately on stop, deletion, failed launch, handoff, and replacement. Await teardown through the service. Convert Claude's browser wrapper to a factory; retain legacy screenshot calls and accurate mutation annotations. Ensure existing approval plumbing still supplies Allow/Deny/per-request Auto.
- [ ] Advertise browser tools only when readiness and effective session permissions permit. Resolve inherited Codex network policy from configuration; enforce it at the host-side service, not only discovery. Protect UI and bridge paths from bypassing that gate.
- [ ] Extend provider parity tests and server lifecycle tests, run their focused commands, review/commit the task.

## Task 6: Live panel and manual input

**Files:** Create `src/testing/routes.ts`, `web/testing.js`, `web/testing.css`, `test/testing-routes.test.ts`, `test/ui-testing.test.ts`; integrate `src/server.ts`, `web/app.js`, `web/index.html` and static allowlist.

**Interfaces:** `/testing/control` POST accepts a session ID plus show/take/return/reset command. `/testing/frame` GET returns the latest bounded frame to an authorized viewer. `/testing/input` POST accepts a viewer credential plus frame revision and a typed input action. `/testing/state` exposes public ownership/readiness metadata only. Keep viewer tokens in memory and request headers, never URLs or persistent browser storage.

- [ ] Inspect existing Host/Origin guards; write tests that reject cross-origin requests, foreign Host headers, missing/incorrect viewer credentials, stopped sessions, and stale viewport revisions. The existing server must not be assumed to provide authentication simply because it is localhost.
- [ ] Run `node --test test/testing-routes.test.ts test/ui-testing.test.ts`.
- [ ] Mint short-lived session-scoped viewer credentials only from same-origin guarded requests, enforce them on frames/input, and require origin checks for all mutations. Register only explicit paths/methods and bound payloads. Do not publish raw automation endpoints. Use frame polling capped at 10 FPS while visible, `Cache-Control: no-store`, and abort reads on hide.
- [ ] Render state via textContent and a frame canvas/image. Map pointer positions from displayed content bounds to frame coordinates; reject letterbox/out-of-bounds input. Forward input only in human state; handle focus, key events, paste text, wheel, and lost connections. Never log typed input. On return require agent reinspection. Closing the panel while human-owned leaves a visible Return control action on the card.
- [ ] Add tab selection, URL, loading/error states, Reset browser with explicit destructive-data copy, and keyboard-accessible controls. Display cookie persistence accurately without promising restored unsaved forms after restart.
- [ ] Test takeover interleavings and input mapping, then verify the local fixture visually using both pointer and keyboard. Review/commit the task's passing changes.

## Task 7: Browser release verification and documentation

**Files:** Update `README.md`, extend `scripts/smoke-interactive-browser.ts`, create `docs/superpowers/reports/2026-09-11-interactive-browser-validation.md`.

**Interfaces:** No new runtime contract. Produces reproducible readiness/setup instructions and acceptance evidence.

- [ ] Run the offline boundary suite, including two session profiles, stop/resume, human takeover, crashed driver, pending-action cancellation, secret redaction, and legacy screenshot regression tests.
- [ ] Run `npm test` and `git diff --check`. No real browser/account calls belong in npm test.
- [ ] Run the manual local fixture probe. Check two simultaneous sessions do not share cookies or elements; Show/Hide preserves unsaved input; reset/deletion removes only managed data; no child survives shutdown.
- [ ] Perform one bounded real-provider workflow per Claude and opted-in Codex app-server with disposable test data. Record actual tool discovery, approval behavior, click/type/inspect results, and takeover. Do not claim parity from one provider's test. Close probe sessions and servers.
- [ ] Document the pinned browser install command, app-managed data location, controls, limitations, and runtime errors. Mark only verified acceptance items passed. Commit only reviewed task files if allowed; leave unrelated accumulated changes intact.

## Plan self-review

Browser spec requirements map to Tasks 1–7: backend feasibility (1), concurrency
and uncertain results (2), persistence/cleanup (3), tools/observations/frames (4),
provider boundaries and permissions (5), panel and HTTP security (6), acceptance
and setup (7). Simulator-specific work is in the companion iOS plan. No default
transport or multi-day rollout work is included.
