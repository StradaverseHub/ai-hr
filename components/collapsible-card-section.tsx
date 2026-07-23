'use client';

import type { ReactNode, SyntheticEvent } from 'react';

/**
 * Whole-section fold for a Card (feedback 03557e76 — Grades section collapse).
 *
 * Native <details>/<summary>, matching the sibling Leave-config disclosure on the Application
 * Rules tab (leaveYearAdvanced) and the Organization page's group-structure fold, with the
 * SectionHeader-style title + count kept visible on the summary bar even when closed. The
 * open/closed choice persists in a cookie (same shape as nav-collapsible-group's write:
 * path=/, 1 year, samesite=lax) that the SERVER page reads via cookies() to resolve
 * `defaultOpen` — SSR-correct initial state, so there is no closed-then-restored hydration
 * flash (the tradeoff leave-type-panel's localStorage route documents).
 *
 * Labels arrive PRE-TRANSLATED (the caller does the static t('…') lookups) so the i18n
 * coverage test keeps seeing literal keys at the call site. Purely presentational: the
 * children render exactly as before, nothing about their data or actions changes.
 */
export function CollapsibleCardSection({
  title,
  count,
  subtitle,
  toggleLabel,
  cookieKey,
  defaultOpen,
  children,
}: {
  /** Pre-translated section title (kept visible on the summary bar when closed). */
  title: string;
  /** Optional record count shown beside the title, SectionHeader-style. */
  count?: number;
  /** Optional pre-translated legend shown after the title/count (e.g. "available / entitled"), or a
   *  small node such as the company-wide badge pill (7b945408 — the relocated Grades catalogue). */
  subtitle?: ReactNode;
  /** Pre-translated accessible name for the summary toggle. */
  toggleLabel: string;
  /** Cookie persisting the open/closed choice; the server page reads it to set `defaultOpen`. */
  cookieKey: string;
  /** SSR-resolved initial open state (from the cookie), so first paint is already correct. */
  defaultOpen: boolean;
  children: ReactNode;
}) {
  const persist = (e: SyntheticEvent<HTMLDetailsElement>) => {
    document.cookie = `${cookieKey}=${e.currentTarget.open ? '1' : '0'}; path=/; max-age=31536000; samesite=lax`;
  };

  return (
    <details className="group" open={defaultOpen} onToggle={persist}>
      <summary
        aria-label={toggleLabel}
        className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-medium group-open:border-b group-open:border-border [&::-webkit-details-marker]:hidden"
      >
        <span>
          {title}
          {count !== undefined && <span className="ml-2 font-normal text-muted-foreground">({count})</span>}
          {subtitle !== undefined && <span className="ml-2 font-normal text-muted-foreground">{subtitle}</span>}
        </span>
        <span aria-hidden className="text-xs text-muted-foreground group-open:rotate-180">
          ▾
        </span>
      </summary>
      {children}
    </details>
  );
}
