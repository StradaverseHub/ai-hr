/** Which companies a ready-company payroll comparison covers (Reconciliation and the comparison report): the count
 * line, the "Not included" panel with each left-out company's reasons, and the never-ran count. Server-rendered. */
import type {PayrollComparisonInclusion} from '@/lib/payroll-comparison-result';

type Translate=(key:string,values?:Record<string,string|number|Date>)=>string;
/** A pay period as a date inside its month (the 15th, UTC), so the message's month format cannot slip a month. */
export const payrollComparisonMonth=(period:string)=>new Date(Date.UTC(Number(period.slice(0,4)),Number(period.slice(5,7))-1,15));

export function PayrollComparisonInclusionNotice({inclusion,t}:{inclusion:PayrollComparisonInclusion|null|undefined;t:Translate}){
  if(!inclusion||(!inclusion.withPayrollCount&&!inclusion.neverRanCount))return null;
  const month=payrollComparisonMonth;
  return <section aria-label={t('inclusion.coverage')} className="space-y-3">
    {inclusion.withPayrollCount>0&&<p role="status" className="text-sm font-medium text-foreground">{t('inclusion.comparing',{included:inclusion.includedCompanyIds.length,total:inclusion.withPayrollCount})}</p>}
    {inclusion.excluded.length>0&&<div className="rounded-xl border border-border bg-muted/50 p-4 text-sm">
      <h2 className="font-semibold">{t('inclusion.notIncluded')}</h2>
      <p className="mt-1 text-muted-foreground">{t('inclusion.notIncludedHelp')}</p>
      <ul className="mt-2 space-y-1">{inclusion.excluded.map(row=><li key={row.companyId}><span className="font-medium">{row.company}</span>: {row.reasons.map(reason=>t('inclusion.reasons.'+reason.code,{month:month(reason.period)})).join('; ')}</li>)}</ul>
    </div>}
    {inclusion.neverRanCount>0&&<p className="text-xs text-muted-foreground">{t('inclusion.neverRan',{count:inclusion.neverRanCount})}</p>}
  </section>;
}

/** The empty state of a ready-company comparison with no ready company, never a blank table. */
export function payrollComparisonEmptyMessage(inclusion:PayrollComparisonInclusion|null|undefined,t:Translate):string|null{
  if(!inclusion||inclusion.includedCompanyIds.length)return null;
  return inclusion.withPayrollCount?t('inclusion.emptyNoneReady'):t('inclusion.emptyNoPayroll');
}
