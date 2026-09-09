import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import type { listShiftOtWindows, listShiftsForTenant } from '@/core/roster';
import type { listAttendanceRules } from '@/core/attendance-rule';
import { Card, ErrorBanner, Field, PageHeader, btnPrimary, inputCls, pageWideCls } from '@/components/ui';
import { ShiftTimeFields, type DayKind } from '@/components/shift-time-fields';
import { ShiftOtWindowFields } from '@/components/shift-ot-window-fields';
import { SHIFT_COLORS, SHIFT_COLOR_TOKENS } from '@/lib/shift-visual';
import { createShiftAction, updateShiftAction } from './shift-actions';

const LIST = '/admin/attendance';

const ISO_DAYS = [1, 2, 3, 4, 5, 6, 7] as const;
// cf21e554 — the shift Day Type box (RECORDED ONLY in stage 1). Static literal keys so the i18n coverage
// test's check C can see every one of them.
const DAY_TYPE_KEY: Record<string, string> = {
  workday: 'shiftDayTypeWorkday',
  rest_day: 'shiftDayTypeRestDay',
  holiday: 'shiftDayTypeHoliday',
};
// 6340aecb — the colour swatches. Static literal keys, same reason as above.
const COLOR_KEY: Record<string, string> = {
  indigo: 'shiftColorIndigo',
  green: 'shiftColorGreen',
  orange: 'shiftColorOrange',
  blue: 'shiftColorBlue',
  red: 'shiftColorRed',
  purple: 'shiftColorPurple',
  teal: 'shiftColorTeal',
  grey: 'shiftColorGrey',
};

export type ShiftRow = Awaited<ReturnType<typeof listShiftsForTenant>>[number];
export type ShiftOtWindowRow = Awaited<ReturnType<typeof listShiftOtWindows>>[number];
export type ShiftRuleOption = Awaited<ReturnType<typeof listAttendanceRules>>[number];

/**
 * af7a8eb4 · Add / Edit form for ONE shift template, on its own page — the same shape
 * /admin/attendance-policy/rules already uses (rules/rule-form.tsx behind rules/new + rules/[ruleId]).
 *
 * ── 6340aecb · THE REDESIGN THE REPORTER ASKED FOR ───────────────────────────────────────────────────
 * The screen had grown field by field rather than being designed, so it read as one long form with a
 * catch-all "More settings" drawer at the bottom. It is now FULL WIDTH and organised into the four
 * sections the reporter named, in their order:
 *
 *   1. SHIFT IDENTIFICATION — what the shift IS: name, code, colour, description, category.
 *   2. WORKING TIMES        — times in/out, the relabelled clock window, total normal hours, the half-day
 *                             pair, the daily cut-off and the weekly row.   (components/shift-time-fields)
 *   3. BREAKS               — the break windows, and the new Flexible break. (components/shift-time-fields)
 *   4. GENERAL CONTROLS     — the rule, rounding, the recorded-only boxes, the overtime schedule and the
 *                             shift premium.
 *
 * NOTHING WAS DROPPED, AND THAT IS LOAD-BEARING. shiftFields() in shift-actions.ts is a FULL-ROW OVERWRITE
 * and every General / recorded-for-reference key is deliberately absent-means-null (core/roster.ts). If any
 * of those inputs stopped rendering, saving MB28 would null its early_in, late_out, its OT window and the
 * shift-premium pair that core/payroll.ts prefillShiftDifferential reads. The old form kept them alive
 * inside a <details> for exactly that reason; sections keep them alive by simply being visible, and the
 * one control still behind a <details> below (the overtime schedule) stays MOUNTED because a <details>
 * hides its children without unmounting them.
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
  const dayKinds = Object.fromEntries(ISO_DAYS.map((d) => [d, kindOf(d)])) as Record<number, DayKind>;

  return (
    <div className={pageWideCls}>
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

        {/* ── SECTION 1 · SHIFT IDENTIFICATION ──────────────────────────────────────────────────────── */}
        <Card className="space-y-4 p-4">
          <h2 className="text-sm font-semibold text-foreground">{t('shiftIdentificationLegend')}</h2>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label={t('shiftName')} required requiredAriaLabel={tr('requiredField')}>
              <input name="name" required defaultValue={editing?.name ?? ''} className={inputCls} />
            </Field>
            <Field label={t('shiftCode')} required requiredAriaLabel={tr('requiredField')}>
              <input name="code" required defaultValue={editing?.code ?? ''} className={inputCls} />
            </Field>
            {/* cf21e554 — the reference "Description" box. MB28's description was living in its NAME
                because there was nowhere else to put it; this is that place, and it belongs with the
                shift's identity rather than in a drawer at the bottom of the screen. */}
            <Field label={t('shiftDescription')} className="lg:col-span-2">
              <input name="description" defaultValue={editing?.description ?? ''} className={inputCls} />
            </Field>
            <Field label={t('shiftCategory')}>
              <input name="category" defaultValue={editing?.category ?? ''} className={inputCls} />
            </Field>
          </div>

          {/* 6340aecb — THE SHIFT COLOUR (request points 6 + 7). A closed palette of radio swatches rather
              than a colour picker: the value is rendered as a filled chip on the Duty Roster, where it has
              to stay legible in both themes, and an arbitrary hex cannot promise that. "No colour" is a
              real, selectable option and the default — a shift without one is drawn on the roster exactly
              as it is today (components/roster-grid.tsx keeps its automatic position palette for it), so
              nothing about an existing roster changes until somebody chooses. */}
          <fieldset>
            <legend className="mb-1.5 text-sm font-medium text-foreground">{t('shiftColorLabel')}</legend>
            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground has-[:checked]:ring-2 has-[:checked]:ring-foreground/40">
                <input
                  type="radio"
                  name="color"
                  value=""
                  defaultChecked={!editing?.color}
                  className="h-3.5 w-3.5 accent-primary"
                />
                {t('shiftColorNone')}
              </label>
              {SHIFT_COLOR_TOKENS.map((token) => (
                <label
                  key={token}
                  className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium has-[:checked]:ring-2 has-[:checked]:ring-foreground/40 ${SHIFT_COLORS[token]}`}
                >
                  <input
                    type="radio"
                    name="color"
                    value={token}
                    defaultChecked={editing?.color === token}
                    className="h-3.5 w-3.5 accent-primary"
                  />
                  {t(COLOR_KEY[token])}
                </label>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">{t('shiftColorHint')}</p>
          </fieldset>
        </Card>

        {/* ── SECTIONS 2 + 3 · WORKING TIMES and BREAKS ─────────────────────────────────────────────
            One island renders both: the shift type decides the labels and which boxes are asked for, and
            the break rows feed the live normal-hours readout, so the two sections share state. */}
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
          defaultHalfDaySecondIn={editing?.halfDaySecondIn?.slice(0, 5) ?? ''}
          defaultEarlyIn={editing?.earlyIn?.slice(0, 5) ?? ''}
          defaultLateOut={editing?.lateOut?.slice(0, 5) ?? ''}
          defaultLateOutNextDay={editing?.lateOutNextDay === true}
          defaultDailyCutoffEnabled={editing?.dailyCutoffEnabled === true}
          defaultDailyCutoffTime={editing?.dailyCutoffTime?.slice(0, 5) ?? ''}
          defaultFlexibleBreakEnabled={editing?.flexibleBreakEnabled === true}
          defaultFlexibleBreakMinutes={editing?.flexibleBreakMinutes != null ? String(editing.flexibleBreakMinutes) : ''}
          dayKinds={dayKinds}
        />

        {/* ── SECTION 4 · GENERAL CONTROLS ──────────────────────────────────────────────────────────── */}
        <Card className="space-y-6 p-4">
          <h2 className="text-sm font-semibold text-foreground">{t('generalSectionLegend')}</h2>

          {/* 88e94371: the shift's attendance-calculation rule. Blank ⇒ the tenant's Standard rule. */}
          <div className="grid gap-3 sm:grid-cols-2">
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
            <div>
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
              <p className="mt-1 text-xs text-muted-foreground">{t('shiftNormalHoursRoundingHint')}</p>
            </div>
          </div>

          {/* cf21e554 — the boxes that are RECORDED ONLY, grouped and labelled as such. Every one of them
              still POSTS; a full-row overwrite means a box that stops rendering is a column that gets
              nulled on the next save. */}
          <fieldset>
            <legend className="mb-1.5 text-sm font-medium text-foreground">
              {t('recordedOnlyLegend')}{' '}
              <span className="font-normal text-muted-foreground">({t('recordedOnlyNote')})</span>
            </legend>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Field label={t('shiftDayType')}>
                <select name="shiftDayType" defaultValue={editing?.dayType ?? ''} className={inputCls}>
                  <option value="">{t('notSet')}</option>
                  <option value="workday">{t(DAY_TYPE_KEY.workday)}</option>
                  <option value="rest_day">{t(DAY_TYPE_KEY.rest_day)}</option>
                  <option value="holiday">{t(DAY_TYPE_KEY.holiday)}</option>
                </select>
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

          {/* 7c834696 rev 2 point 4 — these two are PAY, not a calculation setting.
              core/payroll.ts prefillShiftDifferential reads shift.differential to prefill a payroll
              component, so removing them would leave live premiums unmaintainable. */}
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

          {/* ── cf21e554 stage 2 · the reference OVERTIME SCHEDULE tab ─────────────────────────────────
              The one thing still behind a disclosure, because it is a repeating grid most shifts leave
              empty. A <details> HIDES its children without unmounting them, which is why it is a <details>
              and not a conditional render: the grid must keep posting even while it is closed. */}
          <details className="group rounded-lg border border-border" open={otWindows.length > 0}>
            <summary className="cursor-pointer list-none px-3 py-2 text-sm font-medium text-foreground marker:content-none">
              <span className="inline-flex items-center gap-2">
                <span aria-hidden="true" className="text-muted-foreground transition-transform group-open:rotate-90">
                  ▸
                </span>
                {t('otScheduleLegend')}
              </span>
            </summary>
            <div className="border-t border-border px-3 py-3">
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
        {/* 6340aecb — the sequence rules the service enforces, said once where the operator can read them
            instead of discovered one refusal at a time. */}
        <p className="text-xs text-muted-foreground">{t('shiftTimeSequenceHint')}</p>
        {/* f3321963 — Semi-Flexi rule + Full-Flexi future-release placeholder. */}
        <p className="text-xs text-muted-foreground">{t('shiftTypeSemiFlexiNote')}</p>
        <p className="text-xs text-muted-foreground">{t('shiftTypeFullFlexiNote')}</p>
        <p className="text-xs text-muted-foreground">{t('generalMoreTabNote')}</p>
      </div>
    </div>
  );
}
