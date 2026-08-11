import { test } from 'node:test';
import assert from 'node:assert';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capturePage, browserServer, DEFAULT_VIEWPORT } from '../src/agents/browser.ts';

// A 1x1 PNG. Small enough to inline, real enough that sips has something valid
// to open — the resize is best-effort, so this passes either way.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * A stand-in for Chrome that writes a real PNG wherever --screenshot points.
 * Same idiom as writeFakeXcrun: the fake sits at the process boundary, so
 * everything above it — URL validation, argv construction, the poll for the
 * file, the scratch directory, base64 encoding — is the real code.
 *
 * `silent` is the browser that never produces a screenshot: a wedged load, or
 * a Chrome too old for these flags.
 */
async function writeFakeChrome(dir: string, mode: 'ok' | 'silent' = 'ok'): Promise<string> {
  const path = join(dir, `fake-chrome-${mode}`);
  await writeFile(path, `#!/usr/bin/env node
const { writeFileSync, appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(dir, 'argv.log'))}, JSON.stringify(args) + '\\n');
if (${JSON.stringify(mode)} === 'silent') { setTimeout(() => {}, 60000); return; }
const shot = args.find((a) => a.startsWith('--screenshot=')).slice('--screenshot='.length);
writeFileSync(shot, Buffer.from(${JSON.stringify(PNG)}, 'base64'));
`);
  await chmod(path, 0o755);
  return path;
}

async function scratch(t: { after(fn: () => unknown): void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'switchboard-browsertest-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function argvOf(dir: string): Promise<string[]> {
  return JSON.parse((await readFile(join(dir, 'argv.log'), 'utf8')).split('\n')[0]) as string[];
}

test('capturePage returns the rendered page as base64 PNG', async (t) => {
  const dir = await scratch(t);
  const shot = await capturePage('http://localhost:3000', {}, await writeFakeChrome(dir));
  assert.ok(shot.ok, 'expected a successful capture');
  const bytes = Buffer.from((shot as { base64: string }).base64, 'base64');
  assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});

test('capturePage never passes a virtual time budget', async (t) => {
  const dir = await scratch(t);
  await capturePage('http://localhost:3000', {}, await writeFakeChrome(dir));
  // Measured against Chrome 150: --virtual-time-budget stalls on any page
  // holding an open connection and the screenshot is never written at all. That
  // is every dev server with hot reload, and this app's own SSE page — the exact
  // pages this tool exists for. Do not add it back to "wait for the page".
  assert.ok(
    !(await argvOf(dir)).some((a) => a.startsWith('--virtual-time-budget')),
    'a virtual time budget produces an empty capture on any page with a live connection',
  );
});

test('capturePage uses a throwaway profile and does not phone home', async (t) => {
  const dir = await scratch(t);
  await capturePage('http://localhost:3000/app', {}, await writeFakeChrome(dir));
  const argv = await argvOf(dir);

  assert.equal(argv.at(-1), 'http://localhost:3000/app', 'the URL must be the final argument');
  assert.ok(argv.includes('--headless'));
  assert.ok(argv.includes(`--window-size=${DEFAULT_VIEWPORT.width},${DEFAULT_VIEWPORT.height}`));

  // The user's real Chrome profile is never opened: it would fail outright while
  // their browser is running, and would put their cookies behind the capture.
  const profile = argv.find((a) => a.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length);
  assert.ok(
    profile?.startsWith(join(tmpdir(), 'switchboard-shot-')),
    `throwaway profile expected, got ${profile}`,
  );
  // Left alone, Chrome starts its updater and registers for push on the way past.
  assert.ok(argv.includes('--disable-background-networking'));
});

test('capturePage honours a requested viewport', async (t) => {
  const dir = await scratch(t);
  await capturePage('https://example.com', { width: 390, height: 844 }, await writeFakeChrome(dir));
  assert.ok((await argvOf(dir)).includes('--window-size=390,844'));
});

test('capturePage gives up rather than hanging when no screenshot appears', async (t) => {
  const dir = await scratch(t);
  const started = Date.now();
  const shot = await capturePage(
    'http://localhost:3000',
    { timeoutMs: 1500 },
    await writeFakeChrome(dir, 'silent'),
  );
  assert.equal(shot.ok, false);
  assert.match((shot as { error: string }).error, /no screenshot within 1500ms/);
  // The browser is killed at the deadline, not waited on: headless Chrome keeps
  // running after it writes the file, so nothing here may depend on it exiting.
  assert.ok(Date.now() - started < 10_000, 'the deadline must actually cut the capture short');
});

test('capturePage refuses anything that is not an http(s) URL', async (t) => {
  const dir = await scratch(t);
  const chrome = await writeFakeChrome(dir);
  const bad = [
    '--headless', // would be read as a flag rather than a target
    'file:///etc/passwd', // local disk through a "screenshot"
    'javascript:alert(1)',
    'chrome://history',
    'localhost:3000', // no scheme: URL parses this as protocol "localhost:"
    '',
  ];
  for (const url of bad) {
    const shot = await capturePage(url, {}, chrome);
    assert.equal(shot.ok, false, `expected ${JSON.stringify(url)} to be rejected`);
    assert.match((shot as { error: string }).error, /invalid url/);
  }
  // Rejected before the browser is ever spawned.
  await assert.rejects(() => readFile(join(dir, 'argv.log')));
});

test('capturePage reports a missing browser instead of throwing', async () => {
  const shot = await capturePage('http://localhost:3000', {}, null);
  assert.equal(shot.ok, false);
  assert.match((shot as { error: string }).error, /no Chromium-family browser/);
});

test('capturePage leaves no scratch directory behind', async (t) => {
  const dir = await scratch(t);
  const count = async () => (await readdir(tmpdir()))
    .filter((f) => f.startsWith('switchboard-shot-')).length;
  const before = await count();
  await capturePage('http://localhost:3000', {}, await writeFakeChrome(dir));
  await capturePage('http://localhost:3000', { timeoutMs: 600 }, await writeFakeChrome(dir, 'silent'));
  assert.equal(await count(), before, 'the scratch directory must be removed on both paths');
});

test('the browser server exposes exactly the one tool Bash cannot replace', () => {
  assert.equal(browserServer.type, 'sdk');
  assert.equal(browserServer.name, 'browser');
});
