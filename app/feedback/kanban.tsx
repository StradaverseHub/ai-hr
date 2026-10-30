'use client';

import { useTranslations } from 'next-intl';
import Link from '@/components/intent-link';
import type { FeedbackRow } from '@/core/feedback';
import { FEEDBACK_BOARD_STATUSES, feedbackBoardStatus, feedbackStatusTone, type FeedbackBoardStatus } from '@/lib/feedback-release';
import { formatFeedbackDateTime } from '@/lib/feedback-date';

const ALWAYS_VISIBLE = new Set(['open', 'approved', 'building', 'done', 'staging', 'production_ready', 'production']);

/** Read-only lanes: deployment facts are recorded by the operator, never by dragging a card. */
export function FeedbackKanban({ rows, status }: { rows: FeedbackRow[]; status?: FeedbackBoardStatus }) {
  const t = useTranslations('feedback');
  const lanes = FEEDBACK_BOARD_STATUSES.filter(st => status ? st === status : ALWAYS_VISIBLE.has(st) || rows.some(r => feedbackBoardStatus(r) === st));
  return (
    <div role="region" aria-label={t('viewKanban')} tabIndex={0}
      className="flex min-w-0 snap-x snap-proximity gap-4 overflow-x-auto border-t border-border p-4 focus-visible:outline-2 focus-visible:outline-primary">
      {lanes.map(st => {
        const items = rows.filter(r => feedbackBoardStatus(r) === st);
        const label = t(st === 'deployed' ? 'releaseUnverified' : `status_${st}`);
        return (
          <section key={st} aria-label={label} className="w-72 shrink-0 snap-start space-y-3">
            <h2 className="flex min-h-10 items-center justify-between gap-2 border-b border-border pb-2 text-sm font-semibold">
              <span className={`rounded-md px-2 py-1 ${feedbackStatusTone(st)}`}>{label}</span>
              <span className="tabular-nums text-muted-foreground">{items.length}</span>
            </h2>
            {items.length === 0 ? (
              <p className="py-6 text-center text-xs text-muted-foreground">{t('kanbanEmpty')}</p>
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
  );
}
