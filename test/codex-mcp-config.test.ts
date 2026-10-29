import test from 'node:test';
import assert from 'node:assert/strict';
import {screenshotConfig} from '../src/agents/codex-mcp-config.ts';
test('screenshot configuration respects worktree network policy and reserved names',()=>{
 const base={nodePath:'/node with spaces',browserEntry:'/browser.ts',simulatorEntry:'/sim.ts',platform:'darwin' as const,chromePath:'/Chrome',home:'/home/user'};
 let result=screenshotConfig({...base,config:{sandbox_workspace_write:{network_access:false}}});
 assert.deepEqual(result.enabledNames,['switchboard_simulator']);
 result=screenshotConfig({...base,config:{sandbox_workspace_write:{network_access:true},mcp_servers:{switchboard_browser:{command:'user-owned'}}}});
 assert.deepEqual(result.enabledNames,['switchboard_simulator']);assert.match(result.warnings.join(' '),/already configured/);
 result=screenshotConfig({...base,platform:'linux',chromePath:null,config:{}});assert.deepEqual(result.enabledNames,[]);
});
test('sidecars start with a clean environment and only screenshot enabled',()=>{
 const result=screenshotConfig({nodePath:'/node "quoted"',browserEntry:'/browser.ts',simulatorEntry:'/sim.ts',platform:'darwin',chromePath:'/Chrome',home:'/home/user',config:{sandbox_workspace_write:{network_access:true},mcp_servers:{other:{env:{TOKEN:'private'}}}}});
 assert.equal(result.overrides['mcp_servers.switchboard_browser.command'],'/usr/bin/env');
 assert.deepEqual(result.overrides['mcp_servers.switchboard_browser.args'],['-i','PATH=/usr/bin:/bin:/usr/sbin:/sbin','HOME=/home/user','/node "quoted"','/browser.ts','/Chrome']);
 assert.deepEqual(result.overrides['mcp_servers.switchboard_browser.enabled_tools'],['screenshot']);
 assert.ok(!JSON.stringify(result).includes('private'));assert.equal(result.overrides['mcp_servers.other'],undefined);
});
