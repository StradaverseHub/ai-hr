import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import {
  ALL_ROW_CEILING,
  PAGE_SIZE_OPTIONS,
  lastPage,
  pageHref,
  pageNumbers,
  showPager,
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

/**
 * What a pager link targets. `page` is ALWAYS explicit (0 = the first page) and `size` is present only on
 * the size links, so a custom builder never has to guess whether "absent" means "keep" or "reset".
 */
export type PagerHrefOver = { page: number; size?: PageSize };

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
  ...target
}: PagerTarget & {
  state: PageState;
  /** Optional link to this screen's own export, shown when "All" truncates. */
  exportHref?: string;
}) {
  if (!showPager(state)) return null;
  const t = await getTranslations('pagination');
  const names = target.paramNames ?? { page: 'page', size: 'size' };
  const href = (over: PagerHrefOver) =>
    target.hrefFor
      ? target.hrefFor(over)
      : pageHref(target.basePath, target.params ?? {}, {
          // page 0 drops out of the address entirely — a first-page link should be the bare screen.
          [names.page]: over.page || undefined,
          [names.size]: over.size ?? state.size,
        });

  const sizeOptions = [
    ...PAGE_SIZE_OPTIONS.map((n) => ({
      value: String(n),
      label: String(n),
      // Changing the page size restarts at the first page — page 4 of 25-row pages is meaningless once
      // the page is 200 rows, and landing past the end would show an empty table.
      href: href({ size: n, page: 0 }),
    })),
    { value: 'all', label: t('all'), href: href({ size: 'all', page: 0 }) },
  ];

  // The numbered strip (9da61c86). A window rather than the whole run — see pageNumbers.
  const numbers = pageNumbers(state);
  const last = lastPage(state);

  return (
    <div className="border-t border-border">
      {state.truncated && (
        <p className="border-b border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
          {t('truncated', { shown: ALL_ROW_CEILING, total: state.total })}{' '}
          {exportHref ? (
            <Link href={exportHref} className="text-primary hover:underline">
              {t('truncatedExport')}
            </Link>
          ) : (
            t('truncatedHint')
          )}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <PageSizeSelect label={t('rowsPerPage')} value={String(state.size)} options={sizeOptions} />
        <span className="text-xs tabular-nums text-muted-foreground">
          {state.from > 0
            ? t('range', { from: state.from, to: state.to, total: state.total })
            : t('rangeEmpty', { total: state.total })}
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
            <Link href={href({ page: state.page - 1 })} className={pagerStepCls}>
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
            <Link href={href({ page: state.page + 1 })} className={pagerStepCls}>
              {t('next')}
            </Link>
          ) : (
            <span className={pagerStepMutedCls}>{t('next')}</span>
          )}
          {state.hasNext ? (
            <Link href={href({ page: last })} className={pagerStepCls}>
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
