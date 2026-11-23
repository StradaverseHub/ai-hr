import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {requirePayrollAccess} from '@/lib/authz';
import {listTaxBasisHistory,listQueuedTaxBasisRuns} from '@/packs/payroll/service';
import {PageHeader,pageWideCls} from '@/components/ui';
import {TaxBasisHistory} from '../history-table';

/** a16382b4 — Recalculation history on its own page: one row per company per run, queued and running ones included. */
export default async function TaxBasisHistoryPage({searchParams}:{searchParams:Promise<{after?:string;key?:string}>}){
  const ctx=await requirePayrollAccess(),t=await getTranslations('payrollTaxBasis');
  const {after,key}=await searchParams;
  const cursor=after&&key?{createdAt:after,id:key}:null;
  const [page,queued]=await Promise.all([listTaxBasisHistory(ctx,{cursor}),cursor?Promise.resolve([]):listQueuedTaxBasisRuns(ctx)]);
  const next=page.next?'/payroll/income-tax-recalculation/history?'+new URLSearchParams({after:page.next.createdAt,key:page.next.id}).toString():null;
  return <div className={pageWideCls}>
    <PageHeader title={t('history')} description={t('historyDescription')} back={{href:'/payroll/income-tax-recalculation',label:t('backRecalculation')}}/>
    <TaxBasisHistory rows={[...queued,...page.rows]}/>
    {(cursor||next)&&<nav aria-label={t('historyPagination')} className="flex flex-wrap justify-end gap-3 text-sm">
      {cursor&&<Link className="rounded-lg border border-border px-4 py-2 font-medium" href="/payroll/income-tax-recalculation/history">{t('historyFirstPage')}</Link>}
      {next&&<Link className="rounded-lg border border-border px-4 py-2 font-medium" href={next}>{t('historyNextPage')}</Link>}
    </nav>}
  </div>;
}
