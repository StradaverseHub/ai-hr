import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { BookOpen, Inbox, MessageSquareText, Settings2, UserCheck, Wallet, Workflow } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { aiCentreName } from '@/lib/ai-centre/brand';
import { ADMIN_GROUPS, centreTabsFor, type AdminSection, type CentreTabKey } from '@/lib/ai-centre/centre-nav';
import { cn } from '@/lib/utils';
import { ScrollCurrentTabIntoView } from './centre-tabs-scroll';

const ICONS: Readonly<Record<CentreTabKey, LucideIcon>> = {
  ask: MessageSquareText, inbox: Inbox, jobs: UserCheck, workers: Workflow, setup: Settings2, spend: Wallet, how: BookOpen,
};

/** Synchronous with useTranslations, so it renders from server pages and from client tests alike.
 * The AI centre's one tab bar, on every centre page. Links only: each target page keeps its own guard, and
 * an administrator tab is hidden from a viewer whose page would refuse it. */
/** `inboxBadge` (preferred) is rendered in place of the count, so a page can stream it in a Suspense boundary instead
 * of waiting for the Inbox's pending-task read before anything renders (issue 12, staging acceptance 3 November 2026). */
export function AiCentreTabs({ active, isAdmin, inboxCount, inboxBadge }: { active: CentreTabKey; isAdmin: boolean; inboxCount?: number; inboxBadge?: ReactNode }) {
  const t = useTranslations('aiCentre');
  const name = aiCentreName(t('genericName'));
  return (
    // Phones: one scrolling row, with the current tab brought into view. From sm up the tabs wrap instead, so
    // a long locale (Tamil at 1440px, review M13) never clips the last tab.
    <nav id="ai-centre-tabs" aria-label={t('tabsLabel', { name })} data-ai-centre-tabs className="-mx-1 overflow-x-auto border-b border-border sm:overflow-x-visible">
      <ScrollCurrentTabIntoView navId="ai-centre-tabs" />
      <ul className="flex min-w-max items-end gap-1 px-1 sm:min-w-0 sm:flex-wrap">
        {centreTabsFor({ isAdmin }).map((tab, index, tabs) => {
          const Icon = ICONS[tab.key];
          const current = tab.key === active;
          const firstAdmin = tab.adminOnly && !tabs[index - 1]?.adminOnly;
          return (
            <li key={tab.key} className={cn('flex', firstAdmin && 'ml-2 border-l border-border pl-2')}>
              <Link href={tab.href} aria-current={current ? 'page' : undefined}
                className={cn('-mb-px inline-flex min-h-11 items-center gap-2 border-b-2 px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  current ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
                <Icon aria-hidden className="size-4" />
                {t(`tabs.${tab.key}`)}
                {tab.key === 'inbox' && (inboxBadge ?? (inboxCount !== undefined && <InboxCount count={inboxCount} label={t('inboxCount', { count: inboxCount })} />))}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** The Inbox tab's count; nothing for zero. Shared by the streamed badge (app/assistant/centre/inbox.tsx). */
export function InboxCount({ count, label }: { count: number; label: string }) {
  if (count <= 0) return null;
  return (
    <span className="rounded-full bg-primary px-1.5 py-0.5 text-[0.6875rem] font-semibold leading-none tabular-nums text-primary-foreground">
      <span aria-hidden>{count}</span><span className="sr-only">{label}</span>
    </span>
  );
}

/** The second row for an administrator tab: the AI management sections that tab groups. `available` comes
 * from the screen's own section filter (spending only with a spend policy, provider only for a group
 * administrator), so a link never leads to a section the page would refuse. */
export function AiCentreSubnav({ group, active, available, hrefOf }: {
  group: keyof typeof ADMIN_GROUPS; active: AdminSection; available: readonly string[]; hrefOf: (section: AdminSection) => string;
}) {
  const t = useTranslations('aiCentre');
  const items = ADMIN_GROUPS[group].filter(item => available.includes(item.section));
  if (items.length < 2) return null;
  return (
    <nav aria-label={t('subnavLabel')} className="flex flex-wrap gap-1 rounded-lg bg-muted p-1 text-sm">
      {items.map(item => (
        <Link key={item.section} href={hrefOf(item.section)} aria-current={item.section === active ? 'page' : undefined}
          className={cn('inline-flex min-h-9 items-center rounded-md px-3 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            item.section === active ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
          {t(`subnav.${item.label}`)}
        </Link>
      ))}
    </nav>
  );
}
