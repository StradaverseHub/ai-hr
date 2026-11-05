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
import {DISCLOSURE_CLASSES,type CapabilityRow,type ConnectToolSpec,type DisclosureClass,type EntityId,type SemanticAction,type SemanticEntity,type SemanticField,type SemanticRead} from './types';
import {EXPLAIN_ENTITIES,EXPLAIN_READS} from './entities-explain';
import {SETUP_ENTITIES,SETUP_READS} from './entities-setup';
import {RECOMMEND_ENTITIES} from './entities-recommend';
import {METRIC_ENTITIES,METRIC_READS} from './entities-metrics';
import {CATALOGUE_ENTITIES} from './entities-catalogue';
import {IMPORT_ENTITIES} from './entities-imports';
import {WHY_ENTITIES,WHY_READS} from './entities-why';
import {LOOP_ENTITIES,LOOP_READS} from './entities-loops';
import {PAYROLL_READINESS_ENTITIES,PAYROLL_READINESS_READS} from './entities-payroll-readiness';
import {PAYROLL_LOOP_ENTITIES,PAYROLL_LOOP_READS} from './entities-payroll-loops';
import {HANDBOOK_ENTITIES,HANDBOOK_READS} from './entities-handbook';
import {QUALITY_ENTITIES,QUALITY_READS} from './entities-quality';
import {PAYROLL_LEARNING_ENTITIES,PAYROLL_LEARNING_READS} from './entities-payroll-learning';

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
const inputSchema=(read:SemanticRead)=>object(Object.fromEntries(read.input.map(input=>[input.name,{...input.schema}])),read.input.filter(input=>!input.optional).map(input=>input.name));

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
function describe(read:SemanticRead,entity:SemanticEntity=semanticEntity(read.entity)):string{
 const classes=disclosureOf(disclosable(entity.fields));
 const parts=DISCLOSURE_CLASSES.filter((key):key is Exclude<DisclosureClass,'never'>=>key!=='never'&&classes[key].length>0)
  .map(key=>`${CLASS_WORDS[key]}: ${classes[key].join(', ')}.`);
 const handles=read.input.filter(input=>input.identifier).map(input=>input.name);
 return [read.purpose,...parts,
  ...(handles.length?[`Takes ${handles.join(', ')} only from an earlier result; never guess one.`]:[]),
  `Scope: ${entity.audience.replace(/_/g,' ')}, under ${entity.rls.replace(/_/g,' ')} row-level security.`].join(' ');
}
/** Step 5c kit additions (core/improvement/kit.ts): the description, input schema and registry row every
 * generated output above uses, so a kit-generated capability is generated by the same code, never a copy. */
export const describeRead=(read:SemanticRead,entity:SemanticEntity):string=>describe(read,entity);
export const readInputSchema=(read:SemanticRead):AiJsonSchema=>inputSchema(read);
export const disclosableFields=(fields:readonly SemanticField[]):readonly SemanticField[]=>disclosable(fields);
export const readRegistryRow=(read:SemanticRead,entity:SemanticEntity):CapabilityRow=>({name:read.name,effect:'read',entity:entity.id,module:entity.module,
 sensitivity:entity.sensitivity,audience:entity.audience,rls:entity.rls,purpose:read.purpose,owners:entity.owners,disclosure:disclosureOf(entity.fields)});
let context:readonly AiToolSpec[]|undefined;
export function contextToolSpecs():readonly AiToolSpec[]{
 context??=freeze(SEMANTIC_READS.map(read=>({name:read.name,description:describe(read),inputSchema:inputSchema(read)})));
 return context;
}

const JSON_TYPE:Readonly<Record<SemanticField['type'],string>>={id:'string',code:'string',text:'string',name:'string',label:'string',date:'string',datetime:'string',
 time:'string',period:'string',number:'number',integer:'integer',boolean:'boolean',enum:'string',list:'array',object:'object',
 // AI v2 Phase 2 P2-5: an approved, published policy paragraph (./types.ts published_text).
 published_text:'string'};
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

/** ADR-0170 step 4 — the model as the Teras harness reads it: the declared entities (step 4's field additions
 * are declared in ./entities.ts since integration), plus the explainer, setup co-pilot, step 5 and pay-average entities. The
 * production catalogue outputs above are unchanged; the Teras harness disclosure (disclosure.ts) discloses by these. */
let terasModel:readonly SemanticEntity[]|undefined;
export function terasEntities():readonly SemanticEntity[]{
 // AI v2 W1 appends the capability catalogue (./entities-catalogue.ts), disclosed for the harness's product_capabilities.
 // AI v2 W5 appends the pay difference and claim limit explainers (./entities-why.ts).
 // AI v2 slice 3 appends the chat import (./entities-imports.ts), disclosed for the harness's prepare_import.
 // AI v2 W8 appends the loops overview (./entities-loops.ts), for administrators.
 terasModel??=freeze([...SEMANTIC_ENTITIES,...EXPLAIN_ENTITIES,...SETUP_ENTITIES,...RECOMMEND_ENTITIES,...METRIC_ENTITIES,...CATALOGUE_ENTITIES,...WHY_ENTITIES,...IMPORT_ENTITIES,...LOOP_ENTITIES,
  // AI v2 Phase 2 P2-3 appends the "Before payroll" checklist (./entities-payroll-readiness.ts).
  ...PAYROLL_READINESS_ENTITIES,
  // AI v2 Phase 2 (wave 1 integration) appends the payroll-cycle loop pages (./entities-payroll-loops.ts).
  ...PAYROLL_LOOP_ENTITIES,
  // AI v2 Phase 2 P2-5 appends the Living Handbook's approved policies (./entities-handbook.ts).
  ...HANDBOOK_ENTITIES,
  // AI v2 Phase 2 P2-6 appends AI quality (./entities-quality.ts).
  ...QUALITY_ENTITIES,
  // Payroll history learning (P2) appends "Learned this cycle" (./entities-payroll-learning.ts).
  ...PAYROLL_LEARNING_ENTITIES]);
 return terasModel;
}
export const terasEntity=(id:EntityId):SemanticEntity=>{const entity=terasEntities().find(row=>row.id===id);if(!entity)throw Error('Unknown semantic entity.');return entity;};
/** The step 4 capabilities and the governed pay averages (issue 13b): harness-only reads, never in the production catalogue. */
// AI v2 W5 appends the pay difference and claim limit explainers; AI v2 W8 the loops overview.
export const TERAS_READS:readonly SemanticRead[]=Object.freeze([...EXPLAIN_READS,...SETUP_READS,...METRIC_READS,...WHY_READS,...LOOP_READS,
 // AI v2 Phase 2 P2-3 appends my_payroll_readiness; the wave 1 integration the payroll-cycle loop reads.
 ...PAYROLL_READINESS_READS,...PAYROLL_LOOP_READS,
 // AI v2 Phase 2 P2-5 appends my_policy_handbook.
 ...HANDBOOK_READS,
 // AI v2 Phase 2 P2-6 appends ai_quality_summary.
 ...QUALITY_READS,
 // Payroll history learning (P2) appends payroll_learning_status.
 ...PAYROLL_LEARNING_READS]);
let terasSpecs:readonly AiToolSpec[]|undefined;
export function terasToolSpecs():readonly AiToolSpec[]{
 terasSpecs??=freeze(TERAS_READS.map(read=>({name:read.name,description:describe(read,terasEntity(read.entity)),inputSchema:inputSchema(read)})));
 return terasSpecs;
}
let terasRegistry:readonly CapabilityRow[]|undefined;
/** capabilityRegistry(), plus one row per step 4 capability. */
export function terasCapabilityRegistry():readonly CapabilityRow[]{
 terasRegistry??=freeze([...capabilityRegistry(),
  ...TERAS_READS.map((read):CapabilityRow=>{const entity=terasEntity(read.entity);
   return{name:read.name,effect:'read',entity:entity.id,module:entity.module,sensitivity:entity.sensitivity,audience:entity.audience,rls:entity.rls,
    purpose:read.purpose,owners:entity.owners,disclosure:disclosureOf(entity.fields)};})]);
 return terasRegistry;
}
