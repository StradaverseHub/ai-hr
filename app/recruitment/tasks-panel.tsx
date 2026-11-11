import Link from 'next/link';
import { Suspense } from 'react';
import { getLocale, getTranslations } from 'next-intl/server';
import type { SessionContext } from '@/db/client';
import { cn } from '@/lib/utils';
import {
  RecruitmentError, TASK_TABS, UPDATES_WINDOW_DAYS, countText, recruitmentTodos, recruitmentUnreadCounts, recruitmentUpdates,
  type RecruitmentUpdate, type TaskTab,
} from '@/packs/recruitment/service';
import { markRecruitmentTasksReadAction } from './actions';
import { Pill, klDateTime } from './shared';
import { JobTodosLoading, RecruitmentJobTodos, TodoItems } from './todo-items';

/**
 * Recruitment › Overview › Tasks (slice 9). To do: what waits for the viewer now, computed live — their approval steps
 * and feedback due first, then the per-job counts streamed in their own Suspense boundary (D-035). Requisitions, Offers,
 * Interviews and Applications: what happened in the last 90 days, newest first, with unread badges against the viewer's
 * own "read up to" time and "Mark all as read". Every row comes from the service under the viewer's own access; the
 * panel follows the Overview's company selection (`companyIds` for updates, `scopeIds` for the to-do list).
 */
export async function RecruitmentTasksPanel({ s, scopeIds, companyIds, tab, page, after }: {
  s: SessionContext; scopeIds: string[]; companyIds: string[]; tab: TaskTab; page: number; after?: string;
}) {
  const [t, tc, locale] = await Promise.all([getTranslations('recruitment.tasks'), getTranslations('recruitment.cand'), getLocale()]);
  const [todos, unread, updates] = await Promise.all([
    recruitmentTodos(s, scopeIds),
    recruitmentUnreadCounts(s, companyIds),
    tab === 'todo' ? Promise.resolve(null)
      : recruitmentUpdates(s, { companyIds, category: tab, page, after }).catch((e) => { if (e instanceof RecruitmentError) return recruitmentUpdates(s, { companyIds, category: tab }); throw e; }),
  ]);
  const badge = (key: TaskTab) => (key === 'todo' ? todos.length : unread[key]);
  const anyUnread = companyIds.length > 0 && Object.values(unread).some((n) => n > 0);
  const tabPath = (key: TaskTab, next?: { page: number; after: string }) =>
    `/recruitment?${new URLSearchParams({ tasks: key, ...(next ? { page: String(next.page), after: next.after } : {}) })}`;
  const tabHref = (key: TaskTab, next?: { page: number; after: string }) => `${tabPath(key, next)}#tasks`;
  const markForm = (category: string, label: string) => (
    <form action={markRecruitmentTasksReadAction}>
      {companyIds.map((id) => <input key={id} type="hidden" name="companyId" value={id} />)}
      <input type="hidden" name="category" value={category} />
      <input type="hidden" name="returnTo" value={tabPath(tab)} />
      <button type="submit" className="rounded-md px-2 py-1 text-xs font-medium text-primary hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
        {label}
      </button>
    </form>
  );
  const candidate = (item: Pick<RecruitmentUpdate, 'candidateName' | 'candidateRemoved'>) => (item.candidateRemoved ? tc('removedLabel') : item.candidateName);
  const line = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(' · ');
  const updateText = (item: RecruitmentUpdate) => ({ label: t(`update.${item.kind}`), detail: line(candidate(item), item.title, item.number) });

  return (
    <section id="tasks" aria-labelledby="tasks-title" className="flex flex-col rounded-xl border border-border bg-card">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 id="tasks-title" className="text-sm font-semibold">{t('title')}</h2>
        {anyUnread && markForm('all', t('markEverythingRead'))}
      </header>
      <nav aria-label={t('tabsLabel')} className="flex flex-wrap gap-1 border-b border-border px-2">
        {TASK_TABS.map((key) => {
          const n = badge(key);
          return (
            <Link key={key} href={tabHref(key)} aria-current={key === tab ? 'page' : undefined}
              className={cn('-mb-px inline-flex items-center gap-1 border-b-2 px-2 py-2 text-sm font-medium transition-colors',
                key === tab ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
              {t(`tabs.${key}`)}
              {n > 0 && (
                <span className="rounded-full bg-primary/15 px-1.5 text-xs tabular-nums text-foreground"
                  aria-label={key === 'todo' ? t('todoBadge', { count: n }) : t('unreadBadge', { count: n })}>{countText(n)}</span>
              )}
            </Link>
          );
        })}
      </nav>
      <div className="px-4 py-2">
        {tab === 'todo' ? (
          <>
            {todos.length === 0 ? <p className="py-4 text-sm text-muted-foreground">{t('todoEmpty')}</p> : <TodoItems items={todos} />}
            <Suspense fallback={<JobTodosLoading />}>
              <RecruitmentJobTodos s={s} scopeIds={scopeIds} />
            </Suspense>
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 py-2">
              <p className="text-xs text-muted-foreground">{t('window', { days: UPDATES_WINDOW_DAYS })}</p>
              {companyIds.length > 0 && unread[tab] > 0 && markForm(tab, t('markAllRead'))}
            </div>
            {!updates || updates.items.length === 0 ? <p className="py-4 text-sm text-muted-foreground">{t('updatesEmpty')}</p> : (
              <ul className="divide-y divide-border">
                {updates.items.map((item) => {
                  const text = updateText(item);
                  return (
                    <li key={item.id} className="flex items-start justify-between gap-3 py-3">
                      <div className="min-w-0">
                        <p className="flex flex-wrap items-center gap-2">
                          <Link href={item.href} className={cn('text-sm hover:underline', item.unread ? 'font-semibold' : 'font-medium')}>{text.label}</Link>
                          {item.unread && <Pill tone="info">{t('unread')}</Pill>}
                        </p>
                        {text.detail && <p className="truncate text-xs text-muted-foreground">{text.detail}</p>}
                      </div>
                      <time dateTime={item.at} className="shrink-0 text-xs tabular-nums text-muted-foreground">{klDateTime(locale, item.at)}</time>
                    </li>
                  );
                })}
              </ul>
            )}
            {updates && (updates.page > 1 || updates.hasMore) && (
              <nav aria-label={t('pagesLabel')} className="flex items-center justify-between gap-2 border-t border-border py-2 text-xs">
                {updates.page > 1 ? <Link className="font-medium text-primary hover:underline" href={tabHref(tab)}>{t('newest')}</Link> : <span />}
                <span className="tabular-nums text-muted-foreground">{t('page', { page: updates.page })}</span>
                {updates.hasMore && updates.nextCursor
                  ? <Link className="font-medium text-primary hover:underline" href={tabHref(tab, { page: updates.page + 1, after: updates.nextCursor })}>{t('older')}</Link>
                  : <span />}
              </nav>
            )}
          </>
        )}
      </div>
    </section>
  );
}
