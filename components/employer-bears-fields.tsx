'use client';

/**
 * THE "EMPLOYER BEARS" SWITCHES — EPF, SOCSO, EIS and SKBBK — shared between the Personnel Bank &
 * Statutory tab and the Create New Employee draft (item a72610af).
 *
 * WHAT THE SWITCH MEANS, because it is easy to read as "do not contribute" and it is the opposite: the
 * contribution is still COMPUTED AND REPORTED IN FULL, on both legs, in every statutory file. What
 * changes is who funds the EMPLOYEE's share — the employer, out of cost, instead of a deduction from net
 * pay. Ticking one never changes a figure on a statutory return; it changes a figure on a payslip.
 *
 * ONE SWITCH PER CALL, NOT ONE BLOCK OF FOUR, and that is deliberate. The Personnel card keeps the EPF
 * switch inside the EPF fieldset and the other three inside the SOCSO & EIS fieldset, beside the scheme
 * each belongs to. A single grouped component would have had to MOVE the EPF one, which is a visible
 * change to a screen this item was not asked to redesign. Sharing the switch rather than the layout keeps
 * both screens' grouping intact while the label, the hint and the yes/no encoding have one definition.
 *
 *   mode: 'form'        → an `on`/absent checkbox read out of FormData by `setStatutoryAction`.
 *   mode: 'controlled'  → 'yes' | 'no' bound to the draft's React state, and NO `name` at all.
 *
 * WHY THE DRAFT STORES 'yes'/'no' RATHER THAN A BOOLEAN: every other value in `EmployeeDraftStatutory`
 * is a string, and `hasAnyStatutory` (core/employee-draft.ts) decides whether a statutory row is created
 * at all by trimming each one. A boolean in that section would throw there. 'no' and ABSENT mean the same
 * thing to the writer (`?? false`, the column default), so nothing is lost.
 *
 * LABELS FROM `people.detail.employerBears*` — the Personnel card's own keys; no message key is added.
 */
import { useTranslations } from 'next-intl';

/** The four schemes, in the order the Personnel card names them within each of its two fieldsets. */
export const EMPLOYER_BEARS_FIELDS = [
  'employerBearsEpf',
  'employerBearsSocso',
  'employerBearsEis',
  'employerBearsSkbbk',
] as const;
export type EmployerBearsField = (typeof EMPLOYER_BEARS_FIELDS)[number];

export function EmployerBearsSwitch(
  props:
    | { mode: 'form'; field: EmployerBearsField; defaultChecked: boolean }
    | { mode: 'controlled'; field: EmployerBearsField; value: string | undefined; onChange: (value: string) => void },
) {
  const t = useTranslations('people.detail');
  // One literal per field, never a computed key: a template key is invisible to
  // test/i18n-coverage.test.ts check C, and these four labels are the point of sharing the control.
  const label = {
    employerBearsEpf: t('employerBearsEpf'),
    employerBearsSocso: t('employerBearsSocso'),
    employerBearsEis: t('employerBearsEis'),
    employerBearsSkbbk: t('employerBearsSkbbk'),
  }[props.field];
  // Only EPF has its own hint on the Personnel card; the other three share the fieldset's one. Passing
  // the shared hint as a title on each keeps the draft — which has no fieldset legend — as informative.
  const title = props.field === 'employerBearsEpf' ? t('employerBearsEpfHint') : t('employerBearsHint');

  return (
    <label className="flex items-center gap-2 text-sm" title={title}>
      <input
        type="checkbox"
        className="size-4 rounded"
        {...(props.mode === 'form'
          ? { name: props.field, defaultChecked: props.defaultChecked }
          : {
              checked: props.value === 'yes',
              onChange: (e) => props.onChange(e.target.checked ? 'yes' : 'no'),
            })}
      />
      {label}
    </label>
  );
}
