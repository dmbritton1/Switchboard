import {screenshotConfig} from '../src/agents/codex-mcp-config.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {mkdtemp,writeFile,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
for(const kind of ['browser','simulator']) test(`${kind} sidecar advertises only screenshot and returns PNG through stdio`,async t=>{
 const dir=await mkdtemp(join(tmpdir(),'sb-sidecar-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const fake=join(dir,'capture');await writeFile(fake,`#!${process.execPath}\nconst fs=require('node:fs');if(process.env.SCREENSHOT_SECRET)process.exit(9);const args=process.argv.slice(2);const target=args.find(a=>a.startsWith('--screenshot='))?.slice(13)||args.at(-1);fs.writeFileSync(target,Buffer.from('${png}','base64'));`);await chmod(fake,0o755);
 const entry=fileURLToPath(new URL(`../src/agents/mcp/${kind}-server.ts`,import.meta.url));
 const config=screenshotConfig({nodePath:process.execPath,browserEntry:entry,simulatorEntry:entry,chromePath:fake,home:dir,platform:'darwin',config:{sandbox_workspace_write:{network_access:true}}});
 const prefix=`mcp_servers.switchboard_${kind}.`;
 const args=config.overrides[prefix+'args'] as string[];
 // Replace the fixed xcrun executable at this isolated process boundary.
 if(kind==='simulator')args[args.length-1]=fake;
 const transport=new StdioClientTransport({command:config.overrides[prefix+'command'] as string,args,env:{SCREENSHOT_SECRET:'must-not-reach-capture'},stderr:'pipe'});
 const client=new Client({name:'test',version:'1'});t.after(()=>client.close());await client.connect(transport);
 assert.deepEqual((await client.listTools()).tools.map(t=>t.name),['screenshot']);
 const good=await client.callTool({name:'screenshot',arguments:kind==='browser'?{url:'http://localhost:1234'}:{device:'booted'}});
 assert.equal(good.isError,undefined);assert.equal((good.content as any[])[0].type,'image');assert.equal((good.content as any[])[0].mimeType,'image/png');
 const bad=await client.callTool({name:'screenshot',arguments:kind==='browser'?{url:'file:///private/data'}:{device:'--help'}});
 assert.equal(bad.isError,true);
});
