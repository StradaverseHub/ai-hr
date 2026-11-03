/** AI v2 P2-2a — the Pre-salary loop's checks for one company and pay period, each read through its native owner under
 * the loop sponsor's authority (row-level security applies to every read). Read-only: no write, no model call.
 *
 * Each check counts, from the start of its input window to the cut-off (attendance up to yesterday, since today is still
 * being worked):
 *  - open: something a person must do before the cut-off (a missing punch, an absence with no leave, a claim with no
 *    receipt, a joiner or leaver whose record payroll cannot pay, a bank account missing, a set-up blocker);
 *  - waiting: something waiting for its usual approver (a correction, overtime, leave, a claim, a resignation, a
 *    profile update, a recommended pay change);
 *  - warnings: worth a look but not blocking (late or early marks with no reason given, overtime over the monthly cap,
 *    draft claims not submitted, statutory numbers missing, set-up warnings);
 *  - info: context only (clock-out cards the Phase 1 loop has open, unpaid leave approved, missing-data requests open,
 *    pay changes taking effect).
 * A check is done when nothing is open or waiting. "Done" for the loop is every check done before the cut-off (owner:
 * no blocker left). A check whose module the company does not use is off. Each check names the owner page where its
 * items are fixed (PRE_SALARY_CHECK_HREF); the loop itself changes nothing. Counts only: no name, no amount.
 *
 * Phase 2 hardening (4 November 2026), data-aware: each check reads the owning fact first, so a legitimate set-up is not
 * flagged (owner input 17):
 *  - a day the person's schedule group is exempt from absence, late-in and early-out judgments (the attendance owner's
 *    own "Enable Exception", for staff who do not clock in) is neither an absence nor a short-day mark;
 *  - only pay-relevant profile updates wait for payroll (bank, statutory and tax details, identity numbers, marital
 *    status and children: lib/profile-requestable-fields.ts); a photo or a contact change does not;
 *  - a pending claim counts when it was incurred within the year before the claim cut-off, and a recommended pay change
 *    when its review cycle ended within the year before the salary cut-off, so a stale request left years ago does not
 *    hold this month's payroll;
 *  - statutory numbers are asked only of people they apply to (record readiness: EPF-exempt, SOCSO- and EIS-exempt staff),
 *    and a bank account only of people paid by bank (cash and cheque need none).
 * Owner ruling 19 (coordinator review, 4 November 2026): a WARNING a standing acknowledgement covers leaves the counts.
 * The acknowledgements are the ones payroll HR record on the Audit loop and Salary payroll pages
 * (core/loops/acknowledgements.ts), each for one check and one person, group or the whole company; a Pre-salary warning
 * leaves the count when an acknowledgement of the SAME fact covers that person (PRE_SALARY_ACKNOWLEDGED_BY):
 *  - a late or early mark, when the person's pay is acknowledged as not following attendance ("pay without attendance"
 *    expected: the Audit loop's control or the anomaly detector);
 *  - a missing tax number, when the person's missing tax profile is acknowledged (the anomaly detector);
 *  - a repeat audit issue, when the control is acknowledged (core/payroll-audit/status.ts repeatAuditIssues).
 * Open and waiting items never leave a count (a block stays a block), and no other warning has an acknowledgeable check
 * of its own yet (overtime over the cap, draft claims, missing identity, EPF or SOCSO numbers, set-up warnings).
 * Wave 1 integration: the last check is the payroll Audit loop's repeat issues (P2-2b, core/payroll-audit/status.ts
 * repeatAuditIssues): the control checks that found something in the last audited month (the month before this one) and
 * in the month before that too, which the next Pre-salary loop should look at first. A warning per repeated check, never
 * blocking; off when the company does not use payroll or the sponsor may not read the Audit loop. */
import {and,count,eq,gte,inArray,isNotNull,isNull,lte,or,sql,type Column} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../../db/client';
import {attendance,attendanceCorrection,claimAttachment,claimRequest,claimType,compensation,employeeStatutoryMy,employment,employmentPayComponent,
 leaveRequest,performanceReview,profileChangeRequest,resignationRequest,reviewCycle} from '../../db/schema';
import {isPayRelevantProfileChange} from './pay-relevant';
import {terasLoopCase} from '../../db/teras-schema';
import {isModuleEnabled} from '../entitlements';
import {compensationEffectiveOn} from '../comp';
import {readinessSnapshot} from '../record-readiness';
import {OT_CAP_MINUTES,attendanceForEmploymentsRange} from '../../packs/attendance/service';
import {classifyDay} from '../../packs/attendance/exceptions';
import {payrollReadiness} from '../../packs/payroll/service';
import {addHrDays} from '../../lib/today/audience';
import {unique} from './detect';
import {previousPeriod} from './period';
import {AuditViewRefused,repeatAuditIssues} from '../payroll-audit/status';
import {acknowledgementFor,acknowledgementsTx,currentDepartmentsTx,type Acknowledgement} from './acknowledgements';

export const PRE_SALARY_CHECKS=Object.freeze(['timesheets','overtime','leave','claims','joinersLeavers','statutoryBank','payChanges','setup','repeatAudit'] as const);
export type PreSalaryCheckKey=(typeof PRE_SALARY_CHECKS)[number];
export type PreSalaryCheckStatus='done'|'waiting'|'open'|'warning'|'off';
export type PreSalaryCheck=Readonly<{key:PreSalaryCheckKey;status:PreSalaryCheckStatus;open:number;waiting:number;warnings:number;info:number}>;
export type Window=Readonly<{start:string;end:string}>;
export type PreSalaryWindows=Readonly<{salary:Window;attendance:Window;overtime:Window;claim:Window;leave:Window}>;

/** Where each check's items are fixed: the owner's own page. Exported for the screens and the tests, which pin them. */
export const PRE_SALARY_CHECK_HREF:Readonly<Record<PreSalaryCheckKey,string>>=Object.freeze({
 timesheets:'/attendance/individual',overtime:'/approvals?category=overtime',leave:'/approvals?category=leave',claims:'/approvals?category=claim',
 joinersLeavers:'/personnel',statutoryBank:'/control-tower/readiness',payChanges:'/performance',setup:'/payroll/setup?readiness=full',
 repeatAudit:'/control-tower/loops/loop_payroll_audit'});

/** Owner ruling 19: which standing acknowledgements take a Pre-salary warning out of its count, by the warning. Each is an
 * acknowledgeable check (core/loops/acknowledgements.ts ACKNOWLEDGEABLE_CHECKS) about the same fact for the same person. */
export const PRE_SALARY_ACKNOWLEDGED_BY=Object.freeze({
 lateOrEarly:Object.freeze(['audit:pay_without_attendance','anomaly:pay-without-attendance']),
 taxNumber:Object.freeze(['anomaly:missing-tax-profile']),
} as const);

const statusOf=(c:{open:number;waiting:number;warnings:number}):PreSalaryCheckStatus=>c.open>0?'open':c.waiting>0?'waiting':c.warnings>0?'warning':'done';
const check=(key:PreSalaryCheckKey,c:{open?:number;waiting?:number;warnings?:number;info?:number}):PreSalaryCheck=>{
 const v={open:c.open??0,waiting:c.waiting??0,warnings:c.warnings??0,info:c.info??0};
 return Object.freeze({key,status:statusOf(v),...v});
};
const off=(key:PreSalaryCheckKey):PreSalaryCheck=>Object.freeze({key,status:'off',open:0,waiting:0,warnings:0,info:0});
/** A check is blocking while anything is open or waiting. */
export const isBlocking=(c:PreSalaryCheck)=>c.status==='open'||c.status==='waiting';

/** A case fact for one check: `key:status:open:waiting:warnings:info` (counts only). */
export const encodeCheck=(c:PreSalaryCheck)=>`${c.key}:${c.status}:${c.open}:${c.waiting}:${c.warnings}:${c.info}`;
export function decodeCheck(value:unknown):PreSalaryCheck|null{
 if(typeof value!=='string')return null;
 const m=/^([a-zA-Z]+):(done|waiting|open|warning|off):(\d{1,9}):(\d{1,9}):(\d{1,9}):(\d{1,9})$/.exec(value);
 if(!m||!(PRE_SALARY_CHECKS as readonly string[]).includes(m[1]))return null;
 return Object.freeze({key:m[1] as PreSalaryCheckKey,status:m[2] as PreSalaryCheckStatus,open:Number(m[3]),waiting:Number(m[4]),warnings:Number(m[5]),info:Number(m[6])});
}

const BATCH=100;
const n=(rows:{n:number|string|null}[])=>Number(rows[0]?.n??0);

export type PreSalaryInput=Readonly<{companyId:string;payPeriod:string;today:string;windows:PreSalaryWindows}>;
export type PreSalaryResult=Readonly<{checks:readonly PreSalaryCheck[];readiness:Readonly<{missing:readonly string[];blockers:number;warnings:number}>}>;

/** Every Pre-salary check for one company, in the order the screens show them. */
export async function preSalaryChecks(sponsor:SessionContext,input:PreSalaryInput):Promise<PreSalaryResult>{
 const {companyId,windows}=input,yesterday=addHrDays(input.today,-1);
 const uses=(module:string)=>isModuleEnabled(sponsor,module,companyId);
 // The company's employments active at any point of the salary window (joiners and leavers included).
 const people=await withTenant(sponsor,tx=>tx.select({id:employment.id,hiredOn:employment.hiredOn,terminatedOn:employment.terminatedOn}).from(employment)
  .where(and(eq(employment.companyId,companyId),lte(employment.hiredOn,windows.salary.end),
   or(isNull(employment.terminatedOn),gte(employment.terminatedOn,windows.salary.start)))));
 const ids=people.map(row=>row.id);
 const among=(column:Column)=>ids.length?inArray(column,ids):sql`false`;
 // Owner ruling 19: the standing acknowledgements in force for the company, as the sponsor may read them (none read, none
 // applied), and each person's current department for a group-scope one.
 const acknowledgements:readonly Acknowledgement[]=await withTenant(sponsor,tx=>acknowledgementsTx(tx,sponsor.tenantId,[companyId])).catch(()=>[]);
 const departments=acknowledgements.some(item=>item.scope==='group')?await withTenant(sponsor,tx=>currentDepartmentsTx(tx,ids)):new Map<string,string>();
 const acknowledged=(employmentId:string,checkIds:readonly string[])=>checkIds.some(checkId=>!!acknowledgementFor(acknowledgements,
  {companyId,checkId,employmentId,departmentId:departments.get(employmentId)??null}));
 const anyAcknowledged=(checkIds:readonly string[])=>acknowledgements.some(item=>checkIds.includes(item.checkId));

 // ── Timesheets: missed punches, absences with no leave, late or early marks with no reason, corrections waiting ──
 let timesheets=off('timesheets');
 if(uses('attendance')){
  const to=yesterday<windows.attendance.end?yesterday:windows.attendance.end,from=windows.attendance.start;
  let missing=0,absent=0,short=0,waiting=0;
  if(from<=to&&ids.length){
   const corrections=await withTenant(sponsor,tx=>tx.select({employmentId:attendanceCorrection.employmentId,date:attendanceCorrection.attendanceDate,status:attendanceCorrection.status})
    .from(attendanceCorrection).where(and(among(attendanceCorrection.employmentId),gte(attendanceCorrection.attendanceDate,from),lte(attendanceCorrection.attendanceDate,to),
     isNull(attendanceCorrection.requestedOtMinutes),isNull(attendanceCorrection.cancelledAt),inArray(attendanceCorrection.status,['pending','approved']))));
   const pending=new Set(corrections.filter(row=>row.status==='pending').map(row=>`${row.employmentId}:${row.date}`));
   const explained=new Set(corrections.map(row=>`${row.employmentId}:${row.date}`));
   const span=new Map(people.map(row=>[row.id,row]));
   for(let offset=0;offset<ids.length;offset+=BATCH){
    const range=await attendanceForEmploymentsRange(sponsor,ids.slice(offset,offset+BATCH),from,to);
    for(const [employmentId,rows] of range){
     const who=span.get(employmentId);
     for(const row of rows){
      if(who&&(row.date<who.hiredOn||(who.terminatedOn!=null&&row.date>who.terminatedOn)))continue;
      const day=classifyDay(row);
      if(!day)continue;
      const key=`${employmentId}:${row.date}`;
      if(pending.has(key)){waiting++;continue;}
      // The schedule group's own exemption: no absence and no short-day mark on an exempt day.
      const exempt=(row as {exceptionExempt?:boolean}).exceptionExempt===true;
      if(day.section==='incomplete')missing++;
      else if(day.section==='absent'){if(!exempt)absent++;}
      // A late or early mark of someone whose pay is acknowledged as not following attendance: expected, not a warning.
      else if(!exempt&&!explained.has(key)&&!acknowledged(employmentId,PRE_SALARY_ACKNOWLEDGED_BY.lateOrEarly))short++;
     }
    }
   }
  }
  const clockOutCards=n(await withTenant(sponsor,tx=>tx.select({n:count()}).from(terasLoopCase).where(and(eq(terasLoopCase.workerId,'loop_missed_clock_outs'),
   eq(terasLoopCase.companyId,companyId),inArray(terasLoopCase.state,['open','waiting'])))));
  timesheets=check('timesheets',{open:missing+absent,waiting,warnings:short,info:clockOutCards});
 }

 // ── Overtime: requests waiting for approval, and people over the monthly cap ──
 let overtime=off('overtime');
 if(uses('attendance')){
  const [waiting,over]=await withTenant(sponsor,async tx=>[
   n(await tx.select({n:count()}).from(attendanceCorrection).where(and(among(attendanceCorrection.employmentId),eq(attendanceCorrection.status,'pending'),
    isNotNull(attendanceCorrection.requestedOtMinutes),isNull(attendanceCorrection.cancelledAt),
    gte(attendanceCorrection.attendanceDate,windows.overtime.start),lte(attendanceCorrection.attendanceDate,windows.overtime.end)))),
   Array.from(await tx.select({employmentId:attendance.employmentId,minutes:sql<number>`coalesce(sum(${attendance.otMinutes}),0)::int`}).from(attendance)
    .where(and(among(attendance.employmentId),gte(attendance.attendanceDate,windows.overtime.start),lte(attendance.attendanceDate,windows.overtime.end)))
    .groupBy(attendance.employmentId)).filter(row=>Number(row.minutes)>OT_CAP_MINUTES).length,
  ] as const);
  overtime=check('overtime',{waiting,warnings:over});
 }

 // ── Leave: requests waiting for a decision, and approved unpaid leave in the window ──
 let leave=off('leave');
 if(uses('leave')){
  const overlaps=and(lte(leaveRequest.startDate,windows.leave.end),gte(leaveRequest.endDate,windows.leave.start));
  const [waiting,unpaid]=await withTenant(sponsor,async tx=>[
   n(await tx.select({n:count()}).from(leaveRequest).where(and(among(leaveRequest.employmentId),eq(leaveRequest.status,'pending'),overlaps))),
   n(await tx.select({n:count()}).from(leaveRequest).where(and(among(leaveRequest.employmentId),eq(leaveRequest.status,'approved'),overlaps,
    sql`coalesce(${leaveRequest.unpaidDays},0)>0`))),
  ] as const);
  leave=check('leave',{waiting,info:unpaid});
 }

 // ── Claims: waiting for a decision, missing a required receipt, and drafts not yet submitted ──
 let claims=off('claims');
 if(uses('claims')){
  // Incurred within the year before the claim cut-off: a request left pending for longer is not this month's input.
  const inWindow=and(lte(claimRequest.incurredOn,windows.claim.end),gte(claimRequest.incurredOn,addHrDays(windows.claim.end,-365)));
  const noReceipt=sql`${claimType.requiresReceipt} and not exists (select 1 from ${claimAttachment} a where a.claim_request_id=${claimRequest.id})`;
  const [waiting,receipts,drafts]=await withTenant(sponsor,async tx=>[
   n(await tx.select({n:count()}).from(claimRequest).where(and(among(claimRequest.employmentId),eq(claimRequest.status,'pending'),inWindow))),
   n(await tx.select({n:count()}).from(claimRequest).innerJoin(claimType,eq(claimType.id,claimRequest.claimTypeId))
    .where(and(among(claimRequest.employmentId),inArray(claimRequest.status,['pending','draft']),inWindow,noReceipt))),
   n(await tx.select({n:count()}).from(claimRequest).where(and(among(claimRequest.employmentId),eq(claimRequest.status,'draft'),
    gte(claimRequest.incurredOn,windows.claim.start),inWindow))),
  ] as const);
  claims=check('claims',{open:receipts,waiting,warnings:drafts});
 }

 // ── Joiners and leavers: a joiner with no salary record or statutory profile; a leaver whose last day is not recorded ──
 const joiners=people.filter(row=>row.hiredOn>=windows.salary.start&&row.hiredOn<=windows.salary.end).map(row=>row.id);
 const leavers=people.filter(row=>row.terminatedOn!=null&&row.terminatedOn>=windows.salary.start&&row.terminatedOn<=windows.salary.end).length;
 const [incompleteJoiners,unrecordedLeavers,pendingResignations]=await withTenant(sponsor,async tx=>[
  joiners.length?n(await tx.select({n:count()}).from(employment)
   .leftJoin(compensation,and(eq(compensation.employmentId,employment.id),compensationEffectiveOn(windows.salary.end)))
   .leftJoin(employeeStatutoryMy,eq(employeeStatutoryMy.personId,employment.personId))
   .where(and(inArray(employment.id,joiners),or(isNull(compensation.id),isNull(employeeStatutoryMy.personId))))):0,
  n(await tx.select({n:count()}).from(resignationRequest).innerJoin(employment,eq(employment.id,resignationRequest.employmentId))
   .where(and(eq(employment.companyId,companyId),eq(resignationRequest.status,'accepted'),isNull(employment.terminatedOn),
    lte(resignationRequest.lastWorkingDay,windows.salary.end)))),
  n(await tx.select({n:count()}).from(resignationRequest).innerJoin(employment,eq(employment.id,resignationRequest.employmentId))
   .where(and(eq(employment.companyId,companyId),eq(resignationRequest.status,'pending'),lte(resignationRequest.lastWorkingDay,windows.salary.end)))),
 ] as const);
 const joinersLeavers=check('joinersLeavers',{open:incompleteJoiners+unrecordedLeavers,waiting:pendingResignations,info:joiners.length+leavers});

 // ── Statutory and bank details (record readiness, the same rules the payroll detectors use) ──
 const active=people.filter(row=>row.terminatedOn==null).map(row=>row.id);
 const [gaps,profileUpdates,dataRequests]=await withTenant(sponsor,async tx=>[
  // With every person named only when an acknowledgement could take one out of a count (the names never leave here).
  active.length?(await readinessSnapshot(tx,anyAcknowledged(PRE_SALARY_ACKNOWLEDGED_BY.taxNumber)?active.length:0,true,{employmentIds:active})).view.gaps:[],
  // Only a pay-relevant update waits for payroll (not a photo, a contact detail or a preferred name).
  (await tx.select({proposed:profileChangeRequest.proposed}).from(profileChangeRequest).where(and(among(profileChangeRequest.employmentId),
   eq(profileChangeRequest.status,'pending'),sql`coalesce(${profileChangeRequest.proposed}->>'kind','')<>'photo'`))).filter(row=>isPayRelevantProfileChange(row.proposed)).length,
  n(await tx.select({n:count()}).from(terasLoopCase).where(and(eq(terasLoopCase.workerId,'loop_missing_employee_data'),eq(terasLoopCase.companyId,companyId),
   inArray(terasLoopCase.state,['open','waiting'])))),
 ] as const);
 const gap=(id:string)=>gaps.find(item=>item.id===id)?.count??0;
 // A missing tax number of someone whose missing tax profile is acknowledged: expected, not a warning.
 const taxCovered=(gaps.find(item=>item.id==='no_tax_number')?.people??[]).filter(row=>acknowledged(row.employmentId,PRE_SALARY_ACKNOWLEDGED_BY.taxNumber)).length;
 const statutoryBank=check('statutoryBank',{open:gap('no_bank_account'),waiting:profileUpdates,
  warnings:gap('no_identity')+Math.max(0,gap('no_tax_number')-taxCovered)+gap('no_epf_number')+gap('no_socso_number'),info:dataRequests});

 // ── Pay changes: recommended changes not yet decided, and recorded changes taking effect in the window ──
 const [recommended,changes]=await withTenant(sponsor,async tx=>[
  // A recommendation from a review cycle that ended within the year before the salary cut-off (and not after it).
  uses('performance')?n(await tx.select({n:count()}).from(performanceReview).innerJoin(reviewCycle,eq(reviewCycle.id,performanceReview.cycleId))
   .where(and(among(performanceReview.employmentId),eq(performanceReview.compActionStatus,'recommended'),
    lte(reviewCycle.periodEnd,windows.salary.end),gte(reviewCycle.periodEnd,addHrDays(windows.salary.end,-365))))):0,
  n(await tx.select({n:count()}).from(compensation).where(and(among(compensation.employmentId),isNull(compensation.supersededAt),
   gte(compensation.validFrom,windows.salary.start),lte(compensation.validFrom,windows.salary.end))))
  +n(await tx.select({n:count()}).from(employmentPayComponent).where(and(among(employmentPayComponent.employmentId),isNull(employmentPayComponent.supersededAt),
   gte(employmentPayComponent.validFrom,windows.salary.start),lte(employmentPayComponent.validFrom,windows.salary.end)))),
 ] as const);
 const payChanges=check('payChanges',{waiting:recommended,info:changes});

 // ── Payroll set-up (the payroll readiness owner's own verdict for the pay period) ──
 const readiness=await payrollReadiness(sponsor,{companyId,payPeriod:input.payPeriod});
 const missing=[...readiness.checks.filter(item=>item.status==='blocker'),...readiness.checks.filter(item=>item.status==='warning')].map(item=>item.key);
 const setup=check('setup',{open:readiness.blockers,warnings:readiness.warnings});

 // ── Repeat audit issues (P2-2b): checks that found something in the last audited month and the month before it ──
 let repeatAudit=off('repeatAudit');
 if(uses('payroll')){
  const repeat=await repeatAuditIssues(sponsor,{payPeriod:previousPeriod(input.payPeriod),companyIds:[companyId]})
   .catch((error:unknown)=>{if(error instanceof AuditViewRefused)return null;throw error;});
  if(repeat)repeatAudit=check('repeatAudit',{warnings:repeat.get(companyId)?.length??0});
 }

 return Object.freeze({checks:Object.freeze([timesheets,overtime,leave,claims,joinersLeavers,statutoryBank,payChanges,setup,repeatAudit]),
  readiness:Object.freeze({missing:Object.freeze(unique(missing)),blockers:readiness.blockers,warnings:readiness.warnings})});
}

