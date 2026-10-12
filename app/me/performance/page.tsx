import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { onehrAssignments, myCheckIns, myFeedbackRequests, myGoals, myReviews } from '@/packs/performance/service';
import { Button, Card, ErrorBanner, Field, PageHeader, SectionHeader, inputCls } from '@/components/ui';
import {
  myCreateGoal,
  myDeclinePeerFeedback,
  mySubmitPeerFeedback,
  myUpdateGoalProgress,
} from '../actions';

/**
 * MY PERFORMANCE — the employee's own goals, 360 feedback and 1:1 check-ins.
 *
 * r259. This is a MOVE, not a new screen and not a second copy. Every card below came WHOLE off /me's
 * retired Performance tab when My Profile was rebuilt in the shape of the Personnel record (board item
 * 9583deac): six tabs — Profile, Employment, Bank & Statutory, Payroll, Family, Documents — none of which
 * is Performance, because the Personnel record has no such tab.
 *
 * WHY IT COULD NOT SIMPLY BE DROPPED, and why it could not go to /performance either. /performance
 * redirects anyone who is neither an administrator nor a manager back to the dashboard, so for a plain
 * employee THIS is the only place their own goals, their peer-feedback requests and their check-in
 * history have ever been reachable. Deleting the tab without moving its contents would have removed four
 * live self-service capabilities on a change nobody read as touching performance — the exact failure
 * test/me-tabs.test.ts was written to catch when the Leave tab moved at a7cbd895.
 *
 * The four server actions are IMPORTED from app/me/actions.ts rather than re-declared. One implementation,
 * one approval route; a second copy beside this page is how the two would drift. Their redirects were
 * repointed at this address in the same change, because an action must land the employee back on the
 * screen they posted from.
 *
 * `/me?tab=performance` forwards here (app/me/page.tsx), so an existing bookmark or notification link
 * still arrives.
 */
export default async function MyPerformancePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const t = await getTranslations('me');
  const s = await getSession();
  const { error } = await searchParams;

  const [reviews, goals, checkins, feedbackRequests, onehr] = await Promise.all([
    myReviews(s),
    myGoals(s),
    myCheckIns(s),
    myFeedbackRequests(s),
    onehrAssignments(s),
  ]);

  const standardReviews=reviews.filter(r=>!onehr.reviews.some(a=>a.id===r.reviewId));
  const standardFeedbackRequests=feedbackRequests.filter(r=>!onehr.feedback.some(a=>a.id===r.requestId));
  const onehrText=await getTranslations('onehr');
  return (
    <div className="mx-auto max-w-[100rem] space-y-6">
      <PageHeader
        back={{ href: '/me', label: t('title') }}
        title={t('secPerformance')}
        description={t('performancePageDescription')}
      />

      <ErrorBanner message={error} />
      {(onehr.reviews.length > 0 || onehr.sessions.length > 0 || onehr.feedback.length > 0) && <Card className="space-y-3 p-5"><h2 className="font-semibold">{onehrText('assignments')}</h2>{onehr.reviews.map(a=><p key={a.id}><Link className="text-primary hover:underline" href={`/performance/review/${a.id}`}>{a.name} · {a.cycle} · {a.periodEnd}</Link></p>)}{onehr.sessions.map(a=><p key={a.id}><Link className="text-primary hover:underline" href={`/performance/onehr/calibration/${a.id}`}>{a.name}</Link></p>)}{onehr.feedback.map(a=><p key={a.id}><Link className="text-primary hover:underline" href={`/performance/onehr/feedback/${a.id}`}>{onehrText('feedback360')} · {a.subject}</Link></p>)}</Card>}

      {/* Performance reviews */}
      {standardReviews.length > 0 && (
        <Card className="overflow-hidden">
          <SectionHeader title={t('myReviews')} count={standardReviews.length} />
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">{t('colCycle')}</th>
                <th className="px-4 py-2 font-medium">{t('colStatus')}</th>
                <th className="px-4 py-2 text-center font-medium">{t('colOverall')}</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {standardReviews.map((r) => {
                // Employee-facing status: their own perspective, not the raw enum.
                const label =
                  r.status === 'self_review'
                    ? t('reviewLabelSelfReview')
                    : r.status === 'manager_review'
                      ? t('reviewLabelWithManager')
                      : r.status === 'submitted'
                        ? r.released
                          ? t('reviewLabelReadyToAcknowledge')
                          : t('reviewLabelAwaitingRelease')
                        : t('reviewLabelAcknowledged');
                const action =
                  r.status === 'self_review'
                    ? t('reviewActionSelfReview')
                    : r.status === 'submitted' && r.released
                      ? t('reviewActionAcknowledge')
                      : r.released || r.status === 'acknowledged'
                        ? t('reviewActionView')
                        : null; // nothing to do yet (with manager / awaiting release)
                return (
                  <tr key={r.reviewId}>
                    <td className="px-4 py-2.5 font-medium">{r.cycleName}</td>
                    <td className="px-4 py-2.5 text-muted-foreground">{label}</td>
                    <td className="px-4 py-2.5 text-center tabular-nums">
                      {r.released && r.overallRating != null ? r.overallRating : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {action ? (
                        <Link href={`/performance/review/${r.reviewId}`} className="text-xs text-primary hover:underline">
                          {action}
                        </Link>
                      ) : (
                        <span className="text-xs text-muted-foreground">{t('noActionNeeded')}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

      {/* My goals (ADR-0022) — continuous, employee-owned objectives */}
      <Card className="overflow-hidden">
        <SectionHeader title={t('goalsTitle')} count={goals.length} />
        {goals.length === 0 ? (
          <p className="px-4 py-5 text-center text-sm text-muted-foreground">{t('goalsEmpty')}</p>
        ) : (
          <ul className="divide-y divide-border">
            {goals.map((g) => {
              const statusTone =
                g.status === 'achieved'
                  ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400'
                  : g.status === 'missed'
                    ? 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-400'
                    : g.status === 'dropped'
                      ? 'bg-muted text-muted-foreground'
                      : 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-400';
              return (
                <li key={g.id} className="px-4 py-3.5">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{g.title}</span>
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${statusTone}`}>
                          {t(`goalStatus_${g.status}`)}
                        </span>
                        {g.cycleName && <span className="text-[10px] text-muted-foreground">· {g.cycleName}</span>}
                      </div>
                      {g.description && <p className="mt-0.5 text-xs text-muted-foreground">{g.description}</p>}
                      {(g.metric || g.target) && (
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {[g.metric, g.target].filter(Boolean).join(' · ')}
                          {g.dueOn ? ` · ${t('goalDueShort', { date: g.dueOn })}` : ''}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="mt-2 flex items-center gap-3">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${g.progress}%` }} />
                    </div>
                    <span className="w-9 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{g.progress}%</span>
                  </div>
                  <form action={myUpdateGoalProgress} className="mt-2 flex flex-wrap items-center justify-end gap-2">
                    <input type="hidden" name="goalId" value={g.id} />
                    <label className="flex items-center gap-1 text-[10px] uppercase text-muted-foreground">
                      {t('goalProgressLabel')}
                      <input
                        name="progress"
                        type="number"
                        min="0"
                        max="100"
                        defaultValue={g.progress}
                        className={`${inputCls} w-20 text-right`}
                      />
                    </label>
                    <select name="status" defaultValue={g.status} className={`${inputCls} w-32`}>
                      <option value="active">{t('goalStatus_active')}</option>
                      <option value="achieved">{t('goalStatus_achieved')}</option>
                      <option value="missed">{t('goalStatus_missed')}</option>
                      <option value="dropped">{t('goalStatus_dropped')}</option>
                    </select>
                    <Button type="submit" size="sm" variant="secondary">
                      {t('goalSave')}
                    </Button>
                  </form>
                </li>
              );
            })}
          </ul>
        )}
        <form action={myCreateGoal} className="space-y-3 border-t border-border bg-muted/20 px-4 py-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('goalNewTitle')}</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t('goalTitleLabel')}>
              <input name="title" required placeholder={t('goalTitlePlaceholder')} className={inputCls} />
            </Field>
            <Field label={t('goalDueLabel')}>
              <input name="dueOn" type="date" className={inputCls} />
            </Field>
            <Field label={t('goalMetricLabel')}>
              <input name="metric" placeholder={t('goalMetricPlaceholder')} className={inputCls} />
            </Field>
            <Field label={t('goalTargetLabel')}>
              <input name="target" placeholder={t('goalTargetPlaceholder')} className={inputCls} />
            </Field>
          </div>
          <Field label={t('goalDescriptionLabel')}>
            <textarea name="description" rows={2} className={inputCls} />
          </Field>
          <div className="flex justify-end">
            <Button type="submit">{t('goalAdd')}</Button>
          </div>
        </form>
      </Card>

      {/* 360 feedback requests (ADR-0022) — the peer responds; their identity stays with HR/manager */}
      {standardFeedbackRequests.length > 0 && (
        <Card className="overflow-hidden">
          <SectionHeader title={t('feedbackTitle')} count={standardFeedbackRequests.length} />
          <p className="px-4 pt-3 text-xs text-muted-foreground">{t('feedbackIntro')}</p>
          <ul className="divide-y divide-border">
            {standardFeedbackRequests.map((fr) => (
              <li key={fr.requestId} className="px-4 py-4">
                <div className="text-sm font-medium">
                  {t('feedbackOn', { name: fr.subject })}
                  {fr.cycleName && <span className="ml-2 text-xs text-muted-foreground">{fr.cycleName}</span>}
                </div>
                <form action={mySubmitPeerFeedback} className="mt-3 space-y-3">
                  <input type="hidden" name="requestId" value={fr.requestId} />
                  <Field label={t('feedbackStrengths')}>
                    <textarea name="strengths" rows={2} className={inputCls} placeholder={t('feedbackStrengthsPlaceholder')} />
                  </Field>
                  <Field label={t('feedbackImprovements')}>
                    <textarea name="improvements" rows={2} className={inputCls} placeholder={t('feedbackImprovementsPlaceholder')} />
                  </Field>
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <input type="checkbox" name="named" className="size-4" />
                    {t('feedbackNamed')}
                  </label>
                  <div className="flex items-center justify-end gap-2">
                    <Button type="submit" size="sm">
                      {t('feedbackSubmit')}
                    </Button>
                  </div>
                </form>
                <form action={myDeclinePeerFeedback} className="mt-1 flex justify-end">
                  <input type="hidden" name="requestId" value={fr.requestId} />
                  <Button type="submit" size="sm" variant="ghost">
                    {t('feedbackDecline')}
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* My 1:1 check-ins (ADR-0022) — read-only; the manager schedules from /performance */}
      {checkins.length > 0 && (
        <Card className="overflow-hidden">
          <SectionHeader title={t('checkinsTitle')} count={checkins.length} />
          <ul className="divide-y divide-border">
            {checkins.map((c) => (
              <li key={c.id} className="px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium tabular-nums">{c.scheduledOn}</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                      c.status === 'completed'
                        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400'
                        : c.status === 'cancelled'
                          ? 'bg-muted text-muted-foreground'
                          : 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-400'
                    }`}
                  >
                    {t(`checkinStatus_${c.status}`)}
                  </span>
                </div>
                {c.notes && <p className="mt-1 text-xs text-muted-foreground">{c.notes}</p>}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
