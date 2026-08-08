import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import {
  auditActors,
  auditAggregateTypes,
  auditEvents,
  auditEventsCount,
  listCompanies,
  listLeaveTypes,
} from '@/core/read';
import { Card, Field, PageHeader, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { AuditTable } from '@/components/audit-table';
import { aggregateLabel, isModuleKey, moduleKeyOf, MODULE_KEYS, type ModuleKey } from '@/lib/audit-format';
import { Pager } from '@/components/pager';
import { pageState, parsePageQuery } from '@/lib/pagination';

/**
 * The ONE audit page (f1b994e3 — "the Audit submenu under Leave Configuration is unnecessary because
 * the system already has a central Audit Trail module").
 *
 * There was never a second store to merge: /admin/leave/audit and this page both read the single
 * append-only domain_event ledger through the same `auditWhere` predicate and both render the same
 * <AuditTable>. The leave page differed ONLY by pre-applying its own hardcoded eight-aggregate list —
 * which is also what made it wrong in two directions at once: it hid 404 real leave rows (holiday
 * calendars, entitlement schemes, shared leave groups, balance recalculations) including the newest
 * leave-config changes on the system, and it listed job-grade rows this page has always chipped
 * Organization. So the merge is a NAVIGATION and FEATURE-PARITY change, not a data change.
 *
 * What arrives here from the retired page, so nothing is taken away with it: the Action / User /
 * Company / Leave-type filters, the KL-calendar Today / Yesterday timeline, and CSV / XLSX / PDF
 * export. What is new is the AREA filter, which replaces the leave page's hardcoded list with a
 * resolution derived from AGGREGATE_MODULE — the same map that chips each row — so the area that finds
 * a row and the chip that row renders can never disagree.
 *
 * /admin/leave/audit survives as an unguarded redirect stub to `?module=leave`, so no bookmark 404s.
 * Read-only view: appends no DomainEvent (deliberate, documented skip).
 */

// 4ec5a940 — the action filter's allowlist, carried up from the leave page unchanged. Each entry is
// used LITERALLY as the event-type suffix (`event_type ilike '%.'||action`), so every option maps 1:1
// to a real event suffix.
const ACTION_OPTIONS = ['created', 'updated', 'deleted', 'archived', 'unarchived', 'superseded'] as const;

/** KL-calendar day key (yyyy-mm-dd) for grouping — the tenant's local calendar, not UTC. */
function klDayKey(d: Date | string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuala_Lumpur' }).format(new Date(d));
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{
    module?: string;
    type?: string;
    q?: string;
    from?: string;
    to?: string;
    page?: string;
    size?: string;
    action?: string;
    user?: string;
    company?: string;
    leaveType?: string;
  }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.audit');
  // The Area option labels are the module chip's own labels, read from the chip's namespace, so the two
  // are one string in six languages rather than two free to drift.
  const tm = await getTranslations('components.auditTable');
  const sp = await searchParams;
  const pq = parsePageQuery(sp);

  // An out-of-set ?module= is IGNORED (the whole log), never narrowed to nothing — the leave page's
  // treatment of an out-of-set ?type=, applied to the new control.
  const chosenModule: ModuleKey | undefined = isModuleKey(sp.module) ? sp.module : undefined;
  const chosenAction = (ACTION_OPTIONS as readonly string[]).includes(sp.action ?? '') ? sp.action : undefined;

  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const chosenUser = uuidRe.test(sp.user ?? '') ? sp.user : undefined;
  const chosenCompany = uuidRe.test(sp.company ?? '') ? sp.company : undefined;
  // The Leave-type control exists only in the Leave area, so its param only binds there. A leftover
  // ?leaveType= carried in from a leave link would otherwise silently empty every other area.
  const chosenLeaveType =
    chosenModule === 'leave' && uuidRe.test(sp.leaveType ?? '') ? sp.leaveType : undefined;

  const [allTypes, companies, leaveTypes, actors] = await Promise.all([
    auditAggregateTypes(s),
    listCompanies(s),
    chosenModule === 'leave' ? listLeaveTypes(s, { includeArchived: true }) : Promise.resolve([]),
    auditActors(s, { module: chosenModule }),
  ]);

  // The record-type dropdown offers the CHOSEN AREA's types, not everything — and only types the log
  // actually holds. An out-of-set ?type= is ignored for the same reason ?module= is.
  const types = chosenModule
    ? allTypes.filter((x) => moduleKeyOf(x.aggregateType) === chosenModule)
    : allTypes;
  const chosenType = types.some((x) => x.aggregateType === sp.type) ? sp.type : undefined;

  // fc776376 — the SAME filter object drives the page and its COUNT, so "26-50 of 312" can never
  // disagree with the rows on screen (this replaced a fetch-one-extra next-page probe).
  const filters = {
    module: chosenModule,
    aggregateType: chosenType,
    eventQuery: sp.q || undefined,
    action: chosenAction,
    actorId: chosenUser,
    companyId: chosenCompany,
    leaveTypeId: chosenLeaveType,
    from: /^\d{4}-\d{2}-\d{2}$/.test(sp.from ?? '') ? sp.from : undefined,
    to: /^\d{4}-\d{2}-\d{2}$/.test(sp.to ?? '') ? sp.to : undefined,
  };
  const [rows, total] = await Promise.all([
    auditEvents(s, { ...filters, limit: pq.limit, offset: pq.offset }),
    auditEventsCount(s, filters),
  ]);
  const pgState = pageState(pq, total, rows.length);
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
          ? t('today')
          : key === yesterdayKey
            ? t('yesterday')
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
    module: chosenModule,
    type: chosenType,
    q: sp.q || undefined,
    action: chosenAction,
    user: chosenUser,
    company: chosenCompany,
    leaveType: chosenLeaveType,
    from: filters.from,
    to: filters.to,
  };
  const exportHref = (format: string) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(activeParams)) if (v) p.set(k, String(v));
    p.set('format', format);
    return `/admin/audit/export?${p.toString()}`;
  };

  const actorName = (a: { actorId: string | null; actorName: string | null }) => a.actorName ?? t('systemActor');
  const moduleLabel = (k: ModuleKey) => tm(`module_${k}` as `module_${ModuleKey}`);

  return (
    <div className="space-y-6">
      <div data-tour="admin-audit">
        <PageHeader title={t('title')} description={t('description')} />
      </div>

      <Card data-tour="admin-audit-filters">
        <form className="grid grid-cols-1 items-end gap-3 p-4 sm:grid-cols-3 lg:grid-cols-4">
          <Field label={t('area')}>
            <select name="module" defaultValue={chosenModule ?? ''} className={inputCls}>
              <option value="">{t('allAreas')}</option>
              {MODULE_KEYS.map((m) => (
                <option key={m} value={m}>
                  {moduleLabel(m)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('recordType')}>
            <select name="type" defaultValue={chosenType ?? ''} className={inputCls}>
              <option value="">{t('all')}</option>
              {types.map((x) => (
                <option key={x.aggregateType} value={x.aggregateType}>
                  {aggregateLabel(x.aggregateType)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('action')}>
            <select name="action" defaultValue={chosenAction ?? ''} className={inputCls}>
              <option value="">{t('allActions')}</option>
              {ACTION_OPTIONS.map((a) => (
                <option key={a} value={a}>
                  {t(`action_${a}` as `action_${(typeof ACTION_OPTIONS)[number]}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('user')}>
            <select name="user" defaultValue={chosenUser ?? ''} className={inputCls}>
              <option value="">{t('allUsers')}</option>
              {actors
                .filter((a) => a.actorId)
                .map((a) => (
                  <option key={a.actorId} value={a.actorId!}>
                    {actorName(a)}
                  </option>
                ))}
            </select>
          </Field>
          <Field label={t('company')}>
            <select name="company" defaultValue={chosenCompany ?? ''} className={inputCls}>
              <option value="">{t('allCompanies')}</option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          {/* Leave type is a LEAVE question. Rendering it in the Payroll area would be a control that
              silently empties the list, so it appears only where it can mean something. */}
          {chosenModule === 'leave' && (
            <Field label={t('leaveType')}>
              <select name="leaveType" defaultValue={chosenLeaveType ?? ''} className={inputCls}>
                <option value="">{t('all')}</option>
                {leaveTypes.map((lt) => (
                  <option key={lt.id} value={lt.id}>
                    {lt.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label={t('searchEvent')}>
            <input name="q" defaultValue={sp.q ?? ''} placeholder={t('searchPlaceholder')} className={inputCls} />
          </Field>
          <Field label={t('from')}>
            <input name="from" type="date" defaultValue={sp.from ?? ''} className={inputCls} />
          </Field>
          <Field label={t('to')}>
            <input name="to" type="date" defaultValue={sp.to ?? ''} className={inputCls} />
          </Field>
          <div className="flex items-center gap-2 sm:col-span-3 lg:col-span-4">
            <button className={btnPrimary}>{t('filter')}</button>
            <Link href="/admin/audit" className="text-sm text-muted-foreground hover:text-foreground">
              {t('reset')}
            </Link>
            <span className="ml-auto flex items-center gap-3 text-xs">
              <span className="text-muted-foreground">{t('exportAs')}</span>
              <a href={exportHref('csv')} className="text-primary hover:underline">
                {t('exportCsv')}
              </a>
              <a href={exportHref('xlsx')} className="text-primary hover:underline">
                {t('exportExcel')}
              </a>
              <a href={exportHref('pdf')} className="text-primary hover:underline">
                {t('exportPdf')}
              </a>
            </span>
          </div>
        </form>
      </Card>

      <Card data-tour="admin-audit-table" className="overflow-hidden">
        <SectionHeader title={t('events')} count={rows.length} />
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
        <Pager basePath="/admin/audit" params={activeParams} state={pgState} exportHref={exportHref('csv')} />
      </Card>
    </div>
  );
}
