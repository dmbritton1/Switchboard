import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat as fsStat } from 'node:fs/promises';
import { join } from 'node:path';
import { currentBranch } from './merge.ts';

const run = promisify(execFile);

/** Branch names become path segments; `feat/x` lives at `.claude/worktrees/feat-x`. */
function slug(branch: string): string {
  return branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

export async function createWorktree(repo: string, branch: string): Promise<string> {
  try {
    await run('git', ['rev-parse', '--git-dir'], { cwd: repo });
  } catch {
    throw new Error(`not a git repository: ${repo}`);
  }

  const path = join(repo, '.claude', 'worktrees', slug(branch));
  try {
    await run('git', ['worktree', 'add', '-b', branch, path], { cwd: repo });
  } catch (err) {
    const msg = String((err as { stderr?: string }).stderr ?? err);
    if (/already exists/i.test(msg)) throw new Error(`branch already exists: ${branch}`);
    throw new Error(msg.trim());
  }
  return path;
}

/**
 * Which line of history a commit belongs to, for styling. Decided here rather
 * than in the browser because it is a reachability question and git already
 * knows the answer.
 */
export type Tier = 'own' | 'trunk' | 'other';

export type GraphCommit = {
  h: string; p: string[]; subject: string; author: string; when: string;
  refs: string[]; lane: number; row: number; tier: Tier;
};

/** Index of a reusable lane, appending one if all are busy. */
function freeLane(lanes: (string | null)[]): number {
  const i = lanes.indexOf(null);
  if (i !== -1) return i;
  lanes.push(null);
  return lanes.length - 1;
}

/**
 * Assign each commit a lane (column). `commits` must be in topo order.
 *
 * A lane is reserved by a child for its parent, so a commit inherits whichever
 * lane claimed it first and every other lane pointing at it is released — that
 * release is what closes a branch's line after a merge instead of leaving a
 * dead column running down the rest of the graph.
 */
export function assignLanes<T extends { h: string; p: string[] }>(
  commits: T[],
): (T & { lane: number; row: number })[] {
  const lanes: (string | null)[] = [];
  return commits.map((c, row) => {
    const lane = lanes.includes(c.h) ? lanes.indexOf(c.h) : freeLane(lanes);
    for (let i = 0; i < lanes.length; i++) if (i !== lane && lanes[i] === c.h) lanes[i] = null;
    lanes[lane] = c.p[0] ?? null;
    for (const extra of c.p.slice(1)) if (!lanes.includes(extra)) lanes[freeLane(lanes)] = extra;
    return Object.assign(c, { lane, row });
  });
}

const GRAPH_FORMAT = '--format=%H%x00%P%x00%s%x00%an%x00%ar%x00%D';

function parseLog(stdout: string, tier: Tier) {
  return stdout.split('\n').filter(Boolean).map((line) => {
    const [h, p, subject, author, when, refs] = line.split('\0');
    return {
      h, subject, author, when, tier,
      p: p ? p.split(' ') : [],
      refs: refs.split(',').map((r) => r.trim()).filter(Boolean),
    };
  });
}

/**
 * Commits across every branch, laid out for drawing.
 *
 * `--all` with a single `-limit` looks like it reads the whole repo but does
 * not: the budget is global and spent newest-first, so trunk history eats it
 * and any branch whose tip is older than that window is dropped entirely,
 * ref and all. Instead the budget is split — everything off-trunk, plus a
 * bounded slice of trunk — so no branch can be starved by trunk's activity.
 *
 * The two results are concatenated and deliberately NOT re-sorted. They are
 * disjoint (one set is defined as unreachable from trunk, the other only as
 * reachable from it), and no trunk commit can have an off-trunk parent, or
 * that parent would be reachable from trunk. So every parent still follows
 * its child and assignLanes' topological requirement holds.
 *
 * Trunk is the base repo's checked-out branch — the same branch mergeWorktrees
 * merges into — so the graph's spine and the merge target cannot drift apart.
 */
export async function commitGraph(
  cwd: string, repo: string = cwd, limit = 400,
): Promise<GraphCommit[]> {
  const branch = await currentBranch(repo).catch(() => '');
  // Fully qualified, never the bare name: a branch called `docs` or `src` is
  // also a path here, and `git log docs` is a fatal ambiguity rather than a
  // revision. --verify doubles as the unborn-branch check, routing an orphan
  // trunk into the same single-walk fallback as a detached HEAD.
  const trunk = branch && await run(
    'git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd },
  ).then(() => `refs/heads/${branch}`, () => '');
  // Detached HEAD: there is no trunk to split on, so fall back to one walk.
  if (!trunk) {
    const { stdout } = await run(
      'git', ['log', '--all', '--topo-order', `-${limit}`, GRAPH_FORMAT], { cwd },
    );
    return assignLanes(parseLog(stdout, 'other'));
  }

  const [off, spine, own] = await Promise.all([
    run('git', ['log', '--all', '--not', trunk, '--topo-order', `-${limit}`, GRAPH_FORMAT], { cwd }),
    run('git', ['log', trunk, '--topo-order', `-${limit}`, GRAPH_FORMAT], { cwd }),
    // Commits unique to this session's branch: the boundary is the fork point,
    // so the highlight covers the work done here, not the inherited ancestry.
    // An unborn HEAD has none, which is a legitimate empty answer, not an error.
    run('git', ['rev-list', 'HEAD', '--not', trunk], { cwd }).catch(() => ({ stdout: '' })),
  ]);

  const mine = new Set(own.stdout.split('\n').filter(Boolean));
  const commits = [...parseLog(off.stdout, 'other'), ...parseLog(spine.stdout, 'trunk')];
  for (const c of commits) if (mine.has(c.h)) c.tier = 'own';
  return assignLanes(commits);
}

export async function worktreeStatus(cwd: string): Promise<{
  branch: string; added: number; removed: number; dirty: boolean;
}> {
  const [branch, stat, porcelain, others] = await Promise.all([
    run('git', ['branch', '--show-current'], { cwd }),
    run('git', ['diff', 'HEAD', '--numstat'], { cwd }),
    // `uploads/` is excluded from both: /upload drops pasted and attached files
    // there for the agent to read, and counting a screenshot as +N added lines
    // made the card's progress indicator report work nobody did.
    run('git', ['status', '--porcelain', '--', '.', ':!uploads'], { cwd }),
    run('git', ['ls-files', '--others', '--exclude-standard', '-z', '--', '.', ':(exclude)uploads'], { cwd }),
  ]);

  let added = 0;
  let removed = 0;
  for (const line of stat.stdout.split('\n')) {
    const [a, r] = line.split('\t');
    // Binary files report `-`; skip rather than counting NaN.
    if (a && a !== '-') added += Number(a);
    if (r && r !== '-') removed += Number(r);
  }

  // `git diff HEAD --numstat` only sees tracked files, so an agent told to *create*
  // files — most first prompts — showed `+0 −0 · dirty`, zero progress on the card's
  // only progress indicator. Count untracked lines in as added, the way `git add -N`
  // would, but without touching the index.
  for (const rel of others.stdout.split('\0')) {
    if (!rel) continue;
    let buf: Buffer;
    try {
      // Size-check first: this runs in the long-lived server process on every
      // /status poll, and an agent that downloaded a dataset into its worktree
      // would otherwise have it read into memory whole. 2MB of text is ~50k lines;
      // anything past that is generated, and undercounting it beats the spike.
      const { size } = await fsStat(join(cwd, rel));
      if (size === 0 || size > 2_000_000) continue;
      buf = await readFile(join(cwd, rel));
    } catch {
      continue; // Vanished or unreadable between ls-files and here.
    }
    // git's own binary heuristic: a NUL byte near the start. Binary files have no
    // meaningful line count, and numstat skips them for the same reason.
    if (buf.subarray(0, 8000).includes(0)) continue;
    const text = buf.toString('utf8');
    // A file with no trailing newline still ends in a line.
    added += text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  }

  return {
    branch: branch.stdout.trim(),
    added,
    removed,
    dirty: porcelain.stdout.trim().length > 0,
  };
}

export type FileDiff = {
  path: string;
  old?: string;
  added: number;
  removed: number;
  binary: boolean;
  patch: string;
  truncated: boolean;
};

/** A body longer than this is cut; see the truncation note in the diff spec. */
const MAX_PATCH_LINES = 2000;

/**
 * A patch chunk's own header lines. The pane's summary already names the file,
 * so `index`/`---`/`+++` are noise — but `old mode`, `new file mode`,
 * `rename from/to` and `Binary files … differ` are not, and stay.
 */
const NOISE = /^(index |--- |\+\+\+ )/;

/** Chunk text as it should be rendered: header line dropped, noise filtered. */
function patchBody(chunk: string): string {
  return chunk
    .split('\n')
    .slice(1) // the remainder of the `diff --git a/x b/y` line this was split on
    .filter((l) => !NOISE.test(l))
    .join('\n')
    .replace(/\n+$/, '');
}

function cap(patch: string): { patch: string; truncated: boolean } {
  const lines = patch.split('\n');
  if (lines.length <= MAX_PATCH_LINES) return { patch, truncated: false };
  return { patch: lines.slice(0, MAX_PATCH_LINES).join('\n'), truncated: true };
}

/**
 * `git diff --numstat -z` records. The `-z` form exists because a path may
 * contain a space, a quote or a newline, and the default form escapes those
 * into a quoted string that then has to be unquoted. Its layout is
 * `added \t removed \t path NUL`, except for a rename, which leaves the path
 * field empty and follows with `old NUL new NUL`.
 */
function parseNumstat(stdout: string): Omit<FileDiff, 'patch' | 'truncated'>[] {
  const parts = stdout.split('\0');
  const rows: Omit<FileDiff, 'patch' | 'truncated'>[] = [];
  for (let i = 0; i < parts.length; i++) {
    const [a, r, p] = parts[i].split('\t');
    if (p === undefined) continue; // trailing empty element, not a record
    // Binary files report `-` for both counts; a byte count is not a line count.
    const binary = a === '-';
    const row = { added: binary ? 0 : Number(a), removed: binary ? 0 : Number(r), binary };
    if (p === '') rows.push({ ...row, old: parts[++i], path: parts[++i] });
    else rows.push({ ...row, path: p });
  }
  return rows;
}

/**
 * Every uncommitted change in the worktree, file by file.
 *
 * The range and the pathspec are `worktreeStatus()`'s, deliberately: the pane's
 * per-file numbers and the sidebar's `+N −M` are read inches apart, and a pane
 * that measured a different range would look like a bug rather than a feature.
 */
export async function worktreeDiff(cwd: string): Promise<FileDiff[]> {
  const SPEC = ['--', '.', ':!uploads'];
  const [numstat, patch, others] = await Promise.all([
    // quotePath=false keeps a non-ASCII path readable in the patch headers, which
    // is what the sanity check below matches against.
    run('git', ['-c', 'core.quotePath=false', 'diff', 'HEAD', '--numstat', '-z', ...SPEC], { cwd }),
    // The one call whose output can be large. A generated file blows past
    // execFile's 1MB default maxBuffer and rejects with ENOBUFS, so raise it —
    // and if it still fails, fall back to no bodies rather than losing the list.
    run(
      'git',
      ['-c', 'core.quotePath=false', 'diff', 'HEAD', '--patch', '--no-color', '--no-ext-diff', ...SPEC],
      { cwd, maxBuffer: 32 * 1024 * 1024 },
    ).catch(() => ({ stdout: '' })),
    run('git', ['ls-files', '--others', '--exclude-standard', '-z', '--', '.', ':(exclude)uploads'], { cwd }),
  ]);

  const rows = parseNumstat(numstat.stdout);
  // Zipped by position, not by path: both commands walk the same diff queue with
  // the same pathspec, so they list the same files in the same order — binary
  // files and mode-only changes included. That beats parsing a path back out of
  // a header git may have quoted. The `includes` is the guard on that assumption:
  // if the orders ever diverge, a file shows an empty body rather than somebody
  // else's diff.
  const chunks = patch.stdout.split(/^diff --git /m).slice(1);
  const files: FileDiff[] = rows.map((row, i) => {
    const chunk = chunks[i];
    if (row.binary || !chunk || !chunk.includes(row.path)) {
      return { ...row, patch: '', truncated: false };
    }
    return { ...row, ...cap(patchBody(chunk)) };
  });

  // `git diff HEAD` cannot see untracked files, and leaving them out would show
  // `+0 −0` for the commonest first prompt there is — one telling the agent to
  // *create* files. worktreeStatus() counts their lines directly rather than
  // staging them with `git add -N`; this does the same and builds the body too.
  for (const rel of others.stdout.split('\0')) {
    if (!rel) continue;
    let buf: Buffer;
    try {
      // Size-check first: this runs in the long-lived server process, and an
      // agent that downloaded a dataset into its worktree should not have it
      // read into memory whole.
      const { size } = await fsStat(join(cwd, rel));
      if (size === 0 || size > 2_000_000) continue;
      buf = await readFile(join(cwd, rel));
    } catch {
      continue; // Vanished or unreadable between ls-files and here.
    }
    // git's own binary heuristic: a NUL byte near the start.
    if (buf.subarray(0, 8000).includes(0)) {
      files.push({ path: rel, added: 0, removed: 0, binary: true, patch: '', truncated: false });
      continue;
    }
    const text = buf.toString('utf8');
    const lines = text.split('\n');
    // A file with no trailing newline still ends in a line.
    const n = lines.length - (text.endsWith('\n') ? 1 : 0);
    const body = `@@ -0,0 +1,${n} @@\n${lines.slice(0, n).map((l) => `+${l}`).join('\n')}`;
    files.push({ path: rel, added: n, removed: 0, binary: false, ...cap(body) });
  }

  return files;
}
