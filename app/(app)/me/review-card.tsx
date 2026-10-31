// /me review outcome surface (0110, §4.4) — mirrors the resignation status surface. Shows the
// employee's own completed probation/contract/internship review outcome (RLS scopes reviewsFor to self).
// 6522d26a Fn 6: plus the review DOCUMENTS section — once HR persists the letter / uploads the signed
// copy, the employee can view and download it here (RLS on review_document scopes reads to self; the
// download route is /me/review/document/[docId]).
import { getTranslations } from 'next-intl/server';
import { Card, SectionHeader } from '@/components/ui';
import { reviewDocumentsFor, reviewsFor, type ReviewType } from '@/core/employment-review';
import type { SessionContext } from '@/db/client';

export async function MeReviewCard({ s, employmentId }: { s: SessionContext; employmentId: string }) {
  const t = await getTranslations('review');
  const all = await reviewsFor(s, employmentId);
  const completed = all.filter((r) => r.status === 'completed');
  if (completed.length === 0) return null;
  const documents = await reviewDocumentsFor(s, employmentId);
  const docsByReview = new Map<string, typeof documents>();
  for (const d of documents) {
    const list = docsByReview.get(d.reviewId) ?? [];
    list.push(d);
    docsByReview.set(d.reviewId, list);
  }

  return (
    <Card className="mt-6 p-5">
      <SectionHeader title={t('outcome')} />
      <ul className="mt-3 divide-y divide-border text-sm">
        {completed.map((r) => {
          const docs = docsByReview.get(r.id) ?? [];
          return (
            <li key={r.id} className="py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {t(`reviewType.${r.reviewType as ReviewType}` as 'reviewType.probation')}
                  {r.decision ? ` · ${t(`decision.${r.decision}` as 'decision.confirm')}` : ''}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t('decidedOn')} <span className="tabular-nums">{r.endDate}</span>
                </span>
              </div>
              {docs.length > 0 && (
                <div className="mt-1.5 text-xs">
                  <div className="font-medium text-muted-foreground">{t('documents')}</div>
                  <ul className="mt-0.5 space-y-0.5">
                    {docs.map((d) => (
                      <li key={d.id} className="flex items-center justify-between gap-2">
                        <span className="truncate">
                          {t(`documentKind.${d.kind}` as 'documentKind.signed_letter')} · {d.fileName}
                        </span>
                        <a
                          href={`/me/review/document/${d.id}`}
                          className="shrink-0 text-primary underline-offset-2 hover:underline"
                        >
                          {t('download')}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
