# Capability discovery validation — 2026-09-10

Implemented live-session capability discovery for app-server Codex: skills,
apps, and MCP tools; availability reasons; refresh and invalidation; searchable
composer picker; server-side alias resolution with another check before dispatch.
Native paths and app identities remain out of the public catalog.

Validation:
- Focused catalog, supervisor, and adapter tests: 274 passed.
- Focused HTTP/catalog tests: 206 passed.
- Generated contract checked against installed Codex 0.153.4: passed.
- Full `npm test`: 1,129 passed, zero failures (57.1 seconds).
- Browser fixture: catalog opened; unavailable app disabled with explanation;
  search filtered entries; selecting a skill inserted its alias and focused the
  draft. Temporary browser tab and server were closed afterward.
- `node --check web/app.js` and `git diff --check`: passed.

A fixture assertion initially compared macOS /var and /private/var paths
literally. Canonicalizing its expected path fixed the assertion; the native
skill dispatch test now checks the real worktree path.

Scope limits: discovery is available after a live session starts. Pre-creation
discovery, compaction/built-in commands, screenshot sidecars, and the remaining
live sidecar integration gate are still roadmap items. This validation used
fake-account turns and an installed-binary schema check, not real-account tool
execution. The running user app was not restarted and transport defaults were
not changed.
