/** Payroll-owned projection of attendance allowance sources. Never overwrites unrelated batch inputs. */
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { withTenant,type SessionContext,type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { employment,payComponent, payrollBatch, payrollBatchComponent, payrollAttendanceAllowanceSource, attendanceAllowanceResult } from '../db/schema';
import { BatchNotDraftError,resolveBatchScopeFilter,type BatchScope } from './payroll';
import { allowanceCents, allowanceMoney } from '../lib/attendance-allowance-rules';
import { assertModuleEnabled } from './entitlements';
import { isUnsupportedTaxableComponent } from './pay-components';
export class AllowancePayrollConflictError extends Error {
  constructor(message='An unrelated payroll input uses this pay code. Review it in Payroll before transferring.') { super(message); this.name='AllowancePayrollConflictError'; }
}
const marker = 'Attendance allowance sources';
export type AllowancePayrollContribution = { resultId:string; employmentId:string; componentId:string; periodKey:string; amount:string };
/** Caller supplies its transaction so results, sources, totals, recalc state and events commit together. */
export async function projectAttendanceAllowanceTx(tx:Tx,ctx:SessionContext,p:{batchId:string;policyId:string;companyId:string;payMonth:string;contributions:AllowancePayrollContribution[];reprocess?:boolean}) {
  assertModuleEnabled(ctx,'payroll');
  const [batch]=await tx.select().from(payrollBatch).where(eq(payrollBatch.id,p.batchId)).for('update');
  if(!batch||batch.companyId!==p.companyId||batch.payPeriod!==p.payMonth) throw new Error('The payroll run does not belong to this policy company and payment month');
  const allowed=await tx.execute(sql`select app.is_admin_for(${batch.companyId}) as allowed`);
  if(!(allowed[0] as {allowed?:boolean})?.allowed) throw new Error('Only an authorised payroll administrator may transfer allowances');
  if(batch.status==='closed'||(batch.status!=='draft'&&!(batch.status==='processed'&&p.reprocess))) throw new BatchNotDraftError();
  // Serialise across runs too. A retry cannot post a policy/month to two runs concurrently.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${ctx.tenantId}:attendance-allowance:${p.policyId}:${p.payMonth}`},0))`);
  const other=await tx.select({id:payrollAttendanceAllowanceSource.id}).from(payrollAttendanceAllowanceSource).where(and(eq(payrollAttendanceAllowanceSource.policyId,p.policyId),eq(payrollAttendanceAllowanceSource.payMonth,p.payMonth),ne(payrollAttendanceAllowanceSource.batchId,p.batchId))).limit(1);
  if(other.length) throw new AllowancePayrollConflictError('This policy and payment month already belongs to another payroll run');
  const scope=await resolveBatchScopeFilter(tx,batch.scope as BatchScope|null);
  if(scope.employmentIds&&p.contributions.some(c=>!scope.employmentIds!.includes(c.employmentId)))throw new Error('Allowance recipient is outside the payroll run scope');
  const previous=await tx.select().from(payrollAttendanceAllowanceSource).where(and(eq(payrollAttendanceAllowanceSource.batchId,p.batchId),eq(payrollAttendanceAllowanceSource.policyId,p.policyId)));
  const touched=new Map<string,{employmentId:string;componentId:string}>();
  for(const row of [...previous,...p.contributions]) touched.set(`${row.employmentId}:${row.componentId}`,{employmentId:row.employmentId,componentId:row.componentId});
  const ids=[...new Set([...touched.values()].map(r=>r.employmentId))].sort();
  if(ids.length){
    const subjects=await tx.select({id:employment.id,allowed:sql<boolean>`app.can_admin_employment(${employment.id})`}).from(employment).where(inArray(employment.id,ids));
    if(subjects.length!==ids.length||subjects.some(r=>!r.allowed)) throw new Error('The transfer contains an employee outside your administrative scope');
  }
  // Compare every aggregate to its sources BEFORE mutation: manual edits or prior legacy inputs are
  // conflicts, even if their value happens to equal this policy's amount.
  for(const key of touched.values()){
    const sources=await tx.select().from(payrollAttendanceAllowanceSource).where(and(eq(payrollAttendanceAllowanceSource.batchId,p.batchId),eq(payrollAttendanceAllowanceSource.employmentId,key.employmentId),eq(payrollAttendanceAllowanceSource.componentId,key.componentId)));
    const [current]=await tx.select().from(payrollBatchComponent).where(and(eq(payrollBatchComponent.batchId,p.batchId),eq(payrollBatchComponent.employmentId,key.employmentId),eq(payrollBatchComponent.componentId,key.componentId))).for('update');
    const expected=allowanceMoney(sources.reduce((n,r)=>n+allowanceCents(r.amount),BigInt(0)));
    if(current ? !sources.length||current.notes!==marker||current.amount!==expected : sources.length>0) throw new AllowancePayrollConflictError();
  }
  if(previous.length){
    await tx.update(attendanceAllowanceResult).set({status:'superseded'}).where(inArray(attendanceAllowanceResult.id,previous.map(r=>r.resultId)));
    await tx.delete(payrollAttendanceAllowanceSource).where(and(eq(payrollAttendanceAllowanceSource.batchId,p.batchId),eq(payrollAttendanceAllowanceSource.policyId,p.policyId)));
  }
  for(const row of p.contributions){
    await tx.insert(payrollAttendanceAllowanceSource).values({tenantId:ctx.tenantId,companyId:p.companyId,batchId:p.batchId,policyId:p.policyId,resultId:row.resultId,employmentId:row.employmentId,componentId:row.componentId,payMonth:p.payMonth,periodKey:row.periodKey,amount:allowanceMoney(allowanceCents(row.amount))});
    await tx.update(attendanceAllowanceResult).set({status:'transferred'}).where(eq(attendanceAllowanceResult.id,row.resultId));
  }
  for(const key of touched.values()){
    const sources=await tx.select().from(payrollAttendanceAllowanceSource).where(and(eq(payrollAttendanceAllowanceSource.batchId,p.batchId),eq(payrollAttendanceAllowanceSource.employmentId,key.employmentId),eq(payrollAttendanceAllowanceSource.componentId,key.componentId)));
    const where=and(eq(payrollBatchComponent.batchId,p.batchId),eq(payrollBatchComponent.employmentId,key.employmentId),eq(payrollBatchComponent.componentId,key.componentId));
    const total=allowanceMoney(sources.reduce((n,r)=>n+allowanceCents(r.amount),BigInt(0)));
    const changed = !sources.length
      ? await tx.delete(payrollBatchComponent).where(where).returning({id:payrollBatchComponent.id})
      : await tx.insert(payrollBatchComponent).values({tenantId:ctx.tenantId,batchId:p.batchId,employmentId:key.employmentId,componentId:key.componentId,amount:total,notes:marker}).onConflictDoUpdate({target:[payrollBatchComponent.batchId,payrollBatchComponent.employmentId,payrollBatchComponent.componentId],set:{amount:total,notes:marker}}).returning({id:payrollBatchComponent.id});
    for(const input of changed)await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'payroll-batch-component',aggregateId:input.id,eventType:sources.length?'payroll-batch-component.set':'payroll-batch-component.removed',actor:actorOf(ctx),subjectEmploymentId:key.employmentId,payload:{batchId:p.batchId,componentId:key.componentId,source:'attendance-allowance',policyId:p.policyId,resultIds:sources.map(r=>r.resultId)}});
  }
  if(batch.status==='processed'&&ids.length){
    const recalc=[...new Set([...(batch.recalcEmploymentIds??[]),...ids])];
    await tx.update(payrollBatch).set({needsRecalcAt:batch.needsRecalcAt??new Date(),recalcEmploymentIds:recalc}).where(eq(payrollBatch.id,batch.id));
    await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'payroll-batch',aggregateId:batch.id,eventType:'payroll-batch.recalc-required',actor:actorOf(ctx),payload:{source:'attendance-allowance',addedEmploymentIds:ids}});
  }
  return {applied:new Set(p.contributions.map(r=>r.employmentId)).size,reversed:new Set(previous.filter(r=>!p.contributions.some(c=>c.employmentId===r.employmentId)).map(r=>r.employmentId)).size};
}

/** Attendance setup can read the existing pay-code vocabulary without purchasing Payroll processing. */
export function listAttendanceAllowancePayCodes(ctx:SessionContext){
  return withTenant(ctx,async tx=>{
    const rows=await tx.select().from(payComponent).where(eq(payComponent.tenantId,ctx.tenantId)).orderBy(payComponent.code);
    return rows.filter(c=>!c.archivedAt&&!c.isNonPayable&&(!c.rule||c.rule.kind==='fixed')&&(c.kind==='allowance'||c.kind==='deduction')&&!isUnsupportedTaxableComponent(c)).map(c=>({id:c.id,code:c.code,name:c.name,kind:c.kind}));
  });
}
