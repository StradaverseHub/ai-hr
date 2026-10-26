/** Deterministic template vocabulary. Rich text is structured data; no HTML, scripts or remote assets. */
import {z} from 'zod';
import {isCalendarDate} from './calendar-date';
import {CURRENCIES,currencyMinorScale} from './currencies';
import {formatMoney} from './money';
export const LETTER_LANGUAGES=['en','ms','zh','th','ta','vi'] as const;
export const LETTER_SOURCES={
 'employee.name':{kind:'text',sensitive:false},'employee.code':{kind:'text',sensitive:false},
 'employment.hiredOn':{kind:'date',sensitive:false},'employment.jobTitle':{kind:'text',sensitive:false},
 'employment.department':{kind:'text',sensitive:false},'company.name':{kind:'text',sensitive:false},
 'company.registration':{kind:'text',sensitive:false},'company.address':{kind:'text',sensitive:false},
 'compensation.basicSalary':{kind:'currency',sensitive:true},'custom.text':{kind:'text',sensitive:false},
 'custom.date':{kind:'date',sensitive:false},'custom.currency':{kind:'currency',sensitive:true},
} as const;
export type LetterFieldKind='text'|'date'|'currency';
export type LetterField={key:string;label:string;description:string;kind:LetterFieldKind;source:keyof typeof LETTER_SOURCES;required:boolean;editable:boolean;sensitive:boolean};
export type LetterValue={kind:'text';value:string}|{kind:'date';value:string}|{kind:'currency';value:string;currency:string};
export type LetterInline={type:'text';text:string;marks?:('bold'|'italic'|'underline')[]}|{type:'field';key:string;marks?:('bold'|'italic'|'underline')[]};
export type LetterCondition={type:'present';field:string}|{type:'equals'|'after'|'greater';field:string;value:LetterValue}|{type:'all'|'any';conditions:LetterCondition[]}|{type:'not';condition:LetterCondition};
export type LetterBlock={type:'paragraph';content:LetterInline[]}|{type:'heading';level:1|2|3;content:LetterInline[]}|{type:'list';ordered:boolean;items:LetterInline[][]}|{type:'table';rows:LetterInline[][][]}|{type:'if';condition:LetterCondition;then:LetterBlock[];otherwise:LetterBlock[]};
export type LetterDocument={version:1;language:typeof LETTER_LANGUAGES[number];blocks:LetterBlock[]};
export type ResolvedLetterBlock=Exclude<LetterBlock,{type:'if'}>;
export class LetterModelError extends Error{
 constructor(public code:'invalid'|'unknownField'|'missingField'|'confidential'|'limit',public path:string){super(`${code}: ${path}`);this.name='LetterModelError';}
}
const fieldKey=z.string().regex(/^[a-z][a-zA-Z0-9_.]{0,79}$/);
const decimal=z.string().regex(/^-?\d{1,12}(\.\d{1,3})?$/);
const valueSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('text'),value:z.string().max(10000)}).strict(),
 z.object({kind:z.literal('date'),value:z.string().refine(isCalendarDate)}).strict(),
 z.object({kind:z.literal('currency'),value:decimal,currency:z.string().refine(code=>CURRENCIES.some(currency=>currency.code===code))}).strict().refine(value=>(value.value.split('.')[1]?.length??0)<=currencyMinorScale(value.currency)),
]);
const marks=z.array(z.enum(['bold','italic','underline'])).max(3).optional();
const inlineSchema=z.discriminatedUnion('type',[
 z.object({type:z.literal('text'),text:z.string().max(20000),marks}).strict(),
 z.object({type:z.literal('field'),key:fieldKey,marks}).strict(),
]);
const conditionSchema:z.ZodType<LetterCondition>=z.lazy(()=>z.union([
 z.object({type:z.literal('present'),field:fieldKey}).strict(),
 z.object({type:z.enum(['equals','after','greater']),field:fieldKey,value:valueSchema}).strict(),
 z.object({type:z.enum(['all','any']),conditions:z.array(conditionSchema).min(1).max(20)}).strict(),
 z.object({type:z.literal('not'),condition:conditionSchema}).strict(),
]));
const blockSchema:z.ZodType<LetterBlock>=z.lazy(()=>z.union([
 z.object({type:z.literal('paragraph'),content:z.array(inlineSchema).max(200)}).strict(),
 z.object({type:z.literal('heading'),level:z.union([z.literal(1),z.literal(2),z.literal(3)]),content:z.array(inlineSchema).max(100)}).strict(),
 z.object({type:z.literal('list'),ordered:z.boolean(),items:z.array(z.array(inlineSchema).max(100)).max(100)}).strict(),
 z.object({type:z.literal('table'),rows:z.array(z.array(z.array(inlineSchema).max(100)).min(1).max(12)).max(100)}).strict(),
 z.object({type:z.literal('if'),condition:conditionSchema,then:z.array(blockSchema).max(100),otherwise:z.array(blockSchema).max(100)}).strict(),
]));
/** Bound and reject cycles before a recursive validator can overflow its call stack. */
export function assertLetterStructureBound(value:unknown){
 let nodes=0,characters=0;const stack:{value:unknown;depth:number;exit?:boolean}[]=[{value,depth:0}],seen=new Set<object>();
 while(stack.length){const next=stack.pop()!;if(next.exit){seen.delete(next.value as object);continue;}if(++nodes>10000||next.depth>32)throw new LetterModelError('limit','document');
  if(typeof next.value==='string'){characters+=next.value.length;if(characters>256000)throw new LetterModelError('limit','document');}
  if(next.value&&typeof next.value==='object'){
   if(seen.has(next.value))throw new LetterModelError('invalid','cyclic document');seen.add(next.value);stack.push({value:next.value,depth:next.depth,exit:true});
   for(const child of Object.values(next.value))stack.push({value:child,depth:next.depth+1});
  }
 }
}
const fieldSchema=z.object({key:fieldKey,label:z.string().trim().min(1).max(160),description:z.string().max(1000),kind:z.enum(['text','date','currency']),source:z.enum(Object.keys(LETTER_SOURCES) as [keyof typeof LETTER_SOURCES,...(keyof typeof LETTER_SOURCES)[]]),required:z.boolean(),editable:z.boolean(),sensitive:z.boolean()}).strict();
export function validateLetterFields(input:unknown):LetterField[]{
 const result=z.array(fieldSchema).max(200).safeParse(input);if(!result.success)throw new LetterModelError('invalid','fields');
 const keys=new Set<string>();for(const field of result.data){
  if(keys.has(field.key))throw new LetterModelError('invalid',field.key);keys.add(field.key);
  const source=LETTER_SOURCES[field.source];if(source.kind!==field.kind||source.sensitive&&!field.sensitive||field.editable&&!field.source.startsWith('custom.'))throw new LetterModelError('invalid',field.key);
 }
 return result.data;
}
export function validateLetterDocument(input:unknown,fields:readonly LetterField[]):LetterDocument{
 assertLetterStructureBound(input);const result=z.object({version:z.literal(1),language:z.enum(LETTER_LANGUAGES),blocks:z.array(blockSchema).min(1).max(500)}).strict().safeParse(input);
 if(!result.success)throw new LetterModelError('invalid','document');
 const definitions=new Map(fields.map(field=>[field.key,field]));
 function condition(test:LetterCondition){
  if('conditions' in test){test.conditions.forEach(condition);return;}if(test.type==='not'){condition(test.condition);return;}
  const field=definitions.get(test.field);if(!field)throw new LetterModelError('unknownField',test.field);
  if(test.type==='present')return;
  if(field.kind!==test.value.kind||test.type==='after'&&field.kind!=='date'||test.type==='greater'&&field.kind!=='currency')throw new LetterModelError('invalid',test.field);
 }
 function inline(content:LetterInline[]){for(const item of content)if(item.type==='field'&&!definitions.has(item.key))throw new LetterModelError('unknownField',item.key);}
 function blocks(items:LetterBlock[]){for(const item of items){if(item.type==='if'){condition(item.condition);blocks(item.then);blocks(item.otherwise);}else if(item.type==='table')item.rows.forEach(row=>row.forEach(inline));else if(item.type==='list')item.items.forEach(inline);else inline(item.content);}}
 blocks(result.data.blocks);return result.data;
}
export function usedLetterFields(document:LetterDocument):string[]{
 const used=new Set<string>();
 const visit=(value:unknown)=>{if(!value||typeof value!=='object')return;const node=value as Record<string,unknown>;if(node.type==='field'&&typeof node.key==='string')used.add(node.key);if(['present','equals','after','greater'].includes(String(node.type))&&typeof node.field==='string')used.add(node.field);Object.values(node).forEach(child=>Array.isArray(child)?child.forEach(visit):visit(child));};
 assertLetterStructureBound(document);visit(document);return [...used].sort();
}
const locale={en:'en-MY',ms:'ms-MY',zh:'zh-CN',th:'th-TH',ta:'ta-MY',vi:'vi-VN'};
/** Inputs must already come from scoped canonical readers; this function never fetches employee data. */
export function renderLetterDocument(input:unknown,fieldInput:unknown,values:Readonly<Record<string,LetterValue|null>>,options:{allowSensitive:boolean}):{document:Omit<LetterDocument,'blocks'>&{blocks:ResolvedLetterBlock[]};usedFields:string[]}{
 const fields=validateLetterFields(fieldInput),document=validateLetterDocument(input,fields),definitions=new Map(fields.map(field=>[field.key,field])),used=new Set<string>();
 function read(key:string,required=false):LetterValue|null{
  const field=definitions.get(key);if(!field)throw new LetterModelError('unknownField',key);
  if(field.sensitive&&!options.allowSensitive)throw new LetterModelError('confidential',key);
  used.add(key);const value=values[key];
  if(value==null||value.kind==='text'&&!value.value.trim()){if(required||field.required)throw new LetterModelError('missingField',key);return null;}
  const parsed=valueSchema.safeParse(value);if(!parsed.success||value.kind!==field.kind)throw new LetterModelError('invalid',key);return parsed.data;
 }
 function cents(value:string){const negative=value.startsWith('-'),[whole,fraction='']=value.replace(/^-/, '').split('.');const amount=BigInt(whole+fraction.padEnd(3,'0'));return negative?-amount:amount;}
 function condition(test:LetterCondition):boolean{
  // Evaluate every operand: a true/false sibling cannot hide a forbidden or missing source.
  if('conditions' in test){const answers=test.conditions.map(condition);return test.type==='all'?answers.every(Boolean):answers.some(Boolean);}if(test.type==='not')return !condition(test.condition);
  const value=read(test.field,test.type!=='present');if(test.type==='present')return value!==null;if(!value)return false;
  if(value.kind!==test.value.kind)throw new LetterModelError('invalid',test.field);
  if(value.kind==='currency'&&test.value.kind==='currency'){
   if(value.currency!==test.value.currency)throw new LetterModelError('invalid',test.field);
   return test.type==='equals'?cents(value.value)===cents(test.value.value):cents(value.value)>cents(test.value.value);
  }
  return test.type==='equals'?value.value===test.value.value:value.value>test.value.value;
 }
 function inline(items:LetterInline[]):LetterInline[]{return items.map(item=>{
  if(item.type==='text')return {...item};const value=read(item.key);let text='';
  if(value?.kind==='text')text=value.value;
  else if(value?.kind==='date')text=new Intl.DateTimeFormat(locale[document.language],{year:'numeric',month:'long',day:'numeric',timeZone:'UTC',calendar:'gregory'}).format(new Date(value.value+'T00:00:00Z'));
  else if(value?.kind==='currency'){const scale=currencyMinorScale(value.currency);text=scale===2?formatMoney(value.value,value.currency,locale[document.language]):`${value.currency} ${Number(value.value).toLocaleString(locale[document.language],{minimumFractionDigits:scale,maximumFractionDigits:scale})}`;}
  return {type:'text',text,...(item.marks?{marks:[...item.marks]}:{})};
 });}
 function blocks(items:LetterBlock[]):ResolvedLetterBlock[]{return items.flatMap(item=>{
  if(item.type==='if')return blocks(condition(item.condition)?item.then:item.otherwise);
  if(item.type==='list')return [{...item,items:item.items.map(inline)}];if(item.type==='table')return [{...item,rows:item.rows.map(row=>row.map(inline))}];return [{...item,content:inline(item.content)}];
 });}
 return {document:{version:1,language:document.language,blocks:blocks(document.blocks)},usedFields:[...used].sort()};
}
