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
// b8aa3466 — the four day kinds of the weekly row. Static literal keys, same reason as above.
const DAY_KIND_KEY = {
  full: 'dayKindFull',
  half: 'dayKindHalf',
  rest: 'dayKindRest',
  off: 'dayKindOff',
} as const;
type DayKind = keyof typeof DAY_KIND_KEY;

export type ShiftRow = Awaited<ReturnType<typeof listShiftsForTenant>>[number];
export type ShiftOtWindowRow = Awaited<ReturnType<typeof listShiftOtWindows>>[number];
export type ShiftRuleOption = Awaited<ReturnType<typeof listAttendanceRules>>[number];

/**
 * af7a8eb4 · Add / Edit form for ONE shift template, on its own page — the same shape
 * /admin/attendance-policy/rules already uses (rules/rule-form.tsx behind rules/new + rules/[ruleId]).
 *
 * b8aa3466 · and now the form the reporter actually asked for. Three things changed:
 *
 *  1. EVERY BOX HAS A PRINTED LABEL. Ten controls carried only an aria-label or a placeholder, four of them
 *     the first four you type into.
 *  2. The top of the form is the EIGHT things the reporter listed, in their order, and the shift type
 *     decides which of them a shift needs (components/shift-time-fields.tsx owns that, as client state).
 *  3. Everything else folds into a collapsed "More settings" panel.
 *
 * MORE SETTINGS IS COLLAPSED, NOT UNMOUNTED, AND THAT IS LOAD-BEARING. shiftFields() in shift-actions.ts is
 * a FULL-ROW OVERWRITE and every General / Recorded-for-reference key is deliberately absent-means-null
 * (core/roster.ts). If any of those inputs stopped rendering, saving MB28 would null its early_in, late_out,
 * its OT window and the shift-premium pair that core/payroll.ts prefillShiftDifferential reads. A <details>
 * element keeps them all in the DOM and in the POST — which is exactly why it is a <details> and not a
 * conditional render.
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
  const tr = await getTranslations('roster');
  const editing = shift;

  // b8aa3466 — today's row read as the four-way one. Full = in weekly_pattern, Half / Off = their own
  // arrays, Rest = in none of them. A shift saved before migration 0429 therefore opens as Full where it
  // was ticked and Rest where it was not, which is precisely what it means today. A NEW shift defaults
  // Mon–Fri Full, Sat/Sun Rest — the same default the tick row had.
  const kindOf = (d: number): DayKind => {
    if (!editing) return d <= 5 ? 'full' : 'rest';
    if (editing.weeklyPattern?.includes(d)) return 'full';
    if (editing.halfPattern?.includes(d)) return 'half';
    if (editing.offPattern?.includes(d)) return 'off';
    return 'rest';
  };

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

        {/* ── What the shift IS ───────────────────────────────────────────────────────────────────── */}
        <Card className="space-y-4 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('shiftName')} required requiredAriaLabel={tr('requiredField')}>
              <input name="name" required defaultValue={editing?.name ?? ''} className={inputCls} />
            </Field>
            <Field label={t('shiftCode')} required requiredAriaLabel={tr('requiredField')}>
              <input name="code" required defaultValue={editing?.code ?? ''} className={inputCls} />
            </Field>
          </div>

          {/* Shift type + the per-type field set (items 1-6 of the reporter's list). The island owns the
              type select, because the type is what decides which of these boxes a shift needs. */}
          <ShiftTimeFields
            defaultType={(editing?.type ?? 'normal') as 'normal' | 'semi_flexi' | 'full_flexi'}
            defaultStart={editing?.startTime.slice(0, 5) ?? '09:00'}
            defaultEnd={editing?.endTime.slice(0, 5) ?? '18:00'}
            defaultBreaks={(editing?.breakPeriods ?? []).map((bp) => ({
              start: bp.start.slice(0, 5),
              end: bp.end.slice(0, 5),
              paid: bp.paid === true,
              flexible: bp.flexible === true,
            }))}
            defaultBreakMinutes={editing ? String(editing.breakMinutes) : '60'}
            defaultOverride={editing?.normalMinutesOverride != null ? String(editing.normalMinutesOverride) : ''}
            defaultRounding={editing?.normalHoursRoundingMinutes != null ? String(editing.normalHoursRoundingMinutes) : ''}
            defaultHalfDayFirstOut={editing?.halfDayFirstOut?.slice(0, 5) ?? ''}
            defaultDailyCutoffEnabled={editing?.dailyCutoffEnabled === true}
            defaultDailyCutoffTime={editing?.dailyCutoffTime?.slice(0, 5) ?? ''}
          />

          {/* 7 — 88e94371: the shift's attendance-calculation rule. Blank ⇒ the tenant's Standard rule. */}
          <Field label={t('ruleFieldLabel')}>
            <select name="attendanceRuleId" defaultValue={editing?.ruleId ?? ''} className={inputCls}>
              <option value="">{t('ruleFieldStandardDefault')}</option>
              {ruleOptions.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.isDefault ? `${r.name} ${t('ruleDefaultSuffix')}` : r.name}
                  {r.status === 'inactive' ? ` ${t('ruleInactiveSuffix')}` : ''}
                </option>
              ))}
            </select>
          </Field>

          {/* 8 — b8aa3466: the Mon–Sun row becomes seven dropdowns, one line, four choices each.
              One <select> per weekday posting "full" | "half" | "rest" | "off", decoded server-side in
              shift-actions.ts into the three ISO-weekday arrays the service expects — the same idiom the
              company work schedule has used since feedback 31474452. */}
          <fieldset>
            <legend className="mb-1.5 text-sm font-medium text-foreground">{t('shiftWorkingDays')}</legend>
            <div className="flex flex-wrap gap-1.5">
              {ISO_DAYS.map((d) => (
                <div key={d} className="flex flex-col items-center gap-1 rounded-lg border border-border px-2 py-1.5">
                  <span className="text-xs font-medium text-foreground">{t(DAY_KEY[d])}</span>
                  <select
                    name={`dayKind_${d}`}
                    defaultValue={kindOf(d)}
                    className="rounded border border-border bg-transparent px-1 py-0.5 text-xs"
                    aria-label={t(DAY_KEY[d])}
                  >
                    <option value="full">{tr(DAY_KIND_KEY.full)}</option>
                    <option value="half">{tr(DAY_KIND_KEY.half)}</option>
                    <option value="rest">{tr(DAY_KIND_KEY.rest)}</option>
                    <option value="off">{tr(DAY_KIND_KEY.off)}</option>
                  </select>
                </div>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">{tr('dayKindHint')}</p>
          </fieldset>
        </Card>

        {/* ── MORE SETTINGS · collapsed, never unmounted (see the header comment) ──────────────────── */}
        <Card className="p-0">
          <details className="group">
            <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium text-foreground marker:content-none">
              <span className="inline-flex items-center gap-2">
                <span aria-hidden="true" className="text-muted-foreground transition-transform group-open:rotate-90">
                  ▸
                </span>
                {tr('moreSettingsSummary')}
              </span>
              <span className="mt-0.5 block text-xs font-normal text-muted-foreground">{tr('moreSettingsHint')}</span>
            </summary>

            <div className="space-y-6 border-t border-border px-4 py-4">
              {/* cf21e554 — the reference "Description" box. */}
              <Field label={t('shiftDescription')}>
                <input name="description" defaultValue={editing?.description ?? ''} className={inputCls} />
              </Field>

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
                    />
                  </Field>
                </div>
                <p className="mt-1.5 text-xs text-muted-foreground">{t('shiftNormalHoursRoundingHint')}</p>
              </fieldset>

              {/* cf21e554 — the boxes that are RECORDED ONLY, grouped and labelled as such. Every one of
                  them still POSTS, which is why they live behind a <details> rather than a condition. */}
              <fieldset>
                <legend className="mb-1.5 text-sm font-medium text-foreground">
                  {t('recordedOnlyLegend')}{' '}
                  <span className="font-normal text-muted-foreground">({t('recordedOnlyNote')})</span>
                </legend>
                <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3">
                  <Field label={t('shiftEarlyIn')}>
                    <input name="earlyIn" type="time" defaultValue={editing?.earlyIn?.slice(0, 5) ?? ''} className={inputCls} />
                  </Field>
                  <Field label={t('shiftLateOut')}>
                    <input name="lateOut" type="time" defaultValue={editing?.lateOut?.slice(0, 5) ?? ''} className={inputCls} />
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
                    />
                  </Field>
                  <Field label={t('shiftDayType')}>
                    <select name="shiftDayType" defaultValue={editing?.dayType ?? ''} className={inputCls}>
                      <option value="">{t('notSet')}</option>
                      <option value="workday">{t(DAY_TYPE_KEY.workday)}</option>
                      <option value="rest_day">{t(DAY_TYPE_KEY.rest_day)}</option>
                      <option value="holiday">{t(DAY_TYPE_KEY.holiday)}</option>
                    </select>
                  </Field>
                  <Field label={t('shiftCategory')}>
                    <input name="category" defaultValue={editing?.category ?? ''} className={inputCls} />
                  </Field>
                  <Field label={t('shiftFullDayLeaveMinutes')}>
                    <input
                      name="fullDayLeaveMinutes"
                      type="number"
                      min={0}
                      max={1440}
                      defaultValue={editing?.fullDayLeaveMinutes ?? ''}
                      className={inputCls}
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
                    />
                  </Field>
                </div>
              </fieldset>

              {/* ── cf21e554 stage 2 · the reference OVERTIME SCHEDULE tab ─────────────────────────── */}
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

              {/* 7c834696 rev 2 point 4 — these two are PAY, not a calculation setting.
                  core/payroll.ts prefillShiftDifferential reads shift.differential to prefill a payroll
                  component, so removing them would leave live premiums unmaintainable. b8aa3466 — and they
                  finally have printed labels; they were two of the ten unlabelled boxes. */}
              <fieldset>
                <legend className="mb-1.5 text-sm font-medium text-foreground">
                  {t('shiftPremiumLegend')}{' '}
                  <span className="font-normal text-muted-foreground">({t('shiftPremiumHint')})</span>
                </legend>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label={t('diffLabel')}>
                    <select name="differentialKind" defaultValue={editing?.differential?.kind ?? ''} className={inputCls}>
                      <option value="">{t('diffNone')}</option>
                      <option value="percent">{t('diffPercent')}</option>
                      <option value="flat_hourly">{t('diffFlatHourly')}</option>
                      <option value="flat_per_shift">{t('diffPerShift')}</option>
                    </select>
                  </Field>
                  <Field label={t('diffValue')}>
                    <input
                      name="differentialValue"
                      type="number"
                      min={0}
                      step="0.01"
                      defaultValue={editing?.differential?.value ?? ''}
                      className={inputCls}
                    />
                  </Field>
                </div>
              </fieldset>
            </div>
          </details>
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
        <p className="text-xs text-muted-foreground">{t('breakPaidHint')}</p>
        {/* f3321963 — Semi-Flexi rule + Full-Flexi future-release placeholder. */}
        <p className="text-xs text-muted-foreground">{t('shiftTypeSemiFlexiNote')}</p>
        <p className="text-xs text-muted-foreground">{t('shiftTypeFullFlexiNote')}</p>
        <p className="text-xs text-muted-foreground">{t('generalMoreTabNote')}</p>
      </div>
    </div>
  );
}
