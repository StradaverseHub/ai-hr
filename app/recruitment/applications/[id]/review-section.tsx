import { getTranslations } from 'next-intl/server';
import { btnGhost, btnPrimary } from '@/components/ui';
import { BLOCKED_REASON_MAX, type ApplicationReview, type CandidatePools } from '@/packs/recruitment/service';
import { blockCandidateAction, removeCandidateFromPoolAction, resolveReviewMarkAction } from '../../actions';
import { AddToPool } from '../../pool-ui';
import { klDate, textareaCls } from '../../shared';

/**
 * Slice 13 on the application page. The banner says what the viewer may know (D-049): anyone who reads the application sees
 * "Needs an administrator's review"; the job's recruiter and assistants also see that the candidate is on, or matches, the
 * blocked list; administrators see who matched, the reason, and resolve the mark ("Not the same person", or "Remove from
 * blocked list" with a reason).
 */
export async function ReviewBanner({ review, here, locale }: { review: ApplicationReview | null; here: string; locale: string }) {
  if (!review || (!review.needsReview && !review.candidate?.entryId)) return null;
  const t = await getTranslations('recruitment.pools.review');
  const hidden = (name: string, value: string) => <input type="hidden" name={name} value={value} />;
  if (review.view === 'reader') {
    return (
      <section role="status" aria-labelledby="review-title" className="space-y-1 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
        <h2 id="review-title" className="font-semibold">{t('needsReview')}</h2>
        <p>{t('readerNote')}</p>
      </section>
    );
  }
  const self = review.marks.some((m) => m.matchedSelf);
  return (
    <section role="status" aria-labelledby="review-title" className="space-y-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
      <h2 id="review-title" className="font-semibold">{review.needsReview ? t('needsReview') : t('listedTitle')}</h2>
      {review.view === 'operator' && (
        <p>{review.needsReview ? (self || review.candidate?.entryId ? t('operatorSelf') : t('operatorMatch')) : t('listedNote')}</p>
      )}
      {review.view === 'admin' && !review.needsReview && review.candidate?.reason && (
        <p>{t('listedNote')} <span className="whitespace-pre-wrap">{t('reason', { reason: review.candidate.reason })}</span></p>
      )}
      {review.view === 'admin' && review.marks.map((m) => (
        <div key={m.markId} className="space-y-2 rounded-lg border border-amber-500/30 bg-card/60 p-3">
          <p>{m.matchedSelf ? t('adminSelf') : m.blockedCandidateName ? t('adminMatch', { name: m.blockedCandidateName }) : t('adminMatchRemoved')}</p>
          {m.reason && <p className="whitespace-pre-wrap">{t('reason', { reason: m.reason })}</p>}
          <p className="text-xs text-muted-foreground">{t('markedOn', { date: klDate(locale, m.markedAt) })}</p>
          <div className="flex flex-wrap items-start gap-3">
            {!m.matchedSelf && (
              <form action={resolveReviewMarkAction}>
                {hidden('markId', m.markId)}{hidden('resolution', 'not_same_person')}{hidden('returnTo', here)}
                <button type="submit" className={btnPrimary}>{t('notSamePerson')}</button>
              </form>
            )}
            <details>
              <summary className="cursor-pointer py-2 text-destructive">{t('removeFromList')}</summary>
              <form action={resolveReviewMarkAction} className="mt-2 space-y-2">
                {hidden('markId', m.markId)}{hidden('resolution', 'remove_from_list')}{hidden('returnTo', here)}
                <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">{t('removalReason')}
                  <textarea name="reason" required maxLength={BLOCKED_REASON_MAX} rows={2} className={textareaCls} /></label>
                <button type="submit" className={btnGhost}>{t('removeFromList')}</button>
              </form>
            </details>
          </div>
        </div>
      ))}
    </section>
  );
}

/** The candidate's custom pools (operators and administrators) and, for administrators, "Add to blocked list". */
export async function PoolsAndBlockSection({ pools, review, here }: { pools: CandidatePools | null; review: ApplicationReview | null; here: string }) {
  if (!pools && !review?.candidate?.canBlock) return null;
  const t = await getTranslations('recruitment.pools');
  const hidden = (name: string, value: string) => <input type="hidden" name={name} value={value} />;
  return (
    <section aria-labelledby="pools-title" className="space-y-3 rounded-xl border border-border bg-card p-4">
      <h2 id="pools-title" className="text-sm font-semibold">{t('candidate.title')}</h2>
      {pools && (
        <>
          {pools.member.length === 0 ? <p className="text-sm text-muted-foreground">{t('candidate.none')}</p> : (
            <ul className="flex flex-wrap gap-2">
              {pools.member.map((p) => (
                <li key={p.id} className="flex items-center gap-1 rounded-full border border-border py-0.5 pl-3 pr-1 text-xs">
                  <span>{p.label}</span>
                  {pools.canEdit && (
                    <form action={removeCandidateFromPoolAction}>
                      {hidden('poolId', p.id)}{hidden('candidateId', pools.candidateId)}{hidden('returnTo', here)}
                      <button type="submit" aria-label={t('candidate.removeFrom', { pool: p.label })} className="rounded-full px-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">×</button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )}
          {pools.addable.length > 0 && <AddToPool candidateId={pools.candidateId} choices={pools.addable} here={here} t={t} id="candidate" />}
        </>
      )}
      {review?.candidate?.canBlock && (
        <details className="border-t border-border pt-3 text-sm">
          <summary className="cursor-pointer text-destructive">{t('blocked.add')}</summary>
          <form action={blockCandidateAction} className="mt-2 space-y-2">
            {hidden('candidateId', review.candidate.candidateId)}{hidden('returnTo', here)}
            <p className="text-xs text-muted-foreground">{t('blocked.addNote')}</p>
            <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">{t('blocked.reason')}
              <textarea name="reason" required maxLength={BLOCKED_REASON_MAX} rows={3} className={textareaCls} /></label>
            <span className="text-xs text-muted-foreground">{t('blocked.reasonHint')}</span>
            <div><button type="submit" className={btnGhost}>{t('blocked.add')}</button></div>
          </form>
        </details>
      )}
    </section>
  );
}
