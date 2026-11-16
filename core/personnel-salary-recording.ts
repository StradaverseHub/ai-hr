import {and,eq,isNull} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {compensation,employment} from '../db/schema';
import {appendEvent,actorOf} from '../db/events';
import {setCompensation} from './comp';
import {setEmploymentPaymentMethod} from './org';
import {createMovementEventTx,editMovementEventTx,movementHistoryTx,movementLedgerMarkerTx,movementRowsAfterSequenceTx,salaryStartAfterClosedPayrollTx} from './movement';
import {resolveMovementEventTypeTx} from './movement-type';
import {isComparisonKind} from './movement-kinds';
import {assertWorkforceEmploymentTx} from './workforce-access';
import {lockLeaveDependencyConfigurationTx} from './leave-dependency-lock';
import {lockPayrollInputsTx} from './payroll-inputs-lock';
import {lockEmploymentStatutoryOwnerTx} from './employment-statutory-owner-lock';
import {withProtectedMovementHistoryTx} from './movement-payroll-protection';
import {latestApplicableMovementCandidates} from '../lib/movement-latest-applicable';
import {todayInKualaLumpur} from '../lib/hr-date';
import {isCalendarDate} from '../lib/calendar-date';
import {PAYMENT_METHODS,type PaymentMethod} from '../lib/payment-methods';

export type SalaryRecordingChoice='newEvent'|'updateLatest'|'amendment';
export type PersonnelSalaryRecording={
 employmentId:string;choice:SalaryRecordingChoice;effectiveDate:string;basicSalary:number;
 paymentMethod?:PaymentMethod|null;eventType?:string;movementId?:string;sourceCompensationId?:string;
 currency?:string;payMode?:string;paymentTerm?:string;rateAmount?:number|null;remarks?:string;reason?:string;
};

/** One atomic human decision for amount, routing method and business date. The ordinary financial,
 * Movement and payment-method owners repeat their own validation; a UI choice is not authority. */
export function recordPersonnelSalary(ctx:SessionContext,raw:PersonnelSalaryRecording){
 const p=structuredClone(raw);
 if(!['newEvent','updateLatest','amendment'].includes(p.choice))throw new Error('Choose how to record this salary change.');
 if(!isCalendarDate(p.effectiveDate))throw new Error('Enter a valid Effective Date.');
 if(!Number.isFinite(p.basicSalary)||p.basicSalary<0)throw new Error('Enter a valid Basic Salary amount.');
 if(p.paymentMethod!==undefined&&p.paymentMethod!==null&&!(PAYMENT_METHODS as readonly string[]).includes(p.paymentMethod))throw new Error('Payment method is invalid.');
 if(p.choice!=='newEvent'&&!p.reason?.trim())throw new Error('Record a reason for this salary correction.');
 return withTenant(ctx,async tx=>{
  await assertWorkforceEmploymentTx(tx,ctx,p.employmentId,'maintain');
  await lockLeaveDependencyConfigurationTx(tx,ctx.tenantId);
  await lockPayrollInputsTx(tx,{employmentIds:[p.employmentId]});
  await lockEmploymentStatutoryOwnerTx(tx,p.employmentId);
  const [subject]=await tx.select({id:employment.id}).from(employment).where(eq(employment.id,p.employmentId)).for('update');
  if(!subject)throw new Error('Employee record is unavailable.');
  if(p.sourceCompensationId){
   const [source]=await tx.select({id:compensation.id}).from(compensation).where(and(eq(compensation.id,p.sourceCompensationId),eq(compensation.employmentId,p.employmentId)));
   if(!source)throw new Error('The selected salary record is unavailable.');
  }
  const [current]=await tx.select().from(compensation).where(and(eq(compensation.employmentId,p.employmentId),isNull(compensation.supersededAt),isNull(compensation.validTo))).limit(1);
  const pay={employmentId:p.employmentId,basicSalary:p.basicSalary,paymentMethod:p.paymentMethod,currency:p.currency,payMode:p.payMode,paymentTerm:p.paymentTerm};
  if(p.choice!=='amendment'&&p.rateAmount!==undefined&&(p.rateAmount??null)!==(current?.rateAmount==null?null:Number(current.rateAmount))){
   throw new Error('Use a salary amendment to change the daily or hourly rate.');
  }
  if(p.choice==='newEvent'){
   const type=p.eventType?await resolveMovementEventTypeTx(tx,ctx.tenantId,p.eventType):null;
   if(!type?.active||!isComparisonKind(type.behaviourKind))throw new Error('Choose an active salary-capable event type from Movement Settings.');
   const marker=await movementLedgerMarkerTx(tx,ctx,p.employmentId);
   const result=await createMovementEventTx(tx,ctx,{...pay,kind:type.code,effectiveDate:p.effectiveDate,remarks:p.remarks||p.reason});
   // Initial pay normally belongs to Hired. Here the human explicitly chose a new configured event.
   if(!(await movementRowsAfterSequenceTx(tx,ctx,p.employmentId,marker)).length&&'groupId' in result&&typeof result.groupId==='string'){
    await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'employment',aggregateId:p.employmentId,eventType:'employment.movement.recorded',actor:actorOf(ctx),subjectEmploymentId:p.employmentId,
     payload:{type:type.code,effectiveDate:p.effectiveDate,endDate:null,remarks:p.remarks??null,movement:{type:type.code,groupId:result.groupId,effectiveDate:p.effectiveDate}}});
   }
   return {employmentId:p.employmentId,choice:p.choice,result};
  }
  if(p.choice==='updateLatest'){
   const latest=latestApplicableMovementCandidates(await movementHistoryTx(tx,ctx,p.employmentId),todayInKualaLumpur());
   const selected=latest.find(row=>row.id===p.movementId);
   if(!selected)throw new Error('The latest applicable event changed. Reload and select the event again.');
   if(selected.effectiveDate!==p.effectiveDate)throw new Error(`This event is effective on ${selected.effectiveDate}. Keep that date, or choose a new event or salary amendment for another date.`);
   const type=await resolveMovementEventTypeTx(tx,ctx.tenantId,selected.correctionKind??selected.kind);
   if(!selected.canEdit||!type||!isComparisonKind(type.behaviourKind))throw new Error('This event cannot maintain salary through its current workflow. Choose a new event or a salary amendment.');
   const result=await editMovementEventTx(tx,ctx,{...pay,kind:type.code,movementId:selected.id,effectiveDate:selected.effectiveDate,reason:p.reason,remarks:p.remarks??selected.remarks});
   return {employmentId:p.employmentId,choice:p.choice,result};
  }
  return withProtectedMovementHistoryTx(tx,ctx,p.employmentId,async()=>{
   const payrollEffectiveDate=await salaryStartAfterClosedPayrollTx(tx,p.employmentId,p.effectiveDate);
   if(current&&payrollEffectiveDate<current.validFrom)throw new Error('This amendment predates the latest salary record. Correct the historical event, or choose a later Effective Date.');
   const terms=await setCompensation(ctx,{employmentId:p.employmentId,basicSalary:p.basicSalary,effectiveFrom:payrollEffectiveDate,currency:p.currency,payMode:p.payMode,paymentTerm:p.paymentTerm,rateAmount:p.rateAmount,remarks:p.remarks||p.reason},tx);
   if(p.paymentMethod!==undefined)await setEmploymentPaymentMethod(ctx,{employmentId:p.employmentId,paymentMethod:p.paymentMethod,effectiveDate:p.effectiveDate,reason:p.reason},tx);
   await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'employment',aggregateId:p.employmentId,eventType:'employment.salary.amended',actor:actorOf(ctx),subjectEmploymentId:p.employmentId,
    payload:{effectiveDate:p.effectiveDate,payrollEffectiveDate,compensationId:terms.compensationId,sourceCompensationId:p.sourceCompensationId??null,reason:p.reason?.trim(),movementCreated:false}});
   return {employmentId:p.employmentId,choice:p.choice,payrollEffectiveDate};
  },message=>new Error(message));
 });
}
