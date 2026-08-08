import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';

const UPLOAD_PREFIX = '.switchboard-upload-';
const STORED_UPLOAD = /^\.switchboard-upload-[0-9a-f]{32}-(.+)$/s;

export class UploadChangedError extends Error {}

/** Recover the browser filename while keeping the random storage path out of durable transcript state. */
export function uploadAttachmentName(relativePath: string): string {
  const storedName = basename(relativePath);
  return storedName.match(STORED_UPLOAD)?.[1] ?? storedName;
}

/**
 * Writes to an unpredictable direct child of the canonical worktree root.
 * There is no attacker-mutable intermediate directory, O_EXCL makes the leaf
 * ours, O_NOFOLLOW refuses a pre-created symlink, and all bytes go through the
 * opened handle even if a hostile process subsequently replaces the pathname.
 *
 * The root is the one component still resolved by path at open() time, so its
 * identity is pinned from the validating lstat() — not re-read afterwards, which
 * would just pin whatever the attacker swapped in — and reconfirmed against that
 * pin at every step that can act on it: before the bytes go out, and before a
 * path is reported to the caller. lstat(cwd) and lstat(realpath(cwd)) name the
 * same directory once the leaf is known not to be a symlink, so comparing them
 * is what catches a swap during realpath().
 *
 * ponytail: one window stays open — a swap landing between the pin and open()
 * creates an empty 0600 file under the attacker's directory. Nothing is written
 * to it and no path is returned, so it leaks nothing; closing it needs
 * openat(2)-style resolution against a pinned directory fd, which Node does not
 * expose. Not worth building: the only actor that can replace the root is an
 * unsandboxed agent process running as this same uid, which can already rewrite
 * this file, edit accounts.json, or kill the server. The fix for that actor is
 * sandboxing, not more checks here.
 */
export async function writeContainedUpload(
  cwd: string,
  name: string,
  bytes: Buffer,
  hooks: {
    beforeRootPin?: () => Promise<void>;
    beforeWrite?: (target: string) => Promise<void>;
  } = {},
): Promise<string> {
  const rootStat = await lstat(cwd);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('session worktree is unavailable');
  }
  const root = await realpath(cwd);
  const requireOriginalRoot = async (): Promise<void> => {
    const now = await lstat(root).catch(() => null);
    if (!now || now.dev !== rootStat.dev || now.ino !== rootStat.ino) {
      throw new UploadChangedError('session worktree changed while the upload was being written');
    }
  };
  await hooks.beforeRootPin?.();
  await requireOriginalRoot();
  const storedName = `${UPLOAD_PREFIX}${randomUUID().replaceAll('-', '')}-${name}`;
  if (Buffer.byteLength(storedName, 'utf8') > 255) throw new Error('filename is too long');
  const target = join(root, storedName);
  const file = await open(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  let openedStat;
  try {
    openedStat = await file.stat();
    await hooks.beforeWrite?.(target);
    await requireOriginalRoot();
    await file.writeFile(bytes);
  } finally {
    await file.close();
  }

  const current = await lstat(target).catch(() => null);
  if (!current || current.isSymbolicLink()
    || current.dev !== openedStat.dev || current.ino !== openedStat.ino) {
    throw new UploadChangedError('upload changed while it was being written');
  }
  // storedName is resolved against session.cwd by whoever receives it, so a root
  // swapped in after the write would redirect that later read even though these
  // bytes landed correctly. Reporting the path is itself an action on the root.
  await requireOriginalRoot();
  return storedName;
}
