import { screenshotResult } from './screenshot-result.ts';
import { capture, run, type Capture } from './capture.ts';

/**
 * Devices are named by the agent, so this is a trust boundary. execFile takes an
 * argv array (no shell), which rules out injection but not argument smuggling —
 * a name starting with `-` would be read by simctl as a flag. Requiring the
 * first character to be alphanumeric costs nothing: real names are `booted`, a
 * UUID, or something like "iPhone 16 Pro".
 */
const DEVICE = /^[A-Za-z0-9][A-Za-z0-9 _.-]*$/;

/**
 * One PNG of the simulator's screen, base64-encoded.
 *
 * `xcrun` is a parameter so tests can point at a fake the same way the Codex
 * tests point at a fake codex binary — the real boundary stays in play, no
 * simulator required.
 */
export async function captureScreenshot(device = 'booted', xcrun = 'xcrun'): Promise<Capture> {
  if (!DEVICE.test(device)) return { ok: false, error: `invalid device name: ${device}` };
  return capture((file) => run(xcrun, ['simctl', 'io', device, 'screenshot', file]));
}


export async function simulatorScreenshot({device}: {device?:string}, xcrun = 'xcrun') {
  return screenshotResult(await captureScreenshot(device,xcrun));
}
