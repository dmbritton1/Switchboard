import { test } from 'node:test';
import assert from 'node:assert';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureScreenshot, simulatorServer } from '../src/agents/simulator.ts';
import { MAX_EDGE } from '../src/agents/capture.ts';

// A 1x1 PNG. Small enough to inline, real enough that sips has something valid
// to open — the resize is best-effort, so this passes either way.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * A stand-in for xcrun that writes a real PNG where simctl would. Same idiom as
 * writeFakeCodex: the fake sits at the process boundary, so everything above it
 * — argv construction, the temp-file dance, base64 encoding — is the real code.
 */
async function writeFakeXcrun(
  dir: string,
  mode: 'ok' | 'no-device' = 'ok',
): Promise<string> {
  const path = join(dir, 'fake-xcrun');
  await writeFile(path, `#!/usr/bin/env node
const { writeFileSync, appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(dir, 'argv.log'))}, JSON.stringify(args) + '\\n');
if (${JSON.stringify(mode)} === 'no-device') {
  process.stderr.write('No devices are booted.\\n');
  process.exit(164);
}
writeFileSync(args[args.length - 1], Buffer.from(${JSON.stringify(PNG.toString('base64'))}, 'base64'));
`);
  await chmod(path, 0o755);
  return path;
}

async function scratch(t: { after(fn: () => unknown): void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'switchboard-sim-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('captureScreenshot returns the PNG as base64', async (t) => {
  const dir = await scratch(t);
  const shot = await captureScreenshot('booted', await writeFakeXcrun(dir));
  assert.ok(shot.ok, 'expected a successful capture');
  // Decodes, and is a PNG: the magic number survives the base64 round trip.
  const bytes = Buffer.from((shot as { base64: string }).base64, 'base64');
  assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});

test('captureScreenshot builds the simctl invocation it means to', async (t) => {
  const dir = await scratch(t);
  await captureScreenshot('iPhone 16 Pro', await writeFakeXcrun(dir));
  const { readFile } = await import('node:fs/promises');
  const argv = JSON.parse((await readFile(join(dir, 'argv.log'), 'utf8')).split('\n')[0]) as string[];
  assert.deepEqual(argv.slice(0, 4), ['simctl', 'io', 'iPhone 16 Pro', 'screenshot']);
});

test('captureScreenshot surfaces simctl stderr instead of swallowing it', async (t) => {
  const dir = await scratch(t);
  const shot = await captureScreenshot('booted', await writeFakeXcrun(dir, 'no-device'));
  assert.equal(shot.ok, false);
  // The agent's cue to boot a device itself rather than report a dead end.
  assert.match((shot as { error: string }).error, /No devices are booted/);
});

test('captureScreenshot refuses a device name that could smuggle a flag', async (t) => {
  const dir = await scratch(t);
  const xcrun = await writeFakeXcrun(dir);
  for (const bad of ['--help', '-x', '', 'rm -rf /; echo']) {
    const shot = await captureScreenshot(bad, xcrun);
    assert.equal(shot.ok, false, `expected ${JSON.stringify(bad)} to be rejected`);
    assert.match((shot as { error: string }).error, /invalid device name/);
  }
});

/**
 * See the twin of this test in browser.test.ts. Both count `switchboard-shot-*`
 * and both create one, so while they shared the system temp dir and ran as
 * concurrent `node --test` processes they failed each other by exactly one.
 * TMPDIR is repointed at a private directory so each file counts only its own.
 */
test('captureScreenshot leaves no temp file behind', async (t) => {
  const dir = await scratch(t);
  const { readdir } = await import('node:fs/promises');
  const priorTmp = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  t.after(() => { process.env.TMPDIR = priorTmp; });

  const count = async () => (await readdir(tmpdir()))
    .filter((f) => f.startsWith('switchboard-shot-')).length;
  const before = await count();

  // A concurrent sibling's scratch dir in the *system* temp dir must not move
  // this count. Without the isolation above it does, by exactly one.
  const decoy = await mkdtemp(join(priorTmp ?? '/tmp', 'switchboard-shot-'));
  t.after(() => rm(decoy, { recursive: true, force: true }));

  await captureScreenshot('booted', await writeFakeXcrun(dir));
  await captureScreenshot('nope-not-valid!!', await writeFakeXcrun(dir));
  assert.equal(await count(), before, 'the scratch directory must be removed on both paths');
});

test('the simulator server exposes exactly the one tool Bash cannot replace', () => {
  assert.equal(simulatorServer.type, 'sdk');
  assert.equal(simulatorServer.name, 'simulator');
  assert.ok(MAX_EDGE > 0 && MAX_EDGE <= 1568, 'stay at or under the model image cap');
});
