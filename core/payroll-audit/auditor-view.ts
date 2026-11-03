/** AI v2 Phase 2 hardening (4 November 2026) — the Audit loop page for a granted auditor: read-only, for the companies the
 * auditor holds a current grant for, consistent with that grant (migration 2006, payroll_audit_reader).
 *
 * The grant lets a named login read a company's Audit loop and audit pack, nothing else: not the payroll runs, payslips,
 * statutory reports or domain events themselves. So this view is built only from what the Audit loop captured for the
 * month (payroll_audit_capture, read under app.payroll_audit_can_read) and its findings, dispositions and settings, the
 * same evidence the auditor's audit pack holds. It mirrors the administrator's view (core/payroll-audit/status.ts
 * auditLoopDetail) so the page renders both with the same parts, and it never offers a command: no capture, disposition,
 * root cause, setting, grant, switch or pause. A company the auditor holds no current grant for is never in view, whatever
 * the request names. Read under the auditor's own row-level security; no figure is calculated. */
import {and,desc,eq,inArray,sql,type SQL} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {payrollAuditCapture,payrollAuditFinding} from '../../db/payroll-audit-schema';
import {latestDispositionsTx} from './controls';
import {auditReaderCompaniesTx} from './reader-grant';
export {auditReaderCompaniesTx,hasAuditReaderGrant} from './reader-grant';
import {controlSettingsTx} from './settings';
import {AuditViewRefused,acknowledgedFindingsTx,statutoryDueDate,type AuditCompanyStatus,type AuditFindingView,type AuditFormStatus,type AuditLoopDetail,type AuditRunStatus} from './status';
import type {PostRunCorrection} from './corrections';
import {STATUTORY_FILED_STATUSES} from '../../db/schema';
import {AUDIT_LOOP_ID,AUDIT_STATUTORY_FORMS,STATUTORY_FORM_TYPES,isPayPeriod,type AuditControlId,type AuditRootCause} from './types';

type Row=Record<string,unknown>;
const rows=async(tx:Tx,query:SQL)=>Array.from(await tx.execute(query) as unknown as Row[]);
const at=(value:unknown)=>value==null||value===''?null:value instanceof Date?value:new Date(String(value));
const klDay=(value:unknown)=>{const d=at(value);return d&&Number.isFinite(d.getTime())?new Date(d.getTime()+8*3_600_000).toISOString().slice(0,10):null;};
const prevMonth=(period:string)=>{const y=Number(period.slice(0,4)),m=Number(period.slice(5,7));return m===1?`${y-1}-12`:`${y}-${String(m-1).padStart(2,'0')}`;};

/** The latest capture of each source key of one company and month, by kind. */
async function latestCapturesTx(tx:Tx,tenantId:string,companyId:string,payPeriod:string){
 const all=await tx.select({sourceKey:payrollAuditCapture.sourceKey,kind:payrollAuditCapture.kind,content:payrollAuditCapture.content,seq:payrollAuditCapture.seq,
  capturedAt:payrollAuditCapture.capturedAt,chainHash:payrollAuditCapture.chainHash}).from(payrollAuditCapture)
  .where(and(eq(payrollAuditCapture.tenantId,tenantId),eq(payrollAuditCapture.companyId,companyId),eq(payrollAuditCapture.payPeriod,payPeriod)))
  .orderBy(payrollAuditCapture.seq);
 const latest=new Map<string,(typeof all)[number]>();
 for(const row of all)latest.set(row.sourceKey,row);
 const ofKind=(kind:string)=>[...latest.values()].filter(row=>row.kind===kind);
 return {all,ofKind};
}

async function companyTx(tx:Tx,ctx:SessionContext,item:{id:string;name:string;paused:boolean},payPeriod:string){
 const {all,ofKind}=await latestCapturesTx(tx,ctx.tenantId,item.id,payPeriod);
 const runs:AuditRunStatus[]=ofKind('run').map(row=>{const b=((row.content as {batch?:Row}).batch??{}) as Row;
  return Object.freeze({batchId:String(b.id??''),runType:String(b.run_type??''),runSeq:Number(b.run_seq??0),status:String(b.status??''),closedAt:at(b.closed_at),releasedAt:at(b.released_at)});})
  .filter(run=>run.batchId!=='').sort((a,b)=>a.runSeq-b.runSeq);
 const releases=ofKind('payslip_release').map(row=>row.content as {releasedAt?:unknown;payslips?:number;openedBy?:number});
 const payslips=Object.freeze({total:releases.reduce((n,r)=>n+Number(r.payslips??0),0),
  released:releases.filter(r=>r.releasedAt!=null).reduce((n,r)=>n+Number(r.payslips??0),0),opened:releases.reduce((n,r)=>n+Number(r.openedBy??0),0)});
 const reports=ofKind('statutory_file').map(row=>(row.content as {report?:Row}).report??{});
 const due=statutoryDueDate(payPeriod);
 // What the month required is what the captured payslips say: any PCB deducted, any HRD levy charged.
 const slips=ofKind('payslip').map(row=>((row.content as {payslip?:Row}).payslip??{}) as Row);
 const charged=(key:string)=>slips.some(slip=>Number(((slip.statutory??{}) as Row)[key]??0)>0);
 const statutory:AuditFormStatus[]=AUDIT_STATUTORY_FORMS.map(form=>{
  const types=STATUTORY_FORM_TYPES[form],own=reports.filter(r=>types.includes(String(r.report_type)));
  const prepared=own.map(r=>klDay(r.generated_at)).filter((d):d is string=>!!d).sort();
  const filed=own.filter(r=>(STATUTORY_FILED_STATUSES as readonly string[]).includes(String(r.status))&&String(r.ack_ref??'').trim()!=='');
  const filedOn=filed.map(r=>r.filed_on==null?null:String(r.filed_on).slice(0,10)).filter((d):d is string=>!!d).sort();
  const required=form==='pcb_cp39'?charged('pcb'):form==='hrd'?charged('hrdf'):true;
  return Object.freeze({form,required,prepared:prepared.length>0,preparedOn:prepared[0]??null,beforeDue:prepared[0]?prepared[0]<=due:null,
   filed:filed.length>0,filedOn:filedOn[0]??null,receipt:filed.length>0});
 });
 const banks=new Map<string,{bank:string|null;format:string;files:number;records:number;totalCents:number}>();
 for(const row of ofKind('bank_file')){const c=row.content as Row,key=`${String(c.format??'')}|${String(c.bank??'')}`;
  const hit=banks.get(key)??{bank:c.bank==null?null:String(c.bank),format:String(c.format??''),files:0,records:0,totalCents:0};
  hit.files++;hit.records+=Number(c.recordCount??0);hit.totalCents+=Number(c.totalCents??0);banks.set(key,hit);}
 const corrections:PostRunCorrection[]=ofKind('correction').map(row=>{const c=row.content as {correctionKey?:string;statusHistory?:Row;rootCauses?:Row[]};
  const h=c.statusHistory??{},cause=(c.rootCauses??[]).at(-1);const run=runs.find(r=>r.batchId===String(h.batch_id??''));
  return Object.freeze({correctionKey:String(c.correctionKey??''),batchId:String(h.batch_id??''),runType:run?.runType??'',runSeq:run?.runSeq??0,
   action:(h.action==='rollback'?'rollback':'unlock') as 'unlock'|'rollback',at:at(h.created_at)??new Date(0),actorId:h.actor_id==null?null:String(h.actor_id),
   reason:typeof h.reason==='string'&&h.reason.trim()?h.reason.trim():null,rootCause:(cause?.root_cause??null) as AuditRootCause|null,
   note:cause?.note==null?null:String(cause.note),recordedBy:cause?.recorded_by_user_id==null?null:String(cause.recorded_by_user_id),recordedAt:at(cause?.recorded_at)});});
 const own=await tx.select({id:payrollAuditFinding.id,controlId:payrollAuditFinding.controlId,employmentId:payrollAuditFinding.employmentId}).from(payrollAuditFinding)
  .where(and(eq(payrollAuditFinding.tenantId,ctx.tenantId),eq(payrollAuditFinding.companyId,item.id),eq(payrollAuditFinding.payPeriod,payPeriod)));
 const earlier=await tx.select({id:payrollAuditFinding.id,controlId:payrollAuditFinding.controlId,employmentId:payrollAuditFinding.employmentId}).from(payrollAuditFinding)
  .where(and(eq(payrollAuditFinding.tenantId,ctx.tenantId),eq(payrollAuditFinding.companyId,item.id),eq(payrollAuditFinding.controlId,'shared_bank_account'),
   sql`${payrollAuditFinding.payPeriod}<${payPeriod}`));
 const earlierLatest=await latestDispositionsTx(tx,ctx.tenantId,earlier.map(row=>row.id));
 const findings=[...own,...earlier.filter(row=>!earlierLatest.has(row.id))];
 const latest=await latestDispositionsTx(tx,ctx.tenantId,findings.map(row=>row.id));
 const previous=await tx.selectDistinct({controlId:payrollAuditFinding.controlId}).from(payrollAuditFinding)
  .where(and(eq(payrollAuditFinding.tenantId,ctx.tenantId),eq(payrollAuditFinding.companyId,item.id),eq(payrollAuditFinding.payPeriod,prevMonth(payPeriod))));
 const before=new Set(previous.map(row=>row.controlId));
 const covered=await acknowledgedFindingsTx(tx,ctx.tenantId,item.id,findings);
 const open=findings.filter(row=>!latest.has(row.id)&&!covered.has(row.id)).length,withoutRootCause=corrections.filter(row=>!row.rootCause).length;
 const acknowledged=findings.filter(row=>!latest.has(row.id)&&covered.has(row.id)).length;
 const head=all.at(-1);
 const status:AuditCompanyStatus=Object.freeze({companyId:item.id,companyName:item.name,paused:item.paused,runs:Object.freeze(runs),payslips,statutory:Object.freeze(statutory),
  bank:Object.freeze({files:[...banks.values()].reduce((n,row)=>n+row.files,0),byBank:Object.freeze([...banks.values()].map(row=>Object.freeze(row)))}),
  corrections:Object.freeze({count:corrections.length,withoutRootCause}),findings:Object.freeze({open,disposed:findings.length-open-acknowledged,acknowledged}),
  repeatIssues:Object.freeze([...new Set(own.filter(row=>!covered.has(row.id)).map(row=>row.controlId))].filter(id=>before.has(id)).sort() as AuditControlId[]),
  captures:Object.freeze({count:all.length,lastAt:head?.capturedAt??null,head:head?.chainHash??null}),settings:await controlSettingsTx(tx,ctx.tenantId,item.id),
  done:runs.length>0&&runs.every(run=>run.status==='closed'&&run.releasedAt!==null)&&statutory.every(form=>!form.required||form.filed)&&open===0&&withoutRootCause===0});
 return {status,corrections,findingIds:findings.map(row=>row.id),covered};
}

/** The read-only Audit loop page of an auditor: the month, the granted companies (optionally one of them). */
export async function auditorLoopDetail(supplied:SessionContext,input:Readonly<{payPeriod:unknown;companyIds?:readonly string[]}>):Promise<AuditLoopDetail>{
 const ctx:SessionContext={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(grant=>({...grant}))};
 if(!ctx.userId||ctx.agent)throw new AuditViewRefused('not_administrator');
 if(!isPayPeriod(input.payPeriod))throw new AuditViewRefused('invalid');
 const payPeriod=input.payPeriod;
 return withTenant(ctx,async tx=>{
  const granted=await auditReaderCompaniesTx(tx,ctx);
  const wanted=input.companyIds?.length?new Set(input.companyIds):null;
  const scope=granted.filter(row=>!wanted||wanted.has(row.id));
  const paused=scope.length?new Set((await rows(tx,sql`select p.company_id from public.teras_loop_pause p where p.tenant_id=${ctx.tenantId}::uuid
   and p.worker_id=${AUDIT_LOOP_ID} and p.paused and p.company_id in (${sql.join(scope.map(row=>sql`${row.id}::uuid`),sql`,`)})`)).map(row=>String(row.company_id))):new Set<string>();
  const companies:AuditCompanyStatus[]=[],corrections:(PostRunCorrection&{companyId:string;companyName:string})[]=[],findingIds:string[]=[];
  const acks=new Map<string,{id:string;scope:'person'|'group'|'company';reason:string;reviewOn:string|null}>();
  for(const item of scope){
   const result=await companyTx(tx,ctx,{...item,paused:paused.has(item.id)},payPeriod);
   companies.push(result.status);findingIds.push(...result.findingIds);
   for(const [id,ack] of result.covered)acks.set(id,{id:ack.id,scope:ack.scope,reason:ack.reason,reviewOn:ack.reviewOn});
   corrections.push(...result.corrections.map(row=>Object.freeze({...row,companyId:item.id,companyName:item.name})));
  }
  const latest=await latestDispositionsTx(tx,ctx.tenantId,findingIds);
  const found=findingIds.length?await tx.select().from(payrollAuditFinding).where(and(eq(payrollAuditFinding.tenantId,ctx.tenantId),inArray(payrollAuditFinding.id,findingIds)))
   .orderBy(desc(payrollAuditFinding.detectedAt),desc(payrollAuditFinding.id)):[];
  // An auditor may not read the person behind a finding: only what the finding itself holds is shown.
  const findings:AuditFindingView[]=found.map(row=>{const d=latest.get(row.id);return Object.freeze({id:row.id,companyId:row.companyId,controlId:row.controlId,batchId:row.batchId,
   employmentId:row.employmentId,personName:null,employeeCode:null,detectedAt:row.detectedAt,evidence:row.evidence,evidenceHash:row.evidenceHash,
   disposition:d?.disposition??null,note:d?.note??null,disposedBy:d?.disposedByUserId??null,disposedAt:d?.disposedAt??null,
   acknowledgement:acks.has(row.id)?Object.freeze(acks.get(row.id)!):null});})
   .sort((a,b)=>Number(a.disposition!==null)-Number(b.disposition!==null)||b.detectedAt.getTime()-a.detectedAt.getTime());
  const control=await rows(tx,sql`select w.enabled from public.teras_worker_control w where w.tenant_id=${ctx.tenantId}::uuid and w.worker_id=${AUDIT_LOOP_ID}`);
  const totals=Object.freeze({payslips:companies.reduce((n,c)=>n+c.payslips.total,0),released:companies.reduce((n,c)=>n+c.payslips.released,0),
   opened:companies.reduce((n,c)=>n+c.payslips.opened,0),formsPrepared:companies.reduce((n,c)=>n+c.statutory.filter(f=>f.required&&f.prepared).length,0),
   formsFiled:companies.reduce((n,c)=>n+c.statutory.filter(f=>f.required&&f.filed).length,0),forms:companies.reduce((n,c)=>n+c.statutory.filter(f=>f.required).length,0),
   bankFiles:companies.reduce((n,c)=>n+c.bank.files,0),corrections:companies.reduce((n,c)=>n+c.corrections.count,0),
   correctionsWithoutRootCause:companies.reduce((n,c)=>n+c.corrections.withoutRootCause,0),openFindings:companies.reduce((n,c)=>n+c.findings.open,0),
   repeatIssues:companies.reduce((n,c)=>n+c.repeatIssues.length,0),captures:companies.reduce((n,c)=>n+c.captures.count,0),companiesDone:companies.filter(c=>c.done).length});
  return Object.freeze({payPeriod,dueDate:statutoryDueDate(payPeriod),level:'prepare' as const,
   loop:Object.freeze({on:control[0]?.enabled===true,sponsorUserId:null,sponsorName:null}),companies:Object.freeze(companies),totals,canCapture:false,
   findings:Object.freeze(findings),corrections:Object.freeze(corrections.sort((a,b)=>b.at.getTime()-a.at.getTime()))});
 });
}

/** The companies of the auditor's page picker. */
export async function auditorCompanies(ctx:SessionContext){
 if(!ctx.userId||ctx.agent)throw new AuditViewRefused('not_administrator');
 return withTenant(ctx,async tx=>(await auditReaderCompaniesTx(tx,ctx)).map(row=>Object.freeze({id:row.id,name:row.name,group:false})));
}

