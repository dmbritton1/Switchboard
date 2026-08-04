import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Serializes merge/push per base repo: two concurrent operations on the same
// repo's working directory would race on HEAD and the index (a merge started
// from one browser tab while a push reads HEAD from another, say). Keyed by
// repo path and chained, the same shape as Registry#save's #saveChain.
const repoLocks = new Map<string, Promise<unknown>>();
function withRepoLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoLocks.get(repo) ?? Promise.resolve();
  const next = prev.then(fn, fn); // run fn whether or not the previous op succeeded
  repoLocks.set(repo, next.catch(() => {}));
  return next;
}

function errMsg(err: unknown): string {
  const stderr = (err as { stderr?: string }).stderr;
  const trimmed = stderr?.trim();
  return trimmed || String((err as Error).message ?? err);
}

async function isDirty(cwd: string): Promise<boolean> {
  const { stdout } = await run('git', ['status', '--porcelain'], { cwd });
  return stdout.trim().length > 0;
}

/**
 * Every worktree Switchboard creates lives at `<repo>/.claude/worktrees/<slug>`
 * (see createWorktree in worktree.ts) — nested inside the base repo's own
 * working directory. Unless a repo's own .gitignore happens to exclude that
 * path, `git status` run at the repo root reports it as untracked, which would
 * make isDirty(repo) true essentially always and block every merge. The
 * pathspec exclusion below is what isDirty(cwd) does for any other directory,
 * scoped to the one path that's ours, not the user's actual outstanding work.
 */
async function isRepoDirty(repo: string): Promise<boolean> {
  const { stdout } = await run(
    'git', ['status', '--porcelain', '--', '.', ':!.claude/worktrees'], { cwd: repo },
  );
  return stdout.trim().length > 0;
}

export async function currentBranch(cwd: string): Promise<string> {
  const { stdout } = await run('git', ['branch', '--show-current'], { cwd });
  return stdout.trim();
}

export type MergeResult =
  | { ok: true; merged: string[]; target: string }
  | { ok: false; merged: string[]; error: string };

/**
 * Commits any outstanding changes in each selected worktree, then merges each
 * branch — in the given order — into whatever branch the base repo currently
 * has checked out, one `git merge --no-ff` per branch. Stops at the first
 * conflict, `merge --abort`s it, and reports which branches (if any) already
 * landed rather than leaving the repo mid-conflict.
 *
 * Callers must have already verified every session shares this `repo` and none
 * is `working`/`needs-you` (see the `merge` command in server.ts, the one
 * caller) — that check is what stops a branch from a different base repo, or a
 * currently-running agent's half-written files, from ending up here. This
 * function trusts both and only re-derives the merge target itself.
 */
export async function mergeWorktrees(
  repo: string,
  branches: { cwd: string; branch: string }[],
): Promise<MergeResult> {
  return withRepoLock(repo, async () => {
    const target = await currentBranch(repo);
    if (!target) {
      return {
        ok: false, merged: [],
        error: `${repo} is not on a branch (detached HEAD) — check it out onto one before merging into it`,
      };
    }
    if (await isRepoDirty(repo)) {
      return {
        ok: false, merged: [],
        error: `${repo} has uncommitted changes of its own on ${target} — commit or stash them before merging into it`,
      };
    }

    const merged: string[] = [];
    for (const { cwd, branch } of branches) {
      if (branch === target) {
        return { ok: false, merged, error: `"${branch}" is already ${repo}'s checked-out branch` };
      }
      if (await isDirty(cwd)) {
        try {
          await run('git', ['add', '-A'], { cwd });
          await run('git', ['commit', '-m', `Switchboard: outstanding changes on ${branch}`], { cwd });
        } catch (err) {
          return { ok: false, merged, error: `committing "${branch}" failed: ${errMsg(err)}` };
        }
      }
      try {
        await run(
          'git', ['merge', '--no-ff', branch, '-m', `Merge branch '${branch}' via Switchboard`],
          { cwd: repo },
        );
        merged.push(branch);
      } catch (err) {
        // Leave the repo the way we found it (on `target`, clean) rather than
        // mid-conflict — a failed merge here shouldn't hand the user an
        // unresolved conflict they didn't ask to be dropped into, and it lets
        // them fix the branch and retry without first cleaning up after us.
        await run('git', ['merge', '--abort'], { cwd: repo }).catch(() => {});
        return { ok: false, merged, error: `merging "${branch}" into ${target} conflicted: ${errMsg(err)}` };
      }
    }
    return { ok: true, merged, target };
  });
}

export type PushResult = { ok: true; output: string } | { ok: false; error: string };

/** Pushes the base repo's currently checked-out branch to `origin`. */
export async function pushRepo(repo: string): Promise<PushResult> {
  return withRepoLock(repo, async () => {
    try {
      const { stdout, stderr } = await run('git', ['push', 'origin', 'HEAD'], { cwd: repo });
      return { ok: true, output: (stdout + stderr).trim() };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  });
}
