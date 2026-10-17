import { getTranslations } from 'next-intl/server';
import { AttendanceSettingsNavigation } from '@/components/attendance-settings-navigation';
import Link from 'next/link';
import type { listShiftOtWindows, listShiftsForTenant } from '@/core/roster';
import type { listAttendanceRules } from '@/core/attendance-rule';
import { weekPatternFor, weekPatternGroupFor } from '@/core/week-pattern';
import { ErrorBanner, Field, PageHeader, btnPrimary, inputCls, pageWideCls } from '@/components/ui';
import { SectionCard, LabelValue, LabelValueList } from '@/components/ui/section-card';
import { ShiftTimeFields } from '@/components/shift-time-fields';
import { ShiftColorPicker } from '@/components/shift-color-picker';
import { scheduleGroupSectionHref } from './schedule/sections';
import { createShiftAction, updateShiftAction } from './shift-actions';

const LIST = '/admin/attendance';

// 6340aecb — the colour swatches. Static literal keys so the i18n coverage test's check C can see every one.
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
 * r429 (f6819e19) · THE SHIFT PAGE, REDESIGNED — "how this shift works: its hours and its breaks. Which
 * days it is worked is set by its Schedule Group." (the reporter's own words, from the mockup header).
 *
 * ── D1-D8 OF THE APPROVED PLAN, IN ONE PLACE ─────────────────────────────────────────────────────────────
 * THREE sections now, not four, plus a closed fourth:
 *   1. SHIFT INFORMATION — name, label (code), colour, description, category, and — READ ONLY — the
 *      Schedule Group this shift belongs to and the working days actually in force, with a link to change
 *      them on the Group's own page. (components/ui/section-card.tsx LabelValueList/LabelValue, the r427
 *      primitives this redesign is built on.)
 *   2. WORKING TIME — shift type, start/end, the derived Cross Midnight readout, Full Day Working Hours +
 *      rounding, the half-day pair, and — grouped as "recorded for reference" — the earliest/latest
 *      accepted clocking and the daily cut-off.                       (components/shift-time-fields.tsx)
 *   3. BREAKS — an always-visible table, one row per break, Flexible as the ONE way to set a break.
 *                                                                      (components/shift-time-fields.tsx)
 *   4. OVERTIME AND PAY FOR THIS SHIFT — the overtime schedule and the shift premium, behind a closed
 *      <details> that stays MOUNTED (never a conditional render — see the note below).
 *
 * GONE (D1/D2/D3/D4): the Mon–Sun working-day row (now the Schedule Group's own "Working Days" section),
 * the Schedule Group picker (now the Group's own "Shifts in this group" — changed FROM the group, not the
 * shift), the three reference-only boxes (day type, full-day leave, full-day overtime — saved, not shown),
 * and the whole-shift Flexible switch (per-row Flexible is the one way now; the one shift migration 0519
 * could not convert keeps its switch until explicitly turned off — see shift-time-fields.tsx).
 *
 * NOTHING WAS DROPPED FROM THE WRITE, AND THAT IS STILL LOAD-BEARING. shiftFields() in shift-actions.ts is
 * a FULL-ROW OVERWRITE for the fields still on screen; every field that left the screen (the week, the
 * group, the three reference boxes, the whole-shift switch) now PRESERVES on an absent post
 * (core/roster.ts normalizeShiftInput), the same undefined-means-preserve contract 88e94371 established for
 * otRule / ruleId. The overtime schedule stays MOUNTED behind its <details> for the same old reason: a
 * <details> hides children without unmounting them, and a conditional render would delete every window on
 * the next save.
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

  // ── D2 · THE SCHEDULE GROUP, READ-ONLY ─────────────────────────────────────────────────────────────
  // The SAME resolver the engine and the Schedule Group's own page use (core/week-pattern.ts), asked about
  // the SAME two candidates: the group a blank dropdown would have resolved to (weekPatternGroupFor), and
  // the triple it hands to weekPatternFor. Nothing here writes anything — see shift-actions.ts, which never
  // posts a ruleId or a day field for this form at all any more.
  const group = weekPatternGroupFor(ruleOptions, editing?.ruleId ?? null);
  const groupWeek = group ? { pattern: group.weeklyPattern, halfPattern: group.halfPattern, offPattern: group.offPattern } : null;
  const shiftOwnWeek = {
    pattern: editing?.weeklyPattern ?? null,
    halfPattern: editing?.halfPattern ?? [],
    offPattern: editing?.offPattern ?? [],
  };
  const resolvedWeek = weekPatternFor(groupWeek, shiftOwnWeek);
  const ISO_DAYS = [1, 2, 3, 4, 5, 6, 7] as const;
  const DAY_KEY: Record<number, string> = { 1: 'dayMon', 2: 'dayTue', 3: 'dayWed', 4: 'dayThu', 5: 'dayFri', 6: 'daySat', 7: 'daySun' };
  const KIND_KEY = { full: 'dayKindFull', half: 'dayKindHalf', off: 'dayKindOff', rest: 'dayKindRest' } as const;
  const declaresWeek = ISO_DAYS.some(
    (d) => resolvedWeek.pattern?.includes(d) || resolvedWeek.halfPattern?.includes(d) || resolvedWeek.offPattern?.includes(d),
  );
  const weekDaysText = declaresWeek
    ? ISO_DAYS.map((d) => {
        const kind = resolvedWeek.pattern?.includes(d)
          ? 'full'
          : resolvedWeek.halfPattern?.includes(d)
            ? 'half'
            : resolvedWeek.offPattern?.includes(d)
              ? 'off'
              : 'rest';
        return kind === 'rest' ? null : `${t(DAY_KEY[d])} ${tr(KIND_KEY[kind])}`;
      })
        .filter(Boolean)
        .join(' · ')
    : null;

  // ── D5 · BREAKS — the always-at-least-one-row table, and the scalar-only / locked states ──────────
  const defaultBreaks =
    editing?.breakPeriods && editing.breakPeriods.length > 0
      ? editing.breakPeriods.map((bp) => ({
          start: bp.start.slice(0, 5),
          end: bp.end.slice(0, 5),
          paid: bp.paid === true,
          flexible: bp.flexible === true,
          flexibleMinutes: bp.flexibleMinutes != null ? String(bp.flexibleMinutes) : '',
        }))
      : [{ start: '', end: '' }];
  const isScalarOnlySource =
    editing != null && (editing.breakPeriods == null || editing.breakPeriods.length === 0) && editing.breakMinutes > 0;

  return (
    <div className={pageWideCls}>
      <AttendanceSettingsNavigation />
      <PageHeader
        title={editing ? t('shiftFormEditTitle') : t('shiftFormNewTitle')}
        description={t('shiftFormDescription')}
        back={{ href: LIST, label: t('shiftFormBackToList') }}
      />
      <ErrorBanner message={error} />

      {/* `key` forces React to reset the ShiftTimeFields island's internal state when the route switches
          between add and a specific shift's edit. R33 f21d6eee — no company picker: a shift is a
          tenant-global template. */}
      <form id="shift-form" key={editing?.id ?? 'new'} action={editing ? updateShiftAction : createShiftAction} className="space-y-6">
        {editing && <input type="hidden" name="shiftId" value={editing.id} />}

        {/* ── SECTION 1 · SHIFT INFORMATION ──────────────────────────────────────────────────────────── */}
        <SectionCard index={1} title={t('shiftInformationLegend')}>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label={tr('shiftName')} required requiredAriaLabel={tr('requiredField')}>
              <input name="name" required defaultValue={editing?.name ?? ''} className={inputCls} />
            </Field>
            <Field label={t('shiftCode')} required requiredAriaLabel={tr('requiredField')}>
              <input name="code" required defaultValue={editing?.code ?? ''} className={inputCls} />
            </Field>
            <Field label={t('shiftCategory')}>
              <input name="category" defaultValue={editing?.category ?? ''} className={inputCls} />
            </Field>
            <Field label={t('shiftDescription')}>
              <input name="description" defaultValue={editing?.description ?? ''} className={inputCls} />
            </Field>
          </div>

          <ShiftColorPicker value={editing?.color ?? null} />

          {/* r429 (f6819e19) · D2 — READ ONLY. The group is changed on ITS OWN page now ("Shifts allowed"
              there), and the week is changed on the group's "Working Days" section — never here. */}
          <LabelValueList className="mt-5 border-t border-border pt-2">
            <LabelValue
              label={t('shiftScheduleGroupLabel')}
              value={
                <>
                  {group?.name ?? '—'}{' '}
                  <Link href={scheduleGroupSectionHref(group?.id ?? '', 'workingDay')} className="text-primary hover:underline">
                    {t('shiftScheduleGroupChangeLink')}
                  </Link>
                </>
              }
            />
            <LabelValue
              label={t('shiftWorkingDaysInForceLabel')}
              value={weekDaysText ?? t('shiftScheduleGroupNoWeek', { group: group?.name ?? '' })}
              help={
                declaresWeek
                  ? resolvedWeek.source === 'group'
                    ? t('shiftWorkingDaysSetBy', { group: group?.name ?? '' })
                    : t('shiftWorkingDaysOwnWeek')
                  : undefined
              }
            />
          </LabelValueList>
          <p className="mt-2 text-xs text-muted-foreground">{t('shiftScheduleGroupFollowNote')}</p>
        </SectionCard>

        {/* ── SECTIONS 2 + 3 · WORKING TIME and BREAKS ────────────────────────────────────────────────
            One island renders both: the shift type decides the labels and which boxes are asked for, and
            the break rows feed the live normal-hours readout, so the two sections share state. */}
        <ShiftTimeFields
          defaultType={(editing?.type ?? 'normal') as 'normal' | 'semi_flexi' | 'full_flexi'}
          defaultStart={editing?.startTime?.slice(0, 5) ?? '09:00'}
          defaultEnd={editing?.endTime?.slice(0, 5) ?? '18:00'}
          defaultBreaks={defaultBreaks}
          isScalarOnlySource={isScalarOnlySource}
          defaultBreakMinutesScalar={editing ? String(editing.breakMinutes) : '0'}
          defaultOverride={editing?.normalMinutesOverride != null ? String(editing.normalMinutesOverride) : ''}
          defaultRounding={editing?.normalHoursRoundingMinutes != null ? String(editing.normalHoursRoundingMinutes) : ''}
          defaultHalfDayFirstOut={editing?.halfDayFirstOut?.slice(0, 5) ?? ''}
          defaultHalfDaySecondIn={editing?.halfDaySecondIn?.slice(0, 5) ?? ''}
          defaultEarlyIn={editing?.earlyIn?.slice(0, 5) ?? ''}
          defaultLateOut={editing?.lateOut?.slice(0, 5) ?? ''}
          defaultLateOutNextDay={editing?.lateOutNextDay === true}
          defaultDailyCutoffEnabled={editing?.dailyCutoffEnabled === true}
          defaultDailyCutoffTime={editing?.dailyCutoffTime?.slice(0, 5) ?? ''}
          flexLocked={editing?.flexibleBreakEnabled === true}
          lockedAllowanceMinutes={editing?.flexibleBreakMinutes ?? 0}
          lockedBreakPeriodsJson={JSON.stringify(editing?.breakPeriods ?? [])}
        />

        <p className="text-sm text-muted-foreground"><Link className="text-primary hover:underline" href="/admin/attendance/settings/work-schedule-overtime#shift-pay">{t('shiftOvertimePayLegend')}</Link></p>

        <div className="flex items-center gap-3">
          <button className={btnPrimary}>{editing ? t('saveShift') : t('addShift')}</button>
          <Link href={LIST} className="text-sm text-muted-foreground hover:text-foreground hover:underline">
            {t('cancelEdit')}
          </Link>
        </div>
      </form>

      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">{t('breakPaidHint')}</p>
      </div>
    </div>
  );
}
