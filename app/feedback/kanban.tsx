'use client';

import { useRef } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { DEFAULT_FEEDBACK_SORT, type FeedbackSort } from '@/lib/feedback-sort';
import { useTranslations } from 'next-intl';
import Link from '@/components/intent-link';
import type { FeedbackRow } from '@/core/feedback';
import { FEEDBACK_BOARD_STATUSES, feedbackBoardStatus, feedbackStatusTone, type FeedbackBoardStatus } from '@/lib/feedback-release';
import { formatFeedbackDateTime } from '@/lib/feedback-date';

/** Read-only lanes: deployment facts are recorded by the operator, never by dragging a card. */
export function FeedbackKanban({ rows, status, counts, sort = DEFAULT_FEEDBACK_SORT }: {
  rows: FeedbackRow[]; status?: FeedbackBoardStatus;
  counts: { status: FeedbackBoardStatus; count: number }[]; sort?: FeedbackSort;
}) {
  const t = useTranslations('feedback');
  const scrollArea = useRef<HTMLDivElement>(null);
  const totalOf = (st: FeedbackBoardStatus) => counts.find(c => c.status === st)?.count ?? 0;
  const lanes = FEEDBACK_BOARD_STATUSES.filter(st => status ? st === status : totalOf(st) > 0);
  const stageHref = (st: FeedbackBoardStatus) => {
    const query = new URLSearchParams({ status: st, view: 'kanban' });
    if (sort !== DEFAULT_FEEDBACK_SORT) query.set('sort', sort);
    return `/feedback?${query}`;
  };
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3">
        <p className="text-xs text-muted-foreground">{t('kanbanScroll')}</p>
        <div className="flex gap-2">
          <button type="button" onClick={() => scrollArea.current?.scrollBy({ left: -304, behavior: 'auto' })}
            className="inline-flex min-h-11 items-center gap-1 rounded-md border border-border px-2 text-xs hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary">
            <ChevronLeft size={14} aria-hidden="true" />{t('kanbanPrevious')}
          </button>
          <button type="button" onClick={() => scrollArea.current?.scrollBy({ left: 304, behavior: 'auto' })}
            className="inline-flex min-h-11 items-center gap-1 rounded-md border border-border px-2 text-xs hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary">
            {t('kanbanNext')}<ChevronRight size={14} aria-hidden="true" />
          </button>
        </div>
      </div>
      {lanes.length === 0 && <p className="px-4 py-6 text-center text-sm text-muted-foreground">{t('empty')}</p>}
    <div ref={scrollArea} role="region" aria-label={t('viewKanban')} tabIndex={0}
      className="flex min-w-0 snap-x snap-proximity gap-4 overflow-x-auto border-t border-border p-4 focus-visible:outline-2 focus-visible:outline-primary">
      {lanes.map(st => {
        const items = rows.filter(r => feedbackBoardStatus(r) === st);
        const label = t(st === 'deployed' ? 'releaseUnverified' : `status_${st}`);
        return (
          <section key={st} aria-label={label} className="w-72 shrink-0 snap-start space-y-3">
            <h2 className="flex min-h-10 items-center justify-between gap-2 border-b border-border pb-2 text-sm font-semibold">
              <Link href={stageHref(st)} className={`rounded-md px-2 py-1 hover:underline focus-visible:outline-2 focus-visible:outline-primary ${feedbackStatusTone(st)}`}>{label}</Link>
              <span className="tabular-nums text-muted-foreground">{totalOf(st)}</span>
            </h2>
            {items.length < totalOf(st) && (
              <p className="text-xs text-muted-foreground">
                {t('kanbanLoaded', { shown: items.length, total: totalOf(st) })}{' '}
                <Link href={stageHref(st)} className="rounded text-primary underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-primary">{t('kanbanViewStage')}</Link>
              </p>
            )}
            {items.length === 0 ? (
              <p className="py-6 text-center text-xs text-muted-foreground">{t(totalOf(st) > 0 ? 'kanbanNotLoaded' : 'kanbanEmpty')}</p>
            ) : items.map(row => (
              <Link key={row.id} href={`/feedback/${row.id}`}
                className="block space-y-3 rounded-xl border border-border bg-background p-4 transition-colors hover:border-primary focus-visible:outline-2 focus-visible:outline-primary">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>{t(`category_${row.category}`)}</span>
                  <span>{row.id.slice(0, 8)}</span>
                </div>
                <h3 className="break-words text-sm font-medium leading-6">{row.title}</h3>
                {row.reopenedCount > 0 && <p className="text-xs text-rose-700 dark:text-rose-300">{t('reopenedBadge', { count: row.reopenedCount })}</p>}
                <div className="space-y-1 border-t border-border pt-3 text-xs text-muted-foreground">
                  <p className="break-words">{row.reporter ?? t('accountReporter')}</p>
                  <p className="tabular-nums">{t('colUpdated')}: {formatFeedbackDateTime(row.updatedAt)}</p>
                </div>
              </Link>
            ))}
          </section>
        );
      })}
    </div>
    </div>
  );
}
