import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { getSession } from '@/lib/session';
import { myEmployment } from '@/core/read';
import { markNoticeViewed, noticesForEmployment } from '@/core/notice';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { Card, PageHeader, SectionHeader } from '@/components/ui';
import { Markdown } from '@/components/markdown';

/**
 * 6e122302 — the employee's reading page for one notice.
 *
 * WHY IT READS THROUGH `noticesForEmployment` RATHER THAN FETCHING THE NOTICE BY ID: that function already
 * carries every rule about what this person may see — in the audience snapshot, published, unarchived,
 * inside the window in the tenant timezone. Fetching by id and re-checking those here would be a second
 * copy of the eligibility rule, and the two would eventually disagree. A notice not in the list is a 404,
 * which is also the right answer for one addressed to someone else.
 *
 * OPENING IT MARKS IT VIEWED — first open only, and this is NOT an acknowledgement. It exists so the
 * dashboard badge can stop saying "new"; it is a page load, and release two's acknowledgement is a
 * deliberate act with its own evidence. The two must never be conflated, which is why they are separate
 * columns with separate names rather than one "seen" flag doing both jobs.
 */
export default async function NoticeReadPage({ params }: { params: Promise<{ id: string }> }) {
  const s = await getSession();
  const t = await getTranslations('notices');
  const { id } = await params;

  const me = await myEmployment(s);
  if (!me) notFound();
  const rows = await noticesForEmployment(s, me.employmentId);
  const n = rows.find((r) => r.id === id);
  if (!n) notFound();

  if (n.firstViewedAt == null) await markNoticeViewed(s, n.id, me.employmentId);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title={n.title}
        description={t('publishedByOn', {
          // Both are derived from an INSTANT, so the displayed date goes through the tenant timezone.
          date: n.publishedAt ? todayInKualaLumpur(n.publishedAt) : '—',
          by: n.publishedBy ?? '—',
        })}
        back={{ href: '/notices', label: t('backToMine') }}
      />
      <Card>
        <SectionHeader title={t('noticeTitle')} />
        <div className="px-4 py-4">
          {/* Markdown, not raw HTML: react-markdown without rehype-raw cannot render an injected script,
              so a notice — the one piece of content in the product deliberately shown to every employee —
              can never become a stored-XSS delivery mechanism. */}
          <Markdown>{n.body}</Markdown>
          {/* The reporter's "Display End Date on Notice" option. When it is off the expiry is simply not
              shown; the notice still stops being visible on that date. */}
          {n.showEndDate && (
            <p className="mt-6 border-t border-border pt-3 text-xs text-muted-foreground">
              {t('validUntil', { date: n.endOn })}
            </p>
          )}
        </div>
      </Card>
    </div>
  );
}
