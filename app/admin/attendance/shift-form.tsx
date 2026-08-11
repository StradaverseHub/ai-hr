import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import type { listShiftOtWindows, listShiftsForTenant } from '@/core/roster';
import type { listAttendanceRules } from '@/core/attendance-rule';
import { Card, ErrorBanner, Field, PageHeader, btnPrimary, inputCls } from '@/components/ui';
import { ShiftTimeFields } from '@/components/shift-time-fields';
import { ShiftOtWindowFields } from '@/components/shift-ot-window-fields';
import { createShiftAction, updateShiftAction } from './shift-actions';

const LIST = '/admin/attendance';

const ISO_DAYS = [1, 2, 3, 4, 5, 6, 7] as const;
const DAY_KEY: Record<number, string> = { 1: 'dayMon', 2: 'dayTue', 3: 'dayWed', 4: 'dayThu', 5: 'dayFri', 6: 'daySat', 7: 'daySun' };
// cf21e554 — the shift Day Type box (RECORDED ONLY in stage 1). Static literal keys so the i18n coverage
// test's check C can see every one of them.
const DAY_TYPE_KEY: Record<string, string> = {
  workday: 'shiftDayTypeWorkday',
  rest_day: 'shiftDayTypeRestDay',
  holiday: 'shiftDayTypeHoliday',
};

export type ShiftRow = Awaited<ReturnType<typeof listShiftsForTenant>>[number];
export type ShiftOtWindowRow = Awaited<ReturnType<typeof listShiftOtWindows>>[number];
export type ShiftRuleOption = Awaited<ReturnType<typeof listAttendanceRules>>[number];

/**
 * af7a8eb4 · Add / Edit form for ONE shift template, on its own page — the same shape
 * /admin/attendance-policy/rules already uses (rules/rule-form.tsx behind rules/new + rules/[ruleId]).
 * Before this it lived permanently open underneath the shift list on /admin/attendance, which is the
 * thing the reporter asked to stop seeing.
 *
 * This is a pure RELOCATION: every field, legend, hint and default is byte-for-byte what the inline form
 * rendered, with the flex-wrap groups swapped for the house responsive grid rule-form.tsx uses. Nothing is
 * added, renamed or removed — b8aa3466 is the item that changes the field set.
 *
 * Server component: it RENDERS ShiftTimeFields and ShiftOtWindowFields as JSX (never imports+calls them),
 * keeping the RSC boundary clean.
 */
export async function ShiftForm({
  shift,
  otWindows,
  ruleOptions,
  error,
}: {
  shift: ShiftRow | null;
  otWindows: ShiftOtWindowRow[];
  ruleOptions: ShiftRuleOption[];
  error?: string;
}) {
  const t = await getTranslations('admin.attendancePolicy');
  const editing = shift;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title={editing ? t('shiftFormEditTitle') : t('shiftFormNewTitle')}
        description={t('shiftFormDescription')}
        back={{ href: LIST, label: t('shiftFormBackToList') }}
      />
      <ErrorBanner message={error} />

      {/* `key` forces React to reset the ShiftTimeFields island's internal state when the route switches
          between add and a specific shift's edit. R33 f21d6eee — no company picker: a shift is a
          tenant-global template. */}
      <form
        id="shift-form"
        key={editing?.id ?? 'new'}
        action={editing ? updateShiftAction : createShiftAction}
        className="space-y-6"
      >
        {editing && <input type="hidden" name="shiftId" value={editing.id} />}

        <Card className="space-y-4 p-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t('shiftName')}>
              <input
                name="name"
                required
                placeholder={t('shiftName')}
                defaultValue={editing?.name ?? ''}
                className={inputCls}
                aria-label={t('shiftName')}
              />
            </Field>
            <Field label={t('shiftCode')}>
              <input
                name="code"
                required
                placeholder={t('shiftCode')}
                defaultValue={editing?.code ?? ''}
                className={inputCls}
                aria-label={t('shiftCode')}
              />
            </Field>
            {/* f3321963 — Shift Type selector. Normal (fixed schedule) + Semi-Flexi (flexible window) are
                selectable; Full-Flexi is reserved for a FUTURE enhancement (reporter-sanctioned), so its
                option is disabled and a placeholder note explains it. */}
            <Field label={t('shiftTypeLabel')}>
              <select
                name="shiftTemplateType"
                defaultValue={editing?.type ?? 'normal'}
                className={inputCls}
                aria-label={t('shiftTypeLabel')}
              >
                <option value="normal">{t('shiftTypeNormal')}</option>
                <option value="semi_flexi">{t('shiftTypeSemiFlexi')}</option>
                <option value="full_flexi" disabled>
                  {t('shiftTypeFullFlexi')}
                </option>
              </select>
            </Field>
          </div>
          {/* cf21e554 — the reference "Description" box. The Shift name can go back to being a short name.
              Full width: MB28's description is 48 characters and was being typed into the name field. */}
          <Field label={t('shiftDescription')}>
            <input
              name="description"
              defaultValue={editing?.description ?? ''}
              className={inputCls}
              aria-label={t('shiftDescription')}
            />
          </Field>
          <div className="flex flex-wrap items-end gap-2">
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
          </div>
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
              className={inputCls}
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
        </Card>

        {/* ── cf21e554 · the reference GENERAL tab's remaining boxes ─────────────────────────────── */}
        <Card className="space-y-4 p-4">
          <fieldset>
            <legend className="mb-1.5 text-sm font-medium text-foreground">{t('generalSectionLegend')}</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('shiftNormalHoursRounding')}>
                <input
                  name="normalHoursRoundingMinutes"
                  type="number"
                  min={0}
                  max={1440}
                  defaultValue={editing?.normalHoursRoundingMinutes ?? ''}
                  className={inputCls}
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
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">{t('shiftNormalHoursRoundingHint')}</p>
            <p className="text-xs text-muted-foreground">{t('shiftHalfDayHint')}</p>
          </fieldset>
        </Card>

        {/* cf21e554 — the boxes that are RECORDED ONLY in this stage. Grouped and labelled as such,
            because the plan promises "the screen will say so on the box itself, so nobody fills one in
            and expects a different pay result".

            Earliest clock-in, Latest clock-out, its next-day marker and the 2nd half-day clock-in were
            shipped in the General fieldset beside controls that DO move figures — but they have no
            reader anywhere in core/, app/, packs/ or components/ either (only validation in
            normalizeShiftInput and the copy in copyShift), so they belong here. Verified per field
            before moving. `halfDayFirstOut` deliberately STAYS in General: it is genuinely wired, at
            core/attendance.ts:528 and :599. Nothing is being wired up here — that is a later stage. */}
        <Card className="space-y-4 p-4">
          <fieldset>
            <legend className="mb-1.5 text-sm font-medium text-foreground">
              {t('recordedOnlyLegend')}{' '}
              <span className="font-normal text-muted-foreground">({t('recordedOnlyNote')})</span>
            </legend>
            <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3">
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
              <label className="inline-flex h-9 cursor-pointer items-center gap-1.5 self-end text-sm text-muted-foreground">
                <input
                  type="checkbox"
                  name="lateOutNextDay"
                  defaultChecked={editing?.lateOutNextDay === true}
                  className="h-3.5 w-3.5 accent-primary"
                />
                {t('shiftLateOutNextDay')}
              </label>
              <Field label={t('shiftHalfDaySecondIn')}>
                <input
                  name="halfDaySecondIn"
                  type="time"
                  defaultValue={editing?.halfDaySecondIn?.slice(0, 5) ?? ''}
                  className={inputCls}
                  aria-label={t('shiftHalfDaySecondIn')}
                />
              </Field>
              <Field label={t('shiftDayType')}>
                <select
                  name="shiftDayType"
                  defaultValue={editing?.dayType ?? ''}
                  className={inputCls}
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
                  className={inputCls}
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
                  className={inputCls}
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
                  className={inputCls}
                  aria-label={t('shiftFullDayOtMinutes')}
                />
              </Field>
            </div>
          </fieldset>
        </Card>

        {/* ── cf21e554 stage 2 · the reference OVERTIME SCHEDULE tab ─────────────────────────────── */}
        <Card className="space-y-4 p-4">
          <fieldset>
            <legend className="mb-1.5 text-sm font-medium text-foreground">{t('otScheduleLegend')}</legend>
            <ShiftOtWindowFields
              defaultRows={otWindows.map((w) => ({
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
        </Card>

        {/* 7c834696 rev 2 point 4 — these two are PAY, not a calculation setting, and sitting unlabelled
            next to the grace boxes is what made them read as one. core/payroll.ts prefillShiftDifferential
            reads shift.differential to prefill a payroll component (percent / flat-hourly / flat-per-shift),
            so removing them would leave live premiums unmaintainable. Grouped under their own heading
            instead, which is the fix the reporter actually needs. */}
        <Card className="space-y-4 p-4">
          <fieldset>
            <legend className="mb-1.5 text-sm font-medium text-foreground">
              {t('shiftPremiumLegend')}{' '}
              <span className="font-normal text-muted-foreground">({t('shiftPremiumHint')})</span>
            </legend>
            <div className="grid gap-3 sm:grid-cols-2">
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
                className={inputCls}
                aria-label={t('diffValue')}
              />
            </div>
          </fieldset>
        </Card>

        {/* Mon–Sun Working/Rest toggle — same has-[:checked] row as the working-days editor. Checked =
            working day; unchecked = rest. New shift defaults Mon–Fri. */}
        <Card className="space-y-4 p-4">
          <fieldset>
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
        </Card>

        <div className="flex items-center gap-3">
          <button className={btnPrimary}>{editing ? t('saveShift') : t('addShift')}</button>
          <Link href={LIST} className="text-sm text-muted-foreground hover:text-foreground hover:underline">
            {t('cancelEdit')}
          </Link>
        </div>
      </form>

      <div className="space-y-1">
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
    </div>
  );
}
