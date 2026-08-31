import { readFile, writeFile, rename } from 'node:fs/promises';
import type { CodexTransport } from './agents/codex-provider.ts';

export type Account = {
  name: string;
  provider: 'claude' | 'codex';
  budget: number;
  env: Record<string, string>;
  bin?: string;
  /** Who this account belongs to, when the provider told us. Used only to stop
   *  the same account being linked twice under two names. Absent for
   *  hand-written entries and for auth modes that expose no identity. */
  identity?: string;
  /** Account-level rollout choice for future Codex sessions. Omission stays SDK-default. */
  codexTransport?: CodexTransport;
};

export const DEFAULT_BUDGET = 2_000_000;

/** An account name becomes a directory under the accounts root, so this is a
 *  trust boundary, not a cosmetic rule: the browser supplies the name. Same
 *  posture as the upload handler (src/server.ts) — reject what we would have
 *  had to rewrite rather than rewriting it silently. */
export const ACCOUNT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function validateAccountName(name: unknown, existing: Account[]): string | null {
  if (typeof name !== 'string') return 'name must be a string';
  if (!ACCOUNT_NAME_RE.test(name)) {
    return 'name must be 1-32 characters of lowercase letters, digits or hyphens, and start with a letter or digit';
  }
  if (existing.some((a) => a.name === name)) return `an account named ${name} already exists`;
  return null;
}

/** A missing file is the first-run case and loads as an empty list. Malformed
 *  JSON is NOT: that is a hand-edit the user needs told about, and silently
 *  starting with zero accounts would look like their accounts vanished. */
export async function loadAccounts(path: string): Promise<Account[]> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`${path} must contain a JSON array`);
  return parsed.map((entry, index) => validateAccount(entry, index));
}

function validateAccount(value: unknown, index: number): Account {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`accounts.json entry ${index + 1} must be an object`);
  }
  const entry = value as Record<string, unknown>;
  if (typeof entry.name !== 'string') throw new Error(`accounts.json entry ${index + 1} name must be a string`);
  if (entry.provider !== 'claude' && entry.provider !== 'codex') {
    throw new Error(`accounts.json entry ${index + 1} provider must be claude or codex`);
  }
  if (typeof entry.budget !== 'number' || !Number.isFinite(entry.budget)) {
    throw new Error(`accounts.json entry ${index + 1} budget must be a finite number`);
  }
  if (!entry.env || typeof entry.env !== 'object' || Array.isArray(entry.env)
    || Object.values(entry.env).some((item) => typeof item !== 'string')) {
    throw new Error(`accounts.json entry ${index + 1} env must be a string map`);
  }
  if (entry.bin !== undefined && typeof entry.bin !== 'string') {
    throw new Error(`accounts.json entry ${index + 1} bin must be a string`);
  }
  if (entry.identity !== undefined && typeof entry.identity !== 'string') {
    throw new Error(`accounts.json entry ${index + 1} identity must be a string`);
  }
  if (entry.codexTransport !== undefined) {
    if (entry.provider !== 'codex') {
      throw new Error(`accounts.json entry ${index + 1} codexTransport is only valid for Codex accounts`);
    }
    if (entry.codexTransport !== 'sdk' && entry.codexTransport !== 'app-server') {
      throw new Error(`accounts.json entry ${index + 1} codexTransport must be sdk or app-server`);
    }
  }
  return {
    name: entry.name,
    provider: entry.provider,
    budget: entry.budget,
    env: { ...entry.env as Record<string, string> },
    ...(entry.bin !== undefined ? { bin: entry.bin } : {}),
    ...(entry.identity !== undefined ? { identity: entry.identity } : {}),
    ...(entry.codexTransport !== undefined ? { codexTransport: entry.codexTransport } : {}),
  };
}

export type AccountStore = {
  append(entry: Account): Promise<void>;
  remove(name: string): Promise<void>;
};

/**
 * Both mutators are read-modify-write, never a blind write of an in-memory
 * array. accounts.json is hand-editable and a link parks for minutes waiting on
 * a browser, so an edit made in that window has to survive — see the
 * append-only rule in the design doc.
 *
 * Writes are serialized behind one chain and use a temp file next to the
 * destination, mirroring Registry#save (src/sessions.ts): two concurrent writes
 * to the same temp path would race each other's rename.
 */
export function createAccountStore(path: string): AccountStore {
  let chain: Promise<void> = Promise.resolve();

  const mutate = (fn: (current: Account[]) => Account[]): Promise<void> => {
    const next = chain.then(async () => {
      const current = await loadAccounts(path);
      const tmp = `${path}.tmp`;
      await writeFile(tmp, `${JSON.stringify(fn(current), null, 2)}\n`);
      await rename(tmp, path);
    });
    // The chain link always resolves so one failed write cannot wedge every
    // write after it; the rejection still reaches this call's caller.
    chain = next.catch(() => {});
    return next;
  };

  return {
    append: (entry) => mutate((current) => [...current, entry]),
    remove: (name) => mutate((current) => current.filter((a) => a.name !== name)),
  };
}
