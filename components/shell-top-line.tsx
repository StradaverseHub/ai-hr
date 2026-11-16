'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { resolveBreadcrumbTrail } from '@/lib/navigation/breadcrumbs';
import { useLocale, useTranslations } from 'next-intl';
import { useIsMonolith, useUiTheme } from '@/components/ui-theme-context';
import { useNavIndex } from '@/components/nav-index-context';
import { companyScopeLabel } from '@/components/company-switcher';

/**
 * r398 — the pieces of the Monolith shell that exist ONLY in Monolith (docs/design/monolith/README.md §3).
 * Each renders nothing in Classic, so Classic's header and column keep exactly the children they had.
 * Display only: none of them reads a session, a route guard or data the layout did not already have.
 */

/** The top line's start: the route path in mono, then a hairline tick before the company switcher. */
export function ShellRoutePath() {
  const monolith = useIsMonolith();
  const atelier = useUiTheme() === 'atelier';
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const { active, entries } = useNavIndex();
  const tTop = useTranslations('topbar');
  const t = useTranslations();
  const rewards = pathname === '/rewards' || pathname?.startsWith('/rewards/') || pathname?.startsWith('/admin/rewards/');
  const showBreadcrumb = atelier || rewards;
  const trail = resolveBreadcrumbTrail(pathname, search, entries, active, key => t(key));
  const pageTitle = usePageTitle(showBreadcrumb && trail?.detail ? pathname + '?' + search : null);
  if (showBreadcrumb && trail) {
    const parts = trail.detail ? [...trail.parts, {label:pageTitle ?? tTop('details')}] : trail.parts;
    return (
      <nav aria-label={tTop('breadcrumb')} className={atelier ? "atelier-crumb" : "flex min-w-0 shrink items-center gap-1 overflow-hidden whitespace-nowrap"} data-shell-path>
        {parts.map((part,index) => <span key={index} className="contents">
          {index > 0 && <i aria-hidden>/</i>}
          {index === parts.length - 1
            ? <b className="min-w-0 truncate" aria-current="page">{part.label}</b>
            : part.href ? <Link href={part.href}>{part.label}</Link> : <span>{part.label}</span>}
        </span>)}
      </nav>
    );
  }
  if (!monolith) return null;
  return (
    <>
      <span className="min-w-0 shrink truncate text-mid" data-shell-path>
        {pathname}
      </span>
      <span aria-hidden className="h-3.5 w-px shrink-0 bg-hairline" />
    </>
  );
}

/**
 * The heading of the page below a list, for the breadcrumb's last crumb. The shell does not know a record's
 * name, but the page already prints it as its title, so this follows it throughout the detail route.
 * A streamed transition can retain the old heading before replacing it, and a refresh can rename
 * a record without changing its path.
 * Null on a list page, or while the current heading is missing or empty.
 */
function usePageTitle(path: string | null): string | null {
  const [title, setTitle] = useState<{ path: string; text: string } | null>(null);
  useEffect(() => {
    if (!path) return;
    const main = document.querySelector('[data-app-content] > main');
    if (!main) return;
    const read = () => {
      const h1 = main.querySelector('[data-page-header] h1') ?? main.querySelector('h1');
      const text = h1?.textContent?.trim();
      setTitle((prev) => text
        ? (prev?.path === path && prev.text === text ? prev : { path, text })
        : null);
    };
    const observer = new MutationObserver(read);
    observer.observe(main, { childList: true, subtree: true, characterData: true });
    read();
    return () => observer.disconnect();
  }, [path]);
  // A title read on the previous record must never label this one.
  return path && title?.path === path ? title.text : null;
}

/**
 * The live dot and the viewer's clock, pushed to the right of the top line. The time is the BROWSER's own
 * (the person reading it is the one it is for) and is rendered only after mount: a server-rendered minute
 * would hydrate against a different one. It ticks every 15 s, and the dot is the only thing that animates.
 * Below sm it is not shown: a phone's top line has room for the path, the scope and the account, not a clock.
 */
export function ShellLiveClock() {
  const monolith = useIsMonolith();
  const t = useTranslations('topbar');
  const locale = useLocale();
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    if (!monolith) return;
    setNow(new Date());
    const id = window.setInterval(() => setNow(new Date()), 15_000);
    return () => window.clearInterval(id);
  }, [monolith]);
  if (!monolith) return null;
  const time = now
    ? new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hour12: false }).format(now)
    : '';
  return (
    <span className="ml-auto hidden shrink-0 items-center gap-2.5 whitespace-nowrap text-mid sm:inline-flex" data-shell-clock>
      <span aria-hidden className="monolith-dot" />
      {t('live')}
      <time className="tabular-nums" suppressHydrationWarning>
        {time}
      </time>
    </span>
  );
}

/**
 * The footer status line (`.stat`). The board's line is `Sys OK · scope · last sweep`; ONLY the scope is
 * shown, because it is the only one of the three the shell actually knows. There is no system-health read in
 * the layout to stand behind "Sys OK", and the last overnight sweep lives in the scheduled-actions log, which
 * the layout does not query — printing either would be inventing a status.
 */
export function ShellStatusLine({
  companies,
  selected,
}: {
  companies: { id: string; name: string }[];
  selected: string[];
}) {
  const monolith = useIsMonolith();
  const pathname = usePathname();
  const t = useTranslations('topbar');
  if (!monolith || pathname === '/leave/credit-details') return null;
  return (
    <footer
      className="monolith-rv flex shrink-0 flex-wrap gap-7 border-t border-ink pt-3 pb-3 font-mono text-[11px] uppercase tracking-[0.14em] text-mid [animation-delay:100ms]"
      data-shell-status
    >
      <span>
        {t('scope')} · {companies.length === 0 ? t('allCompanies') : companyScopeLabel(t, companies, selected)}
      </span>
    </footer>
  );
}
