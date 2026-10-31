'use client';

/**
 * Manager-review form (ADR-0022 slice 5). A client island so the "Draft with AI" affordance can drop
 * generated prose straight into the comments textarea for the manager to edit. The draft is advisory:
 * the textarea stays fully editable, and only the finalize submit (submitManagerAction) writes state.
 * The AI button only renders when the gateway is configured (aiEnabled), so it is never a dead button.
 */
import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2, Sparkles } from 'lucide-react';
import { Button, Field, inputCls } from '@/components/ui';
import { draftManagerReviewAction, submitManagerAction } from '../../actions';

type Scale = { value: number; label: string }[];

export function ManagerReviewForm({
  reviewId,
  scale,
  managerRating,
  overallRating,
  managerComments,
  recommendedMeritPct,
  recommendedBonus,
  aiEnabled,
}: {
  reviewId: string;
  scale: Scale;
  managerRating: number | null;
  overallRating: number | null;
  managerComments: string | null;
  recommendedMeritPct: number | null;
  recommendedBonus: number | null;
  aiEnabled: boolean;
}) {
  const t = useTranslations('performance.review');
  const [comments, setComments] = useState(managerComments ?? '');
  const [pending, startTransition] = useTransition();

  function onDraft() {
    startTransition(async () => {
      const res = await draftManagerReviewAction(reviewId);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      if (res.draft) {
        setComments(res.draft);
        toast.success(t('aiDraftSuccess'));
      }
    });
  }

  return (
    <div className="mt-3 space-y-4">
      {aiEnabled && (
        <div className="flex items-start justify-between gap-3 rounded-xl border border-border bg-muted/30 p-3">
          <p className="text-xs text-muted-foreground">{t('aiDraftHint')}</p>
          <Button type="button" variant="secondary" size="sm" onClick={onDraft} disabled={pending} className="shrink-0">
            {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
            {pending ? t('aiDrafting') : t('aiDraftButton')}
          </Button>
        </div>
      )}

      <form action={submitManagerAction} className="space-y-4">
        <input type="hidden" name="reviewId" value={reviewId} />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t('managerRatingLabel')}>
            <select name="managerRating" required defaultValue={managerRating ?? ''} className={inputCls}>
              <option value="" disabled>
                {t('selectRating')}
              </option>
              {scale.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.value} · {s.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('overallRatingLabel')}>
            <select name="overallRating" required defaultValue={overallRating ?? ''} className={inputCls}>
              <option value="" disabled>
                {t('selectRating')}
              </option>
              {scale.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.value} · {s.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label={t('commentsOptionalLabel')}>
          <textarea
            name="managerComments"
            rows={6}
            className={inputCls}
            value={comments}
            onChange={(e) => setComments(e.target.value)}
          />
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
                defaultValue={recommendedMeritPct ?? ''}
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
                defaultValue={recommendedBonus ?? ''}
                placeholder={t('oneOffBonusPlaceholder')}
              />
            </Field>
          </div>
        </div>
        <Button type="submit">{t('finalizeReview')}</Button>
      </form>
    </div>
  );
}
