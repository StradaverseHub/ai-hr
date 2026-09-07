'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  ALL_ROW_CEILING,
  PAGE_SIZE_OPTIONS,
  lastPage,
  pageNumbers,
  parsePageQuery,
  parsePageSize,
  showPager,
  type PageQuery,
  type PageSize,
  type PageState,
} from '@/lib/pagination';
import { pagerPageNumCls, pagerPageNumCurrentCls, pagerStepButtonCls } from './ui';

/**
 * The pager for grids that live in the BROWSER (feedback fc776376).
 *
 * <Pager> is an async server component — it awaits getTranslations — so a 'use client' grid cannot render
 * it at all. That is the whole reason six of this product's list tables were skipped when pagination was
 * built: feedback, loans, salary history, the two payroll transaction views and the roster. The feedback
 * table is the one that matters most, at 517 rows the largest list in the product.
 *
 * 9da61c86 added the three System Settings master-data grids to that set. They are the first EDITABLE
 * grids to page — spreadsheet-style inline editing, drafts, one atomic Save — which is what
 * `useClientPageNav` and `useResetPageOnFilterChange` below exist for: an appended draft must not vanish
 * onto the last page, and narrowing the search must not leave you on a page that no longer exists.
 *
 * WHY NOT JUST SLICE IN LOCAL STATE. These grids sort and filter over the rows they hold. If paging were
 * applied first, sorting would silently become sort-WITHIN-PAGE — clicking a column header would reorder
 * twenty-five rows and leave the other 492 where they were, which looks like sorting and is not. So the
 * grid sorts its full set FIRST and slices second, and the slice index rides in the address exactly as it
 * does on the server-paged screens: same ?page=&size= names, same shareable link, one contract.
 *
 * The address is updated with replace() rather than push() so paging does not stack history entries — Back
 * should leave the list, not walk back through pages of it. useSearchParams re-renders as soon as the
 * address changes, so the new page paints immediately without waiting on the server round trip.
 */

/** Read `?page=&size=` on the client, with the same parsing the server pages use. */
export function useClientPageQuery(paramNames?: { page: string; size: string }): PageQuery {
  const sp = useSearchParams();
  const names = paramNames ?? { page: 'page', size: 'size' };
  return parsePageQuery({
    page: sp.get(names.page) ?? undefined,
    size: sp.get(names.size) ?? undefined,
  });
}

/**
 * Where the remembered rows-per-page lives (9da61c86 — "keep the page size you pick, so you do not reset
 * it every time you open the screen").
 *
 * Per SCREEN, not global: 100 rows is a sensible default for Positions and a wall of text on a list of
 * companies. localStorage rather than the address, because the address is what a SHARED link carries and a
 * link should open the view its sender was looking at, not the view the recipient last chose.
 */
const sizeStorageKey = (screen: string) => `pager.size.${screen}`;

function readRememberedSize(screen: string): PageSize | null {
  try {
    const raw = window.localStorage.getItem(sizeStorageKey(screen));
    // parsePageSize turns anything unrecognised into the DEFAULT, which would be indistinguishable from
    // "nothing stored" — so an unusable value is treated as absent and the caller keeps its own default.
    if (raw === null) return null;
    return raw === 'all' || (PAGE_SIZE_OPTIONS as readonly number[]).includes(Number(raw))
      ? parsePageSize(raw)
      : null;
  } catch {
    // Private browsing and "block site data" both throw on access rather than returning null.
    return null;
  }
}

function rememberSize(screen: string, size: PageSize) {
  try {
    window.localStorage.setItem(sizeStorageKey(screen), String(size));
  } catch {
    /* storage unavailable — the choice still applies to this visit through the address. */
  }
}

/**
 * Move the list to a page from OUTSIDE the pager (9da61c86).
 *
 * Two callers, both in the editable grids: adding a row jumps to the page the new row landed on, and
 * changing the search resets to the first page. Both go through the same replace() the pager itself uses,
 * so there is one way the page ends up in the address.
 */
export function useClientPageNav(paramNames?: { page: string; size: string }) {
  const router = useRouter();
  const sp = useSearchParams();
  const names = paramNames ?? { page: 'page', size: 'size' };
  const qs = sp.toString();
  return useCallback(
    (page: number) => {
      const next = new URLSearchParams(qs);
      // page 0 drops out of the address entirely — the first page should be the bare screen.
      if (page > 0) next.set(names.page, String(page));
      else next.delete(names.page);
      const q = next.toString();
      router.replace(q ? `?${q}` : '?', { scroll: false });
    },
    [qs, names.page, router],
  );
}

/**
 * Send the reader back to page one when the FILTERS change (9da61c86).
 *
 * The grids keep search / status / scope in component state while the page rides in the address, so
 * without this you can be on page 5 of 300 rows, type a search that matches four, and get an empty table
 * with no clue that the rows exist one click away. `signature` is whatever string the grid builds out of
 * its active filters; sorting is deliberately NOT part of it — reordering the same set keeps your place.
 *
 * It skips the FIRST render on purpose: a deep link that carries ?page=3 must open on page 3, and an
 * unconditional reset here would strip it before the reader saw it.
 */
export function useResetPageOnFilterChange(
  signature: string,
  paramNames?: { page: string; size: string },
) {
  const goToPage = useClientPageNav(paramNames);
  const previous = useRef(signature);
  useEffect(() => {
    if (previous.current === signature) return;
    previous.current = signature;
    goToPage(0);
  }, [signature, goToPage]);
}

export function ClientPager({
  state,
  paramNames,
  note,
  rememberAs,
}: {
  state: PageState;
  /** A screen carrying two independently paged listings gives the second its own prefixed pair. */
  paramNames?: { page: string; size: string };
  /** Optional line shown beside the counter — used to say that selection covers this page only. */
  note?: string;
  /** Screen key under which the chosen rows-per-page is remembered for next time. */
  rememberAs?: string;
}) {
  const t = useTranslations('pagination');
  const router = useRouter();
  const sp = useSearchParams();
  const names = paramNames ?? { page: 'page', size: 'size' };

  /** Same rule as pageHref: build on top of the params already in the address, drop the empty ones. */
  const href = (over: { page: number; size?: PageSize }) => {
    const next = new URLSearchParams(sp.toString());
    // page 0 drops out of the address entirely — a first-page link should be the bare screen.
    if (over.page) next.set(names.page, String(over.page));
    else next.delete(names.page);
    if (over.size !== undefined) next.set(names.size, String(over.size));
    const qs = next.toString();
    return qs ? `?${qs}` : '?';
  };

  const go = (over: { page: number; size?: PageSize }) => router.replace(href(over), { scroll: false });

  // Apply the remembered size only on a BARE arrival — no page and no size in the address. A link someone
  // sent carries both, and it must open on the view its sender was looking at rather than being rewritten
  // by the recipient's last choice. Runs in an effect, not during render: reading localStorage while
  // rendering would make the server and client markup disagree.
  const hasPageParam = sp.get(names.page) !== null;
  const hasSizeParam = sp.get(names.size) !== null;
  const applied = useRef(false);
  useEffect(() => {
    if (!rememberAs || applied.current || hasPageParam || hasSizeParam) return;
    applied.current = true;
    const stored = readRememberedSize(rememberAs);
    if (stored !== null && stored !== state.size) {
      const next = new URLSearchParams(sp.toString());
      next.set(names.size, String(stored));
      router.replace(`?${next.toString()}`, { scroll: false });
    }
    // sp/state are read for the CURRENT address only; the guard above makes this a once-per-mount effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rememberAs, hasPageParam, hasSizeParam]);

  if (!showPager(state)) return null;

  // A window of numbered pages, empty on a one-page list — see pageNumbers for why a lone "1" is noise.
  const numbers = pageNumbers(state);
  const last = lastPage(state);

  return (
    <div className="border-t border-border">
      {state.truncated && (
        <p className="border-b border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
          {t('truncated', { shown: ALL_ROW_CEILING, total: state.total })} {t('truncatedHint')}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-2">
          <label htmlFor={`client-page-size-${names.page}`} className="text-xs text-muted-foreground">
            {t('rowsPerPage')}
          </label>
          <select
            id={`client-page-size-${names.page}`}
            value={String(state.size)}
            onChange={(e) => {
              const raw = e.target.value;
              const size = raw === 'all' ? 'all' : (Number(raw) as PageSize);
              if (rememberAs) rememberSize(rememberAs, size);
              // Changing the page size restarts at the first page — page 4 of 25-row pages is meaningless
              // once the page is 200 rows, and landing past the end would show an empty table.
              go({ page: 0, size });
            }}
            className="h-7 rounded-md border border-border bg-card px-1.5 text-xs tabular-nums text-foreground outline-none transition-colors focus-visible:border-ring"
          >
            {PAGE_SIZE_OPTIONS.map((n) => (
              <option key={n} value={String(n)}>
                {n}
              </option>
            ))}
            <option value="all">{t('all')}</option>
          </select>
        </div>
        <span className="text-xs tabular-nums text-muted-foreground">
          {state.from > 0
            ? t('range', { from: state.from, to: state.to, total: state.total })
            : t('rangeEmpty', { total: state.total })}
          {note && <span className="ms-2 tabular-nums-none">{note}</span>}
        </span>
        <div className="flex items-center gap-2 text-sm">
          <button
            type="button"
            disabled={!state.hasPrev}
            onClick={() => go({ page: 0 })}
            className={pagerStepButtonCls}
          >
            {t('first')}
          </button>
          <button
            type="button"
            disabled={!state.hasPrev}
            onClick={() => go({ page: state.page - 1 })}
            className={pagerStepButtonCls}
          >
            {t('previous')}
          </button>
          {numbers.map((n) =>
            n === state.page ? (
              <span key={n} aria-current="page" className={pagerPageNumCurrentCls}>
                {n + 1}
              </span>
            ) : (
              <button
                key={n}
                type="button"
                aria-label={t('pageNumber', { n: n + 1 })}
                onClick={() => go({ page: n })}
                className={pagerPageNumCls}
              >
                {n + 1}
              </button>
            ),
          )}
          <button
            type="button"
            disabled={!state.hasNext}
            onClick={() => go({ page: state.page + 1 })}
            className={pagerStepButtonCls}
          >
            {t('next')}
          </button>
          <button
            type="button"
            disabled={!state.hasNext}
            onClick={() => go({ page: last })}
            className={pagerStepButtonCls}
          >
            {t('last')}
          </button>
        </div>
      </div>
    </div>
  );
}
