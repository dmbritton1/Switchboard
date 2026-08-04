import { z } from 'zod';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
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

/**
 * The one simulator capability the agent cannot get from Bash.
 *
 * Everything else it might want — `simctl list`, `boot`, `install`, `launch`,
 * `xcodebuild test` — is already reachable through the Bash tool, so wrapping
 * those would be a second way to do what already works. Only an image has to
 * come back as a tool result, because that is the sole path from a PNG on disk
 * into what the model can actually see.
 *
 * Not exposed: tap/swipe/typing. simctl has no input injection at all, so that
 * needs idb or XCUITest — a real dependency and a separate decision.
 */
export const simulatorServer = createSdkMcpServer({
  name: 'simulator',
  version: '0.1.0',
  instructions:
    'Screenshots of the iOS Simulator on this machine. Boot, install, launch and '
    + 'test with xcrun simctl and xcodebuild through Bash; use this only to look at the screen.',
  tools: [
    tool(
      'screenshot',
      'Capture the iOS Simulator screen as an image. Boot a device with '
      + '`xcrun simctl boot` first if none is running.',
      {
        device: z.string().optional()
          .describe('Device UDID or name. Defaults to the currently booted device.'),
      },
      async ({ device }) => {
        const shot = await captureScreenshot(device);
        if (!shot.ok) return { content: [{ type: 'text', text: shot.error }], isError: true };
        return { content: [{ type: 'image', data: shot.base64, mimeType: 'image/png' }] };
      },
    ),
  ],
});
