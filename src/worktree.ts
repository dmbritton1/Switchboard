import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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

export async function worktreeStatus(cwd: string): Promise<{
  branch: string; added: number; removed: number; dirty: boolean;
}> {
  const [branch, stat, porcelain] = await Promise.all([
    run('git', ['branch', '--show-current'], { cwd }),
    run('git', ['diff', 'HEAD', '--numstat'], { cwd }),
    run('git', ['status', '--porcelain'], { cwd }),
  ]);

  let added = 0;
  let removed = 0;
  for (const line of stat.stdout.split('\n')) {
    const [a, r] = line.split('\t');
    // Binary files report `-`; skip rather than counting NaN.
    if (a && a !== '-') added += Number(a);
    if (r && r !== '-') removed += Number(r);
  }

  return {
    branch: branch.stdout.trim(),
    added,
    removed,
    dirty: porcelain.stdout.trim().length > 0,
  };
}
