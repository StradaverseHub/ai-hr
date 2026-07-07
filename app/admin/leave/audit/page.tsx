import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { auditEvents } from '@/core/read';
import { Card, Field, PageHeader, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { LeaveTabs } from '@/components/leave-tabs';
import { AuditTable } from '@/components/audit-table';
import { aggregateLabel } from '@/lib/audit-format';

const PAGE = 100;

/**
 * Leave Settings — Audit tab (0d147b78 — Leave Settings Reorganization).
 *
 * Read-only history of every change the ticket lists (entitlements, eligibility, carry-forward,
 * payroll integration, approval workflow, leave-type activation/creation) — filtered to the leave
 * module's aggregate types. Reuses the existing append-only DomainEvent ledger via `auditEvents`
 * (extended with `aggregateTypes`) and the shared `AuditTable` / `aggregateLabel` — NO new audit
 * table, NO new event types, NO writes. Substrate note: this is a read-only view, so it appends no
 * DomainEvent (deliberate, documented skip).
 */

// The leave module's aggregate types, all already populated in the ledger by the leave services.
const LEAVE_AGGREGATES = [
  'leave-type',
  'leave-policy',
  'leave-approval-policy',
  'leave-year',
  'leave-encashment-policy',
  'leave-grant',
  'job-grade',
  'leave-ledger-import',
] as const;

export default async function LeaveAuditPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; q?: string; from?: string; to?: string; page?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.leave');
  const ta = await getTranslations('admin.audit');
  const sp = await searchParams;
  const page = Math.max(0, Number(sp.page) || 0);
  // The record-type dropdown offers only the leave aggregates; an out-of-set ?type is ignored so the
  // Audit tab can never show non-leave events. Absent ⇒ the full leave set.
  const chosenType = (LEAVE_AGGREGATES as readonly string[]).includes(sp.type ?? '') ? sp.type : undefined;
  const filters = {
    aggregateType: chosenType,
    aggregateTypes: chosenType ? undefined : [...LEAVE_AGGREGATES],
    eventQuery: sp.q || undefined,
    from: /^\d{4}-\d{2}-\d{2}$/.test(sp.from ?? '') ? sp.from : undefined,
    to: /^\d{4}-\d{2}-\d{2}$/.test(sp.to ?? '') ? sp.to : undefined,
    limit: PAGE + 1, // fetch one extra to know if there's a next page
    offset: page * PAGE,
  };
  const rowsPlusOne = await auditEvents(s, filters);
  const hasNext = rowsPlusOne.length > PAGE;
  const rows = rowsPlusOne.slice(0, PAGE);
  const nowMs = Date.now();

  const qs = (over: Record<string, string | number | undefined>) => {
    const merged = { type: sp.type, q: sp.q, from: sp.from, to: sp.to, page: sp.page, ...over };
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, String(v));
    return `/admin/leave/audit?${p.toString()}`;
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={t('pageTitle')} description={t('pageDescription')} />
      <LeaveTabs active="audit" />

      <Card>
        <p className="px-4 pt-4 text-xs text-muted-foreground">{t('auditHelp')}</p>
        <form className="grid grid-cols-1 items-end gap-3 p-4 sm:grid-cols-5">
          <Field label={ta('recordType')}>
            <select name="type" defaultValue={chosenType ?? ''} className={inputCls}>
              <option value="">{ta('all')}</option>
              {LEAVE_AGGREGATES.map((agg) => (
                <option key={agg} value={agg}>
                  {aggregateLabel(agg)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={ta('searchEvent')}>
            <input name="q" defaultValue={sp.q ?? ''} placeholder={ta('searchPlaceholder')} className={inputCls} />
          </Field>
          <Field label={ta('from')}>
            <input name="from" type="date" defaultValue={sp.from ?? ''} className={inputCls} />
          </Field>
          <Field label={ta('to')}>
            <input name="to" type="date" defaultValue={sp.to ?? ''} className={inputCls} />
          </Field>
          <div className="flex items-center gap-2">
            <button className={btnPrimary}>{ta('filter')}</button>
            <Link href="/admin/leave/audit" className="text-sm text-muted-foreground hover:text-foreground">
              {ta('reset')}
            </Link>
          </div>
        </form>
      </Card>

      <Card className="overflow-hidden">
        <SectionHeader title={ta('events')} count={rows.length} />
        <AuditTable rows={rows} nowMs={nowMs} />
        {(page > 0 || hasNext) && (
          <div className="flex items-center justify-between border-t border-border px-4 py-3 text-sm">
            {page > 0 ? (
              <Link href={qs({ page: page - 1 || undefined })} className="text-primary hover:underline">
                ← {ta('newer')}
              </Link>
            ) : (
              <span />
            )}
            <span className="text-xs text-muted-foreground">{ta('pageIndicator', { page: page + 1 })}</span>
            {hasNext ? (
              <Link href={qs({ page: page + 1 })} className="text-primary hover:underline">
                {ta('older')} →
              </Link>
            ) : (
              <span />
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
