/** Own Home hints over existing Payroll results. No amount, statutory snapshot or bank data is read.
 * A payment hint requires an actual generated result for this employment on a dated run; a company
 * cycle, draft scope or calendar-month end alone cannot establish that this person is being paid.
 */
import {and,asc,desc,eq} from 'drizzle-orm';
import type {SessionContext} from '../db/client';
import {payslip,payrollBatch} from '../db/schema';
import {withPayrollTenant} from './module-gate';
import {myOwnEmploymentSubjectsTx} from './read';
import {payrollPublicationState} from '../lib/payroll-publication';
import {todayInKualaLumpur} from '../lib/hr-date';

export class OwnPayrollSubjectUnavailableError extends Error{
 constructor(){super('The own payroll context is unavailable.');this.name='OwnPayrollSubjectUnavailableError';}
}
export type OwnPayrollHomeMetadata={
 version:1;employmentId:string;
 payslips:{id:string;period:string;runType:string;runSequence:number}[];
 nextPayment:{date:string;period:string;runType:string}|null;
};

/** The selector is always an explicit own active subject, even for a privileged employee. A fresh
 * own-row/login check runs in this transaction, so a stale card cannot survive unlink/archive/block.
 * Metadata is projected by SQL rather than stripping amounts from the existing full payslip read.
 */
export function readOwnPayrollHomeMetadata(ctx:SessionContext,employmentId:string):Promise<OwnPayrollHomeMetadata>{
 return withPayrollTenant(ctx,async tx=>{
  if(!ctx.userId||!ctx.personId)throw new OwnPayrollSubjectUnavailableError();
  const own=await myOwnEmploymentSubjectsTx(tx,ctx,{profileEdit:true});
  if(!own.some(subject=>subject.employmentId===employmentId))throw new OwnPayrollSubjectUnavailableError();
  const rows=await tx.select({id:payslip.id,period:payrollBatch.payPeriod,runType:payrollBatch.runType,
   runSequence:payrollBatch.runSeq,paymentDate:payrollBatch.batchDate,status:payrollBatch.status,releasedAt:payrollBatch.releasedAt,needsRecalcAt:payrollBatch.needsRecalcAt})
   .from(payslip).innerJoin(payrollBatch,and(eq(payrollBatch.id,payslip.batchId),eq(payrollBatch.tenantId,payslip.tenantId)))
   .where(and(eq(payslip.tenantId,ctx.tenantId),eq(payslip.employmentId,employmentId)))
   .orderBy(desc(payrollBatch.payPeriod),desc(payrollBatch.runSeq),asc(payslip.id)).limit(1201);
  if(rows.length>1200)throw Error('Own payroll metadata exceeds its bounded history.');
  const now=new Date(),today=todayInKualaLumpur(now);
  const published=rows.filter(row=>payrollPublicationState(row,now)==='published');
  // This is a recorded scheduled payment, never a claim that money has reached a bank account.
  // Do not return an unpublished slip ID or reconstruct membership from a draft's company/scope.
  const payments=rows.filter(row=>row.status!=='draft'&&row.needsRecalcAt===null&&row.paymentDate>=today)
   .sort((a,b)=>a.paymentDate.localeCompare(b.paymentDate)||a.period.localeCompare(b.period)||a.runSequence-b.runSequence||a.id.localeCompare(b.id));
  const next=payments[0];
  return {version:1,employmentId,payslips:published.slice(0,12).map(row=>({id:row.id,period:row.period,runType:row.runType,runSequence:row.runSequence})),
   nextPayment:next?{date:next.paymentDate,period:next.period,runType:next.runType}:null};
 });
}
