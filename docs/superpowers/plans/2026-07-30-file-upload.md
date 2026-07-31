# File Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user attach files to an open session from the browser, by writing them into that session's git worktree and putting their paths into the message.

**Architecture:** One new `POST /upload` route on the existing server writes raw request bytes to `<session.cwd>/uploads/<name>` and returns the relative path. The web client uploads on file-pick or drag-drop, then appends the returned path to the prompt box. No adapter, `Msg`, `Session`, or registry change — the agent reads the file by path like any other file in its worktree.

**Tech Stack:** Node >= 22.18 running TypeScript directly (no build step), `node:http`, `node:test`, vanilla ES-module browser JS.

Spec: `docs/superpowers/specs/2026-07-30-file-upload-design.md`

## Global Constraints

- Node >= 22.18, TypeScript run directly — no build step, no transpile.
- No new dependencies. `package.json` stays as it is.
- Server binds `127.0.0.1:4711` only.
- Every route stays behind `hostOk(req)`, which is applied above the route dispatch — do not add a route above that check.
- Any route with side effects also needs the `Origin`-vs-`Host` check.
- Tests are `node:test` + `node:assert`, run with `npm test`.
- Uploads land at `<session.cwd>/uploads/<name>` — inside the worktree, because Codex is sandboxed to its worktree and cannot read anything outside it.

## File Structure

- `src/server.ts` — add `originOk()` helper, `MAX_UPLOAD` constant, and the `/upload` route. The route lives beside `/command`, above the static-file fallback.
- `test/server.test.ts` — two new tests: happy path, and filename traversal rejection.
- `web/index.html` — attach button inside `#composer`, error line below it.
- `web/app.js` — `upload()` function, `change` handler on the file input, drag-drop handlers on `#chat`.
- `web/style.css` — styles for the attach button, drop highlight, and error line.

---

### Task 1: Upload route

**Files:**
- Modify: `src/server.ts` (imports at lines 3 and 7; new helper beside `hostOk` at line 42; new route before the static-file fallback at line 311; the existing inline Origin check at lines 283–288 gets replaced by a call to the new helper)
- Test: `test/server.test.ts`

**Interfaces:**
- Consumes: `registry.get(id)` returning `Session | undefined` with a `cwd` string (`src/sessions.ts`).
- Produces: `POST /upload?id=<sessionId>&name=<filename>` with raw bytes as the body, responding `200 { path: "uploads/<name>" }`. Task 2's client calls exactly this.

- [ ] **Step 1: Write the failing tests**

Add these two imports to the top of `test/server.test.ts` — the existing line is `import { mkdtemp, rm } from 'node:fs/promises';`:

```ts
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
```

(`join` is already imported from `node:path`; add `dirname` to that same line rather than a second import.)

Append to `test/server.test.ts`:

```ts
test('POST /upload writes the file into the session worktree', async (t) => {
  const { base, registry } = await boot(t);
  const wt = await mkdtemp(join(tmpdir(), 'sb-wt-'));
  t.after(() => rm(wt, { recursive: true, force: true }));
  const s = registry.create({
    provider: 'claude', account: 'claude-main', repo: '/r',
    cwd: wt, branch: 'b', title: 't',
  });

  const res = await fetch(`${base}/upload?id=${s.id}&name=notes.txt`, {
    method: 'POST',
    body: 'hello file',
  });

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { path: 'uploads/notes.txt' });
  assert.equal(await readFile(join(wt, 'uploads', 'notes.txt'), 'utf8'), 'hello file');
});

test('POST /upload rejects a filename that escapes the worktree', async (t) => {
  const { base, registry } = await boot(t);
  const wt = await mkdtemp(join(tmpdir(), 'sb-wt-'));
  t.after(() => rm(wt, { recursive: true, force: true }));
  const s = registry.create({
    provider: 'claude', account: 'claude-main', repo: '/r',
    cwd: wt, branch: 'b', title: 't',
  });
  // Unique so a leftover file from an earlier run can never make this pass.
  const escapee = `escaped-${s.id}.txt`;

  const res = await fetch(
    `${base}/upload?id=${s.id}&name=${encodeURIComponent(`../${escapee}`)}`,
    { method: 'POST', body: 'pwned' },
  );

  assert.equal(res.status, 400);
  await assert.rejects(
    stat(join(dirname(wt), escapee)),
    'a rejected name must not have written anything outside the worktree',
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — both new tests. The first gets a 404 (`/upload` is not a known static asset), the second gets 404 instead of 400.

- [ ] **Step 3: Implement the route**

In `src/server.ts`, extend the two existing import lines:

```ts
import { readFile, readdir, rm, stat, mkdir, writeFile } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
```

Add beside the existing `hostOk` function (after it, around line 47):

```ts
const MAX_UPLOAD = 25 * 1024 * 1024;

/**
 * Blocks a plain cross-origin POST, where Origin disagrees with Host — the
 * hostOk() check above only catches a spoofed Host. Non-browser clients (curl,
 * this file's own tests) send no Origin at all, so only a *mismatched* one is
 * rejected. Every route with side effects calls this.
 */
function originOk(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  return !origin || origin === `http://${req.headers.host}`;
}
```

Replace the inline Origin check inside the `/command` handler (the `const origin = req.headers.origin;` block and its `if`) with:

```ts
        if (!originOk(req)) {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'cross-origin request blocked' }));
          return;
        }
```

Keep the long comment that sits above that check — move it onto `originOk` if you prefer, but do not delete it.

Add this route immediately after the `/command` block and before the static-file fallback (`const file = url.pathname === '/' ? ...`):

```ts
      if (url.pathname === '/upload' && req.method === 'POST') {
        if (!originOk(req)) {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'cross-origin request blocked' }));
          return;
        }
        const session = registry.get(url.searchParams.get('id') ?? '');
        // No session means no worktree to write into — there is no sane default
        // target for the bytes, so this is a 404 rather than a guess.
        if (!session) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'no such session' }));
          return;
        }
        // Trust boundary: the name comes from the browser and is used to build a
        // filesystem path. Reject anything basename() had to change rather than
        // silently rewriting it — a caller asking for ../../.ssh/authorized_keys
        // should get an error, not a surprise file in uploads/.
        const raw = url.searchParams.get('name') ?? '';
        const name = basename(raw);
        if (!name || name === '.' || name === '..' || name !== raw) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'bad filename' }));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const c of req) {
          size += (c as Buffer).length;
          // Counted as it streams, not after: buffering first would mean a
          // mistaken drop of a video file allocates the whole thing before we
          // decide to refuse it.
          if (size > MAX_UPLOAD) {
            res.writeHead(413, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'file too large' }));
            req.destroy();
            return;
          }
          chunks.push(c as Buffer);
        }
        await mkdir(join(session.cwd, 'uploads'), { recursive: true });
        await writeFile(join(session.cwd, 'uploads', name), Buffer.concat(chunks));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ path: `uploads/${name}` }));
        return;
      }
```

- [ ] **Step 4: Run the whole suite**

Run: `npm test`
Expected: PASS, 63 tests — the 61 that existed plus the 2 new ones. The pre-existing Origin tests must still pass; they now exercise `originOk`.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts test/server.test.ts
git commit -m "feat: upload files into a session's worktree"
```

---

### Task 2: Attach files from the chat view

**Files:**
- Modify: `web/index.html` (the `#composer` form, line 8)
- Modify: `web/app.js` (after the `#composer` submit handler, line 258)
- Modify: `web/style.css` (after the `#prompt` rule, line 39)

**Interfaces:**
- Consumes: Task 1's `POST /upload?id=<sessionId>&name=<filename>` → `200 { path }`; the module-level `openId` and `$()` helper already in `web/app.js`.
- Produces: nothing other tasks consume. This is the last task.

- [ ] **Step 1: Add the markup**

In `web/index.html`, replace the `#composer` line with:

```html
  <form id="composer">
    <label id="attach" title="Attach files">📎<input type="file" multiple hidden></label>
    <input id="prompt" placeholder="Message…" autocomplete="off"><button>Send</button>
  </form>
  <p id="upload-error"></p>
```

- [ ] **Step 2: Add the styles**

Append to `web/style.css` after the `#prompt` rule:

```css
#attach { display: grid; place-content: center; padding: 0 .7rem; cursor: pointer;
  background: var(--card); border: 1px solid #333; border-radius: 8px; }
#attach:hover { border-color: var(--working); }
/* Drop target feedback: without it, a drag over the transcript looks inert and
   the user cannot tell whether releasing will do anything. */
#chat.dropping { outline: 2px dashed var(--working); outline-offset: 6px; border-radius: 8px; }
#upload-error { margin: .5rem 0 0; color: #e05555; font-size: .85rem; max-width: 60rem; }
#upload-error:empty { display: none; }
```

- [ ] **Step 3: Wire up the client**

In `web/app.js`, add after the `$('#composer').onsubmit` handler:

```js
// Uploads go straight to disk in the session's worktree and come back as a
// relative path, which is appended to the prompt box. The agent then opens it
// like any other file in the repo — no adapter or transcript change needed.
async function upload(files) {
  if (!openId || !files.length) return;
  $('#upload-error').textContent = '';
  for (const file of files) {
    let path;
    try {
      const res = await fetch(`/upload?id=${openId}&name=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        body: file,
      });
      if (!res.ok) throw new Error((await res.json()).error ?? res.status);
      ({ path } = await res.json());
    } catch (err) {
      // Surfaced, not swallowed: a silently dropped upload turns into the user
      // sending a path that does not exist and the agent reporting confusion.
      $('#upload-error').textContent = `could not attach ${file.name}: ${err.message}`;
      return;
    }
    const box = $('#prompt');
    box.value = box.value ? `${box.value} ${path}` : path;
  }
  $('#prompt').focus();
}

$('#attach input').onchange = (e) => {
  upload(e.target.files);
  // Cleared so picking the same file twice in a row still fires `change`.
  e.target.value = '';
};

const chat = $('#chat');
chat.addEventListener('dragover', (e) => {
  e.preventDefault(); // Without this the browser navigates to the dropped file.
  chat.classList.add('dropping');
});
chat.addEventListener('dragleave', () => chat.classList.remove('dropping'));
chat.addEventListener('drop', (e) => {
  e.preventDefault();
  chat.classList.remove('dropping');
  upload(e.dataTransfer.files);
});
```

- [ ] **Step 4: Verify manually**

Run: `npm start`, open http://127.0.0.1:4711, and open a session that is not `stopped`.

1. Click 📎, pick a text file. Its path appears in the prompt box as `uploads/<name>`.
2. Confirm the file is really there: `ls <worktree>/uploads/`.
3. Drag a second file onto the transcript. The dashed outline appears while dragging, and the second path is appended after the first, space-separated.
4. Type `summarise ` before the paths and press Send. Confirm the agent reads the files and replies about their contents.
5. Reload the page, open a session, and drop a file larger than 25 MB. Confirm `could not attach …: file too large` appears under the composer and the prompt box is unchanged.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS, 63 tests. Nothing in Task 2 is server-side, so this is a regression check only.

- [ ] **Step 6: Commit**

```bash
git add web/index.html web/app.js web/style.css
git commit -m "feat: attach files from the chat composer"
```

---

## Self-Review

**Spec coverage:** Route shape, guards, session lookup, name validation, size cap, write location — Task 1. File picker, drag-drop, path appending, error surfacing — Task 2. Both spec tests — Task 1 Step 1. The spec's two out-of-scope items (new-session dialog attach, transcript attachment chips) appear in no task, which is correct.

**Placeholders:** None. Every code step carries the literal code; every run step names the command and the expected result.

**Type consistency:** Task 1 produces `{ path: string }` from `POST /upload?id&name`; Task 2 destructures `path` from exactly that response and calls exactly that URL. `originOk(req: IncomingMessage): boolean` is defined once in Task 1 and used at both of its call sites there. `registry.get()` and `session.cwd` match `src/sessions.ts` and `src/types.ts` as they exist today.

**One risk to watch:** Task 1 Step 3 edits the `/command` Origin check in place. If the existing comment block is deleted rather than kept, the reason that check exists is lost — the review gate for Task 1 should check that the comment survived.
