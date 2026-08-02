import { open, lstat, realpath } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import type { AgentPrompt, PromptAttachment } from './types.ts';

const MAX_ATTACHMENTS = 10;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

function invalidPath(path: string): boolean {
  if (!path || isAbsolute(path)) return true;
  return path.split(/[\\/]/).some((part) => part === '..');
}

function isContained(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot.length > 0 && !isAbsolute(fromRoot)
    && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`);
}

function hasImageSignature(extension: string, header: Buffer): boolean {
  switch (extension) {
    case '.png':
      return header.subarray(0, 8).equals(Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]));
    case '.jpg':
    case '.jpeg':
      return header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
    case '.webp':
      return header.subarray(0, 4).toString('ascii') === 'RIFF'
        && header.subarray(8, 12).toString('ascii') === 'WEBP';
    default:
      return false;
  }
}

async function classifyImage(path: string, index: number): Promise<PromptAttachment['kind']> {
  const extension = extname(path).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension)) return 'file';

  const header = Buffer.alloc(12);
  const file = await open(path, 'r');
  let bytesRead = 0;
  try {
    ({ bytesRead } = await file.read(header, 0, header.length, 0));
  } finally {
    await file.close();
  }
  if (!hasImageSignature(extension, header.subarray(0, bytesRead))) {
    throw new Error(`Attachment ${index + 1} has invalid image contents.`);
  }
  return 'image';
}

/**
 * Turns untrusted browser paths into adapter input. Absolute paths are created
 * here, after filesystem containment checks, and never cross back into durable
 * or public session state.
 */
export async function resolveAgentPrompt(
  cwd: string,
  text: string,
  attachmentPaths: unknown,
): Promise<AgentPrompt> {
  const submitted = attachmentPaths === undefined ? [] : attachmentPaths;
  if (!Array.isArray(submitted)) throw new Error('Attachments must be an array.');
  if (submitted.length > MAX_ATTACHMENTS) throw new Error('At most 10 attachments are allowed.');
  if (!submitted.every((path) => typeof path === 'string')) {
    throw new Error('Attachment paths must be strings.');
  }

  if ((submitted as string[]).some(invalidPath)) {
    throw new Error('Attachment paths must stay inside the worktree.');
  }
  const paths = (submitted as string[]).map((path) => normalize(path));
  if (new Set(paths).size !== paths.length) throw new Error('Attachment paths must be unique.');

  let realCwd: string;
  try {
    realCwd = await realpath(cwd);
  } catch {
    throw new Error('The session worktree is unavailable.');
  }

  const attachments: PromptAttachment[] = [];
  for (const [index, relativePath] of paths.entries()) {
    const submittedPath = join(cwd, relativePath);
    let submittedStat;
    try {
      submittedStat = await lstat(submittedPath);
    } catch {
      throw new Error(`Attachment ${index + 1} does not exist.`);
    }
    if (submittedStat.isSymbolicLink()) {
      throw new Error(`Attachment ${index + 1} must be a regular file, not a symbolic link.`);
    }
    if (!submittedStat.isFile()) throw new Error(`Attachment ${index + 1} must be a regular file.`);

    let realCandidate: string;
    try {
      realCandidate = await realpath(submittedPath);
    } catch {
      throw new Error(`Attachment ${index + 1} does not exist.`);
    }
    if (!isContained(realCwd, realCandidate)) {
      throw new Error('Attachment paths must stay inside the worktree.');
    }

    attachments.push({
      name: basename(relativePath),
      relativePath,
      absolutePath: submittedPath,
      kind: await classifyImage(realCandidate, index),
    });
  }

  return { text, attachments };
}
