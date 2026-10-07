'use client';

import { useState } from 'react';
// r399: board rows prefetch the item on hover/focus (components/intent-link.tsx), so opening one skips the shell.
import Link from '@/components/intent-link';
import { useTranslations } from 'next-intl';
import type { FeedbackRow } from '@/core/feedback';
import { paginateRows } from '@/lib/pagination';
import { formatFeedbackDateTime } from '@/lib/feedback-date';
import { DEFAULT_FEEDBACK_SORT, flipFeedbackSort, type FeedbackSort } from '@/lib/feedback-sort';
import { ClientPager, useClientPageQuery } from '@/components/client-pager';
import { bulkReviewAction } from './actions';

// Kept in sync with statusTone in page.tsx (a pure mapping; duplicated to stay inside the client boundary).
function statusTone(status: string): string {
  switch (status) {
    case 'open':
      return 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400';
    case 'planned':
      return 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400';
    case 'contested':
      return 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400';
    case 'approved':
    case 'building':
      return 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-400';
    // Matches app/feedback/page.tsx — amber, the "needs you" colour, not a shade of in-progress.
    case 'blocked':
      return 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300';
    case 'done':
    case 'deployed':
      return 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400';
    default:
      return 'bg-muted text-muted-foreground';
  }
}

/** The review list with checkbox multi-select + a bulk action bar (approve / cancel the selection at once).
 *  The bar is a server-action form carrying the selected ids; the service skips items in the wrong state and
 *  reports the skipped count, so selecting a mixed bag is safe. */
export function BulkTable({
  rows,
  status,
  sort = DEFAULT_FEEDBACK_SORT,
}: {
  rows: FeedbackRow[];
  /** The active ?status= chip, so flipping the order does not silently drop the filter. */
  status?: string;
  /** The order the SERVER applied — the heading renders its mark from this, never from local state. */
  sort?: FeedbackSort;
}) {
  const t = useTranslations('feedback');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // e14334ef — the Last Updated heading is a LINK, not a client-side sort. listFeedback caps the board at
  // 200 rows; re-ordering the rows this component holds would rank only the newest-touched 200, so
  // "oldest first" would show the oldest OF THE NEWEST rather than the stale items it is meant to chase.
  // The flip therefore has to go back to the server. Page index is deliberately dropped: a re-sort starts
  // at the top, and staying on page 4 of a reversed list lands somewhere meaningless.
  const flipHref = (() => {
    const p = new URLSearchParams();
    if (status) p.set('status', status);
    // The default order drops out of the address, matching the rule ClientPager applies to page 0.
    const next = flipFeedbackSort(sort);
    if (next !== DEFAULT_FEEDBACK_SORT) p.set('sort', next);
    const qs = p.toString();
    return qs ? `/feedback?${qs}` : '/feedback';
  })();
  // Same marks as components/loan-list.tsx and components/salary-history-table.tsx.
  const sortMark = sort === 'updated_asc' ? ' ▲' : ' ▼';

  // Paging happens AFTER the SERVER's ordering and filtering — see client-pager.tsx. It does NOT page over
  // the full set: listFeedback cuts the board at FEEDBACK_LIST_LIMIT (200) rows, so `rows` is the top of
  // the server's order, not all 517 production items. That is why the heading above is a link rather than
  // a client sort, and why app/feedback/page.tsx prints how many rows the cut left behind.
  // (This comment used to claim "over the full set"; it was written before the cap mattered to the reader.)
  const q = useClientPageQuery();
  const { rows: pageRows, state } = paginateRows(rows, q);
  const pageIds = new Set(pageRows.map((r) => r.id));

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  // Selection is confined to the page you can see: "approve all" must never quietly mean "approve all
  // 517". Intersecting here rather than clearing on page change makes that structural — the form can only
  // ever carry rows that are on screen — and it needs no effect, so a selection you left on page 2 is
  // simply invisible until you go back to it.
  const ids = [...selected].filter((id) => pageIds.has(id));
  const allSelected = pageRows.length > 0 && ids.length === pageRows.length;
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(pageRows.map((r) => r.id)));

  return (
    <div>
      {ids.length > 0 && (
        <form
          action={bulkReviewAction}
          className="flex flex-wrap items-center gap-2 border-b border-border bg-primary/5 px-4 py-2.5"
        >
          {ids.map((id) => (
            <input key={id} type="hidden" name="ids" value={id} />
          ))}
          <span className="text-sm font-medium">{t('bulkSelected', { count: ids.length })}</span>
          <span className="text-xs text-muted-foreground">{t('bulkPageScope')}</span>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="submit"
              name="action"
              value="approve"
              className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700"
            >
              {t('bulkApprove')}
            </button>
            <button
              type="submit"
              name="action"
              value="cancel"
              className="rounded-md bg-rose-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-700"
            >
              {t('bulkCancel')}
            </button>
            <button
              type="submit"
              name="action"
              value="restore"
              className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted"
            >
              {t('bulkRestore')}
            </button>
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="rounded-md px-2 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              {t('bulkClear')}
            </button>
          </div>
        </form>
      )}
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="w-10 px-4 py-2">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleAll}
                aria-label={t('selectAll')}
                className="h-4 w-4 rounded border-border"
              />
            </th>
            <th className="px-4 py-2 font-medium">{t('colTitle')}</th>
            <th className="px-4 py-2 font-medium">{t('colCategory')}</th>
            <th className="px-4 py-2 font-medium">{t('colReporter')}</th>
            <th className="px-4 py-2 font-medium">{t('colStatus')}</th>
            <th className="px-4 py-2 font-medium">
              <Link
                href={flipHref}
                scroll={false}
                title={t(sort === 'updated_asc' ? 'sortNewestFirst' : 'sortOldestFirst')}
                className="uppercase tracking-wide hover:text-foreground"
              >
                {t('colUpdated')}
                {sortMark}
              </Link>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {pageRows.map((r) => (
            <tr key={r.id} className={selected.has(r.id) ? 'bg-primary/5' : 'hover:bg-muted/40'}>
              <td className="px-4 py-2.5">
                <input
                  type="checkbox"
                  checked={selected.has(r.id)}
                  onChange={() => toggle(r.id)}
                  aria-label={r.title}
                  className="h-4 w-4 rounded border-border"
                />
              </td>
              <td className="px-4 py-2.5 font-medium">
                <Link href={`/feedback/${r.id}`} className="underline-offset-2 hover:text-primary hover:underline">
                  {r.title}
                </Link>
                {r.reopenedCount > 0 && (
                  <span
                    className="ml-2 rounded-full bg-rose-50 px-1.5 py-0.5 text-[10px] font-medium text-rose-700 dark:bg-rose-500/10 dark:text-rose-400"
                    title={t('reopenedTitle')}
                  >
                    {t('reopenedBadge', { count: r.reopenedCount })}
                  </span>
                )}
              </td>
              <td className="px-4 py-2.5 text-muted-foreground">{t(`category_${r.category}`)}</td>
              <td className="px-4 py-2.5 text-muted-foreground">{r.reporter}</td>
              <td className="px-4 py-2.5">
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${statusTone(r.status)}`}>
                  {t(`status_${r.status}`)}
                </span>
              </td>
              {/* An item nobody has touched since it was raised shows the time it was raised — updated_at
                  defaults to the insert. That is the reporter's stated convention, so there is no
                  em-dash case here and no "never updated" to distinguish. */}
              <td className="whitespace-nowrap px-4 py-2.5 tabular-nums text-muted-foreground">
                {formatFeedbackDateTime(r.updatedAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <ClientPager state={state} />
    </div>
  );
}
