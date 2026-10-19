/** Spreadsheet-specific admission adapts inputs, then the existing Movement owner adjudicates. */
import {and,desc,eq,sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {compensation,domainEvent,employment,jobGrade} from '../db/schema';
import {compensationEffectiveOn} from './comp';
import {deriveEmploymentStatus} from './employment-status';
import {EMPLOYMENT_TEST_RECORD_EVENT} from './movement-import-admission';
import {todayInKualaLumpur} from '../lib/hr-date';
import type {MovementImportRecord} from '../lib/movement-import-contract';
import type {CreateMovementInput,MovementCurrentState} from './movement';
export type MovementManagerEvidence={row:number;manager:string;marked:boolean;revision:string|null};
function cents(raw:string){if(!/^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/.test(raw))throw new Error('invalid_number:incrementAmount');const [n,d='']=raw.split('.');return BigInt(n)*BigInt(100)+BigInt(d.padEnd(2,'0'));}
export async function movementImportRulesTx(tx:Tx,ctx:SessionContext,record:MovementImportRecord,input:CreateMovementInput,before:MovementCurrentState,behaviour:string,salaryAdapted=false){
 const warnings:string[]=[],references:MovementManagerEvidence[]=[];let baselineDate:string|undefined;
 // Apply this only to a genuinely different resolved manager, not an unchanged legacy reference.
 if(input.managerEmploymentId&&input.managerEmploymentId!==before.managerEmploymentId){
  const [manager]=await tx.select().from(employment).where(and(eq(employment.id,input.managerEmploymentId),eq(employment.tenantId,ctx.tenantId))).limit(1);
  const applicableCompany=input.companyId??before.companyId;
  if(!manager||manager.companyId!==applicableCompany||manager.hiredOn>todayInKualaLumpur()||['resigned','blacklisted'].includes(deriveEmploymentStatus(manager,todayInKualaLumpur())))throw new Error('unknown_reference:managerEmploymentId');
  // sequence is the always-present BIGSERIAL, NOT nullable hash-chain chainSeq or a timestamp/UUID max.
  const [event]=await tx.select({revision:sql<string>`${domainEvent.sequence}::text`}).from(domainEvent).where(and(eq(domainEvent.tenantId,ctx.tenantId),eq(domainEvent.aggregateType,'employment'),eq(domainEvent.aggregateId,manager.id),eq(domainEvent.subjectEmploymentId,manager.id),eq(domainEvent.eventType,EMPLOYMENT_TEST_RECORD_EVENT))).orderBy(desc(domainEvent.sequence),desc(domainEvent.id)).limit(1);
  references.push({row:record.row,manager:manager.id,marked:manager.isTestRecord,revision:event?.revision??null});
  if(manager.isTestRecord)throw new Error('test_superior_not_available:managerEmploymentId');
 }
 if(record.importVersion!==2)return {input,warnings,references,baselineDate};
 if(['promotion','demotion'].includes(behaviour)&&!input.positionId&&!input.gradeId)throw new Error('position_or_grade_required');
 if(['salaryAdjustment','demotion','joinDateChange','groupJoinDateCorrection'].includes(behaviour)&&!input.remarks?.trim())throw new Error('required:remarks');
 if(['transfer','orgAssignmentChange'].includes(behaviour)&&!Object.entries(input).some(([k,v])=>!['employmentId','kind','effectiveDate','typeCode','remarks'].includes(k)&&v!=null&&String(v)!==String(before[k as keyof MovementCurrentState]??'')))throw new Error('movement_has_no_changes');
 if(behaviour==='reportingLineChange'&&!input.managerEmploymentId)throw new Error('required:managerEmploymentId');
 if(behaviour==='employmentTypeChange'&&!input.employmentType)throw new Error('required:employmentType');
 if(behaviour==='salaryAdjustment'&&input.basicSalary===undefined)throw new Error('required:basicSalary');
 const [emp]=await tx.select().from(employment).where(eq(employment.id,input.employmentId)).limit(1);
 if(!emp)throw new Error('employee_not_available');
 if(['confirmation','probationExtension'].includes(behaviour)){
  const status=deriveEmploymentStatus({...emp,finalConfirmationDate:emp.extendedConfirmationDate??emp.confirmationDate},todayInKualaLumpur());
  if(status!=='probation')throw new Error('probation_required');
  const end=emp.extendedConfirmationDate??emp.confirmationDate??emp.probationEndDate??emp.provisionalEndOn;
  if(behaviour==='probationExtension'&&(!end||!input.endDate||input.endDate<=end))throw new Error('probation_end_must_be_later:endDate');
  if(behaviour==='confirmation'&&end&&input.effectiveDate<end)throw new Error('confirmation_before_probation_end:effectiveDate');
 }
 if(behaviour==='promotion'&&input.gradeId&&input.gradeId!==before.gradeId){
  const grades=await tx.select({id:jobGrade.id,rank:jobGrade.rank}).from(jobGrade).where(eq(jobGrade.tenantId,ctx.tenantId));
  const current=grades.find(g=>g.id===before.gradeId),next=grades.find(g=>g.id===input.gradeId);
  const confirmed=(g:typeof current)=>!!g&&g.rank>0&&grades.filter(x=>x.rank===g.rank).length===1;
  if(!confirmed(current)||!confirmed(next))warnings.push('grade_order_unknown');
  else if(next!.rank>=current!.rank)throw new Error('promotion_grade_not_higher:gradeId');
 }
 const amount=record.incrementAmount;
 if(behaviour==='increment'&&!amount&&!salaryAdapted)throw new Error('required:incrementAmount');
 if(amount&&!salaryAdapted){
  if(!['increment','promotion','confirmation'].includes(behaviour))throw new Error('not_applicable:incrementAmount');
  if(input.basicSalary!==undefined)throw new Error('conflicting_salary_inputs');
  const increment=cents(amount);if(increment<=BigInt(0))throw new Error('positive_increment_required');
  const rows=await tx.select().from(compensation).where(and(eq(compensation.employmentId,input.employmentId),compensationEffectiveOn(input.effectiveDate))).limit(2);
  if(rows.length!==1)throw new Error('salary_effective_date_conflict');
  const basis=rows[0];baselineDate=basis.validFrom;
  if(basis.basicSalary!==before.basicSalary||basis.currency!==before.currency)throw new Error('salary_effective_date_conflict');
  const base=cents(basis.basicSalary),total=base+increment;
  if(total>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('invalid_number:incrementAmount');
  input={...input,basicSalary:Number(total)/100,currency:input.currency??basis.currency};
  if(base>BigInt(0)&&increment*BigInt(100)>base*BigInt(20))warnings.push('salary_rise_over_twenty_percent');
 }
 const today=todayInKualaLumpur(),[y,m,d]=today.split('-').map(Number),month=new Date(Date.UTC(y,m-4,1));
 const cutoff=new Date(Date.UTC(month.getUTCFullYear(),month.getUTCMonth(),Math.min(d,new Date(Date.UTC(month.getUTCFullYear(),month.getUTCMonth()+1,0)).getUTCDate()))).toISOString().slice(0,10);
 if(input.effectiveDate<cutoff)warnings.push('backdated_over_three_months');
 return {input,warnings,references,baselineDate};
}
