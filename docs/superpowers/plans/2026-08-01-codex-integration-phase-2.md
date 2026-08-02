# Switchboard Codex Integration Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a richer, still-safe Codex experience to the Phase 1 integration: live item lifecycles, bounded details, reasoning summaries and todos, native local-image input, inherited-by-default thread settings, reliable usage detail, and a conclusive app-server approval evaluation.

**Architecture:** Build on the prepared-runtime SDK adapter and durable Registry delivered by Phase 1. Normalize rich Codex data into provider-neutral persisted messages before it reaches SSE, resolve attachments at the server trust boundary, and keep explicit Codex settings separate from mandatory safety overrides. App-server remains an isolated stdio prototype and decision record; it does not become a production transport in this plan.

**Tech Stack:** Node.js 22.18+ with native TypeScript execution, `node:test`, the post-Phase-1 pinned `@openai/codex-sdk` and SDK-bundled Codex CLI, Node HTTP/SSE, browser ES modules, JSONL/JSON-RPC for the evaluation prototype, and git worktrees on macOS.

## Global Constraints

- Do not begin Task 1 until Task 0 passes against the completed Phase 1 tree. The current pre-Phase-1 source is not a valid execution baseline for this plan.
- Keep the production transport on `@openai/codex-sdk` throughout this plan. App-server work is a bounded prototype plus decision record only.
- Keep production `sandboxMode: 'workspace-write'` and `approvalPolicy: 'never'`. Never expose `danger-full-access`, silently broaden filesystem access, or enable network access without an explicit persisted setting.
- Preserve `CODEX_HOME`, global and repository Codex configuration, `AGENTS.md`, skills, MCP configuration, and every omitted setting as inherited.
- Keep the integration intentionally macOS-only.
- Normal `npm test` must remain hermetic: no OpenAI calls, paid turns, real login changes, or reads/writes under the user's real `~/.codex`.
- Redact and truncate tool detail before Registry persistence or SSE delivery. The maximum persisted detail is exactly 32 KiB in UTF-8, including the visible truncation marker.
- Display reasoning summaries only. Never request, persist, or render hidden/raw chain-of-thought content.
- Treat all tool output, MCP arguments/results, paths, filenames, settings, and model-provided text as untrusted browser text. Render with `textContent`, not HTML injection.
- Resolve every attachment on the server. Absolute attachment paths are adapter-only data and must never enter `state.json`, SSE, or the browser transcript.
- Omitted Codex settings mean inherit. Do not materialize SDK, user, or repository defaults into session state.
- App-server evaluation uses stable stdio JSONL and generated version-matched schemas. Do not use the experimental WebSocket transport or opt into `experimentalApi`.
- Preserve pre-existing unrelated worktree changes and untracked files. Stage only files named by the active task.
- Current official references, to be refreshed in Task 0: <https://developers.openai.com/codex/sdk/> and <https://developers.openai.com/codex/app-server/>.

---

### Task 0: Verify the Phase 1 baseline and freeze Phase 2 compatibility assumptions

**Files:**
- Create: `docs/superpowers/reports/2026-08-01-codex-phase-2-compatibility.md`
- Modify only if the gate finds a real mismatch: `docs/superpowers/plans/2026-08-01-codex-integration-phase-2.md`

**Interfaces:**

Phase 2 expects these Phase 1 contracts to exist with equivalent behavior:

```ts
prepareCodexRuntime(account): Promise<PreparedCodexRuntime>
createCodexAdapter(runtime: PreparedCodexRuntime): Adapter
Registry.appendPrompt(sessionId, text, delivery): string
AgentHandle.send(text, promptId?): void
type PromptDelivery = 'queued' | 'sent' | 'unsent'
type Session = { stoppedCode: CodexFailureCode | null }
```

The exact post-Phase-1 signatures are authoritative. If they differ, update this plan's interface blocks consistently before Task 1; do not create compatibility shims solely to preserve planning prose.

- [ ] **Step 1: Prove Phase 1 is complete before inspecting Phase 2**

Run:

```bash
npm test
git status --short
rg -n "prepareCodexRuntime|createCodexAdapter|PromptDelivery|stoppedCode|appendPrompt" src test
rg -n "CODEX_BIN|/Applications/ChatGPT.app/Contents/Resources/codex" src
```

Expected: `npm test` exits 0; the Phase 1 runtime, adapter factory, delivery, failure, process, and browser tests exist; the second `rg` returns no hardcoded adapter binary. If any check fails, stop and finish Phase 1 before continuing.

- [ ] **Step 2: Record the installed SDK and CLI surface without running a model turn**

Run:

```bash
npm ls @openai/codex-sdk @openai/codex
rg -n "ItemStartedEvent|ItemUpdatedEvent|ItemCompletedEvent|local_image|modelReasoningEffort|webSearchMode|networkAccessEnabled" node_modules/@openai/codex-sdk/dist/index.d.ts
node_modules/.bin/codex --version
```

Expected: the SDK and bundled CLI published versions match; the installed SDK exposes item lifecycle events, `local_image`, and every optional thread field used below. At plan authoring, all are present in 0.145.0.

- [ ] **Step 3: Refresh the official transport evidence**

Review the current Codex SDK and app-server documentation linked in Global Constraints. Confirm and record:

- TypeScript SDK start, continue, resume, streaming, local images, and thread options;
- app-server stable stdio transport and version-specific `generate-ts` support;
- stable command/file approval requests and decisions;
- whether any newly documented TypeScript SDK approval callback makes an app-server evaluation unnecessary;
- which app-server fields remain experimental.

Do not copy secrets, account email, complete environment values, or generated schema bundles into the report.

- [ ] **Step 4: Write the compatibility report**

Create `docs/superpowers/reports/2026-08-01-codex-phase-2-compatibility.md` with exactly these sections:

```markdown
# Codex Phase 2 compatibility report

## Phase 1 gate
PASS or FAIL, the `npm test` total, and the verified Phase 1 interface names.

## Installed runtime
SDK version, bundled CLI version, platform, and supported SDK fields.

## Official surface
SDK capabilities, app-server stable capabilities, and experimental exclusions.

## Plan adjustments
List exact signature/path changes made to the Phase 2 plan, or state "None."

## Decision
PASS only when Tasks 1-9 can execute against the observed interfaces.
```

A FAIL report blocks every later task. Do not weaken a safety or test requirement to force PASS.

- [ ] **Step 5: Commit the compatibility lock**

```bash
git add docs/superpowers/reports/2026-08-01-codex-phase-2-compatibility.md docs/superpowers/plans/2026-08-01-codex-integration-phase-2.md
git commit -m "docs: lock Codex phase 2 compatibility"
```

---

### Task 1: Add bounded detail types and Registry upserts

**Files:**
- Create: `src/agents/codex-detail.ts`
- Create: `test/codex-detail.test.ts`
- Modify: `src/types.ts`
- Modify: `src/sessions.ts`
- Modify: `test/sessions.test.ts`

**Interfaces:**

Add these message and event contracts in `src/types.ts`:

```ts
export type ToolMsg = {
  kind: 'tool';
  id?: string;
  name: string;
  summary: string;
  status: 'running' | 'ok' | 'error';
  detail?: string;
  detailTruncated?: boolean;
};

export type ReasoningMsg = { kind: 'reasoning'; id: string; text: string };
export type TodoMsg = {
  kind: 'todo';
  id: string;
  items: { text: string; completed: boolean }[];
};

export type UpsertMsg =
  | (ToolMsg & { id: string })
  | ReasoningMsg
  | TodoMsg;
```

Add `{ type: 'upsert-msg'; msg: UpsertMsg }` to `AdapterEvent`. Keep the existing `msg` event for append-only user, assistant, and error messages.

Create this sanitizer contract:

```ts
export const MAX_CODEX_DETAIL_BYTES = 32 * 1024;
export type SafeDetail = { text: string; truncated: boolean };

export function safeCodexDetail(
  value: unknown,
  env: Record<string, string>,
  maxBytes?: number,
): SafeDetail | null;
```

- [ ] **Step 1: Write failing detail-sanitizer tests**

Create `test/codex-detail.test.ts` with these cases:

```ts
test('safeCodexDetail redacts credential keys and launch-environment values', () => {
  const detail = safeCodexDetail({
    command: 'curl -H "Authorization: Bearer abcdefghijklmnop"',
    apiKey: 'visible-key',
    nested: { password: 'hunter2', ordinary: 'keep me' },
  }, { OPENAI_API_KEY: 'visible-key', PRIVATE_TOKEN: 'hunter2' })!;

  assert.doesNotMatch(detail.text, /abcdefghijklmnop|visible-key|hunter2/);
  assert.match(detail.text, /\[REDACTED\]/);
  assert.match(detail.text, /keep me/);
});

test('safeCodexDetail caps valid UTF-8 including its marker', () => {
  const detail = safeCodexDetail('🙂'.repeat(20_000), {}, 1024)!;
  assert.equal(Buffer.byteLength(detail.text, 'utf8') <= 1024, true);
  assert.equal(detail.truncated, true);
  assert.match(detail.text, /\n\[truncated\]$/);
  assert.doesNotMatch(detail.text, /�/);
});
```

Also cover null/undefined, plain strings, stable indented JSON for objects, circular data, Bearer credentials, OpenAI-style `sk-` secrets, and a value below the limit.

- [ ] **Step 2: Run the sanitizer tests and confirm failure**

```bash
node --test test/codex-detail.test.ts
```

Expected: FAIL because `src/agents/codex-detail.ts` does not exist.

- [ ] **Step 3: Implement recursive redaction and UTF-8-safe truncation**

Use a `JSON.stringify` replacer with a `WeakSet`. Replace values whose key matches `/token|api[_-]?key|secret|password|authorization|cookie|credential/i`, pass the serialized text through the Phase 1 public-text redactor for environment values and Bearer credentials, then redact OpenAI-style `/\bsk-[A-Za-z0-9_-]{16,}\b/g` values locally.

Truncate the UTF-8 buffer to leave room for `\n[truncated]`. Repeatedly remove a trailing replacement character after decoding the sliced buffer. The returned text, including the marker, must never exceed `maxBytes`.

- [ ] **Step 4: Write failing Registry upsert tests**

Add to `test/sessions.test.ts`:

```ts
test('upsert-msg keeps one lifecycle row per kind and id', () => {
  const { reg, id } = make();
  reg.apply(id, { type: 'upsert-msg', msg: {
    kind: 'tool', id: 'item-1', name: 'shell', summary: 'npm test', status: 'running',
  } });
  reg.apply(id, { type: 'upsert-msg', msg: {
    kind: 'tool', id: 'item-1', name: 'shell', summary: 'npm test', status: 'ok',
    detail: '84 tests passed', detailTruncated: false,
  } });

  assert.deepEqual(reg.get(id)!.transcript, [{
    kind: 'tool', id: 'item-1', name: 'shell', summary: 'npm test', status: 'ok',
    detail: '84 tests passed', detailTruncated: false,
  }]);
});
```

Also test different IDs, a tool and todo sharing the same ID, reasoning replacement, todo replacement, and legacy `msg` append behavior.

- [ ] **Step 5: Implement Registry upserts**

In `Registry.apply()`, find an existing transcript entry only when both `kind` and `id` match. Replace it in place to preserve transcript order; append when absent. Never merge fields from an old item into a terminal item.

- [ ] **Step 6: Run focused and full tests**

Run:

```bash
node --test test/codex-detail.test.ts test/sessions.test.ts
npm test
```

Expected: sanitizer and upsert tests pass; legacy state and Claude behavior remain green.

- [ ] **Step 7: Commit bounded detail storage**

```bash
git add src/agents/codex-detail.ts src/types.ts src/sessions.ts test/codex-detail.test.ts test/sessions.test.ts
git commit -m "feat: add bounded Codex transcript details"
```

---

### Task 2: Normalize the full SDK item lifecycle

**Files:**
- Modify: `src/agents/codex.ts`
- Modify: `test/agents-codex.test.ts`
- Modify: `test/helpers/fake-codex.ts`
- Modify: `test/agents-codex-process.test.ts`

**Interfaces:**

Keep a pure exported normalizer with the prepared launch environment available for redaction:

```ts
export function normalizeCodex(
  event: ThreadEvent,
  env?: Record<string, string>,
): AdapterEvent[];
```

Lifecycle mapping is exact:

- command, file-change, MCP, and web-search `item.started`/`item.updated`/`item.completed` emit `upsert-msg` with the SDK item ID;
- SDK `in_progress` maps to `running`, `completed` to `ok`, and `failed` to `error`;
- agent messages and error items remain append-only and emit only from `item.completed`;
- reasoning emits `ReasoningMsg` from its SDK summary text;
- todo lists emit `TodoMsg` and replace the same ID as completion changes;
- unknown event/item types remain nonfatal and development-only diagnostics contain the type, never payload data.

- [ ] **Step 1: Write failing lifecycle normalization tests**

Add a table in `test/agents-codex.test.ts` that sends started, updated, and completed versions of one command item and expects:

```ts
[
  { type: 'upsert-msg', msg: {
    kind: 'tool', id: 'cmd-1', name: 'shell', summary: 'npm test', status: 'running',
  } },
  { type: 'upsert-msg', msg: {
    kind: 'tool', id: 'cmd-1', name: 'shell', summary: 'npm test', status: 'running',
    detail: 'running output', detailTruncated: false,
  } },
  { type: 'upsert-msg', msg: {
    kind: 'tool', id: 'cmd-1', name: 'shell', summary: 'npm test', status: 'ok',
    detail: 'all passed', detailTruncated: false,
  } },
]
```

Add equivalent focused cases for failed commands, file changes, MCP arguments/result/error, web search, reasoning text, todo completion, completed assistant text, and completed errors. Assert started/updated assistant messages produce no transcript message.

- [ ] **Step 2: Run normalization tests and confirm failure**

```bash
node --test test/agents-codex.test.ts
```

Expected: FAIL because Phase 1 ignores started/updated items and has no rich message kinds.

- [ ] **Step 3: Implement item-phase normalization**

Add a helper that receives `phase: 'started' | 'updated' | 'completed'` and one `ThreadItem`. For command detail use `aggregated_output`; for file detail use `{ changes }`; for MCP detail use `{ arguments, result, error }`. Pass every detail through `safeCodexDetail()` before constructing an event.

Do not store raw reasoning beyond the SDK's `ReasoningItem.text`, which the installed TypeScript SDK documents as its reasoning summary. Do not fabricate a running status for reasoning or todo messages.

- [ ] **Step 4: Extend the fake CLI and process tests**

Add a `rich-lifecycle` fake prompt that emits:

- one command item through started, updated, and completed with the same ID;
- an MCP call whose arguments contain a fake token and whose result exceeds 32 KiB;
- a file change and web search;
- reasoning and todo updates;
- one completed assistant message and turn usage.

In `test/agents-codex-process.test.ts`, apply emitted events to a real Registry and assert one row per item ID, terminal status, redacted detail, truncation marker, distinct reasoning/todo messages, and no duplicate assistant text.

- [ ] **Step 5: Run focused and full tests**

```bash
node --test test/agents-codex.test.ts test/agents-codex-process.test.ts test/sessions.test.ts
npm test
```

Expected: live events update one persisted item each and every detail is bounded before Registry application.

- [ ] **Step 6: Commit rich SDK normalization**

```bash
git add src/agents/codex.ts test/agents-codex.test.ts test/helpers/fake-codex.ts test/agents-codex-process.test.ts
git commit -m "feat: stream Codex item lifecycles"
```

---

### Task 3: Render live tools, bounded details, reasoning, and todos

**Files:**
- Modify: `web/lib.js`
- Modify: `web/app.js`
- Modify: `web/style.css`
- Modify: `test/ui.test.ts`

**Interfaces:**

Add a DOM-free view projection in `web/lib.js`:

```ts
type TranscriptView =
  | { kind: 'tool'; className: string; summary: string; detail?: string; truncated: boolean }
  | { kind: 'reasoning'; className: string; summary: string }
  | { kind: 'todo'; className: string; items: { text: string; completed: boolean }[] }
  | { kind: 'text'; className: string; summary: string };

declare function transcriptView(message: Msg): TranscriptView;
```

The returned strings remain untrusted. `web/app.js` must assign them with `textContent`.

- [ ] **Step 1: Write failing transcript projection tests**

Add to `test/ui.test.ts`:

```ts
test('transcriptView projects a running tool with collapsible detail', () => {
  assert.deepEqual(transcriptView({
    kind: 'tool', id: 'c1', name: 'shell', summary: 'npm test', status: 'running',
    detail: 'working...', detailTruncated: false,
  }), {
    kind: 'tool', className: 'msg tool running',
    summary: 'shell: npm test', detail: 'working...', truncated: false,
  });
});

test('transcriptView keeps reasoning and todos distinct from tools', () => {
  assert.equal(transcriptView({ kind: 'reasoning', id: 'r1', text: 'Checking the failing path.' }).kind, 'reasoning');
  assert.deepEqual(transcriptView({
    kind: 'todo', id: 't1', items: [{ text: 'Run tests', completed: true }],
  }).items, [{ text: 'Run tests', completed: true }]);
});
```

Also cover terminal tool labels, truncated detail, assistant/error/user messages, and no-detail tools.

- [ ] **Step 2: Run UI tests and confirm failure**

```bash
node --test test/ui.test.ts
```

Expected: FAIL because `transcriptView` is not exported.

- [ ] **Step 3: Implement the pure projection**

Use these labels:

- running tool: no terminal suffix;
- ok tool: ` · ok`;
- error tool: ` · error`;
- reasoning: `Reasoning summary` plus the summary text;
- todo: one row per item, `✓` for complete and `○` for pending.

Do not include prompt IDs, item IDs, absolute paths added by the adapter, or raw object serialization in the projection.

- [ ] **Step 4: Implement safe DOM rendering**

Refactor `renderChatPane()` to consume `transcriptView()`:

- tool summary remains the visible row;
- when detail exists, append `<details><summary>Details</summary><pre></pre></details>` and assign the detail with `pre.textContent`;
- reasoning uses a visually secondary block labelled `Reasoning summary`;
- todo uses a semantic `<ul>` with complete/pending classes;
- ordinary text, user, prompt-delivery, and error rendering from Phase 1 remains intact;
- preserve the current near-bottom scroll behavior during rapid updates.

- [ ] **Step 5: Add focused styling**

Add styles for `.tool details`, `.tool pre`, `.msg.reasoning`, `.msg.todo`, `.todo-complete`, and `.todo-pending`. Detail must wrap long lines, use a bounded viewport, and remain collapsed by default.

- [ ] **Step 6: Run focused and full tests**

Run:

```bash
node --test test/ui.test.ts
npm test
```

Expected: projections pass and all browser helper tests remain green.

- [ ] **Step 7: Commit rich transcript rendering**

```bash
git add web/lib.js web/app.js web/style.css test/ui.test.ts
git commit -m "feat: render rich Codex transcript events"
```

---

### Task 4: Resolve secure prompt attachments and send native images

**Files:**
- Create: `src/prompt-input.ts`
- Create: `test/prompt-input.test.ts`
- Modify: `src/types.ts`
- Modify: `src/server.ts`
- Modify: `src/agents/codex.ts`
- Modify: `src/agents/claude.ts`
- Modify: `test/server.test.ts`
- Modify: `test/agents-codex-process.test.ts`
- Modify: `test/agents-claude.test.ts`

**Interfaces:**

Replace the adapter's string-only prompt with:

```ts
export type PromptAttachment = {
  name: string;
  relativePath: string;
  absolutePath: string;
  kind: 'image' | 'file';
};

export type AgentPrompt = {
  text: string;
  attachments: PromptAttachment[];
};

export type StartOpts = {
  cwd: string;
  prompt: AgentPrompt;
  promptId?: string;
  env: Record<string, string>;
  resumeId?: string;
  auto?: boolean;
};

export type AgentHandle = {
  send(prompt: AgentPrompt, promptId?: string): void;
  decide(allow: boolean): void;
  setAuto(on: boolean): void;
  stop(): void;
};
```

Create the server trust-boundary function:

```ts
export async function resolveAgentPrompt(
  cwd: string,
  text: string,
  attachmentPaths: unknown,
): Promise<AgentPrompt>;
```

- [ ] **Step 1: Write failing attachment-resolution tests**

Create `test/prompt-input.test.ts` using only temporary directories. Cover:

```ts
test('resolveAgentPrompt classifies a real PNG inside the worktree', async (t) => {
  const fixture = await promptFixture(t);
  await writeFile(join(fixture.cwd, 'uploads', 'screen.png'), PNG_BYTES);

  const prompt = await resolveAgentPrompt(fixture.cwd, 'Inspect this screenshot', ['uploads/screen.png']);

  assert.deepEqual(prompt.attachments[0], {
    name: 'screen.png', relativePath: 'uploads/screen.png',
    absolutePath: join(fixture.cwd, 'uploads', 'screen.png'), kind: 'image',
  });
});
```

Also test JPEG and WebP signatures, ordinary files, missing files, absolute paths, `..` traversal, symlinked file, symlinked parent, directory, extension/signature mismatch, non-array input, non-string entries, duplicate paths, and more than 10 attachments.

- [ ] **Step 2: Run prompt-input tests and confirm failure**

```bash
node --test test/prompt-input.test.ts
```

Expected: FAIL because `src/prompt-input.ts` does not exist.

- [ ] **Step 3: Implement containment and image classification**

Require zero to ten unique relative paths. Resolve both the worktree and candidate through `realpath()`, reject any candidate whose relative path from the real worktree is empty, absolute, or starts with `..`, and require `lstat().isFile()` with no symlink at the submitted path.

Classify images only when extension and magic bytes agree:

- `.png`: `89 50 4e 47 0d 0a 1a 0a`;
- `.jpg`/`.jpeg`: `ff d8 ff`;
- `.webp`: `RIFF` at bytes 0-3 and `WEBP` at bytes 8-11.

All other files remain `kind: 'file'`. Return safe public names and relative paths plus adapter-only absolute paths.

- [ ] **Step 4: Convert provider adapters to `AgentPrompt`**

For Claude, render the text followed by every attachment's relative path; behavior remains path-based.

For Codex, build SDK `Input` as follows:

```ts
const files = prompt.attachments.filter((a) => a.kind === 'file');
const images = prompt.attachments.filter((a) => a.kind === 'image');
const text = [
  prompt.text,
  ...files.map((a) => `Attached file: ${a.relativePath}`),
].filter(Boolean).join('\n');
const input: Input = images.length
  ? [{ type: 'text', text }, ...images.map((a) => ({ type: 'local_image' as const, path: a.absolutePath }))]
  : text;
```

Keep FIFO prompt IDs/delivery from Phase 1 unchanged. The fake CLI invocation log must record `--image` arguments as test-owned paths.

- [ ] **Step 5: Integrate server commands without persisting absolute paths**

For `send`, resolve attachments before `Registry.appendPrompt()` or `handle.send()`. A validation error returns HTTP 400 and appends nothing. Persist only attachment names on the user message:

```ts
type UserMsg = {
  kind: 'user'; id: string; text: string; delivery: PromptDelivery;
  attachments?: string[];
};
```

Pass the full `AgentPrompt` only to the live adapter. Initial create and resume prompts use `{ text, attachments: [] }`.

- [ ] **Step 6: Add server and adapter integration coverage**

Test that:

- Codex sends PNG/JPEG/WebP through real SDK `--image` arguments;
- non-image files appear in stdin text, not `--image`;
- Claude receives every attachment as a relative text reference;
- escaped/missing/symlinked paths never call the handle or append a prompt;
- state and SSE include attachment names but no absolute attachment path;
- resume never replays old attachments.

Run:

```bash
node --test test/prompt-input.test.ts test/server.test.ts test/agents-codex-process.test.ts test/agents-claude.test.ts
npm test
```

Expected: all attachment security and provider-delivery cases pass offline.

- [ ] **Step 7: Commit structured prompt input**

```bash
git add src/prompt-input.ts src/types.ts src/server.ts src/agents/codex.ts src/agents/claude.ts test/prompt-input.test.ts test/server.test.ts test/agents-codex-process.test.ts test/agents-claude.test.ts
git commit -m "feat: send Codex images as structured input"
```

---

### Task 5: Add pending-attachment browser state

**Files:**
- Modify: `web/index.html`
- Modify: `web/app.js`
- Modify: `web/lib.js`
- Modify: `web/style.css`
- Modify: `test/ui.test.ts`

**Interfaces:**

Add DOM-free helpers:

```js
export function addAttachment(list, attachment) {
  return list.some((item) => item.path === attachment.path)
    ? list
    : [...list, attachment];
}

export function removeAttachment(list, path) {
  return list.filter((item) => item.path !== path);
}

export function sendPayload(sessionId, text, attachments) {
  return {
    cmd: 'send', id: sessionId, text,
    attachments: attachments.map((item) => item.path),
  };
}
```

`addAttachment` deduplicates by relative path and preserves order. `sendPayload` returns `{ cmd: 'send', id, text, attachments: string[] }`.

- [ ] **Step 1: Write failing attachment-state tests**

Add to `test/ui.test.ts`:

```ts
test('attachment helpers deduplicate, remove, and build a path-only request', () => {
  const first = addAttachment([], { name: 'screen.png', path: 'uploads/screen.png' });
  const duplicate = addAttachment(first, { name: 'screen.png', path: 'uploads/screen.png' });
  assert.equal(duplicate.length, 1);
  assert.deepEqual(sendPayload('s1', 'inspect it', duplicate), {
    cmd: 'send', id: 's1', text: 'inspect it', attachments: ['uploads/screen.png'],
  });
  assert.deepEqual(removeAttachment(duplicate, 'uploads/screen.png'), []);
});
```

- [ ] **Step 2: Run UI tests and confirm failure**

```bash
node --test test/ui.test.ts
```

Expected: FAIL because the attachment helpers do not exist.

- [ ] **Step 3: Implement pending attachment chips**

Add `<div id="attachments" aria-live="polite"></div>` above the composer. Keep `pendingAttachments` in `web/app.js`, scoped to `openId`; clear it on a real session change.

After `/upload` succeeds, add `{ name, path }` to pending state instead of inserting the path into the prompt textbox. Render one chip per attachment with its filename and a remove button. Assign all names with `textContent`.

- [ ] **Step 4: Send and clear attachments transactionally**

The composer may submit when trimmed text is nonempty. Await the Phase 1 command helper with `sendPayload()`. Clear the text and pending attachments only after HTTP success; retain both on a non-2xx or network failure so the user can retry.

Disable the Send button while uploads or send are in flight. Preserve upload errors until retry, dismiss, or session change.

- [ ] **Step 5: Render transcript attachment names**

For a user message with `attachments`, append a secondary `Attachments: name1, name2` line. Never display stored relative or absolute paths as the attachment label.

- [ ] **Step 6: Verify the attachment UI**

```bash
node --test test/ui.test.ts
npm test
```

Expected: UI helper and full tests pass; attachments survive failed sends and clear only after acceptance.

- [ ] **Step 7: Commit attachment UI state**

```bash
git add web/index.html web/app.js web/lib.js web/style.css test/ui.test.ts
git commit -m "feat: add structured attachment composer state"
```

---

### Task 6: Add inherited-by-default Codex thread settings

**Files:**
- Create: `src/agents/codex-settings.ts`
- Create: `test/codex-settings.test.ts`
- Modify: `src/types.ts`
- Modify: `src/sessions.ts`
- Modify: `src/server.ts`
- Modify: `src/agents/codex.ts`
- Modify: `web/index.html`
- Modify: `web/app.js`
- Modify: `web/lib.js`
- Modify: `web/style.css`
- Modify: `test/server.test.ts`
- Modify: `test/sessions.test.ts`
- Modify: `test/agents-codex-process.test.ts`
- Modify: `test/ui.test.ts`

**Interfaces:**

Add the approved type:

```ts
export type CodexThreadSettings = {
  model?: string;
  modelReasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  webSearchMode?: 'disabled' | 'cached' | 'live';
  networkAccessEnabled?: boolean;
};
```

Add `codexSettings?: CodexThreadSettings` to `Session` and `StartOpts`. Add:

```ts
export function validateCodexSettings(value: unknown): CodexThreadSettings | undefined;
Registry.setCodexSettings(id: string, settings: CodexThreadSettings | undefined): void;
```

- [ ] **Step 1: Write failing validation tests**

Create `test/codex-settings.test.ts` covering omitted/empty input, each valid field, explicit `false`, unknown keys, null, arrays, blank/over-200-character model, invalid efforts/search modes, and non-boolean network values.

Representative assertion:

```ts
assert.deepEqual(validateCodexSettings({
  modelReasoningEffort: 'high', networkAccessEnabled: false,
}), { modelReasoningEffort: 'high', networkAccessEnabled: false });
assert.equal(validateCodexSettings({}), undefined);
```

- [ ] **Step 2: Run validation tests and confirm failure**

```bash
node --test test/codex-settings.test.ts
```

Expected: FAIL because the validator does not exist.

- [ ] **Step 3: Implement the validator**

Reject unknown keys and invalid values with an actionable error. Trim `model`; empty becomes omitted, but more than 200 characters is invalid. Return `undefined` when every field inherits.

- [ ] **Step 4: Write failing persistence and server tests**

Test that:

- Codex create persists only explicitly supplied settings;
- Claude create rejects `codexSettings`;
- legacy state with no field loads as inherited;
- stopped Codex sessions accept `cmd: 'codex-settings'`;
- working/done/needs-you sessions reject changes with 409;
- non-Codex sessions reject changes;
- resume passes the stored settings again;
- settings contain no materialized default values in state or SSE.

- [ ] **Step 5: Apply settings below inherited config and above no safety boundary**

Build SDK thread options in this order:

```ts
const threadOptions = {
  ...(settings?.model !== undefined ? { model: settings.model } : {}),
  ...(settings?.modelReasoningEffort !== undefined
    ? { modelReasoningEffort: settings.modelReasoningEffort } : {}),
  ...(settings?.webSearchMode !== undefined ? { webSearchMode: settings.webSearchMode } : {}),
  ...(settings?.networkAccessEnabled !== undefined
    ? { networkAccessEnabled: settings.networkAccessEnabled } : {}),
  workingDirectory: opts.cwd,
  sandboxMode: 'workspace-write' as const,
  approvalPolicy: 'never' as const,
};
```

Do not pass undefined settings. Do not add `additionalDirectories`, `skipGitRepoCheck`, `danger-full-access`, or an approval control. Fake CLI logs must prove explicit settings appear while omitted settings do not.

- [ ] **Step 6: Add new-session and stopped-session controls**

In `web/index.html`, add a Codex-only fieldset to the new-session dialog and a reusable `#codex-settings-dialog` for stopped sessions. Controls are:

- Model: optional text, blank label `Inherit`;
- Reasoning: `Inherit`, `minimal`, `low`, `medium`, `high`, `xhigh`;
- Web search: `Inherit`, `disabled`, `cached`, `live`;
- Network: `Inherit`, `Disabled`, `Enabled`.

Use a select for network so inherited and explicit false are distinct. Never render sandbox or approval controls. Show the fieldset only when the selected account provider is Codex. Add `Codex settings…` to the overflow menu only for stopped Codex sessions.

Add DOM-free `codexSettingsFromForm()` and `codexSettingsSummary()` helpers to `web/lib.js`; cover inherit and explicit false in `test/ui.test.ts`.

- [ ] **Step 7: Run focused and full tests**

```bash
node --test test/codex-settings.test.ts test/sessions.test.ts test/server.test.ts test/agents-codex-process.test.ts test/ui.test.ts
npm test
```

Expected: omitted values remain absent, explicit settings persist/resume, and safety arguments always win.

- [ ] **Step 8: Commit optional Codex settings**

```bash
git add src/agents/codex-settings.ts src/types.ts src/sessions.ts src/server.ts src/agents/codex.ts web/index.html web/app.js web/lib.js web/style.css test/codex-settings.test.ts test/server.test.ts test/sessions.test.ts test/agents-codex-process.test.ts test/ui.test.ts
git commit -m "feat: add inherited Codex thread settings"
```

---

### Task 7: Expose reliable per-turn usage without inventing limits

**Files:**
- Modify: `src/types.ts`
- Modify: `src/sessions.ts`
- Modify: `src/agents/codex.ts`
- Modify: `src/agents/claude.ts`
- Modify: `src/server.ts`
- Modify: `web/lib.js`
- Modify: `web/app.js`
- Modify: `web/style.css`
- Modify: `test/agents-codex.test.ts`
- Modify: `test/agents-claude.test.ts`
- Modify: `test/server.test.ts`
- Modify: `test/sessions.test.ts`
- Modify: `test/ui.test.ts`

**Interfaces:**

Add optional SDK-backed breakdown fields while preserving the existing pace calculation:

```ts
export type TurnUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningOutputTokens?: number;
};

type UsageEvent = { type: 'usage'; usage: TurnUsage };
type Session = { lastUsage: TurnUsage | null };
```

`Usage.record()` continues receiving only `inputTokens` and `outputTokens`; optional fields are subsets/informational and must not be added to budget pace.

- [ ] **Step 1: Write failing usage normalization and persistence tests**

Assert one Codex `turn.completed` maps every SDK field exactly and Registry stores it as `lastUsage`. Assert the server passes only `inputTokens` and `outputTokens` to the account pace recorder. Add Claude envelope coverage and legacy-load coverage for missing `lastUsage`.

- [ ] **Step 2: Run tests and confirm failure**

```bash
node --test test/agents-codex.test.ts test/sessions.test.ts test/usage.test.ts
```

Expected: FAIL until `TurnUsage` and `lastUsage` exist.

- [ ] **Step 3: Implement usage storage**

Initialize `lastUsage: null`, replace it on each usage event, and default missing legacy state to null. Adapt Claude usage events to the same `{ usage }` envelope with only input/output fields.

- [ ] **Step 4: Add a pure browser usage projection**

Add:

```js
export function usageLines(usage) {
  if (!usage) return [];
  const lines = [
    `input: ${usage.inputTokens}`,
    `output: ${usage.outputTokens}`,
  ];
  if (usage.cachedInputTokens !== undefined) {
    lines.push(`cached input: ${usage.cachedInputTokens}`);
  }
  if (usage.cacheWriteInputTokens !== undefined) {
    lines.push(`cache write input: ${usage.cacheWriteInputTokens}`);
  }
  if (usage.reasoningOutputTokens !== undefined) {
    lines.push(`reasoning output: ${usage.reasoningOutputTokens}`);
  }
  return lines;
}
```

Test exact lines for basic and full Codex usage. Labels must say `cached input` and `reasoning output`; never call them extra tokens or remaining quota.

- [ ] **Step 5: Render last-turn usage and preserve estimated meters**

Show a compact `Last turn` usage disclosure in the open session view. Render only present fields. Keep header account meters labelled and documented as estimates based on observed input/output spend.

Do not add a reset time, remaining percentage, plan name, or rate-limit meter from parsed error strings. The production TypeScript SDK has no reliable rate-limit event in the current gate.

- [ ] **Step 6: Verify usage behavior**

```bash
node --test test/agents-codex.test.ts test/sessions.test.ts test/usage.test.ts test/ui.test.ts
npm test
```

Expected: usage detail is SDK-backed, pace does not double-count subsets, and the full suite passes.

- [ ] **Step 7: Commit reliable usage detail**

```bash
git add src/types.ts src/sessions.ts src/agents/codex.ts src/agents/claude.ts src/server.ts web/lib.js web/app.js web/style.css test/agents-codex.test.ts test/agents-claude.test.ts test/server.test.ts test/sessions.test.ts test/ui.test.ts
git commit -m "feat: show reliable Codex turn usage"
```

---

### Task 8: Build the bounded app-server approval evaluation

**Files:**
- Create: `scripts/codex-app-server-probe.ts`
- Create: `test/helpers/fake-app-server.ts`
- Create: `test/app-server-probe.test.ts`
- Create: `docs/superpowers/reports/2026-08-01-codex-app-server-decision.md`
- Modify: `package.json`

**Interfaces:**

The prototype is not imported by `src/server.ts` or any production adapter.

```ts
export type AppServerEvidence = {
  version: string;
  schemaGenerated: boolean;
  initialized: boolean;
  authStateReadable: boolean;
  lifecycleRoundTrip: boolean;
  followUpRoundTrip: boolean;
  resumeRoundTrip: boolean;
  cancellationRoundTrip: boolean;
  commandApprovalRoundTrip: boolean;
  fileApprovalRoundTrip: boolean;
  mcpApprovalObserved: boolean;
  processCrashHandled: boolean;
  vendorThreadMigration: 'verified' | 'not-proven';
  cleanShutdown: boolean;
};

export async function probeAppServer(options: {
  command: string;
  env: Record<string, string>;
  fixtureMode: boolean;
}): Promise<AppServerEvidence>;
```

Add `npm run evaluate:codex-app-server` for the local no-turn probe. It must not be part of `npm test`.

- [ ] **Step 1: Write a fake stdio app-server**

Create `test/helpers/fake-app-server.ts` that supports newline-delimited JSON-RPC without a `jsonrpc` field. It must implement:

- `initialize` then `initialized`;
- `account/read` with a fake authenticated mode and no email/token;
- `thread/start`, `turn/start`, item lifecycle, and `turn/completed`;
- a second `turn/start` on the same thread to prove follow-up behavior;
- `thread/resume`;
- `turn/interrupt` ending interrupted;
- server requests for command and file approval, plus `serverRequest/resolved`;
- an MCP approval-shaped request;
- a controlled unexpected-exit mode for process-crash handling;
- clean EOF shutdown.

- [ ] **Step 2: Write failing probe tests**

Create `test/app-server-probe.test.ts`. Assert the fake proves lifecycle, follow-up, resume, cancellation, both stable approvals, the observed MCP request shape, controlled process-crash handling, and clean shutdown. Assert `vendorThreadMigration` remains `not-proven` because fixture identifiers cannot prove continuity with SDK-created vendor threads. Also assert request IDs correlate under interleaved notifications, approval responses use documented decisions, malformed JSON rejects safely, unexpected exits reject without hanging, and timeout kills the child.

- [ ] **Step 3: Run tests and implement the JSON-RPC probe**

```bash
node --test test/app-server-probe.test.ts
```

Expected: FAIL because the probe does not exist.

Use `spawn()` and `readline`. Maintain a monotonically increasing request ID and a `Map` of pending resolvers. Server-initiated requests have both `method` and `id`; respond to approvals without treating them as client responses. Redact all stderr before returning an error. A 5-second per-request timeout terminates the child and rejects.

- [ ] **Step 4: Add a real no-turn compatibility mode**

When `fixtureMode` is false, use the Phase 1 prepared command/environment and:

1. run `app-server generate-ts` into a temporary directory;
2. start `app-server --listen stdio://`;
3. send `initialize` without `experimentalApi`;
4. call `account/read` with `refreshToken: false`;
5. shut down without `thread/start` or a model turn;
6. inspect generated types for stable thread lifecycle and command/file approval methods.

Persist only booleans, versions, method names, and auth mode. Never persist email, tokens, complete account objects, rate-limit values, or environment values.

The script entry point reads `accounts.json`, selects the first Codex account, calls `prepareCodexRuntime()` with that account's `bin` and `env`, and passes only `runtime.commandPath` and `runtime.env` to `probeAppServer()`. If no Codex account is configured, exit nonzero with `No Codex account configured.` Tests import `probeAppServer()` without running the entry point.

- [ ] **Step 5: Run the offline automated and local no-turn probes**

```bash
npm test
npm run evaluate:codex-app-server
```

Expected: `npm test` uses only the fake; the explicit evaluation performs schema generation, initialization, local auth-state read, and clean shutdown without starting a turn.

- [ ] **Step 6: Write the deterministic decision record**

Create `docs/superpowers/reports/2026-08-01-codex-app-server-decision.md` with the measured matrix for documented approvals, lifecycle, typed schema stability, authentication reuse, MCP approvals, process ownership, crash recovery, fake testing, and vendor-thread migration.

Apply these rules:

1. Choose **SDK-only** if the TypeScript SDK gained adequate approvals, any mandatory app-server gate fails, or no authorized live evidence proves thread-ID migration.
2. Choose **approval bridge** only when a controlled prototype proves the SDK and app-server can safely share the same thread with one process owner. Otherwise explicitly reject the hybrid.
3. Choose **app-server replacement candidate** only when every stable gate passes and an explicitly authorized, non-CI live smoke proves new turn, follow-up, resume, cancellation, and existing vendor-thread continuity. That outcome requires a new design and implementation plan before production code changes.

Absence of a paid/live smoke defaults the production decision to SDK-only; it is not an unresolved result.

- [ ] **Step 7: Commit the evaluation**

```bash
git add scripts/codex-app-server-probe.ts test/helpers/fake-app-server.ts test/app-server-probe.test.ts docs/superpowers/reports/2026-08-01-codex-app-server-decision.md package.json
git commit -m "research: evaluate Codex app-server approvals"
```

---

### Task 9: Document and verify Phase 2 completion

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/superpowers/specs/2026-08-01-codex-integration-design.md` only to add an implementation-status note; do not rewrite approved requirements

- [ ] **Step 1: Update user and contributor documentation**

Document:

- live tool lifecycle and collapsible 32 KiB redacted details;
- reasoning summaries and todo status, with no raw reasoning;
- supported native image formats and path-based fallback files;
- pending attachment retry behavior;
- inherited-by-default Codex settings and their stopped-session update rule;
- mandatory sandbox/approval overrides;
- last-turn usage versus estimated account pace;
- app-server evaluation outcome and why production remains SDK-based unless a later plan changes it;
- normal offline test and optional no-turn evaluation commands.

- [ ] **Step 2: Run security and scope checks**

```bash
rg -n "danger-full-access|experimentalApi|ws://|wss://" src web test scripts README.md AGENTS.md
rg -n "innerHTML|insertAdjacentHTML" web
rg -n "MAX_CODEX_DETAIL_BYTES|safeCodexDetail|local_image|CodexThreadSettings|lastUsage" src test
rg -n "TODO|TBD|FIXME" src web test scripts README.md AGENTS.md
```

Expected: no production danger/full-access or experimental transport path; no untrusted HTML rendering; every Phase 2 contract has focused coverage; no unfinished marker remains.

- [ ] **Step 3: Prove secrets and absolute image paths cannot cross persistence/SSE**

Run the focused tests that write state and read `/events`, using fake tokens in command output, MCP data, account env, and attachment absolute paths:

```bash
node --test test/codex-detail.test.ts test/server.test.ts test/agents-codex-process.test.ts test/prompt-input.test.ts
```

Expected: all pass and assertions explicitly reject each fake secret/path from serialized state and SSE text.

- [ ] **Step 4: Run the complete verification contract**

```bash
npm test
npm run evaluate:codex-app-server
git diff --check
git status --short
```

Expected: all automated tests pass offline; the real no-turn probe completes; whitespace is clean; unrelated user files remain untouched.

- [ ] **Step 5: Review the Phase 2 definition of done line by line**

Confirm:

- each Codex item occupies one row from running to terminal;
- detail is useful, redacted, bounded, marked, persisted, and browser-safe;
- reasoning summaries/todos are separate and no hidden reasoning is stored;
- supported images reach SDK `local_image` and every path is worktree-contained;
- omitted settings inherit and explicit settings persist/resume;
- safety overrides cannot be weakened;
- usage fields come from SDK values and no rate limit is inferred;
- app-server has a working fake protocol probe, a real no-turn probe, and one explicit production decision;
- normal `npm test` remains free of networked/paid Codex work.

Add a short Phase 2 implementation-status note to the design spec only after every item passes.

- [ ] **Step 6: Commit completion documentation**

```bash
git add README.md AGENTS.md docs/superpowers/specs/2026-08-01-codex-integration-design.md
git commit -m "docs: complete Codex integration phase 2"
```

---

## Phase 2 Completion Boundary

Completing Tasks 0-9 means 100% completion of the approved two-phase Codex integration specification. It yields the design's estimated 90-95% of the desired local Codex worker experience, not parity with every Codex app, cloud, connector, collaboration, or external-session capability.

If Task 8 chooses an app-server replacement candidate, that decision is complete but the transport replacement is not authorized by this plan. Write and approve a separate transport-migration design and implementation plan before changing production process ownership or persisted thread semantics.
