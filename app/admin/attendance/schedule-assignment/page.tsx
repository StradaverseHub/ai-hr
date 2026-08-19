import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { listShiftArrangements, type ShiftArrangementListRow } from '@/core/shift-arrangement';
import { listShiftsForTenant } from '@/core/roster';
import {
  Card,
  EmployeeCode,
  PageHeader,
  SectionHeader,
  pageWideCls,
  tableWrapCls,
  tbodyCls,
  theadCls,
  thCls,
} from '@/components/ui';
import { FilterChips, FilterPanel, type FilterField } from '@/components/filter-panel';

/**
 * Schedule Assignment (feedback 0bade264, r209) — every employee's shift arrangement in ONE list.
 *
 * THE ITEM IN ONE LINE. The arrangement already existed and was already maintained per employee, under
 * Personnel Management › Employee › Attendance › Shift arrangement. What did not exist was a place to
 * see everybody's at once: the only way to answer "who is on which shift" was to open employees one at
 * a time.
 *
 * ⚠️ THE VIEW / EDIT LINK IS THE WHOLE DESIGN, AND IT IS A LINK ON PURPOSE. The request is explicit that
 * both surfaces must act on the same information. So this screen has NO editor of its own: the row's
 * action opens the personnel profile's Attendance tab, anchored at the very card that already writes the
 * arrangement (#section-default-shift → EmployeeShiftFields → assignEmployeeShiftDated). A second form
 * here would be a second write path over one table, which is exactly how the two would drift — and the
 * card carries validation this list does not (start-date floor, no back-insert, same-date replace) that
 * a copy would have to re-implement and eventually re-implement differently.
 *
 * WHAT "CURRENT" MEANS is decided in core/shift-arrangement.ts listShiftArrangements, off the live
 * partial unique index and the shared `pickArrangementOn` rule — not here, and not by sorting rows in
 * this file. See that function's header.
 *
 * requireAdmin(), like every other row of the Attendance menu it hangs under: the list names every
 * employee in the tenant. The menu is not what protects it (test/attendance-menu-relocation.test.ts).
 */
export default async function ScheduleAssignmentPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; shiftType?: string; shiftId?: string; status?: string }>;
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

  const [rows, shifts] = await Promise.all([
    listShiftArrangements(s, { q, shiftType, shiftId, status }),
    listShiftsForTenant(s),
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
  const STATUS_STYLE: Record<ShiftArrangementListRow['status'], string> = {
    current: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
    scheduled: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
    notRecorded: 'bg-muted text-muted-foreground',
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
  ];
  const filterValues = { q: q ?? '', shiftType: shiftType ?? '', shiftId: shiftId ?? '', status: status ?? '' };
  const activeCount = [q, shiftType, shiftId, status].filter(Boolean).length;
  const filterLabels = {
    filter: t('filters.filter'),
    apply: t('filters.apply'),
    clearAll: t('filters.clearAll'),
    activeCount: t('filters.activeCount', { count: activeCount }),
  };

  /**
   * THE ONE EDITOR. `tab=attendance` opens the Attendance tab of the personnel profile (its ClientTabs
   * shell reads ?tab= for deep links) and the hash scrolls to the Shift arrangement card itself, which
   * carries `id="section-default-shift"`. Nothing about the arrangement is edited on this screen.
   */
  const editHref = (employmentId: string) =>
    `/admin/personnel/${employmentId}?tab=attendance#section-default-shift`;

  return (
    <div className={pageWideCls}>
      <PageHeader
        title={t('pageTitle')}
        description={t('pageDescription')}
        actions={
          <FilterPanel
            action="/admin/attendance/schedule-assignment"
            fields={filterFields}
            values={filterValues}
            labels={filterLabels}
          />
        }
      />
      <FilterChips
        action="/admin/attendance/schedule-assignment"
        fields={filterFields}
        values={filterValues}
        labels={filterLabels}
      />

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
                    <th className={thCls}>{t('colShiftType')}</th>
                    <th className={thCls}>{t('colBackupShift')}</th>
                    <th className={thCls}>{t('colEffectiveFrom')}</th>
                    <th className={thCls}>{t('colStatus')}</th>
                    <th className={thCls}></th>
                  </tr>
                </thead>
                <tbody className={tbodyCls}>
                  {rows.map((r) => (
                    <tr key={r.employmentId}>
                      <td className="px-3 py-2.5">
                        {r.employeeCode ? <EmployeeCode code={r.employeeCode} /> : '—'}
                      </td>
                      <td className="px-3 py-2.5 font-medium">{r.name}</td>
                      <td className="px-3 py-2.5 text-muted-foreground">{r.company}</td>
                      <td className="px-3 py-2.5">{SHIFT_TYPE_LABEL[r.shiftType]}</td>
                      <td className="px-3 py-2.5">
                        {r.shiftName ? `${r.shiftCode ?? '—'} — ${r.shiftName}` : '—'}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 tabular-nums">{r.effectiveFrom ?? '—'}</td>
                      <td className="px-3 py-2.5">
                        <span
                          title={STATUS_HINT[r.status]}
                          className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${STATUS_STYLE[r.status]}`}
                        >
                          {STATUS_LABEL[r.status]}
                        </span>
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
