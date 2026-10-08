// Review section on the employee profile (0110, §4.1). Mirrors the Terminate/Transfer sections; gated by
// the caller (admin/manager) at the page level. Shows the current employment type, the relevant end-date
// and computed due-date, AND: the "Set review end date" control (if unset), a Start Review button (if a
// date is set and no open review), or an inline status card (if a review is open).
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { Card, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { reviewDocumentsFor, reviewProfile, type ReviewType } from '@/core/employment-review';
import { reviewsFor } from '@/core/employment-review';
import type { SessionContext } from '@/db/client';
import { DateField } from '@/components/ui/date-field';
import { formatDmy } from '@/lib/date-display';
import { saveReviewLetterAction, setReviewEndDateAction, startReviewAction, uploadReviewDocumentAction } from './actions';

const REVIEW_TYPES: ReviewType[] = ['probation', 'contract', 'internship'];

export async function ReviewSection({ s, employmentId }: { s: SessionContext; employmentId: string }) {
  const t = await getTranslations('review');
  const profile = await reviewProfile(s, employmentId);
  if (!profile) return null;
  const history = await reviewsFor(s, employmentId);
  // 6522d26a Fn 5 — stored letter documents, grouped per review (one read for the whole history).
  const documents = await reviewDocumentsFor(s, employmentId);
  const docsByReview = new Map<string, typeof documents>();
  for (const d of documents) {
    const list = docsByReview.get(d.reviewId) ?? [];
    list.push(d);
    docsByReview.set(d.reviewId, list);
  }

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
              <dd className="tabular-nums">{formatDmy(profile.endDate)}</dd>
              <dt className="text-muted-foreground">{t('dueDate')}</dt>
              <dd className="tabular-nums">{formatDmy(profile.dueDate)}</dd>
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
            <DateField name="endDate" required className={inputCls} label={t('endDate')} />
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
            {history.map((r) => {
              const docs = docsByReview.get(r.id) ?? [];
              const hasSystemLetter = docs.some((d) => d.kind === 'system_letter');
              return (
                <li key={r.id} className="py-1.5">
                  <div className="flex items-center justify-between">
                    <span>
                      {typeLabel(r.reviewType)} · {t(`stage.${r.status}` as 'stage.completed')}
                      {r.decision ? ` · ${t(`decision.${r.decision}` as 'decision.confirm')}` : ''}
                    </span>
                    {r.status === 'completed' && (
                      <a
                        href={`/admin/personnel/${employmentId}/review/${r.id}/letter`}
                        className="text-primary underline-offset-2 hover:underline"
                      >
                        {t('downloadLetter')}
                      </a>
                    )}
                  </div>
                  {r.status === 'completed' && (
                    // 6522d26a Fn 5 — the letter document store: persisted system letter + HR-uploaded
                    // signed copy. What lands here is what the employee sees in ESS (Fn 6).
                    <div className="mt-1.5 space-y-1.5 rounded-md border border-border bg-muted/20 px-2.5 py-2">
                      <div className="font-medium text-muted-foreground">{t('documents')}</div>
                      {docs.length > 0 && (
                        <ul className="space-y-0.5">
                          {docs.map((d) => (
                            <li key={d.id} className="flex items-center justify-between gap-2">
                              <span className="truncate">
                                {t(`documentKind.${d.kind}` as 'documentKind.signed_letter')} · {d.fileName}
                              </span>
                              <a
                                href={`/admin/personnel/${employmentId}/review/${r.id}/document/${d.id}`}
                                className="shrink-0 text-primary underline-offset-2 hover:underline"
                              >
                                {t('download')}
                              </a>
                            </li>
                          ))}
                        </ul>
                      )}
                      <div className="flex flex-wrap items-center gap-2 pt-0.5">
                        {!hasSystemLetter && (
                          <form action={saveReviewLetterAction}>
                            <input type="hidden" name="employmentId" value={employmentId} />
                            <input type="hidden" name="reviewId" value={r.id} />
                            <button className="text-primary underline-offset-2 hover:underline">{t('saveLetterToRecord')}</button>
                          </form>
                        )}
                        <form action={uploadReviewDocumentAction} className="flex flex-wrap items-center gap-2">
                          <input type="hidden" name="employmentId" value={employmentId} />
                          <input type="hidden" name="reviewId" value={r.id} />
                          <label className="text-muted-foreground">
                            {t('uploadSignedLetter')}
                            <input
                              type="file"
                              name="document"
                              accept="application/pdf,image/jpeg,image/png"
                              required
                              className="ml-1.5 max-w-48 text-xs file:mr-1.5 file:rounded file:border file:border-border file:bg-muted/40 file:px-1.5 file:py-0.5"
                            />
                          </label>
                          <button className="text-primary underline-offset-2 hover:underline">{t('upload')}</button>
                        </form>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Card>
  );
}
