import {createHash} from 'node:crypto';
import {realpath} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
export type Capability = {id:string;kind:'skill'|'app'|'mcp-tool';alias:string;displayName:string;description:string;available:boolean;unavailableReason:string|null};
export type CapabilitySnapshot = {revision:number;capabilities:Capability[];warnings:string[]};
type Native = {public:Capability;input:Record<string,unknown>[]};
type Cached = {revision:number;expires:number;entries:Native[];warnings:string[]};
export const CAPABILITY_METHODS=['skills/list','app/list','app/installed','mcpServerStatus/list'] as const;
export const CAPABILITY_NOTIFICATIONS=['skills/changed','app/list/updated','mcpServer/startupStatus/updated'] as const;
const obj=(v:unknown):Record<string,any>|null=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:null;
const str=(v:unknown,max=1024):v is string=>typeof v==='string'&&v.length>0&&v.length<=max;
const identifier=(v:unknown):v is string=>str(v,256)&&/^[a-zA-Z0-9_.:-]+$/.test(v);
const id=(s:string)=>createHash('sha256').update(s).digest('hex').slice(0,24);
const slug=(s:string)=>s.toLowerCase().replace(/[^a-z0-9_.-]+/g,'-').replace(/^-|-$/g,'').slice(0,60)||'item';

/** One account-owned catalog; native identities never leave this process. */
export class CodexCapabilityCatalog {
 #request:(method:string,params:Record<string,unknown>)=>Promise<unknown>;
 #redact:(s:string)=>string;
 #revision=0;
 #cache=new Map<string,Cached>();
 #pending=new Map<string,Promise<Cached>>();
 constructor(request:(method:string,params:Record<string,unknown>)=>Promise<unknown>,redact:(s:string)=>string){this.#request=request;this.#redact=redact;}
 invalidate():void{this.#revision++;this.#cache.clear();this.#pending.clear();}
 async #page(method:string,params:Record<string,unknown>):Promise<any[]>{
  let cursor:string|undefined;const seen=new Set<string>();const rows:any[]=[];
  for(let page=0;page<20;page++){
   const result=obj(await this.#request(method,{...params,limit:100,...(cursor?{cursor}:{})}));
   if(!result||!Array.isArray(result.data)||result.data.length>1000)throw new Error('Invalid capability page');
   rows.push(...result.data);if(rows.length>2000)throw new Error('Capability inventory too large');
   if(result.nextCursor==null)return rows;
   if(!str(result.nextCursor,4096)||seen.has(result.nextCursor))throw new Error('Invalid capability cursor');
   cursor=result.nextCursor;seen.add(cursor);
  }throw new Error('Capability pagination limit');
 }
 async #read(cwd:string,threadId:string|undefined,force:boolean,revision:number):Promise<Cached>{
  const thread=threadId?{threadId}:{};
  const results=await Promise.allSettled([
   this.#request('skills/list',{cwds:[cwd],forceReload:force}),
   this.#page('app/list',{...thread,forceRefetch:force}),
   this.#request('app/installed',{...thread,forceRefresh:force}),
   threadId ? this.#page('mcpServerStatus/list',{...thread,detail:'full'}) : Promise.resolve({data:[]}),
  ]);
  const warnings:string[]=threadId?[]:['Start a session to discover its MCP tools and screenshot availability.'];const entries:Native[]=[];const identities=new Set<string>();
  const warn=(s:string)=>{if(!warnings.includes(s))warnings.push(s);};
  const value=(i:number,label:string)=>{const r=results[i];if(r.status==='fulfilled')return r.value;warn(`${label} could not be refreshed.`);return null;};
  const add=(kind:Capability['kind'],identity:string,name:string,description:unknown,available:boolean,reason:string,input:Record<string,unknown>[])=>{
   if(entries.length>=2000){warn('Capability inventory was truncated.');return;}
   const key=kind+':'+identity;if(identities.has(key))return;identities.add(key);
   entries.push({public:{id:id(key),kind,alias:`${kind==='mcp-tool'?'mcp':kind}:${slug(this.#redact(name))}`,displayName:this.#redact(name).slice(0,256),description:typeof description==='string'?this.#redact(description).slice(0,1500):'',available,unavailableReason:available?null:reason},input});
  };
  const skills=obj(value(0,'Skills'));
  if(skills){if(!Array.isArray(skills.data))warn('Skills returned an unsupported response.');else for(const raw of skills.data.slice(0,32)){
   const group=obj(raw);if(!group||typeof group.cwd!=='string'||!Array.isArray(group.skills))continue;
   let scoped=false;try{scoped=await realpath(group.cwd)===cwd;}catch{}if(!scoped)continue;
   if(group.errors?.length)warn('Some skills could not be loaded.');
   for(const rawSkill of group.skills.slice(0,2000)){const s=obj(rawSkill);
    if(!s||!identifier(s.name)||!str(s.path,8192)||!isAbsolute(s.path)||typeof s.enabled!=='boolean'){warn('Some skill records were omitted.');continue;}
    add('skill',s.path,s.name,s.shortDescription??s.description,s.enabled,'Skill is disabled.',[{type:'skill',name:s.name,path:s.path}]);
   }
  }}
  const apps=value(1,'Apps');const installed=obj(value(2,'Installed apps'));
  const runtime=new Map<string,any>();if(installed&&Array.isArray(installed.apps))for(const app of installed.apps.slice(0,2000))if(obj(app)&&identifier(app.id))runtime.set(app.id,app);
  if(Array.isArray(apps))for(const raw of apps){const app=obj(raw);if(!app||!identifier(app.id)||!str(app.name,256)){warn('Some app records were omitted.');continue;}
   const state=runtime.get(app.id);const available=app.isAccessible===true&&app.isEnabled===true&&state?.enabled===true&&state?.callable===true;
   add('app',app.id,app.name,app.description,available,'App is not connected, enabled, or callable.',[{type:'mention',name:app.name,path:`app://${app.id}`}]);
  }
  const servers=value(3,'MCP tools');if(Array.isArray(servers))for(const raw of servers){const server=obj(raw);if(!server||!identifier(server.name)||!obj(server.tools)){warn('Some MCP records were omitted.');continue;}
   for(const [name,rawTool]of Object.entries(server.tools).slice(0,2000)){const tool=obj(rawTool);if(!identifier(name)||!tool){warn('Some MCP tools were omitted.');continue;}
    const available=server.runtimeStatus==='connected';
    add('mcp-tool',server.name+'\0'+name,server.name+'.'+name,tool.description,available,'MCP server is not connected.',[{type:'text',text:`Use the MCP tool ${JSON.stringify(name)} from server ${JSON.stringify(server.name)} for this request.`,text_elements:[]}]);
   }
  }
  const aliases=new Map<string,number>();for(const e of entries)aliases.set(e.public.alias,(aliases.get(e.public.alias)??0)+1);
  for(const e of entries)if(aliases.get(e.public.alias)!>1)e.public.alias+='-'+e.public.id.slice(0,8);
  return {revision,expires:Date.now()+30000,entries,warnings};
 }
 async #load(cwd:string,threadId?:string,force=false):Promise<Cached>{
  cwd=await realpath(cwd);const key=JSON.stringify([cwd,threadId??null]);
  const cached=this.#cache.get(key);if(!force&&cached&&cached.expires>Date.now())return cached;
  const pending=this.#pending.get(key);if(pending)return pending;
  const revision=++this.#revision;
  const operation=this.#read(cwd,threadId,force,revision);this.#pending.set(key,operation);
  try{const result=await operation;if(this.#pending.get(key)!==operation)throw new Error('Capabilities changed; refresh and retry.');
   this.#cache.set(key,result);if(this.#cache.size>64)this.#cache.delete(this.#cache.keys().next().value!);return result;
  }finally{if(this.#pending.get(key)===operation)this.#pending.delete(key);}
 }
 async list(cwd:string,threadId?:string,force=false):Promise<CapabilitySnapshot>{const c=await this.#load(cwd,threadId,force);return {revision:c.revision,capabilities:c.entries.map(e=>({...e.public})),warnings:[...c.warnings]};}
 async expand(selection:string,cwd:string,threadId?:string,force=false):Promise<Record<string,unknown>[]|null>{
  const c=await this.#load(cwd,threadId,force);const matches=c.entries.filter(e=>e.public.id===selection||e.public.alias===selection);
  return matches.length===1&&matches[0].public.available?matches[0].input.map(i=>({...i})):null;
 }
}
