import { screenshotResult } from './screenshot-result.ts';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { capture, type Capture } from './capture.ts';

/**
 * First Chromium-family browser that is actually installed, or null.
 *
 * Resolved once at load: the app list on a Mac does not change mid-session, and
 * a null here is what keeps the tool from being advertised at all.
 */
export const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
].find((p) => existsSync(p)) ?? null;

/** Viewport when the agent does not ask for one. Ordinary desktop. */
export const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

/** How often to check whether Chrome has written the file yet. */
const POLL_MS = 200;

/** Wall-clock ceiling for one capture. A real load lands in a few seconds. */
const TIMEOUT_MS = 30_000;

/**
 * URLs come from the agent and become argv, so this is a trust boundary.
 * Parsing with the stdlib URL does the whole job: it rejects anything starting
 * with `-` (which Chrome would read as a flag), and the protocol check then
 * rules out `file:`, `chrome:` and `javascript:` — three ways a "screenshot"
 * could turn into reading local disk or running script in a privileged page.
 */
function httpUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return /^https?:$/.test(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Run Chrome until the screenshot lands, then kill it.
 *
 * Headless Chrome (tested against 150) writes the file and then keeps running,
 * so waiting for it to exit hangs forever — the file appearing is the only
 * completion signal there is. Two equal nonzero sizes in a row means the write
 * finished rather than being caught halfway.
 *
 * ponytail: polling, not CDP. A DevTools connection would give a real load
 * event and console errors too, and Node 22's native WebSocket makes it
 * dependency-free — that is the upgrade path when console output is wanted. It
 * is a lot more moving parts for a picture.
 */
async function shoot(chrome: string, args: string[], file: string, timeoutMs: number): Promise<void> {
  // Its own process group: Chrome leaves GPU, network and renderer helpers
  // behind, and killing the group takes all of them rather than orphaning them.
  const child = spawn(chrome, args, { detached: true, stdio: 'ignore' });
  let spawnError: Error | null = null;
  child.on('error', (err) => { spawnError = err; });
  try {
    const deadline = Date.now() + timeoutMs;
    let size = 0;
    let stable = 0;
    while (Date.now() < deadline) {
      await new Promise((r) => { setTimeout(r, POLL_MS); });
      if (spawnError) throw spawnError;
      const now = await stat(file).then((s) => s.size).catch(() => 0);
      stable = now > 0 && now === size ? stable + 1 : 0;
      if (stable >= 2) return;
      size = now;
    }
    throw new Error(`the browser wrote no screenshot within ${timeoutMs}ms`);
  } finally {
    // Negative pid = the whole group. Nothing else runs in it, and the user's
    // own Chrome is a different process group with a different profile.
    try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

/**
 * One PNG of a rendered web page, base64-encoded.
 *
 * A server that is down is not an error here: Chrome renders its own "This site
 * can't be reached / ERR_CONNECTION_REFUSED" page, and handing that back is
 * more use to the agent than a string, because it is what a human would see.
 */
export async function capturePage(
  raw: string,
  { width = DEFAULT_VIEWPORT.width, height = DEFAULT_VIEWPORT.height, timeoutMs = TIMEOUT_MS } = {},
  chrome = CHROME,
): Promise<Capture> {
  if (!chrome) return { ok: false, error: 'no Chromium-family browser is installed' };
  const url = httpUrl(raw);
  if (!url) return { ok: false, error: `invalid url (http and https only): ${raw}` };
  return capture((file) => shoot(chrome, [
    '--headless',
    `--screenshot=${file}`,
    `--window-size=${width},${height}`,
    '--hide-scrollbars',
    // A throwaway profile inside the scratch directory. Without it Chrome opens
    // the user's real profile, which fails outright while their browser is
    // running and would otherwise put their cookies behind the capture.
    `--user-data-dir=${join(dirname(file), 'profile')}`,
    '--no-first-run',
    '--no-default-browser-check',
    // A screenshot should not phone home. Without these Chrome starts its
    // updater and registers for push on the way past.
    '--disable-background-networking',
    '--disable-component-update',
    '--no-service-autorun',
    url,
  ], file, timeoutMs));
}


export async function browserScreenshot({url,width,height}: {url:string;width?:number;height?:number}, chrome = CHROME) {
  return screenshotResult(await capturePage(url,{width,height},chrome));
}
