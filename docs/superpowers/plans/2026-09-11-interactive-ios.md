# Interactive iOS Simulator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add exclusive iOS simulator testing and manual takeover for Claude and Codex app-server sessions.

**Architecture:** Reuse the server-owned service, generation checks, control queue, bridge, and viewer routes from the browser plan. A simulator adapter combines simctl discovery with Appium/XCUITest interaction. Claims are process-local and indexed by exact UDID.

**Tech Stack:** Node >=22.18, TypeScript, node:test, macOS/Xcode/simctl, compatible pinned Appium/XCUITest/WebDriverAgent, existing MCP tools and web panel.

**Spec:** `docs/superpowers/specs/2026-09-11-interactive-app-testing-design.md`

## Global Constraints

- Only one Switchboard session controls a device at a time.
- No automatic runtime installation, device creation, erase, or physical iPhone support.
- Missing iOS tooling does not disable browser testing.
- Device app data is device-scoped and may remain for the next owner.
- Preserve fixed provider policies and account-secret isolation.
- No automatic retry of mutations with uncertain outcomes.
- Claims are process-local; restart restores no ownership.
- Browser plan Tasks 2, 3, 5, and 6 supply shared interfaces. Read that plan and spec before implementation.
- Multi-day rollout work remains tabled; transport defaults do not change.

## Files and interfaces

Create `src/testing/ios-readiness.ts`, `ios-claims.ts`, `ios-driver.ts`, and
`ios-tools.ts`. Extend `service.ts`, `routes.ts`, `web/testing.js`, and the
provider wrappers in `src/agents/simulator.ts`, `claude.ts`,
`codex-mcp-config.ts`, and `src/agents/mcp/simulator-server.ts`.
Create `test/testing-ios-*.test.ts`, a fake WebDriver HTTP boundary under
`test/helpers/`, and `scripts/smoke-interactive-ios.ts`.

## Task 1: Device readiness and a real interaction feasibility gate

**Files:** Create `src/testing/ios-readiness.ts`, `test/testing-ios-readiness.test.ts`, `scripts/smoke-interactive-ios.ts`; record `docs/superpowers/reports/2026-09-11-interactive-ios-feasibility.md`.

**Interfaces:** `readIosReadiness(): Promise<{available:boolean;reasons:string[];devices:{udid:string;name:string;booted:boolean}[]}>`. Inject executable runners for offline tests.

- [ ] Inspect official version compatibility for installed Xcode, Appium, XCUITest driver and Node. Pin a compatible pair only after live verification; use a task-local driver home to avoid altering a user's global Appium install.
- [ ] Test missing commands, malformed JSON, no runtime, duplicate device names, unavailable devices, and bounded command failures. Parse exact UDIDs from `xcrun simctl list devices available --json`; never treat device names as ownership keys.

```ts
const state = await readIosReadiness();
assert.equal(state.available, false);
assert.ok(state.reasons.length > 0);
```

- [ ] Run `node --test test/testing-ios-readiness.test.ts`; implement injectable command execution with argv arrays, 30-second deadlines, and public errors without native credential paths.
- [ ] If no runtime exists, report readiness as unavailable and continue fake-boundary work. Obtain user direction for runtime/device installation instead of doing it silently. Do not mark live feasibility passed.
- [ ] With an available explicitly chosen test device, run WebDriverAgent and verify an actual accessibility lookup, tap, swipe, typed value, screenshot, app launch and driver teardown on a disposable app. The probe must contain `try/finally` deleting its WebDriver session and closing only owned processes:

```ts
let driver;
try {
  driver = await openIosDriver(udid);
  await driver.execute({type:'inspect'});
  await driver.execute({type:'screenshot'});
} finally {
  await driver?.close();
}
```

- [ ] Record exact versions, command/setup steps and evidence. Keep paid provider turns and real simulator probes outside npm test. Review/commit this task's owned changes when verified.

## Task 2: Exclusive claims and safe cleanup

**Files:** Create `src/testing/ios-claims.ts`, `test/testing-ios-claims.test.ts`; extend `src/testing/service.ts`.

**Interfaces:** `createIosClaims()` exposes `claim(lease:Lease,udid:string): void`, `assertOwner(lease,udid): void`, `release(lease,udid): void`, `releaseAll(lease): void`. An already-owned device returns a typed busy error; claiming the same device with the same lease is idempotent.

- [ ] Test two simultaneous claims, stale generations, release by non-owner, repeat release, failed initialization, and server shutdown:

```ts
claims.claim(a, udid);
assert.throws(() => claims.claim(b, udid), /busy/);
claims.releaseAll(a);
claims.claim(b, udid);
assert.throws(() => claims.assertOwner(a, udid), /owner/);
```

- [ ] Run `node --test test/testing-ios-claims.test.ts`.
- [ ] Implement a process-local UDID map. Hold ownership until the old driver has stopped; if teardown is uncertain, quarantine the device from reassignment until cleanup verifies completion. Integrate stop, deletion, failed launch, and server close. Do not erase devices or kill unrelated Simulator.app/Xcode processes.
- [ ] Run focused claim/service tests and review/commit the task.

## Task 3: Appium driver and validated iOS tools

**Files:** Create `src/testing/ios-driver.ts`, `src/testing/ios-tools.ts`, `test/testing-ios-driver.test.ts`, `test/testing-ios-tools.test.ts`.

**Interfaces:** `openIosDriver(udid:string): Promise<IosDriver>`; IosDriver has `execute(action:IosAction): Promise<IosResult>` and `close():Promise<void>`. IosAction variants: inspect, tap, swipe, type, button, screenshot, install, launch, terminate. IosResult contains bounded public text/elements and optional PNG. Export `validateSimulatorApp(cwd,path): Promise<string>` for canonical worktree-contained .app validation.

- [ ] Build a fake WebDriver HTTP boundary and test errors, unknown completion, invalid coordinates, unsupported buttons, stale element IDs, oversized screenshots, install path escapes and account-env stripping.

```ts
await assert.rejects(validateSimulatorApp(cwd, '../outside.app'), /worktree/);
await assert.rejects(driver.execute({type:'tap', ref:'old-document-ref'}), /inspect again/);
assert.equal(fakeDriver.mutationCalls, 0);
```

- [ ] Run `node --test test/testing-ios-driver.test.ts test/testing-ios-tools.test.ts`.
- [ ] Map validated actions to the verified Appium/WebDriver APIs from Task 1. Enforce exact claimed UDID before every operation; cap screen dimensions, text and response sizes; apply 30-second action deadlines. On timeout terminate the driver and invalidate observations without replay.
- [ ] Bind driver communications to protected local infrastructure. Appium must not expose an unprotected control listener to tested apps/other clients: configure supported authentication when available in the pinned version, or use a protected proxy plus a verified inaccessible backend. If the selected stack cannot meet this boundary, stop the backend integration and revise this security detail before shipping.
- [ ] Check canonical .app containment immediately before installation and reject escaping symlinks. Use explicit bundle IDs for launch/terminate; no shell commands from model arguments. Redact diagnostics and never retain typed secrets. Review/commit passing task changes.

## Task 4: Provider tools and simulator panel

**Files:** Modify `src/agents/simulator.ts`, `src/agents/claude.ts`, `src/agents/mcp/simulator-server.ts`, `src/agents/codex-mcp-config.ts`, `src/testing/routes.ts`, `web/testing.js`; add `test/testing-ios-integration.test.ts`, extend `test/ui-testing.test.ts`, `test/mcp-sidecars.test.ts`.

**Interfaces:** Extend the existing service bridge with ios readiness/claim/release and validated actions. Viewer controls identify surface `ios`; device identity remains service-validated, and the bridge credential still supplies the sender.

- [ ] Test missing-runtime discovery, busy-device messages, claim release on stop, cross-session denial, screenshot ownership checks, takeover and fresh observation on return.
- [ ] Run `node --test test/testing-ios-integration.test.ts test/ui-testing.test.ts test/mcp-sidecars.test.ts`.
- [ ] Build session-specific Claude/MCP wrappers with accurate mutation annotations. Route old simulator screenshot tools through claims during interactive use; resolve names to exact UDIDs and reject ambiguity. Existing compatibility paths must not bypass claims.
- [ ] Add a device picker, readiness explanation, Claim/Release, screen view, and Take/Return control. Poll screenshots only while viewed, at most 2 FPS with one in flight; ensure input uses the latest screenshot dimensions. Explain that device app data can remain after release. Do not silently acquire another device or return control when the panel closes.
- [ ] Verify lifecycle cleanup and provider approval behavior with fake boundaries, then review/commit passing task changes.

## Task 5: iOS acceptance and setup documentation

**Files:** Update `README.md`, `scripts/smoke-interactive-ios.ts`; create `docs/superpowers/reports/2026-09-11-interactive-ios-validation.md`.

**Interfaces:** No new runtime API; produces setup and release evidence.

- [ ] Run focused iOS and shared-service tests, followed by `npm test` and `git diff --check`.
- [ ] With a ready simulator, run the live fixture: install/launch, inspect, tap/swipe/type, screenshot, human takeover, return-control refresh, second-session busy rejection, and release/reclaim after stop.
- [ ] Run a bounded real-provider workflow once each for Claude and Codex app-server; confirm actual tool discovery, approvals and returned images. Record incomplete checks explicitly when runtime or provider access is unavailable.
- [ ] Document pinned setup commands, optional iOS readiness, data persistence, ownership limits, and troubleshooting. Confirm no driver sessions, helper processes, or test server remain. Do not erase the user's simulator. Commit only reviewed task files when allowed.

## Plan self-review

Readiness and backend feasibility map to Task 1; claims and lifecycle to Task 2;
interaction, containment and driver protection to Task 3; tools and viewer to
Task 4; actual-device/provider acceptance to Task 5. Browser delivery is not
blocked by missing iOS setup. The shared spec's transport and multi-day rollout
boundaries apply throughout.
