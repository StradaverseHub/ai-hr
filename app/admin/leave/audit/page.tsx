import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { auditActors, auditEvents, listCompanies, listLeaveTypes } from '@/core/read';
import { Card, Field, PageHeader, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { LeaveTabs } from '@/components/leave-tabs';
import { AuditTable } from '@/components/audit-table';
import { aggregateLabel } from '@/lib/audit-format';

const PAGE = 100;

/**
 * Leave Settings — Audit tab (0d147b78 — Leave Settings Reorganization; enhanced 4ec5a940).
 *
 * Read-only history of every leave-config change (entitlements, eligibility, carry-forward, payroll
 * integration, approval workflow, leave-type activation/creation) — filtered to the leave module's
 * aggregate types. Reuses the append-only DomainEvent ledger via `auditEvents` and the shared
 * `AuditTable`. 4ec5a940 adds: User / Action / Company / Leave-type filters (combinable), a day-grouped
 * timeline (Today / Yesterday / date), a real before→after diff on expand, and CSV/XLSX/PDF export.
 * Substrate note: this is a read-only view, so it appends no DomainEvent (deliberate, documented skip).
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

// 4ec5a940 — the action filter's allowlist. Each entry is used LITERALLY as the event-type suffix
// (`event_type ilike '%.'||action`), so every option maps 1:1 to a real leave-config event suffix.
const ACTION_OPTIONS = ['created', 'updated', 'deleted', 'archived', 'unarchived', 'superseded'] as const;

/** KL-calendar day key (yyyy-mm-dd) for grouping — the tenant's local calendar, not UTC. */
function klDayKey(d: Date | string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuala_Lumpur' }).format(new Date(d));
}

export default async function LeaveAuditPage({
  searchParams,
}: {
  searchParams: Promise<{
    type?: string;
    q?: string;
    from?: string;
    to?: string;
    page?: string;
    action?: string;
    user?: string;
    company?: string;
    leaveType?: string;
  }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.leave');
  const ta = await getTranslations('admin.audit');
  const sp = await searchParams;
  const page = Math.max(0, Number(sp.page) || 0);
  // The record-type dropdown offers only the leave aggregates; an out-of-set ?type is ignored so the
  // Audit tab can never show non-leave events. Absent ⇒ the full leave set.
  const chosenType = (LEAVE_AGGREGATES as readonly string[]).includes(sp.type ?? '') ? sp.type : undefined;
  const chosenAction = (ACTION_OPTIONS as readonly string[]).includes(sp.action ?? '') ? sp.action : undefined;

  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const chosenUser = uuidRe.test(sp.user ?? '') ? sp.user : undefined;
  const chosenCompany = uuidRe.test(sp.company ?? '') ? sp.company : undefined;
  const chosenLeaveType = uuidRe.test(sp.leaveType ?? '') ? sp.leaveType : undefined;

  const [companies, leaveTypes, actors] = await Promise.all([
    listCompanies(s),
    listLeaveTypes(s, { includeArchived: true }),
    auditActors(s, [...LEAVE_AGGREGATES]),
  ]);

  const filters = {
    aggregateType: chosenType,
    aggregateTypes: chosenType ? undefined : [...LEAVE_AGGREGATES],
    eventQuery: sp.q || undefined,
    action: chosenAction,
    actorId: chosenUser,
    companyId: chosenCompany,
    leaveTypeId: chosenLeaveType,
    from: /^\d{4}-\d{2}-\d{2}$/.test(sp.from ?? '') ? sp.from : undefined,
    to: /^\d{4}-\d{2}-\d{2}$/.test(sp.to ?? '') ? sp.to : undefined,
    limit: PAGE + 1, // fetch one extra to know if there's a next page
    offset: page * PAGE,
  };
  const rowsPlusOne = await auditEvents(s, filters);
  const hasNext = rowsPlusOne.length > PAGE;
  const rows = rowsPlusOne.slice(0, PAGE);
  const nowMs = Date.now();

  // Timeline grouping — bucket the (already occurredAt-desc) rows by KL calendar day, preserving order.
  const todayKey = klDayKey(new Date(nowMs));
  const yesterdayKey = klDayKey(new Date(nowMs - 86_400_000));
  const groups: { key: string; label: string; rows: typeof rows }[] = [];
  for (const r of rows) {
    const key = klDayKey(r.occurredAt);
    let g = groups.find((x) => x.key === key);
    if (!g) {
      const label =
        key === todayKey
          ? ta('today')
          : key === yesterdayKey
            ? ta('yesterday')
            : new Date(`${key}T00:00:00`).toLocaleDateString(undefined, {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
              });
      g = { key, label, rows: [] };
      groups.push(g);
    }
    g.rows.push(r);
  }

  // Build a query string carrying every active filter (used by pagination + the export links).
  const activeParams: Record<string, string | undefined> = {
    type: chosenType,
    q: sp.q || undefined,
    action: chosenAction,
    user: chosenUser,
    company: chosenCompany,
    leaveType: chosenLeaveType,
    from: filters.from,
    to: filters.to,
  };
  const qs = (over: Record<string, string | number | undefined>) => {
    const merged = { ...activeParams, page: sp.page, ...over };
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, String(v));
    return `/admin/leave/audit?${p.toString()}`;
  };
  const exportHref = (format: string) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(activeParams)) if (v) p.set(k, String(v));
    p.set('format', format);
    return `/admin/leave/audit/export?${p.toString()}`;
  };

  const actorName = (a: { actorId: string | null; actorName: string | null }) => a.actorName ?? ta('systemActor');

  return (
    <div className="space-y-6">
      <PageHeader title={t('pageTitle')} description={t('pageDescription')} />
      <LeaveTabs active="audit" />

      <Card>
        <p className="px-4 pt-4 text-xs text-muted-foreground">{t('auditHelp')}</p>
        <form className="grid grid-cols-1 items-end gap-3 p-4 sm:grid-cols-3 lg:grid-cols-4">
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
          <Field label={ta('action')}>
            <select name="action" defaultValue={chosenAction ?? ''} className={inputCls}>
              <option value="">{ta('allActions')}</option>
              {ACTION_OPTIONS.map((a) => (
                <option key={a} value={a}>
                  {ta(`action_${a}` as `action_${(typeof ACTION_OPTIONS)[number]}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={ta('user')}>
            <select name="user" defaultValue={chosenUser ?? ''} className={inputCls}>
              <option value="">{ta('allUsers')}</option>
              {actors
                .filter((a) => a.actorId)
                .map((a) => (
                  <option key={a.actorId} value={a.actorId!}>
                    {actorName(a)}
                  </option>
                ))}
            </select>
          </Field>
          <Field label={ta('company')}>
            <select name="company" defaultValue={chosenCompany ?? ''} className={inputCls}>
              <option value="">{ta('allCompanies')}</option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={ta('leaveType')}>
            <select name="leaveType" defaultValue={chosenLeaveType ?? ''} className={inputCls}>
              <option value="">{ta('all')}</option>
              {leaveTypes.map((lt) => (
                <option key={lt.id} value={lt.id}>
                  {lt.name}
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
          <div className="flex items-center gap-2 sm:col-span-3 lg:col-span-4">
            <button className={btnPrimary}>{ta('filter')}</button>
            <Link href="/admin/leave/audit" className="text-sm text-muted-foreground hover:text-foreground">
              {ta('reset')}
            </Link>
            <span className="ml-auto flex items-center gap-3 text-xs">
              <span className="text-muted-foreground">{ta('exportAs')}</span>
              <a href={exportHref('csv')} className="text-primary hover:underline">
                {ta('exportCsv')}
              </a>
              <a href={exportHref('xlsx')} className="text-primary hover:underline">
                {ta('exportExcel')}
              </a>
              <a href={exportHref('pdf')} className="text-primary hover:underline">
                {ta('exportPdf')}
              </a>
            </span>
          </div>
        </form>
      </Card>

      <Card className="overflow-hidden">
        <SectionHeader title={ta('events')} count={rows.length} />
        {groups.length === 0 ? (
          <AuditTable rows={rows} nowMs={nowMs} />
        ) : (
          groups.map((g) => (
            <div key={g.key}>
              <div className="border-y border-border/60 bg-muted/40 px-4 py-1.5 text-xs font-medium text-muted-foreground">
                {g.label}
              </div>
              <AuditTable rows={g.rows} nowMs={nowMs} />
            </div>
          ))
        )}
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
