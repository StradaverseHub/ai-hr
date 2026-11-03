/** ADR-0170 step 1 — the tools a turn may offer, bound to their existing native owners.
 *
 * A ToolProvider returns the CANDIDATE bindings for one caller; the runner then applies the gate, the spec's
 * offer policy and the caller's own narrowing (./runner.ts), so the offer policy is never the provider's.
 * The native provider binds:
 *  - reads: specs generated from the semantic model (contextToolSpecs), only for reads core/assistant-tools
 *    toolsFor(ctx) offers this caller (module enablement), each run by its existing owner AS THE CALLER;
 *  - context tools: the phase-B owners (core/product-context/tools.ts) for this caller;
 *  - step 4 capabilities: the "Why?" explainers and the setup co-pilot (core/explainers/capabilities.ts), as
 *    reads with their own semantic entities, for callers whose module (or administrator role) they need, the
 *    explainers only while the tenant's explainers worker gate is open (switch on, tenant not stopped);
 *  - suggest_action: the caller's current action catalogue (core/product-context/actions.ts). A suggestion
 *    is a pointer to the review page where the person completes and confirms. For the leave cards (step 2)
 *    the native preparer may also issue a signed proposal (core/proposals/suggested.ts) from the caller's own
 *    records and words; it saves a review, never a change, and the person confirms on the review page. A leave
 *    application (issue 10) with details missing or unclear returns them, with the leave types numbered, so the
 *    person is asked one question; nothing is suggested until it is clear.
 * No binding changes HR data; the only write is the review custody row a native preparer saves for a proposal.
 * Tests may pass their own provider; production wiring will not. */
import {and,eq,inArray,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../../db/client';
import {employment} from '../../db/schema';
import {hasTeamAccess,isAdmin} from '../../lib/authz-model';
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
import {asksToBypassReview,prepareSuggestedProposal} from '../proposals/suggested';
import {LEAVE_APPLY_FORM_ROUTE} from '../proposals/leave-apply';
import type {Proposal} from '../proposals/proposal';
import {HARNESS_SPEC} from './spec';

export type ToolKind='read'|'context'|'suggest';
export type ToolRun=Readonly<{ok:boolean;content:unknown;refusal?:string;suggestion?:Readonly<{action:string;reviewRoute:string;inlineCard:boolean}>;
 /** Review M15: employments in this result that the caller administers (an HR administrator's own scope, decided by
  * the database's app.is_admin_for). Their names reach the model; everyone else's stay placeholders. */
 namesInScope?:ReadonlySet<string>;
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

const SUGGEST_DESCRIPTION='Point the person to the page where they complete and confirm one change from available_actions. For leave.apply, details may carry leaveType, startDate and endDate (YYYY-MM-DD), durationType (full_day, half_day_am or half_day_pm) and reason, each only from the person\'s own words; leave out what they did not say. Nothing is submitted.'
 // AI v2 W2: the attendance requests prepared from chat (core/proposals/attendance-request.ts).
 +' For attendance.correction.request, details may carry date (YYYY-MM-DD), checkIn and checkOut (HH:MM, 24-hour) and reason; for attendance.overtime.request, date, plannedStartTime and plannedEndTime (HH:MM, 24-hour) and reason. The same rule applies: only what the person said.'
 // AI v2 W2: own claims and own profile changes (core/proposals/claim-submit.ts, claim-cancel.ts, profile-change.ts).
 +' For claims.submit, details may carry claimType, claimItem, amount (exactly as the person stated it), incurredOn (YYYY-MM-DD) and description. For claims.cancel, details may carry incurredOn.'
 +' For ess.profile.request, details carry change (address, emergency_contact, dependant or bank) and only what the person said: addressLine1, addressLine2, addressLine3, postcode, city, state; contactName, relationship; dependantName, relationship, dateOfBirth (YYYY-MM-DD), gender; bankName.'
 +' Never put a bank account, phone or identity number in details: the system reads those from the person\'s own message.';
/** Issue 10: a leave application from chat with details missing or unclear. One question, never a guess. */
const ASK_NOTE='Some details for this leave application are missing or unclear (listed in missing). Nothing is prepared. Ask the person one short question for them; when options are listed, show them numbered as given and ask for the number. Never guess a leave type or a date.';
/** AI v2 W2: an attendance correction or overtime request with details missing (the date, a time, a clock-in to pair with
 * a clock-out, or the person's own reason). One question, never a guess. */
const ATTENDANCE_ASK_NOTE='Some details for this attendance request are missing or unclear (listed in missing). Nothing is prepared. Ask the person one short question for them; checkIn means the clock-in time to pair with the clock-out they gave. Never guess a date, a time or a reason.';
const FORM_NOTE='The leave application is filled in on the Request Leave form for the person to check and submit there. Nothing is submitted until they do.';
const CHOOSE_NOTE='Several leave requests are waiting for this person\'s decision, numbered in pending. Nothing is prepared. List them by number (applicant, leave type, days and when it starts) and ask which number they want to approve; never choose one yourself. When they say which, suggest again with that number as request in details. Requests not listed are on the review page.';
/** Entities whose rows name other people the caller may see (core/semantic-model/entities.ts). */
/** Review H5 (runs 41343676782 and 41360905376): an approver asking what is "pending for me" was answered from their own
 * applications. For an approver whose words ask that, their own-requests result says where the queue is. */
const PENDING_FOR_ME=/\bpending\s+(for|to|on)\s+me\b|\bwaiting\s+(for|on)\s+(me|my)\b|\bneeds?\s+my\s+(approval|decision|review)\b|\b(for|to)\s+(me\s+to\s+)?approve\b|\bmy\s+approvals?\b|\bawaiting\s+my\b/i;
export const asksPendingForMe=(words:string|undefined)=>typeof words==='string'&&PENDING_FOR_ME.test(words);
const QUEUE_NOTE='These are the person\'s own applications only. Requests from other people waiting for their decision are in approval_queue: call it for "pending for me".';
const NAMED_OTHERS:ReadonlySet<EntityId>=new Set<EntityId>(['absence','employment_profile']);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function employmentIdsIn(value:unknown,out=new Set<string>()):Set<string>{
 if(Array.isArray(value)){for(const item of value)employmentIdsIn(item,out);return out;}
 if(value&&typeof value==='object')for(const [key,child] of Object.entries(value)){
  if(key==='employmentId'&&typeof child==='string'&&UUID.test(child))out.add(child);
  else if(key==='employmentIds'&&Array.isArray(child)){for(const id of child)if(typeof id==='string'&&UUID.test(id))out.add(id);}
  else employmentIdsIn(child,out);}
 return out;
}
/** Review M15 (owner privacy decision 9, "only based on the user's access"): the employments in a result that an HR
 * administrator administers, read as the caller under RLS with the database's own company-scope rule. Empty for
 * anyone who is not an administrator. */
export async function administeredEmployments(ctx:SessionContext,content:unknown):Promise<ReadonlySet<string>>{
 const ids=[...employmentIdsIn(content)];
 if(!isAdmin(ctx)||!ids.length)return new Set();
 const rows=await withTenant(ctx,tx=>tx.select({id:employment.id}).from(employment)
  .where(and(eq(employment.tenantId,ctx.tenantId),inArray(employment.id,ids),sql`app.is_admin_for(${employment.companyId}) IS TRUE`)));
 return new Set(rows.map(row=>row.id));
}
export const nativeToolProvider:ToolProvider=async(ctx,scope,actions)=>{
 const owners=new Map(toolsFor(ctx).map(tool=>[tool.spec.name,tool]));
 const reads=contextToolSpecs().filter(spec=>owners.has(spec.name)).map((spec):ToolBinding=>{
  const declared=SEMANTIC_READS.find(read=>read.name===spec.name)!,owner=owners.get(spec.name)!;
  return{name:spec.name,kind:'read',entity:declared.entity,spec,identifierInputs:declared.input.filter(input=>input.identifier).map(input=>input.name),
   async run(input){const outcome=await owner.run(ctx,input);if(!outcome.ok)return{ok:false,content:outcome,refusal:outcome.refusal};
    if(spec.name==='my_leave_requests'&&hasTeamAccess(ctx)&&asksPendingForMe(scope.personWords))return{ok:true,content:{...outcome,note:QUEUE_NOTE}};
    return NAMED_OTHERS.has(declared.entity)?{ok:true,content:outcome,namesInScope:await administeredEmployments(ctx,outcome)}:{ok:true,content:outcome};}};
 });
 const teras=(await terasCapabilitiesFor(ctx)).map((capability):ToolBinding=>{
  const spec=terasToolSpecs().find(row=>row.name===capability.name)!,declared=TERAS_READS.find(read=>read.name===capability.name)!;
  return{name:spec.name,kind:'read',entity:declared.entity,spec,identifierInputs:[],
   async run(input){const outcome=await capability.run(ctx,input,scope);return outcome.ok?{ok:true,content:outcome}:{ok:false,content:outcome,refusal:outcome.refusal};}};
 });
 const context=contextToolSpecsFor(ctx).map((spec):ToolBinding=>({name:spec.name,kind:'context',entity:null,spec,identifierInputs:[],
  async run(input){const result=await runContextTool(ctx,spec.name,input,scope);return result.ok?{ok:true,content:result.content}:{ok:false,content:result,refusal:result.refusal};}}));
 const catalogue=actions?await actionCatalogueFor(ctx):[];
 // Disclosed under its declared entity (core/semantic-model/entities-recommend.ts): pending applicants and dates are
 // another person's, so they leave as placeholders.
 const suggest:ToolBinding[]=catalogue.length?[{name:HARNESS_SPEC.offer.suggestTool,kind:'suggest',entity:'suggested_action',identifierInputs:[],
  spec:{name:HARNESS_SPEC.offer.suggestTool,description:SUGGEST_DESCRIPTION,inputSchema:{type:'object',properties:{action:{type:'string',enum:catalogue.map(row=>row.id)},details:{type:'object',additionalProperties:{type:'string'}}},required:['action'],additionalProperties:false} as AiToolSpec['inputSchema']},
  async run(input){
   // A request to skip the review or decide in bulk gets no decision suggestion at all (model run 41360905376).
   if(typeof input.action==='string'&&/^approvals\..+\.decide$/.test(input.action)&&asksToBypassReview(scope.personWords))
    return{ok:false,refusal:'review_required',content:{ok:false,note:'The person asked to skip the review or to decide in bulk. Nothing is suggested: every decision is checked and confirmed one at a time on its review page. Say so briefly.'}};
   // AI v2 W2: the overtime card's native hint shape is its selectors only (date and window); the person's own reason is
   // for the native preparer (core/proposals/attendance-request.ts), never a hint, so it is left out of the hint check.
   const hinted=input.action==='attendance.overtime.request'&&input.details&&typeof input.details==='object'&&!Array.isArray(input.details)
    ?Object.fromEntries(Object.entries(input.details as Record<string,unknown>).filter(([key])=>key!=='reason')):input.details;
   const result=suggestAction(catalogue,input.action,hinted);
   if(result.suggested){const outcome=await prepareSuggestedProposal(ctx,result.action,input.details,scope.personWords,undefined,scope.locale);
    // A leave application with details missing or unclear: the person is asked, and nothing is suggested yet.
    if(outcome?.kind==='ask')return{ok:false,refusal:'missing_details',content:{suggested:false,action:result.action,reason:'missing_details',missing:outcome.missing,
     ...(outcome.options.length?{options:outcome.options}:{}),note:'note' in outcome?outcome.note:result.action.startsWith('attendance.')?ATTENDANCE_ASK_NOTE:ASK_NOTE}};
    const suggestion={action:result.action,reviewRoute:result.reviewRoute,inlineCard:result.inlineCard};
    // Several pending: the person chooses; the model lists them and asks, and nothing is prepared (ADR-0170 §3.15).
    if(outcome?.kind==='choose')return{ok:true,content:{...result,pending:outcome.pending,...(outcome.more?{notListed:outcome.more}:{}),note:CHOOSE_NOTE},suggestion};
    const proposal=outcome?.kind==='proposal'?outcome.proposal:null;
    const note=!proposal?'The person completes and confirms this on the review page; nothing is prepared or submitted.'
     :proposal.body.review.route===LEAVE_APPLY_FORM_ROUTE?FORM_NOTE:'A review item is ready; the person checks and confirms it on the review page. Nothing is submitted until they do.';
    return{ok:true,content:{...result,note},
     suggestion,...(proposal?{proposal}:{})};}
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
