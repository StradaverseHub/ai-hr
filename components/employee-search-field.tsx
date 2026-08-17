'use client';

import { useId, useMemo, useRef, useState } from 'react';
import { inputCls } from '@/components/ui';
import { employeeLabel } from '@/lib/employee-code';
import { EMPLOYEE_SEARCH_RESULT_CAP, matchEmployees } from '@/lib/employee-search';

/**
 * WHO MOUNTS THIS (the header used to say "nobody", and that stopped being true):
 *   • the two Leave Inquiry pickers — app/leave/employee-balances + employee-records (38b94df7),
 *   • the authorised-signatory picker on each statutory card in components/company-panel.tsx (3c2f55d7
 *     rev 2), which is the first consumer to post a PERSON id rather than an employment id — `value` is
 *     whatever the caller wants submitted, so that needed no change here.
 *
 * The two screens it was originally built for (98e69987 Transaction Detail, f35f758a Individual Payslip)
 * both reverted to the left-hand panel in r185 after the reporter reviewed the search-box layout live and
 * asked for the list back; `payroll.individualPayslip.search*` still carries a caption set for them in all
 * six catalogues, and test/employee-scope-panel-guard.test.ts asserts those two screens mount this control
 * ZERO times. Keeping it was the right call rather than deleting a working, tested control and
 * re-deriving it. `lib/employee-search.ts` is a separate matter and has live consumers either way (via
 * `app/admin/personnel/employee-search.ts`).
 *
 * ───────────────────────────────────────────────────────────────────────────────────────────────────
 * THE SHARED "search for an employee" FILTER FIELD — built once for 98e69987 (Transaction Detail) and
 * f35f758a (Individual Payslip), which both asked for the same thing in the same words: put a searchable
 * employee box at the TOP of the page, inside the filter row, instead of a left-hand list panel.
 *
 * HOW IT DIFFERS FROM THE TWO CONTROLS THAT ALREADY EXIST, because the difference is the whole reason this
 * file is here rather than a third caller of one of them:
 *
 *  - `app/admin/personnel/employee-switcher.tsx` searches the same way but NAVIGATES: picking a person is
 *    `router.push(...)`. That is right for a switcher between profile routes and wrong for a filter, where
 *    the choice has to sit still until the reader presses Apply alongside the other filters.
 *  - `components/ui/combobox.tsx` posts a value the right way but filters with a plain case-insensitive
 *    substring over the label, with no cap and no ranking — so "emp0008" would not find "EMP-0008", and a
 *    company with 2,000 people would render 2,000 <li>s. The employee rule is `matchEmployees`, and it is
 *    the rule the rest of the product already searches employees by.
 *
 * SO: form-native like the Combobox, ranked and capped like the switcher, and it never navigates.
 *
 * FORM CONTRACT — this is the part a consumer must get right:
 *   • The committed selection is carried by a HIDDEN input named `name`. Drop this component where a
 *     `<select name="emp">` used to be inside a `<form method="GET">` and the submitted query string is
 *     unchanged.
 *   • The VISIBLE text box deliberately has NO `name`. In a GET form every named control lands in the
 *     address bar; a stray `?=john%20t` would ride along on every Apply.
 *   • The box always shows WHAT WILL BE SUBMITTED. Typing clears the committed value, and leaving the
 *     field without picking a row snaps the text back to the committed selection (or to empty). An
 *     uncommitted string is not a filter, and showing one would be a lie the reader only discovers after
 *     pressing Apply.
 *   • ENTER: with the result list open it PICKS the highlighted row (and stops there). With the list
 *     closed it does what Enter normally does in a form — submits. So type, Enter to pick, Enter to apply.
 *
 * EVERY PROP IS PLAIN DATA — no callbacks, by design and not by taste. Both consumers are SERVER
 * components, and a function crossing that boundary is a 500 on every request that tsc, `next build` and
 * the whole suite stay green through (r123). There is deliberately no `onChange` here to tempt anyone.
 *
 * LABELS ARRIVE PRE-TRANSLATED, the way `CollapsibleEmployeePanel` and `ReplacementEligibilityPicker`
 * take theirs: the caller does the literal `t('…')` lookup so the i18n coverage guard can still see the
 * key on the page that owns it, and this file needs no namespace of its own.
 */

/** One searchable row. `value` is whatever the caller wants the form to post — usually an employmentId. */
export type EmployeeSearchOption = {
  /** What the hidden input carries when this row is chosen. */
  value: string;
  name: string;
  employeeCode: string | null;
  /** Optional second line, e.g. "Alpha Sdn Bhd · Finance". A plain string — never a node. */
  secondary?: string | null;
};

/** The five captions this control shows. All required: nothing here invents English. */
export type EmployeeSearchFieldLabels = {
  /** Empty-box prompt, e.g. "Search by Employee ID or name". */
  placeholder: string;
  /** Accessible name for the text box, e.g. "Search employee". */
  ariaLabel: string;
  /** Accessible name for the result list, e.g. "Employee search results". */
  resultsLabel: string;
  /** Shown in place of the list when nothing matches, e.g. "No matching employee". */
  noMatches: string;
  /** Accessible name for the × button, e.g. "Clear employee". */
  clear: string;
};

export function EmployeeSearchField({
  name,
  employees,
  value,
  labels,
  cap = EMPLOYEE_SEARCH_RESULT_CAP,
  id,
  className,
  dataTour,
}: {
  /** The form field name the committed selection posts under. */
  name: string;
  /** Already scope-fenced by the caller. This control only ever narrows it. */
  employees: EmployeeSearchOption[];
  /**
   * The value already in the address bar, so a reload comes back showing the same person. A value that is
   * NOT in `employees` is treated as no selection: the list is the caller's scoped read, so an id missing
   * from it is one this reader may not filter by, and silently re-posting it would carry it forward.
   */
  value?: string | null;
  labels: EmployeeSearchFieldLabels;
  /** How many rows the list offers at once. Defaults to the shared cap the Personnel switcher uses. */
  cap?: number;
  /** Set it when the caller renders its own <label htmlFor>. */
  id?: string;
  /** Width lives on the WRAPPER: `inputCls` already carries `w-full`, so `${inputCls} w-64` is a no-op. */
  className?: string;
  dataTour?: string;
}) {
  const listId = useId();
  const optionIdBase = useId();
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const labelOf = (o: EmployeeSearchOption) => employeeLabel(o.employeeCode, o.name);
  const initial = (value && employees.find((e) => e.value === value)) || null;

  const [selected, setSelected] = useState(initial ? initial.value : '');
  const [query, setQuery] = useState(initial ? labelOf(initial) : '');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const results = useMemo(() => matchEmployees(employees, query, cap), [employees, query, cap]);
  /**
   * The list is open exactly while there is UNCOMMITTED text. Typing always clears `selected`, so this
   * reads as "you are searching". Gating on the text alone instead would re-open the list on a committed
   * field the moment it regained focus — and the query would then be the committed label
   * ("EMP-0008 · Aisha Rahman"), which the matcher rightly finds nobody for, so the reader would be told
   * "No matching employee" about the person the box is currently showing.
   */
  const showList = open && selected === '' && query.trim() !== '';

  const commit = (o: EmployeeSearchOption) => {
    setSelected(o.value);
    setQuery(labelOf(o));
    setOpen(false);
  };

  /** Back to "no employee filter" — and keep the caret in the box so the reader can type another name. */
  const clear = () => {
    setSelected('');
    setQuery('');
    setOpen(false);
    setActive(0);
    inputRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      if (!open) return;
      e.preventDefault();
      setOpen(false);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      if (results.length) setActive((i) => (i + 1) % results.length);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      if (results.length) setActive((i) => (i - 1 + results.length) % results.length);
      return;
    }
    if (e.key === 'Enter') {
      // Only swallow Enter when there is actually something to pick. With the list closed or empty this
      // falls through to the surrounding form's submit, which is what a filter row's Enter should do.
      if (!showList || !results.length) return;
      e.preventDefault();
      const pick = results[Math.min(active, results.length - 1)];
      if (pick) commit(pick);
    }
  };

  return (
    <div
      ref={boxRef}
      className={`relative ${className ?? 'w-full sm:w-72'}`}
      // Closing on blur rather than on a document listener keeps this island free of effects; the
      // contains() check is what stops a click on a RESULT from closing the list before it commits.
      onBlur={(e) => {
        if (boxRef.current?.contains(e.relatedTarget as Node | null)) return;
        setOpen(false);
        const still = selected ? employees.find((x) => x.value === selected) : null;
        setQuery(still ? labelOf(still) : '');
      }}
    >
      {/* The value the surrounding <form> submits — the same field a native <select> would have posted. */}
      <input type="hidden" name={name} value={selected} />

      <input
        ref={inputRef}
        id={id}
        type="text"
        role="combobox"
        autoComplete="off"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-label={labels.ariaLabel}
        aria-activedescendant={showList && results.length ? `${optionIdBase}-${Math.min(active, results.length - 1)}` : undefined}
        data-tour={dataTour}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          // What was typed is no longer the committed choice. Until a row is picked this field posts
          // nothing, so an Apply pressed mid-typing filters by everything else and says so on screen.
          setSelected('');
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder={labels.placeholder}
        // `pr-8` clears the × button. Unlike the `${inputCls} w-<n>` trap (w-full wins because both
        // land in the SAME width namespace and `w-full` is emitted later), `px-*` and `pr-*` are
        // different Tailwind namespaces with a fixed emission order — pr after px — so this one applies.
        className={`${inputCls} pr-8`}
      />

      {(query !== '' || selected !== '') && (
        // type="button" is load-bearing: a bare <button> inside a <form> submits it.
        <button
          type="button"
          onClick={clear}
          aria-label={labels.clear}
          className="absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      )}

      {showList && (
        <div
          id={listId}
          role="listbox"
          aria-label={labels.resultsLabel}
          className="absolute left-0 z-50 mt-1 max-h-80 w-[min(24rem,90vw)] overflow-y-auto rounded-md border border-border bg-popover text-popover-foreground shadow-lg"
        >
          {results.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">{labels.noMatches}</p>
          ) : (
            results.map((o, i) => (
              <button
                key={o.value}
                id={`${optionIdBase}-${i}`}
                type="button"
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                // mousedown, not click: commit before the wrapper's blur handler can close the list.
                onMouseDown={(e) => {
                  e.preventDefault();
                  commit(o);
                }}
                className={`flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-sm transition-colors hover:bg-muted ${
                  i === active ? 'bg-muted' : ''
                }`}
              >
                {/* The row text and the box text are the SAME string on purpose — what you clicked is
                    literally what the field then shows. `employeeLabel` is the house ID-left-of-name form. */}
                <span className="block w-full truncate font-medium text-foreground">{labelOf(o)}</span>
                {o.secondary ? (
                  <span className="block w-full truncate text-xs text-muted-foreground">{o.secondary}</span>
                ) : null}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
