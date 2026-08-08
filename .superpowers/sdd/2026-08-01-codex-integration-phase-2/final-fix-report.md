# Codex Phase 2 final fix report

## Scope and baseline

- Worktree: `/Users/dwightbritton/Desktop/Switchboard/.worktrees/codex-integration-phase-2`
- Branch: `codex/codex-integration-phase-2`
- Reviewed parent: `e4f09399877b664d973f430966c5922ee0804eaa`
- Verified code commit: `e1753643ac375090e65c1ccf31fe054c3b70c53b`
- Code commit parent: `e4f09399877b664d973f430966c5922ee0804eaa`
- This report is committed separately as a child of the verified code commit; its SHA is necessarily recorded in the final handoff because a commit cannot contain its own identity.

The wave stayed within the final-review findings. Production remains on `@openai/codex-sdk`, with mandatory `workspace-write` / `never`, inherited configuration, macOS-only scope, and SDK-only app-server decision unchanged.

## Finding 1: concurrent resume and resume-versus-delete

### Root cause

`resume` checked `status === "stopped"`, then yielded through worktree `stat()` and Codex runtime preflight. Nothing reserved the Registry identity during those awaits. Two requests could therefore both launch and the second `handles.set()` could orphan the first live handle. A delete during preflight removed the Registry entry, but the captured session still launched afterward.

### RED

Two HTTP regressions use a real executable preflight gate:

- concurrent resume reached two preflights and both requests launched;
- delete completed during a gated preflight, after which the resume still returned 200 and launched.

Command:

```text
node --test test/server.test.ts
```

The focused RED run failed both threat sequences for the intended reasons (`two-preflights` and `200 == 409`).

### Fix and GREEN

`createServer` now owns an atomic per-session resume reservation. A duplicate is rejected before readiness work. After the final await and immediately before synchronous revival/launch, the server verifies:

- the same reservation token still owns the operation;
- the Registry still maps the ID to the same Session object;
- the Session is still stopped;
- no live handle exists.

The token is conditionally released in `finally`. No request can interleave between the final check, Registry revival, and synchronous handle installation.

Focused GREEN: 5/5 resume lifecycle tests, including both gated threat sequences.

## Finding 2: upload parent/leaf swap

### Root cause

The upload route used path observations (`lstat`) followed by yielding `mkdir` and path-following `writeFile`. A worktree process could replace `uploads/` or the leaf after validation, so the server opened/truncated an outside target.

### RED

A narrow injected write barrier pauses the real HTTP route at the former validation/write gap. Deterministic tests then:

- replace `uploads/` with an outside symlink and observe an outside file created;
- replace the leaf with an outside symlink and observe the outside sentinel truncated.

After adding only the diagnostic barrier, both tests failed at the actual security effect, including the forbidden empty-file side effect.

### Design and fix

Node on macOS exposes no stable `openat` API, and `/dev/fd/<directory-fd>/child` is not traversable on macOS. The implementation therefore removes every mutable worktree-relative parent component from the write:

- canonicalize and validate the fixed worktree root;
- generate a cryptographically unpredictable top-level storage name;
- create it with `O_CREAT | O_EXCL | O_NOFOLLOW`, mode `0600`;
- write only through the returned `FileHandle`;
- compare the pathname's post-write device/inode to the opened object and reject a replaced/unlinked leaf.

The trusted root is the session's dedicated Codex worktree. Under the mandatory `workspace-write` sandbox, the worker can mutate content below that root but cannot rename/replace the parent-owned root itself. Removing `uploads/` from the write path closes the parent swap without pretending final-component `O_NOFOLLOW` protects intermediate directories.

The browser receives the random relative path for the pending attachment. `resolveAgentPrompt` restores the original basename for transcript persistence/SSE while retaining the real relative path only for adapter delivery. Absolute paths remain adapter-only.

Focused GREEN: 5/5 upload tests. Parent swap creates no outside file; leaf swap leaves the outside sentinel unchanged and returns 409.

## Finding 3: mutable image path after verification

### Root cause

Prompt revalidation closed the contained file and returned its worktree pathname. The SDK reopened that mutable pathname later, so the bytes it consumed were not bound to the bytes/identity the server checked.

### RED

Regressions proved:

- no verified-byte snapshot boundary existed;
- success and failure left the SDK consuming the mutable original path;
- stop had no private snapshot lifecycle to clean.

### Design, lifecycle, and GREEN

Immediately before each dequeued Codex turn, `snapshotCodexPrompt`:

1. revalidates all attachment paths;
2. for every native image, records submitted `lstat` identity and canonical containment;
3. reopens with `O_RDONLY | O_NOFOLLOW` and compares opened device/inode to the contained object before reading;
4. validates PNG/JPEG/WebP magic against the exact read bytes;
5. writes those exact bytes to a mode-`0600` file inside an unguessable `mkdtemp` directory;
6. passes only that private snapshot path to SDK `local_image`.

The snapshot object has idempotent cleanup. The adapter wraps the SDK turn in `finally`, covering success, SDK/start/stream failure, stop/abort, and a stop that arrives while preparation is in flight. Queued prompts allocate no snapshots until they are dequeued; stopped queued prompts remain unsent. A multi-image preparation failure cleans already-created siblings. Ordinary files remain worktree-relative text references.

The fake SDK boundary now reads and records image bytes at invocation time, allowing assertions on exact native PNG/JPEG/WebP bytes after snapshot cleanup. Focused GREEN: 43/43 prompt/adapter tests, including success, failure, stop, queued source swap, privacy, and idempotent cleanup.

## Finding 4: launch-environment values at public boundaries

### Root cause

The final server sanitizer handled append-only messages and stopped reasons, but passed every `upsert-msg` unchanged. Adapter-local redaction only substituted values whose environment keys looked credential-shaped. Create/resume preflight responses also used that key-filtered redactor. A long value under an ordinary launch key could therefore reach Registry state, SSE metadata, lazy detail, reasoning, todos, and preflight errors.

### RED

Real fake-SDK events put a long ordinary-key value into command/MCP names, summaries and detail, reasoning, todos, and file-change data. Separate create and resume preflight executables echoed the same class of value. RED exposed the value in all three boundary tests.

### Fix and GREEN

At the final pre-Registry boundary, every string-bearing Codex upsert is now copied and sanitized while stable item IDs remain untouched:

- tool `name`, `summary`, and `detail`;
- reasoning `text`;
- every todo item's `text`.

Detail is passed through the 32 KiB safety cap again after substitution, because replacing a six-byte value with `[REDACTED]` can increase byte length. Create and resume preflight errors use the same final account-value sanitizer before response or Registry admission.

The existing `redactable` floor is preserved: values of six or more characters are substituted regardless of key shape; trivial short flags remain unchanged so values such as `1` or `info` do not shred ordinary output. Vendor session IDs remain unmodified so resume identity stays stable.

Focused GREEN: 7/7 redaction tests across Registry state, persisted JSON, SSE, `/detail`, both preflight routes, short-value semantics, and vendor-session resume.

## Deferred `lastUsage` regression

The reviewed implementation already replaces the object rather than merging it. The new regression applies a full usage event, then a basic input/output-only event, and asserts all prior cache/reasoning optionals disappear.

Because the base behavior was already correct, a mutation check temporarily reintroduced merging. The new test failed with all three stale optional fields present. Restoring the reviewed replacement logic returned the test to GREEN. No production change was needed.

## Exact files

Production:

- `src/agents/codex.ts`
- `src/prompt-input.ts`
- `src/server.ts`
- `src/upload.ts` (new)

Tests/test fixtures:

- `test/agents-codex-process.test.ts`
- `test/helpers/fake-codex.ts`
- `test/prompt-input.test.ts`
- `test/server.test.ts`
- `test/sessions.test.ts`

Report:

- `.superpowers/sdd/2026-08-01-codex-integration-phase-2/final-fix-report.md`

## Verification evidence

- Focused resume GREEN: 5/5.
- Focused upload GREEN: 5/5.
- Focused image/prompt GREEN: 43/43.
- Focused redaction GREEN: 7/7.
- Deferred usage mutation RED, restored GREEN: 1/1.
- Full server suite: 56/56.
- Task 9 security/persistence command:

  ```text
  node --test test/codex-detail.test.ts test/server.test.ts test/agents-codex-process.test.ts test/prompt-input.test.ts
  ```

  Exit 0.

- Full required suite: `npm test` — 301 tests, 301 pass, 0 fail.
- Real no-turn evaluator: `npm run evaluate:codex-app-server` — exit 0 with Codex 0.145.0, schema generated, initialized, auth state readable without refresh, and clean shutdown. Lifecycle/turn fields remained false, proving the no-turn boundary. The restricted first attempt could not launch/read the configured local runtime; the required escalated local-runtime run passed.
- Worktree `accounts.json` was absent. A temporary symlink to the requested existing account file was created without reading/printing it, removed immediately after evaluation, and confirmed absent.
- Security scans found no production `danger-full-access`, `experimentalApi`, `ws://`, or `wss://`; the only `experimentalApi` hit is the fake evaluator's assertion that it is omitted.
- HTML scan found only comments explaining `textContent`; no `innerHTML` or `insertAdjacentHTML` sink.
- No `TODO`, `TBD`, or `FIXME` markers in the scoped production/test/docs paths.
- No test secret sentinel in `src`, `web`, `README.md`, or `AGENTS.md`.
- No leftover `switchboard-codex-image-*` snapshot directory.
- `git diff --check` exited 0.

## Self-review

- Resume reservation cleanup covers success, readiness error, adapter start throw, duplicate request, and Registry deletion.
- Snapshot cleanup covers all dequeued-turn outcomes; condition-based tests wait for cleanup after terminal status rather than assuming status emission and `finally` are atomic.
- The upload write does not touch the attacker-controlled legacy `uploads/` directory; a pre-existing symlink there is still rejected for compatibility/defense-in-depth.
- Random upload storage paths remain relative and are not persisted or rendered; original basename-only attachment state is preserved.
- Final redaction happens after provider normalization and before every Registry application, so adapter-local omissions cannot cross state/SSE/detail boundaries.
- Detail remains omitted from SSE, globally/per-item bounded, and lazy ID-keyed.
- No sandbox/approval/configuration or app-server transport decision changed.

## Concerns

No known correctness or security concern remains in the reviewed scope. The deterministic upload barrier is an optional internal server-construction hook used only by offline tests; production does not supply it. As before, an operating-system process running outside the mandated Codex sandbox and with the same user authority could attack parent-owned paths or temp storage; that is outside the fixed `workspace-write` worker threat boundary.
