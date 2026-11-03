/** AI v2 P2-2b — the Audit loop's capture: per company and pay month, the evidence of how each payroll run came about.
 *
 * Collect (as the reader: the loop's sponsor, or the payroll administrator who asked) reads the native owners under row-level
 * security and turns each piece of evidence into one artefact: a closed kind, a stable source key and the content as the owner
 * holds it. Nothing is recalculated and no figure is derived: money, dates and counts are copied from their owners.
 *  - per run (regular, bonus and off-cycle alike): the run itself; every payslip; the inputs snapshot with one hash per
 *    component (attendance, overtime, leave, claims, pay changes, run inputs, one-off transactions, run components) as the
 *    owners hold them at capture; every change from draft to final (the run's domain events, its status history and each
 *    employee's reprocess or removal before and after) with who, when and the stated reason; each manual adjustment and
 *    override with its reason; the rule and formula versions; each exception, its disposition and who disposed of it; the
 *    approval and close trail; the payslip release and how many people opened their payslip; each post-run correction (a
 *    closed run reopened, or a processed run reset) with its root cause;
 *  - per company and month: each bank file (its sha256, record count and total, per bank and format), each statutory return
 *    and file (type, form, totals, rows, version, generated and filed), the filing evidence and receipts (core/statutory-
 *    filed.ts), who viewed or exported payroll data, pay-affecting configuration changes with before and after, and the
 *    control findings with their dispositions.
 * Append (as the writer: the agent principal for the daily loop, or the same administrator) inserts each artefact whose
 * content differs from every version already captured for its source key; an unchanged artefact is not captured again. The
 * database computes the content hash, the sequence and the link to the previous capture of the company and month, and anchors
 * each capture in the tenant audit hash chain (migration 0965). A capture is never updated or deleted.
 * No model is called. */
import {createHash} from 'node:crypto';
import {and,eq,sql,type SQL} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {payrollAuditCapture} from '../../db/payroll-audit-schema';
import {isAdmin} from '../../lib/authz-model';
import {resolveBatchCutOffWindow} from '../../packs/payroll/service';
import {periodFiledTx} from '../statutory-filed';
import {PAYROLL_ACCESS_EVENT,PAYSLIP_OPENED_EVENT,isPayPeriod,statutoryFormOf,type AuditCaptureKind} from './types';

export type AuditArtefact=Readonly<{kind:AuditCaptureKind;sourceKey:string;batchId:string|null;content:Record<string,unknown>}>;
export type CaptureWriter=Readonly<{kind:'agent';principalId:string;runId:string}>|Readonly<{kind:'user';userId:string}>;
export type CaptureResult=Readonly<{companyId:string;payPeriod:string;artefacts:number;captured:number;runs:number}>;
export class AuditCaptureRefused extends Error{constructor(readonly reason:'not_administrator'|'invalid'){super('Audit capture refused: '+reason);this.name='AuditCaptureRefused';}}

type Row=Record<string,unknown>;
const rows=async(tx:Tx,query:SQL)=>Array.from(await tx.execute(query) as unknown as Row[]);
const str=(value:unknown)=>typeof value==='string'?value:value==null?null:String(value);
/** A read that may be unavailable to this reader (a table it holds no grant on, a policy that refuses it). Inside a savepoint,
 * so a refusal leaves the capture's transaction usable and the artefact records only what could be read. */
const optional=async(tx:Tx,query:SQL):Promise<Row[]>=>{try{return await tx.transaction(savepoint=>rows(savepoint as unknown as Tx,query));}catch{return [];}};

/** Pay-affecting configuration, by domain event type prefix. Employee bank changes are employee data, followed by the
 * bank-change control, not here. */
export const CONFIG_EVENT_PREFIXES=Object.freeze(['pay-component.','payroll-policy.','payroll-cycle.','statutory.config.','statutory.component.',
 'company-statutory-authority.','company-bank-profile.','payroll-config.','pay-formula.','payslip-information.','payroll-permission-grant.']);
/** Post-run corrections: a closed run reopened, or a processed run reset to draft. */
const CORRECTION_ACTIONS=['unlock','rollback'];

const monthEnd=(period:string)=>{const y=Number(period.slice(0,4)),m=Number(period.slice(5,7));return `${period}-${String(new Date(Date.UTC(y,m,0)).getUTCDate()).padStart(2,'0')}`;};
const nextMonth=(period:string)=>{const y=Number(period.slice(0,4)),m=Number(period.slice(5,7));return m===12?`${y+1}-01`:`${y}-${String(m+1).padStart(2,'0')}`;};

/** One component of the inputs snapshot: how many owner rows, and the sha256 of all of them as the owner holds them. */
async function componentTx(tx:Tx,label:string,query:SQL){
 const [row]=await rows(tx,sql`select count(*)::int as n,app.payroll_audit_hash(coalesce(jsonb_agg(to_jsonb(x) order by x.id)::text,'[]')) as hash from (${query}) x`);
 return [label,{rows:Number(row?.n??0),hash:str(row?.hash)}] as const;
}

/** Every artefact of one company and pay month, read as `reader`. Read-only. */
export async function collectPayrollPeriodArtefactsTx(tx:Tx,reader:SessionContext,p:Readonly<{companyId:string;payPeriod:string}>):Promise<AuditArtefact[]>{
 const {companyId,payPeriod}=p,out:AuditArtefact[]=[];
 // Instants render in UTC whatever the session, so the same owner row always yields the same content and hash.
 await tx.execute(sql`set local timezone='UTC'`);
 const push=(kind:AuditCaptureKind,sourceKey:string,batchId:string|null,content:Record<string,unknown>)=>out.push(Object.freeze({kind,sourceKey,batchId,content}));
 const batches=await rows(tx,sql`select b.id,to_jsonb(b) as batch,pp.statutory_version,
  case when c.id is null then null else jsonb_build_object('id',c.id,'name',c.name,'code',c.code,'runType',c.run_type) end as cycle
  from public.payroll_batch b join public.pay_period pp on pp.id=b.pay_period_id left join public.payroll_cycle c on c.id=b.payroll_cycle_id
  where b.tenant_id=${reader.tenantId}::uuid and b.company_id=${companyId}::uuid and b.pay_period=${payPeriod} order by b.run_seq,b.id`);
 const windowOf=async(type:'attendance'|'overtime'|'claim'|'leave')=>{
  try{return await tx.transaction(savepoint=>resolveBatchCutOffWindow(savepoint as unknown as Tx,companyId,type,payPeriod));}
  catch{return {start:`${payPeriod}-01`,end:monthEnd(payPeriod)};}
 };
 const windows={attendance:await windowOf('attendance'),overtime:await windowOf('overtime'),claim:await windowOf('claim'),leave:await windowOf('leave')};
 for(const batch of batches){
  const batchId=String(batch.id);
  push('run','run:'+batchId,batchId,{batch:batch.batch,statutoryVersion:batch.statutory_version??null,cycle:batch.cycle??null});
  const slips=await rows(tx,sql`select s.employment_id,to_jsonb(s) as payslip,e.employee_code from public.payslip s join public.employment e on e.id=s.employment_id
   where s.batch_id=${batchId}::uuid order by s.employment_id`);
  for(const slip of slips)push('payslip',`payslip:${batchId}:${slip.employment_id}`,batchId,{payslip:slip.payslip,employeeCode:slip.employee_code??null});
  const emps=slips.map(slip=>String(slip.employment_id));
  const inList=emps.length?sql`(${sql.join(emps.map(e=>sql`${e}::uuid`),sql`,`)})`:sql`(null::uuid)`;
  const components:Record<string,{rows:number;hash:string|null}>={};
  for(const [label,query] of [
   ['attendance',sql`select a.* from public.attendance a where a.employment_id in ${inList} and a.attendance_date between ${windows.attendance.start}::date and ${windows.attendance.end}::date`],
   ['overtime',sql`select a.id,a.employment_id,a.attendance_date,a.ot_minutes,a.ot_flat_minutes,a.ot00_minutes,a.ot10_minutes,a.ot15_minutes,a.ot20_minutes,a.ot30_minutes
    from public.attendance a where a.employment_id in ${inList} and a.attendance_date between ${windows.overtime.start}::date and ${windows.overtime.end}::date and coalesce(a.ot_minutes,0)>0`],
   ['leave',sql`select l.* from public.leave_request l where l.employment_id in ${inList} and l.start_date<=${windows.leave.end}::date and l.end_date>=${windows.leave.start}::date`],
   ['claims',sql`select c.* from public.claim_request c where c.payroll_batch_id=${batchId}::uuid
    or (c.employment_id in ${inList} and c.incurred_on between ${windows.claim.start}::date and ${windows.claim.end}::date)`],
   ['payChanges',sql`select c.* from public.compensation c where c.employment_id in ${inList} and c.valid_from<=${monthEnd(payPeriod)}::date
    and (c.valid_to is null or c.valid_to>=${payPeriod+'-01'}::date)`],
   ['runInputs',sql`select i.* from public.payroll_input i where i.batch_id=${batchId}::uuid`],
   ['transactions',sql`select t.* from public.payroll_individual_txn t where t.batch_id=${batchId}::uuid or t.consumed_batch_id=${batchId}::uuid`],
   ['runComponents',sql`select c.* from public.payroll_batch_component c where c.batch_id=${batchId}::uuid`],
  ] as const){const [key,value]=await componentTx(tx,label,query);components[key]=value;}
  push('inputs_snapshot','inputs:'+batchId,batchId,{status:str((batch.batch as Row)?.status),employments:emps.length,windows,components});
  // Every change from draft to final: the run's own events, its status history and each employee's before and after.
  const events=await rows(tx,sql`select d.id,d.aggregate_type,d.event_type,d.actor_type::text as actor_type,d.actor_id,d.subject_employment_id,d.payload,d.occurred_at,d.chain_seq,d.hash
   from public.domain_event d where d.tenant_id=${reader.tenantId}::uuid and (d.aggregate_id=${batchId}::uuid or d.payload->>'batchId'=${batchId})
    and d.event_type not in (${PAYROLL_ACCESS_EVENT},${PAYSLIP_OPENED_EVENT}) and d.aggregate_type<>'payroll-audit' order by d.sequence`);
  for(const event of events)push('change','event:'+event.id,batchId,{eventId:event.id,aggregateType:event.aggregate_type,eventType:event.event_type,actorType:event.actor_type,
   actorId:event.actor_id??null,subjectEmploymentId:event.subject_employment_id??null,occurredAt:event.occurred_at,payload:event.payload??null,
   chainSeq:event.chain_seq??null,chainHash:event.hash??null});
  const history=await rows(tx,sql`select h.id,h.action,to_jsonb(h) as row from public.payroll_status_history h where h.batch_id=${batchId}::uuid order by h.created_at,h.id`);
  for(const item of history)push('change','status:'+item.id,batchId,{statusHistory:item.row});
  const results=await rows(tx,sql`select r.id,to_jsonb(r) as row from public.payroll_employee_result_history r where r.batch_id=${batchId}::uuid order by r.created_at,r.id`);
  for(const item of results)push('change','result:'+item.id,batchId,{employeeResult:item.row});
  // Manual adjustments and overrides, each with its reason as the owner holds it.
  for(const item of await rows(tx,sql`select a.id,to_jsonb(a) as row from public.payroll_statutory_adjustment a where a.batch_id=${batchId}::uuid order by a.id`))
   push('adjustment','stat_adj:'+item.id,batchId,{type:'statutory_adjustment',row:item.row,reason:str((item.row as Row).reason)});
  for(const item of await rows(tx,sql`select t.id,to_jsonb(t) as row from public.payroll_individual_txn t where (t.batch_id=${batchId}::uuid or t.consumed_batch_id=${batchId}::uuid)
   and coalesce(t.source,'manual')='manual' order by t.id`))
   push('adjustment','txn:'+item.id,batchId,{type:'one_off_transaction',row:item.row,reason:str((item.row as Row).notes)});
  for(const item of await rows(tx,sql`select c.id,to_jsonb(c) as row from public.payroll_batch_component c where c.batch_id=${batchId}::uuid order by c.id`))
   push('adjustment','component:'+item.id,batchId,{type:'run_component',row:item.row,reason:str((item.row as Row).notes)});
  // Rule and formula versions: the statutory version of the month, the rule sets and overrides in force, and each formula
  // revision and pay component the run used.
  const ruleSets=await optional(tx,sql`select r.id,r.country,r.version,r.effective_from,app.payroll_audit_hash(r.data::text) as data_hash from public.statutory_ruleset r
   where r.archived_at is null and r.effective_from<=${monthEnd(payPeriod)}::date order by r.country,r.effective_from desc,r.id`);
  const overrides=await optional(tx,sql`select o.id,o.country,o.body,o.version,o.effective_from,app.payroll_audit_hash(o.data::text) as data_hash from public.statutory_component_override o
   where o.archived_at is null and o.effective_from<=${monthEnd(payPeriod)}::date order by o.country,o.body,o.effective_from desc,o.id`);
  const formulas=await optional(tx,sql`select distinct v.revision_id,r.ordinal,r.content_hash,f.formula_id as code,v.component_code from public.pay_formula_evaluation v
   join public.pay_formula_revision r on r.id=v.revision_id join public.pay_formula f on f.id=v.formula_id where v.batch_id=${batchId}::uuid order by f.formula_id,r.ordinal`);
  const payComponents=await optional(tx,sql`select pc.id,pc.code,app.payroll_audit_hash(to_jsonb(pc)::text) as definition_hash from public.pay_component pc
   where pc.id in (select component_id from public.payroll_batch_component where batch_id=${batchId}::uuid
    union select component_id from public.payroll_individual_txn where batch_id=${batchId}::uuid or consumed_batch_id=${batchId}::uuid) order by pc.code,pc.id`);
  const slipVersions=await rows(tx,sql`select distinct s.statutory->>'version' as version from public.payslip s where s.batch_id=${batchId}::uuid and s.statutory ? 'version' order by 1`);
  push('rule_version','rules:'+batchId,batchId,{statutoryVersion:batch.statutory_version??null,payslipStatutoryVersions:slipVersions.map(item=>item.version),
   ruleSets,overrides,formulas,payComponents});
  // Each exception, its disposition and who disposed of it. The anomaly narrative is model text and is left out.
  const verdicts=await optional(tx,sql`select v.id,to_jsonb(v) as verdict,coalesce((select jsonb_agg(to_jsonb(f)-'narrative' order by f.id) from public.payroll_anomaly_finding f where f.verdict_id=v.id),'[]'::jsonb) as findings
   from public.payroll_anomaly_verdict v where v.batch_id=${batchId}::uuid order by v.employment_id,v.computed_at,v.id`);
  for(const item of verdicts)push('exception','verdict:'+item.id,batchId,{verdict:item.verdict,findings:item.findings});
  // The approval and close trail, and the release.
  const pick=(types:readonly string[])=>events.filter(event=>types.includes(String(event.event_type))).map(event=>({eventId:event.id,actorType:event.actor_type,actorId:event.actor_id??null,at:event.occurred_at}));
  const runRow=(batch.batch??{}) as Row;
  push('approval','approval:'+batchId,batchId,{processed:pick(['payroll-batch.processed','payroll-batch.selective-reprocessed']),closed:pick(['payroll-batch.closed']),
   unlocked:pick(['payroll-batch.unlocked']),reset:pick(['payroll-batch.reset']),status:runRow.status??null,closedAt:runRow.closed_at??null,releasedAt:runRow.released_at??null,
   closeHistory:history.filter(item=>item.action==='close').map(item=>item.row)});
  const [opens]=await rows(tx,sql`select count(*)::int as events,count(distinct d.subject_employment_id)::int as people from public.domain_event d
   where d.tenant_id=${reader.tenantId}::uuid and d.event_type=${PAYSLIP_OPENED_EVENT} and d.payload->>'batchId'=${batchId}`);
  push('payslip_release','release:'+batchId,batchId,{releasedAt:runRow.released_at??null,payslips:slips.length,openedBy:Number(opens?.people??0),openEvents:Number(opens?.events??0)});
  // Post-run corrections, each with every root cause stated for it.
  for(const item of history.filter(row=>CORRECTION_ACTIONS.includes(String(row.action)))){
   const causes=await rows(tx,sql`select c.id,c.root_cause,c.note,c.recorded_by_user_id,c.recorded_at from public.payroll_audit_correction_cause c
    where c.tenant_id=${reader.tenantId}::uuid and c.company_id=${companyId}::uuid and c.correction_key=${'status:'+item.id} order by c.recorded_at,c.id`);
   push('correction','correction:'+item.id,batchId,{correctionKey:'status:'+item.id,statusHistory:item.row,rootCauses:causes});
  }
 }
 // Company and month: bank files (hash, never the file), statutory returns and files, filing evidence.
 for(const item of await optional(tx,sql`select x.id,x.format,x.value_date,x.tape_id,x.bank_profile_id,bp.bank,x.record_count,x.total_cents,x.filename,x.source_digest,
   x.actor_user_id,x.created_at,app.payroll_audit_hash(x.content) as content_sha256,d.payload->>'periodKey' as period_key,coalesce((d.payload->>'testFile')::boolean,false) as test_file
   from public.bank_payment_export x join public.domain_event d on d.aggregate_id=x.id and d.event_type='bank-payment-file.generated' and d.tenant_id=x.tenant_id
   left join public.company_bank_profile bp on bp.id=x.bank_profile_id
   where x.tenant_id=${reader.tenantId}::uuid and x.company_id=${companyId}::uuid and d.payload->>'periodKey'=${payPeriod} order by x.created_at,x.id`))
  push('bank_file','bank:'+item.id,null,{exportId:item.id,format:item.format,bank:item.bank??null,bankProfileId:item.bank_profile_id,valueDate:item.value_date,tapeId:item.tape_id,
   recordCount:item.record_count,totalCents:Number(item.total_cents),filename:item.filename,fileSha256:item.content_sha256,sourceDigest:item.source_digest,
   generatedBy:item.actor_user_id,generatedAt:item.created_at,testFile:item.test_file===true});
 for(const item of await rows(tx,sql`select r.id,to_jsonb(r) as row,r.report_type from public.statutory_report r where r.tenant_id=${reader.tenantId}::uuid and r.company_id=${companyId}::uuid
   and r.period_key in (${payPeriod},${payPeriod.slice(0,4)}) order by r.generated_at,r.id`))
  push('statutory_file','report:'+item.id,null,{form:statutoryFormOf(String(item.report_type)),report:item.row});
 try{
  const filed=await tx.transaction(savepoint=>periodFiledTx(savepoint as unknown as Tx,{companyId,periodKey:payPeriod}));
  push('filing',`filing:${companyId}:${payPeriod}`,null,{visible:true,filed:filed.filed,evidence:filed.evidence});
 }catch{push('filing',`filing:${companyId}:${payPeriod}`,null,{visible:false,filed:null,evidence:[]});}
 // Who viewed or exported this company's payroll data for the month.
 for(const event of await rows(tx,sql`select d.id,d.actor_type::text as actor_type,d.actor_id,d.payload,d.occurred_at from public.domain_event d
   where d.tenant_id=${reader.tenantId}::uuid and d.event_type=${PAYROLL_ACCESS_EVENT} and d.payload->>'companyId'=${companyId} and d.payload->>'payPeriod'=${payPeriod}
   order by d.sequence`))
  push('access','access:'+event.id,str((event.payload as Row|null)?.batchId),{eventId:event.id,actorType:event.actor_type,actorId:event.actor_id??null,at:event.occurred_at,entry:event.payload});
 // Pay-affecting configuration changes, before and after as each owner recorded them: from the first day of the pay month to
 // the end of the following month (when the month is processed, closed, filed and corrected).
 const from=`${payPeriod}-01`,to=monthEnd(nextMonth(payPeriod));
 const prefixes=sql.join(CONFIG_EVENT_PREFIXES.map(prefix=>sql`d.event_type like ${prefix+'%'}`),sql` or `);
 for(const event of await rows(tx,sql`select d.id,d.aggregate_type,d.aggregate_id,d.event_type,d.actor_type::text as actor_type,d.actor_id,d.payload,d.occurred_at from public.domain_event d
   where d.tenant_id=${reader.tenantId}::uuid and (${prefixes}) and (d.payload->>'companyId' is null or d.payload->>'companyId'=${companyId})
    and d.occurred_at>=(${from}::date::timestamp at time zone 'Asia/Kuala_Lumpur') and d.occurred_at<((${to}::date+1)::timestamp at time zone 'Asia/Kuala_Lumpur')
   order by d.sequence`))
  push('config_change','config:'+event.id,null,{eventId:event.id,aggregateType:event.aggregate_type,aggregateId:event.aggregate_id,eventType:event.event_type,
   actorType:event.actor_type,actorId:event.actor_id??null,at:event.occurred_at,payload:event.payload??null});
 // The control findings for the month, each with every disposition.
 for(const item of await rows(tx,sql`select f.id,f.batch_id,to_jsonb(f) as finding,coalesce((select jsonb_agg(to_jsonb(d) order by d.disposed_at,d.id) from public.payroll_audit_disposition d
   where d.finding_id=f.id and d.tenant_id=f.tenant_id),'[]'::jsonb) as dispositions from public.payroll_audit_finding f
   where f.tenant_id=${reader.tenantId}::uuid and f.company_id=${companyId}::uuid and f.pay_period=${payPeriod} order by f.detected_at,f.id`))
  push('control_finding','finding:'+item.id,str(item.batch_id),{finding:item.finding,dispositions:item.dispositions});
 return out;
}

/** The largest artefact kept whole (migration 0965 bounds a capture at 1 MiB of canonical text). A larger one, such as the
 * processing event of a very large run, is kept as its own sha256 and size, so the capture still proves what it was. */
const MAX_CONTENT_CHARS=700_000;
const bounded=(content:Record<string,unknown>):Record<string,unknown>=>{
 const text=JSON.stringify(content);
 return text.length<=MAX_CONTENT_CHARS?content:{oversize:true,sha256:createHash('sha256').update(text).digest('hex'),chars:text.length};
};

/** Appends the artefacts that are new or changed. Returns how many were captured. */
export async function appendCapturesTx(tx:Tx,tenantId:string,writer:CaptureWriter,p:Readonly<{companyId:string;payPeriod:string}>,artefacts:readonly AuditArtefact[]):Promise<number>{
 let captured=0;
 for(let offset=0;offset<artefacts.length;offset+=100){
  const chunk=artefacts.slice(offset,offset+100);
  const inserted=await tx.insert(payrollAuditCapture).values(chunk.map(item=>({tenantId,companyId:p.companyId,payPeriod:p.payPeriod,batchId:item.batchId,kind:item.kind,
   sourceKey:item.sourceKey,content:bounded(item.content),writer:writer.kind,writerId:writer.kind==='agent'?writer.principalId:writer.userId,
   runId:writer.kind==='agent'?writer.runId:null}))).onConflictDoNothing().returning({id:payrollAuditCapture.id});
  captured+=inserted.length;
 }
 return captured;
}

/** A payroll administrator captures one company and month now, under their own login (before an audit pack is built). Group
 * or HR administrators only: the payroll audit trail reads domain events, which only administrators may read. */
export async function capturePayrollPeriod(supplied:SessionContext,input:Readonly<{companyId:unknown;payPeriod:unknown}>):Promise<CaptureResult>{
 const ctx:SessionContext={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(grant=>({...grant}))};
 if(!ctx.userId||ctx.agent||!isAdmin(ctx))throw new AuditCaptureRefused('not_administrator');
 if(typeof input.companyId!=='string'||!/^[0-9a-f-]{36}$/i.test(input.companyId)||!isPayPeriod(input.payPeriod))throw new AuditCaptureRefused('invalid');
 const p={companyId:input.companyId,payPeriod:input.payPeriod};
 return withTenant(ctx,async tx=>{
  const [allowed]=await rows(tx,sql`select app.can_admin_payroll_for(${p.companyId}::uuid) and app.is_admin_for(${p.companyId}::uuid) as ok`);
  if(allowed?.ok!==true)throw new AuditCaptureRefused('not_administrator');
  const artefacts=await collectPayrollPeriodArtefactsTx(tx,ctx,p);
  const captured=await appendCapturesTx(tx,ctx.tenantId,{kind:'user',userId:ctx.userId!},p,artefacts);
  return Object.freeze({...p,artefacts:artefacts.length,captured,runs:artefacts.filter(item=>item.kind==='run').length});
 });
}

/** The pay months the daily loop captures for a company: this month and the two before it (a month is filed by the 15th of the
 * next one, and corrected after that). */
export function auditPeriodsFor(today:string):readonly string[]{
 const month=today.slice(0,7),prev=(period:string)=>{const y=Number(period.slice(0,4)),m=Number(period.slice(5,7));return m===1?`${y-1}-12`:`${y}-${String(m-1).padStart(2,'0')}`;};
 return Object.freeze([prev(prev(month)),prev(month),month]);
}

/** The captures of one company and month, in chain order, as the caller may read them. */
export async function listCapturesTx(tx:Tx,tenantId:string,p:Readonly<{companyId:string;payPeriod:string}>){
 return tx.select().from(payrollAuditCapture).where(and(eq(payrollAuditCapture.tenantId,tenantId),eq(payrollAuditCapture.companyId,p.companyId),
  eq(payrollAuditCapture.payPeriod,p.payPeriod))).orderBy(payrollAuditCapture.seq);
}
