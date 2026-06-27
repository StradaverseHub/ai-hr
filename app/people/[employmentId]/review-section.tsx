// Review section on the employee profile (0110, §4.1). Mirrors the Terminate/Transfer sections; gated by
// the caller (admin/manager) at the page level. Shows the current employment type, the relevant end-date
// and computed due-date, AND: the "Set review end date" control (if unset), a Start Review button (if a
// date is set and no open review), or an inline status card (if a review is open).
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { Card, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { reviewProfile, type ReviewType } from '@/core/employment-review';
import { reviewsFor } from '@/core/employment-review';
import type { SessionContext } from '@/db/client';
import { setReviewEndDateAction, startReviewAction } from './actions';

const REVIEW_TYPES: ReviewType[] = ['probation', 'contract', 'internship'];

export async function ReviewSection({ s, employmentId }: { s: SessionContext; employmentId: string }) {
  const t = await getTranslations('review');
  const profile = await reviewProfile(s, employmentId);
  if (!profile) return null;
  const history = await reviewsFor(s, employmentId);

  const typeLabel = (rt: ReviewType) => t(`reviewType.${rt}` as 'reviewType.probation');

  return (
    <Card className="overflow-hidden">
      <SectionHeader title={t('sectionTitle')} />
      <div className="space-y-4 px-4 py-4 text-sm">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
          <dt className="text-muted-foreground">{t('currentType')}</dt>
          <dd className="tabular-nums">{profile.employmentType}</dd>
          {profile.reviewType && (
            <>
              <dt className="text-muted-foreground">{t('endDate')}</dt>
              <dd className="tabular-nums">{profile.endDate ?? '—'}</dd>
              <dt className="text-muted-foreground">{t('dueDate')}</dt>
              <dd className="tabular-nums">{profile.dueDate ?? '—'}</dd>
            </>
          )}
        </dl>

        {profile.reviewType && profile.openReview ? (
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2">
            <div className="font-medium">{t('reviewInProgress')}</div>
            <div className="text-xs text-muted-foreground">
              {t(`stage.${profile.openReview.status}` as 'stage.pending_manager')}
            </div>
            <Link href="/approvals" className="mt-1 inline-block text-xs text-primary underline-offset-2 hover:underline">
              {t('viewInApprovals')}
            </Link>
          </div>
        ) : profile.reviewType && !profile.endDate ? (
          // §1.8 — set the end date (the smallest surface that makes the feature non-inert on day one).
          <form action={setReviewEndDateAction} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="employmentId" value={employmentId} />
            <label className="text-xs text-muted-foreground">
              {t('setEndDate')}
              <select name="reviewType" defaultValue={profile.reviewType} className={`${inputCls} mt-1`}>
                {REVIEW_TYPES.map((rt) => (
                  <option key={rt} value={rt}>
                    {typeLabel(rt)}
                  </option>
                ))}
              </select>
            </label>
            <input name="endDate" type="date" required className={inputCls} />
            <button className={btnPrimary}>{t('setEndDate')}</button>
          </form>
        ) : profile.reviewType ? (
          <form action={startReviewAction}>
            <input type="hidden" name="employmentId" value={employmentId} />
            <button className={btnPrimary}>{t('startReview')}</button>
          </form>
        ) : null}

        {history.length > 0 && (
          <ul className="divide-y divide-border border-t border-border pt-2 text-xs">
            {history.map((r) => (
              <li key={r.id} className="flex items-center justify-between py-1.5">
                <span>
                  {typeLabel(r.reviewType)} · {t(`stage.${r.status}` as 'stage.completed')}
                  {r.decision ? ` · ${t(`decision.${r.decision}` as 'decision.confirm')}` : ''}
                </span>
                {r.status === 'completed' && (
                  <a
                    href={`/people/${employmentId}/review/${r.id}/letter`}
                    className="text-primary underline-offset-2 hover:underline"
                  >
                    {t('downloadLetter')}
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
