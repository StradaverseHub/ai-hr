import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { requireAdmin } from '@/lib/authz';
import { listShiftsForTenant } from '@/core/roster';
import { listAttendanceRules } from '@/core/attendance-rule';
import { formatBreakDisplay } from '@/core/shift-break-display';
import { Card, ErrorBanner, Field, PageHeader, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { ShiftTimeFields } from '@/components/shift-time-fields';
import { archiveShiftAction, createShiftAction, deleteShiftAction, updateShiftAction } from './shift-actions';

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
 */
export default async function ShiftSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; editShift?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.attendancePolicy');
  const { error, editShift } = await searchParams;

  // The shared library — every non-archived shift in the tenant (same set the roster + personnel pickers use).
  const shifts = await listShiftsForTenant(s);
  const editing = editShift ? shifts.find((sh) => sh.id === editShift) : undefined;

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
                          {(sh.lateGraceMinutes != null || sh.earlyLeaveGraceMinutes != null) && (
                            <span className="mt-0.5 block text-[11px] text-muted-foreground">
                              {sh.lateGraceMinutes != null && t('lateGraceBadge', { minutes: sh.lateGraceMinutes })}
                              {sh.lateGraceMinutes != null && sh.earlyLeaveGraceMinutes != null && ' · '}
                              {sh.earlyLeaveGraceMinutes != null && t('earlyLeaveGraceBadge', { minutes: sh.earlyLeaveGraceMinutes })}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2.5">
                          <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                            {t(SHIFT_TYPE_KEY[sh.type] ?? 'shiftTypeNormal')}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 tabular-nums">{sh.startTime.slice(0, 5)}</td>
                        <td className="px-4 py-2.5 tabular-nums">{sh.endTime.slice(0, 5)}</td>
                        <td className="px-4 py-2.5">
                          {brk.text === '' ? (
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
                            <form action={archiveShiftAction}>
                              <input type="hidden" name="shiftId" value={sh.id} />
                              <button className="text-xs font-medium text-rose-600 hover:underline dark:text-rose-400">
                                {t('archiveShift')}
                              </button>
                            </form>
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
            <ShiftTimeFields
              defaultStart={editing?.startTime.slice(0, 5) ?? '09:00'}
              defaultEnd={editing?.endTime.slice(0, 5) ?? '18:00'}
              defaultBreaks={(editing?.breakPeriods ?? []).map((bp) => ({ start: bp.start.slice(0, 5), end: bp.end.slice(0, 5) }))}
              defaultBreakMinutes={editing ? String(editing.breakMinutes) : '60'}
              defaultOverride={editing?.normalMinutesOverride != null ? String(editing.normalMinutesOverride) : ''}
            />
            {/* R17 3e8350db — per-shift grace windows (minutes). Blank ⇒ inherit the company policy. */}
            <Field label={t('lateGraceLabel')}>
              <input
                name="lateGraceMinutes"
                type="number"
                min={0}
                placeholder={t('graceInherit')}
                defaultValue={editing?.lateGraceMinutes != null ? String(editing.lateGraceMinutes) : ''}
                className={`${inputCls} w-28`}
                aria-label={t('lateGraceLabel')}
              />
            </Field>
            <Field label={t('earlyLeaveGraceLabel')}>
              <input
                name="earlyLeaveGraceMinutes"
                type="number"
                min={0}
                placeholder={t('graceInherit')}
                defaultValue={editing?.earlyLeaveGraceMinutes != null ? String(editing.earlyLeaveGraceMinutes) : ''}
                className={`${inputCls} w-28`}
                aria-label={t('earlyLeaveGraceLabel')}
              />
            </Field>
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
          <p className="text-xs text-muted-foreground">{t('multiBreakStorageHint')}</p>
          {/* f3321963 — Semi-Flexi rule + Full-Flexi future-release placeholder. */}
          <p className="text-xs text-muted-foreground">{t('shiftTypeSemiFlexiNote')}</p>
          <p className="text-xs text-muted-foreground">{t('shiftTypeFullFlexiNote')}</p>
        </div>
      </Card>

      <p className="px-1 text-xs text-muted-foreground">{t('rosterNote')}</p>
    </div>
  );
}
