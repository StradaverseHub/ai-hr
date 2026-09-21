import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { myEmployment } from '@/core/read';
// The same import app/leave/page.tsx uses for this read; core/leave-shared-group is not part of the
// leave pack's audited surface, so it is imported directly rather than through the facade.
import { sharedLeaveGroupBalances } from '@/core/leave-shared-group';
import { Card, PageHeader } from '@/components/ui';
import { formatDays } from '@/lib/day-format';
import { todayInKualaLumpur } from '@/lib/hr-date';

/**
 * 76dbcaa1 — SPECIAL LEAVE DETAILS: one pooled entitlement, and the reasons that draw on it.
 *
 * The reporter's complaint is that My Leave shows seven cards for what is one allowance. The pooled card
 * itself already existed (46afcc48); this is the screen behind its View details, and the place an employee
 * picks which reason they are applying under.
 *
 * ⚠️ THE EMPLOYEE'S OWN, AND ONLY THEIR OWN. `myEmployment(s)` resolves the signed-in employee and the
 * figures come from `sharedLeaveGroupBalances` for that employment. There is no employee parameter and no
 * admin on-behalf path: an administrator wanting somebody else's pooled figure reads it where every other
 * administrative leave figure is read. A groupId the viewer has no placed group for is a 404, not an
 * empty screen — the id is in the URL and an empty screen would confirm the group exists.
 *
 * THE FIGURE IS NOT THE CEILING, and that distinction is the whole reason the card exists. `available` is
 * min(what is left under the shared ceiling, what the member types actually hold) — computed once by
 * `sharedGroupAvailableDays` and rendered here already resolved. The ceiling is printed beside it as
 * context. A screen promising ten days the group guard would then refuse is worse than no screen.
 *
 * ⚠️ WHAT IS DELIBERATELY NOT HERE: the reporter's Compassionate / Congratulatory sub-grouping. Nothing in
 * the data says which reason belongs to which heading, and inventing the mapping in this file would be
 * exactly the hardcoding their own ticket forbids ("read the conditions from the leave type
 * configuration"). The reasons are listed under the pool that owns them; where the sub-grouping should be
 * STORED is a decision raised separately.
 */
export default async function SharedLeaveGroupPage({ params }: { params: Promise<{ groupId: string }> }) {
  const { groupId } = await params;
  const t = await getTranslations('me.sharedLeaveGroups');
  const locale = await getLocale();
  const { s } = await scopedSession();
  const me = await myEmployment(s);
  if (!me) notFound();

  const groups = await sharedLeaveGroupBalances(s, me.employmentId, {
    locale,
    asOf: todayInKualaLumpur(),
  });
  const group = groups.find((g) => g.id === groupId);
  if (!group) notFound();

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title={group.name} description={t('detailDescription')} />

      <Card className="p-4">
        <div className="text-3xl font-semibold tabular-nums">{formatDays(group.available)}</div>
        <div className="text-sm text-muted-foreground">{t('remaining')}</div>
        <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
          <li>{t('ofLimit', { limit: formatDays(group.totalLimitDays) })}</li>
          {group.maxDaysPerApplication != null && (
            <li>{t('maxPerApplication', { days: formatDays(group.maxDaysPerApplication) })}</li>
          )}
          {/* What has already gone, so the subtraction is visible rather than implied. */}
          <li>{t('usedThisYear', { days: formatDays(group.usedDays) })}</li>
        </ul>
      </Card>

      <section>
        <h2 className="text-sm font-semibold">{t('reasonsHeading')}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{t('reasonsHelp')}</p>
        <div className="mt-3 space-y-2">
          {group.members.map((m) => (
            <div
              key={m.id}
              className="flex items-center justify-between gap-3 rounded-xl border border-border p-3"
            >
              <span className="text-sm">{m.name}</span>
              {/* Straight into the existing Request Leave form with this reason selected — NOT a second
                  apply path. Everything about approval, documents and notice stays where it is. */}
              <Link
                href={`/leave?type=${m.id}`}
                className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground"
              >
                {t('applyForReason')}
              </Link>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
