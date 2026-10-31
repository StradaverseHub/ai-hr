import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';
import Link from '@/components/intent-link';
import { adminPageHref, adminSection, adminSectionHref, adminSectionList, visibleAdminPages, type AdminSection } from '@/packs/performance/onehr/admin-sections';
import { PerformanceAdminAssistant } from './admin-assistant';

const groups = ['top', 'modules', 'end'] as const satisfies readonly AdminSection['group'][];

/**
 * D-P1-32 PT-X4 — the performance admin area's frame, in the shape of OneHR's admin shell (APR-025 D5): the
 * sections in a list on the left (a scrolling row on a phone), the section's tabs across the top and, when a tab
 * holds more than one page, its pages in a row under the tabs. Every entry comes from the one registry
 * (packs/performance/onehr/admin-sections.ts), so a link here and the route it opens cannot disagree. Theme tokens
 * only: the area's own look arrives through its theme, never through colours written here. The admin assistant
 * that sat on the cycle page rides the frame, so it is on every admin page.
 */
export async function PerformanceAdminShell({ cycleId, cycleName, section, tab, page, state, children }: {
  cycleId: string;
  cycleName?: string;
  section: string;
  tab: string;
  page?: string;
  /** A module section's switch on this cycle (OneHR's On / Off in the section head). */
  state?: { on: boolean; cycle: string };
  children: ReactNode;
}) {
  const t = await getTranslations('performanceAdmin');
  const current = adminSection(section), active = current?.tabs.find((x) => x.key === tab);
  if (!current || !active) throw Error(`Unknown admin tab ${section}/${tab}.`);
  const pages = visibleAdminPages(active), pageKey = page ?? pages[0]?.key, title = t(`sections.${current.key}`);
  return (
    <div data-performance-admin className="mx-auto w-full max-w-[1600px] gap-6 md:grid md:grid-cols-[13rem_minmax(0,1fr)]">
      <nav aria-label={t('nav.sections')} className="mb-4 min-w-0 md:mb-0">
        <ul className="flex gap-1 overflow-x-auto pb-1 md:flex-col md:overflow-visible md:pb-0">
          {groups.flatMap((group) => adminSectionList.filter((s) => s.group === group).map((s, i) => (
            <li key={s.key} className={`shrink-0 ${i === 0 && group !== 'top' ? 'md:mt-4' : ''}`}>
              {i === 0 && group === 'modules' && <span className="hidden px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground md:block">{t('groups.modules')}</span>}
              <Link
                href={adminSectionHref(cycleId, s.key)}
                aria-current={s.key === current.key ? 'true' : undefined}
                className={`flex min-h-9 items-center whitespace-nowrap rounded-md px-3 py-2 text-sm transition-colors ${s.key === current.key ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'}`}
              >
                {t(`sections.${s.key}`)}
              </Link>
            </li>
          )))}
        </ul>
      </nav>
      <div className="min-w-0 space-y-6">
        <div className="space-y-3">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
            {state && <span className={`rounded-full border px-2 py-0.5 text-xs ${state.on ? 'border-primary text-primary' : 'border-border text-muted-foreground'}`}>{t(state.on ? 'state.on' : 'state.off', { cycle: state.cycle })}</span>}
            {cycleName && !state && <span className="text-sm text-muted-foreground">{cycleName}</span>}
          </div>
          <nav aria-label={title} className="flex gap-1 overflow-x-auto border-b border-border">
            {current.tabs.map((x) => (
              <Link
                key={x.key}
                href={adminPageHref(cycleId, current.key, x.key)}
                aria-current={x.key === active.key ? (pages.length > 1 ? 'true' : 'page') : undefined}
                className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors ${x.key === active.key ? 'border-primary font-medium text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
              >
                {t(`tabs.${x.key}`)}
              </Link>
            ))}
          </nav>
          {pages.length > 1 && (
            <nav aria-label={t('nav.pages')} className="flex flex-wrap gap-2">
              {pages.map((p) => (
                <Link
                  key={p.key}
                  href={adminPageHref(cycleId, current.key, active.key, p.key)}
                  aria-current={p.key === pageKey ? 'page' : undefined}
                  className={`rounded-full border px-3 py-1 text-sm ${p.key === pageKey ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:bg-accent'}`}
                >
                  {t(`pages.${p.key}`)}
                </Link>
              ))}
            </nav>
          )}
        </div>
        <PerformanceAdminAssistant key={cycleId} cycleId={cycleId} />
        {children}
      </div>
    </div>
  );
}
