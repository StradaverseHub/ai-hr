import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { auditAggregateTypes, auditEvents, auditEventsCount } from '@/core/read';
import { Card, Field, PageHeader, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { AuditTable } from '@/components/audit-table';
import { aggregateLabel } from '@/lib/audit-format';
import { Pager } from '@/components/pager';
import { pageState, parsePageQuery } from '@/lib/pagination';

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{
    type?: string;
    q?: string;
    from?: string;
    to?: string;
    page?: string;
    size?: string;
  }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.audit');
  const sp = await searchParams;
  const pq = parsePageQuery(sp);
  // fc776376 — the SAME filter object drives the page and its COUNT, so "26-50 of 312" can never
  // disagree with the rows on screen (this replaced a fetch-one-extra next-page probe).
  const filters = {
    aggregateType: sp.type || undefined,
    eventQuery: sp.q || undefined,
    from: /^\d{4}-\d{2}-\d{2}$/.test(sp.from ?? '') ? sp.from : undefined,
    to: /^\d{4}-\d{2}-\d{2}$/.test(sp.to ?? '') ? sp.to : undefined,
  };
  const [rows, total, types] = await Promise.all([
    auditEvents(s, { ...filters, limit: pq.limit, offset: pq.offset }),
    auditEventsCount(s, filters),
    auditAggregateTypes(s),
  ]);
  const pgState = pageState(pq, total, rows.length);
  const nowMs = Date.now();

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div data-tour="admin-audit">
        <PageHeader title={t('title')} description={t('description')} />
      </div>

      <Card data-tour="admin-audit-filters">
        <form className="grid grid-cols-1 items-end gap-3 p-4 sm:grid-cols-5">
          <Field label={t('recordType')}>
            <select name="type" defaultValue={sp.type ?? ''} className={inputCls}>
              <option value="">{t('all')}</option>
              {types.map((t) => (
                <option key={t.aggregateType} value={t.aggregateType}>
                  {aggregateLabel(t.aggregateType)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('searchEvent')}>
            <input name="q" defaultValue={sp.q ?? ''} placeholder={t('searchPlaceholder')} className={inputCls} />
          </Field>
          <Field label={t('from')}>
            <input name="from" type="date" defaultValue={sp.from ?? ''} className={inputCls} />
          </Field>
          <Field label={t('to')}>
            <input name="to" type="date" defaultValue={sp.to ?? ''} className={inputCls} />
          </Field>
          <div className="flex items-center gap-2">
            <button className={btnPrimary}>{t('filter')}</button>
            <Link href="/admin/audit" className="text-sm text-muted-foreground hover:text-foreground">
              {t('reset')}
            </Link>
          </div>
        </form>
      </Card>

      <Card data-tour="admin-audit-table" className="overflow-hidden">
        <SectionHeader title={t('events')} count={rows.length} />
        <AuditTable rows={rows} nowMs={nowMs} />
        <Pager
          basePath="/admin/audit"
          params={{ type: sp.type, q: sp.q, from: sp.from, to: sp.to }}
          state={pgState}
        />
      </Card>
    </div>
  );
}
