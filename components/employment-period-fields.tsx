'use client';

/**
 * A PERIOD — a whole number and its unit (Month / Week / Day) — shared between the Personnel Employment
 * tab's Employment Dates card and the Create New Employee draft (item a72610af).
 *
 * FOUR PERIODS USE IT: Probation, Extended Probation, Notice Before Confirmation and Notice After
 * Confirmation. Item 955c7de4 redesigned all four from bare month counts into value+unit pairs, and the
 * Personnel card rendered the same eight lines of markup four times over. The draft needed the same four,
 * so the choice was a fifth and sixth copy or one definition; this is the one definition.
 *
 *   mode: 'form'        → `name`d inputs read out of FormData by `setEmploymentInfoAction`.
 *   mode: 'controlled'  → value/onChange bound to the draft's React state, and NO `name` at all.
 *
 * THE UNIT LIST IS `EMPLOYMENT_PERIOD_UNITS`' — restated on the draft side as `DRAFT_PERIOD_UNITS`
 * (lib/employee-draft-schema.ts) because this file is rendered in the browser and `core/org.ts` is a
 * server module; `test/draft-activation-field-survival.test.ts` pins the two lists equal, so a unit added
 * to the writer and not to the screen fails a test rather than producing "Period unit must be Month, Week
 * or Day." after an employee has already been created.
 *
 * VALIDATION LIVES WITH THE WRITER, NOT HERE. `setEmploymentInfo` refuses a value that is not a whole
 * number of zero or more; `missingByTab` restates that rule for the draft so the refusal lands on the tab
 * instead of after `hireEmployee` has committed. This component only renders.
 */
import { useTranslations } from 'next-intl';
import { Field, inputCls } from '@/components/ui';
import { DRAFT_PERIOD_UNITS } from '@/lib/employee-draft-schema';

/** `people.detail.employmentInfo.*` label key for the period — the Personnel card's own word for it. */
export type EmploymentPeriodLabelKey =
  | 'probationPeriod'
  | 'extendedProbationPeriod'
  | 'noticeBeforeConfirmation'
  | 'noticeAfterConfirmation';

type Common = {
  labelKey: EmploymentPeriodLabelKey;
  value: string | number | null | undefined;
  unit: string | null | undefined;
};

export function EmploymentPeriodField(
  props:
    | (Common & { mode: 'form'; valueName: string; unitName: string })
    | (Common & { mode: 'controlled'; onChange: (patch: { value?: string; unit?: string }) => void }),
) {
  const t = useTranslations('people.detail');
  // A literal per key rather than a computed `employmentInfo.${labelKey}`: a template key is invisible to
  // test/i18n-coverage.test.ts check C, and these four are the whole point of sharing the component.
  const label = {
    probationPeriod: t('employmentInfo.probationPeriod'),
    extendedProbationPeriod: t('employmentInfo.extendedProbationPeriod'),
    noticeBeforeConfirmation: t('employmentInfo.noticeBeforeConfirmation'),
    noticeAfterConfirmation: t('employmentInfo.noticeAfterConfirmation'),
  }[props.labelKey];
  // Same shape: one literal per unit, so every value label is checked by the same guard.
  const unitLabel: Record<string, string> = {
    month: t('employmentInfo.unit_month'),
    week: t('employmentInfo.unit_week'),
    day: t('employmentInfo.unit_day'),
  };

  return (
    <Field label={label}>
      <div className="flex gap-2">
        <input
          type="number"
          min={0}
          step={1}
          placeholder={t('employmentInfo.value')}
          aria-label={t('employmentInfo.value')}
          className={inputCls}
          {...(props.mode === 'form'
            ? { name: props.valueName, defaultValue: props.value ?? '' }
            : {
                value: props.value ?? '',
                onChange: (e) => props.onChange({ value: e.target.value }),
              })}
        />
        <select
          aria-label={t('employmentInfo.unit')}
          className={inputCls}
          {...(props.mode === 'form'
            ? { name: props.unitName, defaultValue: props.unit ?? 'month' }
            : {
                value: props.unit ?? 'month',
                onChange: (e) => props.onChange({ unit: e.target.value }),
              })}
        >
          {DRAFT_PERIOD_UNITS.map((u) => (
            <option key={u} value={u}>
              {unitLabel[u]}
            </option>
          ))}
        </select>
      </div>
    </Field>
  );
}

/**
 * The Confirmation Date — the one probation date that is still editable outside the Movement module.
 *
 * EXTENDED and FINAL confirmation dates are deliberately NOT here. Item d27961e3 moved probation
 * extensions into the Movement tab exclusively: `setEmploymentInfo` honours `extendedConfirmationDate`
 * only under the `probationExtension` movement tag and silently ignores an untagged save that posts it,
 * so a control for it on either of these screens would be a box that appears to work and does nothing.
 */
export function ConfirmationDateField(
  props:
    | { mode: 'form'; value: string | null | undefined; name?: string }
    | { mode: 'controlled'; value: string | null | undefined; onChange: (value: string) => void },
) {
  const t = useTranslations('people.detail');
  return (
    <Field label={t('employmentInfo.confirmationDate')}>
      <input
        type="date"
        className={inputCls}
        {...(props.mode === 'form'
          ? { name: props.name ?? 'confirmationDate', defaultValue: props.value ?? '' }
          : { value: props.value ?? '', onChange: (e) => props.onChange(e.target.value) })}
      />
    </Field>
  );
}
