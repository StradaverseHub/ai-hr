import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { getFeedback } from '@/core/feedback';
import { Button, Card, ErrorBanner, Field, PageHeader, SectionHeader, inputCls } from '@/components/ui';
import { statusTone } from '../page';
import {
  answerBlockingQuestionAction,
  approveFeedbackPlanAction,
  cancelFeedbackAction,
  contestFeedbackPlanAction,
  generateFeedbackPlanNowAction,
  refuteDeploymentAction,
  restoreFeedbackAction,
} from '../actions';
import { settingEnabledOrDefault } from '@/core/entitlements';

/** Which label names the reporter's answer to a plan version (0318). */
function outcomeKey(outcome: string): string {
  switch (outcome) {
    case 'contested':
      return 'historyContested';
    case 'refuted':
      return 'historyRefuted';
    default:
      return 'historySuperseded';
  }
}

/** Approval reads green, push-back rose, a silent replacement stays neutral — it carries no reporter voice. */
function outcomeTone(outcome: string): string {
  switch (outcome) {
    case 'contested':
    case 'refuted':
      return 'bg-rose-50 text-rose-800 dark:bg-rose-500/10 dark:text-rose-300';
    default:
      return 'bg-muted/40 text-muted-foreground';
  }
}

const fmtDate = (d: Date | string) =>
  new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

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
  // 0323 — `blocked` means "waiting on an answer only the reporter can give", and every gate above it
  // covered some OTHER status, so the one state that explicitly asks a question had no way to receive one.
  const canAnswer = (isReporter || isAdmin) && fb.status === 'blocked';
  // In-app planning is disabled by default — plans come from the operator-side improvement loop (ADR-0044).
  const inAppPlanning = settingEnabledOrDefault(s, 'feedback.ai_planning_enabled');
  const canGeneratePlan = inAppPlanning && isAdmin && (fb.status === 'open' || fb.status === 'contested');
  // 0406 — mockups of the CURRENT plan, rendered inline beside it. Two filters, both load-bearing:
  // the revision (an older generation would illustrate a proposal that no longer exists) and the mime
  // (`plan` stage accepts whatever was attached, and a PDF in an <img> is a broken image, so anything
  // non-image falls through to the link list at the top of the page rather than rendering blank).
  const planMockups = fb.attachments.filter(
    (a) => a.stage === 'plan' && a.planRevision === fb.planRevision && (a.mimeType ?? '').startsWith('image/'),
  );

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
            {/* 0321 — grouped by the round each image arrived in. Ungrouped, a screenshot showing "still
                wrong after you shipped it" sits beside the original bug screenshot with nothing to tell
                them apart, which on a three-round item is a pile of pictures and no story. */}
            {/* 0406 — `plan` joins the list so nothing is ever invisible: a mockup that is NOT rendered
                inline below (an older revision, or a PDF rather than an image) still has to be reachable,
                and a stage missing from this array would drop its attachments off the page entirely with
                no error. The ones already shown inline are excluded so they are not listed twice. */}
            {(['submitted', 'contested', 'refuted', 'plan'] as const).map((stage) => {
              const forStage = fb.attachments.filter(
                (a) => (a.stage ?? 'submitted') === stage && !planMockups.some((m) => m.id === a.id),
              );
              if (forStage.length === 0) return null;
              return (
                <div key={stage} className="mt-2">
                  <div className="text-[11px] text-muted-foreground">
                    {t(`attachStage_${stage}`)}
                    {stage !== 'submitted' && forStage[0].planRevision != null
                      ? ` · ${t('historyPlanV', { n: forStage[0].planRevision })}`
                      : ''}
                  </div>
                  <ul className="mt-1 flex flex-wrap gap-2">
                    {forStage.map((a) => (
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
              );
            })}
          </div>
        )}
      </Card>

      {/* 0318 — the negotiation, oldest first. Before this existed, each re-plan overwrote the previous
          plan and cleared the push-back that caused it, so a reporter could not see why the current plan
          says what it says. */}
      {(fb.planHistory.length > 0 || fb.planRevision > 0 || fb.blockHistory.length > 0) && (
        <Card className="p-5">
          <SectionHeader title={t('historyTitle')} />

          {/* The request itself is the first entry — the history starts with what was asked for, not
              with our first answer to it. */}
          <ol className="mt-3 space-y-4">
            <li className="relative border-l-2 border-border pl-4">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('historyRequest')}</div>
              <div className="mt-1 whitespace-pre-wrap text-sm">{fb.description}</div>
            </li>

            {fb.planHistory.map((rev) => (
              <li key={rev.id} className="relative border-l-2 border-border pl-4">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {t('historyPlanV', { n: rev.revision })}
                  </span>
                  <span className="text-xs text-muted-foreground">{fmtDate(rev.draftedAt)}</span>
                </div>
                <div className="mt-1 whitespace-pre-wrap rounded-lg border border-border bg-muted/30 p-3 text-sm">
                  {rev.plan}
                </div>

                {/* Approval is shown separately from how the version ended: a plan can be approved AND
                    later sent back after shipping, and both are things the reporter did to it. */}
                {rev.approvedAt && (
                  <div className="mt-2 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300">
                    <div className="text-xs font-medium uppercase tracking-wide">{t('historyApproved')}</div>
                    <div className="mt-1 text-xs opacity-70">{fmtDate(rev.approvedAt)}</div>
                  </div>
                )}

                {/* How the reporter answered THIS version, attached to it rather than floating loose —
                    the point of the whole table. */}
                {rev.outcome && (
                  <div className={`mt-2 rounded-lg p-3 text-sm ${outcomeTone(rev.outcome)}`}>
                    <div className="text-xs font-medium uppercase tracking-wide">{t(outcomeKey(rev.outcome))}</div>
                    {rev.outcomeReason && <div className="mt-0.5 whitespace-pre-wrap">{rev.outcomeReason}</div>}
                    {rev.outcomeAt && <div className="mt-1 text-xs opacity-70">{fmtDate(rev.outcomeAt)}</div>}
                  </div>
                )}
                {!rev.outcome && !rev.approvedAt && (
                  <div className="mt-2 text-xs text-muted-foreground">{t('historyCurrent')}</div>
                )}
              </li>
            ))}
          </ol>

          {/* 0323 — the questions this item was parked on, and what was said back. They live here rather
              than on the item itself because `blockedReason` is wiped when the item returns to the queue:
              without this, answering a question would erase the question. Shown for a RESOLVED episode
              too, so a reader six weeks later can see the decision the build was made on. */}
          {fb.blockHistory.length > 0 && (
            <ol className="mt-4 space-y-4 border-t border-border pt-4">
              {fb.blockHistory.map((b) => (
                <li key={b.id} className="relative border-l-2 border-amber-300 pl-4 dark:border-amber-500/40">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      {t('historyQuestion')}
                    </span>
                    <span className="text-xs text-muted-foreground">{fmtDate(b.askedAt)}</span>
                  </div>
                  <div className="mt-1 whitespace-pre-wrap rounded-lg border border-amber-200 bg-amber-50/60 p-3 text-sm dark:border-amber-500/30 dark:bg-amber-500/10">
                    {b.question}
                  </div>
                  {b.answer ? (
                    <div className="mt-2 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300">
                      <div className="text-xs font-medium uppercase tracking-wide">{t('historyAnswer')}</div>
                      <div className="mt-0.5 whitespace-pre-wrap">{b.answer}</div>
                      {b.resolvedAt && <div className="mt-1 text-xs opacity-70">{fmtDate(b.resolvedAt)}</div>}
                    </div>
                  ) : (
                    // Two different silences, and conflating them would misreport the history: one is a
                    // question still waiting, the other is a wait an operator ended without an answer.
                    <div className="mt-2 text-xs text-muted-foreground">
                      {b.resolvedAt ? t('historyQuestionUnanswered') : t('historyQuestionOpen')}
                    </div>
                  )}
                </li>
              ))}
            </ol>
          )}

          {/* Say the gap out loud. planRevision counts every version ever drafted; planHistory only has
              the ones recorded since 0318. Showing a partial history as if it were whole is exactly the
              failure this section exists to fix. */}
          {fb.planRevision > fb.planHistory.length && (
            <p className="mt-4 rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
              {t('historyGap', { n: fb.planRevision - fb.planHistory.length })}
            </p>
          )}
          {fb.planHistory.length === 0 && fb.planRevision === 0 && fb.blockHistory.length === 0 && (
            <p className="mt-3 text-sm text-muted-foreground">{t('historyEmpty')}</p>
          )}
        </Card>
      )}

      {/* The AI-written implementation plan */}
      <Card className="p-5">
        <SectionHeader title={t('planTitle')} />
        {fb.plan ? (
          <>
            <p className="px-1 pt-2 text-xs text-muted-foreground">{t('planRevision', { n: fb.planRevision })}</p>
            <div className="mt-2 whitespace-pre-wrap rounded-lg border border-border bg-muted/30 p-4 text-sm">{fb.plan}</div>
            {/* 0406 — the mockups for THIS revision, shown with the plan rather than with the reporter's
                own screenshots at the top of the page. Two reasons they cannot live up there: the block
                above is "what the reporter sent us", and mixing our answer into it loses who is speaking;
                and a mockup only means anything next to the words it illustrates.

                FILTERED BY REVISION, not just by stage. An item re-planned three times carries three
                generations of mockup, and showing an older one beside the current plan would be showing a
                picture of a proposal that no longer exists — the exact failure 0318 fixed for plan TEXT
                and 0321 fixed for the reporter's images. Older ones stay reachable in the timeline below.

                Rendered INLINE, not as a link. The whole point is that the reporter SEES it without
                deciding to click; a `↗ filename` link is what the prose already was. */}
            {planMockups.length > 0 && (
              <div className="mt-3">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t('planMockupsHeading')}
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">{t('planMockupsCaveat')}</p>
                <ul className="mt-2 space-y-3">
                  {planMockups.map((a) => (
                    <li key={a.id}>
                      <a href={`/feedback/attachment/${a.id}?inline=1`} target="_blank" rel="noreferrer" className="block">
                        {/* eslint-disable-next-line @next/next/no-img-element -- the bytes come from our
                            own attachment route, which streams a stored blob with no known dimensions;
                            next/image needs a width/height or a loader and neither exists for a blob. */}
                        <img
                          src={`/feedback/attachment/${a.id}?inline=1`}
                          alt={a.fileName}
                          className="w-full rounded-lg border border-border bg-background"
                        />
                      </a>
                      <div className="mt-1 text-xs text-muted-foreground">{a.fileName}</div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
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

        {fb.status === 'blocked' && (
          <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50/60 p-3 text-sm dark:border-amber-500/30 dark:bg-amber-500/10">
            <div className="text-xs font-medium uppercase tracking-wide text-amber-800 dark:text-amber-400">
              {t('status_blocked')}
            </div>
            <div className="mt-0.5">{t('blocked_banner')}</div>
            {fb.blockedReason && <div className="mt-1">{fb.blockedReason}</div>}
            {/* Link, not an id: the reporter has to be able to reach the question to answer it. */}
            {fb.blockedBy && (
              <a href={`/feedback/${fb.blockedBy.id}`} className="mt-1.5 inline-block text-xs font-medium text-primary hover:underline">
                {t('blocked_waiting_on', { title: fb.blockedBy.title })} ↗
              </a>
            )}

            {/* 0323 — THE FIX. The banner above stated a question and offered nothing to answer it with:
                the reporter could read "which submission channels do you use?" and had no reply box on the
                page, so the loop stalled indefinitely on a question only they could settle. Sending the
                answer records it against the question and returns the item to the build queue. */}
            {canAnswer && (
              <form action={answerBlockingQuestionAction} className="mt-3 space-y-2 border-t border-amber-200 pt-3 dark:border-amber-500/30">
                <input type="hidden" name="id" value={fb.id} />
                <p className="text-sm font-medium">{t('answerPrompt')}</p>
                <Field label={t('answerLabel')}>
                  <textarea name="answer" rows={3} required className={inputCls} placeholder={t('answerPlaceholder')} />
                </Field>
                <Button type="submit" size="sm">
                  {t('answerSubmit')}
                </Button>
              </form>
            )}
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
          <form
            action={refuteDeploymentAction}
            encType="multipart/form-data"
            className="mt-4 space-y-2 border-t border-border pt-4"
          >
            <input type="hidden" name="id" value={fb.id} />
            <p className="text-sm font-medium">{t('refutePrompt')}</p>
            <Field label={t('refuteLabel')}>
              <textarea name="reason" rows={2} required className={inputCls} placeholder={t('refutePlaceholder')} />
            </Field>
            {/* 0321 — a push-back is exactly the message a screenshot carries best ("here is what is
                still wrong"), and until now it was the one moment the reporter could not provide one.
                The form needs multipart encoding for the file to survive the submit. */}
            <Field label={t('attachLabel')}>
              <input
                type="file"
                name="attachments"
                multiple
                className={inputCls}
                accept="image/*,.pdf,.doc,.docx,.txt"
              />
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
              <form action={contestFeedbackPlanAction} encType="multipart/form-data" className="flex-1 space-y-2">
                <input type="hidden" name="id" value={fb.id} />
                <Field label={t('contestLabel')}>
                  <textarea name="reason" rows={2} required className={inputCls} placeholder={t('contestPlaceholder')} />
                </Field>
                <Field label={t('attachLabel')}>
                  <input
                    type="file"
                    name="attachments"
                    multiple
                    className={inputCls}
                    accept="image/*,.pdf,.doc,.docx,.txt"
                  />
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
