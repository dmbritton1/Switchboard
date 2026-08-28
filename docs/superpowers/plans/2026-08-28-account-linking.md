# Account Linking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user link any combination of Claude and Codex accounts from the browser by clicking a button and approving in the provider's own OAuth page, instead of running CLI logins by hand and editing `accounts.json`.

**Architecture:** Switchboard implements no OAuth. It spawns each provider's own CLI login as a child process with an isolated credential directory, scrapes the authorize URL out of the child's output, relays it to the browser, relays a pasted code back into the child's stdin (Claude only), and commits the resulting credentials from a staging directory into `accounts.json` only after reading back who was linked. A `Linker` state machine owns the child; the server owns persistence; `web/lib.js` owns the view model.

**Tech Stack:** Node 22.18+ running TypeScript directly (no build step), `node:test` + `node:assert`, native `node:http` SSE, vanilla ES modules in `web/`.

**Spec:** `docs/superpowers/specs/2026-08-28-account-linking-design.md`

## Global Constraints

- **Node >= 22.18.** TypeScript runs directly. No build step, no transpiler, no new dependencies.
- **`npm test` must stay offline.** No paid, networked, or real-account tests. No test may bind port 1455, open a browser, or spawn a real `claude`/`codex` binary.
- **Account env values are launch-only secrets.** Never persist, log, return over SSE, or render them. This includes every staging and credential directory path.
- **The pasted authorization code** goes browser → POST → child stdin and stops there. Never logged, never in `snapshot()`, never persisted.
- **Never delete a directory outside the accounts root.** Only ever `rm -rf` a path that is exactly `<accountsRoot>/<name>`.
- **Codex safety overrides are untouchable.** `sandboxMode: 'workspace-write'` and `approvalPolicy: 'never'` stay mandatory. This feature adds no interactive approval path.
- **No new CSS colors.** `test/palette.test.ts` parses `web/style.css` and asserts contrast across ten accents × twelve canvases. Use existing tokens only; a hardcoded hex fails the suite.
- **Account name grammar:** `/^[a-z0-9][a-z0-9-]{0,31}$/`, unique among existing account names.
- **Default budget for a linked account:** `2_000_000`.
- **Run `npm test` before declaring any task complete.**

---

### Task 1: Account store — load, append, remove

**Files:**
- Create: `src/accounts.ts`
- Create: `test/accounts.test.ts`
- Modify: `src/server.ts:29-35` (move the `Account` type), `src/server.ts:1186-1189` (tolerate a missing file)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Account = { name: string; provider: 'claude' | 'codex'; budget: number; env: Record<string, string>; bin?: string }` — moved from `src/server.ts`, re-exported there so existing importers keep working.
  - `const DEFAULT_BUDGET = 2_000_000`
  - `const ACCOUNT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/`
  - `function validateAccountName(name: unknown, existing: Account[]): string | null` — returns an error message, or `null` when valid.
  - `function loadAccounts(path: string): Promise<Account[]>`
  - `type AccountStore = { append(entry: Account): Promise<void>; remove(name: string): Promise<void> }`
  - `function createAccountStore(path: string): AccountStore`

- [ ] **Step 1: Write the failing tests**

Create `test/accounts.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadAccounts, createAccountStore, validateAccountName, DEFAULT_BUDGET,
  type Account,
} from '../src/accounts.ts';

async function dir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'switchboard-accounts-'));
}

const claude = (name: string): Account => ({
  name, provider: 'claude', budget: DEFAULT_BUDGET, env: {},
});

test('a missing accounts.json loads as an empty list', async () => {
  const d = await dir();
  assert.deepEqual(await loadAccounts(join(d, 'accounts.json')), []);
  await rm(d, { recursive: true, force: true });
});

test('a malformed accounts.json throws rather than silently emptying the list', async () => {
  const d = await dir();
  const path = join(d, 'accounts.json');
  await writeFile(path, '{ not json');
  await assert.rejects(() => loadAccounts(path));
  await rm(d, { recursive: true, force: true });
});

test('append writes an entry and preserves the ones already there', async () => {
  const d = await dir();
  const path = join(d, 'accounts.json');
  await writeFile(path, JSON.stringify([claude('claude-main')]));
  await createAccountStore(path).append(claude('claude-alt'));
  const written = JSON.parse(await readFile(path, 'utf8')) as Account[];
  assert.deepEqual(written.map((a) => a.name), ['claude-main', 'claude-alt']);
  await rm(d, { recursive: true, force: true });
});

// The append-only rule from the spec. accounts.json is hand-editable and the
// app parks for minutes waiting on a browser, so a concurrent edit is
// realistic. Appending must merge onto what is on disk NOW, not overwrite it
// with a stale array.
test('append merges onto a concurrent hand edit rather than clobbering it', async () => {
  const d = await dir();
  const path = join(d, 'accounts.json');
  await writeFile(path, JSON.stringify([claude('claude-main')]));
  const store = createAccountStore(path);
  // Someone edits the file while a link is in flight.
  await writeFile(path, JSON.stringify([
    { ...claude('claude-main'), budget: 3_000_000 },
    claude('hand-added'),
  ]));
  await store.append(claude('claude-new'));
  const written = JSON.parse(await readFile(path, 'utf8')) as Account[];
  assert.deepEqual(written.map((a) => a.name), ['claude-main', 'hand-added', 'claude-new']);
  assert.equal(written[0].budget, 3_000_000);
  await rm(d, { recursive: true, force: true });
});

test('remove drops one entry by name and leaves the rest', async () => {
  const d = await dir();
  const path = join(d, 'accounts.json');
  await writeFile(path, JSON.stringify([claude('a'), claude('b'), claude('c')]));
  await createAccountStore(path).remove('b');
  const written = JSON.parse(await readFile(path, 'utf8')) as Account[];
  assert.deepEqual(written.map((x) => x.name), ['a', 'c']);
  await rm(d, { recursive: true, force: true });
});

test('remove of a name already gone by hand is a no-op, not an error', async () => {
  const d = await dir();
  const path = join(d, 'accounts.json');
  await writeFile(path, JSON.stringify([claude('a')]));
  await createAccountStore(path).remove('gone');
  const written = JSON.parse(await readFile(path, 'utf8')) as Account[];
  assert.deepEqual(written.map((x) => x.name), ['a']);
  await rm(d, { recursive: true, force: true });
});

test('concurrent appends both land', async () => {
  const d = await dir();
  const path = join(d, 'accounts.json');
  await writeFile(path, JSON.stringify([]));
  const store = createAccountStore(path);
  await Promise.all([store.append(claude('one')), store.append(claude('two'))]);
  const written = JSON.parse(await readFile(path, 'utf8')) as Account[];
  assert.deepEqual(written.map((a) => a.name).sort(), ['one', 'two']);
  await rm(d, { recursive: true, force: true });
});

test('append leaves no temp file behind', async () => {
  const d = await dir();
  const path = join(d, 'accounts.json');
  await writeFile(path, JSON.stringify([]));
  await createAccountStore(path).append(claude('one'));
  await assert.rejects(() => readFile(`${path}.tmp`, 'utf8'));
  await rm(d, { recursive: true, force: true });
});

test('validateAccountName rejects everything that could escape the accounts root', () => {
  const existing = [claude('taken')];
  for (const bad of ['', '..', '.', 'a/b', '../evil', 'UPPER', '-leading', 'a'.repeat(33), 'sp ace']) {
    assert.equal(typeof validateAccountName(bad, existing), 'string', `expected ${bad} rejected`);
  }
  assert.equal(typeof validateAccountName(42, existing), 'string');
  assert.equal(typeof validateAccountName('taken', existing), 'string');
  assert.equal(validateAccountName('claude-alt2', existing), null);
  assert.equal(validateAccountName('a', existing), null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --test-name-pattern='account'`
Expected: FAIL — `Cannot find module '../src/accounts.ts'`.

- [ ] **Step 3: Write the implementation**

Create `src/accounts.ts`:

```ts
import { readFile, writeFile, rename } from 'node:fs/promises';

export type Account = {
  name: string;
  provider: 'claude' | 'codex';
  budget: number;
  env: Record<string, string>;
  bin?: string;
};

export const DEFAULT_BUDGET = 2_000_000;

/** An account name becomes a directory under the accounts root, so this is a
 *  trust boundary, not a cosmetic rule: the browser supplies the name. Same
 *  posture as the upload handler (src/server.ts) — reject what we would have
 *  had to rewrite rather than rewriting it silently. */
export const ACCOUNT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function validateAccountName(name: unknown, existing: Account[]): string | null {
  if (typeof name !== 'string') return 'name must be a string';
  if (!ACCOUNT_NAME_RE.test(name)) {
    return 'name must be 1-32 characters of lowercase letters, digits or hyphens, and start with a letter or digit';
  }
  if (existing.some((a) => a.name === name)) return `an account named ${name} already exists`;
  return null;
}

/** A missing file is the first-run case and loads as an empty list. Malformed
 *  JSON is NOT: that is a hand-edit the user needs told about, and silently
 *  starting with zero accounts would look like their accounts vanished. */
export async function loadAccounts(path: string): Promise<Account[]> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`${path} must contain a JSON array`);
  return parsed as Account[];
}

export type AccountStore = {
  append(entry: Account): Promise<void>;
  remove(name: string): Promise<void>;
};

/**
 * Both mutators are read-modify-write, never a blind write of an in-memory
 * array. accounts.json is hand-editable and a link parks for minutes waiting on
 * a browser, so an edit made in that window has to survive — see the
 * append-only rule in the design doc.
 *
 * Writes are serialized behind one chain and use a temp file next to the
 * destination, mirroring Registry#save (src/sessions.ts): two concurrent writes
 * to the same temp path would race each other's rename.
 */
export function createAccountStore(path: string): AccountStore {
  let chain: Promise<void> = Promise.resolve();

  const mutate = (fn: (current: Account[]) => Account[]): Promise<void> => {
    const next = chain.then(async () => {
      const current = await loadAccounts(path);
      const tmp = `${path}.tmp`;
      await writeFile(tmp, `${JSON.stringify(fn(current), null, 2)}\n`);
      await rename(tmp, path);
    });
    // The chain link always resolves so one failed write cannot wedge every
    // write after it; the rejection still reaches this call's caller.
    chain = next.catch(() => {});
    return next;
  };

  return {
    append: (entry) => mutate((current) => [...current, entry]),
    remove: (name) => mutate((current) => current.filter((a) => a.name !== name)),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- --test-name-pattern='account'`
Expected: PASS, all nine.

- [ ] **Step 5: Re-export `Account` from the server and tolerate a missing file**

In `src/server.ts`, delete the local `Account` type at lines 29-35 and import it instead. Add to the existing import block near the other local imports:

```ts
import { type Account, loadAccounts } from './accounts.ts';
```

Re-export it so existing importers are unaffected:

```ts
export type { Account } from './accounts.ts';
```

Then replace the entry point's account read (`src/server.ts:1186-1189`):

```ts
  const accountsPath = new URL('../accounts.json', import.meta.url).pathname;
  const accounts = await loadAccounts(accountsPath);
```

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS. Nothing else should change — every existing reader calls `accounts.find(...)` at call time.

- [ ] **Step 7: Commit**

```bash
git add src/accounts.ts test/accounts.test.ts src/server.ts
git commit -m "feat: add read-modify-write account store"
```

---

### Task 2: Fake login CLI test helper

**Files:**
- Create: `test/helpers/fake-login.ts`
- Create: `test/fake-login.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `function writeFakeLoginCli(dir: string, options?: { provider?: 'claude' | 'codex'; mode?: 'ok' | 'no-prompt' | 'bad-code' | 'no-url' | 'slow'; email?: string | null }): Promise<string>` — writes an executable script and returns its path.

The helper mirrors `test/helpers/fake-codex.ts`: a real executable driven through a real process boundary, not a mock. This task exists on its own because every later link test depends on it behaving exactly like the measured CLIs, and a bug here would surface as a confusing failure three tasks later.

Behaviour by argv, matching what the real CLIs were measured doing:
- `auth login` (claude) — writes the URL to **stdout**, then unless `no-prompt` writes `Paste code here if prompted > ` and waits for a line on stdin.
- `login` (codex) — writes the URL to **stderr**, then exits 0 without reading stdin.
- `auth status --json` (claude) — prints an identity JSON object.
- `login status` (codex) — prints `Logged in using ChatGPT`.
- `auth logout` / `logout` — exits 0.

- [ ] **Step 1: Write the helper**

Create `test/helpers/fake-login.ts`:

```ts
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * A fake `claude` / `codex` executable for link tests. Mirrors
 * helpers/fake-codex.ts: a real script run through a real process boundary, so
 * stream parsing, stdin relay and exit handling are genuinely exercised.
 *
 * It never binds a port and never opens a browser — the real `codex login`
 * starts a server on 1455, and a test that did the same could not run offline
 * or in parallel.
 */
export async function writeFakeLoginCli(
  dir: string,
  options: {
    provider?: 'claude' | 'codex';
    mode?: 'ok' | 'no-prompt' | 'bad-code' | 'no-url' | 'slow';
    email?: string | null;
  } = {},
): Promise<string> {
  const provider = options.provider ?? 'claude';
  const mode = options.mode ?? 'ok';
  const email = options.email === undefined ? 'user@example.com' : options.email;
  const path = join(dir, `fake-${provider}-login`);

  const url = provider === 'claude'
    ? 'https://claude.com/cai/oauth/authorize?code=true&client_id=fake&state=abc'
    : 'https://auth.openai.com/oauth/authorize?client_id=fake&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=abc';

  const source = `#!/usr/bin/env node
const { writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
const provider = ${JSON.stringify(provider)};
const mode = ${JSON.stringify(mode)};
const email = ${JSON.stringify(email)};
const url = ${JSON.stringify(url)};

const home = provider === 'claude' ? process.env.CLAUDE_CONFIG_DIR : process.env.CODEX_HOME;

function b64url(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function writeCredentials() {
  mkdirSync(home, { recursive: true });
  if (provider === 'claude') {
    writeFileSync(join(home, '.claude.json'), JSON.stringify({
      oauthAccount: email ? { emailAddress: email } : {},
    }));
    return;
  }
  const tokens = email === null
    ? { access_token: 'fake-access', account_id: 'acct_fake' }
    : { id_token: 'h.' + b64url({ email, email_verified: true }) + '.sig',
        access_token: 'fake-access', account_id: 'acct_fake' };
  writeFileSync(join(home, 'auth.json'), JSON.stringify({
    auth_mode: email === null ? 'apikey' : 'chatgpt',
    tokens,
    last_refresh: '2026-08-28T00:00:00Z',
  }));
}

// --- status / logout -------------------------------------------------------
if (provider === 'claude' && args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write(JSON.stringify({
    loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty',
    ...(email ? { email } : {}), subscriptionType: 'pro',
  }) + '\\n');
  process.exit(0);
}
if (provider === 'codex' && args[0] === 'login' && args[1] === 'status') {
  process.stdout.write('Logged in using ChatGPT\\n');
  process.exit(0);
}
if (args.includes('logout')) process.exit(0);

// --- login -----------------------------------------------------------------
const isLogin = provider === 'claude'
  ? args[0] === 'auth' && args[1] === 'login'
  : args[0] === 'login';
if (!isLogin) {
  process.stderr.write('unexpected invocation: ' + args.join(' ') + '\\n');
  process.exit(2);
}
if (!home) {
  process.stderr.write('missing credential dir env\\n');
  process.exit(2);
}

if (mode === 'no-url') {
  // Emits a decoy on a host the scraper must ignore, then hangs.
  process.stdout.write('visit https://example.com/not-oauth for help\\n');
  setInterval(() => {}, 1000);
} else if (mode === 'slow') {
  setTimeout(() => {
    process.stdout.write(url + '\\n');
    writeCredentials();
    process.exit(0);
  }, 2000);
} else if (provider === 'codex') {
  process.stderr.write('Starting local login server on http://localhost:1455.\\n');
  process.stderr.write('If your browser did not open, navigate to this URL:\\n\\n' + url + '\\n');
  writeCredentials();
  process.exit(0);
} else {
  process.stdout.write('Opening browser to sign in\\u2026\\n');
  process.stdout.write("If the browser didn't open, visit: " + url + '\\n');
  if (mode === 'no-prompt') {
    writeCredentials();
    process.exit(0);
  }
  process.stdout.write('Paste code here if prompted > ');
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    const line = buf.split('\\n')[0];
    if (!buf.includes('\\n')) return;
    if (mode === 'bad-code' || line.trim() !== 'good-code') {
      process.stderr.write('invalid authorization code\\n');
      process.exit(1);
    }
    writeCredentials();
    process.exit(0);
  });
}
`;

  await writeFile(path, source);
  await chmod(path, 0o755);
  return path;
}
```

- [ ] **Step 2: Write tests proving the helper behaves like the measured CLIs**

Create `test/fake-login.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { writeFakeLoginCli } from './helpers/fake-login.ts';

function collect(
  bin: string, args: string[], env: Record<string, string>, stdin?: string,
): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env: { ...process.env, ...env } });
    let out = '', err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    if (stdin !== undefined) child.stdin.write(stdin);
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

test('the claude fake prints its URL on stdout and waits for a code', async () => {
  const d = await mkdtemp(join(tmpdir(), 'fake-login-'));
  const bin = await writeFakeLoginCli(d, { provider: 'claude' });
  const home = join(d, 'cfg');
  const r = await collect(bin, ['auth', 'login'], { CLAUDE_CONFIG_DIR: home }, 'good-code\n');
  assert.equal(r.code, 0);
  assert.match(r.out, /https:\/\/claude\.com\/cai\/oauth\/authorize/);
  assert.match(r.out, /Paste code here/);
  assert.ok(JSON.parse(await readFile(join(home, '.claude.json'), 'utf8')).oauthAccount.emailAddress);
  await rm(d, { recursive: true, force: true });
});

test('the codex fake prints its URL on stderr and needs no code', async () => {
  const d = await mkdtemp(join(tmpdir(), 'fake-login-'));
  const bin = await writeFakeLoginCli(d, { provider: 'codex' });
  const home = join(d, 'cfg');
  const r = await collect(bin, ['login'], { CODEX_HOME: home });
  assert.equal(r.code, 0);
  assert.equal(r.out, '');
  assert.match(r.err, /https:\/\/auth\.openai\.com\/oauth\/authorize/);
  const auth = JSON.parse(await readFile(join(home, 'auth.json'), 'utf8'));
  assert.ok(auth.tokens.id_token);
  await rm(d, { recursive: true, force: true });
});

test('a bad code exits nonzero and writes no credentials', async () => {
  const d = await mkdtemp(join(tmpdir(), 'fake-login-'));
  const bin = await writeFakeLoginCli(d, { provider: 'claude', mode: 'bad-code' });
  const home = join(d, 'cfg');
  const r = await collect(bin, ['auth', 'login'], { CLAUDE_CONFIG_DIR: home }, 'whatever\n');
  assert.equal(r.code, 1);
  await assert.rejects(() => readFile(join(home, '.claude.json'), 'utf8'));
  await rm(d, { recursive: true, force: true });
});

test('email: null produces an api-key style auth.json with no id_token', async () => {
  const d = await mkdtemp(join(tmpdir(), 'fake-login-'));
  const bin = await writeFakeLoginCli(d, { provider: 'codex', email: null });
  const home = join(d, 'cfg');
  await collect(bin, ['login'], { CODEX_HOME: home });
  const auth = JSON.parse(await readFile(join(home, 'auth.json'), 'utf8'));
  assert.equal(auth.tokens.id_token, undefined);
  assert.equal(auth.auth_mode, 'apikey');
  await rm(d, { recursive: true, force: true });
});
```

- [ ] **Step 3: Run the tests**

Run: `npm test -- --test-name-pattern='fake'`
Expected: PASS, all four.

- [ ] **Step 4: Commit**

```bash
git add test/helpers/fake-login.ts test/fake-login.test.ts
git commit -m "test: add fake login CLI helper"
```

---

### Task 3: Codex runtime — resolve a binary without asserting auth

**Files:**
- Modify: `src/agents/codex-runtime.ts:50-60` (`CodexRuntimeDeps`), `:284-302` (`prepareCandidate`), `:318-360` (`prepareCodexRuntime`)
- Modify: `test/codex-runtime.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `CodexRuntimeDeps` gains `requireAuth?: boolean` (default `true`). `prepareCodexRuntime(account, { requireAuth: false })` resolves and version-checks a binary without running `login status`.

**Why:** `prepareCandidate` calls `assertAuthentication` on all three resolution paths, so `prepareCodexRuntime` against the fresh, empty `CODEX_HOME` every link starts with throws `codex_auth_unavailable` — the exact state linking exists to fix. The ChatGPT fallback rethrows that code rather than continuing to the SDK binary (`:355`), so it cannot recover either. Without this task, Codex linking fails 100% of the time.

- [ ] **Step 1: Write the failing tests**

Append to `test/codex-runtime.test.ts` (it already imports `writeFakeCodex`, `mkdtemp`, `assert`):

```ts
test('requireAuth false resolves a logged-out binary instead of throwing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-runtime-'));
  const bin = await writeFakeCodex(dir, { login: 'logged-out' });
  const runtime = await prepareCodexRuntime(
    { bin, env: {} },
    { platform: 'darwin', sdkVersion: '0.145.0', requireAuth: false },
  );
  assert.equal(runtime.commandPath, bin);
  assert.equal(runtime.source, 'explicit');
});

test('requireAuth false still rejects a version-mismatched binary', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-runtime-'));
  const bin = await writeFakeCodex(dir, { version: '0.146.0', login: 'logged-out' });
  await assert.rejects(
    () => prepareCodexRuntime(
      { bin, env: {} },
      { platform: 'darwin', sdkVersion: '0.145.0', requireAuth: false },
    ),
    (error: Error) => (error as CodexRuntimeError).code === 'codex_version_mismatch',
  );
});

test('requireAuth defaults to true, so a logged-out binary still fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-runtime-'));
  const bin = await writeFakeCodex(dir, { login: 'logged-out' });
  await assert.rejects(
    () => prepareCodexRuntime({ bin, env: {} }, { platform: 'darwin', sdkVersion: '0.145.0' }),
    (error: Error) => (error as CodexRuntimeError).code === 'codex_auth_unavailable',
  );
});
```

- [ ] **Step 2: Run to verify the first two fail**

Run: `npm test -- --test-name-pattern='requireAuth'`
Expected: the two `requireAuth false` tests FAIL with `codex_auth_unavailable`; the default-true test PASSES already.

- [ ] **Step 3: Thread the flag through**

In `src/agents/codex-runtime.ts`, add to `CodexRuntimeDeps`:

```ts
  /** Skip the `login status` preflight. Account linking sets this false: it
   *  runs against a fresh, empty credential dir, where an auth check would
   *  always fail on the one path that exists to create those credentials.
   *  Version and executability checks still run. */
  requireAuth?: boolean;
```

Add a parameter to `prepareCandidate`, after `diagnostics`:

```ts
async function prepareCandidate(
  path: string,
  source: 'explicit' | 'chatgpt' | 'sdk',
  sdkVersion: string,
  env: Record<string, string>,
  runFile: NonNullable<CodexRuntimeDeps['runFile']>,
  diagnostics: string[],
  requireAuth: boolean,
): Promise<PreparedCodexRuntime> {
  await assertCandidateFile(path, source);
  const version = await readCompatibleVersion(path, source, sdkVersion, env, runFile);
  if (requireAuth) await assertAuthentication(path, env, diagnostics, runFile);
  return {
```

In `prepareCodexRuntime`, read the flag once and pass it at all three call sites:

```ts
  const requireAuth = deps.requireAuth ?? true;
```

```ts
  if (safeAccount.bin !== undefined) {
    return prepareCandidate(safeAccount.bin, 'explicit', sdkVersion, env, runFile, diagnostics, requireAuth);
  }

  const chatgptPath = deps.chatgptPath ?? CHATGPT_PATH;
  try {
    return await prepareCandidate(chatgptPath, 'chatgpt', sdkVersion, env, runFile, diagnostics, requireAuth);
  } catch (error) {
    if (!(error instanceof CodexRuntimeError) || error.code === 'codex_auth_unavailable') throw error;
    diagnostics.push(chatgptDiagnostic(error, chatgptPath, sdkVersion));
  }

  const bundledPath = deps.bundledPath ?? defaultBundledPath();
  return prepareCandidate(bundledPath, 'sdk', sdkVersion, env, runFile, diagnostics, requireAuth);
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS. The default is `true`, so no existing caller changes behavior.

- [ ] **Step 5: Commit**

```bash
git add src/agents/codex-runtime.ts test/codex-runtime.test.ts
git commit -m "feat: allow Codex binary resolution without an auth preflight"
```

---

### Task 4: Linker — spawn, capture the URL, expose phases

**Files:**
- Create: `src/link.ts`
- Create: `test/link.test.ts`

**Interfaces:**
- Consumes: `Account`, `DEFAULT_BUDGET` from Task 1; `writeFakeLoginCli` from Task 2.
- Produces:
  - `type LinkPhase = 'starting' | 'awaiting-user' | 'verifying' | 'naming' | 'error'`
  - `type LinkIdentity = { email: string; subscription: string | null }`
  - `type PublicLink = { provider: 'claude' | 'codex'; phase: LinkPhase; url: string | null; codeRequested: boolean; identity: LinkIdentity | null; suggestedName: string | null; error: string | null }`
  - `type SpawnLogin = (provider: 'claude' | 'codex', env: Record<string, string>) => ChildProcess`
  - `type LinkerOptions = { accountsRoot: string; spawnLogin?: SpawnLogin; urlTimeoutMs?: number; overallTimeoutMs?: number }`
  - `class Linker` with `subscribe(fn: () => void): () => void`, `snapshot(): PublicLink | null`, `start(provider: 'claude' | 'codex'): Promise<{ error?: string }>`

This task lands the machine as far as `awaiting-user`. Tasks 5 and 6 add the code relay, identity readback, and commit.

- [ ] **Step 1: Write the failing tests**

Create `test/link.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Linker, type SpawnLogin } from '../src/link.ts';
import { writeFakeLoginCli } from './helpers/fake-login.ts';

async function harness(options: {
  provider?: 'claude' | 'codex';
  mode?: 'ok' | 'no-prompt' | 'bad-code' | 'no-url' | 'slow';
  email?: string | null;
  urlTimeoutMs?: number;
  overallTimeoutMs?: number;
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'switchboard-link-'));
  const provider = options.provider ?? 'claude';
  const bin = await writeFakeLoginCli(dir, { provider, mode: options.mode, email: options.email });
  const spawnLogin: SpawnLogin = (_p, env) =>
    spawn(bin, provider === 'claude' ? ['auth', 'login'] : ['login'], {
      env: { ...process.env, ...env },
    });
  const linker = new Linker({
    accountsRoot: join(dir, 'accounts'),
    spawnLogin,
    urlTimeoutMs: options.urlTimeoutMs ?? 5000,
    overallTimeoutMs: options.overallTimeoutMs ?? 10_000,
  });
  return { dir, linker, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** Resolves when the snapshot satisfies `predicate`, or rejects after 5s. */
function until(linker: Linker, predicate: (link: ReturnType<Linker['snapshot']>) => boolean) {
  return new Promise<void>((resolve, reject) => {
    const check = () => {
      if (!predicate(linker.snapshot())) return false;
      unsub(); clearTimeout(timer); resolve(); return true;
    };
    const timer = setTimeout(() => { unsub(); reject(new Error('timed out waiting for phase')); }, 5000);
    const unsub = linker.subscribe(() => { check(); });
    check();
  });
}

test('a claude link reaches awaiting-user with the URL from stdout', async () => {
  const h = await harness({ provider: 'claude' });
  await h.linker.start('claude');
  await until(h.linker, (l) => l?.phase === 'awaiting-user');
  const link = h.linker.snapshot();
  assert.equal(link?.provider, 'claude');
  assert.match(link?.url ?? '', /^https:\/\/claude\.com\/cai\/oauth\/authorize/);
  await h.linker.cancel();
  await h.cleanup();
});

test('a codex link reaches awaiting-user with the URL from stderr', async () => {
  const h = await harness({ provider: 'codex' });
  await h.linker.start('codex');
  await until(h.linker, (l) => l?.phase === 'awaiting-user' || l?.phase === 'verifying');
  assert.match(h.linker.snapshot()?.url ?? '', /^https:\/\/auth\.openai\.com\/oauth\/authorize/);
  await h.linker.cancel();
  await h.cleanup();
});

test('a decoy URL on an unexpected host is ignored', async () => {
  const h = await harness({ mode: 'no-url', urlTimeoutMs: 700 });
  await h.linker.start('claude');
  await until(h.linker, (l) => l?.phase === 'error');
  assert.equal(h.linker.snapshot()?.url, null);
  assert.match(h.linker.snapshot()?.error ?? '', /did not print a sign-in URL/);
  await h.cleanup();
});

test('starting a second link while one is pending is refused', async () => {
  const h = await harness();
  await h.linker.start('claude');
  await until(h.linker, (l) => l?.phase === 'awaiting-user');
  const second = await h.linker.start('claude');
  assert.match(second.error ?? '', /already in progress/);
  await h.linker.cancel();
  await h.cleanup();
});

test('cancel kills the child, clears the snapshot and removes staging', async () => {
  const h = await harness();
  await h.linker.start('claude');
  await until(h.linker, (l) => l?.phase === 'awaiting-user');
  await h.linker.cancel();
  assert.equal(h.linker.snapshot(), null);
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual(await readdir(join(h.dir, 'accounts')).catch(() => []), []);
  await h.cleanup();
});

test('subscribers are notified on every phase change and stop after unsubscribe', async () => {
  const h = await harness();
  let calls = 0;
  const unsub = h.linker.subscribe(() => { calls += 1; });
  await h.linker.start('claude');
  await until(h.linker, (l) => l?.phase === 'awaiting-user');
  assert.ok(calls >= 2, `expected >= 2 notifications, got ${calls}`);
  unsub();
  const before = calls;
  await h.linker.cancel();
  assert.equal(calls, before);
  await h.cleanup();
});
```

- [ ] **Step 2: Run to verify the tests fail**

Run: `npm test -- --test-name-pattern='link'`
Expected: FAIL — `Cannot find module '../src/link.ts'`.

- [ ] **Step 3: Write the implementation**

Create `src/link.ts`:

```ts
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { prepareCodexRuntime } from './agents/codex-runtime.ts';

export type LinkProvider = 'claude' | 'codex';
export type LinkPhase = 'starting' | 'awaiting-user' | 'verifying' | 'naming' | 'error';
export type LinkIdentity = { email: string; subscription: string | null };

export type PublicLink = {
  provider: LinkProvider;
  phase: LinkPhase;
  url: string | null;
  codeRequested: boolean;
  identity: LinkIdentity | null;
  suggestedName: string | null;
  error: string | null;
};

export type SpawnLogin = (provider: LinkProvider, env: Record<string, string>) => ChildProcess;

export type LinkerOptions = {
  accountsRoot: string;
  spawnLogin?: SpawnLogin;
  urlTimeoutMs?: number;
  overallTimeoutMs?: number;
};

/**
 * Anchored to the two hosts the real CLIs were measured using. A bare
 * `https://\S+` would let a stray URL in an update notice or a warning hijack
 * the flow, and the thing it would hijack is where we send the user to type
 * their password.
 */
const AUTH_URL = /https:\/\/(?:claude\.com|auth\.openai\.com)\/\S*oauth\S*/;

/** The Claude CLI's own prompt. Detected rather than assumed from the provider:
 *  it hedges with "if prompted", so the branch where it completes without
 *  asking is real, and discovering the prompt handles both with no special
 *  case. */
const CODE_PROMPT = /Paste code here/;

const MAX_OUTPUT_TAIL = 8 * 1024;

export const CREDENTIAL_ENV: Record<LinkProvider, string> = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
};

async function defaultSpawnLogin(
  provider: LinkProvider,
  env: Record<string, string>,
): Promise<ChildProcess> {
  if (provider === 'claude') {
    return spawn('claude', ['auth', 'login'], { env: { ...process.env, ...env } });
  }
  // requireAuth: false — this runs against the fresh, empty CODEX_HOME the link
  // is about to populate, where the usual `login status` preflight would always
  // fail. Version and executability checks still run.
  const runtime = await prepareCodexRuntime({ env }, { requireAuth: false });
  return spawn(runtime.commandPath, ['login'], { env: { ...process.env, ...env } });
}

type Pending = {
  provider: LinkProvider;
  phase: LinkPhase;
  url: string | null;
  codeRequested: boolean;
  identity: LinkIdentity | null;
  suggestedName: string | null;
  error: string | null;
  staging: string;
  child: ChildProcess;
  tail: string;
  urlTimer: ReturnType<typeof setTimeout> | null;
  overallTimer: ReturnType<typeof setTimeout> | null;
};

export class Linker {
  #subs = new Set<() => void>();
  #pending: Pending | null = null;
  readonly #root: string;
  readonly #spawn: SpawnLogin | undefined;
  readonly #urlTimeoutMs: number;
  readonly #overallTimeoutMs: number;

  constructor(options: LinkerOptions) {
    this.#root = options.accountsRoot;
    this.#spawn = options.spawnLogin;
    this.#urlTimeoutMs = options.urlTimeoutMs ?? 30_000;
    this.#overallTimeoutMs = options.overallTimeoutMs ?? 300_000;
  }

  // Mirrors Registry's and Scheduler's #subs/#notify exactly: same shape, so
  // the /events route can treat all three sources the same way.
  subscribe(fn: () => void): () => void {
    this.#subs.add(fn);
    return () => this.#subs.delete(fn);
  }

  #notify(): void {
    for (const fn of this.#subs) fn();
  }

  /** Never exposes the staging path, the child's pid, or raw child output —
   *  the staging path becomes an account env value, which must never reach the
   *  browser. */
  snapshot(): PublicLink | null {
    const p = this.#pending;
    if (!p) return null;
    return {
      provider: p.provider, phase: p.phase, url: p.url,
      codeRequested: p.codeRequested, identity: p.identity,
      suggestedName: p.suggestedName, error: p.error,
    };
  }

  /** The credential dir for the in-flight link. Server-side only. */
  stagingDir(): string | null {
    return this.#pending?.staging ?? null;
  }

  get root(): string {
    return this.#root;
  }

  async start(provider: LinkProvider): Promise<{ error?: string }> {
    if (this.#pending) return { error: 'a link is already in progress' };
    if (provider !== 'claude' && provider !== 'codex') return { error: 'unknown provider' };

    await mkdir(this.#root, { recursive: true });
    const staging = await mkdtemp(join(this.#root, `.pending-${randomUUID().slice(0, 8)}-`));
    const env = { [CREDENTIAL_ENV[provider]]: staging };

    let child: ChildProcess;
    try {
      child = this.#spawn ? this.#spawn(provider, env) : await defaultSpawnLogin(provider, env);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      return { error: String((error as Error).message ?? error) };
    }

    const pending: Pending = {
      provider, phase: 'starting', url: null, codeRequested: false,
      identity: null, suggestedName: null, error: null,
      staging, child, tail: '', urlTimer: null, overallTimer: null,
    };
    this.#pending = pending;

    pending.urlTimer = setTimeout(() => {
      void this.#fail('The sign-in command did not print a sign-in URL.');
    }, this.#urlTimeoutMs);
    pending.overallTimer = setTimeout(() => {
      void this.#fail('The sign-in timed out. Start it again when you are ready.');
    }, this.#overallTimeoutMs);

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.#onOutput(chunk, true));
    child.stderr?.on('data', (chunk: string) => this.#onOutput(chunk, false));
    child.on('error', (error) => { void this.#fail(String(error.message)); });
    child.on('close', (code) => this.#onClose(code));

    this.#notify();
    return {};
  }

  #onOutput(chunk: string, isStdout: boolean): void {
    const p = this.#pending;
    if (!p) return;
    p.tail = (p.tail + chunk).slice(-MAX_OUTPUT_TAIL);

    let changed = false;
    if (!p.url) {
      const match = AUTH_URL.exec(chunk);
      if (match) {
        p.url = match[0];
        p.phase = 'awaiting-user';
        if (p.urlTimer) { clearTimeout(p.urlTimer); p.urlTimer = null; }
        changed = true;
      }
    }
    // Only stdout carries the prompt, and only Claude emits one.
    if (isStdout && !p.codeRequested && CODE_PROMPT.test(chunk)) {
      p.codeRequested = true;
      changed = true;
    }
    if (changed) this.#notify();
  }

  /** Overridden in Task 5 to run identity readback. Here it only marks the
   *  terminal phases so the state machine is observable. */
  #onClose(code: number | null): void {
    const p = this.#pending;
    if (!p) return;
    if (code === 0) {
      p.phase = 'verifying';
      this.#notify();
      return;
    }
    void this.#fail(this.redact(`The sign-in command exited with code ${code}.`));
  }

  /** Removes any value that could identify the staging directory before text
   *  reaches the browser. */
  redact(text: string): string {
    const staging = this.#pending?.staging;
    return staging ? text.split(staging).join('[credential dir]') : text;
  }

  async #fail(message: string): Promise<void> {
    const p = this.#pending;
    if (!p) return;
    this.#clearTimers(p);
    p.child.kill('SIGTERM');
    await rm(p.staging, { recursive: true, force: true });
    p.phase = 'error';
    p.error = message;
    p.url = null;
    this.#notify();
  }

  #clearTimers(p: Pending): void {
    if (p.urlTimer) { clearTimeout(p.urlTimer); p.urlTimer = null; }
    if (p.overallTimer) { clearTimeout(p.overallTimer); p.overallTimer = null; }
  }

  async cancel(): Promise<void> {
    const p = this.#pending;
    if (!p) return;
    this.#clearTimers(p);
    p.child.kill('SIGTERM');
    this.#pending = null;
    await rm(p.staging, { recursive: true, force: true });
    this.#notify();
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- --test-name-pattern='link'`
Expected: PASS, all six.

- [ ] **Step 5: Commit**

```bash
git add src/link.ts test/link.test.ts
git commit -m "feat: add link state machine with URL capture"
```

---

### Task 5: Linker — code relay, identity readback, naming

**Files:**
- Modify: `src/link.ts`
- Modify: `test/link.test.ts`

**Interfaces:**
- Consumes: everything from Task 4.
- Produces: `Linker` gains `submitCode(code: string): { error?: string }` and reaches `phase: 'naming'` with `identity` and `suggestedName` populated. Adds `readIdentity(provider, dir): Promise<LinkIdentity | null>` as an exported function so it can be tested directly.

- [ ] **Step 1: Write the failing tests**

Append to `test/link.test.ts`:

```ts
test('pasting a code completes a claude link and proposes a name', async () => {
  const h = await harness({ provider: 'claude', email: 'dwight@example.com' });
  await h.linker.start('claude');
  await until(h.linker, (l) => l?.codeRequested === true);
  assert.equal(h.linker.submitCode('good-code').error, undefined);
  await until(h.linker, (l) => l?.phase === 'naming');
  const link = h.linker.snapshot();
  assert.equal(link?.identity?.email, 'dwight@example.com');
  assert.equal(link?.suggestedName, 'claude-dwight');
  await h.linker.cancel();
  await h.cleanup();
});

test('a CLI that never prompts goes straight to naming', async () => {
  const h = await harness({ provider: 'claude', mode: 'no-prompt' });
  await h.linker.start('claude');
  await until(h.linker, (l) => l?.phase === 'naming');
  assert.equal(h.linker.snapshot()?.codeRequested, false);
  await h.linker.cancel();
  await h.cleanup();
});

test('a codex link decodes the email out of the id_token', async () => {
  const h = await harness({ provider: 'codex', email: 'dwight@example.com' });
  await h.linker.start('codex');
  await until(h.linker, (l) => l?.phase === 'naming');
  const link = h.linker.snapshot();
  assert.equal(link?.identity?.email, 'dwight@example.com');
  assert.equal(link?.identity?.subscription, null);
  assert.equal(link?.suggestedName, 'codex-dwight');
  await h.linker.cancel();
  await h.cleanup();
});

test('an auth.json with no id_token still links, with a bare provider name', async () => {
  const h = await harness({ provider: 'codex', email: null });
  await h.linker.start('codex');
  await until(h.linker, (l) => l?.phase === 'naming');
  const link = h.linker.snapshot();
  assert.equal(link?.identity, null);
  assert.equal(link?.suggestedName, 'codex');
  await h.linker.cancel();
  await h.cleanup();
});

test('a bad code fails the link and leaves no staging directory', async () => {
  const h = await harness({ provider: 'claude', mode: 'bad-code' });
  await h.linker.start('claude');
  await until(h.linker, (l) => l?.codeRequested === true);
  h.linker.submitCode('wrong');
  await until(h.linker, (l) => l?.phase === 'error');
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual(await readdir(join(h.dir, 'accounts')).catch(() => []), []);
  await h.cleanup();
});

test('submitCode is refused before the CLI has asked for one', async () => {
  const h = await harness({ provider: 'codex' });
  assert.match(h.linker.submitCode('x').error ?? '', /not waiting for a code/);
  await h.cleanup();
});

test('the submitted code never appears in the snapshot', async () => {
  const h = await harness({ provider: 'claude', mode: 'bad-code' });
  await h.linker.start('claude');
  await until(h.linker, (l) => l?.codeRequested === true);
  h.linker.submitCode('sentinel-secret-code');
  await until(h.linker, (l) => l?.phase === 'error');
  assert.ok(!JSON.stringify(h.linker.snapshot()).includes('sentinel-secret-code'));
  await h.cleanup();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- --test-name-pattern='link'`
Expected: the seven new tests FAIL — `submitCode` is not a function, and no link reaches `naming`.

- [ ] **Step 3: Add identity readback**

Add to `src/link.ts`, after the constants:

```ts
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runFile = promisify(execFile);

function emailFromIdToken(idToken: unknown): string | null {
  if (typeof idToken !== 'string') return null;
  const payload = idToken.split('.')[1];
  if (!payload) return null;
  try {
    // Decoded, never verified: this labels a file we wrote seconds ago, it does
    // not authenticate a request. Only `email` is read.
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as
      { email?: unknown };
    return typeof claims.email === 'string' ? claims.email : null;
  } catch {
    return null;
  }
}

/**
 * Who was just linked, or null when the provider exposes nobody.
 *
 * Null is not an error: a Codex auth.json can hold an API key with no
 * id_token, and a Console-authenticated Claude account reports no email. The
 * credentials are still valid, which is what matters — the caller falls back to
 * a numbered name and skips the duplicate check.
 */
export async function readIdentity(
  provider: LinkProvider,
  dir: string,
): Promise<LinkIdentity | null> {
  if (provider === 'codex') {
    try {
      const auth = JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8')) as
        { tokens?: { id_token?: unknown } };
      const email = emailFromIdToken(auth.tokens?.id_token);
      // Codex has no equivalent of subscriptionType, at any auth mode.
      return email ? { email, subscription: null } : null;
    } catch {
      return null;
    }
  }
  try {
    const { stdout } = await runFile('claude', ['auth', 'status', '--json'], {
      env: { ...process.env, [CREDENTIAL_ENV.claude]: dir },
    });
    const status = JSON.parse(stdout) as { email?: unknown; subscriptionType?: unknown };
    if (typeof status.email !== 'string') return null;
    return {
      email: status.email,
      subscription: typeof status.subscriptionType === 'string' ? status.subscriptionType : null,
    };
  } catch {
    return null;
  }
}

/** `dwight@example.com` on claude becomes `claude-dwight`. Falls back to the
 *  bare provider, then a numeric suffix, when there is no identity to derive
 *  from or the derived name is taken. */
export function suggestName(
  provider: LinkProvider,
  identity: LinkIdentity | null,
  existing: readonly { name: string }[],
): string {
  const local = identity?.email.split('@')[0]?.toLowerCase().replace(/[^a-z0-9-]/g, '-') ?? '';
  const base = local ? `${provider}-${local}`.slice(0, 32) : provider;
  const taken = new Set(existing.map((a) => a.name));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base}-${n}`.slice(0, 32);
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`.slice(0, 32);
}
```

- [ ] **Step 4: Wire readback into the machine**

The `Linker` needs to know the current account list to suggest a free name and to refuse a duplicate identity. Add it as a constructor option.

In `LinkerOptions`, add:

```ts
  /** Read at commit and suggest time, not captured at construction: the array
   *  is mutated in place as accounts are linked and unlinked. */
  accounts: () => readonly Account[];
```

Add `import type { Account } from './accounts.ts';` and store it:

```ts
  readonly #accounts: () => readonly Account[];
```
```ts
    this.#accounts = options.accounts;
```

Replace `#onClose` with the real one, and add `submitCode`:

```ts
  submitCode(code: string): { error?: string } {
    const p = this.#pending;
    if (!p) return { error: 'no link is in progress' };
    if (p.phase !== 'awaiting-user' || !p.codeRequested) {
      return { error: 'the sign-in is not waiting for a code' };
    }
    if (typeof code !== 'string' || !code.trim()) return { error: 'code is required' };
    // Straight to the child's stdin and nowhere else: never stored on the
    // pending link, never logged, never in snapshot().
    p.child.stdin?.write(`${code.trim()}\n`);
    return {};
  }

  #onClose(code: number | null): void {
    const p = this.#pending;
    if (!p) return;
    if (code !== 0) {
      void this.#fail(this.redact(
        `The sign-in command exited with code ${code}.${tailSuffix(this.redact(p.tail))}`,
      ));
      return;
    }
    p.phase = 'verifying';
    // A prompt still on screen must go away: the child is done either way.
    p.codeRequested = false;
    this.#notify();
    void this.#verify(p);
  }

  async #verify(p: Pending): Promise<void> {
    const identity = await readIdentity(p.provider, p.staging);
    if (this.#pending !== p) return;   // cancelled while readback was running
    if (identity) {
      const clash = this.#accounts().find(
        (a) => a.provider === p.provider && a.env.__identity === identity.email,
      );
      if (clash) {
        await this.#fail(`That account is already linked as ${clash.name}.`);
        return;
      }
    }
    this.#clearTimers(p);
    p.identity = identity;
    p.suggestedName = suggestName(p.provider, identity, this.#accounts());
    p.phase = 'naming';
    this.#notify();
  }
```

Add the tail helper beside the constants:

```ts
/** A bounded, whitespace-collapsed tail of child output, for error messages
 *  only. Mirrors detailSuffix() in agents/codex-runtime.ts. */
function tailSuffix(tail: string): string {
  const safe = tail.replace(/\s+/g, ' ').trim();
  return safe ? ` ${safe.slice(-400)}` : '';
}
```

- [ ] **Step 5: Store the identity for duplicate detection**

`#verify` compares against `a.env.__identity`, which nothing writes yet. That is deliberate: the entry is built in Task 6. For now, add the field to the `Account` type in `src/accounts.ts`:

```ts
export type Account = {
  name: string;
  provider: 'claude' | 'codex';
  budget: number;
  env: Record<string, string>;
  bin?: string;
};
```

becomes:

```ts
export type Account = {
  name: string;
  provider: 'claude' | 'codex';
  budget: number;
  env: Record<string, string>;
  bin?: string;
  /** Who this account belongs to, when the provider told us. Used only to stop
   *  the same account being linked twice under two names. Absent for
   *  hand-written entries and for auth modes that expose no identity. */
  identity?: string;
};
```

And change the `#verify` lookup to use it:

```ts
      const clash = this.#accounts().find(
        (a) => a.provider === p.provider && a.identity === identity.email,
      );
```

- [ ] **Step 6: Update the test harness to pass `accounts`**

In `test/link.test.ts`, add to the `harness` helper's `Linker` construction:

```ts
  const accounts: Account[] = [];
  const linker = new Linker({
    accountsRoot: join(dir, 'accounts'),
    accounts: () => accounts,
    spawnLogin,
    urlTimeoutMs: options.urlTimeoutMs ?? 5000,
    overallTimeoutMs: options.overallTimeoutMs ?? 10_000,
  });
  return { dir, linker, accounts, cleanup: () => rm(dir, { recursive: true, force: true }) };
```

Add `import type { Account } from '../src/accounts.ts';` at the top.

- [ ] **Step 7: Run the tests**

Run: `npm test -- --test-name-pattern='link'`
Expected: PASS, all thirteen.

- [ ] **Step 8: Commit**

```bash
git add src/link.ts src/accounts.ts test/link.test.ts
git commit -m "feat: add code relay and identity readback to the linker"
```

---

### Task 6: Linker — commit staging into a real account

**Files:**
- Modify: `src/link.ts`
- Modify: `test/link.test.ts`

**Interfaces:**
- Consumes: everything from Task 5.
- Produces: `Linker` gains `commit(name: string): Promise<{ account?: Account; error?: string }>` and `sweep(): Promise<void>`.

`commit` renames staging into place and returns the entry. It deliberately does **not** write `accounts.json` — the server does that, so the Linker stays ignorant of persistence. Rename happens first: if the subsequent file write fails, the result is an orphan directory (harmless) rather than an account entry pointing at nothing.

- [ ] **Step 1: Write the failing tests**

Append to `test/link.test.ts`:

```ts
test('commit renames staging into the accounts root and returns the entry', async () => {
  const h = await harness({ provider: 'claude', mode: 'no-prompt', email: 'dwight@example.com' });
  await h.linker.start('claude');
  await until(h.linker, (l) => l?.phase === 'naming');
  const { account, error } = await h.linker.commit('claude-dwight');
  assert.equal(error, undefined);
  assert.equal(account?.name, 'claude-dwight');
  assert.equal(account?.provider, 'claude');
  assert.equal(account?.budget, 2_000_000);
  assert.equal(account?.identity, 'dwight@example.com');
  assert.equal(account?.env.CLAUDE_CONFIG_DIR, join(h.dir, 'accounts', 'claude-dwight'));
  const { readFile } = await import('node:fs/promises');
  assert.ok(await readFile(join(h.dir, 'accounts', 'claude-dwight', '.claude.json'), 'utf8'));
  assert.equal(h.linker.snapshot(), null);
  await h.cleanup();
});

test('commit rejects a name that could escape the accounts root', async () => {
  const h = await harness({ provider: 'claude', mode: 'no-prompt' });
  await h.linker.start('claude');
  await until(h.linker, (l) => l?.phase === 'naming');
  for (const bad of ['../evil', 'a/b', '', 'UPPER']) {
    const { error } = await h.linker.commit(bad);
    assert.equal(typeof error, 'string', `expected ${bad} rejected`);
  }
  assert.equal(h.linker.snapshot()?.phase, 'naming');
  await h.linker.cancel();
  await h.cleanup();
});

test('commit rejects a name already taken', async () => {
  const h = await harness({ provider: 'claude', mode: 'no-prompt' });
  h.accounts.push({ name: 'taken', provider: 'claude', budget: 1, env: {} });
  await h.linker.start('claude');
  await until(h.linker, (l) => l?.phase === 'naming');
  const { error } = await h.linker.commit('taken');
  assert.match(error ?? '', /already exists/);
  await h.linker.cancel();
  await h.cleanup();
});

test('commit is refused before the link reaches naming', async () => {
  const h = await harness({ provider: 'claude' });
  await h.linker.start('claude');
  await until(h.linker, (l) => l?.phase === 'awaiting-user');
  const { error } = await h.linker.commit('claude-x');
  assert.match(error ?? '', /not ready/);
  await h.linker.cancel();
  await h.cleanup();
});

test('sweep removes leftover staging dirs and nothing else', async () => {
  const h = await harness();
  const { mkdir, readdir } = await import('node:fs/promises');
  const root = join(h.dir, 'accounts');
  await mkdir(join(root, '.pending-abandoned'), { recursive: true });
  await mkdir(join(root, 'claude-keep'), { recursive: true });
  await h.linker.sweep();
  assert.deepEqual((await readdir(root)).sort(), ['claude-keep']);
  await h.cleanup();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- --test-name-pattern='link'`
Expected: the five new tests FAIL — `commit` and `sweep` are not functions.

- [ ] **Step 3: Implement commit and sweep**

Add to `src/link.ts`, importing `rename`, `readdir` and the account helpers:

```ts
import { rename, readdir } from 'node:fs/promises';
import { DEFAULT_BUDGET, validateAccountName, type Account } from './accounts.ts';
```

```ts
  /**
   * Renames the staging dir into place and returns the account entry. Does NOT
   * write accounts.json — the server owns that, so this class never needs to
   * know where the file lives.
   *
   * Rename first, persist second: a failed write then leaves an orphan
   * directory, which is harmless, rather than an account entry pointing at a
   * directory that does not exist.
   */
  async commit(name: string): Promise<{ account?: Account; error?: string }> {
    const p = this.#pending;
    if (!p) return { error: 'no link is in progress' };
    if (p.phase !== 'naming') return { error: 'the sign-in is not ready to be named' };

    const invalid = validateAccountName(name, this.#accounts());
    if (invalid) return { error: invalid };

    const target = join(this.#root, name);
    try {
      await rename(p.staging, target);
    } catch (error) {
      return { error: this.redact(String((error as Error).message ?? error)) };
    }

    const account: Account = {
      name,
      provider: p.provider,
      budget: DEFAULT_BUDGET,
      env: { [CREDENTIAL_ENV[p.provider]]: target },
      ...(p.identity ? { identity: p.identity.email } : {}),
    };

    this.#clearTimers(p);
    this.#pending = null;
    this.#notify();
    return { account };
  }

  /**
   * Removes staging dirs left by a crash or a kill. Deliberately narrow: only
   * `.pending-*` entries. A sweep that deleted any unrecognised directory under
   * the accounts root would eat real credentials after an unrelated bug.
   */
  async sweep(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.#root);
    } catch {
      return;
    }
    await Promise.all(entries
      .filter((entry) => entry.startsWith('.pending-'))
      .map((entry) => rm(join(this.#root, entry), { recursive: true, force: true })));
  }
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- --test-name-pattern='link'`
Expected: PASS, all eighteen.

- [ ] **Step 5: Commit**

```bash
git add src/link.ts test/link.test.ts
git commit -m "feat: commit a linked account from its staging dir"
```

---

### Task 7: Server — link commands, snapshot key, SSE subscription

**Files:**
- Modify: `src/server.ts` — `createServer` opts (`:334-347`), `snapshot()` (`:371-388`), `command()` switch (before `default:` at `:835`), `/events` (`:926-944`), the save-timer close handler (`:1163-1170`), entry point (`:1185-1219`)
- Modify: `test/server.test.ts`

**Interfaces:**
- Consumes: `Linker` (Tasks 4-6), `AccountStore`, `loadAccounts`, `createAccountStore` (Task 1).
- Produces: `createServer` accepts `accountStore?: AccountStore` and `linker?: Linker`. `snapshot()` gains `link: PublicLink | null`. Commands `link-start`, `link-code`, `link-confirm`, `link-cancel`.

- [ ] **Step 1: Write the failing tests**

Append to `test/server.test.ts`. It already has helpers for booting a server; follow the file's existing pattern for creating one and posting commands.

```ts
test('link commands are rejected when the account store seam is absent', async () => {
  // Every pre-existing server test constructs createServer without an
  // accountStore. Those tests must keep passing untouched, so linking has to be
  // off by default rather than reaching for a real accounts.json.
  const h = await bootServer();               // existing helper, no accountStore
  const res = await h.post({ cmd: 'link-start', provider: 'claude' });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /not available/);
  await h.close();
});

test('link-start rejects an unknown provider', async () => {
  const h = await bootServerWithLinking();
  const res = await h.post({ cmd: 'link-start', provider: 'gpt' });
  assert.equal(res.status, 400);
  await h.close();
});

test('link-start refuses a second concurrent link', async () => {
  const h = await bootServerWithLinking();
  assert.equal((await h.post({ cmd: 'link-start', provider: 'claude' })).status, 200);
  const second = await h.post({ cmd: 'link-start', provider: 'claude' });
  assert.equal(second.status, 409);
  await h.post({ cmd: 'link-cancel' });
  await h.close();
});

test('link-code and link-confirm 409 when out of phase', async () => {
  const h = await bootServerWithLinking();
  assert.equal((await h.post({ cmd: 'link-code', code: 'x' })).status, 409);
  assert.equal((await h.post({ cmd: 'link-confirm', name: 'a' })).status, 409);
  await h.close();
});

test('link-cancel with nothing pending is a 200, not an error', async () => {
  const h = await bootServerWithLinking();
  assert.equal((await h.post({ cmd: 'link-cancel' })).status, 200);
  await h.close();
});

test('a completed link appears in accounts.json and in the snapshot', async () => {
  const h = await bootServerWithLinking({ mode: 'no-prompt', email: 'dwight@example.com' });
  await h.post({ cmd: 'link-start', provider: 'claude' });
  await h.untilLink((l) => l?.phase === 'naming');
  const res = await h.post({ cmd: 'link-confirm', name: 'claude-dwight' });
  assert.equal(res.status, 200);
  const written = JSON.parse(await readFile(h.accountsPath, 'utf8'));
  assert.deepEqual(written.map((a: { name: string }) => a.name), ['claude-dwight']);
  assert.ok((await h.snapshot()).accounts.some((a: { name: string }) => a.name === 'claude-dwight'));
  assert.equal((await h.snapshot()).link, null);
  await h.close();
});

// The AGENTS.md rule: account env values, which includes every credential
// directory path, must never reach the browser.
test('the snapshot never contains the staging path or the submitted code', async () => {
  const h = await bootServerWithLinking({ mode: 'bad-code' });
  await h.post({ cmd: 'link-start', provider: 'claude' });
  await h.untilLink((l) => l?.codeRequested === true);
  const staging = h.linker.stagingDir();
  assert.ok(staging, 'expected a staging dir while awaiting a code');
  await h.post({ cmd: 'link-code', code: 'sentinel-secret-code' });
  await h.untilLink((l) => l?.phase === 'error');
  const serialized = JSON.stringify(await h.snapshot());
  assert.ok(!serialized.includes('sentinel-secret-code'));
  assert.ok(!serialized.includes(staging));
  await h.close();
});
```

Add a `bootServerWithLinking` helper next to the file's existing server helper. It must: create a temp dir; write an empty `accounts.json`; build a `Linker` with `accountsRoot` inside that temp dir, an `accounts` getter over the server's array, and a `spawnLogin` that runs `writeFakeLoginCli`'s script; pass `accountStore: createAccountStore(accountsPath)` and the linker to `createServer`; and expose `post`, `snapshot`, `untilLink`, `linker`, `accountsPath`, and `close`.

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- --test-name-pattern='link'`
Expected: FAIL — `unknown cmd: link-start`.

- [ ] **Step 3: Accept the new options**

In `createServer`'s opts type add:

```ts
  /** Persistence for linked accounts. Absent disables linking entirely, which
   *  is what keeps every pre-existing server test unchanged. */
  accountStore?: AccountStore;
  linker?: Linker;
```

and destructure them alongside the existing seams:

```ts
    registry, usage, accounts, scheduler = new Scheduler(), prepare = prepareProvider,
    resolvePrompt = resolveAgentPrompt, accountStore, linker,
```

Add the import:

```ts
import { createAccountStore, loadAccounts, type Account, type AccountStore } from './accounts.ts';
import { Linker, type PublicLink } from './link.ts';
```

- [ ] **Step 4: Add `link` to the snapshot**

In `snapshot()`, add one key after `accounts`:

```ts
      link: linker?.snapshot() ?? null,
```

- [ ] **Step 5: Subscribe `/events` to the linker**

In the `/events` handler, beside the two existing subscriptions:

```ts
        const unsubRegistry = registry.subscribe(push);
        const unsubScheduler = scheduler.subscribe(push);
        const unsubLink = linker ? linker.subscribe(push) : () => {};
```

and in the close handler:

```ts
        req.on('close', () => {
          unsubRegistry();
          unsubScheduler();
          unsubLink();
          clearInterval(ping);
        });
```

- [ ] **Step 6: Add the four commands**

Insert before `default:` in `command()`:

```ts
      case 'link-start': {
        if (!linker || !accountStore) {
          return { status: 400, json: { error: 'account linking is not available' } };
        }
        const provider = body.provider;
        if (provider !== 'claude' && provider !== 'codex') {
          return { status: 400, json: { error: 'provider must be claude or codex' } };
        }
        const { error } = await linker.start(provider);
        // A pending link is the only reason start() refuses, and that is a
        // conflict rather than a malformed request.
        if (error) return { status: 409, json: { error } };
        return { status: 200, json: { ok: true } };
      }

      case 'link-code': {
        if (!linker) return { status: 400, json: { error: 'account linking is not available' } };
        if (typeof body.code !== 'string') {
          return { status: 400, json: { error: 'code must be a string' } };
        }
        const { error } = linker.submitCode(body.code);
        if (error) return { status: 409, json: { error } };
        return { status: 200, json: { ok: true } };
      }

      case 'link-confirm': {
        if (!linker || !accountStore) {
          return { status: 400, json: { error: 'account linking is not available' } };
        }
        if (typeof body.name !== 'string') {
          return { status: 400, json: { error: 'name must be a string' } };
        }
        const { account, error } = await linker.commit(body.name);
        if (error || !account) return { status: 409, json: { error } };
        // Directory renamed, now make it durable, then admit it to the running
        // process. Only this entry enters memory: the file on disk may have
        // gained hand edits while the browser tab was open, and adopting those
        // here would be an uncontrolled reload triggered by an unrelated action.
        await accountStore.append(account);
        accounts.push(account);
        registry.touch();
        return { status: 200, json: { ok: true, name: account.name } };
      }

      case 'link-cancel': {
        if (!linker) return { status: 400, json: { error: 'account linking is not available' } };
        await linker.cancel();
        return { status: 200, json: { ok: true } };
      }
```

- [ ] **Step 7: Wire the entry point**

Replace the account load and `createServer` call at the entry point:

```ts
  const accountsPath = new URL('../accounts.json', import.meta.url).pathname;
  const accounts = await loadAccounts(accountsPath);
  const accountStore = createAccountStore(accountsPath);
  const accountsRoot = join(homedir(), '.switchboard', 'accounts');
  const linker = new Linker({ accountsRoot, accounts: () => accounts });
  // Clears staging dirs left by a crash or a kill. A pending link deliberately
  // does not survive a restart.
  await linker.sweep();
```

and pass them:

```ts
  createServer({ registry, usage, scheduler, accounts, accountStore, linker })
```

- [ ] **Step 8: Run the full suite**

Run: `npm test`
Expected: PASS. Every pre-existing server test constructs `createServer` without `accountStore`, so linking is off for them and nothing changes.

- [ ] **Step 9: Commit**

```bash
git add src/server.ts test/server.test.ts
git commit -m "feat: expose account linking over the command and SSE surface"
```

---

### Task 8: Unlink

**Files:**
- Modify: `src/server.ts` — extract the `busy` predicate from `tick` (`:875-877`), add the `unlink` command
- Modify: `test/server.test.ts`

**Interfaces:**
- Consumes: Task 7's `accountStore` and `linker`.
- Produces: `function accountBusy(registry: Registry, name: string): boolean` exported from `src/server.ts`; the `unlink` command.

- [ ] **Step 1: Write the failing tests**

Append to `test/server.test.ts`:

```ts
test('unlink refuses while a session on the account is running', async () => {
  const h = await bootServerWithLinking();
  await h.linkAccount('claude-x');                 // helper: full link + confirm
  await h.startSession({ account: 'claude-x' });   // existing session helper
  const res = await h.post({ cmd: 'unlink', name: 'claude-x' });
  assert.equal(res.status, 409);
  assert.match(res.json.error, /running/);
  await h.close();
});

test('unlink refuses while a create is queued for the account', async () => {
  const h = await bootServerWithLinking();
  await h.linkAccount('claude-x');
  await h.post({
    cmd: 'schedule',
    trigger: { kind: 'at', time: Date.now() + 3_600_000 },
    action: { kind: 'create', repo: h.repo, branch: 'feat/x', account: 'claude-x', prompt: 'hi' },
  });
  assert.equal((await h.post({ cmd: 'unlink', name: 'claude-x' })).status, 409);
  await h.close();
});

test('unlink succeeds over a stopped session, which then cannot resume', async () => {
  const h = await bootServerWithLinking();
  await h.linkAccount('claude-x');
  const id = await h.startSession({ account: 'claude-x' });
  await h.post({ cmd: 'stop', id });
  assert.equal((await h.post({ cmd: 'unlink', name: 'claude-x' })).status, 200);
  const resumed = await h.post({ cmd: 'resume', id, prompt: 'again' });
  assert.equal(resumed.status, 400);
  assert.match(resumed.json.error, /no longer configured/);
  // The transcript is still readable — an unlinked account leaves a read-only
  // archive, it does not delete history.
  assert.ok((await h.snapshot()).sessions.some((s: { id: string }) => s.id === id));
  await h.close();
});

test('unlink removes the entry from accounts.json and its credential dir', async () => {
  const h = await bootServerWithLinking();
  await h.linkAccount('claude-x');
  const dir = join(h.accountsRoot, 'claude-x');
  const { stat } = await import('node:fs/promises');
  assert.ok(await stat(dir));
  assert.equal((await h.post({ cmd: 'unlink', name: 'claude-x' })).status, 200);
  assert.deepEqual(JSON.parse(await readFile(h.accountsPath, 'utf8')), []);
  await assert.rejects(() => stat(dir));
  await h.close();
});

// The test standing between a bug and a user's real credentials.
test('unlink never deletes a directory outside the accounts root', async () => {
  const h = await bootServerWithLinking();
  const outside = join(h.tmp, 'my-own-claude-dir');
  const { mkdir, stat } = await import('node:fs/promises');
  await mkdir(outside, { recursive: true });
  // A hand-written entry, exactly like the README's claude-alt example.
  h.accounts.push({
    name: 'hand-written', provider: 'claude', budget: 1,
    env: { CLAUDE_CONFIG_DIR: outside },
  });
  await h.accountStore.append(h.accounts.at(-1)!);
  assert.equal((await h.post({ cmd: 'unlink', name: 'hand-written' })).status, 200);
  assert.deepEqual(JSON.parse(await readFile(h.accountsPath, 'utf8')), []);
  assert.ok(await stat(outside), 'the user\'s own directory must survive');
  await h.close();
});

test('unlink of an unknown account is a 404', async () => {
  const h = await bootServerWithLinking();
  assert.equal((await h.post({ cmd: 'unlink', name: 'nope' })).status, 404);
  await h.close();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- --test-name-pattern='unlink'`
Expected: FAIL — `unknown cmd: unlink`.

- [ ] **Step 3: Extract the busy predicate**

`tick` has this inline at `src/server.ts:875-877`. Lift it to module scope so `unlink` and `tick` share one definition rather than a copy:

```ts
/** Does this account have a live agent? `needs-you` counts: it is not
 *  computing, but it is a running child process parked on an approval prompt,
 *  so unlinking under it strands a real process rather than a record. */
export function accountBusy(registry: Registry, name: string): boolean {
  return registry.all().some(
    (s) => s.account === name && (s.status === 'working' || s.status === 'needs-you'),
  );
}
```

and use it in `tick`'s `Ctx`:

```ts
        busy: (name) => accountBusy(registry, name),
```

- [ ] **Step 4: Add the unlink command**

Insert beside the other link commands, after `import { rm } from 'node:fs/promises'` is confirmed present (it is, at `:3`):

```ts
      case 'unlink': {
        if (!accountStore || !linker) {
          return { status: 400, json: { error: 'account linking is not available' } };
        }
        const name = String(body.name);
        const index = accounts.findIndex((a) => a.name === name);
        if (index === -1) return { status: 404, json: { error: `unknown account: ${name}` } };

        if (accountBusy(registry, name)) {
          return { status: 409, json: { error: `${name} has a running session` } };
        }
        const queued = scheduler.all().filter((item) =>
          (item.trigger.kind === 'reset' && item.trigger.account === name)
          || (item.action.kind === 'create' && item.action.account === name));
        if (queued.length > 0) {
          return {
            status: 409,
            json: { error: `${name} has ${queued.length} queued item(s). Remove them first.` },
          };
        }

        const account = accounts[index];
        // Durable record first. A failed rm then leaves a stray directory,
        // which is harmless and sweepable; the reverse order can delete
        // credentials and then fail to persist, leaving a live entry pointing
        // at nothing.
        await accountStore.remove(name);
        accounts.splice(index, 1);

        const dir = account.env[CREDENTIAL_ENV[account.provider]];
        const managed = dir === join(linker.root, name);
        if (managed) {
          // Best-effort revoke, so the refresh token dies rather than being
          // orphaned. A network hiccup must not block removing an account.
          await revokeLogin(account).catch(() => {});
          await rm(dir, { recursive: true, force: true });
        }
        registry.touch();
        return { status: 200, json: { ok: true, removedDirectory: managed } };
      }
```

Add the import for `CREDENTIAL_ENV` from `./link.ts`, and the revoke helper near `prepareProvider`:

```ts
/** Best-effort provider logout before a credential dir is deleted. */
async function revokeLogin(account: Account): Promise<void> {
  const env = { ...process.env, ...account.env } as NodeJS.ProcessEnv;
  if (account.provider === 'claude') {
    await run('claude', ['auth', 'logout'], { env });
    return;
  }
  const runtime = await prepareCodexRuntime(
    { bin: account.bin, env: account.env },
    { requireAuth: false },
  );
  await run(runtime.commandPath, ['logout'], { env });
}
```

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts test/server.test.ts
git commit -m "feat: add account unlink with in-use and directory guards"
```

---

### Task 9: `linkView` — the pure view model

**Files:**
- Modify: `web/lib.js`
- Modify: `test/ui.test.ts`

**Interfaces:**
- Consumes: the `link` snapshot key from Task 7.
- Produces: `export function linkView(link)` returning `{ heading, hint, showUrl, url, showCodeBox, showNameForm, suggestedName, identityLine, error, busy }`, or `null` when `link` is null.

- [ ] **Step 1: Write the failing tests**

Append to `test/ui.test.ts`, and add `linkView` to its import block from `../web/lib.js`:

```ts
test('linkView is null when no link is in progress', () => {
  assert.equal(linkView(null), null);
});

test('linkView asks the user to wait before a URL exists', () => {
  const v = linkView({
    provider: 'claude', phase: 'starting', url: null, codeRequested: false,
    identity: null, suggestedName: null, error: null,
  });
  assert.equal(v.showUrl, false);
  assert.equal(v.busy, true);
  assert.equal(v.showCodeBox, false);
});

test('linkView offers the sign-in link once the URL arrives', () => {
  const v = linkView({
    provider: 'codex', phase: 'awaiting-user', url: 'https://auth.openai.com/x',
    codeRequested: false, identity: null, suggestedName: null, error: null,
  });
  assert.equal(v.showUrl, true);
  assert.equal(v.url, 'https://auth.openai.com/x');
  assert.equal(v.showCodeBox, false);
  assert.equal(v.showNameForm, false);
});

// The paste box follows the CLI's actual prompt, not the provider: the Claude
// CLI hedges with "if prompted", so the no-prompt branch is real.
test('linkView shows the code box only once the CLI asked for one', () => {
  const base = {
    provider: 'claude', phase: 'awaiting-user', url: 'https://claude.com/x',
    identity: null, suggestedName: null, error: null,
  };
  assert.equal(linkView({ ...base, codeRequested: false }).showCodeBox, false);
  assert.equal(linkView({ ...base, codeRequested: true }).showCodeBox, true);
});

test('linkView shows the name form with the identity once naming', () => {
  const v = linkView({
    provider: 'claude', phase: 'naming', url: null, codeRequested: false,
    identity: { email: 'dwight@example.com', subscription: 'pro' },
    suggestedName: 'claude-dwight', error: null,
  });
  assert.equal(v.showNameForm, true);
  assert.equal(v.suggestedName, 'claude-dwight');
  assert.match(v.identityLine, /dwight@example\.com/);
  assert.match(v.identityLine, /pro/i);
});

test('linkView names the account plainly when the provider exposed no identity', () => {
  const v = linkView({
    provider: 'codex', phase: 'naming', url: null, codeRequested: false,
    identity: null, suggestedName: 'codex', error: null,
  });
  assert.equal(v.showNameForm, true);
  assert.equal(v.suggestedName, 'codex');
  assert.match(v.identityLine, /Codex/);
});

test('linkView surfaces an error and hides every input', () => {
  const v = linkView({
    provider: 'claude', phase: 'error', url: null, codeRequested: false,
    identity: null, suggestedName: null, error: 'The sign-in timed out.',
  });
  assert.equal(v.error, 'The sign-in timed out.');
  assert.equal(v.showUrl, false);
  assert.equal(v.showCodeBox, false);
  assert.equal(v.showNameForm, false);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- --test-name-pattern='linkView'`
Expected: FAIL — `linkView is not a function`.

- [ ] **Step 3: Implement it**

Add to `web/lib.js`, beside `accountView`:

```js
const PROVIDER_LABEL = { claude: 'Claude', codex: 'Codex' };

/**
 * What the link dialog should show, from the snapshot's `link` key alone.
 *
 * Pure and DOM-free so the fiddly parts — the paste box appearing only when the
 * CLI actually prompted, the jump straight to naming when it did not — are
 * testable without a browser. app.js only sets `hidden` flags from this.
 */
export function linkView(link) {
  if (!link) return null;
  const provider = PROVIDER_LABEL[link.provider] ?? link.provider;

  if (link.phase === 'error') {
    return {
      heading: `Couldn't link ${provider}`,
      hint: '', showUrl: false, url: null, showCodeBox: false, showNameForm: false,
      suggestedName: null, identityLine: '', error: link.error ?? 'Something went wrong.',
      busy: false,
    };
  }

  if (link.phase === 'naming') {
    const identityLine = link.identity
      ? `Signed in as ${link.identity.email}${link.identity.subscription ? ` · ${link.identity.subscription}` : ''}`
      : `Signed in to ${provider}.`;
    return {
      heading: `Name this ${provider} account`,
      hint: 'This name appears on the account meter and in the New dialog.',
      showUrl: false, url: null, showCodeBox: false, showNameForm: true,
      suggestedName: link.suggestedName, identityLine, error: null, busy: false,
    };
  }

  if (link.phase === 'verifying') {
    return {
      heading: `Linking ${provider}…`, hint: 'Checking who you signed in as.',
      showUrl: false, url: null, showCodeBox: false, showNameForm: false,
      suggestedName: null, identityLine: '', error: null, busy: true,
    };
  }

  if (link.phase === 'awaiting-user' && link.url) {
    return {
      heading: `Sign in to ${provider}`,
      hint: link.codeRequested
        ? 'Approve in the tab that opened, then paste the code it gives you.'
        : 'Approve in the tab that opened. This dialog updates on its own.',
      showUrl: true, url: link.url,
      showCodeBox: Boolean(link.codeRequested), showNameForm: false,
      suggestedName: null, identityLine: '', error: null, busy: false,
    };
  }

  return {
    heading: `Starting ${provider} sign-in…`, hint: '',
    showUrl: false, url: null, showCodeBox: false, showNameForm: false,
    suggestedName: null, identityLine: '', error: null, busy: true,
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- --test-name-pattern='linkView'`
Expected: PASS, all seven.

- [ ] **Step 5: Commit**

```bash
git add web/lib.js test/ui.test.ts
git commit -m "feat: add linkView view model"
```

---

### Task 10: Browser UI — first-run screen, link dialog, accounts in Settings

**Files:**
- Modify: `web/index.html` — add `<section id="welcome">`, `<dialog id="link">`, `<dialog id="unlink">`, `#link-chip` in `#bar`, an Accounts block in `<dialog id="settings">`
- Modify: `web/app.js` — render `#welcome`, drive the link dialog from `state.link`, wire the Settings accounts list
- Modify: `web/style.css` — layout only, existing tokens only

**Interfaces:**
- Consumes: `linkView` (Task 9), the `link` snapshot key (Task 7), commands `link-start` / `link-code` / `link-confirm` / `link-cancel` / `unlink` (Tasks 7-8).
- Produces: no new exports.

**Constraint:** no new color values. `test/palette.test.ts` parses `web/style.css`; a hardcoded hex fails it. Use the tokens the existing dialogs use, and the existing `.field` / `.hint` / `.check` / `<menu>` classes.

- [ ] **Step 1: Add the markup**

In `web/index.html`, add `#link-chip` immediately after `#queue-badge` (line 25):

```html
  <button id="link-chip" type="button" hidden>Linking…</button>
```

Add `#welcome` immediately before `<main id="grid">` (line 41):

```html
<section id="welcome" hidden>
  <h1>Link an account</h1>
  <p class="hint">Switchboard runs coding sessions against your Claude and Codex
    subscriptions. Link at least one to get started — you'll approve it in your
    browser, the same as signing in anywhere else.</p>
  <menu>
    <button type="button" data-link-provider="claude">Link Claude account</button>
    <button type="button" data-link-provider="codex">Link Codex account</button>
  </menu>
</section>
```

Add the two dialogs after `<dialog id="del">`:

```html
<dialog id="link">
  <!-- Not method="dialog": submit ADVANCES the flow (pasting a code) rather
       than closing, unlike every other dialog in this file. -->
  <form id="link-form">
    <h2 id="link-heading"></h2>
    <div id="link-status" aria-live="polite">
      <p class="hint" id="link-hint"></p>
      <p class="meta" id="link-identity"></p>
      <p id="link-error" role="alert"></p>
    </div>
    <p id="link-url-wrap" hidden>
      <a id="link-url" target="_blank" rel="noopener">Open the sign-in page</a>
    </p>
    <div class="field" id="link-code-field" hidden>
      <label for="link-code">Code from the sign-in page</label>
      <input id="link-code" name="code" autocomplete="off" spellcheck="false">
    </div>
    <div class="field" id="link-name-field" hidden>
      <label for="link-name">Account name</label>
      <input id="link-name" name="name" autocomplete="off" spellcheck="false">
      <p class="hint">Letters, digits and hyphens.</p>
    </div>
    <menu>
      <button type="button" id="link-close">Close</button>
      <button type="button" id="link-cancel">Cancel sign-in</button>
      <button type="submit" id="link-go" hidden>Continue</button>
    </menu>
  </form>
</dialog>
<dialog id="unlink">
  <form method="dialog">
    <h2>Unlink account</h2>
    <p id="unlink-name"></p>
    <p class="hint" id="unlink-hint"></p>
    <menu>
      <button value="cancel" formnovalidate>Cancel</button>
      <button id="unlink-go" value="unlink">Unlink</button>
    </menu>
  </form>
</dialog>
```

In `<dialog id="settings">`, add before its closing `<menu>`:

```html
    <h3>Accounts</h3>
    <div id="settings-accounts"></div>
    <menu class="inline">
      <button type="button" data-link-provider="claude">Link Claude account</button>
      <button type="button" data-link-provider="codex">Link Codex account</button>
    </menu>
```

- [ ] **Step 2: Render the welcome screen and the chip**

In `web/app.js`'s `render()`, beside where `#grid` and `#session` are toggled:

```js
  const noAccounts = state.accounts.length === 0;
  $('#welcome').hidden = !noAccounts;
  $('#grid').hidden = noAccounts;
  // Nothing to create a session against yet.
  $('#new-btn').disabled = $('#new-btn').disabled || noAccounts;
  $('#link-chip').hidden = !state.link;
```

- [ ] **Step 3: Drive the link dialog from state**

Add to `web/app.js`, importing `linkView` from `./lib.js`:

```js
const linkDialog = $('#link');

function renderLink() {
  const v = linkView(state.link ?? null);
  if (!v) { if (linkDialog.open) linkDialog.close(); return; }
  $('#link-heading').textContent = v.heading;
  $('#link-hint').textContent = v.hint;
  $('#link-identity').textContent = v.identityLine;
  $('#link-error').textContent = v.error ?? '';
  $('#link-url-wrap').hidden = !v.showUrl;
  if (v.showUrl) $('#link-url').href = v.url;
  $('#link-code-field').hidden = !v.showCodeBox;
  $('#link-name-field').hidden = !v.showNameForm;
  if (v.showNameForm && !$('#link-name').value) $('#link-name').value = v.suggestedName ?? '';
  $('#link-go').hidden = !(v.showCodeBox || v.showNameForm);
  $('#link-cancel').hidden = v.showNameForm === false && v.error !== null;
  if (!linkDialog.open) linkDialog.showModal();
}

async function startLink(provider) {
  $('#link-code').value = '';
  $('#link-name').value = '';
  $('#settings').close();
  await send({ cmd: 'link-start', provider });
}

for (const button of document.querySelectorAll('[data-link-provider]')) {
  button.onclick = () => startLink(button.dataset.linkProvider);
}

// Closing does NOT cancel: the child keeps running so you can look elsewhere
// while the browser tab is open. #link-chip reopens it.
$('#link-close').onclick = () => linkDialog.close();
$('#link-chip').onclick = () => { if (!linkDialog.open) linkDialog.showModal(); };
$('#link-cancel').onclick = () => send({ cmd: 'link-cancel' });

$('#link-form').onsubmit = async (event) => {
  event.preventDefault();
  const v = linkView(state.link ?? null);
  if (!v) return;
  if (v.showNameForm) {
    await send({ cmd: 'link-confirm', name: $('#link-name').value.trim() });
    return;
  }
  if (v.showCodeBox) {
    const code = $('#link-code').value.trim();
    $('#link-code').value = '';
    await send({ cmd: 'link-code', code });
  }
};
```

Call `renderLink()` from `render()`.

- [ ] **Step 4: Render the Settings accounts list**

```js
function renderSettingsAccounts() {
  const rows = state.accounts.map((a) => {
    const row = document.createElement('div');
    row.className = 'settings-account';
    const name = document.createElement('span');
    name.textContent = a.name;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = a.provider === 'claude' ? 'Claude' : 'Codex';
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Unlink';
    button.onclick = () => askUnlink(a);
    row.append(name, meta, button);
    return row;
  });
  $('#settings-accounts').replaceChildren(...rows);
}

function askUnlink(account) {
  $('#unlink-name').textContent = account.name;
  $('#unlink-hint').textContent =
    'Existing sessions stay readable but can never be resumed. Credentials Switchboard created for this account are deleted.';
  $('#unlink').returnValue = '';
  $('#unlink').showModal();
  $('#unlink').onclose = () => {
    if ($('#unlink').returnValue === 'unlink') send({ cmd: 'unlink', name: account.name });
  };
}
```

Call `renderSettingsAccounts()` wherever the Settings dialog is populated.

- [ ] **Step 5: Add layout-only CSS**

Append to `web/style.css`, using existing tokens:

```css
/* Welcome and account-linking chrome. Layout only — every color here is an
   existing token, because test/palette.test.ts parses this file and asserts
   contrast across all accent x canvas combinations. */
#welcome {
  max-width: 34rem;
  margin: 6rem auto;
  text-align: center;
}
#welcome menu {
  display: flex;
  gap: 0.75rem;
  justify-content: center;
  padding: 0;
  margin-top: 1.5rem;
}
#settings-accounts {
  display: grid;
  gap: 0.5rem;
}
.settings-account {
  display: grid;
  grid-template-columns: 1fr auto auto;
  align-items: center;
  gap: 0.75rem;
}
menu.inline {
  display: flex;
  gap: 0.5rem;
  padding: 0;
}
```

- [ ] **Step 6: Run the suite**

Run: `npm test`
Expected: PASS, including `palette.test.ts` and the lib.js-export check in `ui.test.ts` (which will now see `linkView` in app.js's import block).

- [ ] **Step 7: Verify by hand**

Run: `npm start`, open `http://127.0.0.1:4711`.
Expected: with accounts present, Settings shows the accounts list and both Link buttons. Temporarily rename `accounts.json` and restart to confirm the welcome screen appears and `+ New` is disabled. Rename it back.

- [ ] **Step 8: Commit**

```bash
git add web/index.html web/app.js web/style.css
git commit -m "feat: add first-run screen and account linking UI"
```

---

### Task 11: Documentation

**Files:**
- Modify: `README.md:5-56` (Setup)
- Modify: `AGENTS.md` (Setup, Code ownership, Safety boundaries)

**Interfaces:**
- Consumes: everything.
- Produces: no code.

- [ ] **Step 1: Rewrite the README setup section**

Replace the manual account bootstrap with the linking flow. It must state:

- `npm install && npm start`, then open the URL — no `cp accounts.example.json` step.
- With no accounts, the app opens on a linking screen; otherwise Settings → Accounts.
- Claude linking asks for a pasted code; Codex completes in the browser.
- One link at a time, because `codex login` binds a fixed port 1455.
- Linked credentials live in `~/.switchboard/accounts/<name>/`.
- `accounts.json` is still hand-editable, and hand edits still need a restart, while links take effect immediately.
- `budget` remains a hand-tuned value; linked accounts default to 2,000,000.
- Unlinking refuses while a session on the account is running or work is queued; it deletes only credential directories Switchboard created, never a directory pointed at by a hand-written entry.
- Keep the existing `accounts.example.json` documentation of the manual shape.

- [ ] **Step 2: Update AGENTS.md**

- **Setup:** `accounts.json` is now optional; a missing file starts the app in first-run mode.
- **Code ownership:** add `src/accounts.ts` owns `accounts.json` reads and writes; `src/link.ts` owns the login child and the pending-link state machine.
- **Safety boundaries**, add:
  - `accounts.json` is co-owned. The app may only append entries it creates and remove entries by name; it must never write an in-memory array wholesale, and must never adopt a concurrent hand edit into the running process.
  - Only ever delete a credential directory that is exactly `<accountsRoot>/<name>`. A directory named by a hand-written entry is never removed.
  - The pasted authorization code goes to child stdin only — never logged, never in `snapshot()`, never persisted.
  - Link tests must never bind port 1455, open a browser, or spawn a real `claude`/`codex` binary.

- [ ] **Step 3: Verify**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add README.md AGENTS.md
git commit -m "docs: document browser-driven account linking"
```

---

## Self-Review

**Spec coverage:** account store and append-only rule → Task 1. `requireAuth` fix → Task 3. `PendingLink` machine, URL capture, discovered prompt, identity readback, staging/commit, sweep, secrets → Tasks 4-6. Commands, snapshot key, `subscribe()` on `/events` → Task 7. Unlink, blocking rules, directory safety, ordering → Task 8. `linkView` → Task 9. First-run screen, link dialog, Settings accounts, `#link-chip`, aria-live, tokens-only CSS → Task 10. Docs → Task 11.

**Known deviations from the spec, both deliberate:**

1. The spec describes the `ponytail:` note about collapsing the three `#subs` copies into one notifier. It is a comment in the spec, not a code change, and no task implements it — correct, since the trigger conditions have not fired.
2. `Account` gains an optional `identity` field, which the spec does not mention. It is required for the duplicate-detection the spec *does* specify: without somewhere to record who an account belongs to, "already linked as `claude-main`" cannot be computed. It is a plain email string, not a credential.

**Type consistency:** `PublicLink` is defined in Task 4 and consumed unchanged in Tasks 7 and 9. `CREDENTIAL_ENV` is defined in Task 4 and used in Tasks 6 and 8. `AccountStore.append`/`remove` are defined in Task 1 and used in Tasks 7 and 8. `accountBusy` is defined in Task 8 and used in the same task. `validateAccountName` is defined in Task 1 and used in Task 6.
