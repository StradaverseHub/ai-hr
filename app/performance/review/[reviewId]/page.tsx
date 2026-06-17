import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { reviewForViewer, reviewGoals } from '@/core/performance';
import { Button, Card, ErrorBanner, Field, PageHeader, StatusBadge, inputCls } from '@/components/ui';
import {
  acknowledgeAction,
  linkGoalAction,
  submitManagerAction,
  submitSelfAction,
  unlinkGoalAction,
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
  const s = await getSession();
  const { reviewId } = await params;
  const { error, toast } = await searchParams;
  const r = await reviewForViewer(s, reviewId);
  if (!r) notFound();
  const scale = r.ratingScale;
  const backHref = r.isSubject && !r.canManage ? '/me' : '/performance';
  const { linked: linkedGoals, linkable: linkableGoals } = await reviewGoals(s, reviewId);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        back={{ href: backHref, label: r.isSubject && !r.canManage ? t('backMyWorkspace') : t('backPerformance') }}
        title={`${r.employee} — ${r.cycleName}`}
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

      {/* Manager review */}
      <Card className="p-5">
        <h2 className="text-sm font-semibold">{t('managerReviewTitle')}</h2>
        {r.canManagerSubmit ? (
          <form action={submitManagerAction} className="mt-3 space-y-4">
            <input type="hidden" name="reviewId" value={r.id} />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label={t('managerRatingLabel')}>
                <RatingSelect name="managerRating" scale={scale} required defaultValue={r.managerRating} placeholder={t('selectRating')} />
              </Field>
              <Field label={t('overallRatingLabel')}>
                <RatingSelect name="overallRating" scale={scale} required defaultValue={r.overallRating} placeholder={t('selectRating')} />
              </Field>
            </div>
            <Field label={t('commentsOptionalLabel')}>
              <textarea name="managerComments" rows={3} className={inputCls} defaultValue={r.managerComments ?? ''} />
            </Field>
            <div className="rounded-xl border border-border bg-muted/30 p-3">
              <p className="text-xs font-medium text-muted-foreground">{t('payRecommendationHint')}</p>
              <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label={t('meritIncreaseLabel')}>
                  <input
                    name="recommendedMeritPct"
                    type="number"
                    min="0"
                    step="0.1"
                    className={inputCls}
                    defaultValue={r.recommendedMeritPct ?? ''}
                    placeholder={t('meritIncreasePlaceholder')}
                  />
                </Field>
                <Field label={t('oneOffBonusLabel')}>
                  <input
                    name="recommendedBonus"
                    type="number"
                    min="0"
                    step="0.01"
                    className={inputCls}
                    defaultValue={r.recommendedBonus ?? ''}
                    placeholder={t('oneOffBonusPlaceholder')}
                  />
                </Field>
              </div>
            </div>
            <Button type="submit">{t('finalizeReview')}</Button>
          </form>
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
