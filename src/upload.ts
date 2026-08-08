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
 */
export async function writeContainedUpload(
  cwd: string,
  name: string,
  bytes: Buffer,
  beforeWrite?: (target: string) => Promise<void>,
): Promise<string> {
  const rootStat = await lstat(cwd);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('session worktree is unavailable');
  }
  const root = await realpath(cwd);
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
    await beforeWrite?.(target);
    await file.writeFile(bytes);
  } finally {
    await file.close();
  }

  const current = await lstat(target).catch(() => null);
  if (!current || current.isSymbolicLink()
    || current.dev !== openedStat.dev || current.ino !== openedStat.ino) {
    throw new UploadChangedError('upload changed while it was being written');
  }
  return storedName;
}
