import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';
import {browserScreenshot} from '../browser-capture.ts';
const server=new McpServer({name:'switchboard_browser',version:'0.1.0'});
server.registerTool('screenshot',{description:'Capture a browser screenshot as a PNG image.',inputSchema:{url:z.string(),width:z.number().int().min(200).max(3000).optional(),height:z.number().int().min(200).max(3000).optional()},annotations:{readOnlyHint:true,destructiveHint:false}},args=>browserScreenshot(args,process.argv[2]));
try {await server.connect(new StdioServerTransport());}
catch {console.error('Screenshot server failed to start.');process.exitCode=1;}
