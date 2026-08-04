import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { Card, ErrorBanner, Field, PageHeader, btnPrimary, inputCls } from '@/components/ui';
import { AttendanceRuleOtEditor, type OtEditorRow } from '@/components/attendance-rule-ot-editor';
import type { AttendanceRuleView } from '@/core/attendance-rule';
import { createAttendanceRuleAction, updateAttendanceRuleAction } from '../rule-actions';

const LIST = '/admin/attendance-policy';

/**
 * 88e94371 · Add / Edit form for one "Lateness, Early Out & Overtime Settings" rule. Three sections
 * (Lateness, Early Out, Overtime). Server component: it RENDERS the AttendanceRuleOtEditor client island as
 * JSX (never imports+calls it), keeping the RSC boundary clean. Standard (is_default) rules are editable but
 * their name is locked and they can't be deleted.
 *
 * 6da67ab7 — no Company field: a rule belongs to the tenant and reaches employees through the shift that
 * selects it (Shift Settings → Attendance rule).
 */
export async function RuleForm({
  rule,
  error,
}: {
  rule: AttendanceRuleView | null;
  error?: string;
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
    rounding: r.rounding,
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
    roundingYes: t('roundingYes'),
    roundingNo: t('roundingNo'),
    hour: t('unitHour'),
    min: t('unitMin'),
    applyEarlyOtLabel: t('applyEarlyOtLabel'),
    applyEarlyOtHint: t('applyEarlyOtHint'),
    emptyHint: t('otEmptyHint'),
    colPhRate: t('otColPhRate'),
    phRateNone: t('otPhRateNone'),
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title={editing ? t('editTitle') : t('newTitle')}
        description={t('formDescription')}
        back={{ href: LIST, label: t('backToList') }}
      />
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

        {/* Section 3 — Overtime */}
        <Card className="p-4">
          <AttendanceRuleOtEditor initialRows={initialRows} initialApplyEarlyOt={rule?.applyToEarlyOt ?? false} labels={otLabels} />
        </Card>

        <p className="rounded-lg border border-amber-300/60 bg-amber-50/60 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          {t('statutoryCapNote')}
        </p>

        <div className="flex items-center gap-3">
          <button className={btnPrimary}>{t('save')}</button>
          <Link href={LIST} className="text-sm text-muted-foreground hover:text-foreground">
            {t('cancel')}
          </Link>
        </div>
      </form>
    </div>
  );
}
