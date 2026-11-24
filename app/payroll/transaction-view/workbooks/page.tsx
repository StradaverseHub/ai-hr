import { getTranslations, getFormatter } from 'next-intl/server';
import { Button, Card, PageHeader, pageWideCls } from '@/components/ui';
import { scopedAdmin } from '@/lib/scope';
import { bulkJobActive } from '@/lib/bulk-job';
import { listBulkJobsTx } from '@/core/bulk-job';
import { TRANSACTION_EXPORT_KIND } from '@/core/payroll-transaction-export';
import { withPayrollTenant } from '@/core/module-gate';
import { RefreshWorkbookList } from './refresh';

export default async function TransactionWorkbookList({
  searchParams,
}: { searchParams: Promise<{ job?: string; unavailable?: string; tab?: string }> }) {
  const { s, scopeIds } = await scopedAdmin();
  const { job, unavailable, tab } = await searchParams;
  const t = await getTranslations('payroll.transactions.view.workbooks');
  const format = await getFormatter();
  const jobs = (await withPayrollTenant(s, (tx) => listBulkJobsTx(tx, s, TRANSACTION_EXPORT_KIND, 25)))
    .filter((item) => item.company_ids.length > 0 && item.company_ids.every((id) => scopeIds.includes(id)));
  const active = jobs.some((item) => bulkJobActive(item.state));
  const backHref = tab === 'fixed' || tab === 'individual' || tab === 'history' ? `/payroll/transaction-view?tab=${tab}` : '/payroll/transaction-view';

  return (
    <main className={pageWideCls}>
      <PageHeader title={t('title')} back={{ href: backHref, label: t('back') }} />
      {(unavailable || (job && !jobs.some((item) => item.id === job))) && (
        <p role="alert" className="text-sm text-destructive">{t('unavailable')}</p>
      )}
      {active && <RefreshWorkbookList />}
      <Card className="overflow-hidden">
        {jobs.length === 0 ? <p className="p-4 text-sm text-muted-foreground">{t('empty')}</p> : (
          <ul className="divide-y divide-border">
            {jobs.map((item) => {
              const expires = item.finished_at && Date.now() - new Date(item.finished_at).getTime() >= 86_400_000;
              const query = item.input as { kind?: string } | null;
              const result = item.result as { kind?: string } | null;
              const kind = result?.kind ?? query?.kind;
              return (
                <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                  aria-current={item.id === job ? 'true' : undefined}>
                  <div>
                    <p className="font-medium">{kind === 'fixed' ? t('fixed') : kind === 'individual' ? t('individual') : kind === 'history' ? t('history') : t('workbook')}</p>
                    <p className="text-sm text-muted-foreground">
                      {format.dateTime(new Date(item.created_at), { dateStyle: 'medium', timeStyle: 'short' })}
                    </p>
                    {item.state === 'failed' && <p className="text-sm text-destructive">{t('failed')}</p>}
                  </div>
                  {item.state === 'completed' && !expires ? (
                    // Button asChild, never buttonVariants(): that function lives in a 'use client' module and
                    // throws when a server page calls it — production 2026-11-24, every finished workbook.
                    <Button asChild variant="outline" size="sm">
                      <a href={`/payroll/transaction-view/workbooks/${item.id}`}>{t('download')}</a>
                    </Button>
                  ) : (
                    <span className="text-sm text-muted-foreground">
                      {bulkJobActive(item.state) ? t('preparing') : item.state === 'completed' ? t('expired') : null}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </main>
  );
}
