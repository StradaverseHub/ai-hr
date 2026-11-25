import { ExportDownloadLink } from '@/components/export-download-link';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import {
  ALL_ROW_CEILING,
  PAGE_SIZE_OPTIONS,
  lastPage,
  pageHref,
  pageNumbers,
  showPager,
  isKeysetPageState,
  type PageSize,
  type PageState,
} from '@/lib/pagination';
import {
  pagerPageNumCls,
  pagerPageNumCurrentCls,
  pagerStepCls,
  pagerStepMutedCls,
} from './ui';
import { PageSizeSelect } from './page-size-select';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { currentUiTheme } from '@/lib/ui-theme-server';

/**
 * What a pager link targets. `page` is ALWAYS explicit (0 = the first page) and `size` is present only on
 * the size links, so a custom builder never has to guess whether "absent" means "keep" or "reset".
 */
export type PagerHrefOver = {
  page: number;
  size?: PageSize;
  /** Keyset lists only (ADR 0181 Phase 4): the cursor of the step, Last, and "Count exactly". */
  after?: string;
  before?: string;
  last?: boolean;
  count?: 'exact';
};

/** Screens whose address carries repeated params (multi-select filters) build their own links. */
type PagerTarget =
  | {
      basePath: string;
      params?: Record<string, string | number | undefined | null>;
      /**
       * Param names to write. A screen carrying TWO independently paged listings gives the second one its
       * own prefixed pair, so paging one never resets the other (the /leave `edPage` convention).
       */
      paramNames?: { page: string; size: string };
      hrefFor?: never;
    }
  | { hrefFor: (over: PagerHrefOver) => string; basePath?: never; params?: never; paramNames?: never };

/**
 * The ONE pager for list tables (feedback fc776376) — rows-per-page control, position counter and
 * page steps, rendered identically wherever a list is shown.
 *
 * Everything rides in the address (`?page=&size=`), built here from the params the page already carries, so
 * paging keeps the reader's filters and a copied link opens the same view. `params` should therefore be the
 * screen's ACTIVE filter params; `page` and `size` are supplied by the pager itself.
 *
 * When "All" truncates at the ceiling the bar says so in words and points at export. A payroll list that
 * silently stops at 2,000 rows is worse than one that admits it.
 */
export async function Pager({
  state,
  exportHref,
  truncatedHint,
  maxPageSize,
  ...target
}: PagerTarget & {
  state: PageState;
  /** Optional link to this screen's own export, shown when "All" truncates. */
  exportHref?: string;
  /** Screen-specific guidance when this audience has no complete-set export. Already translated. */
  truncatedHint?: string;
  /** Rich aggregate readers can cap available sizes; callers normalize URL input to the same ceiling. */
  maxPageSize?: number;
}) {
  if (!showPager(state)) return null;
  const t = await getTranslations('pagination');
  const names = target.paramNames ?? { page: 'page', size: 'size' };
  const keyset = isKeysetPageState(state) ? state : null;
  // A keyset list keeps "Count exactly" for the rest of the visit once the reader asked for it.
  const withCount = (over: PagerHrefOver): PagerHrefOver =>
    keyset && !over.count && keyset.exactCount ? { ...over, count: 'exact' } : over;
  const href = (raw: PagerHrefOver) => {
    const over = withCount(raw);
    return target.hrefFor
      ? target.hrefFor(over)
      : pageHref(target.basePath, target.params ?? {}, {
          // page 0 drops out of the address entirely — a first-page link should be the bare screen.
          [names.page]: over.page || undefined,
          [names.size]: over.size ?? state.size,
          ...(keyset
            ? { after: over.after, before: over.before, last: over.last ? 1 : undefined, count: over.count }
            : {}),
        });
  };
  // Keyset steps (no OFFSET): Previous steps back before the first row shown (or opens the first page when that is
  // where it lands), Next continues after the last row, Last is offered only when the total is exact.
  const prevHref = keyset
    ? state.page <= 1 || !keyset.firstId ? href({ page: 0 }) : href({ page: state.page - 1, before: keyset.firstId })
    : href({ page: state.page - 1 });
  const nextHref = keyset && keyset.lastId ? href({ page: state.page + 1, after: keyset.lastId }) : href({ page: state.page + 1 });
  const canLast = keyset ? keyset.canLast : state.hasNext;
  const lastHref = keyset ? href({ page: lastPage(state), last: true }) : href({ page: lastPage(state) });
  // "1,000+": the count stopped at the cap. Offer the exact number on request, on the same rows.
  const countHref = keyset?.capped
    ? href({ page: state.page, after: keyset.after, before: keyset.before, last: keyset.last, count: 'exact' })
    : null;
  const rangeText = state.from > 0
    ? keyset?.capped
      ? t('rangeCapped', { from: state.from, to: state.to, total: state.total })
      : t('range', { from: state.from, to: state.to, total: state.total })
    : t('rangeEmpty', { total: state.total });
  const truncatedText = keyset?.capped
    ? t('truncatedCapped', { shown: ALL_ROW_CEILING, total: state.total })
    : t('truncated', { shown: ALL_ROW_CEILING, total: state.total });
  const countExactly = countHref ? (
    <Link href={countHref} className="text-xs text-primary hover:underline" data-pager-count-exactly>
      {t('countExactly')}
    </Link>
  ) : null;

  const sizeOptions = [
    ...PAGE_SIZE_OPTIONS.filter(n=>maxPageSize===undefined||n<=maxPageSize).map((n) => ({
      value: String(n),
      label: String(n),
      // Changing the page size restarts at the first page — page 4 of 25-row pages is meaningless once
      // the page is 200 rows, and landing past the end would show an empty table.
      href: href({ size: n, page: 0 }),
    })),
    ...(maxPageSize===undefined||maxPageSize>=ALL_ROW_CEILING?[{ value: 'all', label: t('all'), href: href({ size: 'all', page: 0 }) }]:[]),
  ];

  // The numbered strip (9da61c86). A window rather than the whole run — see pageNumbers.
  // A keyset list cannot jump to page N, so it offers no numbered strip.
  const numbers = keyset ? [] : pageNumbers(state);

  // Atelier — the compact control-panel pager: rows-per-page, "1–25 / 248", and one ‹ › pair. The same hrefs,
  // the same truncation notice; First/Last and the numbered strip are not offered (owner request 2026-10-20).
  if ((await currentUiTheme()) === 'atelier') {
    return (
      <div data-ui-pager data-ui-pager-compact className="atelier-pager">
        {state.truncated && (
          <p className="atelier-pager-note">
            {truncatedText}{' '}
            {exportHref ? <ExportDownloadLink href={exportHref}>{t('truncatedExport')}</ExportDownloadLink> : (truncatedHint ?? t('truncatedHint'))}
          </p>
        )}
        <PageSizeSelect label={t('rowsPerPage')} value={String(state.size)} options={sizeOptions} />
        <span className="atelier-pager-range">
          {state.from > 0 ? `${state.from}–${state.to} / ${state.total}${keyset?.capped ? '+' : ''}` : t('rangeEmpty', { total: state.total })}
        </span>
        {countExactly}
        <span className="atelier-pager-steps">
          {state.hasPrev ? (
            <Link href={prevHref} aria-label={t('previousPage')} title={t('previousPage')}><ChevronLeft aria-hidden /></Link>
          ) : (
            <button type="button" disabled aria-label={t('previousPage')}><ChevronLeft aria-hidden /></button>
          )}
          {state.hasNext ? (
            <Link href={nextHref} aria-label={t('nextPage')} title={t('nextPage')}><ChevronRight aria-hidden /></Link>
          ) : (
            <button type="button" disabled aria-label={t('nextPage')}><ChevronRight aria-hidden /></button>
          )}
        </span>
      </div>
    );
  }

  return (
    // `data-ui-pager` lets a theme place the pager (it sits above its table, so it is read before the rows); markup only.
    <div data-ui-pager className="border-b border-border">
      {state.truncated && (
        <p className="border-b border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
          {truncatedText}{' '}
          {exportHref ? (
            <ExportDownloadLink href={exportHref} className="text-primary hover:underline">
              {t('truncatedExport')}
            </ExportDownloadLink>
          ) : (
            truncatedHint ?? t('truncatedHint')
          )}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <PageSizeSelect label={t('rowsPerPage')} value={String(state.size)} options={sizeOptions} />
        <span className="flex items-center gap-2 text-xs tabular-nums text-muted-foreground">
          {rangeText}
          {countExactly}
        </span>
        <div className="flex items-center gap-2 text-sm">
          {state.hasPrev ? (
            <Link href={href({ page: 0 })} className={pagerStepCls}>
              {t('first')}
            </Link>
          ) : (
            <span className={pagerStepMutedCls}>{t('first')}</span>
          )}
          {state.hasPrev ? (
            <Link href={prevHref} className={pagerStepCls}>
              {t('previous')}
            </Link>
          ) : (
            <span className={pagerStepMutedCls}>{t('previous')}</span>
          )}
          {numbers.map((n) =>
            n === state.page ? (
              <span key={n} aria-current="page" className={pagerPageNumCurrentCls}>
                {n + 1}
              </span>
            ) : (
              <Link key={n} href={href({ page: n })} aria-label={t('pageNumber', { n: n + 1 })} className={pagerPageNumCls}>
                {n + 1}
              </Link>
            ),
          )}
          {state.hasNext ? (
            <Link href={nextHref} className={pagerStepCls}>
              {t('next')}
            </Link>
          ) : (
            <span className={pagerStepMutedCls}>{t('next')}</span>
          )}
          {canLast ? (
            <Link href={lastHref} className={pagerStepCls}>
              {t('last')}
            </Link>
          ) : (
            <span className={pagerStepMutedCls}>{t('last')}</span>
          )}
        </div>
      </div>
    </div>
  );
}
