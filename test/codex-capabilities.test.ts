import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {CodexCapabilityCatalog} from '../src/agents/codex-capabilities.ts';

test('catalog reads paginated sources, isolates contexts, redacts native paths, and resolves selections',async t=>{
 const cwd=await mkdtemp(join(tmpdir(),'sb-cap-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
 const calls:any[]=[];
 const catalog=new CodexCapabilityCatalog(async(method,p)=>{calls.push({method,p});
  if(method==='skills/list')return {data:[{cwd,skills:[{name:'build',description:'Build private-token',path:cwd+'/SKILL.md',enabled:true}],errors:[]}]};
  if(method==='app/installed')return {apps:[{id:'app-one',enabled:true,callable:true}]};
  if(method==='app/list')return p.cursor?{data:[{id:'app-two',name:'Offline',description:null,isAccessible:false,isEnabled:true}],nextCursor:null}:{data:[{id:'app-one',name:'Connected',description:'App',isAccessible:true,isEnabled:true}],nextCursor:'next'};
  return {data:[{name:'local',runtimeStatus:'connected',tools:{build:{name:'build',description:'Tool'}}}],nextCursor:null};
 },s=>s.replaceAll('private-token','[redacted]'));
 const first=await catalog.list(cwd,'thread-a');
 assert.equal(first.capabilities.length,4);assert.equal(calls.filter(c=>c.method==='app/list').length,2);
 assert.ok(!JSON.stringify(first).includes(cwd));assert.ok(!JSON.stringify(first).includes('private-token'));
 const skill=first.capabilities.find(c=>c.kind==='skill')!;
 assert.deepEqual(await catalog.expand(skill.id,cwd,'thread-a'),[{type:'skill',name:'build',path:cwd+'/SKILL.md'}]);
 const app=first.capabilities.find(c=>c.displayName==='Connected')!;
 assert.deepEqual(await catalog.expand(app.id,cwd,'thread-a'),[{type:'mention',name:'Connected',path:'app://app-one'}]);
 assert.equal(await catalog.expand(first.capabilities.find(c=>!c.available)!.id,cwd,'thread-a'),null);
 const count=calls.length;await catalog.list(cwd,'thread-a');assert.equal(calls.length,count);
 await catalog.list(cwd,'thread-b');assert.ok(calls.length>count);
 catalog.invalidate();const updated=await catalog.list(cwd,'thread-a');assert.ok(updated.revision>first.revision);
});
test('failed sources expose bounded warnings and refresh failure cannot reuse stale native selections',async t=>{
 const cwd=await mkdtemp(join(tmpdir(),'sb-cap-'));t.after(()=>rm(cwd,{recursive:true,force:true}));let fail=false;
 const catalog=new CodexCapabilityCatalog(async(method)=>{
 if(fail)throw new Error('private-path-and-token');
 return method==='skills/list'?{data:[{cwd,skills:[{name:'one',description:'One',path:cwd+'/SKILL.md',enabled:true}]}]}:method==='app/installed'?{apps:[]}:{data:[],nextCursor:null};
 },s=>s);
 const first=await catalog.list(cwd,'t');fail=true;const next=await catalog.list(cwd,'t',true);
 assert.equal(next.capabilities.length,0);assert.ok(next.warnings.length);assert.ok(!JSON.stringify(next).includes('private-path'));
 assert.equal(await catalog.expand(first.capabilities[0].id,cwd,'t'),null);
});

test('alias collisions stay distinct and invalidation discards an in-flight inventory',async t=>{
 const cwd=await mkdtemp(join(tmpdir(),'sb-cap-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
 let release!:()=>void; let blocked=false;
 const gate=new Promise<void>(r=>release=r);
 const catalog=new CodexCapabilityCatalog(async(method)=>{
  if(method==='skills/list'){if(blocked)await gate;return {data:[{cwd,skills:['a','b'].map(folder=>({name:'same',description:'',path:cwd+'/'+folder+'/SKILL.md',enabled:true}))}]};}
  return method==='app/installed'?{apps:[]}:{data:[],nextCursor:null};
 },s=>s);
 const snapshot=await catalog.list(cwd,'t');
 assert.equal(new Set(snapshot.capabilities.map(c=>c.alias)).size,2);
 assert.equal(await catalog.expand('skill:same',cwd,'t'),null);
 blocked=true;const pending=catalog.list(cwd,'t',true);
 await new Promise(r=>setTimeout(r,20));catalog.invalidate();release();
 await assert.rejects(pending,/changed/);
});

test('preview never presents process-wide MCP tools as repository capabilities',async t=>{
 const cwd=await mkdtemp(join(tmpdir(),'sb-preview-'));t.after(()=>rm(cwd,{recursive:true,force:true}));const calls:string[]=[];
 const catalog=new CodexCapabilityCatalog(async method=>{calls.push(method);return method==='skills/list'?{data:[]}:method==='app/installed'?{apps:[]}:{data:[],nextCursor:null};},s=>s);
 const result=await catalog.list(cwd);
 assert.ok(!calls.includes('mcpServerStatus/list'));
 assert.ok(result.warnings.some(s=>s.includes('session')));
});
