# Session Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user move a finished or stopped session's work onto another account, by creating a new session on a branch descended from the old one, opened onto a rendered transcript of everything that happened before it.

**Architecture:** A single `handoff` server command. It commits the source worktree, branches a new worktree from the source branch, writes the source transcript to `.switchboard/handoff.md` inside it, launches a session on the target account with a fixed prompt pointing at that file, and stops the source last. Nothing is asked of the source account — the successor pulls its own context — so the feature works when the source account is out of budget, which is the case it exists for.

**Tech Stack:** TypeScript run directly on Node >= 22.18 (no build step), `node --test`, `node:child_process` git invocations, plain-DOM browser code in `web/`.

**Spec:** `docs/superpowers/specs/2026-08-29-session-handoff-design.md`

## Global Constraints

- Node >= 22.18. TypeScript runs directly; there is no build step.
- Run `npm test` before claiming completion. While iterating, run the focused `node --test` command first.
- Tests must be offline: no paid, networked, or real-account tests. No test may bind port 1455, open a browser, or spawn a real `claude`/`codex` binary.
- Never persist, log, return over SSE, or render account environment values.
- Do not expose raw reasoning.
- Codex sessions keep `sandboxMode: 'workspace-write'` and `approvalPolicy: 'never'`. Do not add an interactive approval path.
- Each session has exactly one dedicated git worktree.
- Only ever delete a credential directory that is exactly `<accountsRoot>/<name>`.

---

### Task 1: Shared outstanding-work commit, excluding `.switchboard`

`mergeWorktrees` commits a dirty worktree before merging it. Handoff needs the identical behaviour before branching. Extract it once rather than duplicating it, and add `.switchboard` to the exclusions in the same move — a handoff file left in a worktree would otherwise be committed into the branch and then permanently into the merge target, which is exactly the bug `uploads` is already excluded for.

Note there are **two** pathspecs to change, not one: `isDirty` decides whether a commit is needed at all, and the `git add` decides what gets staged. Missing the first makes a worktree containing only a handoff file look dirty, producing a commit that stages nothing and fails on "nothing to commit".

**Files:**
- Modify: `src/merge.ts:29-31` (`isDirty`), `src/merge.ts:96-107` (the inline commit block)
- Test: `test/merge.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `export async function commitOutstanding(cwd: string, branch: string): Promise<void>` — commits everything outstanding in `cwd` excluding `uploads` and `.switchboard`; returns without committing when nothing is outstanding; throws on git failure.

- [ ] **Step 1: Write the failing test**

Add to `test/merge.test.ts`:

```ts
test('mergeWorktrees leaves .switchboard/ out of the commit and out of the merge target', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const wt = await createWorktree(repo, 'feat/handed');
  await writeFile(join(wt, 'e.txt'), 'real work\n');
  await mkdir(join(wt, '.switchboard'), { recursive: true });
  await writeFile(join(wt, '.switchboard', 'handoff.md'), '# Handoff\n');

  const result = await mergeWorktrees(repo, [{ cwd: wt, branch: 'feat/handed' }]);

  assert.equal(result.ok, true);
  assert.equal(await readFile(join(repo, 'e.txt'), 'utf8'), 'real work\n');
  await assert.rejects(access(join(repo, '.switchboard', 'handoff.md')));
});

test('commitOutstanding commits nothing when only a handoff file is present', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const wt = await createWorktree(repo, 'feat/only-handoff');
  await mkdir(join(wt, '.switchboard'), { recursive: true });
  await writeFile(join(wt, '.switchboard', 'handoff.md'), '# Handoff\n');
  const before = await run('git', ['rev-parse', 'HEAD'], { cwd: wt });

  await commitOutstanding(wt, 'feat/only-handoff');

  const after = await run('git', ['rev-parse', 'HEAD'], { cwd: wt });
  assert.equal(after.stdout.trim(), before.stdout.trim(), 'no commit should have been made');
});
```

Update the import at the top of `test/merge.test.ts`:

```ts
import { commitOutstanding, mergeWorktrees, pushRepo } from '../src/merge.ts';
```

`mkdir` is already imported there; confirm `access` and `readFile` are too (they are, at `test/merge.test.ts:5`).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/merge.test.ts`
Expected: FAIL — `commitOutstanding` is not exported (`SyntaxError` on the import), and once that is stubbed, the merge-target assertion fails because `.switchboard/handoff.md` lands in the repo.

- [ ] **Step 3: Write minimal implementation**

In `src/merge.ts`, replace `isDirty` (currently at lines 24-31, comment included) with:

```ts
/**
 * `uploads/` and `.switchboard/` are excluded for the same reason the add in
 * commitOutstanding excludes them: those files are conversation inputs, not
 * work. Counting them as dirty would ask for a commit that then stages nothing
 * and fails on "nothing to commit".
 */
async function isDirty(cwd: string): Promise<boolean> {
  const { stdout } = await run(
    'git', ['status', '--porcelain', '--', '.', ':!uploads', ':!.switchboard'], { cwd },
  );
  return stdout.trim().length > 0;
}
```

Add this exported function to `src/merge.ts`, above `mergeWorktrees`:

```ts
/**
 * Commits everything outstanding in one worktree, so a branch point or a merge
 * sees the agent's work rather than the last explicit commit. A clean worktree
 * is a no-op. Throws on git failure; callers frame the message.
 *
 * `uploads/` is where /upload drops pasted and attached files so the agent can
 * read them by path, and `.switchboard/` is where handoff writes the previous
 * session's transcript. Both are inputs to the conversation, not work product,
 * and staging them committed every screenshot and every handoff file into the
 * branch and then permanently into the merge target.
 * ponytail: excludes whole directories, so a repo that tracks its own
 * `uploads/` or `.switchboard/` loses auto-commit for it. Narrow to the paths
 * the registry recorded if that ever bites.
 */
export async function commitOutstanding(cwd: string, branch: string): Promise<void> {
  if (!(await isDirty(cwd))) return;
  await run('git', ['add', '-A', '--', '.', ':(exclude)uploads', ':(exclude).switchboard'], { cwd });
  await run('git', ['commit', '-m', `Switchboard: outstanding changes on ${branch}`], { cwd });
}
```

Then replace the inline block inside `mergeWorktrees`'s loop — everything from `if (await isDirty(cwd)) {` through its closing brace (lines 96-107, comments included) — with:

```ts
      try {
        await commitOutstanding(cwd, branch);
      } catch (err) {
        return { ok: false, merged, error: `committing "${branch}" failed: ${errMsg(err)}` };
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/merge.test.ts`
Expected: PASS, including the pre-existing `uploads` and dirty-worktree tests.

- [ ] **Step 5: Commit**

```bash
git add src/merge.ts test/merge.test.ts
git commit -m "refactor: extract commitOutstanding and exclude .switchboard from auto-commit"
```

---

### Task 2: Branch a worktree from a chosen start point

`createWorktree` runs `git worktree add -b <branch> <path>`, which always branches from the base repo's HEAD. Handoff needs to branch from the source session's branch instead. One optional argument; every existing call site is unaffected.

**Files:**
- Modify: `src/worktree.ts:14-30`
- Test: `test/worktree.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `createWorktree(repo: string, branch: string, from?: string): Promise<string>` — when `from` is given, the new branch starts at that commit-ish instead of the repo's HEAD. Returns the new worktree's absolute path, as before.

- [ ] **Step 1: Write the failing test**

Add to `test/worktree.test.ts` (match the file's existing repo-setup helper; if it has none, use the `makeRepo` body shown in Task 1's test):

```ts
test('createWorktree branches from a given start point instead of repo HEAD', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const first = await createWorktree(repo, 'feat/first');
  await writeFile(join(first, 'only-on-first.txt'), 'source work\n');
  await run('git', ['add', '.'], { cwd: first });
  await run('git', ['commit', '-m', 'work on first'], { cwd: first });

  const second = await createWorktree(repo, 'feat/second', 'feat/first');

  assert.equal(
    await readFile(join(second, 'only-on-first.txt'), 'utf8'), 'source work\n',
    'the new worktree should carry the start-point branch\'s commits',
  );
  // Exits non-zero when it is not an ancestor, which rejects and fails the test.
  await run('git', ['merge-base', '--is-ancestor', 'feat/first', 'feat/second'], { cwd: repo });
});

test('createWorktree still branches from repo HEAD when no start point is given', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const first = await createWorktree(repo, 'feat/a');
  await writeFile(join(first, 'only-on-a.txt'), 'x\n');
  await run('git', ['add', '.'], { cwd: first });
  await run('git', ['commit', '-m', 'work on a'], { cwd: first });

  const second = await createWorktree(repo, 'feat/b');

  await assert.rejects(
    access(join(second, 'only-on-a.txt')),
    'omitting the start point must keep branching from HEAD, not from the last worktree',
  );
});
```

Confirm `access`, `readFile`, `writeFile`, `rm` and `join` are imported at the top of `test/worktree.test.ts`; add whichever are missing.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/worktree.test.ts`
Expected: FAIL — `only-on-first.txt` does not exist in the second worktree, because it branched from `main`.

- [ ] **Step 3: Write minimal implementation**

In `src/worktree.ts`, change the signature and the git invocation:

```ts
/**
 * `from` is a commit-ish the new branch starts at, rather than the repo's
 * current HEAD. Handoff passes the source session's branch so the successor
 * inherits its work; every other caller wants HEAD and omits it.
 */
export async function createWorktree(repo: string, branch: string, from?: string): Promise<string> {
  try {
    await run('git', ['rev-parse', '--git-dir'], { cwd: repo });
  } catch {
    throw new Error(`not a git repository: ${repo}`);
  }

  const path = join(repo, '.claude', 'worktrees', slug(branch));
  try {
    await run('git', ['worktree', 'add', '-b', branch, path, ...(from ? [from] : [])], { cwd: repo });
  } catch (err) {
    const msg = String((err as { stderr?: string }).stderr ?? err);
    if (/already exists/i.test(msg)) throw new Error(`branch already exists: ${branch}`);
    throw new Error(msg.trim());
  }
  return path;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/worktree.test.ts`
Expected: PASS, including every existing worktree test.

- [ ] **Step 5: Commit**

```bash
git add src/worktree.ts test/worktree.test.ts
git commit -m "feat: let createWorktree branch from a given start point"
```

---

### Task 3: Render a session transcript to markdown

The successor's context comes from a file, not a prompt. This task produces that file's contents.

`Registry.get()` returns the internal `Session` (`src/sessions.ts:166`), whose `ToolMsg` entries carry `detail` inline — so no detail-fetching callback is needed, unlike the `getDetail` parameter the spec sketched. Note that deviation when reviewing.

Tool detail is bounded to 32 KiB per item and 2 MiB globally and evicted least-recently-updated, so on a long session early detail is often gone. Emit an explicit marker where it was evicted: a successor reading a confident history with silent holes is worse off than one that can see where the holes are.

**Files:**
- Create: `src/handoff.ts`
- Test: `test/handoff.test.ts`

**Interfaces:**
- Consumes: `Session` and `Msg` from `src/types.ts`.
- Produces:
  - `export const HANDOFF_FILE = '.switchboard/handoff.md'`
  - `export const HANDOFF_PROMPT: string`
  - `export function renderHandoff(session: Session): string`

- [ ] **Step 1: Write the failing test**

Create `test/handoff.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { renderHandoff, HANDOFF_FILE, HANDOFF_PROMPT } from '../src/handoff.ts';
import type { Session } from '../src/types.ts';

function session(transcript: Session['transcript']): Session {
  return {
    id: 'sess-1', provider: 'claude', account: 'claude-main', vendorSessionId: null,
    repo: '/repo', cwd: '/repo/.claude/worktrees/feat-x', branch: 'feat/x', title: 'feat/x',
    status: 'stopped', auto: false, lastUsage: null, transcript, pending: null,
    stoppedReason: null, stoppedCode: null, startedAt: 0, statusSince: 0,
  };
}

test('renderHandoff names the source session in its header', () => {
  const out = renderHandoff(session([]));
  assert.match(out, /# Handoff from `feat\/x`/);
  assert.match(out, /claude-main/);
});

test('renderHandoff keeps prompts, agent prose, todos and errors', () => {
  const out = renderHandoff(session([
    { kind: 'user', id: 'u1', text: 'add a retry', delivery: 'sent' },
    { kind: 'text', text: 'I added a retry to the fetch helper.' },
    { kind: 'todo', id: 't1', items: [
      { text: 'write the test', completed: true },
      { text: 'wire it up', completed: false },
    ] },
    { kind: 'error', text: 'the process exited with code 1' },
  ]));
  assert.match(out, /## You said\n\nadd a retry/);
  assert.match(out, /I added a retry to the fetch helper\./);
  assert.match(out, /- \[x\] write the test/);
  assert.match(out, /- \[ \] wire it up/);
  assert.match(out, /\*\*Error:\*\* the process exited with code 1/);
});

test('renderHandoff inlines held tool detail and marks evicted detail', () => {
  const out = renderHandoff(session([
    { kind: 'tool', id: 'a', name: 'Read', summary: 'src/foo.ts', status: 'ok',
      detail: 'export const foo = 1;' },
    { kind: 'tool', id: 'b', name: 'Bash', summary: 'npm test', status: 'error',
      detailEvicted: true },
  ]));
  assert.match(out, /- \*\*Read\*\* src\/foo\.ts — ok/);
  assert.match(out, /export const foo = 1;/);
  assert.match(out, /- \*\*Bash\*\* npm test — error/);
  assert.match(out, /_\[detail evicted\]_/);
});

test('renderHandoff never emits reasoning', () => {
  const out = renderHandoff(session([
    { kind: 'reasoning', id: 'r1', text: 'the user probably wants a mutex here' },
    { kind: 'text', text: 'Done.' },
  ]));
  assert.doesNotMatch(out, /mutex/);
  assert.match(out, /Done\./);
});

test('the opening prompt points the successor at the handoff file', () => {
  assert.equal(HANDOFF_FILE, '.switchboard/handoff.md');
  assert.match(HANDOFF_PROMPT, /\.switchboard\/handoff\.md/);
  assert.match(HANDOFF_PROMPT, /git log/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/handoff.test.ts`
Expected: FAIL — `Cannot find module '../src/handoff.ts'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/handoff.ts`:

```ts
import type { Msg, Session } from './types.ts';

/** Worktree-relative, so the successor's prompt never carries an absolute path. */
export const HANDOFF_FILE = '.switchboard/handoff.md';

/**
 * Fixed rather than user-editable: the successor is pointed at the narrative
 * and at the code separately, because the transcript explains the intent and
 * the branch carries the result, and neither is much use alone. One constant so
 * it stays tunable once real handoffs show what a successor actually misses.
 */
export const HANDOFF_PROMPT = [
  'You are continuing work handed off from another agent on a different account.',
  '',
  `Read \`${HANDOFF_FILE}\` for the full record of what happened before you: the`,
  'prompts, what the previous agent did, and what it said. Then check `git log`',
  'and the diff against this branch\'s base for the code as it actually stands —',
  'the transcript explains the intent, the branch carries the result.',
  '',
  'Then continue the work.',
].join('\n');

function renderMsg(m: Msg): string | null {
  switch (m.kind) {
    case 'user':
      return `## You said\n\n${m.text}`;
    case 'text':
      return m.text;
    case 'tool': {
      const head = `- **${m.name}** ${m.summary} — ${m.status}`;
      if (m.detail) return `${head}\n\n\`\`\`\n${m.detail}\n\`\`\``;
      // An evicted body is called out rather than omitted: a successor reading
      // a confident history with silent holes in it is worse off than one that
      // can see where the holes are.
      if (m.detailEvicted) return `${head}\n\n  _[detail evicted]_`;
      return head;
    }
    case 'todo':
      return ['## Todo', ...m.items.map((i) => `- [${i.completed ? 'x' : ' '}] ${i.text}`)].join('\n');
    case 'error':
      return `**Error:** ${m.text}`;
    // Reasoning is the agent's private deliberation about a state that has since
    // changed, and the safety boundaries forbid exposing it. Dropped, not rendered.
    case 'reasoning':
      return null;
  }
}

export function renderHandoff(session: Session): string {
  const header = [
    `# Handoff from \`${session.branch}\``,
    '',
    `Previous session ran on account \`${session.account}\` (${session.provider}), on branch`,
    `\`${session.branch}\`, and was \`${session.status}\` when it was handed off.`,
    '',
    '---',
  ].join('\n');
  const body = session.transcript
    .map(renderMsg)
    .filter((chunk): chunk is string => chunk !== null);
  return [header, ...body].join('\n\n') + '\n';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/handoff.test.ts`
Expected: PASS, all five tests.

- [ ] **Step 5: Commit**

```bash
git add src/handoff.ts test/handoff.test.ts
git commit -m "feat: render a session transcript to a handoff document"
```

---

### Task 4: The `handoff` server command

Everything that can fail is checked before anything is created, and the source session is stopped last — a half-completed handoff that also killed the source would leave the work reachable from neither side, and the source account is by assumption already in trouble.

Codex thread settings are deliberately not accepted here; a handoff to a Codex account gets that account's defaults. Adding them later is a `validateCodexSettings` call in the same shape `create` uses.

**Files:**
- Modify: `src/server.ts:3` (fs imports), `src/server.ts:12-13` (worktree/merge imports), `src/server.ts:709-762` (add a case beside `create`)
- Test: `test/server.test.ts`

**Interfaces:**
- Consumes: `commitOutstanding` (Task 1), `createWorktree(repo, branch, from?)` (Task 2), `renderHandoff` / `HANDOFF_FILE` / `HANDOFF_PROMPT` (Task 3).
- Produces: `POST /command` with `{ cmd: 'handoff', id: string, account: string, branch: string }`, returning `{ id }` for the new session on success.

- [ ] **Step 1: Write the failing test**

Add to `test/server.test.ts`:

```ts
test('handoff branches from the source, writes the transcript, and stops the source', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const { adapter } = fakeAdapter();
  const { base, registry } = await boot(t, adapter);

  const created = await fetch(new URL('/command', base), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cmd: 'create', repo, branch: 'feat/src', account: 'claude-main', prompt: 'do the thing' }),
  }).then((r) => r.json());
  const source = registry.get(created.id)!;
  await writeFile(join(source.cwd, 'work.txt'), 'uncommitted work\n');
  registry.apply(created.id, { type: 'status', status: 'done' });

  const res = await fetch(new URL('/command', base), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cmd: 'handoff', id: created.id, account: 'codex', branch: 'feat/dest' }),
  });
  const { id } = await res.json();

  assert.equal(res.status, 200);
  const dest = registry.get(id)!;
  assert.equal(dest.account, 'codex');
  assert.equal(dest.branch, 'feat/dest');
  assert.equal(
    await readFile(join(dest.cwd, 'work.txt'), 'utf8'), 'uncommitted work\n',
    'the source\'s uncommitted work should have been committed and inherited',
  );
  const doc = await readFile(join(dest.cwd, '.switchboard', 'handoff.md'), 'utf8');
  assert.match(doc, /do the thing/);
  await run('git', ['merge-base', '--is-ancestor', 'feat/src', 'feat/dest'], { cwd: repo });
  assert.equal(registry.get(created.id)!.status, 'stopped');
});

test('handoff refuses a working source and creates nothing', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const { adapter } = fakeAdapter();
  const { base, registry } = await boot(t, adapter);

  const created = await fetch(new URL('/command', base), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cmd: 'create', repo, branch: 'feat/busy', account: 'claude-main', prompt: 'go' }),
  }).then((r) => r.json());
  assert.equal(registry.get(created.id)!.status, 'working');

  const res = await fetch(new URL('/command', base), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cmd: 'handoff', id: created.id, account: 'codex', branch: 'feat/nope' }),
  });

  assert.equal(res.status, 409);
  assert.equal(registry.all().length, 1, 'no session should have been created');
  await assert.rejects(access(join(repo, '.claude', 'worktrees', 'feat-nope')));
});

test('handoff rejects an unknown target account before touching the source worktree', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const { adapter } = fakeAdapter();
  const { base, registry } = await boot(t, adapter);

  const created = await fetch(new URL('/command', base), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cmd: 'create', repo, branch: 'feat/keep', account: 'claude-main', prompt: 'go' }),
  }).then((r) => r.json());
  registry.apply(created.id, { type: 'status', status: 'done' });
  await writeFile(join(registry.get(created.id)!.cwd, 'still-dirty.txt'), 'x\n');

  const res = await fetch(new URL('/command', base), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cmd: 'handoff', id: created.id, account: 'nobody', branch: 'feat/nope' }),
  });

  assert.equal(res.status, 400);
  const { stdout } = await run('git', ['status', '--porcelain'], { cwd: registry.get(created.id)!.cwd });
  assert.ok(stdout.includes('still-dirty.txt'), 'the source worktree should not have been committed');
  assert.equal(registry.get(created.id)!.status, 'done', 'the source should not have been stopped');
});
```

`test/server.test.ts:3-5` imports `chmod, mkdir, mkdtemp, writeFile, readdir, realpath, rename, rm, readFile, stat, symlink` from `node:fs/promises` — add `access` to that list.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/server.test.ts`
Expected: FAIL — the command returns 400 `unknown command: handoff` (or the server's equivalent), so the status assertions fail.

- [ ] **Step 3: Write minimal implementation**

Extend the imports in `src/server.ts`:

```ts
import { mkdir, readFile, readdir, rm, stat, lstat, writeFile } from 'node:fs/promises';
```

```ts
import { commitOutstanding, mergeWorktrees, pushRepo } from './merge.ts';
import { HANDOFF_FILE, HANDOFF_PROMPT, renderHandoff } from './handoff.ts';
```

Add this case in `command()`, immediately after `case 'create'` ends (`src/server.ts:761`):

```ts
      case 'handoff': {
        const source = registry.get(String(body.id));
        if (!source) return { status: 404, json: { error: 'no such session' } };
        // The same guard merge applies, for the same reason: a running agent's
        // half-written files must not be committed underneath it.
        if (source.status === 'working' || source.status === 'needs-you') {
          return { status: 409, json: { error: 'stop the session before handing it off' } };
        }
        const account = accounts.find((a) => a.name === body.account);
        if (!account) return { status: 400, json: { error: `unknown account: ${body.account}` } };
        let prepared: PreparedProvider;
        try {
          prepared = await prepare(account);
        } catch (error) {
          if (error instanceof CodexRuntimeError) {
            return {
              status: 400,
              json: { error: redactAccountValue(error.message, account), code: error.code },
            };
          }
          throw error;
        }
        try {
          await commitOutstanding(source.cwd, source.branch);
        } catch (err) {
          return {
            status: 400,
            json: { error: `committing "${source.branch}" failed: ${(err as Error).message}` },
          };
        }
        const branch = String(body.branch);
        let cwd: string;
        try {
          cwd = await createWorktree(source.repo, branch, source.branch);
        } catch (err) {
          return { status: 400, json: { error: (err as Error).message } };
        }
        try {
          await mkdir(join(cwd, dirname(HANDOFF_FILE)), { recursive: true });
          await writeFile(join(cwd, HANDOFF_FILE), renderHandoff(source), 'utf8');
        } catch (err) {
          // The worktree is left behind, exactly as `create` leaves one when
          // launch fails. Inventing a cleanup path here that create does not
          // have would leave the two inconsistent for no gain.
          return { status: 500, json: { error: `writing the handoff file failed: ${(err as Error).message}` } };
        }
        const session = registry.create({
          provider: account.provider,
          account: account.name,
          repo: source.repo,
          cwd,
          branch,
          title: branch,
        });
        const promptId = registry.appendPrompt(
          session.id, HANDOFF_PROMPT, account.provider === 'codex' ? 'queued' : 'sent',
        );
        if (registry.settings().autoApprove) registry.setAuto(session.id, true);
        const launchError = launch(
          session.id, account, prepared.adapter, cwd,
          { text: HANDOFF_PROMPT, attachments: [] }, undefined, promptId,
        );
        if (launchError) return { status: 500, json: launchError };
        // Stopped last: every failure above leaves the source exactly as it was.
        // Delete before stop — see the emit callback in launch().
        const handle = handles.get(source.id);
        handles.delete(source.id);
        handle?.stop();
        return { status: 200, json: { id: session.id } };
      }
```

`dirname` is already imported at `src/server.ts:7`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/server.test.ts`
Expected: PASS, including every pre-existing server test.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts test/server.test.ts
git commit -m "feat: add the handoff command"
```

---

### Task 5: Hand off from the session menu

The action lives in the card's overflow menu, and only on `done` and `stopped` sessions — absent rather than present-and-failing, matching how the grid already treats merge.

`test/ui.test.ts` has **no DOM harness**: it imports pure functions from `web/lib.js` and never loads `app.js` as code (there is a comment at `test/ui.test.ts:20` explaining why). So the decision — which accounts a session can be handed to — goes in `lib.js` as a pure function and is tested there, exactly as `cardAction` (`web/lib.js:39`) already does for the card's action slot. `app.js` renders what it returns.

One function covers both uses: an empty list means the menu item is hidden, and a non-empty list is what fills the dialog's dropdown.

**Files:**
- Modify: `web/lib.js` (a new export beside `cardAction` at line 39), `web/index.html` (a new dialog after `#del` closes at line 284), `web/app.js` (its `lib.js` import block, the session menu at lines 706-711, and a new open/close pair after `confirmDelete` at line 712)
- Test: `test/ui.test.ts`

**Interfaces:**
- Consumes: `POST /command` `{ cmd: 'handoff', id, account, branch }` (Task 4).
- Produces: `export function handoffTargets(session, accounts)` in `web/lib.js` — returns the account objects this session may be handed off to: `[]` unless the session is `done` or `stopped`, otherwise every account except the session's own.

- [ ] **Step 1: Write the failing test**

Add `handoffTargets` to the `web/lib.js` import block at the top of `test/ui.test.ts`, then add:

```ts
test('handoffTargets offers other accounts only for finished or stopped sessions', () => {
  const accounts = [
    { name: 'claude-main', provider: 'claude' },
    { name: 'claude-alt', provider: 'claude' },
    { name: 'codex', provider: 'codex' },
  ];
  const names = (status) =>
    handoffTargets({ id: 's1', account: 'claude-main', status }, accounts).map((a) => a.name);

  // A running agent's half-written files must not be committed underneath it —
  // the same rule the handoff command enforces server-side.
  assert.deepEqual(names('working'), []);
  assert.deepEqual(names('needs-you'), []);
  // The source's own account is excluded: handing off to it goes nowhere.
  assert.deepEqual(names('done'), ['claude-alt', 'codex']);
  assert.deepEqual(names('stopped'), ['claude-alt', 'codex']);
});

test('handoffTargets is empty when the only account is the session\'s own', () => {
  const accounts = [{ name: 'claude-main', provider: 'claude' }];
  assert.deepEqual(handoffTargets({ id: 's1', account: 'claude-main', status: 'done' }, accounts), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/ui.test.ts`
Expected: FAIL — `handoffTargets is not a function`. The pre-existing "every name app.js imports from lib.js is actually exported" test still passes at this point, and will guard the wiring in Step 3.

- [ ] **Step 3: Write minimal implementation**

Add to `web/lib.js`, immediately after `cardAction` (line 52):

```js
/**
 * The accounts a session can be handed off to. Empty means the menu item is
 * hidden; otherwise it is exactly what fills the dialog's dropdown, so the gate
 * and the choices can never disagree.
 *
 * `working` and `needs-you` are excluded because handoff commits the source
 * worktree, and a running agent's half-written files must not be captured
 * underneath it — the same rule the server enforces. The session's own account
 * is excluded because handing off to it goes nowhere.
 */
export function handoffTargets(session, accounts) {
  if (session.status !== 'done' && session.status !== 'stopped') return [];
  return accounts.filter((a) => a.name !== session.account);
}
```

Add the dialog to `web/index.html`, immediately after the `#del` dialog closes (line 284):

```html
<dialog id="handoff">
  <form method="dialog">
    <h2>Hand off session</h2>
    <p class="hint" id="handoff-from"></p>
    <label>Account <select id="handoff-account" name="account"></select></label>
    <label>New branch <input id="handoff-branch" name="branch" required></label>
    <p class="hint">The new session branches from this one and opens onto a written record of it. This session is stopped.</p>
    <p class="hint" id="handoff-error"></p>
    <menu>
      <button value="cancel" formnovalidate>Cancel</button>
      <button value="handoff">Hand off</button>
    </menu>
  </form>
</dialog>
```

In `web/app.js`, add `handoffTargets` to the `import { ... } from './lib.js'` block. Then add the menu item inside the session menu, immediately before the `menu.append(menuItem('Graph', ...))` block at line 706:

```js
  const handoffAccounts = handoffTargets(s, state.accounts);
  if (handoffAccounts.length) {
    menu.append(menuItem('Hand off…', () => openHandoff(s, handoffAccounts)));
  }
```

Add these beside `confirmDelete` (after line 712). The `let` goes first — `let` bindings are hoisted but not initialised, so a declaration below `openHandoff` would still work at call time, but reading top-down is worth more than the saved line:

```js
let handoffSource = null;

function openHandoff(s, targets) {
  const dialog = $('#handoff');
  $('#handoff-from').textContent = `From ${s.branch} on ${s.account}`;
  $('#handoff-error').textContent = '';
  $('#handoff-branch').value = state.settings.branchPrefix;
  $('#handoff-account').replaceChildren(...targets.map((a) => {
    const o = document.createElement('option');
    o.value = a.name;
    o.textContent = a.name;
    return o;
  }));
  dialog.returnValue = '';
  handoffSource = s.id;
  dialog.showModal();
}

$('#handoff').addEventListener('close', async (e) => {
  const dialog = e.target;
  // Consumed here for the same reason #new consumes its own: Escape closes a
  // dialog without setting returnValue, so an unconsumed 'handoff' would make
  // the next Escape re-POST a still-populated form — an unintended worktree and
  // a paid agent launch from a keypress that means "cancel".
  const go = dialog.returnValue === 'handoff';
  dialog.returnValue = '';
  if (!go || !handoffSource) return;
  const result = await postCommand({
    cmd: 'handoff',
    id: handoffSource,
    account: $('#handoff-account').value,
    branch: $('#handoff-branch').value,
  });
  if (!result.ok) {
    $('#handoff-error').textContent = commandFailure(result);
    dialog.showModal();
    return;
  }
  handoffSource = null;
  render();
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/ui.test.ts`
Expected: PASS — both new tests, plus the pre-existing export-wiring test now covering `handoffTargets`.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS. This is the required verification for the whole feature.

- [ ] **Step 6: Commit**

```bash
git add web/index.html web/app.js test/ui.test.ts
git commit -m "feat: hand off a session to another account from the card menu"
```

---

### Task 6: Document the feature

`README.md` documents every user-facing surface; a command the UI exposes and nothing describes is a gap.

**Files:**
- Modify: `README.md` (beside the unlinking paragraph at line 91, or wherever session actions are described)
- Modify: `AGENTS.md` (code ownership and safety boundaries)

- [ ] **Step 1: Add the README section**

Insert after the unlinking paragraph that ends at `README.md:99`:

```markdown
"Hand off…" (in a session's menu) moves work to another account. It is offered
on `done` and `stopped` sessions only — handing off commits the source
worktree, and a `working` agent's half-written files must not be captured
underneath it. Pick a target account and a branch name, and Switchboard commits
whatever the source left outstanding, branches the new session's worktree from
the source branch, and opens the new session onto
`.switchboard/handoff.md` — the previous session's prompts, actions and replies,
rendered to markdown. The successor reads that for itself, so the account being
handed away from spends nothing; it works when that account is out of budget,
which is the case handoff exists for.

Reasoning is never written to that file, and `.switchboard/` is excluded from
the outstanding-work commit the same way `uploads/` is, so a handoff document
can never reach a merge target. The source session is stopped — Resume still
works, but leaving it running would let it edit a branch the new session is
already based on.
```

- [ ] **Step 2: Add the AGENTS.md lines**

Under "Code ownership", add:

```
- `src/handoff.ts` owns the transcript render and the successor's opening prompt.
```

Under "Safety boundaries", add:

```
- Handoff renders a transcript to disk. Reasoning is never included, and
  `.switchboard/` is excluded from the outstanding-work commit so a handoff
  document can never reach a merge target.
```

- [ ] **Step 3: Verify nothing else claims the old behaviour**

Run: `grep -rn "createWorktree\|uploads" README.md AGENTS.md`
Expected: no statement that contradicts the new start-point argument or the widened exclusion list.

- [ ] **Step 4: Commit**

```bash
git add README.md AGENTS.md
git commit -m "docs: describe session handoff"
```

---

## Deferred

Named in the spec's "Out of scope" and deliberately not built here: automatic handoff when the source account hits its reset window; asking a healthy source agent for a summary to prepend to the rendered file; agent-to-agent messaging; and starting the successor from the repo's HEAD instead of the source branch.
