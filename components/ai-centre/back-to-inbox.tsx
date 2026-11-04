'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { TODAY_HREF, cameFromToday } from '@/lib/ai-centre/inbox-origin';

/** Shown above any page opened from a Review link on Today: the way back, to a freshly rendered Today. (Formerly
 * the way back to the AI Centre Inbox, which Today replaced in AI v2 Phase 1.) */
export function BackToInbox() {
  const params = useSearchParams();
  const t = useTranslations('aiCentre');
  if (!cameFromToday(params)) return null;
  return (
    <div data-back-to-inbox data-back-to-today className="px-4 pt-3 sm:px-6">
      <Link href={TODAY_HREF} className="inline-flex min-h-9 items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11">
        ← {t('backToToday')}
      </Link>
    </div>
  );
}
