'use client';

/**
 * Probation / contract / internship review — HR-decision progressive-disclosure form (R4 Build #4).
 *
 * A tiny client island over the EXISTING advisory `decideReviewAction`. Selecting Confirm / Extend /
 * Terminate reveals ONLY that decision's fields; irrelevant inputs are OMITTED from the DOM (not hidden)
 * so stale values never POST. This is UI ONLY — the recorded decision + letter are exactly as today, and
 * the decision stays ADVISORY (no automatic end-date move, no termination). See review-decide-fields.ts
 * for the field map and core/employment-review.ts for the unchanged advisory service contract.
 *
 *   confirm   → no extra fields (single-step submit).
 *   extend    → New End Date (required, posts extendToDate) + Extension Reason (optional, posts hrComments).
 *   terminate → Termination Reason dropdown (required, posts hrComments — advisory text only).
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button, inputCls } from '@/components/ui';
import { decideReviewAction } from './actions';
import {
  REVIEW_DECISIONS,
  TERMINATION_REASONS,
  fieldsForDecision,
  type ReviewDecision,
} from './review-decide-fields';

export function ReviewDecideForm({ reviewId }: { reviewId: string }) {
  const t = useTranslations('review');
  const [decision, setDecision] = useState<ReviewDecision>('confirm');
  const fields = fieldsForDecision(decision);

  return (
    <form action={decideReviewAction} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="id" value={reviewId} />
      <label className="text-xs text-muted-foreground">
        {t('decision.label')}
        <select
          name="decision"
          required
          value={decision}
          onChange={(e) => setDecision(e.target.value as ReviewDecision)}
          className={`${inputCls} mt-1`}
        >
          {REVIEW_DECISIONS.map((d) => (
            <option key={d} value={d}>
              {t(`decision.${d}` as 'decision.confirm')}
            </option>
          ))}
        </select>
      </label>

      {/* Extend → required New End Date (reuses the existing extendToDate column + label). */}
      {fields.includes('extendToDate') && (
        <label className="text-xs text-muted-foreground">
          {t('extendToDate')}
          <input name="extendToDate" type="date" required className={`${inputCls} mt-1`} />
        </label>
      )}

      {/* Extend → optional Extension Reason (posts as hrComments — advisory text). */}
      {fields.includes('extensionReason') && (
        <input name="hrComments" placeholder={t('extensionReason')} className={`${inputCls} flex-1`} />
      )}

      {/* Terminate → required Termination Reason dropdown (posts as hrComments — advisory text only). */}
      {fields.includes('terminationReason') && (
        <label className="text-xs text-muted-foreground">
          {t('terminationReason.label')}
          <select name="hrComments" required defaultValue="" className={`${inputCls} mt-1`}>
            <option value="" disabled>
              {t('terminationReason.placeholder')}
            </option>
            {TERMINATION_REASONS.map((r) => (
              <option key={r} value={r}>
                {t(`terminationReason.${r}` as 'terminationReason.contract_end')}
              </option>
            ))}
          </select>
        </label>
      )}

      <Button type="submit" size="sm">
        {t('recordDecision')}
      </Button>
    </form>
  );
}
