'use client';

/**
 * EPF registration — EPF Number + EPF Citizenship. The FOURTH shared field group of item 35b7af0a (Create
 * New Employee wizard ↔ Personnel (Admin) Bank & Statutory tab). Same shape as groups 1–3: one definition,
 * a discriminated `mode`, both screens render it.
 *
 * WHAT THE TWO COPIES DISAGREED ABOUT, and why it is worth a group of its own:
 *
 *   1. WORDING. The wizard said "Citizen / Permanent resident / Non-citizen"; the Personnel tab says
 *      "Malaysian citizen / Permanent resident (PR) / Non-citizen (foreign worker)". Same three stored
 *      values, two vocabularies — exactly the drift this item exists to stop. The Personnel wording wins
 *      because it is the one an HR administrator sees for the rest of the employee's life.
 *
 *   2. A FOURTH OPTION THAT CANNOT BE STORED. The wizard offered "— Not set —" as well. `epf_citizenship`
 *      is `NOT NULL DEFAULT 'citizen'` (db/schema.ts), so choosing "not set" at hire silently produced
 *      'citizen' anyway — and the Personnel screen then showed "Malaysian citizen" for a foreign worker
 *      whose recruiter had deliberately left it blank. The option promised a state the database has never
 *      been able to hold. It is gone; both screens now show the same three real choices, defaulted the same
 *      way the column is.
 *
 * THE DEFAULT IS DISPLAYED, NOT WRITTEN. In controlled mode the caller keeps its own value and this
 * component only falls back to 'citizen' for DISPLAY. That distinction is load-bearing for the wizard:
 * `completeEmployeeDraft` creates the whole Malaysian statutory row only when at least one statutory field
 * is non-blank (`hasAnyStatutory`), so writing 'citizen' into the draft merely because the field was shown
 * would conjure a statutory row for every hire that has none today. Leaving the draft key absent produces
 * the identical stored value — via the column default — and changes nothing else.
 *
 *   mode: 'form'        → `name` + `defaultValue`, read out of FormData by setStatutoryAction. NO function
 *                         prop, so the Personnel page (a server component) can render it — the r123 fault
 *                         is a closure crossing the RSC boundary, pinned by test/server-client-boundary.
 *   mode: 'controlled'  → `value` + `onChange`, bound to the wizard's draft state.
 *
 * ONE NAMESPACE PER FILE and every key a literal: test/i18n-coverage.test.ts check C skips multi-namespace
 * files and cannot see a computed key.
 */

import { useTranslations } from 'next-intl';
import { Field, inputCls } from '@/components/ui';

/** Client-safe mirror of the `epf_citizenship` Postgres enum (db/schema.ts) — no DB import from a
 *  'use client' module, the same arrangement components/pay-structure-fields.tsx uses for the pay unions.
 *  The column is NOT NULL DEFAULT 'citizen', which is why there is no blank member here. */
export const EPF_CITIZENSHIP_OPTIONS = ['citizen', 'pr', 'non_citizen'] as const;
export type EpfCitizenshipOption = (typeof EPF_CITIZENSHIP_OPTIONS)[number];

type Mode =
  | { mode: 'form' }
  | {
      mode: 'controlled';
      onChange: (patch: { epfNumber?: string; epfCitizenship?: string }) => void;
    };

export type EpfRegistrationFieldsProps = Mode & {
  epfNumber: string | null | undefined;
  /** '' / null / undefined all mean "never chosen" and DISPLAY as the column default, 'citizen'. */
  epfCitizenship: string | null | undefined;
  /** Optional extra classes on each Field wrapper, so a caller's grid decides the layout, not this file. */
  fieldClassName?: string;
};

export function EpfRegistrationFields(props: EpfRegistrationFieldsProps) {
  const t = useTranslations('people.detail');
  const epfNumber = props.epfNumber ?? '';
  // A stored value that is not one of the three (a legacy or half-written draft) falls back to the column
  // default rather than leaving the select showing an option it is not actually set to.
  const citizenship = EPF_CITIZENSHIP_OPTIONS.includes(
    (props.epfCitizenship ?? '') as EpfCitizenshipOption,
  )
    ? (props.epfCitizenship as EpfCitizenshipOption)
    : 'citizen';

  // Literal keys, one branch per value — see the namespace note above. Exhaustiveness is enforced by the
  // option type: adding a member without adding its label here is a type error, not a raw key on screen.
  const citizenshipLabel = (c: EpfCitizenshipOption): string =>
    c === 'citizen'
      ? t('epfCitizenshipCitizen')
      : c === 'pr'
        ? t('epfCitizenshipPr')
        : t('epfCitizenshipNonCitizen');

  return (
    <>
      <Field label={t('epfNumber')} className={props.fieldClassName}>
        <input
          className={inputCls}
          placeholder="123456789"
          {...(props.mode === 'form'
            ? { name: 'epfNumber', defaultValue: epfNumber }
            : {
                value: epfNumber,
                onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
                  props.onChange({ epfNumber: e.target.value }),
              })}
        />
      </Field>
      <Field label={t('epfCitizenship')} className={props.fieldClassName}>
        <select
          className={inputCls}
          {...(props.mode === 'form'
            ? { name: 'epfCitizenship', defaultValue: citizenship }
            : {
                value: citizenship,
                onChange: (e: React.ChangeEvent<HTMLSelectElement>) =>
                  props.onChange({ epfCitizenship: e.target.value }),
              })}
        >
          {EPF_CITIZENSHIP_OPTIONS.map((c) => (
            <option key={c} value={c}>
              {citizenshipLabel(c)}
            </option>
          ))}
        </select>
      </Field>
    </>
  );
}
