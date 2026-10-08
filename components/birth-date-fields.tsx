'use client';

/**
 * Date of Birth + Age — the THIRD shared field group of item 35b7af0a (Create New Employee wizard ↔
 * Personnel (Admin) profile unification). Same shape as group 1 (components/person-details-fields.tsx):
 * one definition, a discriminated `mode`, and BOTH screens render it.
 *
 * WHAT WAS ACTUALLY WRONG, not just duplicated. The reporter listed "Date of Birth" AND "Age
 * (auto-calculated)" as Profile fields and asked that "Age automatically calculated from Date of Birth"
 * behave identically in both places. It could not: the Age figure is computed by `completedYearsAt`, which
 * lived in `core/leave.ts` — a module that imports the database. The Personnel page is a server component so
 * it could call it; the wizard is a client component so it could not, and the wizard therefore showed a bare
 * Date of Birth box with no Age at all. Group 3 moves that two-line calendar math to `lib/completed-years.ts`
 * (client-safe, re-exported from `core/leave.ts` so every existing server caller is untouched) and both
 * screens now read the SAME counter.
 *
 * AGE IS DISPLAY-ONLY AND IS NEVER STORED. It is a `<p>`, never an `<input>`, and there is no draft key and
 * no column behind it — every view recomputes it from the DOB against that day's date, so it is always exact
 * and needs no maintenance. That is a property worth stating loudly: an age that is SAVED is an age that is
 * wrong the day after it is saved.
 *
 * THE TWO MODES, and why the profile one is not simply "controlled with a different handler":
 *
 *   mode: 'form'        → uncontrolled `name` + `defaultValue`, read out of FormData by the Personnel page's
 *                         setPersonComplianceFields action. NO function prop, so a SERVER component can
 *                         render it (the r123 fault — a closure crossing the boundary — 500s every request
 *                         while tsc, the suite and the guard stay green; test/server-client-boundary.test.ts
 *                         pins the class).
 *                         UNCONTROLLED IS LOAD-BEARING HERE, not incidental: components/ic-dob-autofill.tsx
 *                         fills this field by writing `dobEl.value = iso` straight onto the DOM node by id,
 *                         with no React event. A controlled input would fight that write and lose it on the
 *                         next render, silently breaking the IC → DOB autofill (item 354a500d).
 *   mode: 'controlled'  → `value` + `onChange`, bound to the wizard's draft state. Legal there because the
 *                         wizard is itself a client component.
 *
 * The Age still updates live in BOTH modes: in form mode the component keeps its own copy of what has been
 * typed (the input stays uncontrolled — `defaultValue` + `onChange` is React's "observe, don't own" shape),
 * reset whenever the server sends a different stored DOB down. The one case it cannot see is the IC autofill
 * above, whose raw DOM write fires no event; the Age then refreshes on the next server render, exactly as it
 * did before this change.
 *
 * LABELS ARE READ WHERE THEY LIVE. `people.detail.birthDate` / `.age` / `.ageYears` — the profile screen's
 * existing keys, so no catalog gains a key and the wizard's `people.wizard.fields.dateOfBirth` stops being
 * rendered as a label. That key is DELIBERATELY NOT DELETED: `missingByTab` can return the field name
 * 'dateOfBirth' and the wizard's Review step renders it through a COMPUTED t(`fields.${f}`) that the i18n
 * static check cannot see — the same reason `fields.rateAmount` and `fields.basicSalary` were kept.
 *
 * ONE NAMESPACE PER FILE, deliberately: test/i18n-coverage.test.ts check C silently SKIPS any file using more
 * than one translation namespace, and every key below is a literal for the same reason.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Field, inputCls } from '@/components/ui';
import { DateField } from '@/components/ui/date-field';
import { completedYearsAt } from '@/lib/completed-years';

/** What an <input type="date"> can hold: '' or a complete yyyy-mm-dd. A stored draft can hold neither (it
 *  is free-form JSON), and `new Date('nonsense')` yields NaN years rather than throwing — so the Age is
 *  computed only for a well-formed date and reads "Not Available" otherwise, which is also what a blank DOB
 *  shows. `missingByTab` separately flags a malformed draft date on the step itself. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

type Mode =
  | {
      mode: 'form';
      /** DOM id for the input. The Personnel page must pass 'profile-dob-input' — ic-dob-autofill.tsx
       *  looks the field up by that id to autofill from a MyKad number. */
      inputId?: string;
      /** r422 — OPT-IN: draw the box as DD-MMM-YYYY (components/ui/date-field.tsx). Same id, name and ISO
       *  value, so the IC autofill and setPersonDetails are untouched. The Personnel profile passes it; the
       *  Create New Employee draft does not. */
      dmyDisplay?: boolean;
    }
  | { mode: 'controlled'; onChange: (value: string) => void };

export type BirthDateFieldsProps = Mode & {
  /** Current value ('' / null / undefined all mean "not recorded"). */
  dateOfBirth: string | null | undefined;
  /** The date the age is counted to, yyyy-mm-dd. Both screens already resolve "today" through the tenant
   *  timezone (`todayInKualaLumpur`) and pass it down — this component never reads a clock, so it cannot
   *  reintroduce the 00:00–08:00 MYT off-by-one. */
  today: string;
  /** Optional guidance under the date box (the wizard explains that a blank DOB is derived from the IC). */
  hint?: string;
  /** Optional extra classes on each Field wrapper, so a caller's grid decides the layout, not this file. */
  fieldClassName?: string;
};

export function BirthDateFields(props: BirthDateFieldsProps) {
  const t = useTranslations('people.detail');
  const stored = props.dateOfBirth ?? '';

  // Form mode observes its own uncontrolled input so the Age tracks what is on screen. `seen` mirrors the
  // last value the server sent: when a save (or another card's action) re-renders the page with a different
  // stored DOB, the locally typed copy is dropped and the server's value wins again. React's documented
  // "adjusting state when a prop changes" shape — no effect, no extra render pass.
  const [typed, setTyped] = useState<string | null>(null);
  const [seen, setSeen] = useState(stored);
  if (stored !== seen) {
    setSeen(stored);
    setTyped(null);
  }
  const value = props.mode === 'controlled' ? stored : (typed ?? stored);

  const years = ISO_DATE.test(value) ? completedYearsAt(value, props.today) : null;
  const ageLabel = years === null ? null : t('ageYears', { years });

  return (
    <>
      <Field label={t('birthDate')} className={props.fieldClassName}>
        {props.mode === 'form' && props.dmyDisplay ? (
          <DateField
            id={props.inputId}
            name="dateOfBirth"
            defaultValue={stored}
            onChange={(e) => setTyped(e.target.value)}
            className={inputCls}
            label={t('birthDate')}
          />
        ) : (
          <input
            type="date"
            className={inputCls}
            {...(props.mode === 'form'
              ? {
                  id: props.inputId,
                  name: 'dateOfBirth',
                  defaultValue: stored,
                  onChange: (e: React.ChangeEvent<HTMLInputElement>) => setTyped(e.target.value),
                }
              : {
                  value,
                  onChange: (e: React.ChangeEvent<HTMLInputElement>) => props.onChange(e.target.value),
                })}
          />
        )}
        {props.hint && <p className="mt-1 text-xs text-muted-foreground">{props.hint}</p>}
      </Field>
      {/* System-calculated, deliberately NOT an input — nothing to type, nothing to save. "Not Available"
          when no DOB is recorded (shares the cc681bd5 fallback key). */}
      <Field label={t('age')} className={props.fieldClassName}>
        <p className="flex h-9 items-center text-sm text-muted-foreground">
          {ageLabel ?? t('employmentInfo.notAvailable')}
        </p>
      </Field>
    </>
  );
}
