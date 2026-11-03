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
 * items are fixed (PRE_SALARY_CHECK_HREF); the loop itself changes nothing. Counts only: no name, no amount. */
import {and,count,eq,gte,inArray,isNotNull,isNull,lte,or,sql,type Column} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../../db/client';
import {attendance,attendanceCorrection,claimAttachment,claimRequest,claimType,compensation,employeeStatutoryMy,employment,employmentPayComponent,
 leaveRequest,performanceReview,profileChangeRequest,resignationRequest} from '../../db/schema';
import {terasLoopCase} from '../../db/teras-schema';
import {isModuleEnabled} from '../entitlements';
import {compensationEffectiveOn} from '../comp';
import {readinessSnapshot} from '../record-readiness';
import {OT_CAP_MINUTES,attendanceForEmploymentsRange} from '../../packs/attendance/service';
import {classifyDay} from '../../packs/attendance/exceptions';
import {payrollReadiness} from '../../packs/payroll/service';
import {addHrDays} from '../../lib/today/audience';
import {unique} from './detect';

export const PRE_SALARY_CHECKS=Object.freeze(['timesheets','overtime','leave','claims','joinersLeavers','statutoryBank','payChanges','setup'] as const);
export type PreSalaryCheckKey=(typeof PRE_SALARY_CHECKS)[number];
export type PreSalaryCheckStatus='done'|'waiting'|'open'|'warning'|'off';
export type PreSalaryCheck=Readonly<{key:PreSalaryCheckKey;status:PreSalaryCheckStatus;open:number;waiting:number;warnings:number;info:number}>;
export type Window=Readonly<{start:string;end:string}>;
export type PreSalaryWindows=Readonly<{salary:Window;attendance:Window;overtime:Window;claim:Window;leave:Window}>;

/** Where each check's items are fixed: the owner's own page. Exported for the screens and the tests, which pin them. */
export const PRE_SALARY_CHECK_HREF:Readonly<Record<PreSalaryCheckKey,string>>=Object.freeze({
 timesheets:'/attendance/individual',overtime:'/approvals?category=overtime',leave:'/approvals?category=leave',claims:'/approvals?category=claim',
 joinersLeavers:'/personnel',statutoryBank:'/control-tower/readiness',payChanges:'/performance',setup:'/payroll/setup?readiness=full'});

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
      if(day.section==='incomplete')missing++;
      else if(day.section==='absent')absent++;
      else if(!explained.has(key))short++;
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
  const inWindow=lte(claimRequest.incurredOn,windows.claim.end);
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
  active.length?(await readinessSnapshot(tx,0,true,{employmentIds:active})).view.gaps:[],
  n(await tx.select({n:count()}).from(profileChangeRequest).where(and(among(profileChangeRequest.employmentId),eq(profileChangeRequest.status,'pending'),
   sql`coalesce(${profileChangeRequest.proposed}->>'kind','')<>'photo'`))),
  n(await tx.select({n:count()}).from(terasLoopCase).where(and(eq(terasLoopCase.workerId,'loop_missing_employee_data'),eq(terasLoopCase.companyId,companyId),
   inArray(terasLoopCase.state,['open','waiting'])))),
 ] as const);
 const gap=(id:string)=>gaps.find(item=>item.id===id)?.count??0;
 const statutoryBank=check('statutoryBank',{open:gap('no_bank_account'),waiting:profileUpdates,
  warnings:gap('no_identity')+gap('no_tax_number')+gap('no_epf_number')+gap('no_socso_number'),info:dataRequests});

 // ── Pay changes: recommended changes not yet decided, and recorded changes taking effect in the window ──
 const [recommended,changes]=await withTenant(sponsor,async tx=>[
  uses('performance')?n(await tx.select({n:count()}).from(performanceReview).where(and(among(performanceReview.employmentId),eq(performanceReview.compActionStatus,'recommended')))):0,
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

 return Object.freeze({checks:Object.freeze([timesheets,overtime,leave,claims,joinersLeavers,statutoryBank,payChanges,setup]),
  readiness:Object.freeze({missing:Object.freeze(unique(missing)),blockers:readiness.blockers,warnings:readiness.warnings})});
}

