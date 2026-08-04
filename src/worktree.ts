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
  const trunk = await currentBranch(repo).catch(() => '');
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
    run('git', ['status', '--porcelain'], { cwd }),
    run('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd }),
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
