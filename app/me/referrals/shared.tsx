import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { EntitlementError } from '@/core/entitlements';
import { cn } from '@/lib/utils';
import { Card } from '@/components/ui';

/**
 * Employee referrals (Recruitment slice 7): the shared pieces of the three pages under /me/referrals. Every signed-in
 * person reaches the address (scopedSession); what each sees is decided by the database — the Open jobs on the portal in
 * the companies where they have an active employment and Recruitment, and their own referrals only.
 */

/**
 * A tenant without Recruitment refuses at the service gate before any SQL. The pages then show the same friendly
 * "not open to you" note as a person with no eligible employment — never a bare error page, never job data.
 */
export async function referralRead<T>(work: Promise<T>): Promise<T | null> {
  try {
    return await work;
  } catch (e) {
    if (e instanceof EntitlementError) return null;
    throw e;
  }
}

/** The note for a person who may not refer: referrals are for current employees of companies that use Recruitment. */
export async function NotEligibleNote() {
  const t = await getTranslations('recruitment.referrals');
  return <Card role="note" className="p-6 text-sm text-muted-foreground">{t('notEligible')}</Card>;
}

export async function ReferralTabs({ active }: { active: 'jobs' | 'mine' }) {
  const t = await getTranslations('recruitment.referrals');
  const tabs = [{ key: 'jobs', href: '/me/referrals', text: t('tabJobs') }, { key: 'mine', href: '/me/referrals/mine', text: t('tabMine') }] as const;
  return (
    <nav aria-label={t('tabsLabel')} className="flex gap-1 border-b border-border">
      {tabs.map((tab) => (
        <Link key={tab.key} href={tab.href} aria-current={tab.key === active ? 'page' : undefined}
          className={cn('-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors',
            tab.key === active ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
          {tab.text}
        </Link>
      ))}
    </nav>
  );
}

export const klDay = (locale: string, iso: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'Asia/Kuala_Lumpur' }).format(new Date(iso));
