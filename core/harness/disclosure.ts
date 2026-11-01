/** ADR-0170 §2 principle 4 — tool output is disclosed under the semantic model before the model sees it.
 *
 * For a read, the entity's declared fields decide each key (core/semantic-model/entities.ts):
 *  - never:   removed. An identifier the model must hand back (an `id` field, or a list of record ids) is
 *             replaced by an opaque per-turn handle (`ref-1`) that the runner resolves on the way back in;
 *  - bands:   every figure becomes a placeholder (`{{F1}}`) plus the band it falls in; the exact figure stays
 *             in the turn's ledger and is restored only for a caller who may see it (./restore.ts);
 *  - minimum, full: kept.
 * Undeclared keys are removed (fail closed) unless they are spec envelope keys or containers, whose children
 * are judged in turn; every removal is listed for the trace. Context tools have no entity: their product
 * vocabulary passes. In every case a string that is an internal record id becomes a handle. Pure apart from
 * the ledger it writes. */
import {SEMANTIC_ENTITIES} from '../semantic-model/entities';
import type {DisclosureClass,EntityId,SemanticField} from '../semantic-model/types';
import {HARNESS_SPEC} from './spec';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type LedgerFigure=Readonly<{value:number;tool:string;path:string;callerKey:string}>;
export type LedgerHandle=Readonly<{value:string;tool:string;path:string;callerKey:string}>;
/** The turn's local record of what was withheld from the model. Never serialised to the provider. */
export class DisclosureLedger{
 readonly figures=new Map<string,LedgerFigure>();
 readonly handles=new Map<string,LedgerHandle>();
 private readonly byValue=new Map<string,string>();
 constructor(readonly callerKey:string){}
 figure(value:number,tool:string,path:string):string{
  const key=HARNESS_SPEC.disclosure.placeholder.replace('#',String(this.figures.size+1));
  this.figures.set(key,Object.freeze({value,tool,path,callerKey:this.callerKey}));return key;
 }
 handle(value:string,tool:string,path:string):string{
  const known=this.byValue.get(value);if(known)return known;
  const key=HARNESS_SPEC.disclosure.handle.replace('#',String(this.handles.size+1));
  this.handles.set(key,Object.freeze({value,tool,path,callerKey:this.callerKey}));this.byValue.set(value,key);return key;
 }
 resolveHandle(key:string):string|null{return this.handles.get(key)?.value??null;}
}

export type DisclosureApplied=Readonly<{tool:string;entity:EntityId|null;removed:readonly string[];banded:readonly string[];handles:number;undeclared:readonly string[]}>;

const EDGES:readonly number[]=HARNESS_SPEC.disclosure.bandEdges;
/** "between 10 and 20", "below 0", "at least 100000". Lower edge inclusive. */
export function bandOf(value:number):string{
 if(value<EDGES[0])return 'below '+EDGES[0];
 for(let index=EDGES.length-1;index>=0;index--)if(value>=EDGES[index])return index===EDGES.length-1?'at least '+EDGES[index]:'between '+EDGES[index]+' and '+EDGES[index+1];
 return 'below '+EDGES[0];
}
const ENVELOPE:ReadonlySet<string>=new Set<string>(HARNESS_SPEC.disclosure.envelopeKeys);
const fieldMap=(fields:readonly SemanticField[])=>new Map(fields.map(field=>[field.name,field]));
const entityFields=(entity:EntityId)=>{const found=SEMANTIC_ENTITIES.find(row=>row.id===entity);if(!found)throw Error('Unknown semantic entity.');return fieldMap(found.fields);};

type Walk={tool:string;ledger:DisclosureLedger;removed:string[];banded:string[];undeclared:string[];handles:number};
/** Strings that are record ids become handles wherever they appear. */
function sweep(value:unknown,path:string,walk:Walk):unknown{
 if(typeof value==='string'&&UUID.test(value)){walk.handles++;return walk.ledger.handle(value,walk.tool,path);}
 if(Array.isArray(value))return value.map((item,index)=>sweep(item,path+'['+index+']',walk));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,child])=>[key,sweep(child,path+'.'+key,walk)]));
 return value;
}
/** Applies one class to a whole value (a declared leaf, or a declared list/object without its own row shape). */
function apply(disclosure:DisclosureClass,field:SemanticField,value:unknown,path:string,walk:Walk):{keep:boolean;value?:unknown}{
 if(disclosure==='never'){
  const ids=typeof value==='string'?UUID.test(value):Array.isArray(value)&&value.length>0&&value.every(item=>typeof item==='string'&&UUID.test(item));
  if(ids&&(field.type==='id'||field.type==='list')){walk.handles+=Array.isArray(value)?value.length:1;
   return{keep:true,value:Array.isArray(value)?value.map((item,index)=>walk.ledger.handle(item as string,walk.tool,path+'['+index+']')):walk.ledger.handle(value as string,walk.tool,path)};}
  walk.removed.push(path);return{keep:false};
 }
 if(disclosure==='bands'){
  const band=(item:unknown,at:string):unknown=>{
   if(typeof item==='number'&&Number.isFinite(item)){walk.banded.push(at);return walk.ledger.figure(item,walk.tool,at)+' ('+bandOf(item)+')';}
   if(typeof item==='string'&&/^-?\d+(?:\.\d+)?$/.test(item.trim())){walk.banded.push(at);const number=Number(item);return walk.ledger.figure(number,walk.tool,at)+' ('+bandOf(number)+')';}
   if(Array.isArray(item))return item.map((child,index)=>band(child,at+'['+index+']'));
   if(item&&typeof item==='object')return Object.fromEntries(Object.entries(item).map(([key,child])=>[key,band(child,at+'.'+key)]));
   return item;
  };
  return{keep:true,value:band(value,path)};
 }
 return{keep:true,value:sweep(value,path,walk)};
}
function walkObject(value:unknown,fields:ReadonlyMap<string,SemanticField>,path:string,walk:Walk):unknown{
 if(Array.isArray(value))return value.map((item,index)=>walkObject(item,fields,path+'['+index+']',walk));
 if(!value||typeof value!=='object')return sweep(value,path,walk);
 const out:Record<string,unknown>={};
 for(const [key,child] of Object.entries(value)){
  const at=path?path+'.'+key:key,field=fields.get(key);
  if(field){
   // A declared list or object with its own row shape is walked against that shape; the parent's class
   // still governs when it is `never` (a never parent hides its children too).
   if(field.of&&field.disclosure!=='never'){out[key]=walkObject(child,fieldMap(field.of),at,walk);continue;}
   const result=apply(field.disclosure,field,child,at,walk);if(result.keep)out[key]=result.value;continue;
  }
  if(ENVELOPE.has(key)){out[key]=sweep(child,at,walk);continue;}
  // An undeclared container (employments, balances, rows, employee) is judged by its children.
  if(child&&typeof child==='object'){out[key]=walkObject(child,fields,at,walk);continue;}
  walk.undeclared.push(at);
 }
 return out;
}
/** Discloses one tool result. `entity` null means a context tool: identifiers swept, vocabulary kept. */
export function discloseToolOutput(tool:string,entity:EntityId|null,output:unknown,ledger:DisclosureLedger):Readonly<{value:unknown;applied:DisclosureApplied}>{
 const walk:Walk={tool,ledger,removed:[],banded:[],undeclared:[],handles:0};
 const value=entity===null?sweep(output,'',walk):walkObject(output,entityFields(entity),'',walk);
 return Object.freeze({value,applied:Object.freeze({tool,entity,removed:Object.freeze(walk.removed),banded:Object.freeze(walk.banded),handles:walk.handles,undeclared:Object.freeze(walk.undeclared)})});
}
