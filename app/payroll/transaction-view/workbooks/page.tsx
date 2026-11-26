import { getTranslations, getFormatter } from 'next-intl/server';
import { Button, Card, PageHeader, pageWideCls } from '@/components/ui';
import { scopedAdmin } from '@/lib/scope';
import { bulkJobActive } from '@/lib/bulk-job';
import { listTransactionWorkbooks } from '@/core/payroll-transaction-export';
import { RefreshWorkbookList } from './refresh';

export default async function TransactionWorkbookList({
  searchParams,
}: { searchParams: Promise<{ job?: string; unavailable?: string; tab?: string }> }) {
  const { s, scopeIds } = await scopedAdmin();
  const { job, unavailable, tab } = await searchParams;
  const t = await getTranslations('payroll.transactions.view.workbooks');
  const format = await getFormatter();
  const jobs = await listTransactionWorkbooks(s, scopeIds);
  const preparing = jobs.filter((item) => bulkJobActive(item.state)).map((item) => item.id);
  const backHref = tab === 'fixed' || tab === 'individual' || tab === 'history' ? `/payroll/transaction-view?tab=${tab}` : '/payroll/transaction-view';

  return (
    <main className={pageWideCls}>
      <PageHeader title={t('title')} back={{ href: backHref, label: t('back') }} />
      {(unavailable || (job && !jobs.some((item) => item.id === job))) && (
        <p role="alert" className="text-sm text-destructive">{t('unavailable')}</p>
      )}
      {/* Polls the small preparing route and re-renders once when none is left; keyed so a render that still shows a
          workbook being prepared (for example one started in another tab) starts a fresh poll. */}
      {preparing.length > 0 && <RefreshWorkbookList key={preparing.join(',')} />}
      <Card className="overflow-hidden">
        {jobs.length === 0 ? <p className="p-4 text-sm text-muted-foreground">{t('empty')}</p> : (
          <ul className="divide-y divide-border">
            {jobs.map((item) => {
              const expires = item.finishedAt && Date.now() - item.finishedAt.getTime() >= 86_400_000;
              const kind = item.exportKind;
              return (
                <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                  aria-current={item.id === job ? 'true' : undefined}>
                  <div>
                    <p className="font-medium">{kind === 'fixed' ? t('fixed') : kind === 'individual' ? t('individual') : kind === 'history' ? t('history') : t('workbook')}</p>
                    <p className="text-sm text-muted-foreground">
                      {format.dateTime(item.createdAt, { dateStyle: 'medium', timeStyle: 'short' })}
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
