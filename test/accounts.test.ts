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
