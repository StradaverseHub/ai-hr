/** ADR-0169 §2.5 and §5.1, ADR-0170 §11.3 change 4 — the provider-data contract of a Noveri conversation turn.
 *
 * Source: one model request the Teras turn harness built for the caller, after its pre-read
 * gate, offer policy, semantic-model disclosure, identifier screen, untrusted-data fence and model-side history.
 * The harness is the per-tool, per-field disclosure contract; this file is the narrow conversion of its request
 * into gateway conversation bytes, so the gateway's one-use privacy binding, admission, allowances and spend
 * settlement apply to every harness call exactly as to every other provider call. The harness and its wiring are
 * roots of the provider-data closure (scripts/ai-provider-data-source-manifest.mjs), so the owner approval of this
 * contract binds the exact disclosure source, not only this conversion.
 *
 * The conversion adds nothing: no HR data, identifier, tenant value or prose of its own. It only reshapes:
 *  - the system message and the harness's corrective notes become the ordered system blocks;
 *  - tool declarations become strict function schemas (every property required, an optional one nullable, a
 *    free-form string map an array of name/value pairs), which the gateway's transport requires;
 *  - a tool name that an earlier step called but this step does not offer gets an inert declaration, so the
 *    request stays well-formed; the harness still refuses any call to it.
 * fromStrictArguments undoes the schema reshaping on the model's tool-call arguments before the harness validates
 * them against its own declarations. */
import {createHash} from 'node:crypto';
import type {AiJsonSchema,AiToolCall,AiToolSpec,AiTurn,ConverseArgs} from './types';
import {privateCount,privateList,privatePolicyRefusal,privateRecord} from './provider-policy-shape';
import type {PrivateTaskCapture,PrivateTaskDescriptor} from './provider-task-contract';

export const TERAS_HARNESS_CONTRACT='teras_harness_turn_v1' as const;
const NAME=/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const INERT_TOOL='unavailable_tool';
const INERT_DESCRIPTION='Not available in this step.';
const LIMITS=Object.freeze({messages:96,systemNotes:15,text:262_144,tools:31,calls:32,output:32_768,timeout:120_000});

type Message=Readonly<{role:'system'|'user';content:string}|{role:'assistant';content:string|null;toolCalls:readonly Readonly<{id:string;name:string;arguments:string}>[]}|{role:'tool';toolCallId:string;content:string}>;
type Declaration=Readonly<{name:string;description:string;parameters:Readonly<Record<string,unknown>>}>;
type Source=Readonly<{version:1;messages:readonly Message[];tools:readonly Declaration[];maxOutputTokens:number;timeoutMs:number}>;

const text=(value:unknown,max:number=LIMITS.text):string=>typeof value==='string'&&value.length<=max?value:privatePolicyRefusal();
const plain=(value:unknown):unknown=>JSON.parse(JSON.stringify(value));

/** Strict structural capture of the harness request. Anything else is refused. */
function capture(value:unknown):Source{
 const root=privateRecord(value,['version','messages','tools','maxOutputTokens','timeoutMs']);
 if(root.version!==1)return privatePolicyRefusal();
 const messages=privateList(root.messages,LIMITS.messages).map((item):Message=>{
  const role=(item as {role?:unknown})?.role;
  if(role==='system'||role==='user'){const row=privateRecord(item,['role','content']);return Object.freeze({role,content:text(row.content)});}
  if(role==='tool'){const row=privateRecord(item,['role','toolCallId','content']);return Object.freeze({role,toolCallId:text(row.toolCallId,256),content:text(row.content)});}
  if(role==='assistant'){const row=privateRecord(item,['role','content','toolCalls']);
   return Object.freeze({role,content:row.content===null?null:text(row.content),toolCalls:Object.freeze(privateList(row.toolCalls,LIMITS.calls).map(call=>{
    const c=privateRecord(call,['id','name','arguments']);return Object.freeze({id:text(c.id,256),name:text(c.name,256),arguments:text(c.arguments,65_536)});}))});}
  return privatePolicyRefusal();
 });
 if(messages[0]?.role!=='system')return privatePolicyRefusal();
 const tools=privateList(root.tools,LIMITS.tools).map(item=>{const row=privateRecord(item,['name','description','parameters']);
  const name=text(row.name,64);if(!NAME.test(name))return privatePolicyRefusal();
  if(!row.parameters||typeof row.parameters!=='object'||Array.isArray(row.parameters))return privatePolicyRefusal();
  return Object.freeze({name,description:text(row.description,16_384),parameters:Object.freeze(plain(row.parameters) as Record<string,unknown>)});});
 return Object.freeze({version:1,messages:Object.freeze(messages),tools:Object.freeze(tools),
  maxOutputTokens:privateCount(root.maxOutputTokens,1,LIMITS.output),timeoutMs:privateCount(root.timeoutMs,1,LIMITS.timeout)});
}

type Schema=Record<string,unknown>;
const isMap=(schema:Schema)=>schema.type==='object'&&!schema.properties&&schema.additionalProperties!==undefined&&typeof schema.additionalProperties==='object';
function nullable(schema:Schema):Schema{
 if(typeof schema.type==='string'){const out:Schema={...schema,type:[schema.type,'null']};if(Array.isArray(schema.enum))out.enum=[...schema.enum,null];return out;}
 return{anyOf:[schema,{type:'null'}]};
}
/** A JSON schema as strict function calling accepts it. */
export function strictToolSchema(schema:Schema):Schema{
 if(isMap(schema))return{type:'array',description:'Name and value pairs.',items:{type:'object',properties:{name:{type:'string'},value:strictToolSchema(schema.additionalProperties as Schema)},required:['name','value'],additionalProperties:false}};
 if(schema.type==='object'){
  const properties=(schema.properties??{}) as Record<string,Schema>,required=new Set((schema.required??[]) as string[]);
  return{...schema,properties:Object.fromEntries(Object.entries(properties).map(([key,child])=>[key,required.has(key)?strictToolSchema(child):nullable(strictToolSchema(child))])),
   required:Object.keys(properties),additionalProperties:false};
 }
 if(schema.type==='array'&&schema.items&&typeof schema.items==='object')return{...schema,items:strictToolSchema(schema.items as Schema)};
 return{...schema};
}
/** The harness's own arguments in the strict shape, for earlier tool calls sent back as history. */
export function toStrictArguments(schema:Schema|undefined,value:unknown):unknown{
 if(!schema)return value;
 if(isMap(schema)&&value&&typeof value==='object'&&!Array.isArray(value))return Object.entries(value as Record<string,unknown>).map(([name,item])=>({name,value:toStrictArguments(schema.additionalProperties as Schema,item)}));
 if(schema.type==='object'&&value&&typeof value==='object'&&!Array.isArray(value)){
  const properties=(schema.properties??{}) as Record<string,Schema>,given=value as Record<string,unknown>;
  return Object.fromEntries([...Object.entries(properties).map(([key,child])=>[key,given[key]===undefined?null:toStrictArguments(child,given[key])]),
   ...Object.entries(given).filter(([key])=>!(key in properties))]);
 }
 if(schema.type==='array'&&Array.isArray(value)&&schema.items&&typeof schema.items==='object')return value.map(item=>toStrictArguments(schema.items as Schema,item));
 return value;
}
/** Undoes the strict shape: a null optional property is absent, a name/value list is the string map it stood for. */
export function fromStrictArguments(schema:Schema|undefined,value:unknown):unknown{
 if(!schema)return value;
 if(isMap(schema)){
  if(!Array.isArray(value))return value;
  const out:Record<string,unknown>={};
  for(const pair of value){if(!pair||typeof pair!=='object'||typeof (pair as {name?:unknown}).name!=='string')return value;
   out[(pair as {name:string}).name]=fromStrictArguments(schema.additionalProperties as Schema,(pair as {value?:unknown}).value);}
  return out;
 }
 if(schema.type==='object'&&value&&typeof value==='object'&&!Array.isArray(value)){
  const properties=(schema.properties??{}) as Record<string,Schema>,required=new Set((schema.required??[]) as string[]),out:Record<string,unknown>={};
  for(const [key,item] of Object.entries(value as Record<string,unknown>)){
   if(item===null&&!required.has(key))continue;
   out[key]=key in properties?fromStrictArguments(properties[key],item):item;
  }
  return out;
 }
 if(schema.type==='array'&&Array.isArray(value)&&schema.items&&typeof schema.items==='object')return value.map(item=>fromStrictArguments(schema.items as Schema,item));
 return value;
}

const safeName=(name:string)=>NAME.test(name)?name:INERT_TOOL;
const parsed=(raw:string):unknown=>{try{const value=JSON.parse(raw||'{}');return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}catch{return {};}};

function conversation(source:Source):ConverseArgs{
 const declared=new Map(source.tools.map(tool=>[tool.name,tool.parameters as Schema]));
 const system:string[]=[source.messages[0].content as string],turns:AiTurn[]=[],names=new Map<string,string>(),historyNames=new Set<string>();
 for(const message of source.messages.slice(1)){
  if(message.role==='system'){system.push(message.content);continue;}
  if(message.role==='user'){turns.push({role:'user',content:message.content});continue;}
  if(message.role==='assistant'){
   const toolCalls:AiToolCall[]=message.toolCalls.map(call=>{const name=safeName(call.name);names.set(call.id,name);if(!declared.has(name))historyNames.add(name);
    return{id:call.id,name,input:toStrictArguments(declared.get(name),parsed(call.arguments))};});
   turns.push({role:'assistant',content:message.content??'',...(toolCalls.length?{toolCalls}:{})});continue;
  }
  if(message.role!=='tool')return privatePolicyRefusal();
  const name=names.get(message.toolCallId);if(!name)return privatePolicyRefusal();
  const last=turns.at(-1),result={id:message.toolCallId,name,content:message.content};
  if(last?.role==='tool')last.results.push(result);else turns.push({role:'tool',results:[result]});
 }
 if(system.length>LIMITS.systemNotes+1||turns[0]?.role!=='user')return privatePolicyRefusal();
 const tools:AiToolSpec[]=[...source.tools.map(tool=>({name:tool.name,description:tool.description,inputSchema:strictToolSchema(tool.parameters as Schema) as AiJsonSchema})),
  ...[...historyNames].map(name=>({name,description:INERT_DESCRIPTION,inputSchema:{type:'object' as const,properties:{},required:[],additionalProperties:false as const}}))];
 if(tools.length>32)return privatePolicyRefusal();
 // The turn runner executes several calls from one response sequentially, in order, under the spec's caps, so it opts
 // in to multi-call responses; every other caller keeps the transport's single-call refusal.
 return Object.freeze({system,turns,tools,maxTokens:source.maxOutputTokens,timeoutMs:source.timeoutMs,allowMultipleToolCalls:true as const});
}

export function fingerprintTerasHarnessTask(value:unknown):string{return createHash('sha256').update('teras:harness-turn\n'+JSON.stringify(capture(value))).digest('hex');}
export function captureTerasHarnessTask(value:unknown):PrivateTaskCapture{return Object.freeze({args:conversation(capture(value)),local:null});}
export const TERAS_HARNESS_DESCRIPTOR:PrivateTaskDescriptor=Object.freeze({features:Object.freeze(['hr_assistant'] as const),operation:'conversation',
 fingerprint:fingerprintTerasHarnessTask,capture:captureTerasHarnessTask});
