'use client';

import {useTranslations} from 'next-intl';
import {formatMoney} from '@/lib/money';
import type {TaxBasisEmployee} from '@/lib/payroll-tax-basis';

const cell='p-3 text-left align-top';
const numeric='p-3 text-right align-top tabular-nums';

/** Values are calculated by the authorized service. This surface only formats saved results. */
export function TaxBasisResults({employees}:{employees:TaxBasisEmployee[]}){
  const t=useTranslations('payrollTaxBasis');
  const money=(value:number|null)=>value===null?t('unavailable'):formatMoney(value,'MYR');
  return <div className="space-y-3">
    {employees.length===0&&<p className="text-sm text-muted-foreground">{t('noEmployees')}</p>}
    {employees.map(employee=><details key={employee.id} className="group rounded-xl border border-border">
      <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-3 rounded-xl p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span><span className="font-medium">{employee.employeeNo} · {employee.name}</span><span className="ml-3 text-xs text-muted-foreground">{t('recordsCount',{count:employee.recordCount})}</span><span className="mt-1 block text-xs text-muted-foreground">{t('beforeTaxable')}: {money(employee.beforeTaxable)} <span aria-hidden="true">→</span> {t('afterTaxable')}: {money(employee.taxable)} · {t('difference')}: {money(employee.difference)}</span></span>
        <span className={'rounded-full px-2.5 py-1 text-xs font-medium '+(employee.status==='blocked'||employee.status==='failed'?'bg-amber-50 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300':'bg-muted text-foreground')}>{t(`employeeStates.${employee.status}`)}</span><span className="text-xs font-medium text-primary">{t('viewDetails')} <span aria-hidden="true">⌄</span></span>
      </summary>
      <div className="space-y-4 border-t p-4">
        {employee.reason&&<p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/20 dark:text-amber-200">{employee.reason}</p>}
        <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-5">
          <div><dt className="text-muted-foreground">{t('beforeTaxable')}</dt><dd className="mt-1 font-medium tabular-nums">{money(employee.beforeTaxable)}</dd></div>
          <div><dt className="text-muted-foreground">{t('afterTaxable')}</dt><dd className="mt-1 font-medium tabular-nums">{money(employee.taxable)}</dd></div>
          <div><dt className="text-muted-foreground">{t('difference')}</dt><dd className="mt-1 font-medium tabular-nums">{money(employee.difference)}</dd></div>
          <div><dt className="text-muted-foreground">{t('beforeExempt')}</dt><dd className="mt-1 font-medium tabular-nums">{money(employee.beforeExempt)}</dd></div>
          <div><dt className="text-muted-foreground">{t('afterExempt')}</dt><dd className="mt-1 font-medium tabular-nums">{money(employee.exempt)}</dd></div>
        </dl>
        {employee.months.length>0&&<div className="overflow-x-auto rounded-lg border"><table className="w-full text-sm"><caption className="p-3 text-left font-medium">{t('monthlyValues')}</caption><thead className="bg-muted/50"><tr><th className={cell}>{t('period')}</th><th className={numeric}>{t('beforeTaxable')}</th><th className={numeric}>{t('afterTaxable')}</th><th className={numeric}>{t('difference')}</th><th className={numeric}>{t('beforeExempt')}</th><th className={numeric}>{t('afterExempt')}</th><th className={numeric}>{t('ytdTaxable')}</th><th className={numeric}>{t('ytdExempt')}</th><th className={cell}>{t('payItems')}</th></tr></thead><tbody>
          {employee.months.map(month=><tr key={month.payslipId} className="border-t"><th className={cell+' whitespace-nowrap font-medium'}>{month.period}</th><td className={numeric}>{money(month.beforeTaxable)}</td><td className={numeric}>{money(month.taxable)}</td><td className={numeric}>{money(month.difference)}</td><td className={numeric}>{money(month.beforeExempt)}</td><td className={numeric}>{money(month.exempt)}</td><td className={numeric}>{money(month.ytdTaxable)}</td><td className={numeric}>{money(month.ytdExempt)}</td><td className={cell+' min-w-72'}><details><summary className="cursor-pointer text-primary underline underline-offset-2">{t('viewItems')}</summary><div className="mt-3 space-y-3">{month.items.map((item,index)=><div key={item.code+'-'+index} className="rounded-lg border p-3"><p className="font-medium">{item.code} · {item.name}</p><dl className="mt-2 space-y-1 text-xs"><div><dt className="inline text-muted-foreground">{t('originalAmount')}: </dt><dd className="inline tabular-nums">{money(item.amount)}</dd></div><div><dt className="inline text-muted-foreground">{t('previousTreatment')}: </dt><dd className="inline">{item.previousTreatment??t('unavailable')}</dd></div><div><dt className="inline text-muted-foreground">{t('latestTreatment')}: </dt><dd className="inline">{item.latestTreatment}</dd></div><div><dt className="inline text-muted-foreground">{t('afterTaxable')}: </dt><dd className="inline tabular-nums">{money(item.taxable)}</dd></div><div><dt className="inline text-muted-foreground">{t('afterExempt')}: </dt><dd className="inline tabular-nums">{money(item.exempt)}</dd></div></dl></div>)}</div></details></td></tr>)}
        </tbody></table></div>}
      </div>
    </details>)}
  </div>;
}
