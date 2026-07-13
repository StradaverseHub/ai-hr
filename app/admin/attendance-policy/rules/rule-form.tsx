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
 * their name/company are locked and they can't be deleted.
 */
export async function RuleForm({
  rule,
  companies,
  error,
}: {
  rule: AttendanceRuleView | null;
  companies: { id: string; name: string }[];
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
    rate: Number(r.rate).toFixed(2),
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
        {editing ? (
          <input type="hidden" name="companyId" value={rule!.companyId} />
        ) : null}

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
            {!editing && (
              <Field label={t('company')}>
                <select name="companyId" required className={inputCls} defaultValue={companies[0]?.id ?? ''}>
                  {companies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
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
