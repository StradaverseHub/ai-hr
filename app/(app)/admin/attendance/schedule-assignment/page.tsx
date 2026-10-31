import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { UNGROUPED, listShiftArrangements, type ShiftArrangementListRow } from '@/core/shift-arrangement';
import { listShiftsForTenant } from '@/core/roster';
// 8cd601d0 — the Schedule Group filter's options, through the pack facade (the same import the personnel
// card and the detail page use). The tenant's attendance_rule library IS the Schedule Group library.
import { listAttendanceRules } from '@/packs/attendance/service';
import { todayInKualaLumpur } from '@/lib/hr-date';
import {
  Card,
  EmployeeCode,
  ErrorBanner,
  PageHeader,
  SectionHeader,
  btnPrimary,
  pageWideCls,
  tableWrapCls,
  tbodyCls,
  theadCls,
  thCls,
} from '@/components/ui';
import { FilterChips, FilterPanel, type FilterField } from '@/components/filter-panel';
import { StatusChip } from './status-chip';

/**
 * Schedule Assignment (feedback 0bade264 r209; edited in place by a485afa1 r263; a page of its own for
 * each row by a485afa1 rev 2, r265) — every employee's shift arrangement in ONE list.
 *
 * THE ITEM IN ONE LINE. The arrangement already existed and was already maintained per employee, under
 * Personnel Management › Employee › Attendance › Shift arrangement. What did not exist was a place to
 * see everybody's at once: the only way to answer "who is on which shift" was to open employees one at
 * a time.
 *
 * ⚠️ THE ROW ACTION HAS MOVED TWICE — read this before restoring either earlier link.
 * r209 sent View / Edit to `/admin/personnel/<id>?tab=attendance#section-default-shift` on the argument
 * that a second form here would be a second write path over one table. The reporter came back: assigning a
 * shift to twenty people was twenty round trips out of the Attendance module and back. r263 answered with
 * a panel ABOVE this list (`?assign=<id>#assign-panel`) — sound about WRITERS (still one, in core) but the
 * panel sat at the top of a 74-row list, so View / Edit on a row near the bottom jumped the browser to the
 * top and Close put the administrator back at the top, not at the row. The reporter contested that too.
 * r265: View / Edit opens ./[employmentId]/page.tsx, a page of its own, and this file is a list again.
 * What r263 established is unchanged and pinned by test/schedule-assignment.test.ts: the page over there
 * mounts the personnel card's own control (components/employee-shift-fields.tsx) and calls the card's own
 * writer through ./actions.ts; the personnel card KEEPS its copy.
 *
 * WHAT "CURRENT" MEANS is decided in core/shift-arrangement.ts listShiftArrangements, off the live
 * partial unique index and the shared `pickArrangementOn` rule — not here, and not by sorting rows in
 * this file. See that function's header.
 *
 * COMING BACK TO THE ROW. Every row is `id="row-<employmentId>"`, and the detail page's Back, Cancel and
 * Save all return to this list with the filters unchanged plus `?focus=<id>#row-<id>`: the browser lands
 * on that row and it is highlighted. If a save moved the employee OUT of the filtered set (filtered by
 * backup shift, then the backup shift was changed), the saved note still shows and no row is highlighted
 * — the note is true, and the row is simply not in this view any more.
 *
 * `?assign=<id>` — r263's panel parameter — is honoured as a REDIRECT to the detail page, filters and
 * all, so a link or bookmark written before r265 still opens the same employee. A malformed value is
 * dropped: the list renders as if it were not there.
 *
 * requireAdmin(), like every other row of the Attendance menu it hangs under: the list names every
 * employee in the tenant. The menu is not what protects it (test/attendance-menu-relocation.test.ts).
 */
const PAGE = '/admin/attendance/schedule-assignment';

/**
 * `?assign=` IS AN UNTRUSTED QUERY PARAM AND `employment.id` IS A UUID COLUMN. It never reaches a query
 * from this file any more — it only decides WHERE to redirect — but the detail page it redirects to
 * checks the same shape before its own query, and a junk value is dropped here rather than forwarded
 * (lib/calendar-focus.ts: "Junk is dropped rather than rendered").
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ScheduleAssignmentPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    shiftType?: string;
    shiftId?: string;
    status?: string;
    scheduleGroupId?: string;
    focus?: string;
    assign?: string;
    error?: string;
    saved?: string;
  }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.scheduleAssignment');
  const sp = await searchParams;

  // A GET form posts every select, so an unchosen one arrives as '' — read by VALUE, never by presence.
  const q = sp.q?.trim() || undefined;
  const shiftType = sp.shiftType === 'fixed' || sp.shiftType === 'roster' ? sp.shiftType : undefined;
  const status =
    sp.status === 'current' || sp.status === 'scheduled' || sp.status === 'notRecorded' ? sp.status : undefined;
  const shiftId = sp.shiftId?.trim() || undefined;
  /**
   * 8cd601d0 — the Schedule Group filter. `UNGROUPED` is a sentinel, not a rule id: "in no Schedule Group"
   * is the state 74 of 75 production employments are in, so it has to be a choice on the list rather than
   * something an administrator infers from an em-dash in a column. Read by VALUE like every other filter;
   * a junk value simply matches no row (it is compared against resolved rows, never queried).
   */
  const scheduleGroupId = sp.scheduleGroupId?.trim() || undefined;
  // The row to land on and highlight after a trip to the detail page. Compared against row ids only —
  // it is never queried, so a junk value highlights nothing and harms nothing.
  const focus = sp.focus?.trim() || undefined;

  /**
   * Every link carries the FILTERS the administrator is working under. Opening a row's page, and every
   * way back from it, must all come to the same list — a screen that resets its filters on save is the
   * twenty-round-trips complaint in a different costume.
   */
  const hrefWith = (pathname: string, extra: Record<string, string | undefined>) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries({ q, shiftType, shiftId, status, scheduleGroupId, ...extra })) {
      if (v) params.set(k, v);
    }
    const qs = params.toString();
    return `${pathname}${qs ? `?${qs}` : ''}`;
  };
  /** The row action: the employee's own Shift arrangement page, filters riding along. */
  const editHref = (employmentId: string) => hrefWith(`${PAGE}/${employmentId}`, {});
  /**
   * 8cd601d0 — the bulk screen, with THESE filters. The filters are the selection: an administrator who
   * has narrowed the list to "no Schedule Group" and clicks through gets exactly those people to tick,
   * rather than starting again from seventy-five rows on a second screen.
   */
  const bulkHref = hrefWith(`${PAGE}/bulk`, {});

  // r263's `?assign=<id>` — a link written before r265 opens the same employee on the new page.
  const assign = sp.assign?.trim();
  if (assign && UUID_RE.test(assign)) redirect(editHref(assign));

  // ONE "today" for the whole render: the status buckets all answer to the same calendar day, in the
  // tenant's timezone (never the UTC date — between 00:00 and 08:00 MYT that names yesterday).
  const today = todayInKualaLumpur();

  const [rows, shifts, scheduleGroups] = await Promise.all([
    listShiftArrangements(s, { q, shiftType, shiftId, status, scheduleGroupId, today }),
    // Live shifts only: the backup-shift filter offers what can be assigned today.
    listShiftsForTenant(s),
    listAttendanceRules(s),
  ]);

  const SHIFT_TYPE_LABEL: Record<ShiftArrangementListRow['shiftType'], string> = {
    fixed: t('shiftTypeFixed'),
    roster: t('shiftTypeRoster'),
  };
  const STATUS_LABEL: Record<ShiftArrangementListRow['status'], string> = {
    current: t('statusCurrent'),
    scheduled: t('statusScheduled'),
    notRecorded: t('statusNotRecorded'),
  };
  const STATUS_HINT: Record<ShiftArrangementListRow['status'], string> = {
    current: t('statusCurrentHint'),
    scheduled: t('statusScheduledHint'),
    notRecorded: t('statusNotRecordedHint'),
  };

  // All strings PRE-TRANSLATED: FilterPanel/FilterChips are client islands and must not call t() (the
  // i18n static-key guard reads one namespace per file, and a translator closure cannot cross the
  // server/client boundary).
  const filterFields: FilterField[] = [
    {
      kind: 'search',
      name: 'q',
      label: t('filters.search'),
      placeholder: t('filters.searchPlaceholder'),
      ariaLabel: t('filters.searchAria'),
      removeAriaLabel: t('filters.removeFilter', { label: t('filters.search') }),
    },
    {
      kind: 'select',
      name: 'shiftType',
      label: t('filters.shiftType'),
      ariaLabel: t('filters.shiftType'),
      allLabel: t('filters.allShiftTypes'),
      options: [
        { value: 'fixed', label: SHIFT_TYPE_LABEL.fixed },
        { value: 'roster', label: SHIFT_TYPE_LABEL.roster },
      ],
      removeAriaLabel: t('filters.removeFilter', { label: t('filters.shiftType') }),
    },
    {
      kind: 'select',
      name: 'shiftId',
      label: t('filters.backupShift'),
      ariaLabel: t('filters.backupShift'),
      allLabel: t('filters.allBackupShifts'),
      options: shifts.map((sh) => ({ value: sh.id, label: `${sh.code ?? '—'} — ${sh.name}` })),
      removeAriaLabel: t('filters.removeFilter', { label: t('filters.backupShift') }),
    },
    {
      kind: 'select',
      name: 'status',
      label: t('filters.status'),
      ariaLabel: t('filters.status'),
      allLabel: t('filters.allStatuses'),
      options: [
        { value: 'current', label: STATUS_LABEL.current },
        { value: 'scheduled', label: STATUS_LABEL.scheduled },
        { value: 'notRecorded', label: STATUS_LABEL.notRecorded },
      ],
      removeAriaLabel: t('filters.removeFilter', { label: t('filters.status') }),
    },
    {
      // 8cd601d0. The options are the tenant's rule library as it stands, PLUS the "in none" sentinel —
      // never a written-down list of group names, so the 07ebd04d split into three groups shows up here
      // by itself.
      kind: 'select',
      name: 'scheduleGroupId',
      label: t('filters.scheduleGroup'),
      ariaLabel: t('filters.scheduleGroup'),
      allLabel: t('filters.allScheduleGroups'),
      options: [
        { value: UNGROUPED, label: t('filters.noScheduleGroup') },
        ...scheduleGroups.map((g) => ({ value: g.id, label: g.name })),
      ],
      removeAriaLabel: t('filters.removeFilter', { label: t('filters.scheduleGroup') }),
    },
  ];
  const filterValues = {
    q: q ?? '',
    shiftType: shiftType ?? '',
    shiftId: shiftId ?? '',
    status: status ?? '',
    scheduleGroupId: scheduleGroupId ?? '',
  };
  const activeCount = [q, shiftType, shiftId, status, scheduleGroupId].filter(Boolean).length;
  const filterLabels = {
    filter: t('filters.filter'),
    apply: t('filters.apply'),
    clearAll: t('filters.clearAll'),
    activeCount: t('filters.activeCount', { count: activeCount }),
  };

  return (
    <div className={pageWideCls}>
      <PageHeader
        title={t('pageTitle')}
        description={t('pageDescription')}
        actions={
          <div className="flex items-center gap-2">
            {/* 8cd601d0 — the way into the bulk screen, carrying the filters as the starting selection. */}
            <Link href={bulkHref} className={btnPrimary}>
              {t('bulkLink')}
            </Link>
            <FilterPanel
              action={PAGE}
              fields={filterFields}
              values={filterValues}
              labels={filterLabels}
            />
          </div>
        }
      />
      <FilterChips
        action={PAGE}
        fields={filterFields}
        values={filterValues}
        labels={filterLabels}
      />

      {/* `saved=1` is what a save returns with; a removal stays on the detail page (r265), so nothing
          lands here with `removed=` any more and the list carries no note for it. */}
      <ErrorBanner message={sp.error} />
      {!sp.error && sp.saved ? (
        <p className="rounded-lg border border-emerald-500/30 bg-emerald-50 px-4 py-3 text-sm text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400">
          {t('savedNote')}
        </p>
      ) : null}

      <Card>
        <SectionHeader title={t('listTitle')} count={rows.length} />
        {rows.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <div className="px-4 py-3">
            <div className={tableWrapCls}>
              <table className="w-full text-sm">
                <thead className={theadCls}>
                  <tr>
                    <th className={thCls}>{t('colEmployeeId')}</th>
                    <th className={thCls}>{t('colName')}</th>
                    <th className={thCls}>{t('colCompany')}</th>
                    <th className={thCls}>{t('colScheduleGroup')}</th>
                    <th className={thCls}>{t('colShiftType')}</th>
                    <th className={thCls}>{t('colBackupShift')}</th>
                    <th className={thCls}>{t('colEffectiveFrom')}</th>
                    <th className={thCls}>{t('colStatus')}</th>
                    <th className={thCls}></th>
                  </tr>
                </thead>
                <tbody className={tbodyCls}>
                  {rows.map((r) => (
                    <tr
                      key={r.employmentId}
                      id={`row-${r.employmentId}`}
                      className={r.employmentId === focus ? 'bg-muted/50' : undefined}
                    >
                      <td className="px-3 py-2.5">
                        {r.employeeCode ? <EmployeeCode code={r.employeeCode} /> : '—'}
                      </td>
                      <td className="px-3 py-2.5 font-medium">{r.name}</td>
                      <td className="px-3 py-2.5 text-muted-foreground">{r.company}</td>
                      {/* 8cd601d0 — the group the employee is IN. Em-dash means "in none", which is not a
                          gap in the data: it is the state that makes the allowed-shift refusal a no-op for
                          that person, and it is what the bulk screen exists to change. */}
                      <td className="px-3 py-2.5">
                        {r.scheduleGroupName ?? (
                          <span className="text-muted-foreground">{t('noScheduleGroup')}</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">{SHIFT_TYPE_LABEL[r.shiftType]}</td>
                      <td className="px-3 py-2.5">
                        {r.shiftName ? `${r.shiftCode ?? '—'} — ${r.shiftName}` : '—'}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 tabular-nums">{r.effectiveFrom ?? '—'}</td>
                      <td className="px-3 py-2.5">
                        <StatusChip status={r.status} label={STATUS_LABEL[r.status]} hint={STATUS_HINT[r.status]} />
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <Link
                          href={editHref(r.employmentId)}
                          aria-label={t('viewEditAria', { name: r.name })}
                          className="text-xs font-medium text-primary hover:underline"
                        >
                          {t('viewEdit')}
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        <p className="px-4 pb-4 text-xs text-muted-foreground">{t('activeOnlyNote')}</p>
      </Card>
    </div>
  );
}
