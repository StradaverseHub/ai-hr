'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AI_INBOX_HREF, cameFromInbox } from '@/lib/ai-centre/inbox-origin';

/** Shown above any page opened from the AI centre Inbox's Review link: the way back, to a freshly rendered Inbox. */
export function BackToInbox() {
  const params = useSearchParams();
  const t = useTranslations('aiCentre');
  if (!cameFromInbox(params)) return null;
  return (
    <div data-back-to-inbox className="px-4 pt-3 sm:px-6">
      <Link href={AI_INBOX_HREF} className="inline-flex min-h-9 items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        ← {t('tabs.inbox')}
      </Link>
    </div>
  );
}
