/** Build only Switchboard-owned keys; never copy repository config or secrets. */
export function screenshotConfig(options: {
 nodePath:string; browserEntry:string; simulatorEntry:string;
 platform:NodeJS.Platform; chromePath:string|null; home:string;
 config:Record<string,unknown>;
}): {overrides:Record<string,unknown>;enabledNames:string[];warnings:string[]} {
 const overrides:Record<string,unknown>={};const enabledNames:string[]=[];const warnings:string[]=[];
 const servers=options.config.mcp_servers;
 if(servers!==undefined && (!servers || typeof servers!=='object'||Array.isArray(servers))) {
  return {overrides,enabledNames,warnings:['Screenshot tools unavailable: MCP configuration could not be checked.']};
 }
 const network=options.config.sandbox_workspace_write as {network_access?:unknown}|null|undefined;
 const add=(name:string,entry:string,executable:string)=>{
  if(servers && Object.hasOwn(servers,name)){warnings.push(`${name} is already configured; Switchboard left it unchanged.`);return;}
  const prefix=`mcp_servers.${name}.`;
  // env runs before Node, preventing inherited NODE_OPTIONS or account launch
  // secrets from reaching the sidecar or its capture subprocesses.
  overrides[prefix+'command']='/usr/bin/env';
  overrides[prefix+'args']=['-i','PATH=/usr/bin:/bin:/usr/sbin:/sbin',`HOME=${options.home}`,options.nodePath,entry,executable];
  overrides[prefix+'enabled']=true;overrides[prefix+'required']=false;
  overrides[prefix+'enabled_tools']=['screenshot'];overrides[prefix+'env_vars']=[];
  enabledNames.push(name);
 };
 if(options.chromePath && network?.network_access===true) add('switchboard_browser',options.browserEntry,options.chromePath);
 else warnings.push(options.chromePath?'Browser screenshots require worktree network access.':'Browser screenshots require a Chromium-family browser.');
 if(options.platform==='darwin')add('switchboard_simulator',options.simulatorEntry,'/usr/bin/xcrun');
 else warnings.push('Simulator screenshots require macOS.');
 return {overrides,enabledNames,warnings};
}
