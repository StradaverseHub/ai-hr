import type { ReactNode } from 'react';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ChevronLeft, ShieldCheck } from 'lucide-react';
import { PageHeader } from '@/components/ui';
import { cn } from '@/lib/utils';

/** The ONE review-page frame for every /assistant/* review route (AI centre, PLAN.md §2).
 *
 * It owns only the frame: the way back (the Inbox, plus the page's own previous destination), the heading,
 * and the reminder that the change happens on this page. It never owns the decision: each page still
 * renders its own panel, which posts to its own native command, and every check runs again on that POST.
 * A page may be redesigned through this shell, never bypassed. */
export async function ReviewShell({ title, description, back, width = 'narrow', children }: {
  title: string; description?: ReactNode; back?: Readonly<{ href: string; label: string }>; width?: 'narrow' | 'wide'; children: ReactNode;
}) {
  const t = await getTranslations('aiCentre.review');
  const linkCls = 'inline-flex min-h-11 items-center gap-1 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
  return (
    <div data-review-shell className={cn('mx-auto space-y-5', width === 'wide' ? 'max-w-4xl' : 'max-w-3xl')}>
      <nav aria-label={t('navLabel')} className="flex flex-wrap items-center gap-x-4">
        <Link href="/assistant?view=inbox" className={linkCls}><ChevronLeft aria-hidden className="size-4" />{t('back')}</Link>
        {back && <Link href={back.href} className={linkCls}>{back.label}</Link>}
      </nav>
      <PageHeader title={title} description={description} />
      {children}
      <p className="flex items-start gap-2 text-xs text-muted-foreground"><ShieldCheck aria-hidden className="mt-0.5 size-3.5 flex-none" />{t('note')}</p>
    </div>
  );
}

/** The access refusal every review page showed as a copied block: why the Assistant is unavailable, and for a
 * group administrator without a grant, where to grant it. The reason comes from mayUseAssistant. */
export async function ReviewAccessDenied({ id, reason, mayGrant }: { id: string; reason: string; mayGrant: boolean }) {
  const t = await getTranslations('assistant');
  return (
    <section aria-labelledby={id}>
      <h2 id={id} className="text-base font-semibold">{t('home.accessTitle')}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t(`denied_${reason}`)}</p>
      {mayGrant && <Link href="/control-tower/agents/allowances#user-limits" className="mt-3 inline-flex min-h-11 items-center text-sm font-medium text-primary hover:underline">{t('home.grantSelf')}</Link>}
    </section>
  );
}
