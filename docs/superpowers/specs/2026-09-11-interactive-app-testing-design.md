# Interactive browser and iOS app testing

Date: 2026-09-11

Status: Agreed product direction; detailed spec ready for review. No implementation yet.

## Outcome and approved workflow

Switchboard agents can test the web and iOS apps they are building, observe
results, and continue editing. Claude and Codex app-server sessions use the same
underlying testing service. Existing SDK-owned Codex sessions retain their
transport; this feature does not migrate them or flip the default to app-server.

Each Switchboard session gets its own browser process and persistent profile.
Testing starts in the background. Show browser opens a live view inside
Switchboard of the same running page, preserving unfinished forms and page state.
The user can watch, take control, and return control to the agent.

Browser cookies and other persistent site storage survive stop/resume. An
explicit Reset browser action clears them. Deleting a session removes its owned
browser profile. In-memory JavaScript state survives opening and closing the
viewer, but is not promised across process shutdown or restart. Site-expired
logins still require signing in again.

iOS is the first mobile platform. A session explicitly selects and claims an
available simulator. Only one Switchboard session controls that device at a
time; other sessions select another device or receive a busy result. There is
no automatic waiting queue in the initial release.

## Chosen approach and alternatives

Use Playwright with a pinned compatible Chromium build for browser actions and
persistent profiles. Stream the rendered viewport into a Switchboard panel;
forward user input through the same service used for agent actions. This avoids
restarting a headless browser to make it visible. The panel is a remote view of
the actual page, not an iframe embedding the tested app.

A separate visible browser window would reduce viewer implementation work,
but coordinating manual input and background visibility would be less reliable.
Attaching to a personal browser via an extension is outside the agreed app-testing
scope. Hand-written CDP automation would reduce dependencies but duplicate
Playwright's element targeting, waiting, and page lifecycle work.

Use Appium with the XCUITest driver and WebDriverAgent for simulator interaction.
Use simctl for device discovery and appropriate device lifecycle operations.
The existing simctl screenshot path alone cannot supply taps and typing.
Appium adds setup cost, but provides an established interaction backend instead
of requiring Switchboard to maintain its own XCTest runner.

These are Switchboard implementation choices, not claims about the internals
of Claude Code or the Codex desktop browser.

## Architecture and ownership

Introduce a provider-neutral testing service owned by the Switchboard server.
It owns browser processes, profile locations, simulator claims, action queues,
viewer connections, and cleanup. Provider adapters expose thin tool wrappers;
the web UI uses authenticated session-scoped routes to the same service.

Claude's current globally shared screenshot servers must become session-bound
factories. Codex's stdio MCP sidecars become session-bound clients of the service.
They must not independently launch untracked interactive browsers or own device
locks. Every bridge has an opaque, revocable credential scoped to one live
session generation; session identity is never accepted from model tool arguments.

Keep the bridge local, verify ownership on every request, and revoke it at stop,
deletion, or replacement. A stale adapter cannot act on a resumed session. Use
bounded protocol messages and deadlines. No unauthenticated CDP or Appium endpoint
is exposed to the UI, tested pages, or other local clients through Switchboard.

Keep durable profile metadata separate from process-local state. Persist only
the opaque profile association and optional device preference. Ownership,
control state, driver handles, credentials, and queues are process-local. A
server restart restores sessions stopped and restores no device claims.

## Browser tools and panel

Initial actions: open an HTTP(S) page, list/select/close tabs, navigate back or
forward, reload, inspect visible elements, click, fill a field, press a key,
scroll, resize the viewport, capture a screenshot, and read bounded console or
page errors. Popups remain owned by the originating session and appear in its
tab list. Provide explicit handling for ordinary page alert/confirm/prompt dialogs.

Prefer element references obtained from a recent page inspection. References
are scoped to the page and invalidated when its document changes. Coordinate
input is a fallback tied to the current viewport. An invalid reference returns
a refresh-required result rather than clicking a guessed replacement. Do not
expose arbitrary JavaScript evaluation, shell execution, or raw CDP commands.

The panel includes a tab selector, URL, connection status, Show/Hide, Take control,
Return control, and Reset browser. Merely showing it is read-only. Hiding it
stops frame delivery, not the browser. Stream only while a viewer is connected,
with frame-rate, size, and backpressure limits. Match input coordinates to the
displayed frame size and reject obsolete input after a viewport change.

First version excludes upload/download automation, saved recordings, full network
body inspection, personal browser attachment, and Safari/Firefox testing. The
agent starts development servers using its existing terminal tools; the browser
service does not acquire an additional shell or build runner.

## iOS tools and panel

Provide readiness/device discovery, claim/release, boot the claimed device,
install a built simulator app from the session worktree, launch/terminate a
specified app, inspect accessibility elements, tap, swipe, type, press supported
device buttons, and capture the screen. Resolve devices to exact UDIDs before
claiming; never use an ambiguous `booted` alias for interactive actions.

Installation accepts only a validated worktree-contained simulator .app bundle,
including canonical-path and symlink checks. Building remains in the existing
terminal workflow. No runtime installation, device creation, erase, or physical
iPhone support is included in the initial tools.

The iOS panel presents the selected device, readiness and ownership state,
screen updates, and the same manual-control handoff as the browser. Manual input
goes through the service so it observes the device claim. Releasing a claim ends
the driver session without erasing the device or terminating an unrelated
Simulator.app process. Device app data is device-scoped and may remain for the
next owner; it is not isolated like a browser profile. Exclusive claims coordinate
Switchboard agents, not independent Xcode or Simulator.app actions outside it.

Readiness checks explain missing Xcode, simulator runtimes/devices, Appium,
compatible XCUITest driver, or WebDriverAgent preparation. Missing iOS tooling
does not disable browser testing. The latest rollout check found no available
simulators; that must be checked again when implementation reaches live testing.

## Control, stop, and recovery

Each surface has agent-controlled, takeover-pending, human-controlled, stopped,
and failed states. All actions are serialized per surface. Taking control blocks
new agent mutations and lets the current bounded action settle before enabling
manual input. Pending agent mutations are rejected, not silently replayed later.
This pauses testing actions, not the agent's unrelated editing or reasoning.

Returning control increments the observation generation. Before another mutation,
the agent must obtain a fresh page or simulator observation. Closing a viewer
while human-controlled does not silently return control; show that state on the
session card and retain an explicit Return control action.

Stop revokes tool access, discards queued work, closes owned browser processes,
and releases simulator claims. Enforce a cleanup deadline and kill only tracked
owned children if graceful shutdown fails. Reset browser uses the same barrier
before deleting its exact managed profile and opening a clean one on demand.

On driver crash, timeout, or uncertain completion, return an actionable error.
Never automatically repeat a click, submission, install, or other mutation whose
outcome is unknown. A subsequent explicit retry starts with inspection. Browser
recovery can reopen its persistent profile but cannot restore unsaved page state.
Simulator recovery must reacquire a claim and verify the current device screen.

## Existing safety and compatibility boundaries

Preserve fixed Codex sandbox/approval policies, per-request Allow/Deny/Auto,
account-secret isolation, and repository configuration. Tool annotations must
accurately distinguish observation and mutation; they are not authorization.
Sidecars inherit no account environment secrets or NODE_OPTIONS. Profiles live
outside repositories in an app-managed directory with restrictive permissions,
and never enter handoff commits or transcripts.

The testing service is host-side: it must explicitly enforce applicable session
network and filesystem restrictions rather than assuming the provider sandbox
covers it. Retain the current Codex network-access availability gate; navigation
permits HTTP(S) only. Reject privileged browser schemes and prevent tested pages
from acquiring service credentials. Viewer/command routes require the existing
HTTP authentication plus origin/CSRF protections and session ownership checks.

Do not persist typed secrets, raw browser profiles, cookies, or console output
in Registry snapshots. Treat inspected page content as untrusted tool data.
Continue tool-detail redaction, size limits, lazy reads, and exclusion from SSE.
Screenshots and live frames may contain app data: deliver them only to their
intended session/viewer, without unconditional recording or frame logging.

Preserve repository MCP configuration and reserved-name collision behavior.
Advertise only capabilities supported by the installed runtime and session.
Keep legacy screenshot calls compatible, but route interactive-session simulator
captures through ownership checks so old entry points cannot bypass claims.
Legacy one-shot browser screenshots remain separate disposable captures.

## Delivery and verification

1. Prove the selected backends with disposable fixtures: persistent Chromium,
   live frames and manual input without restart; iOS inspection/tap/type and
   driver cleanup once a runtime is available. Pin tested dependency versions.
2. Build the shared ownership/control service and browser tools, integrating
   Claude and Codex app-server through session-bound adapters.
3. Deliver the browser panel and takeover controls as the first usable release.
4. Add iOS readiness, device claims, interaction tools, and simulator panel.

Do not make browser delivery wait for unavailable iOS runtimes. Record a blocked
iOS live check as incomplete rather than treating fake-driver tests as proof.

Offline tests cover cross-session denial, stale generations, claims, takeover
races, bounded queues, uncertain-result non-replay, stop/crash cleanup, profile
reset/deletion containment, secret redaction, configuration preservation, and
provider parity. Panel tests cover input ownership and coordinate mapping.
Use fake browser/driver boundaries in npm test. Run focused tests first and
the required full npm test before implementation completion. Manual live checks
use disposable local apps and verify each provider separately; real-account
turns stay outside the normal suite.

Acceptance requires two simultaneous browser sessions with different storage,
state-preserving Show/Hide, manual/agent handoff without concurrent input,
storage survival across stop/resume, and clean deletion. iOS acceptance requires
exclusive claims, visible busy handling, actual tap/swipe/type/launch results,
and release after stop or failure.

The multi-day app-server rollout soak remains tabled. This spec does not schedule
paid recurring tests, change default transport, or retire the SDK.

## References

- [Playwright persistent contexts and browser launch](https://playwright.dev/docs/api/class-browsertype)
- [Chromium page screen streaming](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-startScreencast)
- [Appium XCUITest device setup](https://github.com/appium/appium-xcuitest-driver/blob/master/docs/getting-started/device-setup.md)
- [Prior app-server parity scope](2026-08-11-codex-app-server-parity-design.md)

The prior parity spec excluded interactive tools from that earlier phase. This
document defines the newly approved phase; it does not retroactively broaden
the older implementation plans.
