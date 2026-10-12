import type { ReactNode } from 'react';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { SessionContext } from '@/db/client';
import { countEmploymentsInRule, type AttendanceRuleView } from '@/core/attendance-rule';
import { listShiftsForTenant } from '@/core/roster';
import {
  Badge,
  Card,
  ErrorBanner,
  Field,
  SectionHeader,
  btnPrimary,
  inputCls,
  tableWrapCls,
  tbodyCls,
  theadCls,
  thCls,
} from '@/components/ui';
import { RuleForm } from '../../attendance-policy/rules/rule-form';
import { ruleShiftChoices } from '../../attendance-policy/rules/shift-choices';
import {
  SCHEDULE_SECTION_KEYS,
  sectionAnchor,
  type ScheduleSectionKey,
} from './sections';
import { scheduleGroupEditPath } from '../../attendance-policy/schedule-panel';
import {
  saveScheduleGroupAttendanceAction,
  saveScheduleGroupOvertimeAction,
} from './actions';
import { ScheduleRotationEditor } from '@/components/schedule-rotation-editor';
import { getScheduleRotation, workingShiftSchedule } from '@/packs/attendance/service';
import { todayInKualaLumpur } from '@/lib/hr-date';
import type { RotationCycle } from '@/core/week-pattern';

/**
 * ─── 665de026 (r331) · ONE SCHEDULE GROUP, ONE SCREEN ────────────────────────────────────────────────
 *
 * THE ITEM IN ONE LINE. Attendance › Schedule was a single tabbed page carrying EVERY Schedule Group's
 * settings at once, with Add and Edit opening over the top of it. The reporter called it crowded and asked
 * for the shape app/admin/attendance/schedule-assignment already has: a list, and a page per record.
 *
 * ⚠️ THIS FILE IS RENDERED BY TWO PAGES AND IS THE ONLY PLACE THAT SAYS WHAT A SCHEDULE GROUP IS.
 * `./[ruleId]/page.tsx` (View Schedule) and `./[ruleId]/edit/page.tsx` (Edit Schedule) both mount it and
 * differ ONLY in `mode`. Two files would be two descriptions of one record, and they would diverge the
 * first time a section changed — the View page would keep showing a setting the Edit page had dropped, and
 * nothing would fail. `mode` is the whole difference and it is threaded, never branched on at the page.
 *
 * ── THE SEVEN SECTIONS, AND WHICH OF THEM ARE REAL ──────────────────────────────────────────────────────
 * ./sections.ts holds the order (the reporter's own) and the honest audit of what is behind each key.
 * FOUR render something: general, overtime, attendance and — new in this item — workingDay. THREE are
 * named and empty: holiday, request, notification. They render one sentence saying so.
 *
 * DO NOT "finish" this screen by drawing a control for a setting nothing stores. The list page's header
 * names the four that are not stored anywhere (rotation, the duty-roster controls, the day-type
 * allow-list, the monthly OT cap) and where each is actually governed from.
 *
 * ── WHY THE GENERAL SECTION IS NOT THE OLD GENERAL TAB ──────────────────────────────────────────────────
 * The old General tab held five cards and exactly ONE of them was per-Schedule-Group. The other four
 * belong to the TENANT (the shift library, the overtime rates, the registered devices) or to a COMPANY
 * (`attendance_policy`), so they have no per-group page to move to and they stayed on the list. The
 * General SECTION is the group's own identity — name, description, status, allowed shifts, the deduction
 * switch and the overtime ladder — which is what rules/rule-form.tsx has always edited. That form is
 * mounted here unchanged apart from its page chrome; the overtime-band editor, the continuous-ladder
 * validation and the service-stamped deduction date all stay in one file with one writer.
 * docs/audits/665de026-schedule-save-classification.md §5 has the card-by-card measurement.
 *
 * ── FOUR SAVES, NO SCREEN-WIDE SAVE, AND THAT IS A DECISION ─────────────────────────────────────────────
 * Each section keeps its own Save. `components/tab-save-scope.tsx` is deliberately NOT mounted: a
 * screen-wide Save implies a screen-wide Discard, and five of the nine forms on this feature are RECORD
 * LIFECYCLE (create, duplicate, delete, activate/deactivate, revoke) while a sixth — the rule editor —
 * stamps `deductions_effective_from` to TODAY on switch-on and clears it on switch-off, so a Discard
 * beside it would appear to undo a toggle while actually moving the date deductions start applying from.
 * The audit above is the measurement; this comment is the consequence.
 *
 * ── WHERE A SAVE LEAVES YOU ─────────────────────────────────────────────────────────────────────────────
 * On this page, on the section it was made from, with a confirmation — `okScheduleGroup` /
 * `failScheduleGroup` (app/admin/_redirects.ts). The section rides as a SECOND `&` parameter (read here,
 * to decide which section shows a refusal) and again as the fragment (read by the browser, to scroll).
 * Never in front of the query key: that is the r287 → r301 defect and it has bitten this screen twice.
 */
export type ScheduleSectionMode = 'view' | 'edit';

const ISO_DAYS = [1, 2, 3, 4, 5, 6, 7] as const;
const DAY_KEY: Record<number, string> = {
  1: 'dayMon',
  2: 'dayTue',
  3: 'dayWed',
  4: 'dayThu',
  5: 'dayFri',
  6: 'daySat',
  7: 'daySun',
};
/** The four-way row, exactly as `shift` carries it since migration 0429 and `attendance_rule` since 0483. */
const DAY_KINDS = ['full', 'half', 'off', 'rest'] as const;
type DayKind = (typeof DAY_KINDS)[number];
const DAY_KIND_KEY: Record<DayKind, string> = {
  full: 'dayKindFull',
  half: 'dayKindHalf',
  off: 'dayKindOff',
  rest: 'dayKindRest',
};
/** The compact echo `failScheduleGroup` carries back, one character per weekday. See ./actions.ts weekParam. */
const CHAR_KIND: Record<string, DayKind> = { F: 'full', H: 'half', O: 'off', R: 'rest' };

/**
 * Which kind each weekday is, read from the STORED row — or, on the refusal path, from what the operator
 * had typed.
 *
 * "Nothing you entered is lost": the only refusal this section can raise is fixed by changing ONE
 * dropdown, so re-rendering the other six from the database would silently undo six edits that were made.
 * `typedWeek` is read BY SHAPE — seven characters from a four-letter alphabet — and anything else is
 * dropped, so a hand-edited URL can never widen what the form accepts (lib/calendar-focus.ts: "Junk is
 * dropped rather than rendered").
 */
export function dayKindsOf(rule: AttendanceRuleView, typedWeek?: string): Record<number, DayKind> {
  const typed = typedWeek?.trim().toUpperCase() ?? '';
  const usable = typed.length === 7 && [...typed].every((c) => c in CHAR_KIND);
  if (usable) {
    return Object.fromEntries(ISO_DAYS.map((d) => [d, CHAR_KIND[typed[d - 1]]])) as Record<number, DayKind>;
  }
  const full = new Set(rule.weeklyPattern ?? []);
  const half = new Set(rule.halfPattern ?? []);
  const off = new Set(rule.offPattern ?? []);
  return Object.fromEntries(
    ISO_DAYS.map((d) => [d, full.has(d) ? 'full' : half.has(d) ? 'half' : off.has(d) ? 'off' : 'rest']),
  ) as Record<number, DayKind>;
}

/** "09:00:00" → "09:00". The DB stores `time`, which round-trips with seconds nobody reads. */
const hhmm = (v: string | null | undefined) => (v ? v.slice(0, 5) : '—');

export async function ScheduleGroupSections({
  s,
  rule,
  rules,
  mode,
  error,
  section,
  typedWeek,
}: {
  s: SessionContext;
  rule: AttendanceRuleView;
  /** Every group in the tenant — the "Shifts allowed" editor names the group a shift would be taken FROM. */
  rules: readonly AttendanceRuleView[];
  mode: ScheduleSectionMode;
  error?: string;
  /** Which section a refusal belongs to, already resolved by VALUE against SCHEDULE_SECTION_KEYS. */
  section?: ScheduleSectionKey | null;
  typedWeek?: string;
}) {
  const t = await getTranslations('admin.scheduleConfig');
  const tr = await getTranslations('admin.attendanceRule');
  const tp = await getTranslations('admin.attendancePolicy');
  const trs = await getTranslations('roster');

  const rotationT = await getTranslations('admin.rotation');
  const editing = mode === 'edit';
  const shifts = await listShiftsForTenant(s, { includeArchived: true });
  const rotationState = await getScheduleRotation(s, rule.id);
  const kinds = dayKindsOf(rule, typedWeek);
  const declaresWeek = ISO_DAYS.some((d) => kinds[d] !== 'rest');
  // r429 (f6819e19) · D7 — "Shifts in this group" (shift.rule_id = group; for Standard, rule_id NULL on
  // every shift that never joined one — this filter already reads that correctly, nothing special-cased).
  const groupShifts = shifts.filter((sh) => sh.ruleId === rule.id);
  const groupEmploymentCount = await countEmploymentsInRule(s, rule.id);

  /** A refusal is shown INSIDE the section it belongs to, and nowhere else, so it is never printed twice. */
  const bannerFor = (key: ScheduleSectionKey) => (section === key ? error : undefined);
  /** An error with no section, or one naming a section that renders no banner, still has to be readable
   *  somewhere — a refusal that lands on a page and is never printed is worse than an ugly one. */
  const BANNERED: readonly ScheduleSectionKey[] = ['general', 'overtime', 'attendance', 'workingDay'];
  const orphanError = error && (section == null || !BANNERED.includes(section)) ? error : undefined;

  const SECTION_LABEL: Record<ScheduleSectionKey, string> = {
    general: t('sectionGeneral'),
    holiday: t('sectionHoliday'),
    overtime: t('sectionOvertime'),
    attendance: t('sectionAttendance'),
    request: t('sectionRequest'),
    notification: t('sectionNotification'),
    workingDay: t('sectionWorkingDay'),
  };

  /** The Schedule Group's own identity + ladder — rules/rule-form.tsx, or a read-only mirror of it. */
  const general = editing ? (
    <RuleForm
      rule={rule}
      hideAllowedShifts
      shifts={ruleShiftChoices(shifts, rules, rule.id)}
      error={bannerFor('general')}
      /* No Cancel: the page header's Back already is the way out that writes nothing, and a "Cancel"
         beside one of four Saves would read as "cancel the whole page". */
      cancel={null}
    />
  ) : (
    <>
      <ErrorBanner message={bannerFor('general')} />
      <Card>
        <SectionHeader title={SECTION_LABEL.general} subtitle={t('generalViewHint')} />
        <dl className="divide-y divide-border">
          <div className="flex items-start justify-between gap-4 px-4 py-3">
            <dt className="text-sm font-medium">{tr('colName')}</dt>
            <dd className="text-right text-sm">
              {rule.name}
              {rule.isDefault && (
                <span className="ml-2 align-middle">
                  <Badge>{tr('defaultBadge')}</Badge>
                </span>
              )}
            </dd>
          </div>
          <div className="flex items-start justify-between gap-4 px-4 py-3">
            <dt className="text-sm font-medium">{tr('colDescription')}</dt>
            <dd className="text-right text-sm text-muted-foreground">{rule.description ?? '—'}</dd>
          </div>
          <div className="flex items-start justify-between gap-4 px-4 py-3">
            <dt className="text-sm font-medium">{tr('colStatus')}</dt>
            <dd className="text-right text-sm">
              {rule.status === 'active' ? tr('statusActive') : tr('statusInactive')}
            </dd>
          </div>
          {/* The deduction switch is NOT repeated here. It is rendered once per page, read-only, in the
              Attendance section below — the place it has been shown since r277 and the place whose note
              explains why it cannot be typed. Two readouts of one money-adjacent switch on one screen is
              how two readouts start disagreeing. */}
        </dl>
      </Card>

      <Card>
        <SectionHeader
          title={tr('shiftsAllowedTitle')}
          count={shifts.filter((sh) => sh.ruleId === rule.id).length}
          subtitle={tr('shiftsAllowedHint')}
        />
        {shifts.filter((sh) => sh.ruleId === rule.id).length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">{tr('shiftsAllowedEmpty')}</p>
        ) : (
          <ul className="divide-y divide-border">
            {shifts
              .filter((sh) => sh.ruleId === rule.id)
              .map((sh) => (
                <li key={sh.id} className="flex items-center justify-between gap-4 px-4 py-2 text-sm">
                  <Link href={`/admin/attendance/${sh.id}`} className="text-primary hover:underline">
                    {sh.name}
                  </Link>
                  <span className="whitespace-nowrap text-muted-foreground">
                    {sh.code ? `${sh.code} · ` : ''}
                    {hhmm(sh.startTime)}–{hhmm(sh.endTime)}
                  </span>
                </li>
              ))}
          </ul>
        )}
      </Card>

      {/* The overtime LADDER — boundaries, pattern and both rates. Read-only here because it is money and
          carries the continuous-ladder validation; it is edited in the form on Edit Schedule. */}
      <Card>
        <SectionHeader title={tr('otSectionTitle')} count={rule.otRows.length} />
        {rule.otRows.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">{t('otRoundingEmpty')}</p>
        ) : (
          <div className={tableWrapCls}>
            <table className="w-full text-sm">
              <thead className={theadCls}>
                <tr>
                  <th className={thCls}>{t('colBand')}</th>
                  <th className={thCls}>{tr('otColPattern')}</th>
                  <th className={thCls}>{tr('otColRate')}</th>
                  <th className={thCls}>{tr('otColPhRate')}</th>
                </tr>
              </thead>
              <tbody className={tbodyCls}>
                {rule.otRows.map((row) => (
                  <tr key={row.id}>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {/* A band whose "To" is at or below its "From" is OPEN-ENDED (db/schema.ts), which is
                          a different sentence from a range and must read as one. */}
                      {row.toMinutes <= row.fromMinutes
                        ? t('bandOpenEnded', { from: row.fromMinutes })
                        : t('bandRange', { from: row.fromMinutes, to: row.toMinutes })}
                    </td>
                    <td className="px-3 py-2">
                      {row.ratePattern === 'flat' ? tr('otPatternFlat') : tr('otPatternVariable')}
                    </td>
                    <td className="px-3 py-2">{row.rate == null ? tr('otRateUnset') : Number(row.rate).toFixed(1)}</td>
                    <td className="px-3 py-2">
                      {row.phRate == null ? tr('otPhRateNone') : Number(row.phRate).toFixed(1)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );

  /**
   * ─── WORKING DAY / SCHEDULE PATTERN — the seventh section, and the only NEW one ─────────────────────
   *
   * 07ebd04d (r331, migration 0483) put the four-way weekly row on `attendance_rule`; until this screen
   * nothing read or wrote it. THE GROUP SAYS WHICH DAYS ARE WORKED; THE SHIFT SAYS WHAT HOURS.
   *
   * ⚠️ AN ALL-REST WEEK IS A FIRST-CLASS VALUE AND MEANS "THIS GROUP DECLARES NO WEEK". It is what every
   * row written before 0483 holds, and what the tenant's un-deletable Standard group MUST keep holding:
   * it is the fallback for every shift whose `rule_id` is NULL, so a week on it would be imposed on every
   * ungrouped shift in the tenant (core/week-pattern.ts `weekPatternFor`, which resolves group-first and
   * deliberately does NOT let a group with no working day win). The section SAYS that in words rather
   * than showing seven "Rest" dropdowns and letting the reader guess.
   *
   * REST IS DERIVED, NEVER STORED: a weekday in none of the three arrays is a Rest day, exactly as on
   * `shift`. There is no fourth column.
   */
  // r429 (f6819e19) · D7 — the group's week, resolved as `ScheduleGroupWeekEditor` resolves it, for the
  // VIEW page's read-only "Shifts in this group" list (no live selects there, so no "after" column).
  const tomorrow = new Date(Date.parse(`${todayInKualaLumpur()}T00:00:00Z`) + 86_400_000).toISOString().slice(0,10);
  const latest = rotationState.versions.reduce<(typeof rotationState.versions)[number] | null>((a,b)=>!a||b.effectiveFrom>a.effectiveFrom?b:a,null);
  const minimumDate = latest && latest.effectiveFrom >= tomorrow
    ? new Date(Date.parse(`${latest.effectiveFrom}T00:00:00Z`)+86_400_000).toISOString().slice(0,10) : tomorrow;
  const monday = new Date(Date.parse(`${minimumDate}T00:00:00Z`));
  monday.setUTCDate(monday.getUTCDate()-((monday.getUTCDay()+6)%7));
  const initialRotation: RotationCycle = latest ? { effectiveFrom: editing ? minimumDate : latest.effectiveFrom,
    anchorDate: latest.anchorDate, unit: latest.unit, length: latest.length, days: latest.days }
    : { effectiveFrom: minimumDate, anchorDate: monday.toISOString().slice(0,10), unit:'week',length:1,
      days:ISO_DAYS.map(d=>({kind:kinds[d],shiftId:kinds[d]==='full'||kinds[d]==='half'?groupShifts.find(sh=>!sh.archivedAt)?.id??null:null})) };
  const workingDay = <>
    <ErrorBanner message={bannerFor('workingDay')} />
    <Card><SectionHeader title={SECTION_LABEL.workingDay} subtitle={rotationT('title')}/>
      {rule.isDefault ? <p className="p-4 text-sm text-muted-foreground">{rotationT('standard')}</p>
      : <ScheduleRotationEditor key={rotationState.revision} ruleId={rule.id} revision={rotationState.revision}
          minimumDate={minimumDate} initial={initialRotation} editing={editing}
          shifts={shifts.map(sh=>{const input={start:sh.startTime,end:sh.endTime,crosses:sh.crossesMidnight,
            breakMinutes:sh.breakMinutes,roundingMinutes:sh.normalHoursRoundingMinutes,normalMinutesOverride:sh.normalMinutesOverride};
            const full=workingShiftSchedule(input,'full'),half=workingShiftSchedule(input,'half');
            return {id:sh.id,name:sh.name,code:sh.code,startTime:sh.startTime,endTime:full.shiftEnd,
              fullMinutes:full.normalMinutes,halfMinutes:half.normalMinutes,halfEnd:half.shiftEnd,
              archived:!!sh.archivedAt,available:!sh.archivedAt&&(!sh.ruleId||sh.ruleId===rule.id),selected:sh.ruleId===rule.id};})}/>
      }
      {!latest && <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">{rotationT('legacy')}</p>}
      {latest && <details className="border-t border-border px-4 py-3 text-sm"><summary>{rotationT('versions')}</summary>
        <ul className="mt-2 space-y-1">{rotationState.versions.map(v=><li key={v.id}>{v.effectiveFrom} · {v.unit==='week'?rotationT('week'):rotationT('day')} × {v.length} · {rotationT('anchor')}: {v.anchorDate}</li>)}</ul>
      </details>}
    </Card>
  </>;

  /**
   * e5ff7189 stage 1 — THE ATTENDANCE SECTION: the four settings the reporter asked for, which already exist.
   *
   * ⚠️ THE WORDING OF THE DEDUCTION CARD IS LOAD-BEARING AND IS NOT A STYLE CHOICE. `late_deduct_minutes`
   * and `early_out_deduct_minutes` are derived in core/attendance.ts and STORED on the attendance row, and
   * nothing in core/payroll.ts or core/pay-components.ts reads either of them — grepped, not assumed. So
   * this screen must never call them a deduction FROM PAY: it says the minutes are RECORDED, and the note
   * at the foot of the card says in plain words that no payslip is reduced by them. Describing them as
   * money would be the screen asserting a behaviour the system deliberately has not built.
   */
  const graceRow = (label: string, afterName: string, afterValue: number, recName: string, recValue: number) => (
    <tr>
      <td className="px-3 py-2">{label}</td>
      <td className="px-3 py-2">
        {editing ? (
          <input
            type="number"
            min={0}
            name={afterName}
            defaultValue={afterValue}
            aria-label={`${label} — ${t('colAfter')}`}
            className={inputCls}
          />
        ) : (
          t('minutes', { n: afterValue })
        )}
      </td>
      <td className="px-3 py-2">
        {editing ? (
          <input
            type="number"
            min={0}
            name={recName}
            defaultValue={recValue}
            aria-label={`${label} — ${t('colRecorded')}`}
            className={inputCls}
          />
        ) : (
          t('minutes', { n: recValue })
        )}
      </td>
    </tr>
  );

  const attendanceBody = (
    <>
      <Card>
        <SectionHeader title={t('graceTitle')} subtitle={t('graceHint', { group: rule.name })} />
        <div className="grid gap-3 p-4 sm:grid-cols-2">
          <Field label={t('graceLate')}>
            {editing ? (
              <input
                type="number"
                min={0}
                name="lateGracePeriodMinutes"
                defaultValue={rule.lateGracePeriodMinutes}
                className={inputCls}
              />
            ) : (
              <p className="text-sm">{t('minutes', { n: rule.lateGracePeriodMinutes })}</p>
            )}
          </Field>
          <Field label={t('graceEarly')}>
            {editing ? (
              <input
                type="number"
                min={0}
                name="earlyGracePeriodMinutes"
                defaultValue={rule.earlyGracePeriodMinutes}
                className={inputCls}
              />
            ) : (
              <p className="text-sm">{t('minutes', { n: rule.earlyGracePeriodMinutes })}</p>
            )}
          </Field>
        </div>
      </Card>

      <Card>
        <SectionHeader title={t('recordRulesTitle')} subtitle={t('recordRulesHint')} />
        <div className={tableWrapCls}>
          <table className="w-full text-sm">
            <thead className={theadCls}>
              <tr>
                <th className={thCls}>{t('colRule')}</th>
                <th className={thCls}>{t('colAfter')}</th>
                <th className={thCls}>{t('colRecorded')}</th>
              </tr>
            </thead>
            <tbody className={tbodyCls}>
              {graceRow(t('ruleLate'), 'lateAfterMinutes', rule.lateAfterMinutes, 'lateDeductMinutes', rule.lateDeductMinutes)}
              {graceRow(
                t('ruleEarly'),
                'earlyAfterMinutes',
                rule.earlyAfterMinutes,
                'earlyDeductMinutes',
                rule.earlyDeductMinutes,
              )}
            </tbody>
          </table>
        </div>
        <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">{t('notPayNote')}</p>
        {editing && (
          <div className="flex items-center gap-3 border-t border-border px-4 py-3">
            <button className={btnPrimary}>{tr('save')}</button>
          </div>
        )}
      </Card>
    </>
  );

  const attendance = (
    <>
      <ErrorBanner message={bannerFor('attendance')} />
      {editing ? (
        <form action={saveScheduleGroupAttendanceAction} className="space-y-6">
          <input type="hidden" name="ruleId" value={rule.id} />
          {attendanceBody}
        </form>
      ) : (
        <div className="space-y-6">{attendanceBody}</div>
      )}

      {/* ⚠️ THE ONE SETTING THAT DID NOT MOVE, AND IT IS READ-ONLY HERE ON PURPOSE.
          `apply_deductions` + `deductions_effective_from` (7c834696 stage 1, migration 0394): the
          effective-from date is STAMPED BY THE SERVICE the moment the switch flips and can never be typed,
          and a DB CHECK makes "deductions on with no start date" unrepresentable. Together that is what
          stops a deduction reaching a payroll month that is already closed. A second form over this switch
          would be a second way to get that date wrong, so it stays on the General section and this card
          shows it and says where it is edited. DO NOT "finish" this section by adding a checkbox here. */}
      <Card>
        <SectionHeader title={tr('deductionsSectionTitle')} />
        <dl className="divide-y divide-border">
          <div className="flex items-center justify-between px-4 py-3">
            <dt className="text-sm font-medium">{t('recordSwitchLabel')}</dt>
            <dd className="text-sm text-foreground">
              {rule.applyDeductions ? t('settingOn') : t('settingOff')}
              {rule.applyDeductions && rule.deductionsEffectiveFrom && (
                <span className="ml-2 text-xs text-muted-foreground">
                  {t('recordSwitchFrom', { date: rule.deductionsEffectiveFrom })}
                </span>
              )}
            </dd>
          </div>
        </dl>
        <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">{t('deductionsHere')}</p>
      </Card>
    </>
  );

  /**
   * d91aee93 stage 1 — THE OVERTIME SECTION: the settings the reporter asked for that already exist, and
   * the per-band rounding is FINER than what they asked for, not coarser — they asked for one rounding
   * method and one step for the whole group; each band has carried its own since migration 0439.
   *
   * The Overtime Pattern is NOT a field here, and that is the 870b79e2 answer restated: the Overtime
   * Pattern IS the Schedule Group. It is the thing these settings belong to — which, since 665de026, is
   * the PAGE, not a dropdown inside it and not a picker above it.
   *
   * The band BOUNDARIES and the RATES are not edited here. They are the overtime ladder, they carry a
   * continuous-ladder validation, and the rate is money; they belong to the General section's form. The
   * action rebuilds the band table from the STORED rows and overlays rounding matched by the band's
   * "From" boundary, so nothing here can move a boundary or a rate.
   */
  const overtimeBody = (
    <>
      <Card>
        <SectionHeader title={t('otEarlyTitle')} subtitle={t('otEarlyHint')} />
        <div className="px-4 py-3">
          {editing ? (
            <label className="flex cursor-pointer items-center gap-2 text-sm has-[:checked]:text-primary">
              <input
                type="checkbox"
                name="applyToEarlyOt"
                defaultChecked={rule.applyToEarlyOt}
                className="h-3.5 w-3.5 accent-primary"
              />
              {t('otEarlyLabel')}
            </label>
          ) : (
            <p className="text-sm">
              {t('otEarlyLabel')} — {rule.applyToEarlyOt ? t('settingOn') : t('settingOff')}
            </p>
          )}
        </div>
      </Card>

      <Card>
        <SectionHeader title={t('otRoundingTitle')} count={rule.otRows.length} subtitle={t('otRoundingHint')} />
        {rule.otRows.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">{t('otRoundingEmpty')}</p>
        ) : (
          <div className={tableWrapCls}>
            <table className="w-full text-sm">
              <thead className={theadCls}>
                <tr>
                  <th className={thCls}>{t('colBand')}</th>
                  <th className={thCls}>{t('colRoundingMode')}</th>
                  <th className={thCls}>{t('colRoundTo')}</th>
                </tr>
              </thead>
              <tbody className={tbodyCls}>
                {rule.otRows.map((row) => (
                  <tr key={row.id}>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {row.toMinutes <= row.fromMinutes
                        ? t('bandOpenEnded', { from: row.fromMinutes })
                        : t('bandRange', { from: row.fromMinutes, to: row.toMinutes })}
                    </td>
                    <td className="px-3 py-2">
                      {/* ⚠️ KEYED ON THE BAND'S "FROM" BOUNDARY — not on its position, and NOT on `row.id`.
                          `updateAttendanceRule` replaces the band table wholesale, so every row id changes
                          on every save of this rule; an id-keyed field silently stops matching after any
                          save made since this page was rendered, and the rounding edit would be discarded
                          without a word. The "From" boundary is unique per rule (the continuous-ladder
                          validation guarantees it) and survives the re-insert. See ./actions.ts. */}
                      {editing ? (
                        <select
                          name={`roundingMode_${row.fromMinutes}`}
                          defaultValue={row.roundingMode}
                          aria-label={t('colRoundingMode')}
                          className={inputCls}
                        >
                          <option value="none">{tr('roundingModeNone')}</option>
                          <option value="down">{tr('roundingModeDown')}</option>
                          <option value="up">{tr('roundingModeUp')}</option>
                        </select>
                      ) : row.roundingMode === 'down' ? (
                        tr('roundingModeDown')
                      ) : row.roundingMode === 'up' ? (
                        tr('roundingModeUp')
                      ) : (
                        tr('roundingModeNone')
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {editing ? (
                        <input
                          type="number"
                          min={0}
                          name={`roundToMinutes_${row.fromMinutes}`}
                          defaultValue={row.roundToMinutes ?? ''}
                          aria-label={t('colRoundTo')}
                          className={inputCls}
                        />
                      ) : row.roundToMinutes == null ? (
                        '—'
                      ) : (
                        t('minutes', { n: row.roundToMinutes })
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {editing && (
          <div className="flex items-center gap-3 border-t border-border px-4 py-3">
            <button className={btnPrimary}>{tr('save')}</button>
          </div>
        )}
      </Card>
    </>
  );

  const overtime = (
    <>
      <ErrorBanner message={bannerFor('overtime')} />
      {editing ? (
        <form action={saveScheduleGroupOvertimeAction} className="space-y-6">
          <input type="hidden" name="ruleId" value={rule.id} />
          {/* ⚠️ THE MARKER, read as a VALUE by the action and never by presence. A browser omits an
              unchecked checkbox, so without this "turned off" and "this form did not carry the control"
              are the same bytes — the trap 7c834696 hit on this exact setting. */}
          <input type="hidden" name="earlyOtEditor" value="1" />
          {overtimeBody}
        </form>
      ) : (
        <div className="space-y-6">{overtimeBody}</div>
      )}
    </>
  );

  /** holiday · request · notification — named, and empty, and they say so. Not placeholders for settings
   *  that exist: each will be defined and built as its own piece of work. */
  const notBuilt = (key: ScheduleSectionKey) => (
    <Card>
      <SectionHeader title={SECTION_LABEL[key]} />
      <p className="p-4 text-sm text-muted-foreground">{t('notBuiltYet')}</p>
    </Card>
  );

  const bodyFor: Record<ScheduleSectionKey, ReactNode> = {
    general,
    holiday: notBuilt('holiday'),
    overtime,
    attendance,
    request: notBuilt('request'),
    notification: notBuilt('notification'),
    workingDay,
  };

  return (
    <div className="space-y-8">
      <ErrorBanner message={orphanError} />
      {/* A jump list, not a tab strip. Every section is rendered and on the page at once — "one Schedule
          Group is one screen" — so these are anchors into what is already there, which is what makes a
          save's `#section-<key>` land somewhere. */}
      <nav aria-label={t('sectionsAria')} className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {SCHEDULE_SECTION_KEYS.map((key) => (
          <a key={key} href={`#${sectionAnchor(key)}`} className="text-primary hover:underline">
            {SECTION_LABEL[key]}
          </a>
        ))}
      </nav>
      {SCHEDULE_SECTION_KEYS.map((key) => (
        <section key={key} id={sectionAnchor(key)} className="scroll-mt-6 space-y-6">
          {bodyFor[key]}
        </section>
      ))}
      {mode === 'view' && (
        <div className="flex items-center gap-3">
          <Link href={scheduleGroupEditPath(rule.id)} className={btnPrimary}>
            {t('groupLink')}
          </Link>
        </div>
      )}
    </div>
  );
}
