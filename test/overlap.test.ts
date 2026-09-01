import { test } from 'node:test';
import assert from 'node:assert';
import {
  MAX_LISTED_PATHS, PATH_TTL_MS, dropPaths, overlaps, refreshPaths, summarizePaths,
  type PathCache,
} from '../src/overlap.ts';

function cache(entries: Record<string, string[]>, at = 0): PathCache {
  return new Map(Object.entries(entries).map(([id, paths]) => [id, { paths, at }]));
}

test('overlaps reports only the shared paths, and only for sessions that share one', () => {
  const c = cache({
    a: ['src/auth.ts', 'src/only-a.ts'],
    b: ['src/auth.ts', 'src/session.ts'],
    d: ['docs/readme.md'],
  });

  assert.deepEqual(
    overlaps(c, 'a', [{ id: 'b', branch: 'feat/b' }, { id: 'd', branch: 'feat/d' }]),
    [{ id: 'b', branch: 'feat/b', files: ['src/auth.ts'] }],
  );
});

test('overlaps is silent about a session whose paths are not cached yet', () => {
  const c = cache({ a: ['src/auth.ts'] });

  assert.deepEqual(overlaps(c, 'a', [{ id: 'b', branch: 'feat/b' }]), []);
});

test('overlaps returns nothing when the caller itself is uncached', () => {
  const c = cache({ b: ['src/auth.ts'] });

  assert.deepEqual(overlaps(c, 'a', [{ id: 'b', branch: 'feat/b' }]), []);
});

test('summarizePaths caps the list and says how many it dropped', () => {
  const few = ['a.ts', 'b.ts'];
  assert.equal(summarizePaths(few), 'a.ts, b.ts');

  const many = Array.from({ length: MAX_LISTED_PATHS + 3 }, (_, i) => `f${i}.ts`);
  const out = summarizePaths(many);
  assert.match(out, /and 3 more$/);
  assert.equal(out.split(',').length, MAX_LISTED_PATHS + 1, 'ten paths plus the tail');
});

test('refreshPaths collects when the entry is missing or stale, and skips when it is fresh', async () => {
  const c: PathCache = new Map();
  let calls = 0;
  const collect = async () => { calls++; return ['src/auth.ts']; };

  await refreshPaths(c, 'a', collect, 1000);
  assert.equal(calls, 1, 'a missing entry is collected');

  await refreshPaths(c, 'a', collect, 1000 + PATH_TTL_MS - 1);
  assert.equal(calls, 1, 'a fresh entry is not recollected — this is the rate limit');

  await refreshPaths(c, 'a', collect, 1000 + PATH_TTL_MS);
  assert.equal(calls, 2, 'a stale entry is recollected');
});

test('refreshPaths leaves the previous entry alone when collection fails', async () => {
  const c: PathCache = new Map();
  await refreshPaths(c, 'a', async () => ['src/auth.ts'], 0);

  await refreshPaths(c, 'a', async () => { throw new Error('worktree is gone'); }, PATH_TTL_MS);

  assert.deepEqual(
    c.get('a')?.paths, ['src/auth.ts'],
    'a failed refresh must not blank an entry other sessions are reading',
  );
});

test('dropPaths forgets one session and leaves the rest', () => {
  const c = cache({ a: ['x.ts'], b: ['y.ts'] });
  dropPaths(c, 'a');
  assert.equal(c.has('a'), false);
  assert.equal(c.has('b'), true);
});
