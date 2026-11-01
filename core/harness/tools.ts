/** ADR-0170 step 1 — the tools a turn may offer, bound to their existing native owners.
 *
 * A ToolProvider returns the CANDIDATE bindings for one caller; the runner then applies the gate, the spec's
 * offer policy and the caller's own narrowing (./runner.ts), so the offer policy is never the provider's.
 * The native provider binds:
 *  - reads: specs generated from the semantic model (contextToolSpecs), only for reads core/assistant-tools
 *    toolsFor(ctx) offers this caller (module enablement), each run by its existing owner AS THE CALLER;
 *  - context tools: the phase-B owners (core/product-context/tools.ts) for this caller;
 *  - step 4 capabilities: the "Why?" explainers and the setup co-pilot (core/explainers/capabilities.ts), as
 *    reads with their own semantic entities, for callers whose module (or administrator role) they need;
 *  - suggest_action: the caller's current action catalogue (core/product-context/actions.ts). A suggestion
 *    is a pointer to the review page where the person completes and confirms. For the leave cards (step 2)
 *    the native preparer may also issue a signed proposal (core/proposals/suggested.ts) from the caller's own
 *    records and words; it saves a review, never a change, and the person confirms on the review page.
 * No binding changes HR data; the only write is the review custody row a native preparer saves for a proposal.
 * Tests may pass their own provider; production wiring will not. */
import type {SessionContext} from '../../db/client';
import type {AiToolSpec} from '../../lib/ai/types';
import {toolsFor} from '../assistant-tools';
import {contextToolSpecsFor,runContextTool,suggestAction} from '../product-context/tools';
import {actionCatalogueFor} from '../product-context/actions';
import {linkablePathsFor} from '../../lib/product-context/destinations';
import {visibleModuleCodes} from '../../lib/nav-entitlements';
import {contextToolSpecs,TERAS_READS,terasToolSpecs} from '../semantic-model/generate';
import {terasCapabilitiesFor} from '../explainers/capabilities';
import {SEMANTIC_READS} from '../semantic-model/entities';
import type {EntityId} from '../semantic-model/types';
import {prepareSuggestedProposal} from '../proposals/suggested';
import type {Proposal} from '../proposals/proposal';
import {HARNESS_SPEC} from './spec';

export type ToolKind='read'|'context'|'suggest';
export type ToolRun=Readonly<{ok:boolean;content:unknown;refusal?:string;suggestion?:Readonly<{action:string;reviewRoute:string;inlineCard:boolean}>;
 /** A signed proposal the native preparer issued for this suggestion (never shown to the model). */
 proposal?:Proposal}>;
export type ToolBinding=Readonly<{name:string;kind:ToolKind;entity:EntityId|null;spec:AiToolSpec;
 /** Inputs that take a record handle from an earlier result in this turn. */
 identifierInputs:readonly string[];
 run(input:Record<string,unknown>):Promise<ToolRun>}>;
/** `personWords` is the person's own question this turn, never model text (core/proposals/suggested.ts). */
export type ToolScope=Readonly<{companyId:string;locale?:string;personWords?:string}>;
export type ToolCandidates=Readonly<{bindings:readonly ToolBinding[];
 /** Review routes the caller's catalogue names; replies may link to the one suggested this turn. */
 reviewRoutes:readonly string[];
 /** Product paths this caller has (the destination registry), for the link check. */
 destinations:readonly string[]}>;
export type ToolProvider=(ctx:SessionContext,scope:ToolScope,actions:boolean)=>Promise<ToolCandidates>;

const SUGGEST_DESCRIPTION='Point the person to the page where they complete and confirm one change from available_actions. Nothing is prepared or submitted.';
export const nativeToolProvider:ToolProvider=async(ctx,scope,actions)=>{
 const owners=new Map(toolsFor(ctx).map(tool=>[tool.spec.name,tool]));
 const reads=contextToolSpecs().filter(spec=>owners.has(spec.name)).map((spec):ToolBinding=>{
  const declared=SEMANTIC_READS.find(read=>read.name===spec.name)!,owner=owners.get(spec.name)!;
  return{name:spec.name,kind:'read',entity:declared.entity,spec,identifierInputs:declared.input.filter(input=>input.identifier).map(input=>input.name),
   async run(input){const outcome=await owner.run(ctx,input);return outcome.ok?{ok:true,content:outcome}:{ok:false,content:outcome,refusal:outcome.refusal};}};
 });
 const teras=terasCapabilitiesFor(ctx).map((capability):ToolBinding=>{
  const spec=terasToolSpecs().find(row=>row.name===capability.name)!,declared=TERAS_READS.find(read=>read.name===capability.name)!;
  return{name:spec.name,kind:'read',entity:declared.entity,spec,identifierInputs:[],
   async run(input){const outcome=await capability.run(ctx,input,scope);return outcome.ok?{ok:true,content:outcome}:{ok:false,content:outcome,refusal:outcome.refusal};}};
 });
 const context=contextToolSpecsFor(ctx).map((spec):ToolBinding=>({name:spec.name,kind:'context',entity:null,spec,identifierInputs:[],
  async run(input){const result=await runContextTool(ctx,spec.name,input,scope);return result.ok?{ok:true,content:result.content}:{ok:false,content:result,refusal:result.refusal};}}));
 const catalogue=actions?await actionCatalogueFor(ctx):[];
 const suggest:ToolBinding[]=catalogue.length?[{name:HARNESS_SPEC.offer.suggestTool,kind:'suggest',entity:null,identifierInputs:[],
  spec:{name:HARNESS_SPEC.offer.suggestTool,description:SUGGEST_DESCRIPTION,inputSchema:{type:'object',properties:{action:{type:'string',enum:catalogue.map(row=>row.id)},details:{type:'object',additionalProperties:{type:'string'}}},required:['action'],additionalProperties:false} as AiToolSpec['inputSchema']},
  async run(input){const result=suggestAction(catalogue,input.action,input.details);
   if(result.suggested){const proposal=await prepareSuggestedProposal(ctx,result.action,input.details,scope.personWords);
    return{ok:true,content:{...result,note:proposal?'A review item is ready; the person checks and confirms it on the review page. Nothing is submitted until they do.':'The person completes and confirms this on the review page; nothing is prepared or submitted.'},
     suggestion:{action:result.action,reviewRoute:result.reviewRoute,inlineCard:result.inlineCard},...(proposal?{proposal}:{})};}
   return{ok:false,refusal:result.reason,content:{...result,note:result.reason==='missing_details'?'Ask the person for the missing details. Do not say anything is prepared.':'This change is not available to this person here.'}};}}]:[];
 return Object.freeze({bindings:Object.freeze([...context,...reads,...teras,...suggest]),reviewRoutes:Object.freeze(catalogue.map(row=>row.reviewRoute)),
  destinations:linkablePathsFor(ctx,visibleModuleCodes(ctx)??undefined)});
};

/** Validates arguments against the subset of JSON Schema the specs use. Returns the problem, or null. */
export function invalidInput(schema:Readonly<Record<string,unknown>>,value:unknown):string|null{
 const type=schema.type;
 if(type==='object'){
  if(!value||typeof value!=='object'||Array.isArray(value))return 'not an object';
  const properties=(schema.properties??{}) as Record<string,Record<string,unknown>>,given=value as Record<string,unknown>;
  for(const key of (schema.required??[]) as string[])if(given[key]===undefined)return 'missing '+key;
  for(const [key,child] of Object.entries(given)){
   const rule=properties[key]??(typeof schema.additionalProperties==='object'?schema.additionalProperties as Record<string,unknown>:null);
   if(!rule){if(schema.additionalProperties===false)return 'unexpected '+key;continue;}
   const problem=invalidInput(rule,child);if(problem)return key+': '+problem;
  }
  return null;
 }
 if(type==='string'){if(typeof value!=='string')return 'not a string';
  if(Array.isArray(schema.enum)&&!schema.enum.includes(value))return 'not an allowed value';
  if(typeof schema.pattern==='string'&&!new RegExp(schema.pattern).test(value))return 'wrong format';
  if(typeof schema.maxLength==='number'&&value.length>schema.maxLength)return 'too long';return null;}
 if(type==='integer'||type==='number'){if(typeof value!=='number'||!Number.isFinite(value)||(type==='integer'&&!Number.isInteger(value)))return 'not a '+type;
  if(typeof schema.minimum==='number'&&value<schema.minimum)return 'too small';if(typeof schema.maximum==='number'&&value>schema.maximum)return 'too large';return null;}
 if(type==='boolean')return typeof value==='boolean'?null:'not a boolean';
 return null;
}
