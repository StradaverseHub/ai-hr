'use client';

import { useId, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { EmployeeName, inputCls } from '@/components/ui';
import { SWITCHER_RESULT_CAP, matchEmployees, switcherHref, type SwitcherEmployee } from './employee-search';

/**
 * c002b3c3 — "Search Employee": type part of an Employee ID or a name and go straight to that person's
 * profile, instead of going back to the list to find them. Mounted twice, in the same top-right position
 * both times: beside the Filter button on the Personnel listing, and beside the status badge on a
 * profile.
 *
 * WHY THIS IS ITS OWN CHROME, next to `components/collapsible-employee-panel.tsx` rather than inside it.
 * That component is the payroll screens' PERSISTENT LEFT RAIL: it owns a two-column grid, collapses
 * horizontally, and hands its width to a workspace that stays on the same page. This is a top-of-page
 * SWITCHER that NAVIGATES — there is no second column to give width to, and the page it lands on is a
 * different route. Forcing one layout on both would give the profile a rail it has no room for and give
 * the transaction screens a control that leaves the screen. What the two DO share is the thing worth
 * sharing: the same scoped read (`listEmployees`) and the same "partial ID or partial name" rule.
 *
 * EVERY PROP IS PLAIN DATA. Both callers are SERVER components; a function crossing that boundary is a
 * 500 on every request that tsc, the suite and `next build` all stay green through (r123). There is no
 * callback here — selection is a URL, which is also what keeps the server-side scope guard in charge:
 * the profile route re-resolves the chosen id with `employeeDetail(s, id)` and 404s if it comes back
 * null, so a result list can never be the thing that grants access.
 */
export function EmployeeSwitcher({
  employees,
  currentEmploymentId,
  tab,
}: {
  /** Already scope-fenced by the caller. This component only ever narrows it. */
  employees: SwitcherEmployee[];
  /** The employee whose profile is open, if any — shown as "current" so a jump is obviously a jump. */
  currentEmploymentId?: string | null;
  /** The profile tab to keep open across the jump. Null on the listing, which has no tab. */
  tab?: string | null;
}) {
  const t = useTranslations('people.switcher');
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const listId = useId();
  const boxRef = useRef<HTMLDivElement>(null);

  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const results = useMemo(
    () => matchEmployees(employees, query, SWITCHER_RESULT_CAP),
    [employees, query],
  );

  const go = (employmentId: string) => {
    setOpen(false);
    startTransition(() => router.push(switcherHref(employmentId, tab)));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (!results.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((i) => (i + 1) % results.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setOpen(true);
      setActive((i) => (i - 1 + results.length) % results.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = results[Math.min(active, results.length - 1)];
      if (pick) go(pick.employmentId);
    }
  };

  const showList = open && query.trim() !== '';

  return (
    <div
      ref={boxRef}
      className="relative"
      // Closing on blur rather than on a document listener keeps this island free of effects; the
      // contains() check is what stops a click on a RESULT from closing the list before it navigates.
      onBlur={(e) => {
        if (!boxRef.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <input
        type="search"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-label={t('ariaLabel')}
        data-tour="personnel-employee-switcher"
        value={query}
        disabled={isPending}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder={t('placeholder')}
        className={`${inputCls} h-9 w-56 sm:w-72`}
      />

      {showList && (
        <div
          id={listId}
          role="listbox"
          aria-label={t('resultsLabel')}
          className="absolute right-0 z-50 mt-1 max-h-80 w-[min(22rem,90vw)] overflow-y-auto rounded-md border border-border bg-popover text-popover-foreground shadow-lg"
        >
          {results.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">{t('noMatches')}</p>
          ) : (
            results.map((e, i) => {
              const isCurrent = e.employmentId === currentEmploymentId;
              return (
                <button
                  key={e.employmentId}
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => go(e.employmentId)}
                  disabled={isPending}
                  className={`flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-muted disabled:opacity-60 ${
                    i === active ? 'bg-muted' : ''
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <EmployeeName
                      code={e.employeeCode}
                      name={e.name}
                      className="block truncate font-medium text-foreground"
                    />
                    <span className="block truncate text-xs text-muted-foreground">
                      {e.company}
                      {e.department ? ` · ${e.department}` : ''}
                    </span>
                  </span>
                  {isCurrent && (
                    <span className="shrink-0 text-xs font-medium text-muted-foreground">
                      {t('currentTag')}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
