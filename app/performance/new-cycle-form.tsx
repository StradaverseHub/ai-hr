'use client';

/**
 * New review-cycle form (Performance eligibility slice). A client island so the "Preview eligible
 * employees" button can call previewEligibilityAction and render the point-in-time count inline, next to
 * the submit button, WITHOUT a debounced/live counter and without navigating away. The form still submits
 * to createCycleAction (a normal server action) for creation.
 *
 * The eligibility rule fields (Company / Status / Employment Type chip pickers, min service months,
 * hired-before) map 1:1 onto EligibilityRules via parseEligibilityRules in actions.ts. The chip pickers
 * post one hidden input per selected value, so formData.getAll(...) sees the same shape as the native
 * <select multiple> they replaced (1a6ed9e6 contest: selections clearly displayed and removable).
 */
import { useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Field, inputCls } from '@/components/ui';
import { ChipMultiSelect } from '@/components/ui/chip-multi-select';
import { createCycleAction, previewEligibilityAction } from './actions';

const STATUS_OPTS = ['active', 'on_leave', 'probation', 'offboarding', 'terminated'] as const;
const EMP_TYPE_OPTS = ['full_time', 'part_time', 'contract', 'intern'] as const;

export function NewCycleForm({
  companies,
  today,
}: {
  companies: { id: string; name: string }[];
  today: string;
}) {
  const t = useTranslations('performance.list');
  const te = useTranslations('performance.eligibility');
  const tl = useTranslations('performance.lifecycle');
  const formRef = useRef<HTMLFormElement>(null);
  const [pending, startTransition] = useTransition();
  const [preview, setPreview] = useState<{ count?: number; error?: string } | null>(null);

  function onPreview() {
    const form = formRef.current;
    if (!form) return;
    // Same FormData the submit would send — the preview runs the exact query openCycle will run.
    const fd = new FormData(form);
    startTransition(async () => {
      const res = await previewEligibilityAction(fd);
      setPreview(res);
    });
  }

  return (
    <form ref={formRef} action={createCycleAction} className="grid grid-cols-1 gap-4 border-t border-border p-4 sm:grid-cols-2">
      <Field label={t('fieldName')}>
        <input name="name" required className={inputCls} placeholder={t('namePlaceholder')} />
      </Field>
      <Field label={t('fieldScope')}>
        <select name="companyId" className={inputCls} defaultValue="">
          <option value="">{t('scopeAllCompanies')}</option>
          {companies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t('fieldPeriodStart')}>
        <input name="periodStart" type="date" required defaultValue={`${today.slice(0, 4)}-01-01`} className={inputCls} />
      </Field>
      <Field label={t('fieldPeriodEnd')}>
        <input name="periodEnd" type="date" required defaultValue={`${today.slice(0, 4)}-12-31`} className={inputCls} />
      </Field>
      <Field label={t('fieldMeritPool')}>
        <div className="flex gap-2">
          <select name="meritBudgetKind" className={inputCls} defaultValue="">
            <option value="">{t('meritNoPool')}</option>
            <option value="percent">{t('meritPercent')}</option>
            <option value="amount">{t('meritAmount')}</option>
          </select>
          <input name="meritBudgetValue" type="number" step="0.1" min="0" className={`${inputCls} w-28`} placeholder="3.5" />
        </div>
      </Field>
      <div className="sm:col-span-2">
        <Field label={tl('stagesField')}>
          <p className="mb-2 text-xs text-muted-foreground">{tl('stagesHint')}</p>
          <div className="flex flex-wrap gap-4 text-sm">
            {([
              ['goal_setting', tl('stageGoalSetting')],
              ['mid_year', tl('stageMidYear')],
              ['year_end', tl('stageYearEnd')],
            ] as const).map(([kind, label]) => (
              <label key={kind} className="flex items-center gap-2">
                <input type="checkbox" name="stage" value={kind} defaultChecked className="size-4" />
                {label}
              </label>
            ))}
          </div>
        </Field>
      </div>

      {/* Eligibility rules — who the cycle snapshots at open. All AND-combined; leave a field empty to skip it. */}
      <div className="sm:col-span-2 rounded-lg border border-border bg-muted/20 p-4">
        <h3 className="mb-1 text-sm font-semibold">{te('eligibilityRulesTitle')}</h3>
        <p className="mb-3 text-xs text-muted-foreground">{te('fieldEligibility')}</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {/* 4dc4c3a5 → 0af0729d: the bulk (Select-all / Clear-all) + collapsed-summary props are OPT-IN
              affordances of the shared ChipMultiSelect. This screen keeps all four on its three pickers because
              the company list is dynamic and unbounded (one-click select-all and the "{n} selected" summary
              genuinely matter here); the leave-type-panel eligibility pickers omit them — their short option
              lists read best as a plain checkbox popover with the chips always visible. */}
          <Field label={te('fieldCompany')}>
            <ChipMultiSelect
              name="eligibilityCompanyId"
              options={companies.map((c) => ({ value: c.id, label: c.name }))}
              addPlaceholder={te('chipAddPlaceholder')}
              removeLabelFor={(label) => te('chipRemoveLabel', { value: label })}
              selectAllLabel={te('chipSelectAll')}
              clearAllLabel={te('chipClearAll')}
              allSelectedLabel={te('chipAllSelected')}
              countLabelFor={(n) => te('chipNSelected', { count: n })}
            />
          </Field>
          <Field label={te('fieldStatus')}>
            <ChipMultiSelect
              name="eligibilityStatus"
              options={STATUS_OPTS.map((v) => ({ value: v, label: te(`status_${v}`) }))}
              addPlaceholder={te('chipAddPlaceholder')}
              removeLabelFor={(label) => te('chipRemoveLabel', { value: label })}
              selectAllLabel={te('chipSelectAll')}
              clearAllLabel={te('chipClearAll')}
              allSelectedLabel={te('chipAllSelected')}
              countLabelFor={(n) => te('chipNSelected', { count: n })}
            />
          </Field>
          <Field label={te('fieldEmploymentType')}>
            <ChipMultiSelect
              name="eligibilityEmploymentType"
              options={EMP_TYPE_OPTS.map((v) => ({ value: v, label: te(`employmentType_${v}`) }))}
              addPlaceholder={te('chipAddPlaceholder')}
              removeLabelFor={(label) => te('chipRemoveLabel', { value: label })}
              selectAllLabel={te('chipSelectAll')}
              clearAllLabel={te('chipClearAll')}
              allSelectedLabel={te('chipAllSelected')}
              countLabelFor={(n) => te('chipNSelected', { count: n })}
            />
          </Field>
          <div className="space-y-4">
            <Field label={te('fieldMinService')}>
              <input name="minServiceMonths" type="number" min="0" step="1" className={inputCls} placeholder="6" />
            </Field>
            <Field label={t('fieldHiredBefore')}>
              <input name="hiredBefore" type="date" className={inputCls} />
            </Field>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <Button type="submit">{t('createCycle')}</Button>
        <Button type="button" variant="secondary" onClick={onPreview} disabled={pending}>
          {te('previewButtonLabel')}
        </Button>
        {preview?.error && <span className="text-sm text-destructive">{preview.error}</span>}
        {preview && preview.error == null && (
          <span className="text-sm text-muted-foreground">
            {te('eligibleCountLabel', { count: preview.count ?? 0 })}
          </span>
        )}
      </div>
    </form>
  );
}
