'use client';

import { useEffect, useRef, useState } from 'react';
import { Field } from '@/components/monolith/field';
import { choosePeriod, periodMonths, periodYears } from '../criteria';
import { HOLD_PERIODS, holdContinue } from './criteria-submit';

/**
 * Board 66175cd2 — PAYROLL YEAR AND PAYROLL MONTH, LISTING ONLY THE PERIODS THE FORM CAN BE PRODUCED FOR.
 *
 * For a form that declares `availablePeriods` (Borang A and BBCD) the criteria step draws this instead of
 * the generic selects. The server renders it with the default company's list (no flicker, nothing fetched
 * on arrival); when the operator changes the Company on the SAME form, this island re-asks
 * `PERIODS_ENDPOINT` for that company and re-draws both lists, opening on the newest listed month.
 *
 * IT READS THE FORM, IT DOES NOT OWN IT. The Company select stays a plain server-rendered control; this
 * island listens to the form's `change` events for it. The two selects it draws carry the destination's own
 * field names, so the form still submits `companyId`, `year` and `month` exactly as before.
 *
 * WHEN IT CHANGES THE MONTH ITSELF (a new company, or a new year whose months differ) it announces a
 * `change` on the Month select, so the Payroll Cycle list beside it (`./cycles-criterion.tsx`, which
 * listens to the same form) re-lists for the month now shown. Its own listener ignores that event: it reacts
 * only to the Company select.
 *
 * NOTHING LISTED ⇒ one plain sentence, both selects empty and disabled, the Payroll Cycle box hidden and
 * Continue held (`holdContinue`). While a company's list is loading Continue is held too, so a press cannot
 * pair the new company with the old company's month. The server-side Continue gate is unchanged: a
 * hand-edited link to an unlisted month is still refused by the form's own preview.
 *
 * Serialisable props only (it is mounted by a server component).
 */
export function PeriodCriterion({
  formId,
  endpoint,
  companyField,
  yearField,
  monthField,
  initialCompanyId,
  initialPeriods,
  initialYear,
  initialMonth,
  monthNames,
  selectClassName,
  strings,
}: {
  formId: string;
  endpoint: string;
  companyField: string;
  yearField: string;
  monthField: string;
  initialCompanyId: string;
  /** `YYYY-MM`, newest first, for `initialCompanyId`. */
  initialPeriods: string[];
  initialYear: string;
  initialMonth: string;
  /** `'01'` … `'12'` → the month's name in the viewer's language. */
  monthNames: Record<string, string>;
  selectClassName: string;
  strings: { year: string; month: string; hint: string; none: string };
}) {
  const monthRef = useRef<HTMLSelectElement>(null);
  const [periods, setPeriods] = useState<string[]>(initialPeriods);
  const [year, setYear] = useState(initialYear);
  const [month, setMonth] = useState(initialMonth);
  const [loading, setLoading] = useState(false);
  const requestId = useRef(0);
  const announced = useRef(false);

  // Re-list when the COMPANY on the same form changes. Nothing else on the form moves this list.
  useEffect(() => {
    const form = monthRef.current?.closest('form');
    if (!form) return;
    const onChange = (e: Event) => {
      const el = e.target as HTMLSelectElement | null;
      if (!el || el.name !== companyField) return;
      const mine = ++requestId.current;
      setLoading(true);
      const url = `${endpoint}?form=${encodeURIComponent(formId)}&companyId=${encodeURIComponent(el.value)}`;
      fetch(url, { headers: { Accept: 'application/json' } })
        .then((r) => (r.ok ? r.json() : { periods: [] }))
        .then((body: { periods?: unknown }) => {
          // A reply that resolves after a newer request started is DROPPED: the slow answer for the company
          // the operator moved away from must not land under the one they chose.
          if (mine !== requestId.current) return;
          const list = Array.isArray(body.periods) ? body.periods.filter((p): p is string => typeof p === 'string') : [];
          const chosen = choosePeriod(list);
          setPeriods(list);
          setYear(chosen?.year ?? '');
          setMonth(chosen?.month ?? '');
          setLoading(false);
        })
        .catch(() => {
          if (mine !== requestId.current) return;
          // A failed fetch lists NOTHING, never "every month": the operator sees the sentence and can retry.
          setPeriods([]);
          setYear('');
          setMonth('');
          setLoading(false);
        });
    };
    form.addEventListener('change', onChange);
    return () => form.removeEventListener('change', onChange);
  }, [companyField, endpoint, formId]);

  const empty = periods.length === 0;

  // Continue, and the Payroll Cycle box, follow the list.
  useEffect(() => {
    const form = monthRef.current?.closest('form');
    if (!form) return;
    if (empty) form.dataset.periodsEmpty = 'true';
    else delete form.dataset.periodsEmpty;
    holdContinue(form, HOLD_PERIODS, empty || loading);
  }, [empty, loading]);

  // Tell the Payroll Cycle list the month changed — but not on arrival, when it already read the server's.
  useEffect(() => {
    if (!announced.current) {
      announced.current = true;
      return;
    }
    monthRef.current?.dispatchEvent(new Event('change', { bubbles: true }));
  }, [year, month, periods]);

  const years = periodYears(periods);
  const months = year ? periodMonths(periods, year) : [];

  return (
    <>
      <Field label={strings.year}>
        <select
          name={yearField}
          value={year}
          disabled={empty}
          onChange={(e) => {
            const y = e.target.value;
            setYear(y);
            // The newest month of the year chosen — every month offered here has something to file.
            setMonth(periodMonths(periods, y)[0] ?? '');
          }}
          className={selectClassName}
          required
          data-period-year
        >
          {years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
      </Field>
      <Field label={strings.month}>
        <select
          ref={monthRef}
          name={monthField}
          value={month}
          disabled={empty}
          onChange={(e) => setMonth(e.target.value)}
          className={selectClassName}
          required
          data-period-month
        >
          {months.map((m) => (
            <option key={m} value={m}>
              {monthNames[m] ?? m}
            </option>
          ))}
        </select>
      </Field>
      <p
        role={empty ? 'status' : undefined}
        data-periods-note={empty ? 'none' : 'hint'}
        className={`text-xs sm:col-span-2 lg:col-span-3 ${
          empty
            ? 'border-l-2 border-amber-500 pl-3 text-amber-800 dark:text-amber-300 monolith:border-signal monolith:text-signal-text'
            : 'text-muted-foreground monolith:text-[12px] monolith:text-mid'
        }`}
      >
        {empty ? strings.none : strings.hint}
      </p>
    </>
  );
}
