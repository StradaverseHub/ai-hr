import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import {
  listShiftArrangements,
  shiftArrangementHistory,
  type ShiftArrangementListRow,
} from '@/core/shift-arrangement';
import { listShiftsForTenant } from '@/core/roster';
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
import { EmployeeShiftFields } from '@/components/employee-shift-fields';
import { FilterChips, FilterPanel, type FilterField } from '@/components/filter-panel';
import { removeScheduleArrangementAction, saveScheduleAssignmentAction } from './actions';

/**
 * Schedule Assignment (feedback 0bade264 r209; edited in place by a485afa1 r263) — every employee's shift
 * arrangement in ONE list, and now editable from that list.
 *
 * THE ITEM IN ONE LINE. The arrangement already existed and was already maintained per employee, under
 * Personnel Management › Employee › Attendance › Shift arrangement. What did not exist was a place to
 * see everybody's at once: the only way to answer "who is on which shift" was to open employees one at
 * a time.
 *
 * ⚠️ a485afa1 REVERSED THE ROW ACTION, AND THE REASONING BELOW IT — read this before restoring the link.
 * r209 sent View / Edit to `/admin/personnel/<id>?tab=attendance#section-default-shift` on the argument
 * that a second form here would be a second write path over one table. The reporter came back: assigning a
 * shift to twenty people was twenty round trips out of the Attendance module and back. The argument was
 * sound about WRITERS and wrong about FORMS — so what this screen gained is the personnel card's own
 * control and the personnel card's own writer, not copies of them:
 *   · <EmployeeShiftFields> is the SAME component the card renders (components/employee-shift-fields.tsx).
 *     Its three controls are declared once, so a field added there appears at both doors or at neither.
 *   · ./actions.ts calls core/shift-arrangement.ts assignEmployeeShiftDated with the identical argument
 *     shape the personnel action uses. There is still exactly ONE writer, and the validation r209 worried
 *     about copying (start-date floor, no back-insert, same-date replace) is enforced inside it for both.
 *   · The history under the panel is `shiftArrangementHistory` — the same read the card renders.
 * The personnel card KEEPS its copy: an HR administrator working through somebody's whole record should
 * still find the schedule where it has always been. What went away is being SENT there from Attendance.
 * test/schedule-assignment.test.ts pins both halves — one writer, and both doors still standing.
 *
 * WHAT "CURRENT" MEANS is decided in core/shift-arrangement.ts listShiftArrangements, off the live
 * partial unique index and the shared `pickArrangementOn` rule — not here, and not by sorting rows in
 * this file. See that function's header.
 *
 * THE PANEL IS URL-DRIVEN (`?assign=<employmentId>`), not client state: the filters are already in the
 * query string, so the open panel travels with them through every redirect the two actions perform, and
 * an administrator can bookmark or reload the row they are working on. It also keeps this page a plain
 * server component — the only client island is the shared field control.
 *
 * requireAdmin(), like every other row of the Attendance menu it hangs under: the list names every
 * employee in the tenant. The menu is not what protects it (test/attendance-menu-relocation.test.ts).
 */
const PAGE = '/admin/attendance/schedule-assignment';

export default async function ScheduleAssignmentPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    shiftType?: string;
    shiftId?: string;
    status?: string;
    assign?: string;
    error?: string;
    saved?: string;
    removed?: string;
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
  const assign = sp.assign?.trim() || undefined;

  // ONE "today" for the whole render: the list's status buckets, the panel's row and the effective-date
  // default all answer to the same calendar day, in the tenant's timezone (never the UTC date — between
  // 00:00 and 08:00 MYT that names yesterday).
  const today = todayInKualaLumpur();

  const [rows, libraryShifts] = await Promise.all([
    listShiftArrangements(s, { q, shiftType, shiftId, status, today }),
    // WITH archived rows, then filtered per use: a currently-assigned-but-later-archived shift must still
    // render as the selected option in the panel (instead of silently showing the placeholder), exactly as
    // the personnel card loads it. New assignments of archived shifts are refused by the service.
    listShiftsForTenant(s, { includeArchived: true }),
  ]);
  const shifts = libraryShifts.filter((sh) => !sh.archivedAt);

  /**
   * The panel's row is read with the SAME function the list uses, narrowed to one employment — not picked
   * out of `rows`. Changing somebody's backup shift while the list is filtered by backup shift moves them
   * out of the filtered set, and the panel they are still standing in must not blank out mid-edit.
   */
  const [panelRow] = assign ? await listShiftArrangements(s, { employmentId: assign, today }) : [];
  const history = panelRow ? await shiftArrangementHistory(s, panelRow.employmentId) : [];
  const panelShifts = panelRow
    ? libraryShifts.filter((sh) => !sh.archivedAt || sh.id === panelRow.shiftId)
    : [];

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
   * Every link and every form return carries the FILTERS the administrator is working under. Opening a
   * panel, closing it, saving and removing must all come back to the same list — a screen that resets its
   * filters on save is the twenty-round-trips complaint in a different costume.
   */
  const hrefWith = (extra: Record<string, string | undefined>) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries({ q, shiftType, shiftId, status, ...extra })) {
      if (v) params.set(k, v);
    }
    const qs = params.toString();
    return `${PAGE}${qs ? `?${qs}` : ''}`;
  };
  /** The row action. No longer a trip into Personnel Management — it opens the panel on this screen. */
  const editHref = (employmentId: string) => `${hrefWith({ assign: employmentId })}#assign-panel`;
  const closeHref = hrefWith({ assign: undefined });
  /** Where the two server actions come back to — the exact list, with this panel still open. */
  const returnTo = hrefWith({ assign });

  return (
    <div className={pageWideCls}>
      <PageHeader
        title={t('pageTitle')}
        description={t('pageDescription')}
        actions={
          <FilterPanel
            action={PAGE}
            fields={filterFields}
            values={filterValues}
            labels={filterLabels}
          />
        }
      />
      <FilterChips
        action={PAGE}
        fields={filterFields}
        values={filterValues}
        labels={filterLabels}
      />

      <ErrorBanner message={sp.error} />
      {!sp.error && (sp.saved || sp.removed) ? (
        <p className="rounded-lg border border-emerald-500/30 bg-emerald-50 px-4 py-3 text-sm text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400">
          {sp.removed ? t('removedNote') : t('savedNote')}
        </p>
      ) : null}

      {assign ? (
        <Card id="assign-panel">
          {panelRow ? (
            <>
              <SectionHeader
                title={t('panelTitle')}
                subtitle={[panelRow.name, panelRow.employeeCode ?? '—', panelRow.company].join(' · ')}
              />
              {/* THE SAME THREE CONTROLS THE PERSONNEL CARD RENDERS, from the same file, posting to the
                  same writer. `defaultEffectiveFrom` is today in the tenant's calendar, resolved on the
                  server exactly as the card resolves it. */}
              <form action={saveScheduleAssignmentAction} className="space-y-3 p-4">
                <input type="hidden" name="employmentId" value={panelRow.employmentId} />
                <input type="hidden" name="returnTo" value={returnTo} />
                <EmployeeShiftFields
                  defaultType={panelRow.shiftType}
                  defaultShiftId={panelRow.shiftId}
                  defaultEffectiveFrom={today}
                  shifts={panelShifts.map((sh) => ({
                    id: sh.id,
                    label: `${sh.code ?? '—'} — ${sh.name} (${sh.startTime.slice(0, 5)}–${sh.endTime.slice(0, 5)})`,
                  }))}
                />
                <div className="flex items-center gap-3">
                  <button className={btnPrimary}>{t('panelSave')}</button>
                  <Link
                    href={closeHref}
                    aria-label={t('panelCloseAria')}
                    className="text-xs font-medium text-muted-foreground hover:underline"
                  >
                    {t('panelClose')}
                  </Link>
                </div>
              </form>
              <p className="px-4 pb-3 text-xs text-muted-foreground">{t('panelHint')}</p>

              {/* PREVIOUS ARRANGEMENTS, and the place a wrong one is taken back off. LIVE periods only — a
                  second save for the same date REPLACES its entry rather than adding a line, which is why
                  a replaced entry is not here to remove. The Remove forms are SIBLINGS of the save form,
                  never nested inside it: a form inside a form is invalid HTML and the inner one is
                  dropped by the parser. */}
              <section className="border-t border-border">
                <div className="px-4 pt-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t('historyTitle')}
                </div>
                {history.length === 0 ? (
                  <p className="px-4 pb-4 pt-2 text-sm text-muted-foreground">{t('historyEmpty')}</p>
                ) : (
                  <div className="px-4 pb-4 pt-2">
                    <div className={tableWrapCls}>
                      <table className="w-full text-sm">
                        <thead className={theadCls}>
                          <tr>
                            <th className={thCls}>{t('historyColEffective')}</th>
                            <th className={thCls}>{t('historyColPrevious')}</th>
                            <th className={thCls}>{t('historyColNew')}</th>
                            <th className={thCls}>{t('historyColChangedBy')}</th>
                            <th className={thCls}>{t('historyColChangedOn')}</th>
                            <th className={thCls}></th>
                          </tr>
                        </thead>
                        <tbody className={tbodyCls}>
                          {history.map((h) => (
                            <tr key={h.id}>
                              <td className="whitespace-nowrap px-3 py-2.5 tabular-nums">{h.effectiveFrom}</td>
                              <td className="px-3 py-2.5 text-muted-foreground">
                                {h.previousShiftName
                                  ? `${h.previousShiftCode ?? '—'} — ${h.previousShiftName}`
                                  : '—'}
                              </td>
                              <td className="px-3 py-2.5">{`${h.shiftCode ?? '—'} — ${h.shiftName}`}</td>
                              <td className="px-3 py-2.5 text-muted-foreground">{h.changedByName ?? '—'}</td>
                              <td className="whitespace-nowrap px-3 py-2.5 text-muted-foreground">
                                {h.recordedOnRelease ? t('historyRecordedOnRelease') : h.changedAt.slice(0, 10)}
                              </td>
                              <td className="px-3 py-2.5 text-right">
                                <form action={removeScheduleArrangementAction}>
                                  <input type="hidden" name="employmentId" value={panelRow.employmentId} />
                                  <input type="hidden" name="arrangementId" value={h.id} />
                                  <input type="hidden" name="returnTo" value={returnTo} />
                                  <button
                                    aria-label={t('removeAria', { date: h.effectiveFrom })}
                                    className="text-xs font-medium text-destructive hover:underline"
                                  >
                                    {t('remove')}
                                  </button>
                                </form>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </section>
            </>
          ) : (
            /* `?assign=` naming somebody the tenant cannot see here — a terminated employment, or a stale
               bookmark. Say so rather than rendering an empty panel. */
            <p className="px-4 py-6 text-sm text-muted-foreground">{t('panelMissing')}</p>
          )}
        </Card>
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
                    <th className={thCls}>{t('colShiftType')}</th>
                    <th className={thCls}>{t('colBackupShift')}</th>
                    <th className={thCls}>{t('colEffectiveFrom')}</th>
                    <th className={thCls}>{t('colStatus')}</th>
                    <th className={thCls}></th>
                  </tr>
                </thead>
                <tbody className={tbodyCls}>
                  {rows.map((r) => (
                    <tr key={r.employmentId} className={r.employmentId === assign ? 'bg-muted/50' : undefined}>
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
