import Link from 'next/link';
import {notFound} from 'next/navigation';
import {getFormatter,getTranslations} from 'next-intl/server';
import {requirePayrollAccess} from '@/lib/authz';
import {getTaxBasisBatch} from '@/packs/payroll/service';
import {PageHeader,pageWideCls} from '@/components/ui';
import {TaxBasisResults} from '../results';

export default async function TaxBasisBatchPage({params}:{params:Promise<{id:string}>}){
  const ctx=await requirePayrollAccess(),{id}=await params,t=await getTranslations('payrollTaxBasis'),format=await getFormatter();
  if(!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id))notFound();
  const batch=await getTaxBasisBatch(ctx,id);if(!batch)notFound();
  return <div className={pageWideCls}>
    <PageHeader title={t('batchTitle',{reference:batch.reference})} description={batch.companyName} back={{href:'/payroll/income-tax-recalculation',label:t('backRecalculation')}}/>
    <section className="space-y-5 rounded-xl border p-5"><dl className="grid gap-5 text-sm sm:grid-cols-2 lg:grid-cols-4">
      <div><dt className="text-muted-foreground">{t('period')}</dt><dd className="mt-1 font-medium">{t('periodRange',{year:batch.year,month:t(`months.${batch.upToMonth}`)})}</dd></div>
      <div><dt className="text-muted-foreground">{t('selection')}</dt><dd className="mt-1 font-medium">{t(batch.selection==='all'?'allEmployees':'selectedEmployees')}</dd></div>
      <div><dt className="text-muted-foreground">{t('status')}</dt><dd className="mt-1 font-medium" role="status">{t(`batchStates.${batch.status}`)}</dd></div>
      <div><dt className="text-muted-foreground">{t('employees')}</dt><dd className="mt-1 font-medium tabular-nums">{batch.employeeCount}</dd></div>
      <div><dt className="text-muted-foreground">{t('actor')}</dt><dd className="mt-1 font-medium">{batch.actorName}</dd></div>
      <div><dt className="text-muted-foreground">{t('date')}</dt><dd className="mt-1 font-medium">{format.dateTime(new Date(batch.createdAt),{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kuala_Lumpur'})}</dd></div>
      <div><dt className="text-muted-foreground">{t('outcomes')}</dt><dd className="mt-1 font-medium">{t('resultCounts',{completed:batch.completedCount,failed:batch.failedCount})}</dd></div>
      <div><dt className="text-muted-foreground">{t('records')}</dt><dd className="mt-1 font-medium tabular-nums">{batch.recordCount}</dd></div>
    </dl><p className="border-t pt-4 text-xs text-muted-foreground">{t('preserved')}</p>
      {batch.failedCount>0&&<div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-amber-300 bg-amber-50/40 p-4 dark:border-amber-700 dark:bg-amber-950/10"><p className="max-w-3xl text-sm">{t('partialHint')}</p><Link className="rounded-lg border bg-background px-4 py-2 text-sm font-medium" href={'/payroll/income-tax-recalculation?retry='+batch.id}>{t('retryFailed')}</Link></div>}
      {(batch.status==='processing'||batch.status==='pending')&&<div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border p-4"><p className="text-sm text-muted-foreground">{t('processingHint')}</p><Link href={'/payroll/income-tax-recalculation/'+batch.id} className="text-sm font-medium text-primary underline">{t('refresh')}</Link></div>}
    </section>
    <section className="space-y-4"><h2 className="font-semibold">{t('employeeOutcomes')}</h2><TaxBasisResults employees={batch.employees}/></section>
  </div>;
}
