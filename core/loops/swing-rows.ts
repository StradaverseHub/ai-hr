/** The ONE reader of the payslips a net-swing comparison judges (owner, 11 November 2026: one threshold, one owner of the
 * fact). The Salary payroll loop (core/loops/salary-payroll.ts) and the payroll anomaly evaluator (core/payroll-anomaly.ts
 * gatherContext) both read through this, so the two checks compare the same rows, and core/loops/net-swing.ts netSwingFor
 * judges them.
 *
 * THE BASELINE RULE. The month being judged counts every processed or closed run of the company in it (plus the batch under
 * evaluation, whatever its status). An EARLIER month counts only its CLOSED runs: a draft or processed run of an earlier
 * month is unfinished (it can still be reprocessed or reset), so it is never "last month". That is the same rule the
 * anomaly layer's prior-cycle gate uses (core/payroll-anomaly.ts, priorBatch: status 'closed'). Months read: the period and
 * the three before it (net-swing.ts swingMonths); a previous paid month older than that is not compared here.
 *
 * ONE set-based statement per call, never a loop per employee or company (docs SCALE-AND-RELEASE-RULES rule 2). Read under
 * the caller's own row-level security. */
import {and,eq,inArray,sql} from 'drizzle-orm';
import type {Tx} from '../../db/client';
import {payrollBatch,payslip} from '../../db/schema';
import type {StoredPayslipRow} from '../pay-difference';
import {swingMonths} from './net-swing';

export async function swingRowsTx(tx:Tx,p:Readonly<{companyId:string;period:string;employmentIds?:readonly string[];includeBatchId?:string}>):Promise<Map<string,StoredPayslipRow[]>>{
 const months=swingMonths(p.period),earlier=months.slice(1);
 if(p.employmentIds&&!p.employmentIds.length)return new Map();
 const rows=await tx.select({employmentId:payslip.employmentId,payPeriod:payrollBatch.payPeriod,runType:payrollBatch.runType,runSeq:payrollBatch.runSeq,
  basic:payslip.basicSalary,allowance:payslip.allowance,overtime:payslip.overtimePay,bonus:payslip.bonus,gross:payslip.grossPay,statutory:payslip.statutory,
  otherDeductions:payslip.otherDeductions,totalDeductions:payslip.totalDeductions,net:payslip.netPay,daysWorked:payslip.daysWorked})
  .from(payslip).innerJoin(payrollBatch,eq(payrollBatch.id,payslip.batchId))
  .where(and(eq(payrollBatch.companyId,p.companyId),inArray(payrollBatch.payPeriod,months),
   p.employmentIds?inArray(payslip.employmentId,[...p.employmentIds]):undefined,
   sql`((${payrollBatch.payPeriod} = ${p.period} and (${inArray(payrollBatch.status,['processed','closed'])}${p.includeBatchId?sql` or ${payrollBatch.id} = ${p.includeBatchId}::uuid`:sql``}))
    or (${inArray(payrollBatch.payPeriod,earlier)} and ${payrollBatch.status} = 'closed'))`));
 const byEmployment=new Map<string,StoredPayslipRow[]>();
 for(const row of rows){
  const list=byEmployment.get(row.employmentId)??[];
  list.push({companyId:p.companyId,company:'',payPeriod:row.payPeriod,runType:row.runType,runSeq:row.runSeq,basic:row.basic,allowance:row.allowance,overtime:row.overtime,
   bonus:row.bonus,gross:row.gross,statutory:row.statutory,otherDeductions:row.otherDeductions,totalDeductions:row.totalDeductions,net:row.net,daysWorked:row.daysWorked});
  byEmployment.set(row.employmentId,list);
 }
 // Only people paid in the period itself are compared.
 for(const [employmentId,list] of byEmployment)if(!list.some(row=>row.payPeriod===p.period))byEmployment.delete(employmentId);
 return byEmployment;
}
