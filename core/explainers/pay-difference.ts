/** AI v2 W5 — "Why is my pay different from last month?" over the caller's own released payslips.
 *
 * The answer is core/pay-difference.ts comparePayPeriods over the payslips' own stored lines and stamps: which lines
 * changed, by how much (the service's subtraction, never the model's) and the causes the runs recorded. The read is
 * the Assistant read facade (core/assistant-read-session.ts) as the caller, own payslips only, with the release
 * filter the employee's payslip page and my_payslip_summary apply, so an unreleased payslip is never compared. Each
 * company is compared on its own. Every figure leaves to the model as a band and placeholder (its semantic entity,
 * core/semantic-model/entities-why.ts) and is restored exactly for the person. Pay item names are the payslip's own;
 * company ids never leave. */
import type {SessionContext} from '../../db/client';
import {withAssistantRead} from '../assistant-read-session';
import {comparePayPeriods,type StoredPayslipRow} from '../pay-difference';
import {provenance,refuse,type ExplainerOutcome} from './outcome';

const MONTH=/^\d{4}-(0[1-9]|1[0-2])$/;
/** The stored row as core/read.ts myPayslips returns it, in the shape the comparison reads. */
export const storedPayslipRow=(row:{companyId:string;company:string;payPeriod:string;runType:string;runSeq:number;basic:unknown;allowance:unknown;overtime:unknown;bonus:unknown;
 gross:unknown;statutory:unknown;otherDeductions:unknown;deductions:unknown;net:unknown;daysWorked:unknown}):StoredPayslipRow=>({companyId:row.companyId,company:row.company,
 payPeriod:row.payPeriod,runType:row.runType,runSeq:row.runSeq,basic:row.basic,allowance:row.allowance,overtime:row.overtime,bonus:row.bonus,gross:row.gross,
 statutory:row.statutory,otherDeductions:row.otherDeductions,totalDeductions:row.deductions,net:row.net,daysWorked:row.daysWorked});

export const PAY_DIFFERENCE_PROVENANCE=provenance('core/pay-difference.ts#comparePayPeriods',
 'The statutory ruleset version each run stamped on its payslip (core/payslip-recompute.ts payslipProvenance).','/me/payslip',
 'Every figure is a payslip\'s own stored line; the payroll service adds up a month\'s runs and subtracts one month from the other. Causes are listed only where a run recorded them; a payslip issued before a cause was recorded cannot show it.');

export async function explainOwnPayDifference(ctx:SessionContext,input:Readonly<{period?:string;compare_to?:string}>):Promise<ExplainerOutcome>{
 if(input.period!==undefined&&!MONTH.test(input.period))return refuse('invalid_input','`period` must be a month as YYYY-MM.');
 if(input.compare_to!==undefined&&!MONTH.test(input.compare_to))return refuse('invalid_input','`compare_to` must be a month as YYYY-MM.');
 return withAssistantRead(ctx,'payroll',async(read):Promise<ExplainerOutcome>=>{
  const ids=(await read.myEmploymentIdsAll()).map(row=>row.employmentId);
  if(!ids.length)return refuse('no_employment','The asking user has no employee record, so they have no payslips.');
  // Released only, own only: the employee's own payslip page shows nothing else.
  const rows=(await read.myPayslips(ids,true)).filter(row=>row.released).map(storedPayslipRow);
  const result=comparePayPeriods(rows,{period:input.period,compareTo:input.compare_to});
  if(!result.ok){
   const message={no_data:'The asking user has no released payslips.',no_period:'The asking user has no released payslip for that month.',
    earliest:'This is the asking user\'s earliest released payslip, so there is no earlier month to compare it with.',same_period:'Two different months are needed to compare.'}[result.reason];
   return{...refuse(result.reason==='same_period'?'invalid_input':'no_data',message),availablePeriods:result.availablePeriods};
  }
  return{ok:true,period:result.period,previousPeriod:result.previousPeriod,availablePeriods:result.availablePeriods,
   comparisons:result.comparisons.map(({companyId:_companyId,...row})=>row),onlyIn:result.onlyIn,provenance:PAY_DIFFERENCE_PROVENANCE};
 });
}
