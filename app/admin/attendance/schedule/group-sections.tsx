import { scheduleGroupControls } from '@/core/schedule-group-controls';
import { saveScheduleGroupControlAction } from './actions';
import { ScheduleGroupTabs } from '@/components/schedule-group-tabs';
import { ScheduleDraftShiftPicker } from '@/components/schedule-shift-picker';
import { ScheduleClockFields, type ScheduleClockSettings } from '@/components/schedule-clock-fields';
import type { ReactNode } from 'react';
import { AttendanceSettingsActionForm, AttendanceSettingsSaveButton } from '@/components/attendance-settings-action-form';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { SessionContext } from '@/db/client';
import type { AttendanceRuleView } from '@/core/attendance-rule';
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
import { WageDeductionsCard } from '@/components/schedule-wage-deductions';
import {
  type ScheduleSectionKey,
} from './sections';
import { scheduleGroupEditPath } from '../../attendance-policy/schedule-panel';
import {
  saveScheduleGroupAttendanceAction,
  saveScheduleGroupAllowedShiftsAction,
  saveScheduleGroupWeekAction,
} from './actions';
import { AttendanceSettingsNavigation } from '@/components/attendance-settings-navigation';
import { ScheduleRotationEditor, StepMark } from '@/components/schedule-rotation-editor';
import { getScheduleRotation, legacyOvertimePatternIdForRule, workingShiftSchedule } from '@/packs/attendance/service';
import { todayInKualaLumpur } from '@/lib/hr-date';
import {rotationMethodOf,rotationVersionOn,type RotationCycle} from '@/core/week-pattern';

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
 * THREE render something and are the tabs: general, attendance, overtime. c03670cc retired the separate
 * Duty Roster (workingDay) tab: its switch and rotation sit in General directly under Shift Allowed, and an
 * old `?section=workingDay` link resolves to General. Holiday, request and notification are named and empty.
 *
 * DO NOT "finish" this screen by drawing a control for a setting nothing stores. The list page's header
 * names the remaining gaps (the duty-roster controls, the day-type
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
/** The four-way row, exactly as `shift` carries it since migration 0429 and `attendance_rule` since 0483. */
const DAY_KINDS = ['full', 'half', 'off', 'rest'] as const;
type DayKind = (typeof DAY_KINDS)[number];
/** The compact echo `failScheduleGroup` carries back, one character per weekday. See ./actions.ts weekParam. */
const CHAR_KIND: Record<string, DayKind> = { F: 'full', H: 'half', O: 'off', R: 'rest' };
const METHOD_LABEL = { workingWeek: 'methodWorkingWeek', weeklyPattern: 'methodWeekly', dailyPattern: 'methodDaily' } as const;

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
  mode,
  error,
  section,
  typedWeek,
  savedSection,
  savedReceipt,
  clockCompanies = {canUseAll:false,group:[],companies:[]},
  canEditShared = true,
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
  savedSection?: ScheduleSectionKey | null;
  savedReceipt?: string;
  clockCompanies?: ScheduleClockSettings;
  canEditShared?: boolean;
}) {
  const t = await getTranslations('admin.scheduleConfig');
  const otWorkspace = await getTranslations('overtimePatterns');
  const tr = await getTranslations('admin.attendanceRule');
  const te = await getTranslations('scheduleGroupEditor');

  const rotationT = await getTranslations('admin.rotation');
  const editing = mode === 'edit';
  const today=todayInKualaLumpur();
  const tb=await getTranslations('boardSchedule');
  const controls=await scheduleGroupControls(s,rule.id);
  const pendingException=controls.revisions.reduce<typeof controls.revisions[number]|null>((a,b)=>!a||b.effectiveFrom>a.effectiveFrom?b:a,null);
  // 2f803985 — Enable Exception is the one remaining group control panel. Duty Roster Control has no switch
  // of its own any more: it follows the saved Working Day / Schedule Pattern (core/attendance-rotation.ts).
  const controlPanel=()=><Card className="space-y-3 p-4"><h3 className="text-sm font-semibold">{tb('exception')}</h3><p className="text-xs text-muted-foreground">{tb('exceptionHint')}</p>{editing?<AttendanceSettingsActionForm submitAction={saveScheduleGroupControlAction} data-schedule-control="exception" data-attendance-save-scope="" data-attendance-saved-receipt={savedReceipt} className="space-y-3"><input type="hidden" name="ruleId" value={rule.id}/><input type="hidden" name="kind" value="exception"/><label className="flex items-center gap-2 text-sm"><input type="checkbox" name="enabled" value="1" defaultChecked={pendingException?.enabled??false} className="accent-primary"/>{tb('exception')}</label><AttendanceSettingsSaveButton className={btnPrimary}>{tr('save')}</AttendanceSettingsSaveButton></AttendanceSettingsActionForm>:<p className="text-sm">{(pendingException?.enabled??false)?tb('on'):tb('off')}</p>}<ul className="space-y-1 text-xs text-muted-foreground">{controls.revisions.map(r=><li key={r.id}>{r.effectiveFrom} · {r.enabled?tb('on'):tb('off')}</li>)}</ul></Card>;
  const shifts = await listShiftsForTenant(s, { includeArchived: true });
  const rotationState = await getScheduleRotation(s, rule.id);
  const legacyPatternId = await legacyOvertimePatternIdForRule(s, rule.id);
  const kinds = dayKindsOf(rule, typedWeek);
  const currentRotation=rotationVersionOn(rotationState.versions,today);
  const latest=rotationState.versions.at(-1);
  const membershipIds=new Set(currentRotation?.allowedShiftIds??rotationState.memberships.map(m=>m.shiftId));
  const groupShifts=shifts.filter(shift=>membershipIds.has(shift.id));
  const draftPool=editing?(latest?.allowedShiftIds??[...membershipIds]):[...membershipIds];
  const availableShifts=shifts.map(sh=>({id:sh.id,name:sh.name,code:sh.code,archived:!!sh.archivedAt,available:!sh.archivedAt}));

  /** A refusal is shown INSIDE the section it belongs to, and nowhere else, so it is never printed twice. */
  const bannerFor = (key: ScheduleSectionKey) => (section === key ? error : undefined);
  /** An error with no section, or one naming a section that renders no banner, still has to be readable
   *  somewhere — a refusal that lands on a page and is never printed is worse than an ugly one. */
  const BANNERED: readonly ScheduleSectionKey[] = ['general', 'overtime', 'attendance'];
  const orphanError = error && (section == null || !BANNERED.includes(section)) ? error : undefined;

  const SECTION_LABEL: Record<ScheduleSectionKey, string> = {
    general: t('sectionGeneral'),
    holiday: t('sectionHoliday'),
    overtime: t('sectionOvertime'),
    attendance: t('sectionAttendance'),
    request: t('sectionRequest'),
    notification: t('sectionNotification'),
  };

  /** The Schedule Group's own identity + ladder — rules/rule-form.tsx, or a read-only mirror of it. */
  const identity = editing ? (
    <RuleForm
      rule={rule}
      hideAllowedShifts
      generalOnly
      saveScope
      savedReceipt={savedSection === 'general' ? savedReceipt : undefined}
      shifts={[]}
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
            <dt className="text-sm font-medium">{tb('groupName')}</dt>
            <dd className="text-right text-sm">
              {rule.name}
              {rule.isDefault && (
                <span className="ml-2 align-middle">
                  <Badge>{tr('defaultBadge')}</Badge>
                </span>
              )}
            </dd>
          </div>
          <div className="flex items-start justify-between gap-4 px-4 py-3"><dt className="text-sm font-medium">{tb('groupLabel')}</dt><dd className="text-sm">{rule.label?.trim()||rule.name}</dd></div>
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
          {/* c03670cc — Wage Deductions is shown (and, on Edit, set) once per page: in the Attendance
              section. Two readouts of one money-adjacent switch on one screen is how they start disagreeing. */}
        </dl>
      </Card>

    </>
  );

  // 2f803985 — ONE section, Working Day / Schedule Pattern, in three steps. Step 1 is Shift Allowed; Steps
  // 2 and 3 are the dated rotation (Working Week = week × 1, Weekly Pattern = week × N, Daily Pattern =
  // day × N), so every method shares one pool and one Day Type + Shift table. The separate Duty Roster
  // block and its switch are gone: saving a pattern also turns on Duty Roster Control for the group
  // (core/attendance-rotation.ts), so a rotation version present means roster-controlled.
  const stepOne = <div className="space-y-3" data-schedule-step="1">
    <h4 className="flex items-center gap-2 text-sm font-medium"><StepMark n={1}/>{te('shiftAllowed')}</h4>
    {editing && canEditShared ? <>
      <p className="text-sm text-muted-foreground">{te('shiftHelp')}</p>
      {latest
        ? <><p className="text-sm text-muted-foreground">{te('rotationPoolSave',{date:latest.effectiveFrom})}</p>
          <ScheduleDraftShiftPicker shifts={availableShifts}/></>
        : <AttendanceSettingsActionForm submitAction={saveScheduleGroupAllowedShiftsAction}
            data-attendance-save-scope="" data-schedule-control="shift-pool" data-attendance-saved-receipt={savedSection==='general'?savedReceipt:undefined}
            className="space-y-3">
            <input type="hidden" name="ruleId" value={rule.id}/>
            <input type="hidden" name="allowedShiftsEditor" value="1"/>
            <ScheduleDraftShiftPicker base shifts={availableShifts}/>
            <AttendanceSettingsSaveButton className={btnPrimary}>{te('saveShiftPool')}</AttendanceSettingsSaveButton>
          </AttendanceSettingsActionForm>}
    </> : <>
      <p className="text-xs text-muted-foreground">{rotationT('poolHint')}</p>
      {groupShifts.length === 0 ? (
        <p className="text-sm text-muted-foreground">{tr('shiftsAllowedEmpty')}</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border" aria-label={te('shiftAllowed')}>
          {shifts
            .filter((sh) => membershipIds.has(sh.id))
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
    </>}
  </div>;
  // Legacy groups retain their weekly pattern until a future-dated cycle is saved.
  // The immutable version owns both its allowed pool and every day of the cycle.
  const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0,10);
  const minimumDate = latest && latest.effectiveFrom >= tomorrow
    ? new Date(Date.parse(`${latest.effectiveFrom}T00:00:00Z`)+86_400_000).toISOString().slice(0,10) : tomorrow;
  const monday = new Date(Date.parse(`${minimumDate}T00:00:00Z`));
  monday.setUTCDate(monday.getUTCDate()-((monday.getUTCDay()+6)%7));
  // A group with no saved version shows its legacy week as a Working Week (week × 1). Nothing is written
  // until an administrator saves a dated version (ADR-0105: no backfill).
  const initialRotation: RotationCycle = latest ? { effectiveFrom: editing ? minimumDate : latest.effectiveFrom,
    anchorDate: latest.anchorDate, unit: latest.unit, length: latest.length, days: latest.days }
    : { effectiveFrom: minimumDate, anchorDate: monday.toISOString().slice(0,10), unit:'week',length:1,
      days:ISO_DAYS.map(d=>({kind:kinds[d],shiftId:kinds[d]==='full'||kinds[d]==='half'?groupShifts.find(sh=>!sh.archivedAt)?.id??null:null})) };
  /** The Standard group cannot rotate (saveScheduleRotation refuses it): it offers Working Week only and
   *  saves its Day Types through the legacy week writer, as before. Each employee keeps their own shift. */
  const standardWeek = <div className="space-y-3 p-4" data-schedule-standard-week="">
    <p className="flex items-center gap-2 text-sm font-medium"><StepMark n={2}/>{rotationT('basedOn')} · {rotationT('methodWorkingWeek')}</p>
    <p className="text-xs text-muted-foreground">{rotationT('standardWeekHint')}</p>
    <p className="flex items-center gap-2 text-sm font-medium"><StepMark n={3}/>{rotationT('stepDays')}</p>
    <div className={tableWrapCls}><table className="w-full text-sm">
      <thead className={theadCls}><tr><th className={thCls}>{rotationT('position')}</th><th className={thCls}>{rotationT('dayType')}</th><th className={thCls}>{rotationT('shift')}</th></tr></thead>
      <tbody className={tbodyCls}>{ISO_DAYS.map(day=><tr key={day}>
        <td className="px-3 py-2">{rotationT(`weekday${day}`)}</td>
        <td className="px-3 py-2">{editing&&canEditShared
          ? <select name={`dayKind_${day}`} defaultValue={kinds[day]} aria-label={`${rotationT('dayType')} ${rotationT(`weekday${day}`)}`} className={inputCls}>
              {DAY_KINDS.map(kind=><option key={kind} value={kind}>{rotationT(kind)}</option>)}</select>
          : rotationT(kinds[day])}</td>
        <td className="px-3 py-2 text-muted-foreground">{kinds[day]==='full'||kinds[day]==='half'?rotationT('shiftFromEmployee'):rotationT('notRequired')}</td>
      </tr>)}</tbody>
    </table></div>
    {editing&&canEditShared&&<AttendanceSettingsSaveButton className={btnPrimary}>{rotationT('saveWeek')}</AttendanceSettingsSaveButton>}
  </div>;
  const pattern = rule.isDefault
    ? (editing&&canEditShared
      ? <AttendanceSettingsActionForm submitAction={saveScheduleGroupWeekAction} data-attendance-save-scope=""
          data-attendance-saved-receipt={savedSection==='general'?savedReceipt:undefined}>
          <input type="hidden" name="ruleId" value={rule.id}/><input type="hidden" name="weekEditor" value="1"/>{standardWeek}
        </AttendanceSettingsActionForm>
      : standardWeek)
    : <ScheduleRotationEditor ruleId={rule.id} revision={rotationState.revision}
        minimumDate={minimumDate} initial={initialRotation} editing={editing&&canEditShared} poolInGeneral useSavedPool={!latest}
        shifts={shifts.map(sh=>{const input={type:sh.type,start:sh.startTime,end:sh.endTime,crosses:sh.crossesMidnight,
          breakMinutes:sh.breakMinutes,roundingMinutes:sh.normalHoursRoundingMinutes,normalMinutesOverride:sh.normalMinutesOverride};
          const full=workingShiftSchedule(input,'full'),half=workingShiftSchedule(input,'half');
          return {id:sh.id,name:sh.name,code:sh.code,startTime:sh.startTime,endTime:full.shiftEnd,
            fullMinutes:full.normalMinutes,halfMinutes:half.normalMinutes,halfEnd:half.shiftEnd,
            archived:!!sh.archivedAt,available:!sh.archivedAt,selected:latest?latest.allowedShiftIds.includes(sh.id):membershipIds.has(sh.id)};})}/>;
  const workingPattern = <Card data-schedule-working-pattern="">
    <SectionHeader title={t('sectionWorkingDay')} subtitle={currentRotation
      ? te('currentRotation',{days:currentRotation.days.length,date:currentRotation.effectiveFrom}) : undefined}/>
    <div className="space-y-4 p-4 pb-0">{stepOne}</div>
    {rule.isDefault&&editing&&<AttendanceSettingsNavigation/>}
    {pattern}
    {!rule.isDefault && !latest && <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">{rotationT('legacy')}</p>}
    {latest && <details className="border-t border-border px-4 py-3 text-sm"><summary>{rotationT('versions')}</summary>
      <ul className="mt-2 space-y-1">{rotationState.versions.map(v=><li key={v.id}>{v.effectiveFrom} · {rotationT(METHOD_LABEL[rotationMethodOf(v)])}{v.unit==='week'&&v.length===1?'':` × ${v.length}`} · {rotationT('anchor')}: {v.anchorDate}</li>)}</ul>
    </details>}
  </Card>;

  const general = <>
    {identity}
    {workingPattern}
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
      <ScheduleClockFields settings={clockCompanies} editing={editing}
        grace={<div className="space-y-3">
        <h3 className="font-semibold">{t('graceTitle')}</h3>
        <Field label={te('lateGrace')}>{editing ? <input type="number" min={0} name="lateGracePeriodMinutes"
          defaultValue={rule.lateGracePeriodMinutes} className={inputCls}/> : <p className="text-sm">{t('minutes',{n:rule.lateGracePeriodMinutes})}</p>}</Field>
        <Field label={te('earlyGrace')}>{editing ? <input type="number" min={0} name="earlyGracePeriodMinutes"
          defaultValue={rule.earlyGracePeriodMinutes} className={inputCls}/> : <p className="text-sm">{t('minutes',{n:rule.earlyGracePeriodMinutes})}</p>}</Field>
      </div>}/>

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
        <div className="space-y-2 border-t border-border px-4 py-3 text-sm">
          {(['includeGraceInLateness','includeGraceInEarlyOut'] as const).map(key=><label key={key} className="flex items-center gap-2">
            {editing?<input type="checkbox" name={key} defaultChecked={rule[key]}/>:<span>{rule[key]?t('settingOn'):t('settingOff')}</span>}
            {tr(key)}
          </label>)}
        </div>
        <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">{t('notPayNote')}</p>
      </Card>
      {/* c03670cc — Wage Deductions moved here from General: the same switch, the same service-stamped
          start date (never typed) and the same deduction rules; this section is now its only writer. */}
      <WageDeductionsCard rule={rule} editing={editing}/>
      {editing && (
        <div className="flex items-center gap-3">
          <AttendanceSettingsSaveButton className={btnPrimary}>{te('saveAttendance')}</AttendanceSettingsSaveButton>
        </div>
      )}
    </>
  );

  const attendance = (
    <>
      {controlPanel()}
      <ErrorBanner message={bannerFor('attendance')} />
      {editing ? (
        <AttendanceSettingsActionForm submitAction={saveScheduleGroupAttendanceAction} data-attendance-save-scope="" data-attendance-saved-receipt={savedSection === 'attendance' ? savedReceipt : undefined} className="space-y-6">
          <input type="hidden" name="ruleId" value={rule.id} />
          <input type="hidden" name="attendanceFlagsEditor" value="1" />
          {attendanceBody}
        </AttendanceSettingsActionForm>
      ) : (
        <div className="space-y-6">{attendanceBody}</div>
      )}

    </>
  );

  /**
   * 2f803985 — THE OVERTIME SECTION after the bands moved. The overtime bands, rates, rounding and early
   * overtime (unchanged UI and writer) now live in Overtime Patterns › 1. General Settings of this group's
   * own legacy pattern; this tab points there. The new Overtime Setting section (before/after shift,
   * approval method, lateness offset, rounding) is released separately, only after Payroll is proven to
   * receive its figures (ADR-0134), so nothing here claims a setting that does not yet reach pay.
   */
  const overtimeHref = legacyPatternId
    ? `/admin/attendance/settings/overtime-patterns?pattern=${legacyPatternId}` : '/admin/attendance/settings/overtime-patterns';
  const overtime = <>
    <ErrorBanner message={bannerFor('overtime')}/>
    <Card className="space-y-3 p-4" data-schedule-overtime-moved="">
      <h3 className="font-semibold">{t('sectionOvertime')}</h3>
      <p className="text-sm">{t('otMovedNote')}{' '}
        <Link href={overtimeHref} className="text-primary hover:underline">{t('otMovedOpen')}</Link></p>
      <p className="text-sm text-muted-foreground">{otWorkspace('legacyContext')}</p>
      <p className="text-xs text-muted-foreground">{t('otSettingPending')}</p>
    </Card>
  </>;

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
  };

  return (
    <div className="space-y-8">
      <ErrorBanner message={orphanError} />
      <ScheduleGroupTabs initial={section ?? savedSection} ariaLabel={t('sectionsAria')} initialPool={editing&&canEditShared?draftPool:undefined}
        tabs={(['general','attendance','overtime'] as const).map(key=>({id:key,label:SECTION_LABEL[key],body:bodyFor[key]}))}/>
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
