/** ADR-0170 §2 principle 4 — tool output is disclosed under the semantic model before the model sees it.
 *
 * For a read, the entity's declared fields decide each key (core/semantic-model/entities.ts):
 *  - never:   removed. An identifier the model must hand back (an `id` field, or a list of record ids) is
 *             replaced by an opaque per-turn handle (`ref-1`) that the runner resolves on the way back in;
 *  - bands:   every figure becomes a placeholder (`{{F1}}`) plus the band it falls in; the exact figure stays
 *             in the turn's ledger and is restored only for a caller who may see it (./restore.ts);
 *  - minimum: kept for the caller's own records and an administrator's configuration. About another person (an
 *             entity whose audience is another person) and for every `name` field, the value becomes a text
 *             placeholder (`{{T1}}`) kept in the ledger and restored locally like a figure;
 *  - full:    kept.
 * A label marked `screen` whose value names a health, religious or similar matter (SENSITIVE_LABEL) becomes a text
 * placeholder whatever its class. Undeclared keys are removed (fail closed), at any depth, unless they are spec
 * envelope keys or containers, whose children are judged in turn; every removal is listed for the trace. Context
 * tools have no entity: their product vocabulary passes. In every case a string that is an internal record id
 * becomes a handle, and every string that reaches the model is screened for identifiers (./reply-checks.ts
 * screenIdentifiers), counted for the trace and never recorded. Pure apart from the ledger it writes. */
import {terasEntity} from '../semantic-model/generate';
import {OTHER_PERSON_AUDIENCES,type DisclosureClass,type EntityId,type SemanticField} from '../semantic-model/types';
import {screenIdentifiers} from './reply-checks';
import {HARNESS_SPEC} from './spec';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Leave, claim and pay item names that indicate health, pregnancy, religion, union membership or a court order,
 * in English and Malay. A denylist: a name it does not recognise passes, so tenant-specific names need review. */
export const SENSITIVE_LABEL=/\b(?:medical|sick|ill(?:ness)?|hospital(?:i[sz]ation)?|outpatient|inpatient|clinic|dental|optical|health|surgery|quarantine|covid|cancer|chemo\w*|mental|counsell?ing|rehab\w*|disab\w*|maternity|paternity|pregnan\w*|prenatal|antenatal|miscarriage|fertility|ivf|hajj?|haji|umrah|pilgrim\w*|zakat|fitrah|religio\w*|baptism|union|court|garnish\w*|sakit|perubatan|rawatan|bersalin|kesihatan|kesatuan|mahkamah)\b/i;

export type LedgerFigure=Readonly<{value:number;tool:string;path:string;callerKey:string}>;
export type LedgerHandle=Readonly<{value:string;tool:string;path:string;callerKey:string}>;
export type LedgerText=Readonly<{value:string;tool:string;path:string;callerKey:string}>;
/** The turn's local record of what was withheld from the model. Never serialised to the provider. */
export class DisclosureLedger{
 readonly figures=new Map<string,LedgerFigure>();
 readonly handles=new Map<string,LedgerHandle>();
 readonly texts=new Map<string,LedgerText>();
 private readonly byValue=new Map<string,string>();
 private readonly byText=new Map<string,string>();
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
 /** A withheld name, date or label. The same value from the same tool gets the same placeholder in a turn. */
 text(value:string,tool:string,path:string):string{
  const known=this.byText.get(tool+'\n'+value);if(known)return known;
  const key=HARNESS_SPEC.disclosure.textPlaceholder.replace('#',String(this.texts.size+1));
  this.texts.set(key,Object.freeze({value,tool,path,callerKey:this.callerKey}));this.byText.set(tool+'\n'+value,key);return key;
 }
 resolveHandle(key:string):string|null{return this.handles.get(key)?.value??null;}
}

export type DisclosureApplied=Readonly<{tool:string;entity:EntityId|null;removed:readonly string[];banded:readonly string[];handles:number;undeclared:readonly string[];
 /** Paths whose value left as a text placeholder (another person's minimum field, a name, a sensitive label). */
 withheld:readonly string[];
 /** Identifiers removed from strings by the screen; counts and kinds only. */
 identifiers:number;identifierKinds:readonly string[]}>;

const EDGES:readonly number[]=HARNESS_SPEC.disclosure.bandEdges;
/** "between 10 and 20", "below 0", "at least 100000". Lower edge inclusive. */
export function bandOf(value:number):string{
 if(value<EDGES[0])return 'below '+EDGES[0];
 for(let index=EDGES.length-1;index>=0;index--)if(value>=EDGES[index])return index===EDGES.length-1?'at least '+EDGES[index]:'between '+EDGES[index]+' and '+EDGES[index+1];
 return 'below '+EDGES[0];
}
const ENVELOPE:ReadonlySet<string>=new Set<string>(HARNESS_SPEC.disclosure.envelopeKeys);
const fieldMap=(fields:readonly SemanticField[])=>new Map(fields.map(field=>[field.name,field]));
const REMOVED=Symbol('removed');

type Walk={tool:string;ledger:DisclosureLedger;removed:string[];banded:string[];undeclared:string[];withheld:string[];handles:number;identifiers:number;identifierKinds:string[];
 /** The entity is about another person: its minimum fields are withheld. */
 others:boolean};
const screen=(text:string,walk:Walk)=>{const result=screenIdentifiers(text);if(result.count){walk.identifiers+=result.count;
 for(const kind of result.kinds)if(!walk.identifierKinds.includes(kind))walk.identifierKinds.push(kind);}return result.text;};
/** Strings that are record ids become handles wherever they appear; every other string is screened for identifiers. */
function sweep(value:unknown,path:string,walk:Walk):unknown{
 if(typeof value==='string'){if(UUID.test(value)){walk.handles++;return walk.ledger.handle(value,walk.tool,path);}return screen(value,walk);}
 if(Array.isArray(value))return value.map((item,index)=>sweep(item,path+'['+index+']',walk));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,child])=>[key,sweep(child,path+'.'+key,walk)]));
 return value;
}
/** A scalar the model may not read becomes a text placeholder; lists and objects are withheld leaf by leaf. */
function withhold(value:unknown,path:string,walk:Walk):unknown{
 if(value===null||value===undefined||typeof value==='boolean')return value;
 if(Array.isArray(value))return value.map((item,index)=>withhold(item,path+'['+index+']',walk));
 if(typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,child])=>[key,withhold(child,path+'.'+key,walk)]));
 walk.withheld.push(path);return walk.ledger.text(String(value),walk.tool,path);
}
const sensitiveLabel=(value:unknown)=>typeof value==='string'&&SENSITIVE_LABEL.test(value);
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
 if(field.screen==='sensitive_label'&&sensitiveLabel(value))return{keep:true,value:withhold(value,path,walk)};
 if(disclosure==='minimum'&&(walk.others||field.type==='name'))return{keep:true,value:withhold(value,path,walk)};
 return{keep:true,value:sweep(value,path,walk)};
}
/** Judges an object (or a list of them) against declared fields. A scalar reached through an undeclared container
 * is undeclared and removed. */
function walkObject(value:unknown,fields:ReadonlyMap<string,SemanticField>,path:string,walk:Walk):unknown{
 if(Array.isArray(value))return value.map((item,index)=>walkObject(item,fields,path+'['+index+']',walk)).filter(item=>item!==REMOVED);
 if(value===null||value===undefined)return value;
 if(typeof value!=='object'){walk.undeclared.push(path);return REMOVED;}
 const out:Record<string,unknown>={};
 for(const [key,child] of Object.entries(value)){
  const at=path?path+'.'+key:key,field=fields.get(key);
  if(field){
   // A declared list or object with its own row shape is walked against that shape; the parent's class
   // still governs when it is `never` (a never parent hides its children too).
   if(field.of&&field.disclosure!=='never'){const walked=walkObject(child,fieldMap(field.of),at,walk);if(walked!==REMOVED)out[key]=walked;continue;}
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
 const declared=entity===null?null:terasEntity(entity);
 const walk:Walk={tool,ledger,removed:[],banded:[],undeclared:[],withheld:[],handles:0,identifiers:0,identifierKinds:[],others:declared!==null&&OTHER_PERSON_AUDIENCES.includes(declared.audience)};
 const walked=declared===null?sweep(output,'',walk):walkObject(output,fieldMap(declared.fields),'',walk);
 const value=walked===REMOVED?null:walked;
 return Object.freeze({value,applied:Object.freeze({tool,entity,removed:Object.freeze(walk.removed),banded:Object.freeze(walk.banded),handles:walk.handles,undeclared:Object.freeze(walk.undeclared),
  withheld:Object.freeze(walk.withheld),identifiers:walk.identifiers,identifierKinds:Object.freeze(walk.identifierKinds)})});
}
