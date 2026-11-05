/** Today (AI v2 Phase 1, W3): every fact the home screen shows, read from its existing owner as the viewer.
 *
 * Nothing here computes a business figure, decides anything or writes anything. Each owner read runs under the
 * caller's session and row-level security; a source that fails is left out and the section says one sentence
 * about it, so one slow or broken owner never takes the page with it. Sections call these inside their own
 * Suspense boundary (components/today/sections.tsx).
 *
 * Sources, by section:
 *  - Needs you: the approvals queue (core/approvals-inbox.ts listPendingTasks, the bell's list); the review
 *    custody of the three governed leave proposals waiting for the caller's own Confirm (own leave application,
 *    own leave cancellation, assigned leave decision); for administrators, prepared fixes awaiting approval
 *    (core/agent-actions.ts), records missing data (core/record-readiness.ts) and setup stages from today's
 *    prepared digest (core/digest/daily-digest.ts; a view never recomputes them, review H4); and the cards the loops
 *    prepared (core/loops/cards.ts, AI v2 W8): the person's own, and for administrators those of their companies.
 *    For anyone holding the letters `generate` capability, employees' letter requests waiting for HR
 *    (core/letter-requests.ts countWaitingLetterRequests; AI v2 Phase 1 slice 3).
 *  - Done for you: outcome records (core/outcome-record/summary.ts), counts only.
 *  - Watching, administrators: CP22/CP22A deadlines (core/reporting.ts complianceWorklist) and open payroll
 *    exceptions (core/payroll-anomaly.ts, the same read and counts as Operations › Exceptions). Passport expiries are
 *    shown once, as the passports loop's own card in Needs you (AI Centre restructure, Today fix b), not here again with
 *    a second window.
 *  - At a glance, everyone else: own leave balances (core/employee-home-time-off.ts), the latest released
 *    payslip's metadata (core/employee-home.ts readEmployeeHomePayHints, no amounts) and a manager's absence
 *    from the Home team calendar (lib/today/coming-up.ts). */
import {withTenant,type SessionContext} from '@/db/client';
import {EntitlementsResolutionFailedError,isModuleEnabled} from '@/core/entitlements';
import {listPendingTasks,pendingTaskSummary,type PendingTaskItem} from '@/core/approvals-inbox';
import {listOwnLeaveReviewsTx,reopenOwnLeaveReviewTx} from '@/core/assistant-actions/own-leave-store';
import {leaveCancellationReviews} from '@/core/assistant-actions/leave-change-review-store';
import {listLeaveDecisionReviews,reopenLeaveDecisionReview} from '@/core/assistant-actions/leave-decision-review-store';
import {OwnLeavePreparedReview} from '@/lib/assistant-actions/own-leave-contract';
import {LeaveCancellationPreparedReview} from '@/lib/assistant-actions/own-leave-change-contract';
import {LeaveDecisionPreparedReview} from '@/lib/assistant-actions/leave-decision-review-contract';
import {proposeActions} from '@/core/agent-actions';
import {recordReadiness} from '@/core/record-readiness';
import {DIGEST_PAGES,latestDailyDigest} from '@/core/digest/daily-digest';
import {workerRunGate} from '@/core/agent-registry/controls';
import {RECOMMENDER_WORKER} from '@/core/recommenders/leave-decision';
import {summariseOutcomeRecords,type OutcomeSummary} from '@/core/outcome-record/summary';
import {complianceWorklist} from '@/core/reporting';
import {openExceptionsAcrossRuns} from '@/core/payroll-anomaly';
import {readEmployeeHomeTimeOff} from '@/core/employee-home-time-off';
import {HomeAccessError,readEmployeeHomePayHints} from '@/core/employee-home';
import {readHomeTeamCalendar} from '@/core/employee-home-sharing';
import {reportingLinesFor} from '@/core/read';
import {readLoopCards,type LoopCard} from '@/core/loops/cards';
import {addHrDays,windowStart,type TodayAudience} from '@/lib/today/audience';
import {managerAbsences,type AwayRange} from '@/lib/today/coming-up';
import {countWaitingLetterRequests} from '@/core/letter-requests';

type Settled<T>={ok:true;value:T}|{ok:false;error:unknown};
async function settle<T>(read:()=>Promise<T>):Promise<Settled<T>>{try{return{ok:true,value:await read()};}catch(error){return{ok:false,error};}}
/** The person has no own employment to show (none, or several and none chosen yet): not a failure. */
const noOwnSubject=(result:Settled<unknown>|null)=>result!==null&&!result.ok&&result.error instanceof HomeAccessError;

/** A module this section depends on, read with the throwing check (test/module-catalog-drift.test.ts keeps the quiet
 * readers to pages in app/). An entitlement snapshot that could not be resolved is an incident, not a plan change: the
 * module counts as off for this view and the section reports a failed read, so it shows its failure note rather than
 * reading as "not on your plan". Any other throw is a wiring bug and still throws. */
type ModuleChecks=Readonly<{on:(code:string)=>boolean;failed:()=>boolean}>;
function moduleChecks(s:SessionContext):ModuleChecks{
 let failed=false;
 return {on:code=>{try{return isModuleEnabled(s,code);}catch(error){if(error instanceof EntitlementsResolutionFailedError){failed=true;return false;}throw error;}},failed:()=>failed};
}
const inboxModules=(m:ModuleChecks)=>({attendance:m.on('attendance'),claims:m.on('claims'),performance:m.on('performance'),rewards:m.on('rewards')});

// ── Needs you ───────────────────────────────────────────────────────────────────────────────────────────────
export type PreparedKind='leaveApply'|'leaveCancel'|'leaveDecision';
/** What the prepared change is about, from the owner's own reopen of the caller's review (the read its review page
 * makes, with every current check): the leave type, dates and days the leave service counted, and the duration. */
export type PreparedLeave=Readonly<{leaveType:string;startDate:string;endDate:string;days:number;durationType:string|null}>;
export type PreparedItem=Readonly<{kind:PreparedKind;actionId:string;createdAt:string;expiresAt:string;href:string;leave?:PreparedLeave|null}>;
export type Finding=Readonly<{key:'setup'|'readiness'|'proposals'|'letterRequests';count:number;href:string}>;
export type NeedsYouData=Readonly<{tasks:readonly PendingTaskItem[];taskTotal?:number;recommender:boolean;prepared:readonly PreparedItem[];findings:readonly Finding[];
 /** AI v2 W8: the loops' open cards for this viewer. */
 loops:readonly LoopCard[];
 /** AI v2 W8: a probation review already waiting on this viewer as an approvals task is shown once, as that task; the
  * loop's context for it, by `${kind}:${id}` of the task. */
 taskLoops:Readonly<Record<string,TaskLoopContext>>;
 failed:boolean}>;
export type TaskLoopContext=Readonly<{loop:'loop_probation_ending';endDate:string;overdue:boolean}>;
const REVIEW_TASKS:ReadonlySet<string>=new Set(['hrReview','managerReview']);
/** The loop cards, less any probation card whose review is already one of the viewer's tasks, with that task's context. */
export function mergeReviewLoops(tasks:readonly PendingTaskItem[],loops:readonly LoopCard[]):Readonly<{loops:readonly LoopCard[];taskLoops:Readonly<Record<string,TaskLoopContext>>}>{
 const waiting=new Map(tasks.filter(task=>REVIEW_TASKS.has(task.kind)).map(task=>[task.id,task]));
 const taskLoops:Record<string,TaskLoopContext>={};
 const kept=loops.filter(card=>{
  const task=card.kind==='probation'&&card.reviewId?waiting.get(card.reviewId):undefined;
  if(!task||card.kind!=='probation')return true;
  taskLoops[`${task.kind}:${task.id}`]=Object.freeze({loop:'loop_probation_ending' as const,endDate:card.endDate,overdue:card.overdue});
  return false;
 });
 return Object.freeze({loops:Object.freeze(kept),taskLoops:Object.freeze(taskLoops)});
}

/** The review page of each governed proposal, as its preparer names it (core/proposals/*.ts and the semantic
 * model's reviewRoute). The cancellation review resumes in the leave page's change flow. */
export const PREPARED_HREF:Readonly<Record<PreparedKind,(actionId:string)=>string>>={
 leaveApply:id=>`/assistant/leave?review=${encodeURIComponent(id)}`,
 leaveCancel:id=>`/assistant/leave?${new URLSearchParams({flow:'change',action:'leave.cancel',review:id})}`,
 leaveDecision:id=>`/assistant/approvals?review=${encodeURIComponent(id)}`,
};

type IndexRow=Readonly<{actionId:string;state:string;createdAt:string;expiresAt:string}>;
/** Only reviews still waiting for the caller's Confirm and not yet expired. A custody index the caller cannot
 * read (no AI principal, a paused Assistant) is simply empty: there is nothing of theirs to confirm there. */
function awaiting(kind:PreparedKind,rows:readonly IndexRow[]|undefined,now:number):PreparedItem[]{
 return (rows??[]).filter(row=>row.state==='awaiting_confirmation'&&Date.parse(row.expiresAt)>now)
  .map(row=>Object.freeze({kind,actionId:row.actionId,createdAt:row.createdAt,expiresAt:row.expiresAt,href:PREPARED_HREF[kind](row.actionId)}));
}

/** At most this many prepared cards are reopened for their details on one view; any further card keeps its generic
 * title. Each reopen repeats its owner's full current checks, so it is not free. */
export const PREPARED_DETAIL_LIMIT=5;
const preparedBody=(result:unknown):unknown=>result&&typeof result==='object'&&(result as {kind?:unknown}).kind==='prepared'?(result as {review?:unknown}).review:null;
const leaveFacts=(leaveType:string,startDate:string,endDate:string,days:number,durationType:string|null):PreparedLeave|null=>
 Number.isFinite(days)&&days>0&&leaveType.trim()?Object.freeze({leaveType,startDate,endDate,days,durationType}):null;
/** The caller's own prepared review, reopened by its owner as the caller. Anything the owner refuses (changed since,
 * paused, no longer assigned) or fails on leaves the card with its generic title, never a guessed one. */
async function preparedLeave(s:SessionContext,item:PreparedItem,locale:string):Promise<PreparedLeave|null>{
 try{
  if(item.kind==='leaveApply'){
   const review=OwnLeavePreparedReview.safeParse(preparedBody(await withTenant(s,tx=>reopenOwnLeaveReviewTx(tx,s,item.actionId,locale))));
   return review.success?leaveFacts(review.data.leaveTypeName,review.data.date,review.data.date,review.data.deductionDays,review.data.durationType):null;
  }
  if(item.kind==='leaveCancel'){
   const review=LeaveCancellationPreparedReview.safeParse(preparedBody(await leaveCancellationReviews.reopen(s,item.actionId)));
   return review.success?leaveFacts(review.data.review.leaveTypeName,review.data.review.startDate,review.data.review.endDate,review.data.review.days,null):null;
  }
  const review=LeaveDecisionPreparedReview.safeParse(preparedBody(await reopenLeaveDecisionReview(s,item.actionId)));
  return review.success?leaveFacts(review.data.review.leaveTypeName,review.data.review.startDate,review.data.review.endDate,Number(review.data.review.days),review.data.review.durationType):null;
 }catch{return null;}
}

export async function readNeedsYou(s:SessionContext,p:Readonly<{scopeIds:readonly string[];audience:TodayAudience;today:string;locale?:string;now?:number;all?:boolean}>):Promise<NeedsYouData>{
 const modules=moduleChecks(s),now=p.now??Date.now(),admin=p.audience.layout==='administrator',payroll=modules.on('payroll'),leave=modules.on('leave');
 const [tasks,ownLeave,cancellations,decisions,proposals,readiness,digest,loops,letterRequests]=await Promise.all([
  // Home only renders five decisions. Keep its exact count without transporting every Claim.
  // The existing explicit All view retains its complete-queue contract.
  settle(()=>p.all?listPendingTasks(s,[...p.scopeIds],inboxModules(modules)).then(items=>({items,total:items.length})):pendingTaskSummary(s,[...p.scopeIds],inboxModules(modules))),
  leave?settle(()=>withTenant(s,tx=>listOwnLeaveReviewsTx(tx,s))):null,
  leave?settle(()=>leaveCancellationReviews.list(s)):null,
  leave?settle(()=>listLeaveDecisionReviews(s)):null,
  admin&&payroll?settle(()=>proposeActions(s)):null,
  admin?settle(()=>recordReadiness(s,{peopleLimit:0})):null,
  admin?settle(()=>latestDailyDigest(s)):null,
  settle(()=>readLoopCards(s,{scopeIds:p.scopeIds,admin})),
  // Letter requests count only in companies where the viewer holds `generate` (the owner's own filter), any layout.
  settle(()=>countWaitingLetterRequests(s,p.scopeIds)),
 ]);
 const list=tasks.ok?tasks.value.items:[];
 // The recommendation is offered only while its worker may run, read through the gate the recommender checks.
 const recommender=list.some(task=>task.kind==='leave')?await workerRunGate(s,RECOMMENDER_WORKER).then(gate=>gate.run).catch(()=>false):false;
 const prepared=[
  ...awaiting('leaveApply',ownLeave?.ok?ownLeave.value.reviews:undefined,now),
  ...awaiting('leaveCancel',cancellations?.ok?cancellations.value.reviews:undefined,now),
  ...awaiting('leaveDecision',decisions?.ok?decisions.value.reviews:undefined,now),
 ].sort((a,b)=>a.expiresAt.localeCompare(b.expiresAt)||a.actionId.localeCompare(b.actionId));
 const detailed=await Promise.all(prepared.map(async(item,index)=>index<PREPARED_DETAIL_LIMIT?Object.freeze({...item,leave:await preparedLeave(s,item,p.locale??'en')}):item));
 const findings:Finding[]=[];
 if(digest?.ok&&digest.value&&digest.value.digest.asOf===p.today&&digest.value.digest.setup){
  const setup=digest.value.digest.setup,count=setup.blocked+setup.attention;
  if(count>0)findings.push(Object.freeze({key:'setup',count,href:DIGEST_PAGES.setup}));
 }
 const missing=readiness?.ok?readiness.value.employees-readiness.value.ready:0;
 if(missing>0)findings.push(Object.freeze({key:'readiness',count:missing,href:'/control-tower/readiness'}));
 const fixes=proposals?.ok?proposals.value.reduce((sum,proposal)=>sum+proposal.count,0):0;
 // Exceptions' "cause already fixed" group, where the former Proposed actions are approved (AI Centre restructure).
 if(fixes>0)findings.push(Object.freeze({key:'proposals',count:fixes,href:'/control-tower/exceptions#fixed-causes'}));
 const waitingLetters=letterRequests.ok?letterRequests.value:0;
 if(waitingLetters>0)findings.push(Object.freeze({key:'letterRequests',count:waitingLetters,href:'/letters/generate?requests=all#letter-requests'}));
 const failed=modules.failed()||!tasks.ok||!loops.ok||[proposals,readiness,letterRequests].some(result=>result!==null&&!result.ok);
 const merged=mergeReviewLoops(list,loops.ok?loops.value:[]);
 return Object.freeze({tasks:list,taskTotal:tasks.ok?tasks.value.total:0,recommender,prepared:detailed,findings,loops:merged.loops,taskLoops:merged.taskLoops,failed});
}

// ── Done for you ────────────────────────────────────────────────────────────────────────────────────────────
export async function readDoneForYou(s:SessionContext,p:Readonly<{scopeIds:readonly string[];today:string}>):Promise<Settled<OutcomeSummary>>{
 return settle(()=>summariseOutcomeRecords(s,{since:windowStart(p.today),companyIds:p.scopeIds}));
}

// ── Watching (administrators) ───────────────────────────────────────────────────────────────────────────────
/** At most this many companies in scope are checked for deadlines on one view, four at a time, as the daily
 * digest does (DIGEST_COMPANY_LIMIT): each check reads that company's employments. */
export const WATCH_COMPANY_LIMIT=20;
const COMPANY_CONCURRENCY=4;
export type WatchingData=Readonly<{
 deadlines:Readonly<{overdue:number;dueSoon:number;checked:number;inScope:number}>|null;
 exceptions:Readonly<{total:number;blocking:number}>|null;
 failed:boolean;
}>;

export async function readWatching(s:SessionContext,p:Readonly<{scopeIds:readonly string[];today:string}>):Promise<WatchingData>{
 const modules=moduleChecks(s),payroll=modules.on('payroll'),companies=p.scopeIds.slice(0,WATCH_COMPANY_LIMIT);
 const deadlineRead=payroll?settle(async()=>{
  const lists:Awaited<ReturnType<typeof complianceWorklist>>[]=[];
  for(let i=0;i<companies.length;i+=COMPANY_CONCURRENCY)
   lists.push(...await Promise.all(companies.slice(i,i+COMPANY_CONCURRENCY).map(companyId=>complianceWorklist(s,{companyId,today:p.today}))));
  const items=lists.flat();
  return {overdue:items.filter(item=>item.status==='overdue').length,dueSoon:items.filter(item=>item.status==='due_soon').length,checked:companies.length,inScope:p.scopeIds.length};
 }):null;
 const [deadlines,exceptions]=await Promise.all([
  deadlineRead,
  // Today fix d: the same read, with the same arguments, as Operations › Exceptions, so its counts are that page's.
  payroll?settle(()=>openExceptionsAcrossRuns(s)):null,
 ]);
 return Object.freeze({
  deadlines:deadlines?.ok&&deadlines.value.overdue+deadlines.value.dueSoon>0?Object.freeze(deadlines.value):null,
  exceptions:exceptions?.ok&&exceptions.value.total>0?Object.freeze({total:exceptions.value.total,blocking:exceptions.value.blocking}):null,
  failed:modules.failed()||[deadlines,exceptions].some(result=>result!==null&&!result.ok),
 });
}

// ── At a glance (personal) ──────────────────────────────────────────────────────────────────────────────────
/** The Home team calendar's look-ahead for "Coming up": today and the next 13 days. */
export const COMING_UP_DAYS=14;
export type GlanceData=Readonly<{
 balances:readonly Readonly<{id:string;name:string;available:number|null}>[]|null;
 payslip:Readonly<{id:string;period:string}>|null|undefined;
 away:readonly AwayRange[]|null;
 failed:boolean;
}>;

export async function readAtAGlance(s:SessionContext,p:Readonly<{employmentId?:string;locale:string;today:string}>):Promise<GlanceData>{
 const modules=moduleChecks(s),payroll=modules.on('payroll');
 const [timeOff,pay]=await Promise.all([
  settle(()=>readEmployeeHomeTimeOff(s,p.employmentId,p.locale)),
  payroll?settle(()=>readEmployeeHomePayHints(s,p.employmentId)):null,
 ]);
 const subject=timeOff.ok?timeOff.value.employmentId:pay?.ok?pay.value.employmentId:null;
 const away=subject?await settle(async()=>{
  const [lines,calendar]=await Promise.all([reportingLinesFor(s,subject),readHomeTeamCalendar(s,subject,p.today,addHrDays(p.today,COMING_UP_DAYS-1))]);
  return managerAbsences(lines.managers.map(line=>line.employmentId),calendar.days);
 }):null;
 const latest=pay?.ok?pay.value.payslips[0]:undefined;
 return Object.freeze({
  balances:timeOff.ok?timeOff.value.balances.map(row=>Object.freeze({id:row.id,name:row.name,available:row.available})):null,
  // undefined: payroll is not in use, so no payslip line at all; null: none released yet.
  payslip:pay===null?undefined:pay.ok?(latest?Object.freeze({id:latest.id,period:latest.period}):null):undefined,
  away:away?.ok?away.value:null,
  failed:modules.failed()||(!timeOff.ok&&!noOwnSubject(timeOff))||(pay!==null&&!pay.ok&&!noOwnSubject(pay))||(away!==null&&!away.ok),
 });
}
