/** Shared labels, columns and notes keep screen and downloaded sign-off outputs consistent. */
import type { ComparisonRow } from './payroll-comparison-result';
import type { PayrollComparisonDefinition, PayrollComparisonReason } from './payroll-period-comparison';
export type PayrollComparisonTranslate=(key:string,values?:Record<string,string|number>)=>string;
export const PAYROLL_REASON_LABELS:Record<PayrollComparisonReason,string>={unexplained:'Unexplained',increment:'Increment',promotion:'Promotion',demotion:'Demotion',newHire:'New hire',resigned:'Resigned / ended employment',proratedLeaving:'Prorated leaving',transfer:'Company transfer',unclassified:'Not classified'};
const LABELS:Record<string,string>={employeeCode:'Emp no.',employeeName:'Employee',department:'Department',grade:'Job grade',company:'Paying company',costCentre:'Cost centre',currency:'Currency',previous:'Previous amount',current:'Current amount',variance:'Variance',variancePct:'Variance %',reason:'Reason',effectiveDate:'Effective date',remarks:'Remarks'};
export function payrollComparisonColumns(definition:PayrollComparisonDefinition,t?:PayrollComparisonTranslate){
  const ids=['employeeCode','employeeName','department','grade','company','costCentre'].filter(id=>definition.columns.includes(id as never));
  ids.push('currency','previous','current','variance');
  if(definition.columns.includes('variancePct'))ids.push('variancePct');
  ids.push('reason');for(const id of ['effectiveDate','remarks'])if(definition.columns.includes(id as never))ids.push(id);
  return ids.map(id=>({id,label:t?t('columns.'+id):LABELS[id],numeric:['previous','current','variance','variancePct'].includes(id)}));
}
export function payrollComparisonRemarks(row:ComparisonRow,t?:PayrollComparisonTranslate){
  const text=(key:string,fallback:string,values?:Record<string,string|number>)=>t?t('remarks.'+key,values):fallback;
  if(row.reason.reason==='unclassified')return text('disabled','Automatic explanations are off.');
  const notes:string[]=[];
  if(row.reason.reason==='unexplained')notes.push(text('unexplained','No matching applied evidence; a movement may not explain the whole difference.'));
  if(row.reason.prorated)notes.push(text('prorated','Saved payroll coverage supports a partial period.'));
  if(row.reason.multipleChanges)notes.push(text('multipleChanges','Several applied salary changes match; the latest is shown.'));
  if(row.reason.evidenceIds.length){const references=row.reason.evidenceIds.join(', ');notes.push(text('evidence','Evidence: '+references,{references}));}
  if(row.currency===null)notes.push(text('currencyUnknown','Currency was not recorded. Variance is unavailable.'));
  return notes.join(' ');
}
export function payrollComparisonCell(row:ComparisonRow,id:string,t?:PayrollComparisonTranslate):string|null{
  if(id==='reason')return t?t('reasons.'+row.reason.reason):PAYROLL_REASON_LABELS[row.reason.reason];
  if(id==='effectiveDate')return row.reason.effectiveDate;
  if(id==='remarks')return payrollComparisonRemarks(row,t);
  if(id==='currency')return row.currency??(t?t('currencyUnknown'):'Not recorded');
  const value=row[id as keyof ComparisonRow];return typeof value==='string'?value:null;
}
export const PAYROLL_COMPARISON_BASIS='Source: saved paid payroll results. Organisation follows the last recorded paying-employer date on the current side, or the previous side when no current result exists. Current authorised labels are shown. Applied evidence order: verified employer transfer, hire, recorded exit, then latest salary-changing increment/promotion/demotion; remaining rows are unexplained. Labels do not prove the cause of the entire monetary difference.';
