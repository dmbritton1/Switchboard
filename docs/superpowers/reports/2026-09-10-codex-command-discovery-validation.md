# Command and preview discovery validation — 2026-09-10

Codex app-server sessions now expose skill, app, and MCP aliases through the
slash picker, alongside `/compact`, `/skills`, `/apps`, and `/mcp`. Installed
plugin-provided capabilities are included through the same stable discovery APIs.
Claude retains its startup-reported command inventory.

New-session preview validates account transport and canonical Git directory,
then reads skills and account apps without creating a thread. It intentionally
does not query process-global MCP tools: those can belong to another repository.
Live session discovery supplies actual MCP/screenshot availability.

`/compact` uses `thread/compact/start` with its empty acknowledgment and separate
turn lifecycle. It holds queued prompts until terminal completion, supports Stop,
and bounds missing start notifications to ten seconds before retiring the failed
transport generation. Whitespace is normalized for command recognition. Arguments
and attachments are rejected before transcript admission.

Verification:
- Adapter/contract suite: 229 passed before final edge-case additions.
- Preview/supervisor/provider/UI integration: 120 passed.
- UI review: 138 passed, including actual refresh-handler and keyboard regressions
  for failed refreshes, disabled commands, and removed selections.
- Compaction/preview edge tests: 5 passed, including early/late notifications,
  queued prompts, Stop, missing notifications, and leading whitespace.
- Installed Codex 0.153.4 generated turn contract verified, including compaction.
  No real account compaction or model turn was started during validation.

Final verification: `npm test` passed 1,149 tests with zero failures in 93.6
seconds after the final edge-case fixes. `git diff --check` passed. All sessions
were confirmed stopped before restarting Switchboard. The restarted server
served `codex-commands.js` with HTTP 200, and the browser rendered the account
meters, enabled New/Settings controls, and stopped-session grid successfully.
Sessions remain stopped and can be resumed manually.
