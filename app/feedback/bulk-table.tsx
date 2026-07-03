'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { FeedbackRow } from '@/core/feedback';
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
export function BulkTable({ rows }: { rows: FeedbackRow[] }) {
  const t = useTranslations('feedback');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const allSelected = rows.length > 0 && selected.size === rows.length;
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)));
  const ids = [...selected];

  return (
    <div>
      {selected.size > 0 && (
        <form
          action={bulkReviewAction}
          className="flex flex-wrap items-center gap-2 border-b border-border bg-primary/5 px-4 py-2.5"
        >
          {ids.map((id) => (
            <input key={id} type="hidden" name="ids" value={id} />
          ))}
          <span className="text-sm font-medium">{t('bulkSelected', { count: selected.size })}</span>
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
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r) => (
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
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
