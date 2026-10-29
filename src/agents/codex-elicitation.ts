import { randomUUID } from 'node:crypto';
import type { ElicitationField, PublicElicitation } from '../types.ts';
export type ElicitationResponse = { action: 'accept' | 'decline' | 'cancel'; content: Record<string, unknown> | null; _meta: null };
type Field = { key: string; public: ElicitationField; options?: Map<string,string> };
export type Elicitation = { public: PublicElicitation; fields: Field[]; url?: string };
const record = (v: unknown): Record<string, any> | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : null;
const text = (v: unknown, max=8192): v is string => typeof v === 'string' && v.length <= max;
const keys = (v: Record<string,unknown>, allowed: string[]) => Object.keys(v).every(k=>allowed.includes(k));
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Full URL remains in the live handle; only its origin reaches Registry. */
export function safeElicitationUrl(value: unknown): string | null {
  if (!text(value) || /[\r\n\t]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password || (url.protocol !== 'https:'
      && !(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))) return null;
    return url.href;
  } catch { return null; }
}

export function normalizeElicitation(params: unknown, redact: (s:string)=>string): Elicitation | null {
  const p=record(params);
  if (!p || !text(p.serverName,256) || !p.serverName || !text(p.message)) return null;
  const base={server:redact(p.serverName),message:redact(p.message)};
  if (p.mode==='url') {
    const url=safeElicitationUrl(p.url);
    if (!url || !text(p.elicitationId,1024) || !p.elicitationId) return null;
    return {public:{...base,mode:'url',destination:redact(new URL(url).origin)},fields:[],url};
  }
  if (p.mode!=='form') return null;
  const schema=record(p.requestedSchema);
  if (!schema || schema.type!=='object' || !keys(schema,['type','properties','required','$schema'])) return null;
  const properties=record(schema.properties);
  if (!properties || Object.keys(properties).length>32) return null;
  const required=schema.required??[];
  if (!Array.isArray(required) || required.some(k=>typeof k!=='string'||!Object.hasOwn(properties,k)) || new Set(required).size!==required.length) return null;
  const fields:Field[]=[];
  let size=p.message.length+p.serverName.length;
  for (const [key,raw] of Object.entries(properties)) {
    const f=record(raw);
    if (!text(key,256) || !f || !['string','number','integer','boolean','array'].includes(f.type)) return null;
    const common=['type','title','description','default'];
    const allowed=f.type==='string'?[...common,'minLength','maxLength','format','enum','enumNames','oneOf']:
      f.type==='number'||f.type==='integer'?[...common,'minimum','maximum']:
      f.type==='array'?[...common,'items','minItems','maxItems']:common;
    if (!keys(f,allowed) || (f.title!==undefined&&!text(f.title,1024)) || (f.description!==undefined&&!text(f.description,4096))) return null;
    const pub:ElicitationField={id:randomUUID(),label:redact(f.title??key),description:redact(f.description??''),type:f.type,required:required.includes(key)};
    for(const [name,max] of [['minLength',8192],['maxLength',8192],['minItems',32],['maxItems',32]] as const) {
      if(f[name]!==undefined) { if(!Number.isSafeInteger(f[name])||f[name]<0||f[name]>max)return null;pub[name]=f[name]; }
    }
    for(const name of ['minimum','maximum'] as const)if(f[name]!==undefined){if(!finite(f[name]))return null;pub[name]=f[name];}
    if((pub.minLength??0)>(pub.maxLength??8192)||(pub.minItems??0)>(pub.maxItems??32)||(pub.minimum??-Infinity)>(pub.maximum??Infinity))return null;
    if(f.format!==undefined){if(!['email','uri','date','date-time'].includes(f.format))return null;pub.format=f.format;}
    let choices: {value:string;label:string}[] | null=null;
    const item=f.type==='array'?record(f.items):f;
    if(f.type==='array' && (!item || !keys(item,['type','enum','anyOf']) || (item.type!==undefined&&item.type!=='string')))return null;
    if(item?.enum!==undefined){
      if(!Array.isArray(item.enum)||item.oneOf!==undefined||item.anyOf!==undefined||!item.enum.length||item.enum.length>32||item.enum.some((v:unknown)=>!text(v,1024)))return null;
      if(item.enumNames!==undefined&&(!Array.isArray(item.enumNames)||item.enumNames.length!==item.enum.length||item.enumNames.some((v:unknown)=>!text(v,1024))))return null;
      choices=item.enum.map((v:string,i:number)=>({value:v,label:item.enumNames?.[i]??v}));
    } else if(item?.oneOf!==undefined||item?.anyOf!==undefined){
      const list=item.oneOf??item.anyOf;
      if(!Array.isArray(list)||!list.length||list.length>32||list.some(o=>!record(o)||!keys(o,['const','title'])||!text(o.const,1024)||!text(o.title,1024)))return null;
      choices=list.map(o=>({value:o.const,label:o.title}));
    }
    if(f.type==='array'&&!choices)return null;
    if(choices && (new Set(choices.map(c=>c.value)).size!==choices.length || f.minLength!==undefined || f.maxLength!==undefined || f.format!==undefined))return null;
    const options=choices?new Map<string,string>():undefined;
    if(choices) pub.options=choices.map(c=>{const id=randomUUID();options!.set(id,c.value);size+=c.value.length+c.label.length;return {id,label:redact(c.label)};});
    size+=key.length+(f.title??'').length+(f.description??'').length;
    if(size>32768)return null;
    fields.push({key,public:pub,options});
  }
  return {public:{...base,mode:'form',fields:fields.map(f=>f.public)},fields};
}

function validFormat(value:string,format?:string):boolean {
  if(format==='email')return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  if(format==='uri'){try{new URL(value);return true;}catch{return false;}}
  if(format==='date')return /^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
  if(format==='date-time')return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)&&Number.isFinite(Date.parse(value));
  return true;
}
export function elicitationResult(e:Elicitation, input:unknown):ElicitationResponse|null {
  const response=record(input);
  if(!response||!['accept','decline','cancel'].includes(response.action))return null;
  if(response.action!=='accept'||e.public.mode==='url') {
    return keys(response,['action'])?{action:response.action,content:null,_meta:null}:null;
  }
  if(!keys(response,['action','values']))return null;
  const values=record(response.values);
  if(!values||Object.keys(values).some(id=>!e.fields.some(f=>f.public.id===id)))return null;
  const content:Record<string,unknown>={};let size=0;
  for(const field of e.fields){
    const f=field.public;
    if(!Object.hasOwn(values,f.id)){if(f.required)return null;continue;}
    let value=values[f.id];
    if(field.options){
      if(f.type==='array'){
        if(!Array.isArray(value)||value.length<(f.minItems??0)||value.length>(f.maxItems??32)||new Set(value).size!==value.length||value.some(v=>typeof v!=='string'||!field.options!.has(v)))return null;
        value=value.map(v=>field.options!.get(v));
      }else{if(typeof value!=='string'||!field.options.has(value))return null;value=field.options.get(value);}
    }else if(f.type==='boolean'){if(typeof value!=='boolean')return null;}
    else if(f.type==='number'||f.type==='integer'){
      if(!finite(value)||(f.type==='integer'&&!Number.isSafeInteger(value))||value<(f.minimum??-Infinity)||value>(f.maximum??Infinity))return null;
    }else if(!text(value)||[...value].length<(f.minLength??0)||[...value].length>(f.maxLength??8192)||!validFormat(value,f.format))return null;
    size+=JSON.stringify(value).length;if(size>32768)return null;
    Object.defineProperty(content,field.key,{value,enumerable:true});
  }
  return {action:'accept',content,_meta:null};
}
