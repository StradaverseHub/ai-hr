'use client';

/**
 * THE TWO DISABILITY RELIEFS (OKU) AND THE CHILD RELIEF MODE, plus the per-employee TRAINING LEVY switch
 * — shared between the Personnel Bank & Statutory tab and the Create New Employee draft (item a72610af).
 *
 * THEY ARE CLAIMS ABOUT A PERSON, NOT AMOUNTS. Each says something true of the employee — registered
 * disabled, spouse registered disabled, how their child relief is maintained, whether their earnings are
 * in the HRD Corp levy base. The RELIEF AMOUNTS are statutory and live in the country pack's ruleset,
 * never on a draft and never on the employee's row; the same separation item d64d0df4 made when it added
 * these columns. Nothing here computes money.
 *
 * THE THIRD ONE IS NOT COSMETIC EITHER. `disabledIndividual` moves the employee's monthly tax the moment
 * it is set, because PCB is worked out from the year to date — so the month of the change absorbs the
 * whole year-to-date correction. Setting it at HIRE, where it belongs, is the difference between that
 * correction being a rounding detail and it being a visible jump on a payslip three months in.
 *
 *   mode: 'form'        → `name`d controls read out of FormData by `setTaxAction` / `setOthersAction`.
 *   mode: 'controlled'  → value/onChange bound to the draft's React state, and NO `name` at all.
 *
 * THE CHILD RELIEF MODE IS CONTROLLED IN **BOTH** MODES, uniquely among the shared groups: on the
 * Personnel card its value decides whether the five-category grid renders and whether the head count is
 * read-only, so that card has always driven it from React state inside its `<form>`. Its form rendering
 * therefore takes `value` + `onChange` as well as `name` — it is a controlled input that posts, not an
 * uncontrolled one.
 *
 * LABELS FROM `people.detail.*` — the Personnel card's own keys; no message key is added.
 */
import { useTranslations } from 'next-intl';
import { Field, inputCls } from '@/components/ui';

/** The three child-relief modes, in the order both screens offer them (item d64d0df4 added the third). */
export const CHILD_RELIEF_MODES = ['manual', 'auto', 'auto_table'] as const;

type YesNoCommon = { field: 'disabledIndividual' | 'disabledSpouse' };

/**
 * One OKU claim — Yes / No, defaulting to No, so nobody's monthly tax moves until an admin makes it.
 *
 * `disabledSpouse` only moves the figure for tax category 2 (married, spouse not working); the official
 * rules give it no effect otherwise. Both screens show the hint that says so rather than letting the
 * setting look ignored — on Personnel under the fieldset, on the draft under the field.
 */
export function DisabledReliefField(
  props:
    | (YesNoCommon & { mode: 'form'; defaultValue: boolean })
    | (YesNoCommon & { mode: 'controlled'; value: string | undefined; onChange: (value: string) => void }),
) {
  const t = useTranslations('people.detail');
  const label = props.field === 'disabledIndividual' ? t('disabledIndividualLabel') : t('disabledSpouseLabel');
  return (
    <Field label={label}>
      <select
        className={inputCls}
        {...(props.mode === 'form'
          ? { name: props.field, defaultValue: props.defaultValue ? 'yes' : 'no' }
          : {
              // ABSENT READS AS 'no' — the column default, and the state in which the relief is not
              // claimed. A draft nobody has touched must not claim a relief by omission.
              value: props.value === 'yes' ? 'yes' : 'no',
              onChange: (e) => props.onChange(e.target.value),
            })}
      >
        <option value="no">{t('disabledIndividualNo')}</option>
        <option value="yes">{t('disabledIndividualYes')}</option>
      </select>
    </Field>
  );
}

/** Both OKU hints, as the Personnel card words them. Rendered by whichever screen has room for them. */
export function DisabledReliefHints() {
  const t = useTranslations('people.detail');
  return (
    <>
      <p className="text-xs text-muted-foreground">{t('disabledIndividualHint')}</p>
      <p className="text-xs text-muted-foreground">{t('disabledSpouseHint')}</p>
    </>
  );
}

/**
 * How `num_children` is maintained: keyed by HR ('manual'), derived from the Family register ('auto'), or
 * keyed against the five LHDN s.48 categories ('auto_table').
 *
 * THE DRAFT OFFERS ALL THREE and carries no grid. 'auto' needs no keying at all — the count syncs from
 * the Family register, which a draft already captures and `materialiseDependents` creates at Activate, so
 * choosing it here is exactly as meaningful as choosing it afterwards. 'auto_table' is stored as the mode
 * and its grid is keyed on the record, where the category totals can be read back against real children.
 */
export function ChildReliefModeField(
  props:
    | { mode: 'form'; name?: string; value: string; onChange: (value: string) => void }
    | { mode: 'controlled'; value: string | undefined; onChange: (value: string) => void },
) {
  const t = useTranslations('people.detail');
  const label: Record<string, string> = {
    manual: t('childReliefModeManual'),
    auto: t('childReliefModeAuto'),
    auto_table: t('childReliefModeAutoTable'),
  };
  const current = CHILD_RELIEF_MODES.includes((props.value ?? '') as 'manual') ? props.value! : 'manual';
  return (
    <Field label={t('childReliefModeLabel')}>
      <select
        className={inputCls}
        value={current}
        onChange={(e) => props.onChange(e.target.value)}
        {...(props.mode === 'form' ? { name: props.name ?? 'childReliefMode' } : {})}
      >
        {CHILD_RELIEF_MODES.map((m) => (
          <option key={m} value={m}>
            {label[m]}
          </option>
        ))}
      </select>
    </Field>
  );
}

/**
 * SUBJECT TO HRDF — the per-employee training-levy switch (feedback 0df0c635), a TRI-STATE.
 *
 * THE BLANK OPTION IS THE DEFAULT AND IT IS NOT "UNSET": it means "follow the company's HRDF registration
 * default", which is what every employee does until somebody overrides them. Only an explicit Yes or No
 * is stored as an override. Feedback 57840a6e is why that distinction is drawn so loudly — the control
 * used to be a checkbox rendered from the company's band, so any save of the card wrote an explicit
 * "No" for every employee of an unregistered company and excluded them from the levy for ever.
 */
export function HrdfSubjectField(
  props:
    | { mode: 'form'; value: boolean | null | undefined; name?: string }
    | { mode: 'controlled'; value: string | undefined; onChange: (value: string) => void },
) {
  const t = useTranslations('people.detail');
  const current =
    props.mode === 'form'
      ? props.value == null
        ? ''
        : props.value
          ? 'yes'
          : 'no'
      : props.value === 'yes' || props.value === 'no'
        ? props.value
        : '';
  return (
    <Field label={t('subjectToHrdf')}>
      <select
        className={inputCls}
        title={t('subjectToHrdfHint')}
        {...(props.mode === 'form'
          ? { name: props.name ?? 'subjectToHrdf', defaultValue: current }
          : { value: current, onChange: (e) => props.onChange(e.target.value) })}
      >
        <option value="">{t('subjectToHrdfFollowingDefault')}</option>
        {/* `prorateYes` / `prorateNo` are the keys this select has always used — kept rather than swapped
            for a tidier-looking pair, because changing them would change the words on a live screen for
            no reason the reporter asked for. */}
        <option value="yes">{t('prorateYes')}</option>
        <option value="no">{t('prorateNo')}</option>
      </select>
    </Field>
  );
}
