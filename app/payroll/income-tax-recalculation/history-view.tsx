import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import type {SessionContext} from '@/db/client';
import {listTaxBasisHistory,listQueuedTaxBasisRuns} from '@/packs/payroll/service';
import {PageHeader,pageWideCls} from '@/components/ui';
import {TaxBasisHistory} from './history-table';

/** a16382b4 — Recalculation history, shown as the `view=history` view of Recalculate Income Tax Value (same route,
 * guard and function-access key): one row per company per run, queued and running ones included. It is a view of
 * the existing page rather than a new linkable page, so it adds no new AI Centre surface. */
export const TAX_BASIS_HISTORY_HREF='/payroll/income-tax-recalculation?view=history';
export async function TaxBasisHistoryView({ctx,after,pageKey}:{ctx:SessionContext;after?:string;pageKey?:string}){
  const t=await getTranslations('payrollTaxBasis');
  const cursor=after&&pageKey?{createdAt:after,id:pageKey}:null;
  const [page,queued]=await Promise.all([listTaxBasisHistory(ctx,{cursor}),cursor?Promise.resolve([]):listQueuedTaxBasisRuns(ctx)]);
  const next=page.next?TAX_BASIS_HISTORY_HREF+'&'+new URLSearchParams({after:page.next.createdAt,key:page.next.id}).toString():null;
  return <div className={pageWideCls}>
    <PageHeader title={t('history')} description={t('historyDescription')} back={{href:'/payroll/income-tax-recalculation',label:t('backRecalculation')}}/>
    <TaxBasisHistory rows={[...queued,...page.rows]}/>
    {(cursor||next)&&<nav aria-label={t('historyPagination')} className="flex flex-wrap justify-end gap-3 text-sm">
      {cursor&&<Link className="rounded-lg border border-border px-4 py-2 font-medium" href={TAX_BASIS_HISTORY_HREF}>{t('historyFirstPage')}</Link>}
      {next&&<Link className="rounded-lg border border-border px-4 py-2 font-medium" href={next}>{t('historyNextPage')}</Link>}
    </nav>}
  </div>;
}
