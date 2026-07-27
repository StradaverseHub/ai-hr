import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { getFeedback } from '@/core/feedback';
import { Button, Card, ErrorBanner, Field, PageHeader, SectionHeader, inputCls } from '@/components/ui';
import { statusTone } from '../page';
import {
  approveFeedbackPlanAction,
  cancelFeedbackAction,
  contestFeedbackPlanAction,
  generateFeedbackPlanNowAction,
  refuteDeploymentAction,
  restoreFeedbackAction,
} from '../actions';
import { settingEnabledOrDefault } from '@/core/entitlements';

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  if (value == null || value === '') return null;
  return (
    <div className="py-2">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 whitespace-pre-wrap text-sm">{value}</div>
    </div>
  );
}

export default async function FeedbackDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const s = await getSession();
  const t = await getTranslations('feedback');
  const { error } = await searchParams;
  const fb = await getFeedback(s, id);
  if (!fb) notFound();

  const isReporter = !!s.userId && fb.reporterUserId === s.userId;
  const isAdmin = (s.roles ?? []).some((r) => r === 'hr_admin' || r === 'super_admin');
  // Approve/contest: the reporter OR an admin (HR triage). Withdraw stays reporter-only.
  const canReview = (isReporter || isAdmin) && fb.status === 'planned';
  const canWithdraw = isReporter && !['done', 'deployed', 'cancelled', 'building'].includes(fb.status);
  const canRestore = isReporter && fb.status === 'cancelled';
  // Close the loop: a deployed result the reporter (or admin) judges below standard can be sent back (ADR-0051).
  const canRefute = (isReporter || isAdmin) && fb.status === 'deployed';
  // In-app planning is disabled by default — plans come from the operator-side improvement loop (ADR-0044).
  const inAppPlanning = settingEnabledOrDefault(s, 'feedback.ai_planning_enabled');
  const canGeneratePlan = inAppPlanning && isAdmin && (fb.status === 'open' || fb.status === 'contested');

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title={fb.title}
        description={`${t(`category_${fb.category}`)}`}
        back={{ href: '/feedback', label: t('back') }}
        actions={
          <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${statusTone(fb.status)}`}>
            {t(`status_${fb.status}`)}
          </span>
        }
      />
      <ErrorBanner message={error} />

      <Card className="p-5">
        <div className="divide-y divide-border">
          <Row label={t('description')} value={fb.description} />
          <Row label={t('expectedBehavior')} value={fb.expectedBehavior} />
          <Row label={t('expectedFunction')} value={fb.expectedFunction} />
        </div>
        {fb.attachments.length > 0 && (
          <div className="mt-3 border-t border-border pt-3">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('attachments')}</div>
            <ul className="mt-1.5 flex flex-wrap gap-2">
              {fb.attachments.map((a) => (
                <li key={a.id}>
                  <a
                    href={`/feedback/attachment/${a.id}?inline=1`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-primary hover:bg-muted"
                  >
                    ↗ {a.fileName}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      {/* The AI-written implementation plan */}
      <Card className="p-5">
        <SectionHeader title={t('planTitle')} />
        {fb.plan ? (
          <>
            <p className="px-1 pt-2 text-xs text-muted-foreground">{t('planRevision', { n: fb.planRevision })}</p>
            <div className="mt-2 whitespace-pre-wrap rounded-lg border border-border bg-muted/30 p-4 text-sm">{fb.plan}</div>
          </>
        ) : (
          <p className="px-1 pt-2 text-sm text-muted-foreground">{t('planPending')}</p>
        )}

        {canGeneratePlan && (
          <form action={generateFeedbackPlanNowAction} className="mt-3">
            <input type="hidden" name="id" value={fb.id} />
            <Button type="submit" size="sm" variant="outline">
              {t('generatePlanNow')}
            </Button>
          </form>
        )}

        {fb.status === 'contested' && fb.contestReason && (
          <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50/60 p-3 text-sm dark:border-rose-500/30 dark:bg-rose-500/10">
            <div className="text-xs font-medium uppercase tracking-wide text-rose-700 dark:text-rose-400">{t('contestedHeading')}</div>
            <div className="mt-0.5">{fb.contestReason}</div>
            <div className="mt-1 text-xs text-muted-foreground">{t('contestedAwaiting')}</div>
          </div>
        )}

        {(fb.status === 'approved' || fb.status === 'building' || fb.status === 'done' || fb.status === 'deployed') && (
          <div className="mt-3 rounded-lg border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
            {fb.status === 'approved' && t('approvedNote')}
            {fb.status === 'building' && t('buildingNote')}
            {fb.status === 'done' && t('doneNote')}
            {fb.status === 'deployed' && t('deployedNote')}
            {fb.buildRef && (
              <>
                {' '}
                <a href={fb.buildRef} target="_blank" rel="noreferrer" className="text-primary underline-offset-2 hover:underline">
                  {t('viewBuild')}
                </a>
              </>
            )}
            {fb.reopenedCount > 0 && (
              <div className="mt-1 text-xs font-medium text-rose-600 dark:text-rose-400">
                {t('reopenedNote', { count: fb.reopenedCount })}
              </div>
            )}
          </div>
        )}

        {/* Close the loop: refute a deployed result that still needs changes (reporter or admin). */}
        {canRefute && (
          <form action={refuteDeploymentAction} className="mt-4 space-y-2 border-t border-border pt-4">
            <input type="hidden" name="id" value={fb.id} />
            <p className="text-sm font-medium">{t('refutePrompt')}</p>
            <Field label={t('refuteLabel')}>
              <textarea name="reason" rows={2} required className={inputCls} placeholder={t('refutePlaceholder')} />
            </Field>
            <Button type="submit" size="sm" variant="outline">
              {t('refute')}
            </Button>
          </form>
        )}

        {/* Reporter-only review controls (only the person who raised it) */}
        {canReview && (
          <div className="mt-4 space-y-3 border-t border-border pt-4">
            <p className="text-sm font-medium">{t('reviewPrompt')}</p>
            <div className="flex flex-wrap items-start gap-3">
              <form action={approveFeedbackPlanAction}>
                <input type="hidden" name="id" value={fb.id} />
                <Button type="submit" size="sm">
                  {t('approve')}
                </Button>
              </form>
              <form action={contestFeedbackPlanAction} className="flex-1 space-y-2">
                <input type="hidden" name="id" value={fb.id} />
                <Field label={t('contestLabel')}>
                  <textarea name="reason" rows={2} required className={inputCls} placeholder={t('contestPlaceholder')} />
                </Field>
                <Button type="submit" size="sm" variant="outline">
                  {t('contest')}
                </Button>
              </form>
            </div>
          </div>
        )}
      </Card>

      {canWithdraw && (
        <form action={cancelFeedbackAction}>
          <input type="hidden" name="id" value={fb.id} />
          <Button type="submit" size="sm" variant="ghost">
            {t('withdraw')}
          </Button>
        </form>
      )}

      {canRestore && (
        <form action={restoreFeedbackAction}>
          <input type="hidden" name="id" value={fb.id} />
          <Button type="submit" size="sm" variant="outline">
            {t('restore')}
          </Button>
        </form>
      )}
    </div>
  );
}
