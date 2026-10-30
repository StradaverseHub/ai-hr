/** Read-only Native input selection shared by payroll generation and saved-formula simulation.
 * These helpers select evidence, never attach/consume a transaction or calculate a Pay Item.
 * Callers retain the Native feature gates, employee/company authorization and run routing. */
import {and,eq,gte,inArray,isNull,lte,or,sql} from 'drizzle-orm';
import type {Tx} from '../db/client';
import {attendance,employmentPayComponent,payComponent,payrollBatchComponent,payrollIndividualTxn} from '../db/schema';
import {collectableCycleIds,intendedCycleFilter} from '../packs/payroll/service';
const formulaContext=sql<{ordinaryRate?:string;hoursPerDay?:string;rate?:string}|null>`${payComponent}.formula_context`;
const componentColumns={
 amount:employmentPayComponent.amount,code:payComponent.code,name:payComponent.name,kind:payComponent.kind,
 epf:payComponent.includedInEpf,socso:payComponent.includedInSocsoEis,pcb:payComponent.includedInPcb,hrdf:payComponent.includedInHrdfBase,
 nonPayable:payComponent.isNonPayable,orpOvertime:payComponent.orpOvertime,orpUnpaidLeave:payComponent.orpUnpaidLeave,
 prorates:payComponent.prorates,rounding:payComponent.roundingMethod,rule:payComponent.rule,resolutionOrder:payComponent.resolutionOrder,formulaContext,
 epfBonus2012:payComponent.epfBonus2012,pcbRemunerationType:payComponent.pcbRemunerationType,pcbExemptionCode:payComponent.pcbExemptionCode,
 displayCategory:payComponent.displayCategory,eaFormLine:payComponent.eaFormLine,
};
export async function readPayrollComponentInputsTx(tx:Tx,p:{employmentIds:string[];periodStart:string;periodEnd:string;batchId?:string}){
 // An empty authorized selection cannot widen into a whole-run or whole-tenant read.
 const recurring=p.employmentIds.length?await tx.select({...componentColumns,sourceId:employmentPayComponent.id,employmentId:employmentPayComponent.employmentId,prorateOverride:employmentPayComponent.prorateOverride})
  .from(employmentPayComponent).innerJoin(payComponent,eq(payComponent.id,employmentPayComponent.componentId))
  .where(and(inArray(employmentPayComponent.employmentId,p.employmentIds),lte(employmentPayComponent.validFrom,p.periodEnd),or(isNull(employmentPayComponent.validTo),gte(employmentPayComponent.validTo,p.periodStart)),isNull(employmentPayComponent.supersededAt))).orderBy(payComponent.code,employmentPayComponent.id):[];
 // valid_to is INCLUSIVE, exactly as the existing Native recurring owner. Archived catalogue rows
 // are deliberately not filtered here: generation's canonical reader does not discard their money.
 const batch=p.batchId&&p.employmentIds.length?await tx.select({...componentColumns,sourceId:payrollBatchComponent.id,oneOff:sql<boolean>`true`,employmentId:payrollBatchComponent.employmentId,amount:payrollBatchComponent.amount})
  .from(payrollBatchComponent).innerJoin(payComponent,eq(payComponent.id,payrollBatchComponent.componentId))
  .where(and(eq(payrollBatchComponent.batchId,p.batchId),inArray(payrollBatchComponent.employmentId,p.employmentIds))).orderBy(payComponent.code,payrollBatchComponent.id):[];
 return {recurring,batch};
}
export type PayrollComponentInputRows=Awaited<ReturnType<typeof readPayrollComponentInputsTx>>;
export async function readPayrollIndividualLedgerTx(tx:Tx,p:{batchId?:string;employmentIds?:string[];unattached?:{companyId:string;payPeriod:string;payrollCycleId:string|null;runType:string}}){
 if(p.employmentIds&&p.employmentIds.length===0)return [];
 const predicates=[];
 if(p.batchId)predicates.push(and(eq(payrollIndividualTxn.batchId,p.batchId),or(isNull(payrollIndividualTxn.consumedBatchId),eq(payrollIndividualTxn.consumedBatchId,p.batchId))));
 if(p.unattached){const collection=await collectableCycleIds(tx,p.unattached);if(!collection.collectsNothing)predicates.push(and(isNull(payrollIndividualTxn.batchId),isNull(payrollIndividualTxn.consumedBatchId),eq(payrollIndividualTxn.companyId,p.unattached.companyId),eq(payrollIndividualTxn.payPeriod,p.unattached.payPeriod),intendedCycleFilter(collection)));}
 if(!predicates.length)return [];
 return tx.select({
  id:payrollIndividualTxn.id,employmentId:payrollIndividualTxn.employmentId,kind:payrollIndividualTxn.kind,amount:payrollIndividualTxn.amount,notes:payrollIndividualTxn.notes,componentId:payrollIndividualTxn.componentId,
  batchId:payrollIndividualTxn.batchId,consumedBatchId:payrollIndividualTxn.consumedBatchId,intendedCycleId:payrollIndividualTxn.intendedCycleId,source:payrollIndividualTxn.source,sourceRef:payrollIndividualTxn.sourceRef,txnDate:payrollIndividualTxn.txnDate,
  compCode:payComponent.code,compName:payComponent.name,compKind:payComponent.kind,compEpf:payComponent.includedInEpf,compSocso:payComponent.includedInSocsoEis,compPcb:payComponent.includedInPcb,compHrdf:payComponent.includedInHrdfBase,
  compNonPayable:payComponent.isNonPayable,compProrates:payComponent.prorates,compRounding:payComponent.roundingMethod,compRule:payComponent.rule,compResolutionOrder:payComponent.resolutionOrder,compFormulaContext:formulaContext,
  compEpfBonus2012:payComponent.epfBonus2012,compPcbRemunerationType:payComponent.pcbRemunerationType,compPcbExemptionCode:payComponent.pcbExemptionCode,compDisplayCategory:payComponent.displayCategory,compEaFormLine:payComponent.eaFormLine,
 }).from(payrollIndividualTxn).leftJoin(payComponent,eq(payComponent.id,payrollIndividualTxn.componentId)).where(and(or(...predicates),p.employmentIds?inArray(payrollIndividualTxn.employmentId,p.employmentIds):undefined)).orderBy(payrollIndividualTxn.id);
}
export type PayrollIndividualLedgerRows=Awaited<ReturnType<typeof readPayrollIndividualLedgerTx>>;
export async function readPayrollAttendanceHoursTx(tx:Tx,p:{employmentIds:string[];periodStart:string;periodEnd:string}):Promise<Map<string,number>>{
 const hours=new Map<string,number>();if(!p.employmentIds.length)return hours;
 const rows=await tx.select({employmentId:attendance.employmentId,minutes:sql<string>`coalesce(sum(${attendance.workedMinutes}),0)`}).from(attendance)
  .where(and(inArray(attendance.employmentId,p.employmentIds),gte(attendance.attendanceDate,p.periodStart),lte(attendance.attendanceDate,p.periodEnd))).groupBy(attendance.employmentId).orderBy(attendance.employmentId);
 // Native attendance scope is a legacy Number boundary. Missing rows stay absent; the caller owns
 // the canonical no-attendance=>zero-hours rule, distinct from an unavailable source/permission.
 for(const row of rows)hours.set(row.employmentId,Number(row.minutes)/60);return hours;
}
