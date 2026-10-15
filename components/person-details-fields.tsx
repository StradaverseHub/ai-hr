'use client';

/**
 * Personal Details — the FIRST shared field group of item 35b7af0a (Create New Employee wizard ↔
 * Personnel (Admin) profile unification).
 *
 * ONE definition of Gender and Marital Status, rendered by BOTH screens. Before this, each screen built
 * its own selects with its own option list and its own labels, and they had already drifted: the profile
 * card offered 3 genders and 6 marital statuses, the wizard offered 2 and 2. That is not only duplicate
 * maintenance — it made 'divorced', 'widowed', 'separated' and 'undisclosed' unrecordable at hire while
 * being perfectly recordable one screen later, and #12129e77 had already written down the rule that every
 * surface offering these must draw from the same master list.
 *
 * WHY ONE COMPONENT CAN SERVE TWO VERY DIFFERENT SCREENS. They collect input in opposite ways: the
 * Personnel profile card is a server-rendered `<form action={serverAction}>` of UNCONTROLLED inputs
 * (`name` + `defaultValue`, read out of FormData on submit), while the wizard is a client component of
 * CONTROLLED inputs bound to draft state (`value` + `onChange`, never submitted as a form). So the mode is
 * an explicit discriminated prop rather than something inferred:
 *
 *   mode: 'form'        → name + defaultValue. NO function props, which is what makes this safe to render
 *                         from the server Personnel page (the r123 fault, pinned by
 *                         test/server-client-boundary.test.ts, is a server component handing a client
 *                         component a closure — React cannot serialise one and the whole page 500s).
 *   mode: 'controlled'  → value + onChange. Only ever used from the wizard, which is itself a client
 *                         component, where a function prop is legal.
 *
 * LABELS ARE READ WHERE THEY LIVE, not copied. This uses the profile screen's existing `people.detail.*`
 * keys — no new key is minted and none of the six catalogs needs a new translation. The wizard's own
 * `people.wizard.fields.gender` / `.maritalStatus` and its `gender.*` / `marital.*` value labels are
 * retired by this change, which is the "no second wording that can drift" half of the item.
 *
 * ONE NAMESPACE PER FILE, deliberately: test/i18n-coverage.test.ts check C silently SKIPS any file that
 * uses more than one translation namespace, so a second `useTranslations` here would take these labels out
 * of the guard. Every option label below is written as a literal key for the same reason — a computed
 * lookup such as t(KEY_FOR[value]) is invisible to that check. (Check C scans this file's COMMENTS too,
 * so an illustrative quoted key inside a t(…) here would itself be reported as unresolved.)
 */

import { useTranslations } from 'next-intl';
import { Field, inputCls } from '@/components/ui';
import { PERSONNEL_FIELDS } from '@/lib/personnel-field-registry';
import { personnelFieldChoices } from '@/lib/personnel-import-contract';

type Mode =
  | { mode: 'form' }
  | {
      mode: 'controlled';
      onGenderChange: (value: string) => void;
      onMaritalStatusChange: (value: string) => void;
    };

export type PersonDetailsFieldsProps = Mode & {
  /** Current values ('' / null / undefined all mean "not set"). */
  gender: string | null | undefined;
  maritalStatus: string | null | undefined;
  /** Optional extra classes on each Field wrapper, so a caller's grid decides the layout, not this file. */
  fieldClassName?: string;
};

export function PersonDetailsFields(props: PersonDetailsFieldsProps) {
  const t = useTranslations('people.detail');
  const field=(key:string)=>PERSONNEL_FIELDS.find(field=>field.owner==='person' && field.ownerField===key)!;
  const fieldLabel=(key:string)=>t(field(key).labelKey.replace(/^people\.detail\./,''));
  const gender = props.gender ?? '';
  const maritalStatus = props.maritalStatus ?? '';


  return (
    <>
      <Field label={fieldLabel('gender')} className={props.fieldClassName}>
        <select
          className={inputCls}
          {...(props.mode === 'form'
            ? { name: 'gender', defaultValue: gender }
            : { value: gender, onChange: (e) => props.onGenderChange(e.target.value) })}
        >
          <option value="">{t('genderNotSet')}</option>
          {personnelFieldChoices(field('gender')).map((option) => (
            <option key={option.value} value={option.value}>
              {t(option.labelKey.replace(/^people\.detail\./,''))}
            </option>
          ))}
        </select>
      </Field>
      <Field label={fieldLabel('maritalStatus')} className={props.fieldClassName}>
        <select
          className={inputCls}
          {...(props.mode === 'form'
            ? { name: 'maritalStatus', defaultValue: maritalStatus }
            : { value: maritalStatus, onChange: (e) => props.onMaritalStatusChange(e.target.value) })}
        >
          <option value="">{t('maritalNotSet')}</option>
          {personnelFieldChoices(field('maritalStatus')).map((option) => (
            <option key={option.value} value={option.value}>
              {t(option.labelKey.replace(/^people\.detail\./,''))}
            </option>
          ))}
        </select>
      </Field>
    </>
  );
}
