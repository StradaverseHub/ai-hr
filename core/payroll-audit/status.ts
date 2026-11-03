/** AI v2 P2-2b — the Audit loop's status and detail: the read behind its column on the Payroll cycle page and its own page.
 *
 * For one pay month and the companies the viewer administers (optionally narrowed to some of them), per company:
 *  - payslips released, and how many people opened theirs;
 *  - each statutory file (EPF, SOCSO and EIS, PCB CP39, HRD Corp): prepared, on which day and whether before its due date
 *    (the 15th of the next month), and filed with a receipt (a person files and records the receipt; nothing is submitted
 *    from here);
 *  - bank files recorded for the month, by bank and format (each file's hash is captured; whether a run's bank total equals
 *    its net pay is the Salary payroll loop's check, owner decision 1);
 *  - post-run corrections (target zero), and how many still lack a root cause;
 *  - the control findings, open and disposed, and the repeat issues: checks that found something this month and last month
 *    too, which the next Pre-salary loop reads (`repeatAuditIssues`);
 *  - the captures: how many, the latest, and the chain head.
 * Done when every run is closed and released, every statutory file is filed with a receipt, no finding is open and every
 * correction has a root cause. The loop stays at Prepare: it never files, submits, closes or changes anything.
 * Group or HR administrators only, under their own row-level security; counts come straight from their owners. */
import {and,count,desc,eq,inArray,max,sql,type SQL} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {company,STATUTORY_FILED_STATUSES} from '../../db/schema';
import {payrollAuditCapture,payrollAuditFinding} from '../../db/payroll-audit-schema';
import {isAdmin,isGroupAdmin} from '../../lib/authz-model';
import {postRunCorrectionsTx,type PostRunCorrection} from './corrections';
import {latestDispositionsTx} from './controls';
import {controlSettingsTx,type AuditControlSettings} from './settings';
import {AUDIT_LOOP_ID,AUDIT_STATUTORY_FORMS,PAYROLL_ACCESS_EVENT,PAYSLIP_OPENED_EVENT,STATUTORY_DUE_DAY,STATUTORY_FORM_TYPES,isPayPeriod,
 type AuditControlId,type AuditDisposition,type AuditStatutoryForm} from './types';

export class AuditViewRefused extends Error{constructor(readonly reason:'not_administrator'|'invalid'){super('Audit view refused: '+reason);this.name='AuditViewRefused';}}

export type AuditFormStatus=Readonly<{form:AuditStatutoryForm;prepared:boolean;preparedOn:string|null;beforeDue:boolean|null;filed:boolean;filedOn:string|null;receipt:boolean}>;
export type AuditRunStatus=Readonly<{batchId:string;runType:string;runSeq:number;status:string;closedAt:Date|null;releasedAt:Date|null}>;
export type AuditFindingView=Readonly<{id:string;controlId:AuditControlId;batchId:string|null;employmentId:string|null;personName:string|null;employeeCode:string|null;
 detectedAt:Date;evidence:Record<string,unknown>;evidenceHash:string;disposition:AuditDisposition|null;note:string|null;disposedBy:string|null;disposedAt:Date|null}>;
export type AuditCompanyStatus=Readonly<{companyId:string;companyName:string;paused:boolean;runs:readonly AuditRunStatus[];
 payslips:Readonly<{total:number;released:number;opened:number}>;statutory:readonly AuditFormStatus[];
 bank:Readonly<{files:number;byBank:readonly Readonly<{bank:string|null;format:string;files:number;records:number;totalCents:number}>[]}>;
 corrections:Readonly<{count:number;withoutRootCause:number}>;findings:Readonly<{open:number;disposed:number}>;repeatIssues:readonly AuditControlId[];
 captures:Readonly<{count:number;lastAt:Date|null;head:string|null}>;settings:AuditControlSettings;done:boolean}>;
export type AuditLoopSummary=Readonly<{payPeriod:string;dueDate:string;level:'prepare';loop:Readonly<{on:boolean;sponsorUserId:string|null;sponsorName:string|null}>;
 companies:readonly AuditCompanyStatus[];
 totals:Readonly<{payslips:number;released:number;opened:number;formsPrepared:number;formsFiled:number;forms:number;bankFiles:number;corrections:number;
  correctionsWithoutRootCause:number;openFindings:number;repeatIssues:number;captures:number;companiesDone:number}>;
 canCapture:boolean}>;
export type AuditLoopDetail=AuditLoopSummary&Readonly<{findings:readonly AuditFindingView[];corrections:readonly (PostRunCorrection&{companyId:string;companyName:string})[]}>;

type Row=Record<string,unknown>;
const rows=async(tx:Tx,query:SQL)=>Array.from(await tx.execute(query) as unknown as Row[]);
const nextMonth=(period:string)=>{const y=Number(period.slice(0,4)),m=Number(period.slice(5,7));return m===12?`${y+1}-01`:`${y}-${String(m+1).padStart(2,'0')}`;};
const prevMonth=(period:string)=>{const y=Number(period.slice(0,4)),m=Number(period.slice(5,7));return m===1?`${y-1}-12`:`${y}-${String(m-1).padStart(2,'0')}`;};
/** Until the 15th the month being audited is last month (its statutory files are due then); after it, this month. */
export const defaultAuditPeriod=(today:string)=>Number(today.slice(8,10))<=STATUTORY_DUE_DAY?prevMonth(today.slice(0,7)):today.slice(0,7);
export const statutoryDueDate=(payPeriod:string)=>`${nextMonth(payPeriod)}-${String(STATUTORY_DUE_DAY).padStart(2,'0')}`;
const dayOf=(value:unknown)=>value==null?null:value instanceof Date?value.toISOString().slice(0,10):String(value).slice(0,10);
const klDay=(value:unknown)=>{if(value==null)return null;const at=value instanceof Date?value:new Date(String(value));return new Date(at.getTime()+8*3_600_000).toISOString().slice(0,10);};
const at=(value:unknown)=>value==null?null:value instanceof Date?value:new Date(String(value));

async function formsTx(tx:Tx,tenantId:string,companyId:string,payPeriod:string):Promise<AuditFormStatus[]>{
 const due=statutoryDueDate(payPeriod),filedStatuses=[...STATUTORY_FILED_STATUSES] as string[];
 const reports=await rows(tx,sql`select r.report_type,r.status,r.generated_at,r.filed_on,r.ack_ref from public.statutory_report r
  where r.tenant_id=${tenantId}::uuid and r.company_id=${companyId}::uuid and r.period_key=${payPeriod}`);
 const exports=await rows(tx,sql`select d.payload->>'detail' as type,d.occurred_at from public.domain_event d where d.tenant_id=${tenantId}::uuid
  and d.event_type=${PAYROLL_ACCESS_EVENT} and d.payload->>'surface'='statutory_file' and d.payload->>'companyId'=${companyId} and d.payload->>'payPeriod'=${payPeriod}`);
 const receipts=await rows(tx,sql`select p.paid_on,p.receipt_ref from public.pcb_payment p where p.tenant_id=${tenantId}::uuid and p.company_id=${companyId}::uuid
  and p.period_key=${payPeriod} and coalesce(btrim(p.receipt_ref),'')<>''`);
 return AUDIT_STATUTORY_FORMS.map(form=>{
  const types=STATUTORY_FORM_TYPES[form];
  const prepared=[...reports.filter(row=>types.includes(String(row.report_type))).map(row=>klDay(row.generated_at)),
   ...exports.filter(row=>types.includes(String(row.type))).map(row=>klDay(row.occurred_at))].filter((day):day is string=>!!day).sort();
  const filed=reports.filter(row=>types.includes(String(row.report_type))&&filedStatuses.includes(String(row.status))&&String(row.ack_ref??'').trim()!=='');
  const filedOn=[...filed.map(row=>dayOf(row.filed_on)),...(form==='pcb_cp39'?receipts.map(row=>dayOf(row.paid_on)):[])].filter((day):day is string=>!!day).sort();
  const preparedOn=prepared[0]??null,isFiled=filed.length>0||(form==='pcb_cp39'&&receipts.length>0);
  return Object.freeze({form,prepared:prepared.length>0,preparedOn,beforeDue:preparedOn?preparedOn<=due:null,filed:isFiled,filedOn:filedOn[0]??null,receipt:isFiled});
 });
}

async function companyStatusTx(tx:Tx,ctx:SessionContext,item:{id:string;name:string;paused:boolean},payPeriod:string):Promise<{status:AuditCompanyStatus;corrections:PostRunCorrection[];findingIds:string[]}>{
 const runs=(await rows(tx,sql`select b.id,b.run_type,b.run_seq,b.status,b.closed_at,b.released_at from public.payroll_batch b where b.tenant_id=${ctx.tenantId}::uuid
  and b.company_id=${item.id}::uuid and b.pay_period=${payPeriod} and b.history_import_attempt_id is null order by b.run_seq,b.id`))
  .map(row=>Object.freeze({batchId:String(row.id),runType:String(row.run_type),runSeq:Number(row.run_seq),status:String(row.status),closedAt:at(row.closed_at),releasedAt:at(row.released_at)}));
 const [slips]=await rows(tx,sql`select count(*)::int as total,count(*) filter (where b.released_at is not null and b.released_at<=now())::int as released
  from public.payslip s join public.payroll_batch b on b.id=s.batch_id where b.tenant_id=${ctx.tenantId}::uuid and b.company_id=${item.id}::uuid
  and b.pay_period=${payPeriod} and b.history_import_attempt_id is null`);
 const [opened]=await rows(tx,sql`select count(distinct d.subject_employment_id)::int as n from public.domain_event d where d.tenant_id=${ctx.tenantId}::uuid
  and d.event_type=${PAYSLIP_OPENED_EVENT} and d.payload->>'companyId'=${item.id} and d.payload->>'payPeriod'=${payPeriod}`);
 const statutory=await formsTx(tx,ctx.tenantId,item.id,payPeriod);
 const banks=(await rows(tx,sql`select bp.bank,x.format,count(*)::int as files,sum(x.record_count)::int as records,sum(x.total_cents)::bigint as total_cents
  from public.bank_payment_export x join public.domain_event d on d.aggregate_id=x.id and d.event_type='bank-payment-file.generated' and d.tenant_id=x.tenant_id
  left join public.company_bank_profile bp on bp.id=x.bank_profile_id where x.tenant_id=${ctx.tenantId}::uuid and x.company_id=${item.id}::uuid
  and d.payload->>'periodKey'=${payPeriod} group by bp.bank,x.format order by x.format,bp.bank`))
  .map(row=>Object.freeze({bank:row.bank==null?null:String(row.bank),format:String(row.format),files:Number(row.files),records:Number(row.records),totalCents:Number(row.total_cents)}));
 const corrections=await postRunCorrectionsTx(tx,ctx.tenantId,{companyId:item.id,payPeriod});
 const findings=await tx.select({id:payrollAuditFinding.id,controlId:payrollAuditFinding.controlId}).from(payrollAuditFinding)
  .where(and(eq(payrollAuditFinding.tenantId,ctx.tenantId),eq(payrollAuditFinding.companyId,item.id),eq(payrollAuditFinding.payPeriod,payPeriod)));
 const latest=await latestDispositionsTx(tx,ctx.tenantId,findings.map(row=>row.id));
 const previous=await tx.selectDistinct({controlId:payrollAuditFinding.controlId}).from(payrollAuditFinding)
  .where(and(eq(payrollAuditFinding.tenantId,ctx.tenantId),eq(payrollAuditFinding.companyId,item.id),eq(payrollAuditFinding.payPeriod,prevMonth(payPeriod))));
 const before=new Set(previous.map(row=>row.controlId));
 const repeatIssues=[...new Set(findings.map(row=>row.controlId))].filter(id=>before.has(id)).sort();
 const [captures]=await tx.select({n:count(),lastAt:max(payrollAuditCapture.capturedAt)}).from(payrollAuditCapture)
  .where(and(eq(payrollAuditCapture.tenantId,ctx.tenantId),eq(payrollAuditCapture.companyId,item.id),eq(payrollAuditCapture.payPeriod,payPeriod)));
 const [head]=await tx.select({hash:payrollAuditCapture.chainHash}).from(payrollAuditCapture)
  .where(and(eq(payrollAuditCapture.tenantId,ctx.tenantId),eq(payrollAuditCapture.companyId,item.id),eq(payrollAuditCapture.payPeriod,payPeriod)))
  .orderBy(desc(payrollAuditCapture.seq)).limit(1);
 const open=findings.filter(row=>!latest.has(row.id)).length;
 const withoutRootCause=corrections.filter(row=>!row.rootCause).length;
 const done=runs.length>0&&runs.every(run=>run.status==='closed'&&run.releasedAt!==null)&&statutory.every(form=>form.filed)&&open===0&&withoutRootCause===0;
 const status:AuditCompanyStatus=Object.freeze({companyId:item.id,companyName:item.name,paused:item.paused,runs:Object.freeze(runs),
  payslips:Object.freeze({total:Number(slips?.total??0),released:Number(slips?.released??0),opened:Number(opened?.n??0)}),statutory:Object.freeze(statutory),
  bank:Object.freeze({files:banks.reduce((n,row)=>n+row.files,0),byBank:Object.freeze(banks)}),
  corrections:Object.freeze({count:corrections.length,withoutRootCause}),findings:Object.freeze({open,disposed:findings.length-open}),
  repeatIssues:Object.freeze(repeatIssues),captures:Object.freeze({count:Number(captures?.n??0),lastAt:captures?.lastAt??null,head:head?.hash??null}),
  settings:await controlSettingsTx(tx,ctx.tenantId,item.id),done});
 return {status,corrections,findingIds:findings.map(row=>row.id)};
}

async function scopeTx(tx:Tx,ctx:SessionContext,companyIds:readonly string[]|undefined){
 const list=await rows(tx,sql`select c.id,c.legal_name,coalesce(p.paused,false) as paused from public.company c
  left join public.teras_loop_pause p on p.tenant_id=c.tenant_id and p.company_id=c.id and p.worker_id=${AUDIT_LOOP_ID}
  where c.tenant_id=${ctx.tenantId}::uuid and app.is_admin_for(c.id) and app.can_admin_payroll_for(c.id) order by c.legal_name,c.id`);
 const wanted=companyIds?.length?new Set(companyIds):null;
 return list.filter(row=>!wanted||wanted.has(String(row.id))).map(row=>({id:String(row.id),name:String(row.legal_name),paused:row.paused===true}));
}

const totalsOf=(companies:readonly AuditCompanyStatus[])=>Object.freeze({
 payslips:companies.reduce((n,c)=>n+c.payslips.total,0),released:companies.reduce((n,c)=>n+c.payslips.released,0),opened:companies.reduce((n,c)=>n+c.payslips.opened,0),
 formsPrepared:companies.reduce((n,c)=>n+c.statutory.filter(f=>f.prepared).length,0),formsFiled:companies.reduce((n,c)=>n+c.statutory.filter(f=>f.filed).length,0),
 forms:companies.length*AUDIT_STATUTORY_FORMS.length,bankFiles:companies.reduce((n,c)=>n+c.bank.files,0),
 corrections:companies.reduce((n,c)=>n+c.corrections.count,0),correctionsWithoutRootCause:companies.reduce((n,c)=>n+c.corrections.withoutRootCause,0),
 openFindings:companies.reduce((n,c)=>n+c.findings.open,0),repeatIssues:companies.reduce((n,c)=>n+c.repeatIssues.length,0),
 captures:companies.reduce((n,c)=>n+c.captures.count,0),companiesDone:companies.filter(c=>c.done).length});

function requireAdmin(ctx:SessionContext,payPeriod:unknown):asserts payPeriod is string{
 if(!ctx.userId||ctx.agent||!isAdmin(ctx))throw new AuditViewRefused('not_administrator');
 if(!isPayPeriod(payPeriod))throw new AuditViewRefused('invalid');
}

async function loopStateTx(tx:Tx,tenantId:string){
 const [control]=await rows(tx,sql`select w.enabled,w.changed_by_user_id,p.full_name from public.teras_worker_control w left join public.app_user u on u.id=w.changed_by_user_id
  left join public.person p on p.id=u.person_id where w.tenant_id=${tenantId}::uuid and w.worker_id=${AUDIT_LOOP_ID}`);
 const on=control?.enabled===true;
 return Object.freeze({on,sponsorUserId:on&&control?.changed_by_user_id?String(control.changed_by_user_id):null,
  sponsorName:on&&control?.full_name?String(control.full_name):null});
}

/** The Audit loop's column: one pay month, the companies in scope. */
export async function auditLoopSummary(ctx:SessionContext,input:Readonly<{payPeriod:unknown;companyIds?:readonly string[]}>):Promise<AuditLoopSummary>{
 requireAdmin(ctx,input.payPeriod);
 const payPeriod=input.payPeriod;
 return withTenant(ctx,async tx=>{
  const companies:AuditCompanyStatus[]=[];
  for(const item of await scopeTx(tx,ctx,input.companyIds))companies.push((await companyStatusTx(tx,ctx,item,payPeriod)).status);
  return Object.freeze({payPeriod,dueDate:statutoryDueDate(payPeriod),level:'prepare' as const,loop:await loopStateTx(tx,ctx.tenantId),
   companies:Object.freeze(companies),totals:totalsOf(companies),canCapture:isAdmin(ctx)});
 });
}

/** The Audit loop's own page: the summary plus every finding and correction, newest first. */
export async function auditLoopDetail(ctx:SessionContext,input:Readonly<{payPeriod:unknown;companyIds?:readonly string[]}>):Promise<AuditLoopDetail>{
 requireAdmin(ctx,input.payPeriod);
 const payPeriod=input.payPeriod;
 return withTenant(ctx,async tx=>{
  const companies:AuditCompanyStatus[]=[],corrections:(PostRunCorrection&{companyId:string;companyName:string})[]=[],findingIds:string[]=[];
  for(const item of await scopeTx(tx,ctx,input.companyIds)){
   const result=await companyStatusTx(tx,ctx,item,payPeriod);
   companies.push(result.status);findingIds.push(...result.findingIds);
   corrections.push(...result.corrections.map(row=>Object.freeze({...row,companyId:item.id,companyName:item.name})));
  }
  const latest=await latestDispositionsTx(tx,ctx.tenantId,findingIds);
  const found=findingIds.length?await rows(tx,sql`select f.id,f.control_id,f.batch_id,f.employment_id,f.detected_at,f.evidence,f.evidence_hash,p.full_name,e.employee_code
   from public.payroll_audit_finding f left join public.employment e on e.id=f.employment_id left join public.person p on p.id=e.person_id
   where f.tenant_id=${ctx.tenantId}::uuid and f.id in (${sql.join(findingIds.map(id=>sql`${id}::uuid`),sql`,`)}) order by f.detected_at desc,f.id`):[];
  const findings=found.map(row=>{const d=latest.get(String(row.id));return Object.freeze({id:String(row.id),controlId:row.control_id as AuditControlId,
   batchId:row.batch_id==null?null:String(row.batch_id),employmentId:row.employment_id==null?null:String(row.employment_id),personName:row.full_name==null?null:String(row.full_name),
   employeeCode:row.employee_code==null?null:String(row.employee_code),detectedAt:at(row.detected_at)!,evidence:(row.evidence??{}) as Record<string,unknown>,
   evidenceHash:String(row.evidence_hash),disposition:d?.disposition??null,note:d?.note??null,disposedBy:d?.disposedByUserId??null,disposedAt:d?.disposedAt??null});})
   .sort((a,b)=>Number(a.disposition!==null)-Number(b.disposition!==null)||b.detectedAt.getTime()-a.detectedAt.getTime());
  return Object.freeze({payPeriod,dueDate:statutoryDueDate(payPeriod),level:'prepare' as const,loop:await loopStateTx(tx,ctx.tenantId),
   companies:Object.freeze(companies),totals:totalsOf(companies),canCapture:isAdmin(ctx),findings:Object.freeze(findings),
   corrections:Object.freeze(corrections.sort((a,b)=>b.at.getTime()-a.at.getTime()))});
 });
}

/** The checks that found something in this pay month and the month before, per company: what the next Pre-salary loop should
 * look at first. Read by P2-2a's Pre-salary loop; never a figure, only control ids. */
export async function repeatAuditIssues(ctx:SessionContext,input:Readonly<{payPeriod:unknown;companyIds:readonly string[]}>):Promise<ReadonlyMap<string,readonly AuditControlId[]>>{
 requireAdmin(ctx,input.payPeriod);
 const payPeriod=input.payPeriod;
 if(!input.companyIds.length)return new Map();
 return withTenant(ctx,async tx=>{
  const found=await tx.selectDistinct({companyId:payrollAuditFinding.companyId,controlId:payrollAuditFinding.controlId,payPeriod:payrollAuditFinding.payPeriod})
   .from(payrollAuditFinding).where(and(eq(payrollAuditFinding.tenantId,ctx.tenantId),inArray(payrollAuditFinding.companyId,[...input.companyIds]),
    inArray(payrollAuditFinding.payPeriod,[payPeriod,prevMonth(payPeriod)])));
  const out=new Map<string,AuditControlId[]>();
  for(const companyId of input.companyIds){
   const now=new Set(found.filter(row=>row.companyId===companyId&&row.payPeriod===payPeriod).map(row=>row.controlId));
   const then=new Set(found.filter(row=>row.companyId===companyId&&row.payPeriod!==payPeriod).map(row=>row.controlId));
   const repeat=[...now].filter(id=>then.has(id)).sort();
   if(repeat.length)out.set(companyId,repeat);
  }
  return out;
 });
}

/** Group administrators see every company; others the ones they administer. Exposed for the page's company picker. */
export async function auditCompanies(ctx:SessionContext){
 if(!ctx.userId||ctx.agent||!isAdmin(ctx))throw new AuditViewRefused('not_administrator');
 return withTenant(ctx,async tx=>(await tx.select({id:company.id,name:company.legalName}).from(company)
  .where(and(eq(company.tenantId,ctx.tenantId),sql`app.is_admin_for(${company.id}) and app.can_admin_payroll_for(${company.id})`)).orderBy(company.legalName,company.id))
  .map(row=>Object.freeze({...row,group:isGroupAdmin(ctx)})));
}
