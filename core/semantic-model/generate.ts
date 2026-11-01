/** ADR-0170 step 0b — everything offered over the semantic model is generated here, never hand-written.
 *
 * Three outputs, all pure and frozen:
 *  - capabilityRegistry(): one row per declared read and action, with effect, audience, RLS scope,
 *    sensitivity, native owners and the per-class field disclosure (the phase B registry's shape, widened);
 *  - contextToolSpecs(): provider-facing specs for the reads. Names and input schemas equal the production
 *    catalogue (pinned by test); descriptions name only fields whose class allows disclosure;
 *  - connectToolSpecs(): MCP-shaped declarations for Teras Connect (ADR-0170 §3.9, review pending): read
 *    and prepare only, output schemas without `never` fields, bands typed as bands.
 * No output carries a value: only declared field names, product vocabulary and page routes. Not imported by
 * the production Assistant, whose specs still come from lib/ai/assistant-tool-catalogue.ts. */
import type {AiJsonSchema,AiToolSpec} from '../../lib/ai/types';
import {SEMANTIC_ACTIONS,SEMANTIC_ENTITIES,SEMANTIC_READS,semanticEntity} from './entities';
import {DISCLOSURE_CLASSES,type CapabilityRow,type ConnectToolSpec,type DisclosureClass,type SemanticAction,type SemanticField,type SemanticRead} from './types';

const freeze=<T>(value:T):T=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
const object=(properties:Record<string,unknown>,required:string[]=Object.keys(properties)):AiJsonSchema=>({type:'object',properties,required,additionalProperties:false});

/** Field paths per disclosure class; nested rows read `parent.child`. */
export function disclosureOf(fields:readonly SemanticField[]):Readonly<Record<DisclosureClass,readonly string[]>>{
 const out:Record<DisclosureClass,string[]>={never:[],bands:[],minimum:[],full:[]};
 const walk=(rows:readonly SemanticField[],prefix:string)=>{for(const field of rows){out[field.disclosure].push(prefix+field.name);if(field.of)walk(field.of,prefix+field.name+'.');}};
 walk(fields,'');
 return out;
}
/** Leaves that may leave the product. A `never` parent hides its children too. */
const disclosable=(fields:readonly SemanticField[]):SemanticField[]=>fields.filter(field=>field.disclosure!=='never');
const inputSchema=(read:SemanticRead)=>object(Object.fromEntries(read.input.map(input=>[input.name,{...input.schema}])));

let registry:readonly CapabilityRow[]|undefined;
export function capabilityRegistry():readonly CapabilityRow[]{
 if(registry)return registry;
 const reads=SEMANTIC_READS.map((read):CapabilityRow=>{const entity=semanticEntity(read.entity);
  return{name:read.name,effect:'read',entity:entity.id,module:entity.module,sensitivity:entity.sensitivity,audience:entity.audience,rls:entity.rls,
   purpose:read.purpose,owners:entity.owners,disclosure:disclosureOf(entity.fields)};});
 const actions=SEMANTIC_ACTIONS.map((action):CapabilityRow=>{const entity=semanticEntity(action.entity);
  return{name:action.id,effect:'prepare_review',entity:entity.id,module:action.module,sensitivity:entity.sensitivity,audience:action.audience,rls:entity.rls,
   purpose:action.purpose,owners:[action.preparer,action.service],disclosure:disclosureOf(entity.fields),reviewRoute:action.reviewRoute,
   requiredDetails:action.nominable.filter(row=>!row.optional).map(row=>row.name)};});
 registry=freeze([...reads,...actions]);
 return registry;
}

const CLASS_WORDS:Readonly<Record<Exclude<DisclosureClass,'never'>,string>>={full:'Returns',minimum:'Returns only when the question needs it',bands:'Figures, released as bands'};
function describe(read:SemanticRead):string{
 const entity=semanticEntity(read.entity),classes=disclosureOf(disclosable(entity.fields));
 const parts=DISCLOSURE_CLASSES.filter((key):key is Exclude<DisclosureClass,'never'>=>key!=='never'&&classes[key].length>0)
  .map(key=>`${CLASS_WORDS[key]}: ${classes[key].join(', ')}.`);
 const handles=read.input.filter(input=>input.identifier).map(input=>input.name);
 return [read.purpose,...parts,
  ...(handles.length?[`Takes ${handles.join(', ')} only from an earlier result; never guess one.`]:[]),
  `Scope: ${entity.audience.replace(/_/g,' ')}, under ${entity.rls.replace(/_/g,' ')} row-level security.`].join(' ');
}
let context:readonly AiToolSpec[]|undefined;
export function contextToolSpecs():readonly AiToolSpec[]{
 context??=freeze(SEMANTIC_READS.map(read=>({name:read.name,description:describe(read),inputSchema:inputSchema(read)})));
 return context;
}

const JSON_TYPE:Readonly<Record<SemanticField['type'],string>>={id:'string',code:'string',text:'string',name:'string',label:'string',date:'string',datetime:'string',
 time:'string',period:'string',number:'number',integer:'integer',boolean:'boolean',enum:'string',list:'array',object:'object'};
function outputProperty(field:SemanticField):Record<string,unknown>{
 const tag={'x-teras-disclosure':field.disclosure,description:field.meaning};
 if(field.disclosure==='bands')return{type:'string',...tag,description:field.meaning+' Released as a band, restored locally.'};
 if(field.of){const rows=Object.fromEntries(disclosable(field.of).map(child=>[child.name,outputProperty(child)]));
  return field.type==='list'?{type:'array',items:object(rows,[]),...tag}:{...object(rows,[]),...tag};}
 return{type:JSON_TYPE[field.type],...(field.values?{enum:[...field.values]}:{}),...tag};
}
/** A read that needs an identifier handle is not Connect-eligible: identifiers never leave the product,
 * and no opaque per-client handle exists yet. An action without a proposal preparer is not migrated, and a
 * migrated action reaches Connect only once its legal review (ADR-0170 §3.9) admits it: step 2 gave
 * leave.cancel and approvals.leave.decide preparers without widening Connect. */
export const CONNECT_REVIEWED_ACTIONS:readonly string[]=Object.freeze(['leave.apply']);
export const connectEligibleRead=(read:SemanticRead)=>read.input.every(input=>!input.identifier);
export const connectEligibleAction=(action:SemanticAction)=>action.proposal!==null&&CONNECT_REVIEWED_ACTIONS.includes(action.id);
let connect:readonly ConnectToolSpec[]|undefined;
export function connectToolSpecs():readonly ConnectToolSpec[]{
 if(connect)return connect;
 const reads=SEMANTIC_READS.filter(connectEligibleRead).map((read):ConnectToolSpec=>{const entity=semanticEntity(read.entity);
  return{name:'teras_'+read.name,title:entity.label,description:describe(read),inputSchema:inputSchema(read),
   outputSchema:object(Object.fromEntries(disclosable(entity.fields).map(field=>[field.name,outputProperty(field)])),[]),
   annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}};});
 const actions=SEMANTIC_ACTIONS.filter(connectEligibleAction).map((action):ConnectToolSpec=>({name:'teras_prepare_'+action.id.replace(/[.]/g,'_'),
  title:'Prepare: '+semanticEntity(action.entity).label.toLowerCase(),
  description:`${action.purpose} Prepares a signed proposal for the person to review and confirm on ${action.reviewRoute} under their own login. Nothing changes until they confirm there.`,
  inputSchema:object(Object.fromEntries(action.nominable.map(row=>[row.name,{type:'string',format:row.type}])),action.nominable.filter(row=>!row.optional).map(row=>row.name)),
  outputSchema:object({action:{type:'string',enum:[action.id]},hints:object(Object.fromEntries(action.nominable.map(row=>[row.name,{type:'string',format:row.type}])),[]),
   reviewRoute:{type:'string',enum:[action.reviewRoute]},expiresAt:{type:'string',format:'date-time'}}),
  annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false}}));
 connect=freeze([...reads,...actions]);
 return connect;
}
/** Every page a generated output names: entity pages and review routes. */
export const referencedPages=():readonly string[]=>Object.freeze([...new Set([...SEMANTIC_ENTITIES.map(entity=>entity.page),...SEMANTIC_ACTIONS.map(action=>action.reviewRoute)])]);
