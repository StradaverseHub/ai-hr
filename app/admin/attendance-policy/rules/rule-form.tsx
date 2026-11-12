import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { AttendanceSettingsActionForm, AttendanceSettingsSaveButton } from '@/components/attendance-settings-action-form';
import { Card, ErrorBanner, Field, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { ScheduleRotationEditor, StepMark } from '@/components/schedule-rotation-editor';
import { ScheduleOvertimeSettingFields, type ScheduleOvertimeSettingIslandProps } from '@/components/schedule-overtime-setting';
import { ScheduleGroupTabs } from '@/components/schedule-group-tabs';
import { ScheduleDraftShiftPicker } from '@/components/schedule-shift-picker';
import { ScheduleClockFields, type ScheduleClockSettings } from '@/components/schedule-clock-fields';
import { formatOtRate } from '@/lib/ot-rate';
import { WageDeductionsCard } from '@/components/schedule-wage-deductions';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { AttendanceRuleOtEditor, type OtEditorRow } from '@/components/attendance-rule-ot-editor';
import type { AttendanceRuleView } from '@/core/attendance-rule';
import { createAttendanceRuleAction, updateAttendanceRuleAction, saveScheduleGroupGeneralAction } from '../rule-actions';

/**
 * 88e94371 · Add / Edit form for one "Lateness, Early Out & Overtime Settings" rule. Three sections
 * (Lateness, Early Out, Overtime). Server component: it RENDERS the AttendanceRuleOtEditor client island as
 * JSX (never imports+calls it), keeping the RSC boundary clean. Standard (is_default) rules are editable but
 * their name is locked and they can't be deleted.
 *
 * 6da67ab7 — no Company field: a rule belongs to the tenant and reaches employees through the shift that
 * selects it (Shift Settings → Attendance rule).
 */
/**
 * 870b79e2 (r277) — one row of the "Shifts allowed" editor. `otherGroupName` is the rule the shift points
 * at TODAY when that is not this rule; it is shown so an administrator can see, before they tick, that
 * they are moving the shift out of another group rather than adding it to a second one.
 */
export type RuleShiftChoice = {
  id: string;
  name: string;
  code: string | null;
  inThisGroup: boolean;
  otherGroupName: string | null;
  startTime?:string|null; endTime?:string|null; fullMinutes?:number; halfMinutes?:number; halfEnd?:string|null;
};

/**
 * 665de026 (r331) — THIS FORM NO LONGER DRAWS ITS OWN PAGE CHROME, and that is a correction rather than a
 * tidy-up. It used to render a `PageHeader` titled "Edit / New Schedule Group" with a back link to
 * `/admin/attendance-policy`, and a Cancel link to the same address. Both were true when this was its own
 * route (88e94371); r301 mounted it as a PANEL on a page that already had a header, so a second `<h1>` and
 * a back link to a REDIRECT STUB were rendered inside it. Now it is a SECTION of Add Schedule and Edit
 * Schedule, whose titles are the reporter's own words ("Add Schedule" / "Edit Schedule") and whose single
 * Back returns to the list. The page owns the chrome; this form owns the fields.
 *
 * `cancel` is passed explicitly by both call sites rather than defaulted: on Add Schedule it is the way out
 * that writes nothing, and on Edit Schedule there is none, because the page header's Back already is one
 * and a "Cancel" beside a Save on a page with four Saves would read as "cancel the whole page".
 */
export async function RuleForm({
  rule,
  shifts,
  error,
  cancel,
  hideAllowedShifts = false,
  saveScope = false,
  generalOnly = false,
  savedReceipt,
  initialSection,
  clockCompanies = {canUseAll:false,group:[],companies:[]},
  canEditShared = true,
  overtimeSetting,
}: {
  /** 2f803985 — Add Schedule's Overtime tab: the full Overtime Setting section, saved with the group. */
  overtimeSetting?: ScheduleOvertimeSettingIslandProps;
  hideAllowedShifts?: boolean;
  saveScope?: boolean;
  generalOnly?: boolean;
  savedReceipt?: string;
  initialSection?: string | null;
  clockCompanies?: ScheduleClockSettings;
  canEditShared?: boolean;
  rule: AttendanceRuleView | null;
  shifts: readonly RuleShiftChoice[];
  error?: string;
  /** The way out that writes nothing, or null when the page's own Back is it. */
  cancel: { href: string; label: string } | null;
}) {
  const t = await getTranslations('admin.attendanceRule');
  const tb=await getTranslations('boardSchedule');
  const editing = !!rule;
  const isDefault = !!rule?.isDefault;

  const ts=await getTranslations('admin.scheduleConfig');
  const te=await getTranslations('scheduleGroupEditor');
  const tr=await getTranslations('admin.rotation');
  const tomorrow = new Date(Date.parse(todayInKualaLumpur()+'T00:00:00Z')+86_400_000).toISOString().slice(0,10);
  const monday=new Date(tomorrow+"T00:00:00Z");
  monday.setUTCDate(monday.getUTCDate()-((monday.getUTCDay()+6)%7));
  const duty = canEditShared ? <Card data-schedule-create-rotation=""><SectionHeader title={tr('title')}/>
    <p className="px-4 pt-3 text-sm text-muted-foreground">{te('dutyRosterPoolNote')}</p>
    <ScheduleRotationEditor creating editing ruleId="" revision="" minimumDate={tomorrow}
    initial={{effectiveFrom:tomorrow,anchorDate:monday.toISOString().slice(0,10),unit:'week',length:1,days:Array.from({length:7},()=>({kind:'rest',shiftId:null}))}}
    shifts={shifts.map(shift=>({...shift,startTime:shift.startTime??null,endTime:shift.endTime??null,halfEnd:shift.halfEnd??null,
      fullMinutes:shift.fullMinutes??0,halfMinutes:shift.halfMinutes??0,archived:false,available:true,selected:false}))}/>
  </Card> : <Card className="p-4 text-sm text-muted-foreground">{te('createBeforeRotation')}</Card>;
  const general = <>
        <Card className="space-y-4 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={tb('groupName')}>
              <input
                name="name"
                required={editing}
                defaultValue={rule?.name ?? ''}
                readOnly={isDefault}
                className={`${inputCls} ${isDefault ? 'opacity-70' : ''}`}
              />
            </Field>
            <Field label={tb('groupLabel')}><input name="label" defaultValue={rule?.label??''} maxLength={80} className={inputCls}/></Field>
            <Field label={t('status')}>
              <select name="status" defaultValue={rule?.status ?? 'active'} className={inputCls}>
                <option value="active">{t('statusActive')}</option>
                <option value="inactive">{t('statusInactive')}</option>
              </select>
            </Field>
          </div>
          <Field label={t('description')}>
            <input name="description" defaultValue={rule?.description ?? ''} className={inputCls} />
          </Field>
          {isDefault && <p className="text-xs text-muted-foreground">{t('standardNote')}</p>}
        </Card>

        {!hideAllowedShifts && <Card className="space-y-3 p-4">
          {/* 2f803985 (round 2) — no Monday–Sunday dropdowns here: they duplicated the dated rotation below,
              which is the one place Day Type and Shift are set (Step 1 Shift Allowed, then Steps 2 and 3). */}
          <h2 className="font-semibold">{ts('sectionWorkingDay')}</h2>
          <h3 className="flex items-center gap-2 font-semibold" data-schedule-step="1"><StepMark n={1}/>{te('shiftAllowed')}</h3>
          <p className="text-sm text-muted-foreground">{te('shiftHelp')}</p>
          {canEditShared&&<>
            <input type="hidden" name="allowedShiftsEditor" value="1"/>
            <ScheduleDraftShiftPicker base shifts={shifts.map(shift=>({...shift,available:true,archived:false}))}/>
          </>}
        </Card>}
        {/* c03670cc — the Duty Roster sits directly under Shift Allowed and draws from the same pool. */}
        {!editing && duty}
  </>;
  const grace = <div className="space-y-3">
    <h3 className="font-semibold">{ts('graceTitle')}</h3>
    <Field label={te('lateGrace')}><input type="number" min={0} name="lateGracePeriodMinutes" defaultValue={rule?.lateGracePeriodMinutes??0} className={inputCls}/></Field>
    <Field label={te('earlyGrace')}><input type="number" min={0} name="earlyGracePeriodMinutes" defaultValue={rule?.earlyGracePeriodMinutes??0} className={inputCls}/></Field>
  </div>;
  const attendance = <>
    <ScheduleClockFields settings={clockCompanies} editing grace={grace}/>

        {/* Section 1 — Lateness */}
        <Card className="space-y-3 p-4">
          <h2 className="text-sm font-semibold text-foreground">{t('latenessSectionTitle')}</h2>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t('afterMinutes')}>
              <input type="number" min={0} name="lateAfterMinutes" defaultValue={rule?.lateAfterMinutes ?? 0} className={inputCls} />
            </Field>
            <Field label={t('deductMinutes')}>
              <input type="number" min={0} name="lateDeductMinutes" defaultValue={rule?.lateDeductMinutes ?? 0} className={inputCls} />
            </Field>
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-sm has-[:checked]:text-primary">
            <input type="checkbox" name="includeGraceInLateness" defaultChecked={rule?.includeGraceInLateness ?? false} className="h-3.5 w-3.5 accent-primary" />
            {t('includeGraceInLateness')}
          </label>
        </Card>

        {/* Section 2 — Early Out */}
        <Card className="space-y-3 p-4">
          <h2 className="text-sm font-semibold text-foreground">{t('earlyOutSectionTitle')}</h2>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t('afterMinutes')}>
              <input type="number" min={0} name="earlyAfterMinutes" defaultValue={rule?.earlyAfterMinutes ?? 0} className={inputCls} />
            </Field>
            <Field label={t('deductMinutes')}>
              <input type="number" min={0} name="earlyDeductMinutes" defaultValue={rule?.earlyDeductMinutes ?? 0} className={inputCls} />
            </Field>
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-sm has-[:checked]:text-primary">
            <input type="checkbox" name="includeGraceInEarlyOut" defaultChecked={rule?.includeGraceInEarlyOut ?? false} className="h-3.5 w-3.5 accent-primary" />
            {t('includeGraceInEarlyOut')}
          </label>
        </Card>
        <WageDeductionsCard rule={rule} editing/>
  </>;
  // 2f803985 — the old overtime bands left Add Schedule: they live in Overtime Patterns › 1. General
  // Settings of the group's own legacy pattern (created on insert by the 0551 trigger). This tab carries
  // the Overtime Setting section instead, written in the same transaction as the new group.
  const tos = await getTranslations('scheduleOvertimeSetting');
  // The complete legacy edit form (updateAttendanceRuleAction replaces the band table from `otRows`) keeps
  // its band editor, so it can never post an empty ladder over a saved one.
  const overtime = generalOnly ? null : editing ? await renderScheduleOvertimeBands(rule) : overtimeSetting ? <Card className="space-y-3 p-4">
    <h2 className="font-semibold">{tos('title')}</h2>
    <ScheduleOvertimeSettingFields {...overtimeSetting}/>
  </Card> : null;
  return (
    <div className="space-y-6">
      <ErrorBanner message={error}/>
      <AttendanceSettingsActionForm submitAction={editing ? generalOnly ? saveScheduleGroupGeneralAction : updateAttendanceRuleAction : createAttendanceRuleAction} preserveDrafts={saveScope||!editing} data-attendance-save-scope={saveScope ? '' : undefined} data-attendance-saved-receipt={savedReceipt} className="space-y-6">
        {editing && <input type="hidden" name="ruleId" value={rule!.id}/>}
        {!editing ? <ScheduleGroupTabs initial={initialSection} ariaLabel={ts('sectionsAria')} initialPool={[]}
          tabs={[
            {id:'general',label:ts('sectionGeneral'),body:general},
            {id:'attendance',label:ts('sectionAttendance'),body:attendance},
            {id:'overtime',label:ts('sectionOvertime'),body:overtime},
          ]}/>
          : <>{general}{!generalOnly&&<>{attendance}{overtime}</>}</>}
        <div className="flex items-center gap-3">
          <AttendanceSettingsSaveButton className={btnPrimary}>{t('save')}</AttendanceSettingsSaveButton>
          {cancel && (
            <Link href={cancel.href} className="text-sm text-muted-foreground hover:text-foreground">
              {cancel.label}
            </Link>
          )}
        </div>
      </AttendanceSettingsActionForm>
    </div>
  );
}


export async function renderScheduleOvertimeBands(rule:AttendanceRuleView|null) {
  const t=await getTranslations('admin.attendanceRule');
  const initialRows: OtEditorRow[] = (rule?.otRows ?? []).map((r) => ({
    fromH: Math.floor(r.fromMinutes / 60),
    fromM: r.fromMinutes % 60,
    toH: Math.floor(r.toMinutes / 60),
    toM: r.toMinutes % 60,
    ratePattern: r.ratePattern,
    // c03670cc — formatted from the stored decimal's own digits (1.50 → "1.5", 1.75 → "1.75", 2 → "2.0"),
    // never through float arithmetic, so a saved rate always reopens exactly as it was typed.
    rate: formatOtRate(r.rate),
    phRate: r.phRate == null ? '' : formatOtRate(r.phRate),
    roundingMode: r.roundingMode,
    roundToMinutes: r.roundToMinutes,
  }));

  const otLabels = {
    sectionTitle: t('otSectionTitle'),
    addRow: t('otAddRow'),
    colFrom: t('otColFrom'),
    colTo: t('otColTo'),
    colPattern: t('otColPattern'),
    colRate: t('otColRate'),
    colRounding: t('otColRounding'),
    colRoundTo: t('otColRoundTo'),
    colRemove: t('otColRemove'),
    patternFlat: t('otPatternFlat'),
    patternVariable: t('otPatternVariable'),
    // 7c834696 contested — Yes/No became None/Down/Up (migration 0439). `roundingYes` / `roundingNo` were
    // retired from all six catalogues in the same change; nothing else read them.
    roundingNone: t('roundingModeNone'),
    roundingDown: t('roundingModeDown'),
    roundingUp: t('roundingModeUp'),
    roundToHint: t('otRoundToHint'),
    rateFlatSuffix: t('otRateFlatSuffix'),
    rateUnset: t('otRateUnset'),
    hour: t('unitHour'),
    min: t('unitMin'),
    applyEarlyOtLabel: t('applyEarlyOtLabel'),
    applyEarlyOtHint: t('applyEarlyOtHint'),
    emptyHint: t('otEmptyHint'),
    colPhRate: t('otColPhRate'),
    phRateNone: t('otPhRateNone'),
    rateInvalid: t('otRateInvalid'),
    phRateInvalid: t('otPhRateInvalid'),
    rateHint: t('otRateHint'),
    otherRateNote: String(t.raw('otOtherRateNote')),
    // Passed as TEMPLATES with {placeholders} the island fills in — a formatter function would be a
    // closure crossing the server→client boundary, which is the RSC bug this repo has shipped before.
    //
    // `t.raw`, NOT `t`: `{row}` is also ICU interpolation syntax, so plain `t()` demands the values HERE,
    // where they do not exist yet — it fails with FORMATTING_ERROR and renders the key path on screen.
    // Caught only by reading the dev log on a real render: the page still returned 200, tsc passed, and
    // i18n coverage check C passed because the KEY exists — existing and formatting are different things.
    ladderGapWarning: String(t.raw('otLadderGapWarning')),
    ladderOpenEndedWarning: String(t.raw('otLadderOpenEndedWarning')),
  };

  return <>
    <Card className="space-y-3 p-4"><AttendanceRuleOtEditor initialRows={initialRows} initialApplyEarlyOt={rule?.applyToEarlyOt??false} labels={otLabels}/>
      <p className="text-xs text-muted-foreground">{t('otRateHint')}</p>
      {/* c03670cc — band rates are reporting only; payroll overtime pay does not read them. */}
      <p className="border-l-2 border-border pl-3 text-sm" data-ot-rate-reporting-note="">{t('otRateReportingNote')}</p>
    </Card>
    <p className="rounded-lg border border-amber-300/60 bg-amber-50/60 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
      {t('statutoryCapNote')}
    </p>
  </>;
}

