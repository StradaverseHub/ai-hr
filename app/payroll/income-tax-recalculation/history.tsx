'use client';

import Link from 'next/link';
import {useFormatter,useTranslations} from 'next-intl';
import type {TaxBasisBatch} from '@/lib/payroll-tax-basis';

export function TaxBasisHistory({batches}:{batches:TaxBasisBatch[]}){
  const t=useTranslations('payrollTaxBasis'),format=useFormatter();
  return <section className="space-y-4 rounded-xl border p-5" aria-labelledby="tax-basis-history-title">
    <h2 id="tax-basis-history-title" className="font-semibold">{t('history')}</h2>
    {batches.length===0?<p className="text-sm text-muted-foreground">{t('noHistory')}</p>:<div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="bg-muted/50"><tr>{['reference','company','period','selection','employees','status','actor','date','details'].map(key=><th key={key} className="p-3 font-medium">{t(key)}</th>)}</tr></thead><tbody>{batches.map(batch=><tr key={batch.id} className="border-t align-top"><td className="p-3 font-mono text-xs">{batch.reference}</td><td className="p-3">{batch.companyName}</td><td className="p-3 whitespace-nowrap">{t('periodRange',{year:batch.year,month:t(`months.${batch.upToMonth}`)})}</td><td className="p-3">{t(batch.selection==='all'?'allEmployees':'selectedEmployees')}</td><td className="p-3 tabular-nums">{batch.employeeCount}</td><td className="p-3"><span className="font-medium">{t(`batchStates.${batch.status}`)}</span><p className="mt-1 text-xs text-muted-foreground">{t('resultCounts',{completed:batch.completedCount,failed:batch.failedCount})}</p></td><td className="p-3">{batch.actorName}</td><td className="p-3 whitespace-nowrap">{format.dateTime(new Date(batch.createdAt),{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kuala_Lumpur'})}</td><td className="p-3"><Link className="font-medium text-primary underline underline-offset-2" href={'/payroll/income-tax-recalculation/'+batch.id}>{t('viewDetails')}</Link></td></tr>)}</tbody></table></div>}
  </section>;
}
