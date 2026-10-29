import { z } from 'zod';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { capturePage, browserScreenshot, CHROME, DEFAULT_VIEWPORT } from './browser-capture.ts';
export { capturePage, browserScreenshot, CHROME, DEFAULT_VIEWPORT } from './browser-capture.ts';

/**
 * The one web capability the agent cannot get from Bash.
 *
 * curl already fetches the HTML, so nothing here wraps the network. What Bash
 * cannot do is hand back a picture of the page after its JavaScript has run —
 * the difference between reading a template and seeing what the human sees.
 *
 * Not exposed: console errors, network failures, clicking. Those need a CDP
 * connection rather than a screenshot flag; see the note on `shoot`.
 */
export const browserServer = createSdkMcpServer({
  name: 'browser',
  version: '0.1.0',
  instructions:
    'Screenshots of rendered web pages. Start dev servers and fetch raw responses '
    + 'with Bash as usual; use this only to look at what a page renders.',
  tools: [
    tool(
      'screenshot',
      'Render a web page in headless Chrome and capture it as an image. Start the '
      + 'dev server with Bash first if the page is local.',
      {
        url: z.string().describe('Absolute http:// or https:// URL, e.g. http://localhost:3000'),
        width: z.number().int().min(200).max(3000).optional()
          .describe(`Viewport width in px. Defaults to ${DEFAULT_VIEWPORT.width}; use ~390 for mobile.`),
        height: z.number().int().min(200).max(3000).optional()
          .describe(`Viewport height in px. Defaults to ${DEFAULT_VIEWPORT.height}.`),
      },
      (args) => browserScreenshot(args),
    ),
  ],
});
