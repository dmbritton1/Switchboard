import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat as fsStat } from 'node:fs/promises';
import { join } from 'node:path';

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

export type GraphCommit = {
  h: string; p: string[]; subject: string; author: string; when: string;
  refs: string[]; lane: number; row: number;
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

/**
 * Commits across every branch, laid out for drawing. `--all` reads the whole
 * repo, so any one worktree's cwd shows the same full picture.
 */
export async function commitGraph(cwd: string, limit = 400): Promise<GraphCommit[]> {
  const { stdout } = await run(
    'git',
    ['log', '--all', '--topo-order', `-${limit}`, '--format=%H%x00%P%x00%s%x00%an%x00%ar%x00%D'],
    { cwd },
  );
  const commits = stdout.split('\n').filter(Boolean).map((line) => {
    const [h, p, subject, author, when, refs] = line.split('\0');
    return {
      h, subject, author, when,
      p: p ? p.split(' ') : [],
      refs: refs.split(',').map((r) => r.trim()).filter(Boolean),
    };
  });
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
