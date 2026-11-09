/** Payroll-owned projection of attendance allowance sources. Never overwrites unrelated batch inputs. */
import {bindAttendanceFormulaOvertimeTx,readPayrollOvertimePatternCashTx} from './payroll-overtime-pattern';
import type {AttendanceFormulaConfiguration} from '../lib/attendance-formula-model';
import {planAttendanceFormulaPosting} from '../lib/attendance-formula-posting';
import {attendanceFormulaEligibleForPeriodTx,readAttendanceFormulaResultTx,attendanceFormulaResultStateTx,replayAttendanceFormulaResultTx,appendAttendanceFormulaResultEventTx} from '../packs/attendance/service';
import {applyFormulaAmount,multiplyFormulaDecimal,divideFormulaDecimal,roundFormulaDecimal} from '../lib/pay-formula-language';
import { and, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { withTenant,type SessionContext,type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { employment,payComponent, payrollBatch, payrollBatchComponent, payrollAttendanceAllowanceSource, attendanceAllowanceResult,attendanceFormulaResult,payrollCycle,company } from '../db/schema';
import { BatchNotDraftError,resolveBatchScopeFilter,type BatchScope } from './payroll';
import { allowanceCents, allowanceMoney } from '../lib/attendance-allowance-rules';
import { assertModuleEnabled } from './entitlements';
import { isUnsupportedTaxableComponent } from './pay-components';
import {BASIC_PAY_CODE,isStatutoryComponent} from './pay-rule';
import { assertPayComponentReady } from '../lib/pay-component-contract';
export class AllowancePayrollConflictError extends Error {
  constructor(message='An unrelated payroll input uses this pay code. Review it in Payroll before transferring.') { super(message); this.name='AllowancePayrollConflictError'; }
}
const marker = 'Attendance allowance sources';
export type AllowancePayrollContribution = { resultId:string; employmentId:string; componentId:string; periodKey:string; amount:string };
/** Caller supplies its transaction so results, sources, totals, recalc state and events commit together. */
export async function projectAttendanceAllowanceTx(tx:Tx,ctx:SessionContext,p:{batchId:string;companyId:string;payMonth:string;contributions:AllowancePayrollContribution[];reprocess?:boolean}&({kind?:'allowance';policyId:string}|{kind:'formula';formulaId:string})) {
  assertModuleEnabled(ctx,'payroll');
  const formula=p.kind==='formula',ownerId=p.kind==='formula'?p.formulaId:p.policyId,ownerColumn=formula?payrollAttendanceAllowanceSource.formulaId:payrollAttendanceAllowanceSource.policyId;
  const [batch]=await tx.select().from(payrollBatch).where(eq(payrollBatch.id,p.batchId)).for('update');
  if(!batch||batch.companyId!==p.companyId||batch.payPeriod!==p.payMonth) throw new Error('The payroll run does not belong to this policy company and payment month');
  const allowed=await tx.execute(sql`select app.is_admin_for(${batch.companyId}) as allowed`);
  if(!(allowed[0] as {allowed?:boolean})?.allowed) throw new Error('Only an authorised payroll administrator may transfer allowances');
  if(batch.status==='closed'||(batch.status!=='draft'&&!(batch.status==='processed'&&p.reprocess))) throw new BatchNotDraftError();
  // Serialise across runs too. A retry cannot post a policy/month to two runs concurrently.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${ctx.tenantId}:attendance-allowance:${ownerId}:${p.payMonth}`},0))`);
  const other=await tx.select({id:payrollAttendanceAllowanceSource.id}).from(payrollAttendanceAllowanceSource).where(and(eq(ownerColumn,ownerId),eq(payrollAttendanceAllowanceSource.payMonth,p.payMonth),ne(payrollAttendanceAllowanceSource.batchId,p.batchId))).limit(1);
  if(other.length) throw new AllowancePayrollConflictError('This policy and payment month already belongs to another payroll run');
  const scope=await resolveBatchScopeFilter(tx,batch.scope as BatchScope|null);
  if(scope.employmentIds&&p.contributions.some(c=>!scope.employmentIds!.includes(c.employmentId)))throw new Error('Allowance recipient is outside the payroll run scope');
  if(formula&&p.contributions.length){const recurring=await tx.execute<{id:string}>(sql`select e.id from employment_pay_component e join attendance_formula_result r on r.employment_id=e.employment_id and r.pay_component_id=e.component_id and r.tenant_id=e.tenant_id where e.tenant_id=app.current_tenant_id() and r.id=any(array[${sql.join(p.contributions.map(row=>sql`${row.resultId}::uuid`),sql`, `)}]::uuid[]) and e.superseded_at is null and e.valid_from<=r.period_to and(e.valid_to is null or e.valid_to>=r.period_from) limit 1`);if(recurring.length)throw new AllowancePayrollConflictError('A recurring Payroll item already uses this employee, Pay Item and period. Review that existing input before transferring.');}
  const componentIds=[...new Set(p.contributions.map(c=>c.componentId))];
  if(componentIds.length){const components=await tx.select({code:payComponent.code,pendingInputKind:payComponent.pendingInputKind}).from(payComponent).where(inArray(payComponent.id,componentIds));for(const component of components)assertPayComponentReady(component);}
  const previous=await tx.select().from(payrollAttendanceAllowanceSource).where(and(eq(payrollAttendanceAllowanceSource.batchId,p.batchId),eq(ownerColumn,ownerId)));
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
    if(sources.some(source=>formula?source.policyId!==null:source.formulaId!==null))throw new AllowancePayrollConflictError('This employee and Pay Item already belongs to another Attendance configuration owner. Use one owner before transferring.');
    const [current]=await tx.select().from(payrollBatchComponent).where(and(eq(payrollBatchComponent.batchId,p.batchId),eq(payrollBatchComponent.employmentId,key.employmentId),eq(payrollBatchComponent.componentId,key.componentId))).for('update');
    const expected=allowanceMoney(sources.reduce((n,r)=>n+allowanceCents(r.amount),BigInt(0)));
    if(current ? !sources.length||current.notes!==marker||current.amount!==expected : sources.length>0) throw new AllowancePayrollConflictError();
  }
  if(previous.length){
    if(!formula)await tx.update(attendanceAllowanceResult).set({status:'superseded'}).where(inArray(attendanceAllowanceResult.id,previous.flatMap(r=>r.resultId?[r.resultId]:[])));
    await tx.delete(payrollAttendanceAllowanceSource).where(and(eq(payrollAttendanceAllowanceSource.batchId,p.batchId),eq(ownerColumn,ownerId)));
  }
  for(const row of p.contributions){
    await tx.insert(payrollAttendanceAllowanceSource).values({tenantId:ctx.tenantId,companyId:p.companyId,batchId:p.batchId,...(formula?{formulaId:ownerId,formulaResultId:row.resultId}:{policyId:ownerId,resultId:row.resultId}),employmentId:row.employmentId,componentId:row.componentId,payMonth:p.payMonth,periodKey:row.periodKey,amount:allowanceMoney(allowanceCents(row.amount))});
    if(!formula)await tx.update(attendanceAllowanceResult).set({status:'transferred'}).where(eq(attendanceAllowanceResult.id,row.resultId));
  }
  for(const key of touched.values()){
    const sources=await tx.select().from(payrollAttendanceAllowanceSource).where(and(eq(payrollAttendanceAllowanceSource.batchId,p.batchId),eq(payrollAttendanceAllowanceSource.employmentId,key.employmentId),eq(payrollAttendanceAllowanceSource.componentId,key.componentId)));
    const where=and(eq(payrollBatchComponent.batchId,p.batchId),eq(payrollBatchComponent.employmentId,key.employmentId),eq(payrollBatchComponent.componentId,key.componentId));
    const total=allowanceMoney(sources.reduce((n,r)=>n+allowanceCents(r.amount),BigInt(0)));
    const changed = !sources.length
      ? await tx.delete(payrollBatchComponent).where(where).returning({id:payrollBatchComponent.id})
      : await tx.insert(payrollBatchComponent).values({tenantId:ctx.tenantId,batchId:p.batchId,employmentId:key.employmentId,componentId:key.componentId,amount:total,notes:marker}).onConflictDoUpdate({target:[payrollBatchComponent.batchId,payrollBatchComponent.employmentId,payrollBatchComponent.componentId],set:{amount:total,notes:marker}}).returning({id:payrollBatchComponent.id});
    for(const input of changed)await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'payroll-batch-component',aggregateId:input.id,eventType:sources.length?'payroll-batch-component.set':'payroll-batch-component.removed',actor:actorOf(ctx),subjectEmploymentId:key.employmentId,payload:{batchId:p.batchId,componentId:key.componentId,source:'attendance-allowance',ownerId,resultIds:sources.map(r=>r.formulaResultId??r.resultId)}});
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
    return rows.filter(c=>!c.archivedAt&&c.pendingInputKind==null&&!c.isNonPayable&&(!c.rule||c.rule.kind==='fixed')&&(c.kind==='allowance'||c.kind==='deduction')&&!isUnsupportedTaxableComponent(c)).map(c=>({id:c.id,code:c.code,name:c.name,kind:c.kind}));
  });
}

/** Pay Item owns quantity pricing. The Attendance engine supplies a typed quantity, never a rate. */
export function priceAttendanceFormulaQuantity(component:typeof payComponent.$inferSelect,p:{quantity:string;unit:'amount'|'minutes'|'hours'|'days'}){
 assertPayComponentReady(component);
 if(component.archivedAt||component.isNonPayable||component.code.trim().toUpperCase()===BASIC_PAY_CODE||isStatutoryComponent(component.code,component.kind)||isUnsupportedTaxableComponent(component)||!['allowance','deduction'].includes(component.kind))throw Error('Choose an active payable earning or deduction Pay Item.');
 const rule=component.rule;
 let amount=p.quantity,rate:string|null=null;
 // A complete formula amount is already priced, as with Native's other source-owned amounts.
 // Only quantity output asks the catalogue to supply a rate; generation must not reprice either.
 if(p.unit==='amount'){}
 else if((p.unit==='minutes'||p.unit==='hours')&&rule?.kind==='per_hour'){
  rate=String(rule.rate);amount=multiplyFormulaDecimal(p.unit==='minutes'?divideFormulaDecimal(p.quantity,'60'):p.quantity,rate);
 }else if(p.unit==='days'&&rule?.kind==='per_day'){rate=String(rule.rate);amount=multiplyFormulaDecimal(p.quantity,rate);}
 else throw Error('The formula output unit does not match the Pay Item pricing rule.');
 const rounding=component.roundingMethod??'none';if(!['none','up','down','nearest'].includes(rounding))throw Error('The Pay Item rounding rule is unsupported.');
 amount=applyFormulaAmount(roundFormulaDecimal(amount,2),{rounding:rounding as 'none'|'up'|'down'|'nearest'});if(amount.startsWith('-')||allowanceCents(amount)>BigInt('999999999999'))throw Error('The calculated amount exceeds the supported Payroll amount.');
 return {amount:allowanceMoney(allowanceCents(amount)),rate};
}

/** Existing Payroll contribution owner consumes DB-owned, freshly replayed approved formula results. */
export function transferAttendanceFormulaResults(ctx:SessionContext,p:{batchId:string;resultIds:string[];reason:string}){return withTenant(ctx,async tx=>{
 assertModuleEnabled(ctx,'payroll');assertModuleEnabled(ctx,'typed_pay_components');
 if(!ctx.userId||!Array.isArray(p.resultIds)||!p.resultIds.length||p.resultIds.length>128||new Set(p.resultIds).size!==p.resultIds.length||!p.reason?.trim()||p.reason.length>1000)throw Error('Choose approved results and give a transfer reason.');
 const results=await Promise.all(p.resultIds.map(id=>readAttendanceFormulaResultTx(tx,ctx,id)));
 for(const employmentId of [...new Set(results.map(row=>row.employmentId))].sort())await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.tenantId+':'+employmentId},0))`);
 // Keep the applicable active set stable until its complete contribution has been checked and posted.
 await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.tenantId.toLowerCase()+':attendance-formula-activation'},0))`);
 const [batch]=await tx.select().from(payrollBatch).where(eq(payrollBatch.id,p.batchId));
 if(!batch||batch.status!=='draft'||batch.runType!=='regular'||results.some(row=>row.companyId!==batch.companyId||row.periodTo.slice(0,7)!==batch.payPeriod))throw Error('Use the matching company regular draft Payroll run and calculation ending month.');
 const [authority]=await tx.execute<{allowed:boolean}>(sql`select app.can_admin_payroll_for(${batch.companyId}::uuid) as allowed`);if(!authority?.allowed)throw Error('Payroll financial authority is required.');
 const candidates:(typeof results[number]&{posting:AttendanceFormulaConfiguration['posting'];purpose:AttendanceFormulaConfiguration['purpose']})[]=[];
 for(const result of results){
  const state=await attendanceFormulaResultStateTx(tx,result.id),replay=await replayAttendanceFormulaResultTx(tx,ctx,result);
  if(state?.kind==='posted'){const [source]=await tx.select().from(payrollAttendanceAllowanceSource).where(eq(payrollAttendanceAllowanceSource.formulaResultId,result.id));if(replay.configuration.purpose==='overtime'){const [binding]=await tx.execute<{ok:boolean}>(sql`select true as ok from attendance_formula_ot_binding_result r join attendance_formula_ot_binding b on b.id=r.binding_id where r.result_id=${result.id}::uuid and r.tenant_id=app.current_tenant_id() and b.batch_id=${batch.id}::uuid and exists(select 1 from overtime_source_settlement s where s.formula_binding_id=b.id and s.released_at is null) limit 1`);if(!binding?.ok)throw Error('The result belongs to another overtime Payroll contribution.');}else if(source?.batchId!==batch.id||source.amount!==result.amount)throw Error('The result belongs to another Payroll contribution.');}
  else if(state?.kind!=='approved')throw Error('Review and approve every current result before transfer.');
  const others=await tx.select().from(attendanceFormulaResult).where(and(eq(attendanceFormulaResult.employmentId,result.employmentId),eq(attendanceFormulaResult.payComponentId,result.payComponentId),sql`${attendanceFormulaResult.periodFrom}<=${result.periodTo}::date and ${attendanceFormulaResult.periodTo}>=${result.periodFrom}::date`)).limit(501);if(others.length>500)throw Error('Narrow the overlapping result history.');
  for(const other of others){const state=await attendanceFormulaResultStateTx(tx,other.id);if(state&&!['superseded','reversed'].includes(state.kind)&&!p.resultIds.includes(other.id))throw Error('Include every current result for the overlapping employee, Pay Item and period; incomplete sets cannot post.');}
  const active=await tx.execute<{id:string;definition:unknown}>(sql`
   select formula_id as id,definition
   from app.attendance_formula_subject_versions(${result.companyId}::uuid,${result.employmentId}::uuid,${result.periodTo}::date,
    null,null,${result.payComponentId}::uuid,${replay.configuration.purpose==='overtime'})
   limit 129`);
  if(active.length>128)throw Error('Narrow the active formula conflict set.');for(const formula of active){if(await attendanceFormulaEligibleForPeriodTx(tx,ctx,formula.definition,{employmentId:result.employmentId,from:result.periodFrom,to:result.periodTo})&&!results.some(row=>row.formulaId===formula.id&&row.employmentId===result.employmentId&&row.periodFrom===result.periodFrom&&row.periodTo===result.periodTo))throw Error('Calculate and review every applicable active formula before resolving the complete posting set.');}
  candidates.push({...result,posting:replay.configuration.posting,purpose:replay.configuration.purpose});
 }
 const plan=planAttendanceFormulaPosting(candidates),selected=results.filter(row=>plan.selected.includes(row.id)),excluded=results.filter(row=>plan.excluded.includes(row.id));
 const states=await Promise.all(selected.map(row=>attendanceFormulaResultStateTx(tx,row.id)));if(states.every(state=>state?.kind==='posted')){await verifyAttendanceFormulaPayrollSourcesTx(tx,ctx,batch.id);await readPayrollOvertimePatternCashTx(tx,ctx,{batchId:batch.id});return {posted:selected.map(row=>row.id),excluded:excluded.map(row=>row.id),idempotent:true};}if(states.some(state=>state?.kind==='posted'))throw Error('The selected results contain a partially posted set. Review the retained Payroll contribution.');
 const overtime=selected.filter(row=>candidates.find(candidate=>candidate.id===row.id)?.purpose==='overtime'),ordinary=selected.filter(row=>!overtime.includes(row));
 const overtimeGroups=new Map<string,typeof overtime>();for(const row of overtime){const key=row.employmentId+':'+row.periodFrom+':'+row.periodTo;const group=overtimeGroups.get(key)??[];group.push(row);overtimeGroups.set(key,group);}for(const rows of overtimeGroups.values())await bindAttendanceFormulaOvertimeTx(tx,ctx,{results:rows,batch});
 // The same existing source projector aggregates old Allowance and new Formula contributions once.
 for(const formulaId of [...new Set(ordinary.map(row=>row.formulaId))].sort()){
  const rows=ordinary.filter(row=>row.formulaId===formulaId);
  const previous=await tx.select({id:payrollAttendanceAllowanceSource.id}).from(payrollAttendanceAllowanceSource).where(and(eq(payrollAttendanceAllowanceSource.formulaId,formulaId),eq(payrollAttendanceAllowanceSource.payMonth,batch.payPeriod)));if(previous.length)throw Error('Reverse the prior formula/month contribution before replacing its results.');
  await projectAttendanceAllowanceTx(tx,ctx,{kind:'formula',formulaId,batchId:batch.id,companyId:batch.companyId,payMonth:batch.payPeriod,contributions:rows.map(row=>({resultId:row.id,employmentId:row.employmentId,componentId:row.payComponentId,periodKey:row.periodTo,amount:row.amount}))});
 }
 for(const result of selected)await appendAttendanceFormulaResultEventTx(tx,ctx,result,'posted',p.reason,batch.id);
 await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'payroll-batch',aggregateId:batch.id,eventType:'payroll-batch.attendance-formula-posted',actor:actorOf(ctx),payload:{posted:selected.map(row=>row.id),excluded:excluded.map(row=>row.id),reason:p.reason}});
 return {posted:selected.map(row=>row.id),excluded:excluded.map(row=>row.id),idempotent:false};
});}
/** Generation and close revalidate retained result evidence and exact aggregate inputs. No writes. */
export async function verifyAttendanceFormulaPayrollSourcesTx(tx:Tx,ctx:SessionContext,batchId:string){
 const sources=await tx.select().from(payrollAttendanceAllowanceSource).where(and(eq(payrollAttendanceAllowanceSource.batchId,batchId),isNotNull(payrollAttendanceAllowanceSource.formulaResultId))).orderBy(payrollAttendanceAllowanceSource.id).limit(5001);
 if(sources.length>5000)throw Error('The formula Payroll source exceeds the bounded review limit.');
 for(const source of sources){const result=await readAttendanceFormulaResultTx(tx,ctx,source.formulaResultId!),state=await attendanceFormulaResultStateTx(tx,result.id);if(state?.kind!=='posted'||state.batchId!==batchId||source.formulaId!==result.formulaId||source.componentId!==result.payComponentId||source.employmentId!==result.employmentId||source.amount!==result.amount)throw Error('The retained Payroll source differs from its approved Attendance result.');await replayAttendanceFormulaResultTx(tx,ctx,result);
  const all=await tx.select().from(payrollAttendanceAllowanceSource).where(and(eq(payrollAttendanceAllowanceSource.batchId,batchId),eq(payrollAttendanceAllowanceSource.employmentId,source.employmentId),eq(payrollAttendanceAllowanceSource.componentId,source.componentId)));
  const [input]=await tx.select().from(payrollBatchComponent).where(and(eq(payrollBatchComponent.batchId,batchId),eq(payrollBatchComponent.employmentId,source.employmentId),eq(payrollBatchComponent.componentId,source.componentId)));
  if(!input||input.notes!==marker||input.amount!==allowanceMoney(all.reduce((sum,row)=>sum+allowanceCents(row.amount),BigInt(0))))throw Error('The Payroll amount no longer reconciles to its exact Attendance contributions.');
 }
 return {verified:sources.length};
}
export function attendanceFormulaPayrollRuns(ctx:SessionContext,companyIds:string[]){return withTenant(ctx,async tx=>{
 if(!companyIds.length)return [];if(companyIds.length>500)throw Error('Narrow the Payroll company scope.');
 return tx.select({id:payrollBatch.id,companyId:payrollBatch.companyId,companyName:company.legalName,period:payrollBatch.payPeriod,cycleId:payrollBatch.payrollCycleId,cycleName:payrollCycle.name}).from(payrollBatch).innerJoin(company,eq(company.id,payrollBatch.companyId)).leftJoin(payrollCycle,eq(payrollCycle.id,payrollBatch.payrollCycleId)).where(and(inArray(payrollBatch.companyId,companyIds),eq(payrollBatch.status,'draft'),eq(payrollBatch.runType,'regular'),sql`app.can_admin_payroll_for(${payrollBatch.companyId})`)).orderBy(payrollBatch.payPeriod,payrollBatch.id).limit(101);
});}
