import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { Card, ErrorBanner, Field, btnPrimary, inputCls } from '@/components/ui';
import { AttendanceRuleOtEditor, type OtEditorRow } from '@/components/attendance-rule-ot-editor';
import type { AttendanceRuleView } from '@/core/attendance-rule';
import { createAttendanceRuleAction, updateAttendanceRuleAction } from '../rule-actions';

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
}: {
  hideAllowedShifts?: boolean;
  rule: AttendanceRuleView | null;
  shifts: readonly RuleShiftChoice[];
  error?: string;
  /** The way out that writes nothing, or null when the page's own Back is it. */
  cancel: { href: string; label: string } | null;
}) {
  const t = await getTranslations('admin.attendanceRule');
  const editing = !!rule;
  const isDefault = !!rule?.isDefault;

  const initialRows: OtEditorRow[] = (rule?.otRows ?? []).map((r) => ({
    fromH: Math.floor(r.fromMinutes / 60),
    fromM: r.fromMinutes % 60,
    toH: Math.floor(r.toMinutes / 60),
    toM: r.toMinutes % 60,
    ratePattern: r.ratePattern,
    // ONE decimal place on both sides — the variable-rate <select> compares option values as strings, and
    // the old toFixed(2) ("1.50") matched none of them, so a saved 1.5 band reopened showing the wrong rate.
    rate: Number(r.rate).toFixed(1),
    phRate: r.phRate == null ? '' : Number(r.phRate).toFixed(1),
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

  return (
    <div className="space-y-6">
      <ErrorBanner message={error} />

      <form action={editing ? updateAttendanceRuleAction : createAttendanceRuleAction} className="space-y-6">
        {editing && <input type="hidden" name="ruleId" value={rule!.id} />}

        <Card className="space-y-4 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('ruleName')}>
              <input
                name="name"
                required
                defaultValue={rule?.name ?? ''}
                readOnly={isDefault}
                className={`${inputCls} ${isDefault ? 'opacity-70' : ''}`}
              />
            </Field>
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

        {/* Section 1 — Lateness */}
        <Card className="space-y-3 p-4">
          <h2 className="text-sm font-semibold text-foreground">{t('latenessSectionTitle')}</h2>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t('gracePeriod')}>
              <input type="number" min={0} name="lateGracePeriodMinutes" defaultValue={rule?.lateGracePeriodMinutes ?? 0} className={inputCls} />
            </Field>
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
            <Field label={t('gracePeriod')}>
              <input type="number" min={0} name="earlyGracePeriodMinutes" defaultValue={rule?.earlyGracePeriodMinutes ?? 0} className={inputCls} />
            </Field>
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

        {/* 7c834696 stage 1 — the deduction switch. The two "after X → deduct Y" pairs above were stored
            and read by nothing until this release, so every rule's effective deduction has always been
            zero. Turning them on for everybody at once would take minutes off people whose employer never
            knew the field was live — hence a per-rule switch that ships OFF, with the start date stamped
            by the server (never typed) so it can only ever be today or later. */}
        <Card className="space-y-3 p-4">
          <h2 className="text-sm font-semibold text-foreground">{t('deductionsSectionTitle')}</h2>
          <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-border px-3 py-2 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/10">
            <input type="checkbox" name="applyDeductions" defaultChecked={rule?.applyDeductions ?? false} className="mt-0.5 h-3.5 w-3.5 accent-primary" />
            <span>
              <span className="font-medium text-foreground">{t('applyDeductionsLabel')}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{t('applyDeductionsHint')}</span>
            </span>
          </label>
          <p className="text-xs text-muted-foreground">
            {t('deductionsFromLabel')}:{' '}
            <span className="font-medium tabular-nums text-foreground">
              {rule?.deductionsEffectiveFrom ?? t('deductionsFromNone')}
            </span>
          </p>
        </Card>

        {/* ── 870b79e2 · Shifts allowed ────────────────────────────────────────────────────────────
            THE LIST IS shift.rule_id READ BACKWARDS, not a new relation. The set of shifts pointing at
            this rule IS the set of shifts this group allows, so the editor writes that one column for the
            shifts that were ticked and clears it for the ones that were not. A shift belongs to exactly
            one group — that cardinality is what keeps rule resolution single-valued — so the row says
            which group a shift is leaving rather than pretending it could be in both.

            ⚠️ THE HIDDEN MARKER IS LOAD-BEARING. Checkboxes are omitted by the browser when unchecked, so
            "every box cleared" and "this form never carried the editor" both arrive as an EMPTY
            getAll('allowedShiftIds'). Without the marker, clearing the last shift would silently do
            nothing. The marker is read as a VALUE, never by presence — the trap 7c834696 hit on this very
            form (see `bool` in ../rule-actions.ts). */}
        {!hideAllowedShifts && <Card className="space-y-3 p-4">
          <h2 className="text-sm font-semibold text-foreground">{t('shiftsAllowedTitle')}</h2>
          <p className="text-xs text-muted-foreground">{t('shiftsAllowedHint')}</p>
          <input type="hidden" name="allowedShiftsEditor" value="1" />
          {shifts.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('shiftsAllowedEmpty')}</p>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {shifts.map((sh) => (
                <li key={sh.id}>
                  <label className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm has-[:checked]:bg-primary/10">
                    <input
                      type="checkbox"
                      name="allowedShiftIds"
                      value={sh.id}
                      defaultChecked={sh.inThisGroup}
                      className="h-3.5 w-3.5 accent-primary"
                    />
                    <span className="font-medium text-foreground">{sh.name}</span>
                    {sh.code && <span className="font-mono text-xs text-muted-foreground">{sh.code}</span>}
                    <span className="ml-auto text-xs text-muted-foreground">
                      {sh.inThisGroup
                        ? null
                        : sh.otherGroupName
                          ? t('shiftsAllowedInGroup', { group: sh.otherGroupName })
                          : t('shiftsAllowedNoGroup')}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </Card>}

        {/* Section 3 — Overtime */}
        <Card className="p-4">
          <AttendanceRuleOtEditor initialRows={initialRows} initialApplyEarlyOt={rule?.applyToEarlyOt ?? false} labels={otLabels} />
        </Card>

        <p className="rounded-lg border border-amber-300/60 bg-amber-50/60 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          {t('statutoryCapNote')}
        </p>

        <div className="flex items-center gap-3">
          <button className={btnPrimary}>{t('save')}</button>
          {cancel && (
            <Link href={cancel.href} className="text-sm text-muted-foreground hover:text-foreground">
              {cancel.label}
            </Link>
          )}
        </div>
      </form>
    </div>
  );
}
