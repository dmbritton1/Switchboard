import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeElicitation, elicitationResult } from '../src/agents/codex-elicitation.ts';
import { CodexApprovals } from '../src/agents/codex-approvals.ts';
const form = () => ({mode:'form',serverName:'fixture',message:'Enter details',turnId:null,requestedSchema:{type:'object',properties:{
 name:{type:'string',minLength:2,maxLength:12}, count:{type:'integer',minimum:1,maximum:5}, agree:{type:'boolean'},
 color:{type:'string',enum:['private-value','blue'],enumNames:['Red','Blue']},
 tags:{type:'array',items:{type:'string',enum:['a','b']},minItems:1,maxItems:2},
},required:['name','count','agree','color','tags']}});
const normalize=(p:unknown)=>normalizeElicitation(p,s=>s.replaceAll('private-value','[redacted]'));
test('forms validate typed values and map opaque field and option IDs to wire values',()=>{
 const e=normalize(form())!; assert.equal(e.public.mode,'form');
 const fields=e.public.fields!; const values=Object.fromEntries(fields.map((f,i)=>[f.id,['Ada',2,false,f.options?.[0].id,[f.options?.[0].id]][i]]));
 assert.deepEqual(elicitationResult(e,{action:'accept',values}),{action:'accept',content:{name:'Ada',count:2,agree:false,color:'private-value',tags:['a']},_meta:null});
 assert.ok(!JSON.stringify(e.public).includes('private-value'));
 for(const bad of [{...values,[fields[1].id]:2.5},{...values,[fields[1].id]:6},{...values,[fields[2].id]:'false'},{...values,[fields[3].id]:'unknown'},{...values,[fields[4].id]:[]},{...values,unknown:1},{}]) assert.equal(elicitationResult(e,{action:'accept',values:bad}),null);
 assert.deepEqual(elicitationResult(e,{action:'cancel'}),{action:'cancel',content:null,_meta:null});
 assert.equal(elicitationResult(e,{action:'decline',values}),null);
});
test('unsupported schemas and unsafe URLs fail closed without publishing raw payloads',()=>{
 for(const p of [null,{...form(),mode:'openai/form'},{...form(),requestedSchema:{type:'object',properties:{x:{type:'object'}}}},
 {...form(),requestedSchema:{type:'object',properties:{x:{type:'string',pattern:'.*'}}}},
 {...form(),requestedSchema:{type:'object',properties:{},required:['missing']}}]) assert.equal(normalize(p),null);
 for(const url of ['javascript:alert(1)','data:text/html,x','file:///tmp/test','http://example.com','https://user:pass@example.com']) assert.equal(normalize({mode:'url',serverName:'fixture',message:'Continue',url,elicitationId:'private'}),null);
 const e=normalize({mode:'url',serverName:'fixture',message:'Continue',url:'https://example.com/auth?token=private-value',elicitationId:'private'})!;
 assert.equal(e.public.destination,'https://example.com');assert.ok(!JSON.stringify(e.public).includes('token'));
 assert.deepEqual(elicitationResult(e,{action:'accept'}),{action:'accept',content:null,_meta:null});
});
test('elicitation stays pending under Auto, waits for resolution, and cancels on Stop',()=>{
 let head:any;const sent:unknown[]=[];
 const q=new CodexApprovals(true,p=>head=p,(id,result)=>sent.push({id,result}));
 q.addElicitation('wire',normalize(form())!);q.setAuto(true);q.decide(true);
 assert.equal(sent.length,0);assert.equal(head.elicitation.mode,'form');
 assert.equal(q.respondElicitation('stale',{action:'cancel'}),false);
 assert.equal(q.respondElicitation(head.id,{action:'decline'}),true);
 assert.equal(head.responding,true);assert.equal(q.respondElicitation(head.id,{action:'accept'}),false);
 q.resolved('wire');assert.equal(head,null);
 q.addElicitation('next',normalize(form())!);q.cancel();
 assert.deepEqual(sent.at(-1),{id:'next',result:{action:'cancel',content:null,_meta:null}});
});
