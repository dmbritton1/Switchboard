import { z } from 'zod';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { captureScreenshot, simulatorScreenshot } from './simulator-capture.ts';
export { captureScreenshot, simulatorScreenshot } from './simulator-capture.ts';

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
      (args) => simulatorScreenshot(args),
    ),
  ],
});
