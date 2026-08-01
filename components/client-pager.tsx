'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  ALL_ROW_CEILING,
  PAGE_SIZE_OPTIONS,
  parsePageQuery,
  showPager,
  type PageQuery,
  type PageSize,
  type PageState,
} from '@/lib/pagination';

/**
 * The pager for grids that live in the BROWSER (feedback fc776376).
 *
 * <Pager> is an async server component — it awaits getTranslations — so a 'use client' grid cannot render
 * it at all. That is the whole reason six of this product's list tables were skipped when pagination was
 * built: feedback, loans, salary history, the two payroll transaction views and the roster. The feedback
 * table is the one that matters most, at 517 rows the largest list in the product.
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

export function ClientPager({
  state,
  paramNames,
  note,
}: {
  state: PageState;
  /** A screen carrying two independently paged listings gives the second its own prefixed pair. */
  paramNames?: { page: string; size: string };
  /** Optional line shown beside the counter — used to say that selection covers this page only. */
  note?: string;
}) {
  const t = useTranslations('pagination');
  const router = useRouter();
  const sp = useSearchParams();
  const names = paramNames ?? { page: 'page', size: 'size' };
  if (!showPager(state)) return null;

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
              // Changing the page size restarts at the first page — page 4 of 25-row pages is meaningless
              // once the page is 200 rows, and landing past the end would show an empty table.
              go({ page: 0, size: raw === 'all' ? 'all' : (Number(raw) as PageSize) });
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
        <div className="flex items-center gap-3 text-sm">
          <button
            type="button"
            disabled={!state.hasPrev}
            onClick={() => go({ page: state.page - 1 })}
            className="text-primary hover:underline disabled:text-muted-foreground/50 disabled:no-underline"
          >
            {t('previous')}
          </button>
          <button
            type="button"
            disabled={!state.hasNext}
            onClick={() => go({ page: state.page + 1 })}
            className="text-primary hover:underline disabled:text-muted-foreground/50 disabled:no-underline"
          >
            {t('next')}
          </button>
        </div>
      </div>
    </div>
  );
}
