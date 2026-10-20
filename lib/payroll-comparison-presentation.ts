/** Shared labels, columns and notes keep screen and downloaded sign-off outputs consistent. */
import type { ComparisonRow } from './payroll-comparison-result';
import type { PayrollComparisonDefinition, PayrollComparisonReason } from './payroll-period-comparison';
export const PAYROLL_REASON_LABELS:Record<PayrollComparisonReason,string>={unexplained:'Unexplained',increment:'Increment',promotion:'Promotion',demotion:'Demotion',newHire:'New hire',resigned:'Resigned / ended employment',proratedLeaving:'Prorated leaving',transfer:'Company transfer',unclassified:'Not classified'};
const LABELS:Record<string,string>={employeeCode:'Emp no.',employeeName:'Employee',department:'Department',grade:'Job grade',company:'Paying company',costCentre:'Cost centre',currency:'Currency',previous:'Previous amount',current:'Current amount',variance:'Variance',variancePct:'Variance %',reason:'Reason',effectiveDate:'Effective date',remarks:'Remarks'};
export function payrollComparisonColumns(definition:PayrollComparisonDefinition){
  const ids=['employeeCode','employeeName','department','grade','company','costCentre'].filter(id=>definition.columns.includes(id as never));
  ids.push('currency','previous','current','variance');
  if(definition.columns.includes('variancePct'))ids.push('variancePct');
  ids.push('reason');for(const id of ['effectiveDate','remarks'])if(definition.columns.includes(id as never))ids.push(id);
  return ids.map(id=>({id,label:LABELS[id],numeric:['previous','current','variance','variancePct'].includes(id)}));
}
export function payrollComparisonRemarks(row:ComparisonRow){
  if(row.reason.reason==='unclassified')return 'Automatic explanations are off.';
  const notes:string[]=[];
  if(row.reason.reason==='unexplained')notes.push('No matching applied evidence; a movement may not explain the whole difference.');
  if(row.reason.prorated)notes.push('Saved payroll coverage supports a partial period.');
  if(row.reason.multipleChanges)notes.push('Several applied salary changes match; the latest is shown.');
  if(row.reason.evidenceIds.length)notes.push('Evidence: '+row.reason.evidenceIds.join(', '));
  if(row.currency===null)notes.push('Currency was not recorded. Variance is unavailable.');
  return notes.join(' ');
}
export function payrollComparisonCell(row:ComparisonRow,id:string):string|null{
  if(id==='reason')return PAYROLL_REASON_LABELS[row.reason.reason];
  if(id==='effectiveDate')return row.reason.effectiveDate;
  if(id==='remarks')return payrollComparisonRemarks(row);
  if(id==='currency')return row.currency??'Not recorded';
  const value=row[id as keyof ComparisonRow];return typeof value==='string'?value:null;
}
export const PAYROLL_COMPARISON_BASIS='Source: saved paid payroll results. Organisation is dated at current period end, or previous period end only when no current result exists. Current authorised labels are shown. Applied evidence order: verified employer transfer, hire, recorded exit, then latest salary-changing increment/promotion/demotion; remaining rows are unexplained. Labels do not prove the cause of the entire monetary difference.';
