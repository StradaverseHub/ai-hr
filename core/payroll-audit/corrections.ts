/** AI v2 P2-2b — post-run corrections and their root causes.
 *
 * A post-run correction is a closed run reopened (payroll_status_history `unlock`) or a processed run reset to draft
 * (`rollback`), as the payroll owner recorded it, with the reason its operator typed. The Audit loop asks a payroll
 * administrator of the company for the root cause, chosen from a fixed list, plus a note. Each statement is appended and
 * anchored in the audit log; the latest one is the correction's root cause. The correction itself is never changed. */
import {and,desc,eq,inArray,sql} from 'drizzle-orm';
import {z} from 'zod';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {payrollAuditCorrectionCause} from '../../db/payroll-audit-schema';
import {canManagePayroll} from '../../lib/authz-model';
import {isAuditRootCause,type AuditRootCause} from './types';

export const CORRECTION_ACTIONS=Object.freeze(['unlock','rollback'] as const);
export class AuditCorrectionRefused extends Error{constructor(readonly reason:'not_administrator'|'invalid'|'not_found'){super('Audit correction refused: '+reason);this.name='AuditCorrectionRefused';}}

export type PostRunCorrection=Readonly<{correctionKey:string;batchId:string;runType:string;runSeq:number;action:'unlock'|'rollback';at:Date;actorId:string|null;
 reason:string|null;rootCause:AuditRootCause|null;note:string|null;recordedBy:string|null;recordedAt:Date|null}>;

/** The corrections of one company and month, each with its latest root cause, oldest first. */
export async function postRunCorrectionsTx(tx:Tx,tenantId:string,p:Readonly<{companyId:string;payPeriod:string}>):Promise<PostRunCorrection[]>{
 const history=Array.from(await tx.execute(sql`select h.id,h.batch_id,h.action,h.created_at,h.actor_id,h.reason,b.run_type,b.run_seq from public.payroll_status_history h
  join public.payroll_batch b on b.id=h.batch_id where b.tenant_id=${tenantId}::uuid and b.company_id=${p.companyId}::uuid and b.pay_period=${p.payPeriod}
  and h.action in ('unlock','rollback') order by h.created_at,h.id`) as unknown as {id:string;batch_id:string;action:'unlock'|'rollback';created_at:string|Date;actor_id:string|null;
  reason:string|null;run_type:string;run_seq:number}[]);
 const keys=history.map(row=>'status:'+row.id);
 const causes=keys.length?await tx.select().from(payrollAuditCorrectionCause).where(and(eq(payrollAuditCorrectionCause.tenantId,tenantId),
  eq(payrollAuditCorrectionCause.companyId,p.companyId),inArray(payrollAuditCorrectionCause.correctionKey,keys)))
  .orderBy(desc(payrollAuditCorrectionCause.recordedAt),desc(payrollAuditCorrectionCause.id)):[];
 const latest=new Map<string,(typeof causes)[number]>();
 for(const cause of causes)if(!latest.has(cause.correctionKey))latest.set(cause.correctionKey,cause);
 return history.map(row=>{const key='status:'+row.id,cause=latest.get(key);return Object.freeze({correctionKey:key,batchId:row.batch_id,runType:row.run_type,
  runSeq:Number(row.run_seq),action:row.action,at:new Date(String(row.created_at)),actorId:row.actor_id,reason:row.reason?.trim()||null,rootCause:cause?.rootCause??null,
  note:cause?.note??null,recordedBy:cause?.recordedByUserId??null,recordedAt:cause?.recordedAt??null});});
}

/** A payroll administrator of the run's company states the root cause of one correction. */
export async function recordCorrectionCause(supplied:SessionContext,input:Readonly<{correctionKey:unknown;rootCause:unknown;note:unknown}>){
 const ctx:SessionContext={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(grant=>({...grant}))};
 if(!ctx.userId||ctx.agent||!canManagePayroll(ctx))throw new AuditCorrectionRefused('not_administrator');
 const key=z.string().regex(/^status:[0-9a-f-]{36}$/).safeParse(input.correctionKey),note=typeof input.note==='string'?input.note.trim():'';
 if(!key.success||!isAuditRootCause(input.rootCause)||note.length<1||note.length>1000)throw new AuditCorrectionRefused('invalid');
 const rootCause:AuditRootCause=input.rootCause,historyId=key.data.slice('status:'.length);
 return withTenant(ctx,async tx=>{
  const [row]=await tx.execute(sql`select h.id,h.batch_id,b.company_id,b.pay_period,app.can_admin_payroll_for(b.company_id) as allowed from public.payroll_status_history h
   join public.payroll_batch b on b.id=h.batch_id where h.id=${historyId}::uuid and b.tenant_id=${ctx.tenantId}::uuid and h.action in ('unlock','rollback') limit 1`) as unknown as
   {id:string;batch_id:string;company_id:string;pay_period:string;allowed:boolean|null}[];
  if(!row)throw new AuditCorrectionRefused('not_found');
  if(row.allowed!==true)throw new AuditCorrectionRefused('not_administrator');
  const [saved]=await tx.insert(payrollAuditCorrectionCause).values({tenantId:ctx.tenantId,companyId:row.company_id,payPeriod:row.pay_period,batchId:row.batch_id,
   correctionKey:key.data,rootCause,note,recordedByUserId:ctx.userId!}).returning();
  return Object.freeze(saved!);
 });
}
