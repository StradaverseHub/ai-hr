import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { requireAdmin } from '@/lib/authz';
import { listShiftsForTenant } from '@/core/roster';
import { listAttendanceRules } from '@/core/attendance-rule';
import { formatBreakDisplay } from '@/core/shift-break-display';
import { weekPatternFor, weekPatternGroupFor } from '@/core/week-pattern';
import { Card, ErrorBanner, PageHeader, SectionHeader, btnPrimary, pageWideCls } from '@/components/ui';
import { shiftChipClass } from '@/lib/shift-visual';
import { scheduleGroupSectionHref } from './schedule/sections';
import { archiveShiftAction, copyShiftAction, deleteShiftAction, unarchiveShiftAction } from './shift-actions';

const ISO_DAYS = [1, 2, 3, 4, 5, 6, 7] as const;
const DAY_KEY: Record<number, string> = { 1: 'dayMon', 2: 'dayTue', 3: 'dayWed', 4: 'dayThu', 5: 'dayFri', 6: 'daySat', 7: 'daySun' };
// f3321963 — shift template type → i18n label key. Falls back to Normal for legacy rows (type defaults to
// 'normal' at the DB layer, so this is belt-and-braces).
const SHIFT_TYPE_KEY: Record<string, string> = {
  normal: 'shiftTypeNormal',
  semi_flexi: 'shiftTypeSemiFlexi',
  full_flexi: 'shiftTypeFullFlexi',
};
/**
 * Shift Settings — R33 f21d6eee: a single, centralized SHARED shift library. The page lands STRAIGHT on the
 * list of shift templates: no overtime-rates card, no per-company attendance-policy cards, no company column
 * or per-company plumbing. Those attendance/OT settings moved to the dedicated /admin/attendance-policy
 * screen (they are still needed to calculate attendance and pay, but they are not shift patterns).
 *
 * Shifts are tenant-global (company_id NULL) — a template is created once and assignable to ANY employee via
 * their Employee Profile (Fixed shift) or Roster Management. Admin-only via requireAdmin(); shift writes are
 * DB-gated by RLS (migration 0197: shift WITH CHECK app.is_admin()).
 *
 * af7a8eb4 — the page is now the LIST and nothing else. The create/edit form moved onto its own routes
 * (new/page.tsx + [shiftId]/page.tsx behind shift-form.tsx), mirroring the rule library next door, and the
 * list uses the FULL window width (pageWideCls) instead of the 896px middle column it was capped at.
 */
export default async function ShiftSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; showArchived?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.attendancePolicy');
  const tr = await getTranslations('admin.attendanceRule');
  const trr = await getTranslations('roster');
  const { error, showArchived } = await searchParams;
  // cf21e554 — "let a switched-off shift be switched back on" needs somewhere to see it from. Off by
  // default: the list is a working library, not an archive.
  const includeArchived = showArchived === '1';

  // The shared library — every non-archived shift in the tenant (same set the roster + personnel pickers
  // use), plus the deactivated ones when the toggle is on.
  const shifts = await listShiftsForTenant(s, { includeArchived });
  // r429 (f6819e19) · D8 — the Schedule Group each shift resolves to, and the working days ACTUALLY IN
  // FORCE (weekPatternFor — group-first, shift-second), not the shift's own raw row. A shift's own week is
  // still what the group falls back to, but a reader of this LIST asking "which days does this shift work"
  // deserves the same answer the engine gives, not an answer only correct for the 0 shifts (measured
  // 2026-10-08) still living on their own fallback.
  const ruleOptions = await listAttendanceRules(s);

  return (
    <div className={pageWideCls}>
      <PageHeader
        title={t('pageTitle')}
        description={t('pageDescription')}
        actions={
          // af7a8eb4 — the reporter's own wording, and the string the rule library next door already shows.
          // `addShift` ("Add shift") stays as the FORM's submit label.
          <Link href="/admin/attendance/new" className={btnPrimary}>
            {tr('addNew')}
          </Link>
        }
      />
      <ErrorBanner message={error} />

      <Card id="shift-schedules" className="scroll-mt-6">
        <SectionHeader title={t('shiftsSectionTitle')} count={shifts.length} />
        <div className="space-y-4 px-4 py-3">
          <div className="flex justify-end">
            <Link
              href={includeArchived ? '/admin/attendance' : '/admin/attendance?showArchived=1'}
              className="text-xs font-medium text-primary hover:underline"
            >
              {includeArchived ? t('hideDeactivated') : t('showDeactivated')}
            </Link>
          </div>
          {shifts.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">{t('colCode')}</th>
                    <th className="px-4 py-2 font-medium">{t('colShiftName')}</th>
                    <th className="px-4 py-2 font-medium">{t('colShiftType')}</th>
                    <th className="px-4 py-2 font-medium">{t('colTimeIn')}</th>
                    <th className="px-4 py-2 font-medium">{t('colTimeOut')}</th>
                    <th className="px-4 py-2 font-medium">{t('colBreakTime')}</th>
                    <th className="px-4 py-2 font-medium">{t('colScheduleGroup')}</th>
                    <th className="px-4 py-2 font-medium">{t('colWorkingDays')}</th>
                    <th className="px-4 py-2"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {shifts.map((sh) => {
                    // 6340aecb — the flexible pair is passed so the mismatch badge does not fire on a
                    // shift whose break IS an allowance; a flexible shift shows its allowance instead.
                    const brk = formatBreakDisplay(sh.breakPeriods, sh.breakMinutes, {
                      enabled: sh.flexibleBreakEnabled,
                      minutes: sh.flexibleBreakMinutes,
                    });
                    // 6340aecb — the shift's own colour, previewed exactly as the Duty Roster paints it.
                    // Null (every shift until somebody picks one) renders the plain code cell as before.
                    const chip = shiftChipClass(sh.color);
                    // r429 (f6819e19) · D8 — the SAME resolver the Shift form's read-only preview and the
                    // engine use: the group this shift resolves to, and the week ACTUALLY IN FORCE.
                    const group = weekPatternGroupFor(ruleOptions, sh.ruleId);
                    const resolvedWeek = weekPatternFor(
                      group ? { pattern: group.weeklyPattern, halfPattern: group.halfPattern, offPattern: group.offPattern } : null,
                      { pattern: sh.weeklyPattern, halfPattern: sh.halfPattern, offPattern: sh.offPattern },
                    );
                    const deactivated = sh.archivedAt != null;
                    return (
                      <tr key={sh.id}>
                        <td className="px-4 py-2.5 font-medium">
                          {chip ? (
                            <span className={`rounded px-1.5 py-0.5 ${chip}`} title={t('shiftColorLabel')}>
                              {sh.code ?? '—'}
                            </span>
                          ) : (
                            (sh.code ?? '—')
                          )}
                        </td>
                        <td className="px-4 py-2.5">
                          {sh.name}
                          {sh.crossesMidnight && (
                            <span className="ml-1.5 text-xs text-muted-foreground" title={t('crossesMidnight')}>
                              ⊕
                            </span>
                          )}
                          {deactivated && (
                            <span className="ml-1.5 rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                              {t('deactivatedBadge')}
                            </span>
                          )}
                          {/* cf21e554 — the Description finally has a home of its own; MB28's was living in
                              the name box because there was nowhere else for it. */}
                          {sh.description && <div className="text-xs text-muted-foreground">{sh.description}</div>}
                        </td>
                        <td className="px-4 py-2.5">
                          <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                            {t(SHIFT_TYPE_KEY[sh.type] ?? 'shiftTypeNormal')}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 tabular-nums">{sh.startTime.slice(0, 5)}</td>
                        <td className="px-4 py-2.5 tabular-nums">{sh.endTime.slice(0, 5)}</td>
                        <td className="px-4 py-2.5">
                          {brk.rows.length > 0 ? (
                            // cf21e554 — Sequence No. + each row's own duration + the Paid tick, which is
                            // the reference Break tab's grid. Rendered from the structured rows so "Paid"
                            // can be localized rather than baked into a string in core/.
                            <span className="flex flex-col gap-0.5">
                              {brk.rows.map((r) => (
                                <span key={r.seq} className="tabular-nums">
                                  {r.seq}. {r.start}–{r.end}{' '}
                                  <span className="text-muted-foreground">({r.minutes}m)</span>
                                  {r.paid && (
                                    <span className="ml-1 rounded bg-emerald-100 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400">
                                      {t('breakPaidBadge')}
                                    </span>
                                  )}
                                </span>
                              ))}
                            </span>
                          ) : brk.text === '' ? (
                            <span className="text-muted-foreground">{t('noBreak')}</span>
                          ) : (
                            <span className="tabular-nums">{brk.text}</span>
                          )}
                          {/* 6340aecb — the allowance, said in the column that shows what comes off a day. */}
                          {brk.flexibleMinutes != null && (
                            <span className="ml-1.5 rounded bg-sky-100 px-1.5 py-0.5 text-[11px] font-medium text-sky-700 dark:bg-sky-500/15 dark:text-sky-400">
                              {t('breakFlexibleBadge', { minutes: brk.flexibleMinutes })}
                            </span>
                          )}
                          {brk.mismatchMinutes != null && (
                            <span
                              className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-500/15 dark:text-amber-400"
                              title={t('breakMismatchNote', { minutes: brk.mismatchMinutes })}
                            >
                              {t('breakMismatchBadge', { minutes: brk.mismatchMinutes })}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2.5">
                          {group ? (
                            <Link href={scheduleGroupSectionHref(group.id, 'workingDay')} className="text-primary hover:underline">
                              {group.name}
                            </Link>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="px-4 py-2.5">
                          {/* r429 (f6819e19) · D8 — THE WEEK ACTUALLY IN FORCE (resolvedWeek), not the
                              shift's own raw row: since 07ebd04d a Schedule Group may decide, and a list
                              that kept showing the shift's own week here would disagree with the engine on
                              every shift whose group decides. b8aa3466 — the row is four-way, so the column
                              still has to say which kind each day is; Rest stays unlisted. */}
                          {resolvedWeek.pattern?.length || resolvedWeek.halfPattern?.length || resolvedWeek.offPattern?.length ? (
                            <span className="flex flex-wrap gap-1">
                              {ISO_DAYS.filter((d) => resolvedWeek.pattern?.includes(d)).map((d) => (
                                <span
                                  key={`f${d}`}
                                  className="rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary"
                                >
                                  {t(DAY_KEY[d])}
                                </span>
                              ))}
                              {ISO_DAYS.filter((d) => resolvedWeek.halfPattern?.includes(d)).map((d) => (
                                <span
                                  key={`h${d}`}
                                  className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-500/15 dark:text-amber-400"
                                  title={trr('dayKindHalf')}
                                >
                                  {t(DAY_KEY[d])} · {trr('dayKindHalf')}
                                </span>
                              ))}
                              {ISO_DAYS.filter((d) => resolvedWeek.offPattern?.includes(d)).map((d) => (
                                <span
                                  key={`o${d}`}
                                  className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground"
                                  title={trr('dayKindOff')}
                                >
                                  {t(DAY_KEY[d])} · {trr('dayKindOff')}
                                </span>
                              ))}
                            </span>
                          ) : (
                            <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                              {t('notSet')}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center justify-end gap-3">
                            <Link
                              href={`/admin/attendance/${sh.id}`}
                              className="text-xs font-medium text-primary hover:underline"
                            >
                              {t('editShift')}
                            </Link>
                            {/* cf21e554 — Copy. NOT the retired cross-company duplicateShift (R33
                                f21d6eee): one new template in the SAME shared library, landing on its own
                                edit form. */}
                            <form action={copyShiftAction}>
                              <input type="hidden" name="shiftId" value={sh.id} />
                              <button className="text-xs font-medium text-primary hover:underline">{t('copyShift')}</button>
                            </form>
                            {deactivated ? (
                              <form action={unarchiveShiftAction}>
                                <input type="hidden" name="shiftId" value={sh.id} />
                                <button className="text-xs font-medium text-emerald-700 hover:underline dark:text-emerald-400">
                                  {t('unarchiveShift')}
                                </button>
                              </form>
                            ) : (
                              <form action={archiveShiftAction}>
                                <input type="hidden" name="shiftId" value={sh.id} />
                                <button className="text-xs font-medium text-rose-600 hover:underline dark:text-rose-400">
                                  {t('archiveShift')}
                                </button>
                              </form>
                            )}
                            {/* R17 3e8350db — hard Delete (distinct from Archive). The service blocks a
                                referenced shift and tells HR to archive instead. */}
                            <form action={deleteShiftAction}>
                              <input type="hidden" name="shiftId" value={sh.id} />
                              <button
                                className="text-xs font-medium text-rose-700 hover:underline dark:text-rose-300"
                                title={t('deleteShiftHint')}
                              >
                                {t('deleteShift')}
                              </button>
                            </form>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>

      <p className="px-1 text-xs text-muted-foreground">{t('rosterNote')}</p>
    </div>
  );
}
