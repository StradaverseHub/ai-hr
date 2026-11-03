// The repository's tab rows prefetch the whole destination once the person shows intent (components/intent-link.tsx),
// so a tab switch renders from the client cache instead of the loading shell (AI v2 W9).
import Link from '@/components/intent-link';
import { useTranslations } from 'next-intl';
import { BookOpen, ChevronDown, Gauge, MessageSquareText, Settings2, UserCheck } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { aiCentreName } from '@/lib/ai-centre/brand';
import { ADMIN_GROUPS, centreSectionsFor, centreTabsFor, type AdminSection, type AdministrationSection, type CentreGroup, type CentreSection, type CentreTabKey } from '@/lib/ai-centre/centre-nav';
import { cn } from '@/lib/utils';
import { ScrollCurrentTabIntoView } from './centre-tabs-scroll';

const ICONS: Readonly<Record<CentreTabKey, LucideIcon>> = {
  ask: MessageSquareText, jobs: UserCheck, operations: Gauge, administration: Settings2, how: BookOpen,
};

/** Synchronous with useTranslations, so it renders from server pages and from client tests alike.
 * The AI centre's one tab bar, on every centre page. Links only: each target page keeps its own guard, and
 * an administrator tab is hidden from a viewer whose page would refuse it. */
/** AI v2 Phase 1: the Inbox tab and its count are retired; what waits on the person is on Today (`/`). */
/** `active` null (AI v2 W4): a centre page that is not one of the tabs (Your data and privacy, More tools). */
export function AiCentreTabs({ active, isAdmin }: { active: CentreTabKey | null; isAdmin: boolean }) {
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
                {/* A group tab (approved mock-up, "Operations ▾ · Administration ▾"): its pages carry a second tab row. */}
                {tab.sections && <ChevronDown aria-hidden data-centre-group-mark className="size-3.5 opacity-70" />}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** A waiting count; nothing for zero. Used by the retired Inbox's streamed badge (app/assistant/centre/inbox.tsx). */
export function InboxCount({ count, label }: { count: number; label: string }) {
  if (count <= 0) return null;
  return (
    <span className="rounded-full bg-primary px-1.5 py-0.5 text-[0.6875rem] font-semibold leading-none tabular-nums text-primary-foreground">
      <span aria-hidden>{count}</span><span className="sr-only">{label}</span>
    </span>
  );
}

/** The second tab row of Operations or Administration (approved mock-up, Operations.dc.html "Operations sections").
 * Links only, like the first row: every page keeps its own requireAdmin guard, and a payroll queue is offered only
 * while the tenant holds payroll, as its former sidebar row was. */
export function AiCentreSectionTabs({ group, active, payroll }: { group: CentreGroup; active: CentreSection; payroll: boolean }) {
  const t = useTranslations('aiCentre');
  const navId = `ai-centre-sections-${group}`;
  return (
    <nav id={navId} aria-label={t('sectionsLabel', { tab: t(`tabs.${group}`) })} data-ai-centre-sections={group} className="-mx-1 overflow-x-auto border-b border-border sm:overflow-x-visible">
      <ScrollCurrentTabIntoView navId={navId} />
      <ul className="flex min-w-max items-end gap-1 px-1 sm:min-w-0 sm:flex-wrap">
        {centreSectionsFor(group, { payroll }).map(section => (
          <li key={section.key} className="flex">
            <Link href={section.href} aria-current={section.key === active ? 'page' : undefined}
              className={cn('-mb-px inline-flex min-h-11 items-center border-b-2 px-3 text-[0.8125rem] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                section.key === active ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
              {t(`sections.${section.key}`)}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Both tab rows of an Operations or Administration page, kept together so the page's own spacing never opens a
 * gap between them. Rendered only on pages behind requireAdmin, so the administrator tabs are shown. */
export function AiCentreGroupTabs({ group, active, payroll }: { group: CentreGroup; active: CentreSection; payroll: boolean }) {
  return (
    <div data-ai-centre-group={group} className="space-y-1">
      <AiCentreTabs active={group} isAdmin />
      <AiCentreSectionTabs group={group} active={active} payroll={payroll} />
    </div>
  );
}

/** The in-section row of an Administration section: the AI management pages that section groups. `available` comes
 * from the screen's own section filter (spending only with a spend policy, provider only for a group
 * administrator), so a link never leads to a section the page would refuse. */
export function AiCentreSubnav({ group, active, available, hrefOf }: {
  group: AdministrationSection; active: AdminSection; available: readonly string[]; hrefOf: (section: AdminSection) => string;
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
