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
import { inputCls } from '@/components/ui';
import { PersonnelField } from '@/components/personnel-field';
import { personnelControl, personnelInput, personnelFormChoices, personnelFormLabel, personnelFormName } from '@/lib/personnel-form-contract';
import { DateField } from '@/components/ui/date-field';


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
  const fields = {
    probationPeriod: ['employment.employment_dates_and_service.probationvalue','employment.employment_dates_and_service.probationunit'],
    extendedProbationPeriod: ['employment.employment_dates_and_service.extendedprobationvalue','employment.employment_dates_and_service.extendedprobationunit'],
    noticeBeforeConfirmation: ['employment.employment_dates_and_service.noticebeforeconfirmationvalue','employment.employment_dates_and_service.noticebeforeconfirmationunit'],
    noticeAfterConfirmation: ['employment.employment_dates_and_service.noticeafterconfirmationvalue','employment.employment_dates_and_service.noticeafterconfirmationunit'],
  } as const;
  const [valueId,unitId]=fields[props.labelKey];
  const mode=props.mode==='controlled' ? 'draft' : 'edit';
  const options=personnelFormChoices(unitId);
  if(props.mode==='form'){personnelFormName(valueId,props.valueName);personnelFormName(unitId,props.unitName);}

  return (
    <PersonnelField fieldId={valueId} mode={mode}>
      <div className="flex gap-2">
        <input
          {...personnelInput(valueId,mode)}
          placeholder={t('employmentInfo.value')}
          aria-label={t('employmentInfo.value')}
          className={inputCls}
          {...(props.mode === 'form'
            ? { defaultValue: props.value ?? '' }
            : {
                value: props.value ?? '',
                onChange: (e) => props.onChange({ value: e.target.value }),
              })}
        />
        <select
          {...personnelControl(unitId,mode)}
          aria-label={t('employmentInfo.unit')}
          className={inputCls}
          {...(props.mode === 'form'
            ? { defaultValue: props.unit ?? 'month' }
            : {
                value: props.unit ?? 'month',
                onChange: (e) => props.onChange({ unit: e.target.value }),
              })}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {t(option.labelKey.slice(14))}
            </option>
          ))}
        </select>
      </div>
    </PersonnelField>
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
    | {
        mode: 'form';
        value: string | null | undefined;
        name?: string;
        /** r422 — OPT-IN: draw the box as DD-MMM-YYYY (components/ui/date-field.tsx); same name, same ISO
         *  value posted. The Personnel profile passes it; the Create New Employee draft does not. */
        dmyDisplay?: boolean;
      }
    | { mode: 'controlled'; value: string | null | undefined; onChange: (value: string) => void },
) {
  const t = useTranslations('people.detail');
  const fieldId='employment.employment_dates_and_service.confirmationdate';
  const mode=props.mode==='controlled' ? 'draft' : 'edit';
  const label=personnelFormLabel(fieldId,(key,fallback)=>key.startsWith('people.detail.') ? t(key.slice(14)) : fallback);
  if(props.mode==='form')personnelFormName(fieldId,props.name);
  if (props.mode === 'form' && props.dmyDisplay) {
    return (
      <PersonnelField fieldId={fieldId} mode={mode}>
        <DateField
          {...personnelControl(fieldId,mode)}
          defaultValue={props.value ?? ''}
          className={inputCls}
          label={label}
        />
      </PersonnelField>
    );
  }
  return (
    <PersonnelField fieldId={fieldId} mode={mode}>
      <input
        {...personnelInput(fieldId,mode)}
        className={inputCls}
        {...(props.mode === 'form'
          ? { defaultValue: props.value ?? '' }
          : { value: props.value ?? '', onChange: (e) => props.onChange(e.target.value) })}
      />
    </PersonnelField>
  );
}
