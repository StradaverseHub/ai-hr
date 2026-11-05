/** AI v2 Phase 2, P2-3 — "Before payroll": the person's own pending items for this month's pay, and the decisions
 * waiting on them as an approver, read AS THE PERSON from the native owners (owner decisions 7 and 8, 3 November 2026).
 *
 * WHAT IT READS, AND FROM WHOM. Every read runs under the caller's own session and row-level security, through the
 * owner's facade, for the caller's own selected employment (core/employee-home.ts requireOwnHomeSubject: a role,
 * company filter or posted id never widens it). Nothing is computed that an owner already decides:
 *  - the pay period and cut-off: the payroll owner's cutOffWindowFor over the cut-off day of the person's own
 *    employment's company, chosen exactly as the payroll inputs loop chooses it (core/loops/payroll-inputs.ts). Company
 *    payroll settings stay readable only by administrators (migration 0081); the days themselves are read through
 *    app.own_payroll_cut_off_day (migration 2008), which answers for the caller's own current employment only and
 *    returns nothing else. With no answer (no own employment) no date is shown and the calendar month is used. Phase 2
 *    hardening: EACH INPUT TYPE USES ITS OWN CUT-OFF (core/loops/payroll-inputs.ts preSalaryWindows, the payroll owner's
 *    per-type resolution for the same pay period): attendance items run to the attendance cut-off and are due then,
 *    overtime to the overtime cut-off, claims to the claim cut-off, leave to the unpaid-leave cut-off; everything else
 *    (details, acknowledgements, approvals) is due by the salary cut-off;
 *  - attendance: the attendance owner's days (attendanceForEmploymentRange) classified by the Attendance Request
 *    screen's own pure classifier (classifyDay), with that screen's rules: yesterday at the latest, and nobody is
 *    flagged when no day is on clocking; the person's own pending requests (myAttendanceCorrections, myOvertimePlans);
 *    the monthly overtime cap (otMonthToDateMinutes, minutes only); the missed clock-out loop's open card
 *    (core/loops/cards.ts), whose Confirm is the existing one-tap card;
 *  - leave: the person's own requests (core/read.ts leaveRequestsFor) and their types' paid and document rules
 *    (listEligibleLeaveTypesFor);
 *  - claims: the person's own claims (listClaimsForEmployment) and their types' receipt rule and receipt-age window
 *    (getEmployeeClaimTypes). Amounts, limits and balances are read by those owners but never copied here;
 *  - TOIL: the person's own Leave Credit requests (listReplacementLeaveRequests);
 *  - personal and statutory details: the readiness owner's own-scope gaps (myReadinessActions); the TP3 owner's
 *    new-joiner eligibility and history (myTp3Employments, myTp3History, lib/my-tp3-eligibility.ts); the person's own
 *    TP1 tax-relief declarations this year, a draft not sent or a sent one not yet approved (listMyTp1Declarations); and
 *    the children declared for tax relief against the Family register's own eligible count (core/profile.ts myProfile
 *    numChildren, core/dependents.ts listDependents and eligibleChildReliefCount, the head-count comparison the child
 *    relief review makes, core/child-relief-review.ts childReliefRecordDisagreement);
 *  - to acknowledge: the person's own letters (listMyLetters), notices (pendingNoticeAcknowledgementTasks) and released
 *    performance reviews waiting for their acknowledgement (myReviews, the canAcknowledge rule of reviewForViewer), and
 *    an onboarding hand-over waiting for their acknowledgement (onboardingMyAcknowledgements: handed over, not yet
 *    acknowledged);
 *  - approvals: the approvals owner's own list of what waits on the caller (core/approvals-inbox.ts listPendingTasks),
 *    which proves actual decision assignment and excludes the caller's own requests.
 * Not covered, because no owner records it (each checked against the code, P2-3 review round):
 *  - shift swaps: no swap request exists; roster gaps: the roster owner draws `off` and `none` alike as "no shift is
 *    scheduled" (lib/roster-month.ts ResolvedCell), so a gap cannot be told from a day off;
 *  - timesheet sign-off: no timesheet exists (core/toil.ts: "no attendance, timesheet or overtime validation");
 *  - overtime worked but not applied for: overtime is derived from the clockings (core/attendance.ts recomputeDayFromPunches)
 *    and a day with no request reads `notRequired` (packs/attendance/overtime-input.ts approvalStatus); the policy
 *    engine's approvalReceiptRequired is a proposal-only state (packs/attendance/policy-execution-proposal.ts);
 *  - a TOIL consent step after submission: consent is ticked at submission (core/replacement-request.ts);
 *  - pay changes to acknowledge: no employee acknowledgement of a pay change exists (core/comp.ts and core/movement.ts
 *    "acknowledged" are HR's closed-payroll confirmations).
 *
 * NO PAY FIGURE. No amount, rate, balance, limit or salary is copied into an item; minutes and days are not copied
 * either. One owner that fails is reported as that group's "could not check", never as done. Never writes. */
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../../db/client';
import {EntitlementsResolutionFailedError,isModuleEnabled} from '../entitlements';
import {HomeAccessError,requireOwnHomeSubject} from '../employee-home';
import {leaveRequestsFor,listEligibleLeaveTypesFor} from '../read';
import {attendanceForEmploymentRange,classifyDay,myAttendanceCorrections,myOvertimePlans,otMonthToDateMinutes} from '../../packs/attendance/service';
import {listReplacementLeaveRequests} from '../../packs/leave/service';
import {getEmployeeClaimTypes,listClaimsForEmployment} from '../../packs/claims/service';
import {listMyTp1Declarations,myTp3Employments,myTp3History} from '../../packs/payroll/service';
import {myReadinessActions} from '../readiness-actions';
import {myProfile} from '../profile';
import {eligibleChildReliefCount,listDependents} from '../dependents';
import {myReviews} from '../../packs/performance/service';
import {onboardingMyAcknowledgements} from '../../packs/lifecycle/service';
import {listMyLetters} from '../letters';
import {pendingNoticeAcknowledgementTasks} from '../notice';
import {listPendingTasks,pendingTaskSummary,type PendingTaskItem} from '../approvals-inbox';
import {readLoopCards} from '../loops/cards';
import {myTp3Eligibility} from '../../lib/my-tp3-eligibility';
import {myTp3PreviousEmployerAnswer} from './tp3-answer';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {addHrDays} from '../../lib/today/audience';
import {PAYROLL_ITEM_GROUPS,groupStatus,monthEnd,orderItems,periodOf,type GroupState,type PayrollItem,type PayrollItemGroup,
 type PayrollItemKind,type PayrollItemState,type PayrollPeriod,type PayrollReadiness,type PayrollTypeWindows,type TypeWindow} from '../../lib/pre-salary/items';
import {upcomingPeriod,type CompanyCutOffs} from '../loops/payroll-inputs';

/** A draft claim whose receipt-age window closes within this many days is "near its deadline". */
export const CLAIM_DEADLINE_LEAD_DAYS=7;
/** At most this many letters are read (the owner's own page ceiling). */
const LETTER_LIMIT=100;

type Read<T>=Readonly<{ok:true;value:T}>|Readonly<{ok:false}>;
async function settle<T>(read:()=>Promise<T>):Promise<Read<T>>{try{return{ok:true,value:await read()};}catch{return{ok:false};}}
/** Throwing module check (core/ code never uses the quiet reader, test/module-catalog-drift.test.ts); an entitlement
 * snapshot that cannot be resolved counts as "could not check", never as "not in use". */
function moduleState(ctx:SessionContext,code:string,companyId?:string|null):'on'|'off'|'failed'{
 try{return isModuleEnabled(ctx,code,companyId)?'on':'off';}catch(error){if(error instanceof EntitlementsResolutionFailedError)return 'failed';throw error;}
}
const isDate=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value);
const day=(value:unknown):string|null=>value instanceof Date?todayInKualaLumpur(value):isDate(value)?value:typeof value==='string'&&isDate(value.slice(0,10))?value.slice(0,10):null;
const min=(a:string|null,b:string|null)=>a===null?b:b===null?a:a<b?a:b;
const item=(p:{key:string;group:PayrollItemGroup;kind:PayrollItemKind;state:PayrollItemState;date?:string|null;endDate?:string|null;due:string|null;label?:string|null;count?:number;href:string}):PayrollItem=>
 Object.freeze({key:p.key,group:p.group,kind:p.kind,state:p.state,date:p.date??null,...(p.endDate!==undefined?{endDate:p.endDate}:{}),due:p.due,
  ...(p.label!==undefined?{label:p.label}:{}),...(p.count!==undefined?{count:p.count}:{}),action:Object.freeze({kind:'open' as const,href:p.href})});

/** The pay period whose inputs are still open today, its salary cut-off and each input type's own window, as the payroll
 * owner resolves them for the company of the caller's own current employment. The cut-off days come from
 * app.own_payroll_cut_off_day (migration 2008), which returns a row only for the caller's own current employment and only
 * that company's cut-off days; no row (another person's employment, none at all): the calendar month, no cut-off date
 * (source `unavailable`). The period is chosen exactly as the Pre-salary loop chooses it (upcomingPeriod). */
export async function resolvePayrollPeriod(ctx:SessionContext,employmentId:string|null,today:string):Promise<PayrollPeriod>{
 return (await resolvePeriodAndWindows(ctx,employmentId,today)).period;
}

type PeriodAndWindows=Readonly<{period:PayrollPeriod;windows:PayrollTypeWindows|null}>;
/** The period, and each input type's own window for it (null when no cut-off is known: the calendar month is used). */
async function resolvePeriodAndWindows(ctx:SessionContext,employmentId:string|null,today:string):Promise<PeriodAndWindows>{
 const calendar=():PeriodAndWindows=>Object.freeze({period:Object.freeze({payPeriod:periodOf(today),start:`${periodOf(today)}-01`,cutOff:null,source:'unavailable' as const}),windows:null});
 if(!employmentId)return calendar();
 const rows=await withTenant(ctx,tx=>tx.execute(sql`SELECT cut_off_day,attendance_cut_off_day,overtime_cut_off_day,claim_cut_off_day,unpaid_leave_cut_off_day
  FROM app.own_payroll_cut_off_day(${employmentId}::uuid)`)) as unknown as {cut_off_day:number|null;attendance_cut_off_day:number|null;
  overtime_cut_off_day:number|null;claim_cut_off_day:number|null;unpaid_leave_cut_off_day:number|null}[];
 if(!rows.length)return calendar();
 const row=rows[0];
 const company:CompanyCutOffs={cutOffDay:row.cut_off_day??null,attendanceCutOffDay:row.attendance_cut_off_day??null,overtimeCutOffDay:row.overtime_cut_off_day??null,
  claimCutOffDay:row.claim_cut_off_day??null,unpaidLeaveCutOffDay:row.unpaid_leave_cut_off_day??null,payDay:null};
 const {period:payPeriod,windows}=upcomingPeriod(company,today);
 return Object.freeze({period:Object.freeze({payPeriod,start:windows.salary.start,cutOff:windows.salary.end,source:company.cutOffDay!=null?'company' as const:'month_end' as const}),
  windows:Object.freeze({attendance:windows.attendance,overtime:windows.overtime,claim:windows.claim,leave:windows.leave})});
}

/** The per-type windows of a resolved period, keyed by the period object (kept out of its public shape). */
const windowsOf=new WeakMap<PayrollPeriod,PayrollTypeWindows>();
/** One input type's window and due date for the period: its own window where the cut-off is known, otherwise the salary
 * period with no due date (unchanged from before). */
const typeWindow=(period:PayrollPeriod,type:'attendance'|'overtime'|'claim'|'leave'):Readonly<{window:TypeWindow;due:string|null}>=>{
 const own=windowsOf.get(period)?.[type];
 return own?{window:own,due:own.end}:{window:{start:period.start,end:period.cutOff??monthEnd(period.payPeriod)},due:period.cutOff};
};

type Subject=Readonly<{employmentId:string;companyId:string|null}>;
type GroupRead=Readonly<{items:readonly PayrollItem[];read:'ok'|'failed'|'off';total?:number;claimTotal?:number}>;
const off:GroupRead=Object.freeze({items:[],read:'off'});
const failed:GroupRead=Object.freeze({items:[],read:'failed'});

async function attendanceGroups(ctx:SessionContext,subject:Subject,period:PayrollPeriod,today:string):Promise<Readonly<{attendance:GroupRead;overtime:GroupRead}>>{
 const state=moduleState(ctx,'attendance',subject.companyId);
 if(state!=='on')return {attendance:state==='off'?off:failed,overtime:state==='off'?off:failed};
 // Attendance runs to the attendance cut-off, overtime to the overtime cut-off: each item is due by its own.
 const att=typeWindow(period,'attendance'),ot=typeWindow(period,'overtime');
 const start=att.window.start,end=att.window.end,to=min(end,addHrDays(today,-1))!,due=att.due;
 const [days,requests,overtime,cap,loops]=await Promise.all([
  to>=start?settle(()=>attendanceForEmploymentRange(ctx,subject.employmentId,start,to)):Promise.resolve<Read<Awaited<ReturnType<typeof attendanceForEmploymentRange>>>>({ok:true,value:[]}),
  settle(()=>myAttendanceCorrections(ctx,subject.employmentId,{status:'pending',limit:200})),
  settle(()=>myOvertimePlans(ctx,subject.employmentId,{status:'pending',from:ot.window.start,limit:200})),
  settle(()=>otMonthToDateMinutes(ctx,subject.employmentId,min(ot.window.end,today)!)),
  settle(()=>readLoopCards(ctx,{scopeIds:[],admin:false})),
 ]);
 const attendance:PayrollItem[]=[],overtimeItems:PayrollItem[]=[];
 const waitingDays=new Set<string>();
 if(requests.ok)for(const row of requests.value){
  if(row.requestKind==='self_overtime'||row.attendanceDate<start||row.attendanceDate>end)continue;
  waitingDays.add(row.attendanceDate);
  attendance.push(item({key:`attendance_request_pending:${row.id}`,group:'attendance',kind:'attendance_request_pending',state:'waiting',date:row.attendanceDate,due,href:'/attendance/request-status'}));
 }
 // The missed clock-out loop's own open card for a day: its Confirm is the one-tap action (core/loops/clock-out-confirm.ts).
 const clockOut=new Map((loops.ok?loops.value:[]).flatMap(card=>card.kind==='clockOut'?[[card.date,card] as const]:[]));
 if(days.ok){
  // The Attendance Request screen's rule: someone not on clocking has no attendance rows, so nothing is flagged.
  const onClocking=days.value.some(row=>row.attendanceId!=null);
  for(const row of onClocking?days.value:[]){
   const flagged=classifyDay(row);
   if(!flagged||waitingDays.has(flagged.date))continue;
   const fix=(section:string)=>`/attendance/requests?${new URLSearchParams({section,fix:flagged.date})}`;
   if(flagged.section==='incomplete'){
    const kind=flagged.missing==='in'?'missed_clock_in' as const:'missed_clock_out' as const,card=kind==='missed_clock_out'?clockOut.get(flagged.date):undefined;
    attendance.push(card?Object.freeze({key:`${kind}:${flagged.date}`,group:'attendance' as const,kind,state:'todo' as const,date:flagged.date,due,
     action:Object.freeze({kind:'confirm' as const,card:'clockOut' as const,caseId:card.caseId,date:card.date,checkIn:card.checkIn,proposedCheckOut:card.proposedCheckOut,href:card.href})})
     :item({key:`${kind}:${flagged.date}`,group:'attendance',kind,state:'todo',date:flagged.date,due,href:fix('incomplete')}));
   }else if(flagged.section==='absent')attendance.push(item({key:`absent_no_leave:${flagged.date}`,group:'attendance',kind:'absent_no_leave',state:'todo',date:flagged.date,due,href:fix('absent')}));
   // A day the person's schedule group is exempt from absence, late-in and early-out judgments is not a short-day mark
   // (the attendance owner's own exemption, Phase 2 hardening).
   else if(!(row as {exceptionExempt?:boolean}).exceptionExempt)attendance.push(item({key:`late_or_early:${flagged.date}`,group:'attendance',kind:'late_or_early',state:'check',date:flagged.date,due,href:fix('short')}));
  }
 }
 if(overtime.ok)for(const row of overtime.value)if(row.attendanceDate<=ot.window.end)
  overtimeItems.push(item({key:`overtime_pending:${row.id}`,group:'overtime',kind:'overtime_pending',state:'waiting',date:row.attendanceDate,due:ot.due,href:'/attendance/plan-ot'}));
 // The attendance owner's own monthly cap (minutes compared, never shown or copied).
 if(cap.ok&&cap.value.totalMinutes>cap.value.capMinutes)
  overtimeItems.push(item({key:`overtime_over_cap:${periodOf(min(ot.window.end,today)!)}`,group:'overtime',kind:'overtime_over_cap',state:'check',date:null,due:ot.due,href:'/attendance/plan-ot'}));
 return {attendance:{items:attendance,read:days.ok&&requests.ok&&loops.ok?'ok':'failed'},overtime:{items:overtimeItems,read:overtime.ok&&cap.ok?'ok':'failed'}};
}

async function leaveGroup(ctx:SessionContext,subject:Subject,period:PayrollPeriod,locale:string):Promise<GroupRead>{
 const state=moduleState(ctx,'leave',subject.companyId);
 if(state!=='on')return state==='off'?off:failed;
 const [requests,types]=await Promise.all([settle(()=>leaveRequestsFor(ctx,subject.employmentId,locale)),settle(()=>listEligibleLeaveTypesFor(ctx,subject.employmentId,locale))]);
 if(!requests.ok)return failed;
 // Leave runs to the unpaid-leave cut-off and is due by it.
 const own=typeWindow(period,'leave'),end=own.window.end,due=own.due,items:PayrollItem[]=[];
 const typeOf=new Map((types.ok?types.value:[]).map(type=>[type.id,type]));
 for(const row of requests.value){
  const start=day(row.startDate),last=day(row.endDate)??start;
  if(!start||!last||last<own.window.start||start>end||(row.status!=='pending'&&row.status!=='approved'))continue;
  const type=typeOf.get(row.leaveTypeId),label=row.leaveType??null,days=Number(row.days);
  if(row.status==='pending')items.push(item({key:`leave_pending:${row.id}`,group:'leave',kind:'leave_pending',state:'waiting',date:start,endDate:last,due,label,href:'/leave'}));
  if(type&&type.paid===false)items.push(item({key:`leave_unpaid:${row.id}`,group:'leave',kind:'leave_unpaid',state:'check',date:start,endDate:last,due,label,href:'/leave'}));
  // The leave type's own document rule: always, or when the request is longer than its threshold.
  const needsDocument=!!type?.requiresDocument&&(!type.mandatoryAfterDays||(Number.isFinite(days)&&days>Number(type.mandatoryAfterDays)));
  if(needsDocument&&!row.hasDocument)items.push(item({key:`leave_certificate_missing:${row.id}`,group:'leave',kind:'leave_certificate_missing',state:'todo',date:start,endDate:last,due,label,href:'/leave'}));
 }
 return {items,read:types.ok?'ok':'failed'};
}

async function claimsGroup(ctx:SessionContext,subject:Subject,period:PayrollPeriod,today:string):Promise<GroupRead>{
 const state=moduleState(ctx,'claims',subject.companyId);
 if(state!=='on')return state==='off'?off:failed;
 const [claims,types]=await Promise.all([settle(()=>listClaimsForEmployment(ctx,subject.employmentId)),settle(()=>getEmployeeClaimTypes(ctx,subject.employmentId))]);
 if(!claims.ok)return failed;
 // Only the receipt rule and the receipt-age window are taken from each type; limits and balances are left behind.
 const rules=new Map((types.ok?types.value:[]).map(type=>[type.id,{requiresReceipt:type.requiresReceipt,window:type.maxReceiptAgeDays}]));
 // Claims are due by the claim cut-off.
 const claimDue=typeWindow(period,'claim').due;
 const items:PayrollItem[]=[];
 for(const row of claims.value){
  const label=row.typeName??null,incurred=day(row.incurredOn);
  if(row.status==='pending'){items.push(item({key:`claim_pending:${row.id}`,group:'claims',kind:'claim_pending',state:'waiting',date:incurred,due:claimDue,label,href:'/claims'}));continue;}
  if(row.status!=='draft')continue;
  const rule=rules.get(row.claimTypeId);
  // The claims owner refuses a receipt older than the type's window at submit: that day is the draft's own deadline.
  const deadline=incurred&&rule&&Number.isFinite(rule.window)?addHrDays(incurred,rule.window):null;
  if(deadline&&deadline<today)continue;
  const near=deadline!==null&&deadline<=addHrDays(today,CLAIM_DEADLINE_LEAD_DAYS);
  const kind=near?'claim_deadline' as const:rule?.requiresReceipt&&row.attachments.length===0?'claim_receipt_missing' as const:'claim_draft' as const;
  items.push(item({key:`${kind}:${row.id}`,group:'claims',kind,state:'todo',date:incurred,due:min(deadline,claimDue),label,href:`/claims?${new URLSearchParams({draft:row.id})}`}));
 }
 return {items,read:types.ok?'ok':'failed'};
}

async function toilGroup(ctx:SessionContext,subject:Subject,period:PayrollPeriod):Promise<GroupRead>{
 const state=moduleState(ctx,'toil',subject.companyId);
 if(state!=='on')return state==='off'?off:failed;
 const requests=await settle(()=>listReplacementLeaveRequests(ctx,subject.employmentId));
 if(!requests.ok)return failed;
 return {read:'ok',items:requests.value.filter(row=>row.status==='pending').map(row=>{
  const dates=row.dates.map(line=>day(line.workedDate)).filter((value):value is string=>value!==null).sort();
  return item({key:`toil_pending:${row.id}`,group:'toil',kind:'toil_pending',state:'waiting',date:dates[0]??day(row.submittedOn),due:period.cutOff,href:'/leave/credit'});
 })};
}

const GAP_KIND:Readonly<Record<string,PayrollItemKind>>={no_bank_account:'bank_missing',no_tax_number:'tax_number_missing',no_epf_number:'epf_number_missing',no_socso_number:'socso_number_missing',no_identity:'identity_missing'};
async function detailsGroup(ctx:SessionContext,subject:Subject,period:PayrollPeriod,today:string):Promise<GroupRead>{
 const payroll=moduleState(ctx,'payroll',subject.companyId);
 const [gaps,tp3,extra]=await Promise.all([
  settle(()=>myReadinessActions(ctx,subject.employmentId)),
  payroll==='on'?settle(async()=>{const [employments,history,answer]=await Promise.all([myTp3Employments(ctx),myTp3History(ctx),
   myTp3PreviousEmployerAnswer(ctx,Number(today.slice(0,4)))]);return{employments,history,answer};}):Promise.resolve(null),
  payroll==='on'&&ctx.personId?settle(async()=>{const personId=ctx.personId!;
   const [tp1,profile,family]=await Promise.all([listMyTp1Declarations(ctx,{assessmentYear:Number(today.slice(0,4))}),myProfile(ctx),listDependents(ctx,{personId})]);
   return{tp1,profile,family};}):Promise.resolve(null),
 ]);
 const items:PayrollItem[]=[];
 if(gaps.ok){
  const requested=new Set<string>();
  for(const gap of gaps.value){
   const kind=GAP_KIND[gap.gap];
   if(!kind)continue;
   const href=`/me?tab=${gap.tab}#section-request-${gap.tab}`;
   // A correction already sent: HR reviews it (one item per request, however many gaps it answers).
   if(gap.type==='review_submission'){const key=gap.requestId??gap.tab;if(!requested.has(key)){requested.add(key);
    items.push(item({key:`details_request_pending:${key}`,group:'details',kind:'details_request_pending',state:'waiting',due:period.cutOff,href}));}continue;}
   items.push(item({key:`${kind}:${subject.employmentId}`,group:'details',kind,state:'todo',due:period.cutOff,href}));
  }
 }
 if(extra?.ok){
  const year=Number(today.slice(0,4));
  // TP1 for this year: a draft the person has not sent, or a sent one waiting for payroll's approval. No amount.
  for(const row of extra.value.tp1.filter(row=>row.assessmentYear===year)){
   if(row.status==='draft')items.push(item({key:`tp1_draft:${row.id}`,group:'details',kind:'tp1_draft',state:'todo',due:period.cutOff,href:'/me/tax-relief'}));
   else if(row.status==='submitted'&&!row.approvedAt)items.push(item({key:`tp1_pending:${row.id}`,group:'details',kind:'tp1_pending',state:'waiting',due:period.cutOff,href:'/me/tax-relief'}));
  }
  // More children declared for tax relief than the Family register counts as eligible: one of the two is incomplete.
  const declared=Number(extra.value.profile?.statutory?.numChildren??0);
  if(Number.isFinite(declared)&&declared>eligibleChildReliefCount(extra.value.family,new Date(`${today}T00:00:00Z`)))
   items.push(item({key:`dependants_mismatch:${subject.employmentId}`,group:'details',kind:'dependants_mismatch',state:'check',due:period.cutOff,href:'/me?tab=family'}));
 }
 if(tp3?.ok){
  const own=tp3.value.employments.find(row=>row.employmentId===subject.employmentId),eligibility=myTp3Eligibility(own,today);
  const year=eligibility.year,done=year!==null&&(tp3.value.history.records.some(record=>record.assessmentYear===year)||tp3.value.history.drafts.some(draft=>draft.assessmentYear===year&&draft.submittedAt!=null));
  // A new joiner this year who has not told payroll about any earlier employer this year (LHDN TP3). Someone who joined on
  // 1 January had no earlier employer that year, so is never asked. Anyone later is asked once, on this checklist, whether
  // they worked for another employer earlier this year (core/pre-salary/tp3-answer.ts): "No" removes the item (a fresh
  // graduate is not a TP3 case); "Yes" keeps it, with its link to the TP3 form; until they answer, the item is the question.
  const answer=tp3.value.answer;
  if(eligibility.eligible&&year===Number(today.slice(0,4))&&!done&&eligibility.joinDate!==`${year}-01-01`&&answer!=='no'){
   const base={key:`tp3_new_joiner:${year}`,group:'details',kind:'tp3_new_joiner',state:'check',date:eligibility.joinDate,due:period.cutOff,href:'/me/tp3'} as const;
   const row=item(base);
   items.push(answer==='yes'||!own?row:Object.freeze({...row,action:Object.freeze({kind:'answer' as const,card:'tp3PreviousEmployer' as const,employmentId:own.employmentId,year,href:'/me/tp3'})}));
  }
 }
 return {items,read:gaps.ok&&(tp3===null||tp3.ok)&&(extra===null||extra.ok)?'ok':'failed'};
}

async function acknowledgeGroup(ctx:SessionContext,subject:Subject,period:PayrollPeriod):Promise<GroupRead>{
 const performance=moduleState(ctx,'performance',subject.companyId),lifecycle=moduleState(ctx,'lifecycle',subject.companyId);
 const [letters,notices,reviews,onboarding]=await Promise.all([settle(()=>listMyLetters(ctx,{limit:LETTER_LIMIT})),settle(()=>pendingNoticeAcknowledgementTasks(ctx)),
  performance==='on'?settle(()=>myReviews(ctx)):Promise.resolve(null),lifecycle==='on'?settle(()=>onboardingMyAcknowledgements(ctx)):Promise.resolve(null)]);
 const items:PayrollItem[]=[];
 if(letters.ok)for(const row of letters.value.rows)if(row.state==='issued'&&!row.voidedAt&&row.acknowledgement!=='none'&&!row.confirmed)
  items.push(item({key:`letter_acknowledge:${row.id}`,group:'acknowledge',kind:'letter_acknowledge',state:'todo',date:day(row.issuedAt),due:period.cutOff,href:`/me/letters/${encodeURIComponent(row.id)}`}));
 if(notices.ok)for(const row of notices.value)
  items.push(item({key:`notice_acknowledge:${row.noticeId}:${row.employmentId}:${row.contentVersion}`,group:'acknowledge',kind:'notice_acknowledge',state:'todo',date:day(row.sourceUpdatedAt),due:period.cutOff,
   href:`/notices/${encodeURIComponent(row.noticeId)}?${new URLSearchParams({employmentId:row.employmentId})}`}));
 // A released review waiting for the person's acknowledgement (reviewForViewer's canAcknowledge). No rating is copied.
 if(reviews?.ok)for(const row of reviews.value)if(row.status==='submitted'&&row.released)
  items.push(item({key:`review_acknowledge:${row.reviewId}`,group:'acknowledge',kind:'review_acknowledge',state:'todo',date:day(row.periodEnd),due:period.cutOff,href:'/me/performance'}));
 if(onboarding?.ok)for(const row of onboarding.value)if(row.available&&!row.submittedAt)
  items.push(item({key:`onboarding_acknowledge:${row.id}`,group:'acknowledge',kind:'onboarding_acknowledge',state:'todo',date:day(row.joinDate),due:period.cutOff,
   href:`/lifecycle/acknowledgement?${new URLSearchParams({case:row.id})}`}));
 return {items,read:letters.ok&&notices.ok&&(reviews===null||reviews.ok)&&(onboarding===null||onboarding.ok)&&performance!=='failed'&&lifecycle!=='failed'?'ok':'failed'};
}

/** The approvals owner's task kinds that feed pay, and the checklist kind each becomes. */
export const APPROVAL_KIND:Readonly<Partial<Record<PendingTaskItem['kind'],PayrollItemKind>>>=Object.freeze({
 leave:'approve_leave',leaveCancellation:'approve_leave_cancellation',attendance:'approve_attendance',claim:'approve_claim',replacementLeave:'approve_toil'});
function startApprovals(ctx:SessionContext,scopeIds:readonly string[]|undefined,preview=false){
 const modules={attendance:moduleState(ctx,'attendance'),claims:moduleState(ctx,'claims')};
 const modulesRead={attendance:modules.attendance==='on',claims:modules.claims==='on',performance:false,rewards:false};
 const scope=scopeIds?[...scopeIds]:undefined;
 const tasks=settle<{items:readonly PendingTaskItem[];claimTotal:number}>(()=>preview?pendingTaskSummary(ctx,scope,modulesRead,{noticeAcknowledgements:false}):listPendingTasks(ctx,scope,modulesRead,{noticeAcknowledgements:false}).then(items=>({items,claimTotal:items.filter(task=>task.kind==='claim').length})));
 return {modules,tasks,preview};
}
async function approvalsGroup(approvalsRead:ReturnType<typeof startApprovals>,period:PayrollPeriod):Promise<GroupRead>{
 const {modules,preview}=approvalsRead,tasks=await approvalsRead.tasks;
 if(!tasks.ok)return failed;
 const items=tasks.value.items.flatMap(task=>{const kind=APPROVAL_KIND[task.kind];
  return kind?[item({key:`${kind}:${task.id}`,group:'approvals',kind,state:'todo',date:null,due:period.cutOff,label:task.subjectName,href:task.linkPath})]:[];});
 const omittedClaims=Math.max(0,tasks.value.claimTotal-items.filter(row=>row.kind==='approve_claim').length);
 return {read:modules.attendance==='failed'||modules.claims==='failed'?'failed':'ok',items,
  ...(preview?{total:items.length+omittedClaims,claimTotal:tasks.value.claimTotal}:{})};
}

/** The person's "Before payroll" checklist. `null` when payroll is not in use for the tenant: there is no payroll to be
 * ready for. Someone with no own employment (or several and none chosen) gets no own items, only their approvals.
 * `scopeIds`: the companies in the viewer's current scope, for the approvals owner's company filter (Today's own). */
export async function readMyPayrollReadiness(ctx:SessionContext,p:Readonly<{employmentId?:string;scopeIds?:readonly string[];locale?:string;today?:string;approvalPreview?:boolean}>={}):Promise<PayrollReadiness|null>{
 if(!ctx.userId||ctx.agent)return null;
 const payroll=moduleState(ctx,'payroll');
 if(payroll==='off')return null;
 const today=p.today??todayInKualaLumpur(),locale=p.locale??'en';
 // The approvals read depends on neither the subject nor the period, so it starts now and runs while they are resolved.
 const approvalsRead=startApprovals(ctx,p.scopeIds,p.approvalPreview);
 let subject:Subject|null=null;
 try{const own=await requireOwnHomeSubject(ctx,p.employmentId);subject={employmentId:own.employmentId,companyId:own.companyProof.companyId??own.currentCompanyId??null};}
 catch(error){if(!(error instanceof HomeAccessError))throw error;}
 const periodRead=payroll==='on'?await settle(()=>resolvePeriodAndWindows(ctx,subject?.employmentId??null,today)):{ok:false as const};
 const period:PayrollPeriod=periodRead.ok?periodRead.value.period:Object.freeze({payPeriod:periodOf(today),start:`${periodOf(today)}-01`,cutOff:null,source:'unavailable' as const});
 // Each input type's own window travels with the period object to the group readers, not into the period's shape.
 if(periodRead.ok&&periodRead.value.windows)windowsOf.set(period,periodRead.value.windows);
 const none=Promise.resolve(off);
 const [att,leave,claims,toil,details,acknowledge,approvals]=await Promise.all([
  subject?attendanceGroups(ctx,subject,period,today):Promise.resolve({attendance:off,overtime:off}),
  subject?leaveGroup(ctx,subject,period,locale):none,
  subject?claimsGroup(ctx,subject,period,today):none,
  subject?toilGroup(ctx,subject,period):none,
  subject?detailsGroup(ctx,subject,period,today):none,
  subject?acknowledgeGroup(ctx,subject,period):none,
  approvalsGroup(approvalsRead,period),
 ]);
 const reads:Readonly<Record<PayrollItemGroup,GroupRead>>={attendance:att.attendance,overtime:att.overtime,leave,claims,toil,details,acknowledge,approvals};
 const groups:GroupState[]=PAYROLL_ITEM_GROUPS.map(group=>Object.freeze({group,status:groupStatus(reads[group].items,reads[group].read)}));
 const own=PAYROLL_ITEM_GROUPS.filter(group=>group!=='approvals').flatMap(group=>reads[group].items);
 return Object.freeze({period,items:orderItems(own),approvals:orderItems(approvals.items),groups:Object.freeze(groups),
  ...(p.approvalPreview?{approvalTotal:approvals.total??approvals.items.length,approvalClaimTotal:approvals.claimTotal??0}:{}),
  failed:!periodRead.ok||PAYROLL_ITEM_GROUPS.some(group=>reads[group].read==='failed')});
}
