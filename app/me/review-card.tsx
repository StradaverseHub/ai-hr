// /me review outcome surface (0110, §4.4) — info-only, mirroring the resignation status surface. Shows the
// employee's own completed probation/contract/internship review outcome (RLS scopes reviewsFor to self).
import { getTranslations } from 'next-intl/server';
import { Card, SectionHeader } from '@/components/ui';
import { reviewsFor, type ReviewType } from '@/core/employment-review';
import type { SessionContext } from '@/db/client';

export async function MeReviewCard({ s, employmentId }: { s: SessionContext; employmentId: string }) {
  const t = await getTranslations('review');
  const all = await reviewsFor(s, employmentId);
  const completed = all.filter((r) => r.status === 'completed');
  if (completed.length === 0) return null;

  return (
    <Card className="mt-6 p-5">
      <SectionHeader title={t('outcome')} />
      <ul className="mt-3 divide-y divide-border text-sm">
        {completed.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span>
              {t(`reviewType.${r.reviewType as ReviewType}` as 'reviewType.probation')}
              {r.decision ? ` · ${t(`decision.${r.decision}` as 'decision.confirm')}` : ''}
            </span>
            <span className="text-xs text-muted-foreground">
              {t('decidedOn')} <span className="tabular-nums">{r.endDate}</span>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
