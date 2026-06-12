import Link from 'next/link';
import { requireAdmin } from '@/lib/authz';
import { auditAggregateTypes, auditEvents } from '@/core/read';
import { Card, Field, PageHeader, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { AuditTable } from '@/components/audit-table';
import { aggregateLabel } from '@/lib/audit-format';

const PAGE = 100;

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; q?: string; from?: string; to?: string; page?: string }>;
}) {
  const s = await requireAdmin();
  const sp = await searchParams;
  const page = Math.max(0, Number(sp.page) || 0);
  const filters = {
    aggregateType: sp.type || undefined,
    eventQuery: sp.q || undefined,
    from: /^\d{4}-\d{2}-\d{2}$/.test(sp.from ?? '') ? sp.from : undefined,
    to: /^\d{4}-\d{2}-\d{2}$/.test(sp.to ?? '') ? sp.to : undefined,
    limit: PAGE + 1, // fetch one extra to know if there's a next page
    offset: page * PAGE,
  };
  const [rowsPlusOne, types] = await Promise.all([auditEvents(s, filters), auditAggregateTypes(s)]);
  const hasNext = rowsPlusOne.length > PAGE;
  const rows = rowsPlusOne.slice(0, PAGE);
  const nowMs = Date.now();

  const qs = (over: Record<string, string | number | undefined>) => {
    const merged = { type: sp.type, q: sp.q, from: sp.from, to: sp.to, page: sp.page, ...over };
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, String(v));
    return `/admin/audit?${p.toString()}`;
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title="Audit trail" description="Every recorded change — who, what, when (append-only)" />

      <Card>
        <form className="grid grid-cols-1 items-end gap-3 p-4 sm:grid-cols-5">
          <Field label="Record type">
            <select name="type" defaultValue={sp.type ?? ''} className={inputCls}>
              <option value="">All</option>
              {types.map((t) => (
                <option key={t.aggregateType} value={t.aggregateType}>
                  {aggregateLabel(t.aggregateType)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Search event">
            <input name="q" defaultValue={sp.q ?? ''} placeholder="e.g. approved, bank, hired" className={inputCls} />
          </Field>
          <Field label="From">
            <input name="from" type="date" defaultValue={sp.from ?? ''} className={inputCls} />
          </Field>
          <Field label="To">
            <input name="to" type="date" defaultValue={sp.to ?? ''} className={inputCls} />
          </Field>
          <div className="flex items-center gap-2">
            <button className={btnPrimary}>Filter</button>
            <Link href="/admin/audit" className="text-sm text-muted-foreground hover:text-foreground">
              Reset
            </Link>
          </div>
        </form>
      </Card>

      <Card className="overflow-hidden">
        <SectionHeader title="Events" count={rows.length} />
        <AuditTable rows={rows} nowMs={nowMs} />
        {(page > 0 || hasNext) && (
          <div className="flex items-center justify-between border-t border-border px-4 py-3 text-sm">
            {page > 0 ? (
              <Link href={qs({ page: page - 1 || undefined })} className="text-primary hover:underline">
                ← Newer
              </Link>
            ) : (
              <span />
            )}
            <span className="text-xs text-muted-foreground">page {page + 1}</span>
            {hasNext ? (
              <Link href={qs({ page: page + 1 })} className="text-primary hover:underline">
                Older →
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
