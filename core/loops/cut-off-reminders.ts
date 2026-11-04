/** AI v2 Phase 2 hardening (4 November 2026) — the Pre-salary loop's automatic cut-off reminders (owner ruling 18: the
 * Pre-salary loop sends cut-off reminders automatically).
 *
 * WHEN. After each Pre-salary run, for each company it checked whose setting has reminders on (on by default,
 * core/loops/payroll-loop-settings.ts), on the days that are exactly 5, 2 and 1 days before one of the company's relevant
 * cut-offs for the upcoming pay period: the salary cut-off and each input type's own (attendance, overtime, claims,
 * unpaid leave), as the payroll owner resolves them (core/loops/payroll-inputs.ts upcomingPeriod).
 * WHO AND WHAT. Each person with something of their OWN to finish before that cut-off gets ONE consolidated reminder: an
 * employee for their own items (a missed clock-in or clock-out or an absence with no leave in the attendance window, a
 * draft claim or a claim missing its receipt in the claim window, a bank account or statutory number the payroll needs),
 * an approver for the requests waiting on them (claims, attendance corrections, leave, replacement leave in their windows),
 * one person who is both getting one reminder with both counts. Counts only, never a pay figure, a name or an amount; the
 * reminder links to their own "Before payroll" checklist, which they read as themselves. Nobody with nothing pending is
 * reminded.
 * RECORDED AND RATE-LIMITED. One row per recipient, cut-off and lead in teras_cut_off_reminder (migration 2011), written by
 * the agent principal only while the loop may write for the company (the database refuses a switched-off, stopped or
 * paused loop); the unique key means a recipient is reminded at most once per cut-off and lead however often the loop
 * runs, and at most MAX_PER_COMPANY reminders go out per company per run. The row's insert appends the reminder's own
 * domain event, which core/notifications.ts turns into the recipient's in-app notice.
 * ALLOWED ABOVE PREPARE. The Pre-salary loop is pay and stays at Prepare in every company; a reminder is a notice about the
 * person's own pending items, classed `payroll_input_reminder` (core/loops/autonomy.ts LOOP_NOTICES, the missing employee
 * data loop's pattern: a request to the person, never the change itself). It changes no record and no pay. No model. */
import {and,eq,gte,inArray,isNull,lte,or,sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {attendanceCorrection,claimAttachment,claimRequest,claimType,employment,leaveRequest,replacementLeaveRequest} from '../../db/schema';
import {terasCutOffReminder} from '../../db/teras-payroll-cycle-schema';
import {attendanceForEmploymentsRange,classifyDay} from '../../packs/attendance/service';
import {addHrDays} from '../../lib/today/audience';
import {readinessSnapshot} from '../record-readiness';
import {approverEmploymentsForKind,currentApproverEmploymentsTx} from '../notifications';
import {noticeAllowed} from './autonomy';
import {companyCutOffs,upcomingPeriod} from './payroll-inputs';
import {payrollLoopSettingsTx} from './payroll-loop-settings';
import {daysBetween} from './period';

export const REMINDER_LEAD_DAYS=Object.freeze([5,2,1] as const);
export type ReminderLead=(typeof REMINDER_LEAD_DAYS)[number];
/** At most this many reminders per company in one run (the rest wait for the next run, still before the cut-off). */
export const MAX_PER_COMPANY=1000;
const BATCH=100;
type InputType='attendance'|'overtime'|'claim'|'leave'|'salary';
type Counts={own:number;approvals:number};

/** PURE. The cut-offs due a reminder today: each distinct cut-off date of the period that is 5, 2 or 1 days away, with the
 * input types that close on it. */
export function remindersDue(windows:Readonly<Record<InputType,{start:string;end:string}>>,today:string):readonly Readonly<{cutOff:string;lead:ReminderLead;types:readonly InputType[]}>[]{
 const byDate=new Map<string,InputType[]>();
 for(const type of ['salary','attendance','overtime','claim','leave'] as const){const end=windows[type].end;byDate.set(end,[...(byDate.get(end)??[]),type]);}
 const out:{cutOff:string;lead:ReminderLead;types:readonly InputType[]}[]=[];
 for(const [cutOff,types] of byDate){
  const lead=daysBetween(today,cutOff);
  if((REMINDER_LEAD_DAYS as readonly number[]).includes(lead))out.push({cutOff,lead:lead as ReminderLead,types:Object.freeze(types)});
 }
 return Object.freeze(out.sort((a,b)=>a.cutOff.localeCompare(b.cutOff)));
}

/** Each person's own pending items and the approvals waiting on them for one cut-off, read under the sponsor's authority. */
export async function pendingForCutOff(sponsor:SessionContext,p:Readonly<{companyId:string;today:string;types:readonly InputType[];
 windows:Readonly<Record<InputType,{start:string;end:string}>>}>):Promise<Map<string,Counts>>{
 const out=new Map<string,Counts>();
 const add=(employmentId:string,key:keyof Counts,n=1)=>{const c=out.get(employmentId)??{own:0,approvals:0};c[key]+=n;out.set(employmentId,c);};
 const salary=p.windows.salary,yesterday=addHrDays(p.today,-1);
 const people=await withTenant(sponsor,tx=>tx.select({id:employment.id,hiredOn:employment.hiredOn,terminatedOn:employment.terminatedOn}).from(employment)
  .where(and(eq(employment.companyId,p.companyId),lte(employment.hiredOn,salary.end),or(isNull(employment.terminatedOn),gte(employment.terminatedOn,salary.start)))));
 const ids=people.map(row=>row.id);
 if(!ids.length)return out;
 const span=new Map(people.map(row=>[row.id,row]));
 // Attendance: missed clockings and absences the person must explain, on clocking and not exempt, up to yesterday.
 if(p.types.includes('attendance')){
  const from=p.windows.attendance.start,to=yesterday<p.windows.attendance.end?yesterday:p.windows.attendance.end;
  if(from<=to){
   const pending=new Set((await withTenant(sponsor,tx=>tx.select({employmentId:attendanceCorrection.employmentId,date:attendanceCorrection.attendanceDate}).from(attendanceCorrection)
    .where(and(inArray(attendanceCorrection.employmentId,ids),eq(attendanceCorrection.status,'pending'),isNull(attendanceCorrection.cancelledAt),
     gte(attendanceCorrection.attendanceDate,from),lte(attendanceCorrection.attendanceDate,to))))).map(row=>`${row.employmentId}:${row.date}`));
   for(let offset=0;offset<ids.length;offset+=BATCH){
    for(const [employmentId,rows] of await attendanceForEmploymentsRange(sponsor,ids.slice(offset,offset+BATCH),from,to)){
     if(!rows.some(row=>row.attendanceId!=null))continue;
     const who=span.get(employmentId);
     for(const row of rows){
      if(who&&(row.date<who.hiredOn||(who.terminatedOn!=null&&row.date>who.terminatedOn)))continue;
      if((row as {exceptionExempt?:boolean}).exceptionExempt===true||pending.has(`${employmentId}:${row.date}`))continue;
      const day=classifyDay(row);
      if(day&&(day.section==='incomplete'||day.section==='absent'))add(employmentId,'own');
     }
    }
   }
  }
 }
 await withTenant(sponsor,async tx=>{
  // Claims: the person's drafts and claims missing a required receipt; approvers' pending claims.
  if(p.types.includes('claim')){
   const window=and(gte(claimRequest.incurredOn,addHrDays(p.windows.claim.end,-365)),lte(claimRequest.incurredOn,p.windows.claim.end));
   for(const row of await tx.select({employmentId:claimRequest.employmentId}).from(claimRequest)
    .where(and(inArray(claimRequest.employmentId,ids),eq(claimRequest.status,'draft'),window)))add(row.employmentId,'own');
   for(const row of await tx.select({employmentId:claimRequest.employmentId}).from(claimRequest).innerJoin(claimType,eq(claimType.id,claimRequest.claimTypeId))
    .where(and(inArray(claimRequest.employmentId,ids),eq(claimRequest.status,'pending'),window,
     sql`${claimType.requiresReceipt} and not exists (select 1 from ${claimAttachment} a where a.claim_request_id=${claimRequest.id})`)))add(row.employmentId,'own');
   for(const row of await tx.select({id:claimRequest.id,employmentId:claimRequest.employmentId}).from(claimRequest)
    .where(and(inArray(claimRequest.employmentId,ids),eq(claimRequest.status,'pending'),window))){
    for(const approver of (await currentApproverEmploymentsTx(tx,'claim',row.id,row.employmentId,'pending'))??[])add(approver,'approvals');
   }
   for(const row of await tx.select({id:replacementLeaveRequest.id,employmentId:replacementLeaveRequest.employmentId}).from(replacementLeaveRequest)
    .where(and(inArray(replacementLeaveRequest.employmentId,ids),eq(replacementLeaveRequest.status,'pending')))){
    for(const approver of (await currentApproverEmploymentsTx(tx,'replacement_leave',row.id,row.employmentId,'pending'))??[])add(approver,'approvals');
   }
  }
  // Attendance corrections and leave waiting for a decision: their first approver (the person's direct manager, or HR).
  const firstApprover=async(employmentId:string)=>{const managers=await approverEmploymentsForKind(tx,employmentId,'direct_manager');
   return managers.length?managers:await approverEmploymentsForKind(tx,employmentId,'hr_admin');};
  if(p.types.includes('attendance')){
   for(const row of await tx.select({employmentId:attendanceCorrection.employmentId}).from(attendanceCorrection)
    .where(and(inArray(attendanceCorrection.employmentId,ids),eq(attendanceCorrection.status,'pending'),isNull(attendanceCorrection.cancelledAt),
     gte(attendanceCorrection.attendanceDate,p.windows.attendance.start),lte(attendanceCorrection.attendanceDate,p.windows.attendance.end))))
    for(const approver of await firstApprover(row.employmentId))add(approver,'approvals');
  }
  if(p.types.includes('leave')){
   for(const row of await tx.select({employmentId:leaveRequest.employmentId}).from(leaveRequest)
    .where(and(inArray(leaveRequest.employmentId,ids),eq(leaveRequest.status,'pending'),lte(leaveRequest.startDate,p.windows.leave.end),gte(leaveRequest.endDate,p.windows.leave.start))))
    for(const approver of await firstApprover(row.employmentId))add(approver,'approvals');
  }
  // The person's own details payroll needs by the salary cut-off (the readiness owner's own rule: bank only for people
  // paid by bank, statutory numbers only for people they apply to).
  if(p.types.includes('salary')){
   const active=people.filter(row=>row.terminatedOn==null).map(row=>row.id);
   if(active.length){
    const gaps=(await readinessSnapshot(tx,Number.POSITIVE_INFINITY,true,{employmentIds:active})).view.gaps;
    for(const gap of gaps)if(['no_bank_account','no_tax_number','no_epf_number','no_socso_number','no_identity'].includes(gap.id))
     for(const person of gap.people)add(person.employmentId,'own');
   }
  }
 });
 return out;
}

export type ReminderRunInput=Readonly<{tenantId:string;principalId:string;runId:string;agent:SessionContext;sponsor:SessionContext;companies:readonly string[];today:string}>;
export type ReminderRunSummary=Readonly<{sent:number;companies:number}>;

/** The Pre-salary loop's reminder step, after its Prepare step. Never throws: a failure leaves the cases as prepared and
 * is retried on the next run (the ledger keeps a reminder from going out twice). */
export async function sendCutOffReminders(p:ReminderRunInput):Promise<ReminderRunSummary>{
 if(!noticeAllowed('loop_payroll_inputs')||!p.companies.length)return Object.freeze({sent:0,companies:0});
 let sent=0,touched=0;
 try{
  const settings=await withTenant(p.agent,tx=>payrollLoopSettingsTx(tx,p.tenantId,p.companies));
  const on=p.companies.filter(companyId=>settings.get(companyId)?.remindersEnabled!==false);
  if(!on.length)return Object.freeze({sent:0,companies:0});
  const config=await companyCutOffs(p.sponsor,on);
  for(const companyId of on)try{
   const {period,windows}=upcomingPeriod(config.get(companyId)??null,p.today);
   const due=remindersDue(windows,p.today);
   if(!due.length)continue;
   touched++;
   let budget=MAX_PER_COMPANY;
   for(const item of due){
    if(budget<=0)break;
    const counts=await pendingForCutOff(p.sponsor,{companyId,today:p.today,types:item.types,windows});
    const rows=[...counts].filter(([,c])=>c.own+c.approvals>0).sort(([a],[b])=>a.localeCompare(b)).slice(0,budget)
     .map(([recipient,c])=>({tenantId:p.tenantId,companyId,payPeriod:period,cutOff:item.cutOff,leadDays:item.lead,recipientEmploymentId:recipient,
      audience:(c.own&&c.approvals?'both':c.own?'employee':'approver') as 'employee'|'approver'|'both',ownItems:Math.min(c.own,10_000),
      approvals:Math.min(c.approvals,10_000),runId:p.runId,agentPrincipalId:p.principalId}));
    for(let offset=0;offset<rows.length;offset+=BATCH){
     const inserted=await withTenant(p.agent,(tx:Tx)=>tx.insert(terasCutOffReminder).values(rows.slice(offset,offset+BATCH)).onConflictDoNothing()
      .returning({id:terasCutOffReminder.id}));
     sent+=inserted.length;budget-=inserted.length;
    }
   }
  }catch{/* One company's failure (paused meanwhile, a read refused) never stops the others; the next run tries again. */}
 }catch{/* The reminders never stop the loop; the next run tries again. */}
 return Object.freeze({sent,companies:touched});
}
