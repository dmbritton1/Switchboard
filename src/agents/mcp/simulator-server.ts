import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';
import {simulatorScreenshot} from '../simulator-capture.ts';
const server=new McpServer({name:'switchboard_simulator',version:'0.1.0'});
server.registerTool('screenshot',{description:'Capture a simulator screenshot as a PNG image.',inputSchema:{device:z.string().optional()},annotations:{readOnlyHint:true,destructiveHint:false}},args=>simulatorScreenshot(args,process.argv[2]));
try {await server.connect(new StdioServerTransport());}
catch {console.error('Screenshot server failed to start.');process.exitCode=1;}
