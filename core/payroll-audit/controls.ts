/** AI v2 P2-2b — the Audit loop's continuous control checks, and a person's disposition of what they find.
 *
 * Seven deterministic checks, run daily by the loop (and on demand by a payroll administrator) for each company and pay month
 * in scope. Each reads the native owners as its reader and, where its condition holds, returns a finding with the evidence a
 * person needs to judge it. A finding never acts: no run is blocked, no figure changed, nobody notified on the finding's own
 * authority. Every comparison is of stored values against a stored or configured limit; no figure is calculated.
 *  1. bank_change_before_pay_day: an employee's bank account or bank changed within the company's window (default 7 days)
 *     before the run's pay day (employee.bank.updated, before and after). Only the last four digits are kept. A joiner's
 *     FIRST bank details (no account before) are an entry, not a change, and are not flagged (Phase 2 hardening).
 *  2. shared_bank_account: one bank account number on two or more people, at least one of them paid by the company that
 *     month. The account is kept as its last four digits and a hash, never in full. ONE finding per account and set of
 *     people, whatever the month (Phase 2 hardening): the same people sharing the same account are not found again every
 *     month; someone new joining the account is a new finding.
 *  3. pay_after_last_day: net pay on a payslip whose coverage starts after the employment's last working day.
 *  4. pay_without_attendance: the payroll anomaly layer's own pure detector (core/payroll-anomaly-detectors.ts
 *     `pay-without-attendance`) over the same context the anomaly evaluator builds, for salary runs.
 *  5. preparer_closed_run: one login both processed and closed a run. Never blocked (owner decision 2: there is no second
 *     approver), and by default information only, kept in the run's approval capture: a finding is opened only where the
 *     company's setting asks for one (payroll_audit_control_setting.preparer_closed_mode, Phase 2 hardening).
 *  6. adjustment_without_reason: a manual one-off transaction, run component or statutory override above the company's amount
 *     (default 1000.00) with no stated reason.
 *  7. formula_changed_open_period: a pay formula revision or a pay component change saved while a run was open (from its
 *     creation until its close).
 * A finding is recorded once per subject (migration 0965: unique per control and subject). A person disposes of it with one of
 * four dispositions and a note; the latest disposition is its state. Nobody disposes of a finding about themselves (the
 * login who processed and closed the run, changed the bank details or the formula, keyed the adjustment, or the person the
 * finding's employment belongs to): another payroll administrator or a group administrator does (migration 2006 repeats
 * the rule in the disposition policy). Pay without attendance reads the attendance owner's own exemption first: a person
 * whose schedule group is exempt from absence judgments for the whole month is not flagged (core/payroll-anomaly-detectors.ts). */
import {createHash} from 'node:crypto';
import {and,desc,eq,inArray,sql,type SQL} from 'drizzle-orm';
import {z} from 'zod';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {payrollAuditDisposition,payrollAuditFinding} from '../../db/payroll-audit-schema';
import {isAdmin,canManagePayroll} from '../../lib/authz-model';
import {defaultPaymentDate} from '../../packs/payroll/service';
import {DETECTORS} from '../payroll-anomaly-detectors';
import {loadBatchContexts} from '../payroll-anomaly';
import {controlSettingsTx} from './settings';
import {isAuditDisposition,type AuditControlId,type AuditDisposition} from './types';

export type ControlObservation=Readonly<{controlId:AuditControlId;companyId:string;payPeriod:string;batchId:string|null;employmentId:string|null;
 subjectKey:string;evidence:Record<string,unknown>}>;
export type ControlWriter=Readonly<{kind:'agent';principalId:string;runId:string}>|Readonly<{kind:'user';userId:string}>;
export class AuditFindingRefused extends Error{constructor(readonly reason:'not_administrator'|'invalid'|'not_found'|'subject'){super('Audit finding refused: '+reason);this.name='AuditFindingRefused';}}

type Row=Record<string,unknown>;
const rows=async(tx:Tx,query:SQL)=>Array.from(await tx.execute(query) as unknown as Row[]);
const optional=async(tx:Tx,query:SQL):Promise<Row[]>=>{try{return await tx.transaction(savepoint=>rows(savepoint as unknown as Tx,query));}catch{return [];}};
const DAY_MS=86_400_000;
const daysBetween=(from:string,to:string)=>Math.round((Date.parse(`${to}T00:00:00Z`)-Date.parse(`${from}T00:00:00Z`))/DAY_MS);
const digits=(value:unknown)=>typeof value==='string'?value.replace(/\D/g,''):'';
const last4=(value:unknown)=>{const d=digits(value);return d.length?d.slice(-4):null;};
const PAY_WITHOUT_ATTENDANCE=DETECTORS.find(detector=>detector.id==='pay-without-attendance')!;
/** A day in Kuala Lumpur from a stored instant. */
/** A calendar day from a stored date, whichever way the driver returns it. */
const dayOf=(value:unknown)=>value instanceof Date?value.toISOString().slice(0,10):String(value).slice(0,10);
const klDay=(value:unknown)=>{const at=value instanceof Date?value:new Date(String(value));return new Date(at.getTime()+8*3_600_000).toISOString().slice(0,10);};

/** Runs every check for one company and pay month, as `reader`. Read-only. */
export async function detectControlFindingsTx(tx:Tx,reader:SessionContext,p:Readonly<{companyId:string;payPeriod:string}>):Promise<ControlObservation[]>{
 const {companyId,payPeriod}=p,out:ControlObservation[]=[];
 const settings=await controlSettingsTx(tx,reader.tenantId,companyId);
 const push=(item:Omit<ControlObservation,'companyId'|'payPeriod'>)=>out.push(Object.freeze({...item,companyId,payPeriod}));
 const [config]=await rows(tx,sql`select pay_day from public.company_payroll_config where tenant_id=${reader.tenantId}::uuid and company_id=${companyId}::uuid limit 1`);
 const batches=await rows(tx,sql`select b.id,b.run_type,b.run_seq,b.status,b.batch_date,b.created_at,b.closed_at from public.payroll_batch b
  where b.tenant_id=${reader.tenantId}::uuid and b.company_id=${companyId}::uuid and b.pay_period=${payPeriod} and b.history_import_attempt_id is null order by b.run_seq,b.id`);
 for(const batch of batches){
  const batchId=String(batch.id),runType=String(batch.run_type),status=String(batch.status);
  const payDay=runType==='regular'?defaultPaymentDate(payPeriod,typeof config?.pay_day==='number'?config.pay_day:null):dayOf(batch.batch_date);
  const slips=status==='draft'?[]:await rows(tx,sql`select s.employment_id,s.net_pay,s.days_worked,s.coverage_from,e.person_id,e.last_working_date,e.terminated_on
   from public.payslip s join public.employment e on e.id=s.employment_id where s.batch_id=${batchId}::uuid order by s.employment_id`);
  // 1. Bank details changed within the window before pay day.
  if(slips.length){
   const people=[...new Set(slips.map(slip=>String(slip.person_id)))];
   const changes=await rows(tx,sql`select d.id,d.actor_id,d.occurred_at,d.payload from public.domain_event d where d.tenant_id=${reader.tenantId}::uuid
    and d.event_type='employee.bank.updated' and d.payload->>'personId' in (${sql.join(people.map(person=>sql`${person}`),sql`,`)})
    and d.occurred_at>=((${payDay}::date-${settings.bankChangeDays}::int)::timestamp at time zone 'Asia/Kuala_Lumpur')
    and d.occurred_at<((${payDay}::date+1)::timestamp at time zone 'Asia/Kuala_Lumpur') order by d.sequence`);
   const latest=new Map<string,Row>();
   for(const change of changes){
    const payload=(change.payload??{}) as {personId?:string;before?:Row;after?:Row};
    const before=payload.before??{},after=payload.after??{};
    if(digits(before.bankAccountNo)===digits(after.bankAccountNo)&&String(before.bankName??'')===String(after.bankName??''))continue;
    // A first entry (no account before) is a joiner's details arriving, not a change of them.
    if(!digits(before.bankAccountNo))continue;
    latest.set(String(payload.personId),change);
   }
   for(const slip of slips){
    const change=latest.get(String(slip.person_id));if(!change)continue;
    const payload=(change.payload??{}) as {before?:Row;after?:Row},changedOn=klDay(change.occurred_at);
    push({controlId:'bank_change_before_pay_day',batchId,employmentId:String(slip.employment_id),subjectKey:`bank_change:${batchId}:${slip.employment_id}`,
     evidence:{payDay,changedOn,daysBeforePayDay:daysBetween(changedOn,payDay),windowDays:settings.bankChangeDays,eventId:change.id,changedBy:change.actor_id??null,
      bankBefore:payload.before?.bankName??null,accountBeforeLast4:last4(payload.before?.bankAccountNo),bankAfter:payload.after?.bankName??null,
      accountAfterLast4:last4(payload.after?.bankAccountNo),netPay:slip.net_pay,runType,runSeq:batch.run_seq}});
   }
  }
  // 3. Pay after the last working day.
  for(const slip of slips){
   const lastDay=(slip.last_working_date??slip.terminated_on)?dayOf(slip.last_working_date??slip.terminated_on):null;
   const coverageFrom=slip.coverage_from?dayOf(slip.coverage_from):`${payPeriod}-01`;
   if(!lastDay||!(lastDay<coverageFrom)||!(Number(slip.net_pay)>0))continue;
   push({controlId:'pay_after_last_day',batchId,employmentId:String(slip.employment_id),subjectKey:`pay_after_last_day:${batchId}:${slip.employment_id}`,
    evidence:{lastWorkingDay:lastDay,coverageFrom,netPay:slip.net_pay,daysWorked:slip.days_worked??null,runType,runSeq:batch.run_seq}});
  }
  // 4. Pay without attendance, by the anomaly layer's own detector, for salary runs.
  if(slips.length&&runType==='regular'){
   const contexts=await tx.transaction(savepoint=>loadBatchContexts(reader,{batchId},savepoint as unknown as Tx)).catch(()=>null);
   for(const context of contexts??[]){
    for(const finding of PAY_WITHOUT_ATTENDANCE.evaluate(context,{}))
     push({controlId:'pay_without_attendance',batchId,employmentId:context.employmentId,subjectKey:`pay_without_attendance:${batchId}:${context.employmentId}`,
      evidence:{detector:finding.detectorId,severity:finding.severity,facts:finding.facts,period:context.period,runType,runSeq:batch.run_seq}});
   }
  }
  // 5. One login both processed and closed the run: a finding only where the company asked for one.
  if(status==='closed'&&settings.preparerClosedMode==='finding'){
   const trail=await rows(tx,sql`select d.event_type,d.actor_id,d.occurred_at from public.domain_event d where d.tenant_id=${reader.tenantId}::uuid and d.aggregate_id=${batchId}::uuid
    and d.actor_type='user' and d.event_type in ('payroll-batch.processed','payroll-batch.selective-reprocessed','payroll-batch.closed') order by d.sequence`);
   const preparers=new Map<string,string[]>();
   for(const item of trail.filter(row=>row.event_type!=='payroll-batch.closed'&&row.actor_id))
    preparers.set(String(item.actor_id),[...(preparers.get(String(item.actor_id))??[]),new Date(String(item.occurred_at)).toISOString()]);
   for(const close of trail.filter(row=>row.event_type==='payroll-batch.closed'&&row.actor_id)){
    const user=String(close.actor_id),prepared=preparers.get(user);if(!prepared)continue;
    push({controlId:'preparer_closed_run',batchId,employmentId:null,subjectKey:`preparer_closed:${batchId}:${user}`,
     evidence:{userId:user,processedAt:prepared,closedAt:new Date(String(close.occurred_at)).toISOString(),runType,runSeq:batch.run_seq,blocked:false}});
   }
  }
  // 6. A manual adjustment above the company's amount with no stated reason.
  const threshold=settings.adjustmentThreshold.toFixed(2);
  for(const item of await rows(tx,sql`select t.id,t.employment_id,t.amount,t.component_id from public.payroll_individual_txn t
   where (t.batch_id=${batchId}::uuid or t.consumed_batch_id=${batchId}::uuid) and coalesce(t.source,'manual')='manual'
    and abs(t.amount)>${threshold}::numeric and coalesce(btrim(t.notes),'')='' order by t.id`))
   push({controlId:'adjustment_without_reason',batchId,employmentId:String(item.employment_id),subjectKey:'adjustment:'+item.id,
    evidence:{type:'one_off_transaction',rowId:item.id,amount:item.amount,threshold,componentId:item.component_id??null,runType,runSeq:batch.run_seq}});
  for(const item of await rows(tx,sql`select c.id,c.employment_id,c.amount,c.component_id from public.payroll_batch_component c
   where c.batch_id=${batchId}::uuid and abs(c.amount)>${threshold}::numeric and coalesce(btrim(c.notes),'')='' order by c.id`))
   push({controlId:'adjustment_without_reason',batchId,employmentId:String(item.employment_id),subjectKey:'adjustment:'+item.id,
    evidence:{type:'run_component',rowId:item.id,amount:item.amount,threshold,componentId:item.component_id??null,runType,runSeq:batch.run_seq}});
  for(const item of await rows(tx,sql`select a.id,a.employment_id,a.created_by_user_id,greatest(abs(coalesce(a.pcb,0)),abs(coalesce(a.epf_employee,0)),abs(coalesce(a.socso_employee,0)),
    abs(coalesce(a.eis_employee,0)),abs(coalesce(a.epf_employer,0)),abs(coalesce(a.socso_employer,0)),abs(coalesce(a.eis_employer,0)),abs(coalesce(a.hrdf,0))) as largest
   from public.payroll_statutory_adjustment a where a.batch_id=${batchId}::uuid and coalesce(btrim(a.reason),'')=''
    and greatest(abs(coalesce(a.pcb,0)),abs(coalesce(a.epf_employee,0)),abs(coalesce(a.socso_employee,0)),abs(coalesce(a.eis_employee,0)),
     abs(coalesce(a.epf_employer,0)),abs(coalesce(a.socso_employer,0)),abs(coalesce(a.eis_employer,0)),abs(coalesce(a.hrdf,0)))>${threshold}::numeric order by a.id`))
   push({controlId:'adjustment_without_reason',batchId,employmentId:String(item.employment_id),subjectKey:'adjustment:'+item.id,
    evidence:{type:'statutory_adjustment',rowId:item.id,largestLine:item.largest,threshold,createdBy:item.created_by_user_id??null,runType,runSeq:batch.run_seq}});
  // 7. A formula or pay component changed while the run was open.
  const openedAt=new Date(String(batch.created_at)).toISOString(),closedAt=batch.closed_at?new Date(String(batch.closed_at)).toISOString():null;
  for(const item of await optional(tx,sql`select r.id,f.formula_id as code,r.ordinal,r.content_hash,r.created_at,r.created_by from public.pay_formula_revision r
   join public.pay_formula f on f.id=r.formula_id where r.tenant_id=${reader.tenantId}::uuid and r.created_at>=${openedAt}::timestamptz
    and (${closedAt}::timestamptz is null or r.created_at<=${closedAt}::timestamptz) order by r.created_at,r.id`))
   push({controlId:'formula_changed_open_period',batchId,employmentId:null,subjectKey:`formula_changed:${batchId}:${item.id}`,
    evidence:{change:'formula_revision',revisionId:item.id,formula:item.code,ordinal:item.ordinal,contentHash:item.content_hash,
     changedAt:new Date(String(item.created_at)).toISOString(),changedBy:item.created_by,runOpenedAt:openedAt,runClosedAt:closedAt,runStatus:status,runType,runSeq:batch.run_seq}});
  for(const item of await rows(tx,sql`select d.id,d.aggregate_id,d.actor_id,d.occurred_at from public.domain_event d where d.tenant_id=${reader.tenantId}::uuid
   and d.event_type='pay-component.updated' and d.occurred_at>=${openedAt}::timestamptz and (${closedAt}::timestamptz is null or d.occurred_at<=${closedAt}::timestamptz)
   order by d.sequence`))
   push({controlId:'formula_changed_open_period',batchId,employmentId:null,subjectKey:`formula_changed:${batchId}:${item.id}`,
    evidence:{change:'pay_component',eventId:item.id,componentId:item.aggregate_id,changedAt:new Date(String(item.occurred_at)).toISOString(),changedBy:item.actor_id??null,
     runOpenedAt:openedAt,runClosedAt:closedAt,runStatus:status,runType,runSeq:batch.run_seq}});
 }
 // 2. One bank account on two or more people, at least one of them paid by this company this month.
 const paid=await rows(tx,sql`select distinct e.id as employment_id,e.person_id from public.payslip s join public.payroll_batch b on b.id=s.batch_id
  join public.employment e on e.id=s.employment_id where b.tenant_id=${reader.tenantId}::uuid and b.company_id=${companyId}::uuid and b.pay_period=${payPeriod}
  and b.history_import_attempt_id is null`);
 if(paid.length){
  const shared=await rows(tx,sql`with accounts as (select m.person_id,m.bank_name,regexp_replace(coalesce(m.bank_account_no,''),'\\D','','g') as account
    from public.employee_statutory_my m where m.tenant_id=${reader.tenantId}::uuid)
   select a.account,array_agg(distinct a.person_id::text) as people,array_agg(distinct coalesce(a.bank_name,'')) as banks from accounts a
   where length(a.account)>=6 group by a.account having count(distinct a.person_id)>=2`);
  const paidPeople=new Map<string,string[]>();
  for(const item of paid)paidPeople.set(String(item.person_id),[...(paidPeople.get(String(item.person_id))??[]),String(item.employment_id)]);
  for(const group of shared){
   const people=(group.people as string[]).filter(Boolean);
   const here=people.filter(person=>paidPeople.has(person));
   if(!here.length)continue;
   const accountHash=createHash('sha256').update(`${reader.tenantId}:${group.account}`).digest('hex');
   // One finding per account and set of people, not per month: the month only says when it was first seen.
   const peopleHash=createHash('sha256').update([...people].sort().join(',')).digest('hex');
   push({controlId:'shared_bank_account',batchId:null,employmentId:null,subjectKey:`shared_bank:${companyId}:${accountHash.slice(0,32)}:${peopleHash.slice(0,16)}`,
    evidence:{accountLast4:String(group.account).slice(-4),accountHash,people:people.length,paidHere:here.length,
     employmentIds:here.flatMap(person=>paidPeople.get(person)??[]).sort(),banks:(group.banks as string[]).filter(Boolean).sort()}});
  }
 }
 return out;
}

/** Records the observations that are new. Returns how many findings were opened. */
export async function recordFindingsTx(tx:Tx,tenantId:string,writer:ControlWriter,observations:readonly ControlObservation[]):Promise<number>{
 let opened=0;
 for(let offset=0;offset<observations.length;offset+=100){
  const chunk=observations.slice(offset,offset+100);
  const inserted=await tx.insert(payrollAuditFinding).values(chunk.map(item=>({tenantId,companyId:item.companyId,payPeriod:item.payPeriod,batchId:item.batchId,
   employmentId:item.employmentId,controlId:item.controlId,subjectKey:item.subjectKey,evidence:item.evidence,writer:writer.kind,
   writerId:writer.kind==='agent'?writer.principalId:writer.userId,runId:writer.kind==='agent'?writer.runId:null}))).onConflictDoNothing().returning({id:payrollAuditFinding.id});
  opened+=inserted.length;
 }
 return opened;
}

/** A payroll administrator runs the checks for one company and month now, under their own login. */
export async function runControlChecks(supplied:SessionContext,input:Readonly<{companyId:unknown;payPeriod:unknown}>){
 const ctx:SessionContext={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(grant=>({...grant}))};
 if(!ctx.userId||ctx.agent||!isAdmin(ctx))throw new AuditFindingRefused('not_administrator');
 const companyId=z.guid().safeParse(input.companyId);
 if(!companyId.success||typeof input.payPeriod!=='string'||!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.payPeriod))throw new AuditFindingRefused('invalid');
 const p={companyId:companyId.data,payPeriod:input.payPeriod};
 return withTenant(ctx,async tx=>{
  const [allowed]=await rows(tx,sql`select app.can_admin_payroll_for(${p.companyId}::uuid) and app.is_admin_for(${p.companyId}::uuid) as ok`);
  if(allowed?.ok!==true)throw new AuditFindingRefused('not_administrator');
  const observations=await detectControlFindingsTx(tx,ctx,p);
  const opened=await recordFindingsTx(tx,ctx.tenantId,{kind:'user',userId:ctx.userId!},observations);
  return Object.freeze({observed:observations.length,opened});
 });
}

/** A payroll administrator of the finding's company disposes of it, with a note. Appended; the latest disposition is its state. */
/** Whether the caller is what a finding is about: one of its subject logins, or the person its employment belongs to. */
export async function isFindingSubjectTx(tx:Tx,userId:string,finding:Readonly<{subjectUserIds:readonly string[];employmentId:string|null}>):Promise<boolean>{
 if(finding.subjectUserIds.includes(userId))return true;
 if(!finding.employmentId)return false;
 const [own]=await rows(tx,sql`select exists(select 1 from public.employment e where e.id=${finding.employmentId}::uuid and app.is_self_person(e.person_id) is true) as ok`);
 return own?.ok===true;
}

export async function disposeFinding(supplied:SessionContext,input:Readonly<{findingId:unknown;disposition:unknown;note:unknown}>){
 const ctx:SessionContext={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(grant=>({...grant}))};
 if(!ctx.userId||ctx.agent||!canManagePayroll(ctx))throw new AuditFindingRefused('not_administrator');
 const findingId=z.guid().safeParse(input.findingId),note=typeof input.note==='string'?input.note.trim():'';
 if(!findingId.success||!isAuditDisposition(input.disposition)||note.length<1||note.length>1000)throw new AuditFindingRefused('invalid');
 const disposition:AuditDisposition=input.disposition;
 return withTenant(ctx,async tx=>{
  const [finding]=await tx.select({id:payrollAuditFinding.id,companyId:payrollAuditFinding.companyId,employmentId:payrollAuditFinding.employmentId,
   subjectUserIds:payrollAuditFinding.subjectUserIds}).from(payrollAuditFinding)
   .where(and(eq(payrollAuditFinding.tenantId,ctx.tenantId),eq(payrollAuditFinding.id,findingId.data))).limit(1);
  if(!finding)throw new AuditFindingRefused('not_found');
  const [allowed]=await rows(tx,sql`select app.can_admin_payroll_for(${finding.companyId}::uuid) as ok`);
  if(allowed?.ok!==true)throw new AuditFindingRefused('not_administrator');
  // Nobody disposes of a finding about themselves (migration 2006 refuses it too).
  if(await isFindingSubjectTx(tx,ctx.userId!,finding))throw new AuditFindingRefused('subject');
  const [row]=await tx.insert(payrollAuditDisposition).values({tenantId:ctx.tenantId,findingId:finding.id,companyId:finding.companyId,disposition,note,
   disposedByUserId:ctx.userId!}).returning();
  return Object.freeze(row!);
 });
}

/** The latest disposition of each finding, or none. */
export async function latestDispositionsTx(tx:Tx,tenantId:string,findingIds:readonly string[]){
 if(!findingIds.length)return new Map<string,typeof payrollAuditDisposition.$inferSelect>();
 const all=await tx.select().from(payrollAuditDisposition).where(and(eq(payrollAuditDisposition.tenantId,tenantId),inArray(payrollAuditDisposition.findingId,[...findingIds])))
  .orderBy(desc(payrollAuditDisposition.disposedAt),desc(payrollAuditDisposition.id));
 const latest=new Map<string,typeof payrollAuditDisposition.$inferSelect>();
 for(const row of all)if(!latest.has(row.findingId))latest.set(row.findingId,row);
 return latest;
}
