import test from 'node:test';
import assert from 'node:assert/strict';
import { codexCommands, searchCommands, capabilityFilter } from '../web/codex-commands.js';
test('Codex commands include builtins and plugin skills with availability', () => {
 const entries = codexCommands({capabilities:[{alias:'skill:plugin.help',description:'Diagnose widgets',available:false,unavailableReason:'Disabled'}]});
 assert.deepEqual(entries.slice(0,4).map(x=>x.name), ['compact','skills','apps','mcp']);
 assert.equal(searchCommands('/widgets',8,entries).matches[0], 'skill:plugin.help');
 assert.equal(entries[4].unavailableReason,'Disabled');
 assert.equal(searchCommands('/skills args',12,entries),null);
});
test('local filters require a complete command and preserve argument text',()=>{
 assert.deepEqual(capabilityFilter('/skills writing'),{kind:'skill',query:'writing'});
 assert.deepEqual(capabilityFilter('/mcp'),{kind:'mcp-tool',query:''});
 assert.equal(capabilityFilter('/skill:foo'),null);
});

import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
test('failed live refresh drops previously selectable capabilities', async () => {
 const panel = {textContent:'',append(){}};
 const context = vm.createContext({
   $:()=>panel, fetch:async()=>({ok:false,json:async()=>({error:'Offline'})}),
   document:{createElement:()=>({})}, paintMirror(){},
 });
 vm.runInContext(`let capabilitySession='s1', openId='s1', capabilityRequest=0, capabilitySnapshot={capabilities:[{alias:'skill:old'}]}; ${source.slice(source.indexOf('async function loadCapabilities('),source.indexOf('function renderCapabilities('))}`,context);
 await vm.runInContext('loadCapabilities(true, false)',context);
 assert.equal(vm.runInContext('capabilitySnapshot',context),null);
});
test('failed preview refresh drops previously selectable capabilities', async () => {
 const context = vm.createContext({
   $:()=>({value:'value',textContent:''}), fetch:async()=>({ok:false,json:async()=>({error:'Offline'})}), paintNewMirror(){},
 });
 vm.runInContext(`let previewRequest=0,previewSnapshot={capabilities:[{alias:'skill:old'}]}; ${source.slice(source.indexOf('async function loadCapabilityPreview('),source.indexOf("$('#new-capabilities-btn').onclick"))}`,context);
 await vm.runInContext('loadCapabilityPreview()',context);
 assert.equal(vm.runInContext('previewSnapshot',context),null);
});
test('keyboard cannot select disabled or subsequently removed commands', () => {
 function element() {
  return {children:[] as any[],hidden:true,style:{},classList:{toggle(){}},attributes:{} as Record<string,string>,
   append(...items:any[]){this.children.push(...items);},replaceChildren(...items:any[]){this.children=items;},
   setAttribute(name:string,value:string){this.attributes[name]=value;},getAttribute(name:string){return this.attributes[name];},removeAttribute(name:string){delete this.attributes[name];},
   addEventListener(){},scrollIntoView(){}};
 }
 const handlers:Record<string,Function[]>={};
 const field={...element(),value:'/blocked',selectionStart:8,addEventListener(name:string,fn:Function){(handlers[name]??=[]).push(fn);},setSelectionRange(){},focus(){}};
 const menu=element();
 let entries=[{name:'blocked',available:false,description:'Disabled plugin',unavailableReason:'Disabled'}];
 const context=vm.createContext({state:{commands:[]},document:{activeElement:field,createElement:element},commandToken:()=>null,commandMenu:()=>null,searchCommands,field,menu,box:element(),mirror:element(),commands:()=>entries});
 vm.runInContext(source.slice(source.indexOf('function wireCommandMenu('),source.indexOf('/**\n * Session autocomplete')),context);
 vm.runInContext("wireCommandMenu({field,menu,box,mirror,ids:'test',commands})",context);
 handlers.input.forEach(fn=>fn());
 assert.equal(menu.children[0].attributes['aria-disabled'],'true');
 let prevented=false;
 handlers.keydown.forEach(fn=>fn({key:'Enter',preventDefault(){prevented=true;}}));
 assert.equal(prevented,true); assert.equal(field.value,'/blocked');
 entries=[{...entries[0],available:true}]; handlers.input.forEach(fn=>fn());
 entries=[];
 handlers.keydown.forEach(fn=>fn({key:'Tab',preventDefault(){}}));
 assert.equal(field.value,'/blocked'); assert.equal(menu.hidden,true);
});
