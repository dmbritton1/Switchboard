# Screenshot support validation — 2026-09-10

Browser and simulator capture handlers now live in provider-neutral modules.
Claude wrappers and MCP 1.30.0 stdio sidecars use the same handlers. Each sidecar
advertises only `screenshot` and returns PNG image content or a tool error.

The supervisor reads effective worktree configuration before thread start/resume
and adds only nonconflicting Switchboard MCP keys through the protocol config
map. It preserves fixed sandbox/approval policy and honors explicit session
network settings. Read failure skips optional injection and gives a catalog
warning. The sidecars start through `/usr/bin/env -i` with fixed PATH, local HOME,
absolute Node/entrypoint paths, and no account launch environment.

Verification performed:
- Real stdio MCP tests capture images through fake Chrome/xcrun and reject invalid
  URL/device inputs. A parent secret sentinel must not reach either capture child.
- Focused capture/config tests: 19 passed.
- Claude wrapper regression tests after callback correction: 51 passed.
- Supervisor/config policy tests: 95 passed.
- Installed Codex 0.153.4 disposable thread (temporary CODEX_HOME, no model turn):
  both `switchboard_browser.screenshot` and `switchboard_simulator.screenshot`
  reported available. Startup invalidation was handled by refreshing the probe.
- Actual installed Chrome captured a local fixture page: valid 32,271-byte PNG.
  The fixture HTTP server and throwaway browser profile were cleaned up.

No real-account model turn or real simulator capture was used. Simulator image
transport was verified with fake xcrun. No target repository configuration was
written. Pre-creation discovery and compaction remain separate roadmap work.

Final verification: `npm test` passed all 1,134 tests with zero failures in
106.8 seconds after the final Claude callback fix. `git diff --check` passed.
Switchboard was restarted with the tested code and its HTTP page verified at
127.0.0.1:4711. Sessions were stopped through the local API before restarting;
they can be resumed manually.
