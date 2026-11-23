'use client';

import {useTranslations} from 'next-intl';
import {formatMoney} from '@/lib/money';
import type {TaxBasisEmployee,TaxBasisLedgerEntry} from '@/lib/payroll-tax-basis';

const cell='p-3 text-left align-top';
const numeric='p-3 text-right align-top tabular-nums whitespace-nowrap';
const sourceTone={saved_payslip:'bg-muted text-foreground',accepted_tp3:'bg-sky-50 text-sky-800 dark:bg-sky-950/30 dark:text-sky-300',no_accepted_tp3:'bg-amber-50 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300'} as const;
const ledgerEntries=(employee:TaxBasisEmployee)=>employee.months.flatMap(month=>{const ledger=month.basis.exemptionLedger as {entries?:TaxBasisLedgerEntry[]}|undefined;return Array.isArray(ledger?.entries)?ledger.entries:[];});

/** Board item 0af23331. Every figure comes from the authorized service and the country pack; this only formats it. */
export function TaxBasisExemptionLimits({employee}:{employee:TaxBasisEmployee}){
  const t=useTranslations('payrollTaxBasis');
  const money=(value:number)=>formatMoney(value,'MYR');
  const opening=employee.openingExemption;
  const legacyZero=employee.openingExemptionSource==='no_tp3_default_zero';
  const entries=ledgerEntries(employee);
  return <>
    {opening?.source==='no_accepted_tp3'&&opening.previousEmployerDeclared&&<p role="note" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/20 dark:text-amber-200">{t('previousEmployerDeclaredWarning')}</p>}
    {legacyZero&&<p className="text-sm text-muted-foreground">{t('noTp3Opening')}</p>}
    {employee.holdReason&&<p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/20 dark:text-amber-200">{t('holdReasons.'+employee.holdReason)}</p>}
    {!!employee.exemptionLedger?.length&&<section className="space-y-3 rounded-lg border border-border p-3 text-sm" aria-label={t('exemptionLimitsTitle')}>
      <h3 className="font-medium">{t('exemptionLimitsTitle')}</h3>
      <div className="overflow-x-auto"><table className="w-full text-sm"><thead className="bg-muted/50"><tr><th className={cell}>{t('exemptionType')}</th><th className={numeric}>{t('annualLimit')}</th><th className={numeric}>{t('previousEmployerUsed')}</th><th className={numeric}>{t('thisCompanyEligible')}</th><th className={numeric}>{t('remainingLimit')}</th><th className={numeric}>{t('taxableExcess')}</th></tr></thead><tbody>
        {employee.exemptionLedger.map(code=><tr key={code.code} className="border-t border-border">
          <th className={cell+' font-medium'}>{code.code}<span className="block text-xs font-normal text-muted-foreground">{code.items.map(item=>item.code+' · '+item.name).join(', ')}</span></th>
          <td className={numeric}>{money(code.cap)}</td>
          <td className={numeric}>{money(code.openingUsed)}{code.openingSource&&<span className={'ml-auto mt-1 block w-fit rounded px-2 py-0.5 text-xs '+sourceTone[code.openingSource]}>{t('openingSources.'+code.openingSource)}</span>}</td>
          <td className={numeric}>{money(code.eligible)}</td>
          <td className={numeric}>{money(code.remaining)}</td>
          <td className={numeric}>{money(code.excess)}</td>
        </tr>)}
      </tbody></table></div>
      {employee.exemptionLedger.map(code=>{const rows=entries.filter(entry=>entry.code===code.code);return rows.length>0&&<div key={code.code} className="overflow-x-auto rounded-lg border border-border"><table className="w-full text-sm"><caption className="p-3 text-left font-medium">{t('monthByMonth',{code:code.code})}</caption><thead className="bg-muted/50"><tr><th className={cell}>{t('period')}</th><th className={cell}>{t('payItems')}</th><th className={numeric}>{t('originalAmount')}</th><th className={numeric}>{t('usedBeforeMonth')}</th><th className={numeric}>{t('remainingBefore')}</th><th className={numeric}>{t('afterExempt')}</th><th className={numeric}>{t('taxableExcess')}</th></tr></thead><tbody>
        {rows.map((entry,index)=><tr key={entry.payslipId+entry.itemCode+index} className="border-t border-border"><th className={cell+' whitespace-nowrap font-medium'}>{entry.period}</th><td className={cell}>{entry.itemCode} · {entry.itemName}</td><td className={numeric}>{money(entry.eligible)}</td><td className={numeric}>{money(entry.usedBefore)}</td><td className={numeric}>{money(entry.remainingBefore)}</td><td className={numeric}>{money(entry.exempt)}</td><td className={numeric}>{money(entry.excess)}</td></tr>)}
      </tbody></table></div>;})}
    </section>}
    {employee.exemptionLedger===undefined&&employee.months.length>0&&<p className="text-sm text-muted-foreground">{t('exemptionLimitsNotRecorded')}</p>}
    {employee.bounds&&<section className="space-y-3 rounded-lg border border-border p-3 text-sm" aria-label={t('boundsTitle')}>
      <h3 className="font-medium">{t('boundsTitle')}</h3><p className="text-muted-foreground">{t('boundsHelp')}</p>
      {employee.bounds.codes.length>0&&<div className="overflow-x-auto"><table className="w-full text-sm"><thead className="bg-muted/50"><tr><th className={cell}>{t('exemptionType')}</th><th className={numeric}>{t('annualLimit')}</th><th className={numeric}>{t('thisCompanyEligible')}</th><th className={numeric}>{t('exemptUpTo')}</th><th className={numeric}>{t('taxableAtLeast')}</th></tr></thead><tbody>
        {employee.bounds.codes.map(code=><tr key={code.code} className="border-t border-border"><th className={cell+' font-medium'}>{code.code}</th><td className={numeric}>{money(code.cap)}</td><td className={numeric}>{money(code.eligible)}</td><td className={numeric}>{money(code.exemptMax)}</td><td className={numeric}>{money(code.certainExcess)}</td></tr>)}
      </tbody></table></div>}
      {employee.bounds.months.map(month=><div key={month.payslipId} className="overflow-x-auto rounded-lg border border-border"><table className="w-full text-sm"><caption className="p-3 text-left font-medium">{month.period}</caption><thead className="bg-muted/50"><tr><th className={cell}>{t('payItems')}</th><th className={numeric}>{t('originalAmount')}</th><th className={numeric}>{t('exemptUpTo')}</th><th className={numeric}>{t('taxableAtLeast')}</th></tr></thead><tbody>
        {month.items.map((item,index)=><tr key={item.code+index} className="border-t border-border"><th className={cell+' font-medium'}>{item.code} · {item.name}{item.exemptionCode&&<span className="block text-xs font-normal text-muted-foreground">{item.exemptionCode}</span>}</th><td className={numeric}>{money(item.amount)}</td><td className={numeric}>{item.exact?t('exactValue',{value:money(item.exemptMax)}):money(item.exemptMax)}</td><td className={numeric}>{item.exact?t('exactValue',{value:money(item.taxableMin)}):money(item.taxableMin)}</td></tr>)}
      </tbody></table></div>)}
    </section>}
  </>;
}
