import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const run = promisify(execFile);

/**
 * Longest edge, in pixels, of a screenshot handed to the model.
 *
 * ponytail: a fixed downscale, not a quality/format knob. A raw iPhone capture
 * is ~1200x2600 and several megabytes; the model caps images around 1568px on
 * the long edge anyway, so full resolution buys nothing and costs context on
 * every single look. Upgrade path if UI text ever reads too small: raise this,
 * or switch sips to `-s format jpeg` for another large cut.
 */
export const MAX_EDGE = 1000;

export type Capture =
  | { ok: true; base64: string }
  | { ok: false; error: string };

/**
 * The part every screenshot source shares: a scratch directory, a downscale, a
 * base64 encode, and cleanup that runs whether or not the capture worked.
 *
 * `produce` writes the PNG to the path it is handed. It gets a whole directory
 * to itself (via `dirname`) because some producers need scratch space of their
 * own — headless Chrome wants a throwaway profile — and one `rm -rf` then
 * clears all of it.
 */
export async function capture(produce: (file: string) => Promise<unknown>): Promise<Capture> {
  const dir = await mkdtemp(join(tmpdir(), 'switchboard-shot-'));
  const file = join(dir, 'shot.png');
  try {
    await produce(file);
    // Best-effort: sips is stock macOS, but a resize failure is no reason to
    // throw away a screenshot we already have. Falls through to the full-size
    // capture, which still works — just costs more context.
    await run('sips', ['-Z', String(MAX_EDGE), file]).catch(() => {});
    return { ok: true, base64: (await readFile(file)).toString('base64') };
  } catch (err) {
    // The tool's own stderr is the useful part ("No devices are booted.",
    // "ERR_CONNECTION_REFUSED"), and it is the agent's cue to fix the cause
    // itself rather than report a dead end.
    const detail = (err as { stderr?: string }).stderr?.trim()
      || String((err as Error).message ?? err);
    return { ok: false, error: detail };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
