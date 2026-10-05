'use client';

import { useEffect, useId, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { EmployeeName, inputCls } from '@/components/ui';
import { switcherHref, type SwitcherEmployee } from './employee-search';
import { searchPersonnelEmployeesAction } from './search-actions';
import { firstDirtyGuard } from '@/lib/unsaved-changes';

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
 * sharing: the same "partial ID or partial name" rule.
 *
 * Search is bounded on the server over the whole reachable population. No employee list crosses the
 * initial page boundary. The imported server action re-resolves the admin and company scope; selection
 * is a URL, which also keeps the profile's scope guard in charge:
 * the profile route re-resolves the chosen id with `employeeDetail(s, id)` and 404s if it comes back
 * null, so a result list can never be the thing that grants access.
 */
export function EmployeeSwitcher({
  currentEmploymentId,
  tab,
}: {
  /** The employee whose profile is open, if any — shown as "current" so a jump is obviously a jump. */
  currentEmploymentId?: string | null;
  /** The profile tab to keep open across the jump. Null on the listing, which has no tab. */
  tab?: string | null;
}) {
  const t = useTranslations('people.switcher');
  const tState = useTranslations('commandBar');
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const listId = useId();
  const boxRef = useRef<HTMLDivElement>(null);

  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [retry, setRetry] = useState(0);
  const [answer, setAnswer] = useState<{ query: string; rows: SwitcherEmployee[]; failed: boolean } | null>(null);
  const results = answer?.query === query ? answer.rows : [];
  const loading = query.trim() !== '' && answer?.query !== query;
  const failed = answer?.query === query && answer.failed;

  useEffect(() => {
    if (!query.trim()) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const rows = await searchPersonnelEmployeesAction(query);
        if (!cancelled) setAnswer({ query, rows, failed: false });
      } catch {
        if (!cancelled) setAnswer({ query, rows: [], failed: true });
      }
    }, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, retry]);

  /**
   * 420ebab5 part two — "Open another employee" is one of the ways the reporter named for leaving a
   * profile with unsaved edits, and this one navigates PROGRAMMATICALLY. The save scope's own guard
   * watches anchor clicks and `beforeunload`, and a `router.push` is neither, so the switcher has to ask
   * for itself. Same registry the tab strip uses (lib/unsaved-changes.ts); when no scope is mounted — the
   * Personnel listing, where this is also rendered — `firstDirtyGuard()` is null and the jump is
   * immediate, exactly as before.
   */
  const go = (employmentId: string) => {
    setOpen(false);
    const jump = () => startTransition(() => router.push(switcherHref(employmentId, tab)));
    const guard = firstDirtyGuard();
    if (guard) {
      guard.prompt(jump);
      return;
    }
    jump();
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
      // A result click must not close the list before it navigates.
      onBlur={(e) => {
        if (!boxRef.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <input
        type="search"
        maxLength={200}
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-busy={loading}
        aria-activedescendant={showList && results.length ? `${listId}-${Math.min(active, results.length - 1)}` : undefined}
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
        // Steps DOWN on small screens rather than staying 18rem wide: both mounts sit in a header
        // actions group the shared PageHeader marks `shrink-0`, so a fixed width here is a page-level
        // horizontal scroll on a phone.
        className={`${inputCls} h-9 w-52 sm:w-64 md:w-72`}
      />

      {showList && (
        <div
          id={listId}
          role="listbox"
          aria-label={t('resultsLabel')}
          className="absolute right-0 z-50 mt-1 max-h-80 w-[min(22rem,90vw)] overflow-y-auto rounded-md border border-border bg-popover text-popover-foreground shadow-lg"
        >
          {loading ? (
            <p role="status" className="px-4 py-6 text-center text-sm text-muted-foreground">{tState('loading')}</p>
          ) : failed ? (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              <p role="alert">{tState('loadError')}</p>
              <button type="button" className="mt-2 underline" onClick={() => { setAnswer(null); setRetry((value) => value + 1); }}>{tState('retry')}</button>
            </div>
          ) : results.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">{t('noMatches')}</p>
          ) : (
            results.map((e, i) => {
              const isCurrent = e.employmentId === currentEmploymentId;
              return (
                <button
                  key={e.employmentId}
                  id={`${listId}-${i}`}
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
