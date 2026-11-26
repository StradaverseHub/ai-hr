'use client';

import {useTranslations} from 'next-intl';
import {formatMoney} from '@/lib/money';
import type {TaxBasisEmployee} from '@/lib/payroll-tax-basis';

const cell='p-3 text-left align-top';
const numeric='p-3 text-right align-top tabular-nums whitespace-nowrap';

/**
 * Board 4ce2c481 — "Year to date from other group companies". The same person's earlier months this assessment year at
 * the group's other companies, which live PCB now takes as a previous-employer opening (the role Form TP3 plays). Totals
 * per company only, from the authorized service; this formats them and never adds anything up itself. Read only: the
 * recalculation below still corrects this company's own months.
 */
export function TaxBasisGroupOpening({employee}:{employee:TaxBasisEmployee}){
  const t=useTranslations('payrollTaxBasis');
  const group=employee.groupOpening;
  if(!group)return null;
  const money=(value:number)=>formatMoney(value,'MYR');
  const span=(periods:string[])=>periods.length>1?`${periods[0]} – ${periods[periods.length-1]}`:periods[0]??'';
  return <section className="space-y-3 rounded-lg border border-border p-3 text-sm" aria-label={t('groupOpeningTitle')}>
    <h3 className="font-medium">{t('groupOpeningTitle')}</h3>
    <p className="text-muted-foreground">{t('groupOpeningHelp')}</p>
    {group.missing.length>0&&<p role="note" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-900 dark:border-amber-800 dark:bg-amber-950/20 dark:text-amber-200">{t('groupOpeningMissing',{months:group.missing.map(m=>`${m.companyName} ${m.period}`).join(', ')})}</p>}
    {group.tp3==='replaced'&&<p className="text-muted-foreground">{t('groupOpeningTp3Replaced')}</p>}
    {group.tp3==='conflict'&&<p role="note" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-900 dark:border-amber-800 dark:bg-amber-950/20 dark:text-amber-200">{t('groupOpeningTp3Conflict')}</p>}
    <div className="overflow-x-auto"><table className="w-full text-sm"><thead className="bg-muted/50"><tr>
      <th className={cell}>{t('groupOpeningCompany')}</th><th className={cell}>{t('groupOpeningMonths')}</th><th className={cell}>{t('groupOpeningSource')}</th>
      <th className={numeric}>{t('groupOpeningTaxable')}</th><th className={numeric}>{t('groupOpeningPcb')}</th><th className={numeric}>{t('groupOpeningEpf')}</th>
    </tr></thead><tbody>
      {group.companies.map(company=><tr key={company.companyId} className="border-t border-border">
        <th className={cell+' font-medium'}>{company.companyName}</th>
        <td className={cell+' whitespace-nowrap'}>{span(company.periods)}</td>
        <td className={cell}>{company.sources.map(source=>t('groupOpeningSources.'+source)).join(', ')}</td>
        <td className={numeric}>{money(company.taxable)}</td><td className={numeric}>{money(company.pcb)}</td><td className={numeric}>{money(company.epf)}</td>
      </tr>)}
    </tbody></table></div>
    {group.limits.length>0&&<div className="overflow-x-auto"><table className="w-full text-sm"><caption className="p-3 text-left font-medium">{t('groupOpeningLimits')}</caption><thead className="bg-muted/50"><tr>
      <th className={cell}>{t('exemptionType')}</th><th className={numeric}>{t('annualLimit')}</th><th className={numeric}>{t('groupOpeningUsed')}</th><th className={numeric}>{t('remainingLimit')}</th>
    </tr></thead><tbody>
      {group.limits.map(limit=><tr key={limit.code} className="border-t border-border">
        <th className={cell+' font-medium'}>{limit.code}</th>
        <td className={numeric}>{limit.cap===null?t('groupOpeningNoLimit'):money(limit.cap)}</td>
        <td className={numeric}>{money(limit.used)}</td>
        <td className={numeric}>{limit.remaining===null?t('groupOpeningNoLimit'):money(limit.remaining)}</td>
      </tr>)}
    </tbody></table></div>}
  </section>;
}
