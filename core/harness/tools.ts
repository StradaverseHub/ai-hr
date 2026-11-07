import {aiCentreReadAllowed,withAiCentreFunction,assertAiCentreRunningTx} from '../ai-centre-control';
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
 *  - product_capabilities (AI v2 W1): the caller's capability catalogue (core/product-context/capability-catalogue.ts),
 *    a context tool disclosed under its semantic entity (core/semantic-model/entities-catalogue.ts).
 *  - approval_queue: the approvals inbox's counts (core/product-context/approval-queue.ts) with the leave requests among
 *    them that the leave decision card can open (approvalQueueWithLeaveRequests below), a context tool disclosed under its
 *    semantic entity (core/semantic-model/entities-recommend.ts approval_queue), so applicants and dates are placeholders.
 *  - topic tools (spec v23): operations_status and explain_why, each serving a family of the capabilities above as topics
 *    (core/semantic-model/topic-tools.ts) instead of one tool per read, so every role's biggest turn stays within the
 *    provider's tool ceiling; each topic keeps its capability's gate, runner, entity and disclosure (topicBindings below).
 *  - prepare_import (AI v2 slice 3, issue 16b): an import prepared from a file attached in chat (core/chat-import/tool.ts),
 *    offered only to a caller who may import here and only when the gate allows actions. The file is the turn's own
 *    (ToolScope.importFile), never the model's, and never reaches it: the result is disclosed under
 *    core/semantic-model/entities-imports.ts. The preparer saves no review; payroll history records its own upload attempt.
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
import {contextToolSpecs,readInputSchema,TERAS_READS,terasToolSpecs} from '../semantic-model/generate';
import {FOLDED_READS,TOPIC_TOOLS,topicRead,topicToolSpec} from '../semantic-model/topic-tools';
import {terasCapabilitiesFor,type TerasCapability} from '../explainers/capabilities';
import {SEMANTIC_ACTIONS,SEMANTIC_READS} from '../semantic-model/entities';
import type {EntityId} from '../semantic-model/types';
import {asksToBypassReview,assignedLeaveDecisionChoices,pendingStarts,prepareSuggestedProposal} from '../proposals/suggested';
import {approvalQueueWithLeaveIdsFor} from '../product-context/approval-queue';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {LEAVE_APPLY_FORM_ROUTE} from '../proposals/leave-apply';
import {requestDates,requestDatesView} from '../proposals/request-dates';
import type {Proposal} from '../proposals/proposal';
import {HARNESS_SPEC} from './spec';
import {PRODUCT_CAPABILITIES_SPEC,productCapabilities} from '../product-context/capability-catalogue';
import {chatImportKindsFor} from '../chat-import/kinds';
import {PREPARE_IMPORT_TOOL,prepareImportSpec,runPrepareImport} from '../chat-import/tool';
import type {ChatImportFile} from '../../lib/chat-import';

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
 /** Spec v23: a topic tool's result is disclosed under the entity of the topic its validated input names
  * (core/semantic-model/topic-tools.ts), never one entity for the whole tool. Absent: `entity` above. */
 entityOf?(input:Record<string,unknown>):EntityId|null;
 run(input:Record<string,unknown>):Promise<ToolRun>}>;
/** `personWords` is the person's own question this turn, never model text (core/proposals/suggested.ts). */
export type ToolScope=Readonly<{companyId:string;locale?:string;personWords?:string;
 /** AI v2 slice 3: the file the person attached to this turn (lib/chat-import.ts), read only by prepare_import's native
  * preparer. Never sent to the model. */
 importFile?:ChatImportFile}>;
export type ToolCandidates=Readonly<{bindings:readonly ToolBinding[];
 /** Review routes the caller's catalogue names; replies may link to the one suggested this turn. */
 reviewRoutes:readonly string[];
 /** Product paths this caller has (the destination registry), for the link check. */
 destinations:readonly string[]}>;
export type ToolProvider=(ctx:SessionContext,scope:ToolScope,actions:boolean)=>Promise<ToolCandidates>;

const SUGGEST_DESCRIPTION='Point the person to the page where they complete and confirm one change. For leave.apply, details may carry leaveType, startDate and endDate, durationType (full_day, half_day_am or half_day_pm) and reason, each only from the person\'s own words; leave out what they did not say. Nothing is submitted.'
 // AI v2 W2: the attendance requests prepared from chat (core/proposals/attendance-request.ts).
 +' For attendance.correction.request, details may carry date, checkIn and checkOut (HH:MM, 24-hour) and reason; for attendance.overtime.request, date, plannedStartTime and plannedEndTime (HH:MM, 24-hour) and reason. The same rule applies: only what the person said.'
 // Owner, 5 November 2026 ("Fix dates first"): the HR date owner works out a named day (core/proposals/request-dates.ts).
 +' For leave.apply, attendance.correction.request and attendance.overtime.request, a date detail is YYYY-MM-DD when the person gave a date; when they named a day instead (today, tomorrow, yesterday, next Friday, this Monday, last Tuesday, next week, on the 13th, or the same in Malay or Chinese), put their own words for it, such as "next friday", and the system works out the date. Their reason is the person\'s own words for why, which may already be in their message (such as "forgot to clock out").'
 // AI v2 W2: own claims and own profile changes (core/proposals/claim-submit.ts, claim-cancel.ts, profile-change.ts).
 +' For claims.submit, details may carry claimType, claimItem, amount (exactly as the person stated it), incurredOn (YYYY-MM-DD) and description. For claims.cancel, details may carry incurredOn.'
 +' For ess.profile.request, details carry change (address, emergency_contact, dependant or bank) and only what the person said: addressLine1, addressLine2, addressLine3, postcode, city, state; contactName, relationship; dependantName, relationship, dateOfBirth (YYYY-MM-DD), gender; bankName.'
 +' Never put a bank account, phone or identity number in details: the system reads those from the person\'s own message.'
 // AI v2 W2 (slice 2): the own Leave Credit request, time off in lieu (core/proposals/toil-request.ts).
 +' For toil.replacement.request, details may carry workedDate (YYYY-MM-DD), claimStart and claimEnd (HH:MM, 24-hour) and reason, only what the person said. The system counts any days credited; never state or work out a credit, rate or pay, and never put anything about agreement or consent in details: only the person can agree, on the card.'
 // AI v2 W2 (slice 3): an assigned approver's claim or attendance decision (core/proposals/assigned-decide.ts).
 +' For approvals.claim.decide and approvals.attendance.decide, details may carry request (the number the person chose from a list), date (YYYY-MM-DD) and, for a rejection, reason in the person\'s own words. Never put a name, an amount or a decision in details: the system reads whose request it is and whether to approve or reject from the person\'s own message, and the approver confirms it on the card.';
/** The details the native hint check sees for one suggestion. The overtime card's hint is its selectors only, without the
 * person's reason, and its date is a date (lib/ai/assistant-action-proposal-hints.ts): a day the person named in their own
 * words is worked out first by the HR date owner's rule (core/proposals/request-dates.ts), the same rule its preparer runs,
 * so "this Saturday" is never refused as a missing date (eval on ef479b55c, mgr-overtime-1). Every other action's
 * details pass unchanged. Pure apart from the clock. */
export function suggestHint(action:unknown,details:unknown,personWords:string|undefined,now:Date=new Date()):unknown{
 if(action!=='attendance.overtime.request'||!details||typeof details!=='object'||Array.isArray(details))return details;
 const hint:Record<string,unknown>=Object.fromEntries(Object.entries(details as Record<string,unknown>).filter(([key])=>key!=='reason'));
 if(typeof hint.date==='string'){const day=requestDates(hint.date,'',personWords,{now,singleDay:true});if(day.kind==='dates')hint.date=day.dates.startDate;}
 return hint;
}
/** Spec v13 (aiv2-speed-findings-20261103, cause 1b): suggest_action is called without available_actions when the action is
 * clear, so its description names the purpose of each declared action (core/semantic-model/entities.ts SEMANTIC_ACTIONS)
 * this caller holds, from the same catalogue rows available_actions returns. Only those (eight at v13; eleven with the
 * slice 2 Leave Credit and the slice 3 approver decisions): the other ids keep their purposes in available_actions. Pure. */
const DECLARED_ACTIONS:ReadonlySet<string>=new Set(SEMANTIC_ACTIONS.map(action=>action.id));
export function suggestDescription(catalogue:readonly Readonly<{id:string;purpose:string}>[]):string{
 const purposes=catalogue.filter(row=>DECLARED_ACTIONS.has(row.id)).map(row=>row.id+': '+row.purpose);
 return purposes.length?SUGGEST_DESCRIPTION+' What these actions do: '+purposes.join(' '):SUGGEST_DESCRIPTION;
}
/** Issue 10: a leave application from chat with details missing or unclear. One question, never a guess. */
const ASK_NOTE='Some details for this leave application are missing or unclear (listed in missing). Nothing is prepared. Ask the person one short question for them; when options are listed, show them numbered as given and ask for the number. Never guess a leave type or a date.';
/** AI v2 W2: an attendance correction or overtime request with details missing (the date, a time, a clock-in to pair with
 * a clock-out, or the person's own reason). One question, never a guess. */
const ATTENDANCE_ASK_NOTE='Some details for this attendance request are missing or unclear (listed in missing). Nothing is prepared. Ask the person one short question for them only: checkOut means only the clock-out time, because the clock-in on record (in recorded) is used; checkIn means the clock-in time to pair with the clock-out; time means the clock-in or clock-out time they want corrected. Never ask for anything in recorded or dates, and never guess a date, a time or a reason.';
/** Owner, 5 November 2026: the dates the system worked out, stated with their weekdays; other dates are offered on the card. */
const DATES_NOTE=' The dates in dates are the ones the system worked out: state them with their weekdays as given. When dates lists others, say the card lets them switch to that date.';
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
/** At most this many waiting leave requests are named; the rest are counted and left to the approvals page. */
export const MAX_QUEUE_LEAVE_REQUESTS=5;
const QUEUE_DECIDE_NOTE='The leave requests among these that wait for this person\'s decision are in leaveRequests, numbered; the applicant and the dates are placeholders the person sees as the real name and date. Name each one in your reply: who, the leave type, the days and the date. Offer to open its decision here for them to review and confirm (suggest_action with the action in decide brings its card); when several wait, ask which number. Never decide one yourself or say it is approved. Other kinds are counted in groups, with their page.';
const QUEUE_PAGE_NOTE='The leave requests among these that wait for this person\'s decision are in leaveRequests, numbered; the applicant and the dates are placeholders the person sees as the real name and date. Name each one in your reply: who, the leave type, the days and the date, and link the page where they decide it. Never decide one yourself or say it is approved.';
/** After spec v20's scored run 41641279562 (mgr-queue-1, "anything waiting for my approval?": "1 leave request is
 * waiting", without who, when or an offer to open it). The approvals inbox's counts for the current company (unchanged), with
 * the leave requests among them that the leave decision card can open for this approver: the card's own assigned-choice
 * owner (core/proposals/suggested.ts assignedLeaveDecisionChoices, the inbox's assignment rule), kept only where the
 * queue counts the request, numbered as suggest_action numbers them. Nobody outside this approver's queue is ever listed.
 * Disclosed under the approval_queue entity: the applicant and dates leave as placeholders the person sees restored, as on
 * their approvals page. `decide` only when this turn offers that card (the leave decision is in the caller's catalogue). */
export async function approvalQueueWithLeaveRequests(ctx:SessionContext,companyId:string,options:Readonly<{decide:boolean;now?:Date}>):Promise<Readonly<Record<string,unknown>>>{
 const {summary,leaveRequestIds}=await approvalQueueWithLeaveIdsFor(ctx,companyId);
 if(!leaveRequestIds.size)return summary;
 const {choices:all}=await assignedLeaveDecisionChoices(ctx),counted=all.filter(row=>leaveRequestIds.has(row.id));
 if(!counted.length)return summary;
 const today=todayInKualaLumpur(options.now??new Date()),days=(value:unknown)=>{const parsed=Number(value);return Number.isFinite(parsed)?parsed:null;};
 const listed=counted.slice(0,MAX_QUEUE_LEAVE_REQUESTS);
 return Object.freeze({...summary,leaveRequests:Object.freeze(listed.map(row=>Object.freeze({request:all.indexOf(row)+1,applicant:row.applicant,leaveType:row.leaveType,
  days:days(row.days),starts:pendingStarts(row.startDate,today),startDate:row.startDate,endDate:row.endDate}))),
  ...(leaveRequestIds.size>listed.length?{leaveRequestsNotListed:leaveRequestIds.size-listed.length}:{}),
  ...(options.decide?{decide:'approvals.leave.decide'}:{}),note:options.decide?QUEUE_DECIDE_NOTE:QUEUE_PAGE_NOTE});
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
 const publicContext:readonly string[]=HARNESS_SPEC.offer.publicContextTools;
 // Spec v22: a capability served as a product_guidance topic is reached through that context tool, never bound itself.
 const permitted=(await terasCapabilitiesFor(ctx)).filter(capability=>!capability.topic);
 // Spec v23: so is a read served as a topic of a topic tool (core/semantic-model/topic-tools.ts); see topicBindings.
 const teras=permitted.filter(capability=>!FOLDED_READS.has(capability.name)).map((capability):ToolBinding=>{
  const spec=terasToolSpecs().find(row=>row.name===capability.name)!,declared=TERAS_READS.find(read=>read.name===capability.name)!;
  // Only the spec's closed public names are context. Keep the semantic entity for declared disclosure.
  return{name:spec.name,kind:publicContext.includes(capability.name)?'context':'read',entity:declared.entity,spec,identifierInputs:[],
   async run(input){const outcome=await capability.run(ctx,input,scope);return outcome.ok?{ok:true,content:outcome}:{ok:false,content:outcome,refusal:outcome.refusal};}};
 });
 const topics=topicBindings(ctx,permitted,scope);
 const catalogue=actions?await actionCatalogueFor(ctx):[];
 const context=contextToolSpecsFor(ctx).map((spec):ToolBinding=>spec.name==='approval_queue'
  // The queue names the leave requests waiting for this approver, so it is disclosed under its declared entity.
  ?{name:spec.name,kind:'context',entity:'approval_queue',spec,identifierInputs:[],
   async run(){return{ok:true,content:await approvalQueueWithLeaveRequests(ctx,scope.companyId,{decide:catalogue.some(row=>row.id==='approvals.leave.decide')})};}}
  :{name:spec.name,kind:'context',entity:null,spec,identifierInputs:[],
   async run(input){
    // Spec v22: product_guidance serves only the spec's guidance topics; anything else is refused before its owner runs.
    const topic=spec.name==='product_guidance'&&input&&typeof input==='object'?(input as Record<string,unknown>).topic:undefined;
    if(topic!==undefined&&topic!==null&&!(HARNESS_SPEC.offer.guidanceTopics as readonly unknown[]).includes(topic))return{ok:false,content:{ok:false,refusal:'invalid_input'},refusal:'invalid_input'};
    const result=await runContextTool(ctx,spec.name,input,scope);return result.ok?{ok:true,content:result.content}:{ok:false,content:result.content??result,refusal:result.refusal};}});
 // Spec v20: where a decision with no match points, when this caller may open the approvals list.
 const approvalsPage=catalogue.some(row=>/^approvals\..+\.decide$/.test(row.id))&&linkablePathsFor(ctx,visibleModuleCodes(ctx)??undefined).includes('/approvals')?'/approvals':null;
 // Disclosed under its declared entity (core/semantic-model/entities-recommend.ts): pending applicants and dates are
 // another person's, so they leave as placeholders.
 const suggest:ToolBinding[]=catalogue.length?[{name:HARNESS_SPEC.offer.suggestTool,kind:'suggest',entity:'suggested_action',identifierInputs:[],
  spec:{name:HARNESS_SPEC.offer.suggestTool,description:suggestDescription(catalogue),inputSchema:{type:'object',properties:{action:{type:'string',enum:catalogue.map(row=>row.id)},details:{type:'object',additionalProperties:{type:'string'}}},required:['action'],additionalProperties:false} as AiToolSpec['inputSchema']},
  async run(input){
   // A request to skip the review or decide in bulk gets no decision suggestion at all (model run 41360905376).
   if(typeof input.action==='string'&&/^approvals\..+\.decide$/.test(input.action)&&asksToBypassReview(scope.personWords))
    return{ok:false,refusal:'review_required',content:{ok:false,note:'The person asked to skip the review or to decide in bulk. Nothing is suggested: every decision is checked and confirmed one at a time on its review page. Say so briefly.'}};
   // AI v2 W2: the overtime card's native hint shape is its selectors only (date and window); the person's own reason is
   // for the native preparer (core/proposals/attendance-request.ts), never a hint, so it is left out of the hint check.
   // A day the person named ("this Saturday") is worked out by the HR date owner first (suggestHint above).
   const hinted=suggestHint(input.action,input.details,scope.personWords);
   // AI v2 W2 (slice 3): an assigned decision card has no hint selectors; the request number, date and reason are for the
   // native preparer (core/proposals/assigned-decide.ts), which counts them only when the person said them.
   const decideHint=input.action==='approvals.claim.decide'||input.action==='approvals.attendance.decide'?{}:hinted;
   const result=suggestAction(catalogue,input.action,decideHint);
   if(result.suggested){const outcome=await prepareSuggestedProposal(ctx,result.action,input.details,scope.personWords,undefined,scope.locale);
    // A leave application with details missing or unclear: the person is asked, and nothing is suggested yet.
    if(outcome?.kind==='ask'){
     // The dates the HR date owner worked out and what the attendance day holds now, so the question asks only for what is missing.
     const dates='dates' in outcome&&outcome.dates?requestDatesView(outcome.dates):null,recorded='recorded' in outcome&&outcome.recorded?outcome.recorded:null;
     return{ok:false,refusal:'missing_details',content:{suggested:false,action:result.action,reason:'missing_details',missing:outcome.missing,
     ...(outcome.options.length?{options:outcome.options}:{}),...(dates?{dates}:{}),...(recorded?{recorded}:{}),
     note:('note' in outcome?outcome.note:result.action.startsWith('attendance.')?ATTENDANCE_ASK_NOTE:ASK_NOTE)+(dates?DATES_NOTE:'')}};}
    // Spec v20: a decision with nothing pending that matches the person's words (or whose queue could not be read) gets no
    // card and no suggestion: the reply says so plainly, with the approvals page.
    if(outcome?.kind==='no_match'||outcome?.kind==='unavailable')return{ok:false,refusal:outcome.kind,content:{suggested:false,action:result.action,reason:outcome.kind,
     ...(approvalsPage?{page:approvalsPage}:{}),note:outcome.note}};
    const suggestion={action:result.action,reviewRoute:result.reviewRoute,inlineCard:result.inlineCard};
    // Several pending: the person chooses; the model lists them and asks, and nothing is prepared (ADR-0170 §3.15).
    if(outcome?.kind==='choose')return{ok:true,content:{...result,pending:outcome.pending,...(outcome.more?{notListed:outcome.more}:{}),note:'note' in outcome?outcome.note:CHOOSE_NOTE},suggestion};
    const proposal=outcome?.kind==='proposal'?outcome.proposal:null;
    // The card's own dates, as the proposal carries them, with any other date the person's words may mean.
    const dates=proposal&&outcome&&'dates' in outcome&&outcome.dates&&proposal.body.facts?.startDate
     ?requestDatesView({startDate:proposal.body.facts.startDate,endDate:proposal.body.facts.endDate??proposal.body.facts.startDate,others:proposal.body.facts.otherDates}):null;
    const note=(!proposal?'The person completes and confirms this on the review page; nothing is prepared or submitted.'
     :proposal.body.review.route===LEAVE_APPLY_FORM_ROUTE?FORM_NOTE:'A review item is ready; the person checks and confirms it on the review page. Nothing is submitted until they do.')+(dates?DATES_NOTE:'');
    return{ok:true,content:{...result,...(dates?{dates}:{}),note},
     suggestion,...(proposal?{proposal}:{})};}
   return{ok:false,refusal:result.reason,content:{...result,note:result.reason==='missing_details'?'Ask the person for the missing details. Do not say anything is prepared.':'This change is not available to this person here.'}};}}]:[];
 // AI v2 W1: what this person can do, import, report on or open; nothing is `prepare` when this surface offers no actions.
 const capabilities:ToolBinding[]=[{name:PRODUCT_CAPABILITIES_SPEC.name,kind:'context',entity:'product_capability',spec:PRODUCT_CAPABILITIES_SPEC,identifierInputs:[],
  async run(input){const result=await productCapabilities(ctx,input,{locale:scope.locale,prepare:actions});return result.ok?{ok:true,content:result}:{ok:false,content:result,refusal:result.refusal};}}];
 // AI v2 slice 3 (issue 16b): an import prepared from a file attached in chat, for a caller who may import here.
 const importKinds=actions?await chatImportKindsFor(ctx):[];
 const imports:ToolBinding[]=importKinds.length?[{name:PREPARE_IMPORT_TOOL,kind:'suggest',entity:'chat_import',spec:prepareImportSpec(importKinds),identifierInputs:[],
  async run(input){const result=await runPrepareImport(ctx,importKinds,input,scope);return{ok:result.ok,content:result.content,...(result.refusal?{refusal:result.refusal}:{}),...(result.proposal?{proposal:result.proposal}:{})};}}]:[];
 const bindings=[...context,...reads,...teras,...topics,...suggest,...capabilities,...imports].map(binding=>Object.freeze({...binding,
  async run(input:Record<string,unknown>){const key=topicRead(binding.name,input.topic)?.name??binding.name;return withAiCentreFunction(ctx,'read:'+key,async()=>{
   const allowed=await aiCentreReadAllowed(ctx,key);
   const moduleAllowed=binding.name!=='my_module_work'||typeof input.module!=='string'||await aiCentreReadAllowed(ctx,'module:'+input.module);
   if(!allowed||!moduleAllowed)return {ok:false as const,refusal:'not_permitted',content:{ok:false,refusal:'not_permitted',message:'This AI function is switched off. Use its normal page or contact your administrator.'}};
   const result=await binding.run(input);
   await withTenant(ctx,tx=>assertAiCentreRunningTx(tx,ctx));
   return result;
  });}
 }));
 return Object.freeze({bindings:Object.freeze(bindings),reviewRoutes:Object.freeze(catalogue.map(row=>row.reviewRoute)),
  destinations:linkablePathsFor(ctx,visibleModuleCodes(ctx)??undefined)});
};

const TOPIC_NOT_PERMITTED='This topic is not available to this person here. Do not call it again; say so in one line and give the next step in the product.';
/** Spec v23 (coordinator decision, 4 November 2026): the topic tools, each bound when the caller is permitted at least one
 * of its topics. `permitted` is terasCapabilitiesFor(ctx): every capability whose own gate (administrator, payroll or team
 * access, module, worker switch) admits this caller now. A topic runs exactly its capability, with only the inputs its
 * read declares, checked against that read's own schema; its result is disclosed under that read's entity (entityOf). A
 * topic the caller is not permitted is refused not_permitted before any runner. */
export function topicBindings(ctx:SessionContext,permitted:readonly TerasCapability[],scope:ToolScope):ToolBinding[]{
 return TOPIC_TOOLS.flatMap((tool):ToolBinding[]=>{
  const runners=new Map(permitted.flatMap(capability=>{const folded=FOLDED_READS.get(capability.name);return folded&&folded.tool===tool.name?[[folded.topic,capability] as const]:[];}));
  if(!runners.size)return [];
  return [{name:tool.name,kind:'read',entity:null,spec:topicToolSpec(tool.name)!,identifierInputs:[],
   entityOf:input=>topicRead(tool.name,input.topic)?.entity??null,
   async run(input){
    const read=topicRead(tool.name,input.topic),capability=runners.get(String(input.topic));
    if(!read)return{ok:false,refusal:'invalid_input',content:{ok:false,refusal:'invalid_input',message:'Name one of the listed topics.'}};
    if(!capability)return{ok:false,refusal:'not_permitted',content:{ok:false,refusal:'not_permitted',message:TOPIC_NOT_PERMITTED}};
    // Only the inputs this topic's read declares reach its runner, each checked against that read's own schema.
    const own:Record<string,unknown>=Object.fromEntries(read.input.filter(row=>input[row.name]!==undefined).map(row=>[row.name,input[row.name]]));
    const problem=invalidInput(readInputSchema(read) as unknown as Record<string,unknown>,own);
    if(problem)return{ok:false,refusal:'invalid_input',content:{ok:false,refusal:'invalid_input',message:'Invalid arguments for '+String(input.topic)+': '+problem+'.'}};
    const outcome=await capability.run(ctx,own,scope);
    return outcome.ok?{ok:true,content:outcome}:{ok:false,content:outcome,refusal:outcome.refusal};}}];
 });
}

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
