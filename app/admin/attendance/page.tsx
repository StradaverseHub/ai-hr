import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { requireAdmin } from '@/lib/authz';
import { listShiftOtWindows, listShiftsForTenant } from '@/core/roster';
import { listAttendanceRules } from '@/core/attendance-rule';
import { formatBreakDisplay } from '@/core/shift-break-display';
import { Card, ErrorBanner, Field, PageHeader, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { ShiftTimeFields } from '@/components/shift-time-fields';
import { ShiftOtWindowFields } from '@/components/shift-ot-window-fields';
import {
  archiveShiftAction,
  copyShiftAction,
  createShiftAction,
  deleteShiftAction,
  unarchiveShiftAction,
  updateShiftAction,
} from './shift-actions';

const ISO_DAYS = [1, 2, 3, 4, 5, 6, 7] as const;
const DAY_KEY: Record<number, string> = { 1: 'dayMon', 2: 'dayTue', 3: 'dayWed', 4: 'dayThu', 5: 'dayFri', 6: 'daySat', 7: 'daySun' };
// f3321963 — shift template type → i18n label key. Falls back to Normal for legacy rows (type defaults to
// 'normal' at the DB layer, so this is belt-and-braces).
const SHIFT_TYPE_KEY: Record<string, string> = {
  normal: 'shiftTypeNormal',
  semi_flexi: 'shiftTypeSemiFlexi',
  full_flexi: 'shiftTypeFullFlexi',
};
// cf21e554 — the shift Day Type box (RECORDED ONLY in stage 1). Static literal keys so the i18n coverage
// test's check C can see every one of them.
const DAY_TYPE_KEY: Record<string, string> = {
  workday: 'shiftDayTypeWorkday',
  rest_day: 'shiftDayTypeRestDay',
  holiday: 'shiftDayTypeHoliday',
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
 * cf21e554 — the form now carries the reference screen's three captured tabs as three labelled sections:
 * General (the eight new boxes plus Description), Break Time Schedule (numbered rows with their own
 * duration and a Paid tick) and Overtime Schedule (clock-time OT windows). The reference's fourth tab,
 * "General (More…)", was never opened in the pictures we were given — it is deliberately absent rather than
 * guessed at.
 */
export default async function ShiftSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; editShift?: string; showArchived?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.attendancePolicy');
  const { error, editShift, showArchived } = await searchParams;
  // cf21e554 — "let a switched-off shift be switched back on" needs somewhere to see it from. Off by
  // default: the list is a working library, not an archive.
  const includeArchived = showArchived === '1';

  // The shared library — every non-archived shift in the tenant (same set the roster + personnel pickers
  // use), plus the deactivated ones when the toggle is on.
  const shifts = await listShiftsForTenant(s, { includeArchived });
  const editing = editShift ? shifts.find((sh) => sh.id === editShift) : undefined;
  // The edited shift's overtime grid. Only fetched for the row being edited — the list does not show them.
  const editingOtWindows = editing ? await listShiftOtWindows(s, editing.id) : [];

  // 88e94371 — the attendance-rule dropdown options for the shift form. 6da67ab7: rules are tenant-wide, so
  // every shift offers the whole library regardless of which company its employees sit in. Inactive rules are
  // hidden unless the edited shift already points at one.
  const allRules = await listAttendanceRules(s);
  const ruleOptions = allRules.filter((r) => r.status === 'active' || r.id === editing?.ruleId);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader
        title={t('pageTitle')}
        description={t('pageDescription')}
        actions={
          <Link href="#shift-form" className={btnPrimary}>
            {t('addShift')}
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
                    <th className="px-4 py-2 font-medium">{t('colWorkingDays')}</th>
                    <th className="px-4 py-2"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {shifts.map((sh) => {
                    const brk = formatBreakDisplay(sh.breakPeriods, sh.breakMinutes);
                    const deactivated = sh.archivedAt != null;
                    return (
                      <tr key={sh.id} className={editing?.id === sh.id ? 'bg-primary/5' : undefined}>
                        <td className="px-4 py-2.5 font-medium">{sh.code ?? '—'}</td>
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
                          {sh.weeklyPattern && sh.weeklyPattern.length > 0 ? (
                            <span className="flex flex-wrap gap-1">
                              {ISO_DAYS.filter((d) => sh.weeklyPattern!.includes(d)).map((d) => (
                                <span
                                  key={d}
                                  className="rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary"
                                >
                                  {t(DAY_KEY[d])}
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
                              href={`/admin/attendance?editShift=${sh.id}#shift-form`}
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

          {/* Create OR edit form. `key` forces React to reset the ShiftTimeFields island's internal state
              when switching between add and a specific shift's edit. R33 f21d6eee — no company picker: a
              shift is a tenant-global template. */}
          <form
            id="shift-form"
            key={editing?.id ?? 'new'}
            action={editing ? updateShiftAction : createShiftAction}
            className="flex scroll-mt-6 flex-wrap items-end gap-2 border-t border-border pt-3"
          >
            {editing && <input type="hidden" name="shiftId" value={editing.id} />}
            <input
              name="name"
              required
              placeholder={t('shiftName')}
              defaultValue={editing?.name ?? ''}
              className={`${inputCls} w-40`}
              aria-label={t('shiftName')}
            />
            <input
              name="code"
              required
              placeholder={t('shiftCode')}
              defaultValue={editing?.code ?? ''}
              className={`${inputCls} w-24`}
              aria-label={t('shiftCode')}
            />
            {/* f3321963 — Shift Type selector. Normal (fixed schedule) + Semi-Flexi (flexible window) are
                selectable; Full-Flexi is reserved for a FUTURE enhancement (reporter-sanctioned), so its
                option is disabled and a placeholder note explains it. */}
            <Field label={t('shiftTypeLabel')}>
              <select
                name="shiftTemplateType"
                defaultValue={editing?.type ?? 'normal'}
                className={`${inputCls} w-40`}
                aria-label={t('shiftTypeLabel')}
              >
                <option value="normal">{t('shiftTypeNormal')}</option>
                <option value="semi_flexi">{t('shiftTypeSemiFlexi')}</option>
                <option value="full_flexi" disabled>
                  {t('shiftTypeFullFlexi')}
                </option>
              </select>
            </Field>
            {/* cf21e554 — the reference "Description" box. The Shift name can go back to being a short name.
                Full width: MB28's description is 48 characters and was being typed into the name field. */}
            <Field label={t('shiftDescription')} className="w-full">
              <input
                name="description"
                defaultValue={editing?.description ?? ''}
                className={inputCls}
                aria-label={t('shiftDescription')}
              />
            </Field>
            <ShiftTimeFields
              defaultStart={editing?.startTime.slice(0, 5) ?? '09:00'}
              defaultEnd={editing?.endTime.slice(0, 5) ?? '18:00'}
              defaultBreaks={(editing?.breakPeriods ?? []).map((bp) => ({
                start: bp.start.slice(0, 5),
                end: bp.end.slice(0, 5),
                paid: bp.paid === true,
              }))}
              defaultBreakMinutes={editing ? String(editing.breakMinutes) : '60'}
              defaultOverride={editing?.normalMinutesOverride != null ? String(editing.normalMinutesOverride) : ''}
              defaultRounding={editing?.normalHoursRoundingMinutes != null ? String(editing.normalHoursRoundingMinutes) : ''}
            />
            {/* 7c834696 rev 2 point 4 — the per-shift Late Grace / Early Out Grace INPUTS are gone. Grace is
                set in one place now: the rule picked below. The shift.late_grace_minutes /
                early_leave_grace_minutes COLUMNS and their precedence in core/attendance.ts (explicit shift
                grace → rule grace → policy-derived) deliberately stay — a future per-shift override needs
                somewhere to land, and the fallback chain is what keeps a row carrying one safe. Because this
                form is a full-row overwrite, shift-actions.ts now OMITS the two keys rather than posting
                blanks, so saving a shift preserves any stored override instead of nulling it. */}
            {/* 88e94371 — the shift's attendance-calculation rule ("Lateness, Early Out & Overtime Settings").
                Replaces the old per-shift OT-Rules field: OT shaping + lateness/early-out grace now live in the
                reusable rule library. Blank ⇒ the tenant's Standard rule is applied automatically. */}
            <Field label={t('ruleFieldLabel')}>
              <select
                name="attendanceRuleId"
                defaultValue={editing?.ruleId ?? ''}
                className={`${inputCls} w-56`}
                aria-label={t('ruleFieldLabel')}
              >
                <option value="">{t('ruleFieldStandardDefault')}</option>
                {ruleOptions.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.isDefault ? `${r.name} ${t('ruleDefaultSuffix')}` : r.name}
                    {r.status === 'inactive' ? ` ${t('ruleInactiveSuffix')}` : ''}
                  </option>
                ))}
              </select>
            </Field>

            {/* ── cf21e554 · the reference GENERAL tab's remaining boxes ─────────────────────────────── */}
            <fieldset className="w-full">
              <legend className="mb-1.5 text-sm font-medium text-foreground">{t('generalSectionLegend')}</legend>
              <div className="flex flex-wrap items-end gap-2">
                <Field label={t('shiftEarlyIn')}>
                  <input
                    name="earlyIn"
                    type="time"
                    defaultValue={editing?.earlyIn?.slice(0, 5) ?? ''}
                    className={inputCls}
                    aria-label={t('shiftEarlyIn')}
                  />
                </Field>
                <Field label={t('shiftLateOut')}>
                  <input
                    name="lateOut"
                    type="time"
                    defaultValue={editing?.lateOut?.slice(0, 5) ?? ''}
                    className={inputCls}
                    aria-label={t('shiftLateOut')}
                  />
                </Field>
                <label className="inline-flex h-9 cursor-pointer items-center gap-1.5 text-sm text-muted-foreground">
                  <input
                    type="checkbox"
                    name="lateOutNextDay"
                    defaultChecked={editing?.lateOutNextDay === true}
                    className="h-3.5 w-3.5 accent-primary"
                  />
                  {t('shiftLateOutNextDay')}
                </label>
                <Field label={t('shiftNormalHoursRounding')}>
                  <input
                    name="normalHoursRoundingMinutes"
                    type="number"
                    min={0}
                    max={1440}
                    defaultValue={editing?.normalHoursRoundingMinutes ?? ''}
                    className={`${inputCls} w-28`}
                    aria-label={t('shiftNormalHoursRounding')}
                  />
                </Field>
                <Field label={t('shiftHalfDayFirstOut')}>
                  <input
                    name="halfDayFirstOut"
                    type="time"
                    defaultValue={editing?.halfDayFirstOut?.slice(0, 5) ?? ''}
                    className={inputCls}
                    aria-label={t('shiftHalfDayFirstOut')}
                  />
                </Field>
                <Field label={t('shiftHalfDaySecondIn')}>
                  <input
                    name="halfDaySecondIn"
                    type="time"
                    defaultValue={editing?.halfDaySecondIn?.slice(0, 5) ?? ''}
                    className={inputCls}
                    aria-label={t('shiftHalfDaySecondIn')}
                  />
                </Field>
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">{t('shiftNormalHoursRoundingHint')}</p>
              <p className="text-xs text-muted-foreground">{t('shiftHalfDayHint')}</p>
            </fieldset>

            {/* The four boxes that are RECORDED ONLY in this stage. Grouped and labelled as such, because
                the plan promises "the screen will say so on the box itself, so nobody fills one in and
                expects a different pay result". */}
            <fieldset className="w-full">
              <legend className="mb-1.5 text-sm font-medium text-foreground">
                {t('recordedOnlyLegend')}{' '}
                <span className="font-normal text-muted-foreground">({t('recordedOnlyNote')})</span>
              </legend>
              <div className="flex flex-wrap items-end gap-2">
                <Field label={t('shiftDayType')}>
                  <select
                    name="shiftDayType"
                    defaultValue={editing?.dayType ?? ''}
                    className={`${inputCls} w-36`}
                    aria-label={t('shiftDayType')}
                  >
                    <option value="">{t('notSet')}</option>
                    <option value="workday">{t(DAY_TYPE_KEY.workday)}</option>
                    <option value="rest_day">{t(DAY_TYPE_KEY.rest_day)}</option>
                    <option value="holiday">{t(DAY_TYPE_KEY.holiday)}</option>
                  </select>
                </Field>
                <Field label={t('shiftCategory')}>
                  <input
                    name="category"
                    defaultValue={editing?.category ?? ''}
                    className={`${inputCls} w-36`}
                    aria-label={t('shiftCategory')}
                  />
                </Field>
                <Field label={t('shiftFullDayLeaveMinutes')}>
                  <input
                    name="fullDayLeaveMinutes"
                    type="number"
                    min={0}
                    max={1440}
                    defaultValue={editing?.fullDayLeaveMinutes ?? ''}
                    className={`${inputCls} w-28`}
                    aria-label={t('shiftFullDayLeaveMinutes')}
                  />
                </Field>
                <Field label={t('shiftFullDayOtMinutes')}>
                  <input
                    name="fullDayOtMinutes"
                    type="number"
                    min={0}
                    max={1440}
                    defaultValue={editing?.fullDayOtMinutes ?? ''}
                    className={`${inputCls} w-28`}
                    aria-label={t('shiftFullDayOtMinutes')}
                  />
                </Field>
              </div>
            </fieldset>

            {/* ── cf21e554 stage 2 · the reference OVERTIME SCHEDULE tab ─────────────────────────────── */}
            <fieldset className="w-full">
              <legend className="mb-1.5 text-sm font-medium text-foreground">{t('otScheduleLegend')}</legend>
              <ShiftOtWindowFields
                defaultRows={editingOtWindows.map((w) => ({
                  label: w.label ?? '',
                  startTime: w.startTime.slice(0, 5),
                  endTime: w.endTime.slice(0, 5),
                  endNextDay: w.endNextDay,
                  minMinutes: w.minMinutes == null ? '' : String(w.minMinutes),
                  maxMinutes: w.maxMinutes == null ? '' : String(w.maxMinutes),
                  adjustAfterMinutes: w.adjustAfterMinutes == null ? '' : String(w.adjustAfterMinutes),
                  adjustDeltaMinutes: w.adjustDeltaMinutes == null ? '' : String(w.adjustDeltaMinutes),
                }))}
              />
            </fieldset>

            {/* 7c834696 rev 2 point 4 — these two are PAY, not a calculation setting, and sitting unlabelled
                next to the grace boxes is what made them read as one. core/payroll.ts prefillShiftDifferential
                reads shift.differential to prefill a payroll component (percent / flat-hourly / flat-per-shift),
                so removing them would leave live premiums unmaintainable. Grouped under their own heading
                instead, which is the fix the reporter actually needs. */}
            <fieldset className="w-full">
              <legend className="mb-1.5 text-sm font-medium text-foreground">
                {t('shiftPremiumLegend')}{' '}
                <span className="font-normal text-muted-foreground">({t('shiftPremiumHint')})</span>
              </legend>
              <div className="flex flex-wrap items-end gap-2">
                <select
                  name="differentialKind"
                  defaultValue={editing?.differential?.kind ?? ''}
                  className={inputCls}
                  aria-label={t('diffLabel')}
                >
                  <option value="">{t('diffNone')}</option>
                  <option value="percent">{t('diffPercent')}</option>
                  <option value="flat_hourly">{t('diffFlatHourly')}</option>
                  <option value="flat_per_shift">{t('diffPerShift')}</option>
                </select>
                <input
                  name="differentialValue"
                  type="number"
                  min={0}
                  step="0.01"
                  placeholder={t('diffValue')}
                  defaultValue={editing?.differential?.value ?? ''}
                  className={`${inputCls} w-24`}
                  aria-label={t('diffValue')}
                />
              </div>
            </fieldset>
            {/* Mon–Sun Working/Rest toggle — same has-[:checked] row as the working-days editor. Checked =
                working day; unchecked = rest. New shift defaults Mon–Fri. */}
            <fieldset className="w-full">
              <legend className="mb-1.5 text-sm font-medium text-foreground">
                {t('shiftWorkingDays')}{' '}
                <span className="font-normal text-muted-foreground">
                  ({t('shiftWorking')} / {t('shiftRest')})
                </span>
              </legend>
              <div className="flex flex-wrap gap-1.5">
                {ISO_DAYS.map((d) => {
                  const checked = editing ? (editing.weeklyPattern?.includes(d) ?? false) : d <= 5;
                  return (
                    <label
                      key={d}
                      className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm transition-colors has-[:checked]:border-primary has-[:checked]:bg-primary/10 has-[:checked]:text-primary"
                    >
                      <input
                        type="checkbox"
                        name="weeklyPattern"
                        value={d}
                        defaultChecked={checked}
                        className="h-3.5 w-3.5 accent-primary"
                      />
                      {t(DAY_KEY[d])}
                    </label>
                  );
                })}
              </div>
            </fieldset>
            <div className="flex w-full items-center gap-3">
              <button className={btnPrimary}>{editing ? t('saveShift') : t('addShift')}</button>
              {editing && (
                <Link
                  href="/admin/attendance#shift-form"
                  className="text-sm text-muted-foreground hover:text-foreground hover:underline"
                >
                  {t('cancelEdit')}
                </Link>
              )}
            </div>
          </form>
          <p className="text-xs text-muted-foreground">{t('shiftHint')}</p>
          {/* cf21e554 — `multiBreakStorageHint` ("the hours deducted still use their combined total") is no
              longer rendered here. It was already out of date after b7b886e2 taught the engine to deduct the
              window a clocking actually spanned, and the Paid tick makes it plainly wrong: the total is now
              the sum of the UNPAID windows. The key is left in the message files rather than deleted (other
              locales and any computed lookup keep resolving); this screen states the live rule instead. */}
          <p className="text-xs text-muted-foreground">{t('breakPaidHint')}</p>
          {/* f3321963 — Semi-Flexi rule + Full-Flexi future-release placeholder. */}
          <p className="text-xs text-muted-foreground">{t('shiftTypeSemiFlexiNote')}</p>
          <p className="text-xs text-muted-foreground">{t('shiftTypeFullFlexiNote')}</p>
          {/* cf21e554 — the reference tab we were never shown. Named, not guessed at. */}
          <p className="text-xs text-muted-foreground">{t('generalMoreTabNote')}</p>
        </div>
      </Card>

      <p className="px-1 text-xs text-muted-foreground">{t('rosterNote')}</p>
    </div>
  );
}
