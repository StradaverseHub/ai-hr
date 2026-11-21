import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import type { SessionContext } from '@/db/client';
import { TODO_COUNT_CAP, countText, recruitmentJobTodos, recruitmentWaitingTodos, type RecruitmentTodo } from '@/packs/recruitment/service';
import { klDate, klDateTime } from './shared';

/** One list of to-dos (personal or per-job), each linked to where the viewer acts, with its Kuala Lumpur time. */
export async function TodoItems({ items }: { items: RecruitmentTodo[] }) {
  const [t, tc, locale] = await Promise.all([getTranslations('recruitment.tasks'), getTranslations('recruitment.cand'), getLocale()]);
  const line = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(' · ');
  const candidate = (item: RecruitmentTodo) => (item.candidateRemoved ? tc('removedLabel') : item.candidateName);
  const text = (item: RecruitmentTodo) => {
    // A waiting count that read only part of a busy job is a lower bound: "N+" (slice 17).
    const shown = item.countCapped && (item.count ?? 0) < TODO_COUNT_CAP ? `${item.count ?? 0}+` : countText(item.count ?? 0, TODO_COUNT_CAP);
    switch (item.kind) {
      case 'requisitionApproval': return { label: t('todo.requisitionApproval'), detail: line(item.title, item.number, item.step && t('step', item.step)) };
      case 'offerApproval': return { label: t('todo.offerApproval'), detail: line(candidate(item) ?? t('offerFallback'), item.title, item.step && t('step', item.step)) };
      case 'feedback': return { label: t('todo.feedback'), detail: line(candidate(item), item.title, t('startedAt', { time: klDateTime(locale, item.at) })) };
      case 'agencyReview': return { label: t('todo.agencyReview'), detail: line(candidate(item), item.title, item.number) };
      case 'contractExpiry': return { label: t('todo.contractExpiry'), detail: line(item.title, item.endsOn && t('endsOn', { date: klDate(locale, item.endsOn) })) };
      case 'screening': return {
        label: candidate(item) && item.title ? t('todo.screeningFor', { candidate: candidate(item)!, job: item.title }) : t('todo.screening'), detail: line(item.number),
      };
      case 'backgroundCheckAuthorisation': return { label: t('todo.backgroundCheckAuthorisation'), detail: line(candidate(item), item.title, item.number) };
      case 'backgroundCheckOverdue': return { label: t('todo.backgroundCheckOverdue'), detail: line(candidate(item), item.title, item.number) };
      case 'toSchedule': return { label: t('todo.toSchedule', { count: item.count ?? 0, shown }), detail: line(item.title, item.number) };
      case 'toScreen': return { label: t('todo.toScreen', { count: item.count ?? 0, shown }), detail: line(item.title, item.number) };
      case 'toAssign': return { label: t('todo.toAssign', { count: item.count ?? 0, shown }), detail: line(item.title) };
      case 'waiting': return { label: t('todo.waiting', { count: item.count ?? 0, shown }), detail: line(item.title, item.number) };
      case 'suggestedArchive': return { label: t('todo.suggestedArchive', { count: item.count ?? 0, shown }), detail: line(item.title, item.number) };
    }
  };
  return (
    <ul className="divide-y divide-border">
      {items.map((item) => {
        const { label, detail } = text(item);
        return (
          <li key={`${item.kind}:${item.id}`} className="flex items-start justify-between gap-3 py-3">
            <div className="min-w-0">
              <Link href={item.href} className="text-sm font-medium hover:underline">{label}</Link>
              {detail && <p className="truncate text-xs text-muted-foreground">{detail}</p>}
            </div>
            <time dateTime={item.at} className="shrink-0 text-xs tabular-nums text-muted-foreground">{item.kind === 'contractExpiry' ? klDate(locale, item.at) : klDateTime(locale, item.at)}</time>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The To do tab's per-job counts (D-035): applications to schedule and to screen on the viewer's Open or On hold jobs.
 * Rendered inside its own Suspense boundary, so the rest of the Overview never waits for it; over its own statement
 * timeout (or on a database failure) it says so in place with a link to try again — never an error page.
 */
export async function RecruitmentJobTodos({ s, scopeIds }: { s: SessionContext; scopeIds: string[] }) {
  const [t, result] = await Promise.all([getTranslations('recruitment.tasks'), recruitmentJobTodos(s, scopeIds)]);
  if (result.status === 'unavailable') {
    return (
      <p role="status" className="py-3 text-sm text-muted-foreground">
        {t('jobsUnavailable')} <Link href="/recruitment?tasks=todo#tasks" className="font-medium text-primary hover:underline">{t('jobsRefresh')}</Link>
      </p>
    );
  }
  if (!result.items.length) return null;
  return (
    <section aria-labelledby="job-todos-title" className="border-t border-border pt-2">
      <h3 id="job-todos-title" className="pt-1 text-xs font-semibold text-muted-foreground">{t('jobsTitle')}</h3>
      {await TodoItems({ items: result.items })}
    </section>
  );
}

/**
 * Slice 17: the per-job waiting counts (applications waiting too long, suggested to archive), in their own Suspense boundary and under
 * their own statement timeout: if they cannot be loaded, only this line says so; the other counts are unaffected.
 */
export async function RecruitmentWaitingTodos({ s, scopeIds }: { s: SessionContext; scopeIds: string[] }) {
  const [t, result] = await Promise.all([getTranslations('recruitment.tasks'), recruitmentWaitingTodos(s, scopeIds)]);
  if (result.status === 'unavailable') return <p role="status" className="py-3 text-sm text-muted-foreground">{t('waitingUnavailable')}</p>;
  if (!result.items.length) return null;
  return (
    <section aria-labelledby="waiting-todos-title" className="border-t border-border pt-2">
      <h3 id="waiting-todos-title" className="pt-1 text-xs font-semibold text-muted-foreground">{t('waitingTitle')}</h3>
      {await TodoItems({ items: result.items })}
    </section>
  );
}

/** What the To do tab shows while the per-job counts load. */
export async function JobTodosLoading() {
  const t = await getTranslations('recruitment.tasks');
  return <p role="status" className="py-3 text-xs text-muted-foreground">{t('jobsLoading')}</p>;
}
