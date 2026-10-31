import { getOnehrReview } from '@/packs/performance/service';
import { OnehrReviewView } from '../../onehr/review-view';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { peerFeedbackForReview, reviewForViewer, reviewGoals } from '@/core/performance';
import { isAiConfigured } from '@/core/ai-config';
import { Button, Card, ErrorBanner, Field, PageHeader, StatusBadge, inputCls } from '@/components/ui';
import { employeeLabel } from '@/lib/employee-code';
import { ManagerReviewForm } from './manager-review-form';
import {
  acknowledgeAction,
  linkGoalAction,
  requestPeerFeedbackAction,
  submitSelfAction,
  submitStageManagerAction,
  submitStageSelfAction,
  unlinkGoalAction,
  uploadAttachmentAction,
} from '../../actions';

function RatingSelect({
  name,
  scale,
  defaultValue,
  required,
  placeholder,
}: {
  name: string;
  scale: { value: number; label: string }[];
  defaultValue?: number | null;
  required?: boolean;
  placeholder: string;
}) {
  return (
    <select name={name} className={inputCls} required={required} defaultValue={defaultValue ?? ''}>
      <option value="" disabled>
        {placeholder}
      </option>
      {scale.map((s) => (
        <option key={s.value} value={s.value}>
          {s.value} · {s.label}
        </option>
      ))}
    </select>
  );
}

function ratingLabel(scale: { value: number; label: string }[], v: number | null) {
  if (v == null) return '—';
  const s = scale.find((x) => x.value === v);
  return s ? `${s.value} · ${s.label}` : String(v);
}

export default async function ReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ reviewId: string }>;
  searchParams: Promise<{ error?: string; toast?: string }>;
}) {
  const t = await getTranslations('performance.review');
  const tl = await getTranslations('performance.lifecycle');
  const s = await getSession();
  const { reviewId } = await params;
  const { error, toast } = await searchParams;
  const onehr = await getOnehrReview(s, reviewId);
  if (onehr) return <OnehrReviewView v={onehr} error={error}/>;
  const r = await reviewForViewer(s, reviewId);
  if (!r) notFound();
  const scale = r.ratingScale;
  const backHref = r.isSubject && !r.canManage ? '/me' : '/performance';
  const { linked: linkedGoals, linkable: linkableGoals } = await reviewGoals(s, reviewId);
  const f360 = await peerFeedbackForReview(s, reviewId);
  const aiEnabled = r.canManagerSubmit ? await isAiConfigured(s) : false;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        back={{ href: backHref, label: r.isSubject && !r.canManage ? t('backMyWorkspace') : t('backPerformance') }}
        title={`${employeeLabel(r.employeeCode, r.employee)} — ${r.cycleName}`}
        description={
          <>
            {r.periodStart} → {r.periodEnd}
            {r.reviewer ? ` · ${t('reviewerLabel', { reviewer: r.reviewer })}` : ''}
          </>
        }
        actions={<StatusBadge status={r.status} />}
      />
      <ErrorBanner message={error} />
      {toast && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-400">
          {toast}
        </div>
      )}

      {/* Self-review */}
      <Card className="p-5">
        <h2 className="text-sm font-semibold">{t('selfReviewTitle')}</h2>
        {r.canSelfSubmit ? (
          <form action={submitSelfAction} className="mt-3 space-y-4">
            <input type="hidden" name="reviewId" value={r.id} />
            <Field label={t('yourRatingLabel')}>
              <RatingSelect name="selfRating" scale={scale} required placeholder={t('selectRating')} />
            </Field>
            <Field label={t('commentsOptionalLabel')}>
              <textarea name="selfComments" rows={3} className={inputCls} placeholder={t('selfCommentsPlaceholder')} />
            </Field>
            <Field label={t('goalsReferencedLabel')}>
              <textarea name="goalsSummary" rows={2} className={inputCls} placeholder={t('goalsPlaceholder')} />
            </Field>
            <Button type="submit">{t('submitSelfReview')}</Button>
          </form>
        ) : r.selfRating != null ? (
          <dl className="mt-3 space-y-2 text-sm">
            <Row label={t('ratingLabel')} value={ratingLabel(scale, r.selfRating)} />
            {r.selfComments && <Row label={t('commentsLabel')} value={r.selfComments} />}
            {r.goalsSummary && <Row label={t('goalsLabel')} value={r.goalsSummary} />}
          </dl>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">{t('notSubmittedYet')}</p>
        )}
      </Card>

      {/* Mid-year stage (lifecycle) — own self + manager columns; status machine is the year-end one */}
      {r.stages.some((st) => st.kind === 'mid_year') && (
        <Card className="p-5">
          <h2 className="text-sm font-semibold">{tl('stageMidYear')}</h2>
          <div className="mt-3 grid gap-5 sm:grid-cols-2">
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{tl('selfRating')}</p>
              {r.isSubject ? (
                <form action={submitStageSelfAction} className="space-y-3">
                  <input type="hidden" name="reviewId" value={r.id} />
                  <input type="hidden" name="stage" value="mid_year" />
                  <RatingSelect name="selfRating" scale={scale} defaultValue={r.midSelfRating} required placeholder={t('selectRating')} />
                  <textarea name="selfComments" rows={2} defaultValue={r.midSelfComments ?? ''} className={inputCls} placeholder={t('selfCommentsPlaceholder')} />
                  <Button type="submit" size="sm">{tl('submitSelf')}</Button>
                </form>
              ) : (
                <p className="text-sm">{ratingLabel(scale, r.midSelfRating)}</p>
              )}
            </div>
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{tl('managerRating')}</p>
              {r.canManage ? (
                <form action={submitStageManagerAction} className="space-y-3">
                  <input type="hidden" name="reviewId" value={r.id} />
                  <input type="hidden" name="stage" value="mid_year" />
                  <RatingSelect name="managerRating" scale={scale} defaultValue={r.midManagerRating} required placeholder={t('selectRating')} />
                  <textarea name="managerComments" rows={2} defaultValue={r.midManagerComments ?? ''} className={inputCls} placeholder={t('selfCommentsPlaceholder')} />
                  <Button type="submit" size="sm" variant="secondary">{tl('submitManager')}</Button>
                </form>
              ) : (
                <p className="text-sm">{r.midManagerRating != null ? ratingLabel(scale, r.midManagerRating) : t('managerReviewPendingRelease')}</p>
              )}
            </div>
          </div>
        </Card>
      )}

      {/* Goals referenced (ADR-0022) — the manager links the subject's goals onto this review */}
      {(linkedGoals.length > 0 || r.canManage) && (
        <Card className="p-5">
          <h2 className="text-sm font-semibold">{t('goalsCardTitle')}</h2>
          {linkedGoals.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">{t('goalsCardEmpty')}</p>
          ) : (
            <ul className="mt-3 space-y-2.5">
              {linkedGoals.map((g) => (
                <li key={g.id} className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{g.title}</span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">{t(`goalStatus_${g.status}`)}</span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-primary" style={{ width: `${g.progress}%` }} />
                    </div>
                  </div>
                  <span className="w-9 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{g.progress}%</span>
                  {r.canManage && (
                    <form action={unlinkGoalAction}>
                      <input type="hidden" name="reviewId" value={r.id} />
                      <input type="hidden" name="goalId" value={g.id} />
                      <Button type="submit" size="sm" variant="ghost">
                        {t('goalUnlink')}
                      </Button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )}
          {r.canManage && linkableGoals.length > 0 && (
            <form action={linkGoalAction} className="mt-4 flex items-end gap-2 border-t border-border pt-3">
              <input type="hidden" name="reviewId" value={r.id} />
              <Field label={t('goalLinkLabel')}>
                <select name="goalId" required className={inputCls} defaultValue="">
                  <option value="" disabled>
                    {t('goalLinkPlaceholder')}
                  </option>
                  {linkableGoals.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.title}
                    </option>
                  ))}
                </select>
              </Field>
              <Button type="submit" variant="secondary">
                {t('goalLink')}
              </Button>
            </form>
          )}
        </Card>
      )}

      {/* 360 peer feedback (ADR-0022) — manager invites + sees attributed; subject sees anonymized after release */}
      {(f360.canManage || f360.feedback.length > 0) && (
        <Card className="p-5">
          <h2 className="text-sm font-semibold">{t('feedback360Title')}</h2>
          {f360.canManage && (
            <p className="mt-1 text-xs text-muted-foreground">{t('feedback360ManagerHint')}</p>
          )}
          {!f360.canManage && (
            <p className="mt-1 text-xs text-muted-foreground">{t('feedback360SubjectHint')}</p>
          )}

          {f360.feedback.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">
              {f360.canManage && f360.pending > 0 ? t('feedback360Pending', { count: f360.pending }) : t('feedback360Empty')}
            </p>
          ) : (
            <ul className="mt-3 space-y-3">
              {f360.feedback.map((fb) => (
                <li key={fb.id} className="rounded-xl border border-border bg-muted/20 p-3 text-sm">
                  <div className="text-xs font-medium text-muted-foreground">
                    {fb.peer ? fb.peer : t('feedback360Anonymous')}
                  </div>
                  {fb.strengths && (
                    <p className="mt-1">
                      <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">{t('feedbackStrengths')}: </span>
                      {fb.strengths}
                    </p>
                  )}
                  {fb.improvements && (
                    <p className="mt-1">
                      <span className="text-xs font-medium text-amber-600 dark:text-amber-400">{t('feedbackImprovements')}: </span>
                      {fb.improvements}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}

          {f360.canManage && f360.invitable.length > 0 && (
            <form action={requestPeerFeedbackAction} className="mt-4 border-t border-border pt-3">
              <input type="hidden" name="reviewId" value={r.id} />
              <p className="mb-2 text-xs font-medium text-muted-foreground">{t('feedback360Invite')}</p>
              <div className="flex flex-wrap gap-3">
                {f360.invitable.map((p) => (
                  <label key={p.employmentId} className="flex items-center gap-1.5 text-sm">
                    <input type="checkbox" name="peerEmploymentId" value={p.employmentId} className="size-4" />
                    {p.name}
                  </label>
                ))}
              </div>
              <div className="mt-3 flex justify-end">
                <Button type="submit" variant="secondary">
                  {t('feedback360Request')}
                </Button>
              </div>
            </form>
          )}
        </Card>
      )}

      {/* Manager review */}
      <Card className="p-5">
        <h2 className="text-sm font-semibold">{t('managerReviewTitle')}</h2>
        {r.canManagerSubmit ? (
          <ManagerReviewForm
            reviewId={r.id}
            scale={scale}
            managerRating={r.managerRating}
            overallRating={r.overallRating}
            managerComments={r.managerComments}
            recommendedMeritPct={r.recommendedMeritPct}
            recommendedBonus={r.recommendedBonus}
            aiEnabled={aiEnabled}
          />
        ) : r.managerRating != null || r.overallRating != null ? (
          <dl className="mt-3 space-y-2 text-sm">
            <Row label={t('managerRatingLabel')} value={ratingLabel(scale, r.managerRating)} />
            <Row label={t('overallRatingLabel')} value={ratingLabel(scale, r.overallRating)} />
            {r.managerComments && <Row label={t('commentsLabel')} value={r.managerComments} />}
          </dl>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">
            {r.isSubject && !r.released
              ? t('managerReviewPendingRelease')
              : t('awaitingManager')}
          </p>
        )}
      </Card>

      {/* Comp recommendation (manager/admin only) */}
      {r.canManage && r.compActionStatus !== 'none' && (
        <Card className="p-5">
          <h2 className="text-sm font-semibold">{t('payRecommendationTitle')}</h2>
          <dl className="mt-3 space-y-2 text-sm">
            {r.recommendedMeritPct != null && <Row label={t('meritLabel')} value={`${r.recommendedMeritPct}%`} />}
            {r.recommendedBonus != null && <Row label={t('bonusLabel')} value={`RM ${r.recommendedBonus.toFixed(2)}`} />}
            <Row label={t('statusLabel')} value={r.compActionStatus} />
          </dl>
          <p className="mt-2 text-xs text-muted-foreground">{t('enactFromCyclePage')}</p>
        </Card>
      )}

      {/* Closure summary (lifecycle G4) — final score + ABC, shown once finalized + released */}
      {(r.closed || r.finalScore != null || r.abcClass != null) && (
        <Card className="p-5">
          <h2 className="text-sm font-semibold">{tl('closurePanelTitle')}</h2>
          <dl className="mt-3 space-y-2 text-sm">
            {r.finalScore != null && <Row label={tl('finalScore')} value={String(r.finalScore)} />}
            {r.abcClass != null && <Row label={tl('abcClass')} value={r.abcClass} />}
            {r.closed && <Row label={t('statusLabel')} value={tl('closed')} />}
          </dl>
        </Card>
      )}

      {/* Attachments (lifecycle G5) — subject-scoped: visible to the subject + their manager/admin only */}
      {(r.isSubject || r.canManage) && (
        <Card className="p-5">
          <h2 className="text-sm font-semibold">{tl('attachmentsTitle')}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{tl('attachmentsHint')}</p>
          {r.attachments.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">{tl('attachmentEmpty')}</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {r.attachments.map((att) => (
                <li key={att.id} className="flex items-center justify-between gap-3 text-sm">
                  <span className="min-w-0 flex-1 truncate">
                    {att.fileName}
                    {att.stageKind && (
                      <span className="ml-2 text-[10px] text-muted-foreground">
                        {att.stageKind === 'goal_setting' ? tl('stageGoalSetting') : att.stageKind === 'mid_year' ? tl('stageMidYear') : tl('stageYearEnd')}
                      </span>
                    )}
                  </span>
                  <a className="shrink-0 text-xs text-primary underline" href={`/performance/attachment/${att.id}`}>
                    {tl('attachmentDownload')}
                  </a>
                </li>
              ))}
            </ul>
          )}
          <form action={uploadAttachmentAction} className="mt-4 flex flex-wrap items-end gap-2 border-t border-border pt-3">
            <input type="hidden" name="reviewId" value={r.id} />
            <Field label={tl('stagesField')}>
              <select name="stageKind" className={inputCls} defaultValue="">
                <option value="">—</option>
                <option value="goal_setting">{tl('stageGoalSetting')}</option>
                <option value="mid_year">{tl('stageMidYear')}</option>
                <option value="year_end">{tl('stageYearEnd')}</option>
              </select>
            </Field>
            <input type="file" name="file" required className="text-sm" />
            <Button type="submit" variant="secondary">{tl('attachmentUpload')}</Button>
          </form>
        </Card>
      )}

      {/* Acknowledge */}
      {r.canAcknowledge && (
        <Card className="p-5">
          <p className="text-sm text-muted-foreground">
            {t('acknowledgeHint')}
          </p>
          <form action={acknowledgeAction} className="mt-3">
            <input type="hidden" name="reviewId" value={r.id} />
            <Button type="submit">{t('acknowledge')}</Button>
          </form>
        </Card>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3">
      <dt className="w-32 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="whitespace-pre-wrap">{value}</dd>
    </div>
  );
}
