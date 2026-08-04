import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { getSession } from '@/lib/session';
import { myEmployment } from '@/core/read';
import { noticesForEmployment } from '@/core/notice';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { Card, PageHeader, SectionHeader } from '@/components/ui';

/**
 * 6e122302 — the employee's own Notice Board ("View All Notices" from the dashboard card).
 *
 * No guard beyond the session: everything here is the viewer's OWN notices, and which those are is decided
 * by the audience snapshot plus the recipient RLS policy — not by a role. A principal with no employment
 * (an admin login not attached to a person) simply has none, which is correct rather than an error.
 *
 * The window test lives in `noticesForEmployment`, against the tenant timezone. This page does no date
 * arithmetic of its own; adding some is how the listing and the dashboard card start disagreeing.
 */
export default async function MyNoticesPage() {
  const s = await getSession();
  const t = await getTranslations('notices');
  const me = await myEmployment(s);
  const rows = me ? await noticesForEmployment(s, me.employmentId) : [];

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title={t('myTitle')} description={t('myDescription')} />
      <Card>
        <SectionHeader title={t('myListTitle')} count={rows.length} />
        <ul className="divide-y divide-border">
          {rows.length === 0 && (
            <li className="px-4 py-6 text-center text-xs text-muted-foreground">{t('myEmpty')}</li>
          )}
          {rows.map((n) => (
            <li key={n.id} className="px-4 py-3">
              <Link href={`/notices/${n.id}`} className="flex flex-wrap items-center justify-between gap-3">
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-foreground">{n.title}</span>
                  {/* `publishedAt` is an INSTANT, so the date it names must go through the tenant
                      timezone — `toISOString().slice(0,10)` would show yesterday's date between 00:00 and
                      08:00 MYT for anything published that evening. */}
                  <span className="text-xs text-muted-foreground">
                    {t('publishedOn', { date: n.publishedAt ? todayInKualaLumpur(n.publishedAt) : '—' })}
                  </span>
                </span>
                {n.firstViewedAt == null && (
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
                    {t('newBadge')}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
