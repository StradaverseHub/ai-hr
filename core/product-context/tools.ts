/** ADR-0169 phase B — the Assistant's context and capability layer, as typed tools.
 *
 * Six context tools (product destinations, product guidance, available actions, the approval queue, and for
 * administrators setup readiness and company setup) run as the caller over
 * existing owners, plus a capability registry that classifies every existing Assistant read and proposable
 * action by effect, and a deterministic proposal check that reuses the native hint schema. Nothing here
 * changes data, prepares a review or sends anything to a provider. Not imported by the production
 * Assistant (outside the provider privacy closure until the ADR-0169 §5.1 review passes); a future harness
 * must route tool output through the reviewed disclosure contract before any egress. */
import type {SessionContext} from '../../db/client';
import type {AiToolSpec} from '../../lib/ai/types';
import {isAdmin} from '../../lib/authz-model';
import {ASSISTANT_TOOLS} from '../assistant-tools';
import {visibleModuleCodes} from '../../lib/nav-entitlements';
import {ASSISTANT_PROPOSAL_FALLBACK,ASSISTANT_PROPOSAL_HINT_KEYS,captureAssistantProposalHints,isAssistantProposableAction,type AssistantProposableAction} from '../../lib/ai/assistant-action-proposal-hints';
import {DESTINATION_PURPOSE,destinationsFor} from '../../lib/product-context/destinations';
import {productGuidance} from './guides';
import {setupReadiness,SetupReadinessRefused} from './setup-readiness';
import {ACTION_PURPOSE,SUGGESTABLE_ACTIONS,actionCatalogueFor,type SuggestableAction} from './actions';
import {approvalQueueFor} from './approval-queue';
import {companySetup,CompanySetupRefused} from './company-setup';
import en from '../../messages/en.json';import ms from '../../messages/ms.json';import zh from '../../messages/zh.json';import vi from '../../messages/vi.json';import ta from '../../messages/ta.json';import th from '../../messages/th.json';
const NAV_LABELS:Readonly<Record<string,Record<string,string>>>={en:en.nav,ms:ms.nav,zh:zh.nav,vi:vi.nav,ta:ta.nav,th:th.nav};
/** A destination's label in the person's locale, as product_destinations gives it. */
export const destinationLabel=(labelKey:string,locale?:string)=>(NAV_LABELS[locale??'en']??NAV_LABELS.en)[labelKey]??NAV_LABELS.en[labelKey]??labelKey;

export type CapabilityEffect='read'|'context'|'prepare_review';
export type Capability=Readonly<{name:string;effect:CapabilityEffect;module:string|null;sensitivity:'ordinary'|'pay'|'identity'|'configuration';
 audience:'everyone'|'admin';purpose:string;reviewRoute?:string;requiredDetails?:readonly string[]}>;

const object=(properties:Record<string,unknown>,required:string[]=[])=>({type:'object' as const,properties,required,additionalProperties:false});
export const CONTEXT_TOOL_SPECS:Readonly<Record<'product_destinations'|'product_guidance'|'setup_readiness'|'available_actions'|'approval_queue'|'company_setup',AiToolSpec>>=Object.freeze({
 product_destinations:{name:'product_destinations',description:'Real places in this product that the signed-in person can open, with their labels and addresses. Name or link only these.',inputSchema:object({}) as AiToolSpec['inputSchema']},
 product_guidance:{name:'product_guidance',description:'Search this company\'s published product guides for how a feature works or how to set it up. Returns authored guide sections with links.',inputSchema:object({query:{type:'string',maxLength:200}},['query']) as AiToolSpec['inputSchema']},
 available_actions:{name:'available_actions',description:'Changes this person may be pointed to in the product, each with its purpose, its review page and the details that page collects. Suggest only these; the person completes and confirms each change on its page.',inputSchema:object({}) as AiToolSpec['inputSchema']},
 approval_queue:{name:'approval_queue',description:'Requests from other people waiting for the signed-in person\'s own decision as an approver ("anything pending for me", "waiting for my approval"): how many, by kind, with the page where they review them and the matching review action, and the leave requests among them (who, leave type, days and dates).',inputSchema:object({}) as AiToolSpec['inputSchema']},
 company_setup:{name:'company_setup',description:'Administrators only: the companies they administer (every company in the group for a group administrator), by name, with the page that lists them; and the leave types and attendance schedule groups this company has already configured (names and whether each leave type is paid), with the pages where they are set up. Whether a leave type can grant days comes from setup_readiness.',inputSchema:object({}) as AiToolSpec['inputSchema']},
 setup_readiness:{name:'setup_readiness',description:'Administrators only: whether this company is set up to run: payroll this month, employee records missing required information, each leave type\'s entitlement health and public holidays loaded, attendance schedule groups and employees without one, and onboarding checklists. Counts, statuses and configuration names only, with the page to fix each.',inputSchema:object({}) as AiToolSpec['inputSchema']},
});
/** Every capability the Assistant could offer, classified. Context tools are admin-only where marked. */
export function capabilityRegistry():readonly Capability[]{
 return Object.freeze([
  ...ASSISTANT_TOOLS.map(tool=>Object.freeze({name:tool.spec.name,effect:'read' as const,module:tool.module,sensitivity:tool.sensitivity,audience:'everyone' as const,purpose:tool.spec.description})),
  Object.freeze({name:'product_destinations',effect:'context' as const,module:null,sensitivity:'ordinary' as const,audience:'everyone' as const,purpose:CONTEXT_TOOL_SPECS.product_destinations.description}),
  Object.freeze({name:'product_guidance',effect:'context' as const,module:null,sensitivity:'ordinary' as const,audience:'everyone' as const,purpose:CONTEXT_TOOL_SPECS.product_guidance.description}),
  Object.freeze({name:'setup_readiness',effect:'context' as const,module:null,sensitivity:'configuration' as const,audience:'admin' as const,purpose:CONTEXT_TOOL_SPECS.setup_readiness.description}),
  Object.freeze({name:'company_setup',effect:'context' as const,module:null,sensitivity:'configuration' as const,audience:'admin' as const,purpose:CONTEXT_TOOL_SPECS.company_setup.description}),
  Object.freeze({name:'available_actions',effect:'context' as const,module:null,sensitivity:'ordinary' as const,audience:'everyone' as const,purpose:CONTEXT_TOOL_SPECS.available_actions.description}),
  Object.freeze({name:'approval_queue',effect:'context' as const,module:null,sensitivity:'ordinary' as const,audience:'everyone' as const,purpose:CONTEXT_TOOL_SPECS.approval_queue.description}),
  // Every human-confirmed registry action is suggestable; the seven inline-card actions keep their hint schema.
  ...SUGGESTABLE_ACTIONS.map(action=>{const inline=isAssistantProposableAction(action.id);return Object.freeze({name:action.id,effect:'prepare_review' as const,module:action.module,
   sensitivity:'ordinary' as const,audience:action.permission.actor==='self'?'everyone' as const:'admin' as const,purpose:ACTION_PURPOSE[action.id]??action.id,
   reviewRoute:inline?ASSISTANT_PROPOSAL_FALLBACK[action.id as AssistantProposableAction]:action.review.route,
   ...(inline?{requiredDetails:Object.freeze(ASSISTANT_PROPOSAL_HINT_KEYS[action.id as AssistantProposableAction].filter(key=>!key.endsWith('?')))}:{})});}),
 ]);
}
/** Context tool specs this caller may be offered (setup readiness for administrators only). Anyone can hold an
 * assigned approval (named attendance participants, reporting assignments), so the queue is offered to everyone. */
export function contextToolSpecsFor(ctx:SessionContext):readonly AiToolSpec[]{
 return Object.freeze([CONTEXT_TOOL_SPECS.product_destinations,CONTEXT_TOOL_SPECS.product_guidance,CONTEXT_TOOL_SPECS.available_actions,CONTEXT_TOOL_SPECS.approval_queue,...(isAdmin(ctx)?[CONTEXT_TOOL_SPECS.setup_readiness,CONTEXT_TOOL_SPECS.company_setup]:[])]);
}
export type ContextToolResult=Readonly<{ok:true;content:unknown}>|Readonly<{ok:false;refusal:'not_offered'|'invalid_input'|'not_permitted'}>;
/** Runs one context tool as the caller. `companyId` is the caller's current company scope. */
export async function runContextTool(ctx:SessionContext,name:string,input:unknown,scope:{companyId:string;locale?:string}):Promise<ContextToolResult>{
 if(!contextToolSpecsFor(ctx).some(spec=>spec.name===name))return{ok:false,refusal:'not_offered'};
 const value=input&&typeof input==='object'&&!Array.isArray(input)?input as Record<string,unknown>:null;if(!value)return{ok:false,refusal:'invalid_input'};
 if(name==='product_destinations'){
  // The sidebar's own module visibility owner; null means "no opinion" there, so no module filter here.
  return{ok:true,content:destinationsFor(ctx,visibleModuleCodes(ctx)??undefined).map(row=>({href:row.href,label:destinationLabel(row.labelKey,scope.locale),module:row.module,
   ...(DESTINATION_PURPOSE[row.href]?{purpose:DESTINATION_PURPOSE[row.href]}:{})}))};
 }
 if(name==='product_guidance'){
  if(typeof value.query!=='string'||!value.query.trim()||value.query.length>200)return{ok:false,refusal:'invalid_input'};
  return{ok:true,content:await productGuidance(ctx,value.query,scope.locale)};
 }
 if(name==='company_setup'){try{return{ok:true,content:await companySetup(ctx)};}catch(error){if(error instanceof CompanySetupRefused)return{ok:false,refusal:'not_permitted'};throw error;}}
 if(name==='approval_queue')return{ok:true,content:await approvalQueueFor(ctx,scope.companyId)};
 if(name==='available_actions')return{ok:true,content:(await actionCatalogueFor(ctx)).map(({id,purpose,reviewRoute,humanInputs})=>({id,purpose,reviewRoute,collects:humanInputs}))};
 try{return{ok:true,content:await setupReadiness(ctx,scope.companyId)};}
 catch(error){if(error instanceof SetupReadinessRefused)return{ok:false,refusal:'not_permitted'};throw error;}
}
/** Deterministic check before any proposal is shown: the native hint schema decides, and missing required
 * details are named so the person is asked for them. A valid result is still only a suggestion. */
export function checkProposal(action:unknown,details:unknown):Readonly<{valid:true;action:string}>|Readonly<{valid:false;missing:readonly string[]}>{
 if(!isAssistantProposableAction(action))return{valid:false,missing:[]};
 const given=details&&typeof details==='object'&&!Array.isArray(details)?details as Record<string,unknown>:{};
 const required=ASSISTANT_PROPOSAL_HINT_KEYS[action].filter(key=>!key.endsWith('?'));
 const missing=required.filter(key=>typeof given[key]!=='string'||!(given[key] as string).trim());
 if(missing.length)return{valid:false,missing:Object.freeze(missing)};
 try{captureAssistantProposalHints(action,given);return{valid:true,action};}catch{return{valid:false,missing:Object.freeze(required)};}
}
/** Suggest one action from the caller's CURRENT catalogue. Inline-card actions must pass the native hint
 * check first; every other action points to its review page, which collects and validates the details.
 * Either way nothing is prepared or submitted: the person acts on the page. */
export function suggestAction(catalogue:readonly SuggestableAction[],action:unknown,details?:unknown):
 Readonly<{suggested:true;action:string;reviewRoute:string;inlineCard:boolean}>|Readonly<{suggested:false;reason:'not_available'}>|Readonly<{suggested:false;reason:'missing_details';missing:readonly string[]}>{
 const entry=catalogue.find(row=>row.id===action);if(!entry)return{suggested:false,reason:'not_available'};
 if(entry.inlineCard){const check=checkProposal(entry.id,details??{});if(!check.valid)return{suggested:false,reason:'missing_details',missing:check.missing};}
 return{suggested:true,action:entry.id,reviewRoute:entry.reviewRoute,inlineCard:entry.inlineCard};
}
