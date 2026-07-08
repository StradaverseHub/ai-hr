'use client';

/**
 * Client tab shell for the admin Employee Detail page (feedback f2904eeb). The page is a server
 * component that pre-loads every section's data, so this shell takes the already-rendered section
 * JSX as per-tab `panels` and just shows/hides them on click — no data fetching moves client-side and
 * every existing server-action <form> stays wired exactly as it was on the long-scroll page.
 *
 * Why client `useState` rather than route segments: the ticket requires "maintain user position when
 * switching tabs" and the whole record is already in memory, so switching is instant with no reload
 * and no scroll jump. Adding a future tab = one more `{ key, label }` + one more panel; existing tabs
 * are untouched (the scalability requirement). The responsive strip styling mirrors the proven
 * `section-jump-nav.tsx` rail (horizontal, scrollable on narrow screens).
 */
import { useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type PersonnelTabKey = 'profile' | 'family' | 'job' | 'payroll' | 'leave' | 'documents' | 'others';

export function PersonnelTabs({
  tabs,
  panels,
  emptyLabel,
}: {
  tabs: { key: PersonnelTabKey; label: string }[];
  panels: Partial<Record<PersonnelTabKey, ReactNode>>;
  // Shown when a tab's panel resolves to nothing (e.g. Documents for an employee with no records,
  // or any admin-only tab viewed by a non-admin). Keeps a switched-to tab from looking broken.
  emptyLabel: string;
}) {
  const [active, setActive] = useState<PersonnelTabKey>(tabs[0]?.key ?? 'profile');

  return (
    <div className="space-y-6">
      <nav
        aria-label="Employee sections"
        className="flex gap-1 overflow-x-auto rounded-[1.25rem] border border-border bg-card p-1.5 shadow-[var(--shadow-card)]"
      >
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={active === tab.key}
            aria-current={active === tab.key ? 'true' : undefined}
            onClick={() => setActive(tab.key)}
            className={cn(
              'whitespace-nowrap rounded-xl px-4 py-2 text-sm font-medium transition-colors',
              active === tab.key
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {tabs.map((tab) => {
        const panel = panels[tab.key];
        // Panels stay mounted (hidden, not unmounted) so form state / server-action targets survive a
        // tab switch and there is zero re-render cost when returning to a tab.
        const hasContent = panel != null && (!Array.isArray(panel) || panel.length > 0);
        return (
          <div
            key={tab.key}
            role="tabpanel"
            hidden={active !== tab.key}
            className={active === tab.key ? 'space-y-6' : undefined}
          >
            {hasContent ? (
              panel
            ) : (
              <div className="rounded-[1.25rem] border border-border bg-card p-8 text-center text-sm text-muted-foreground shadow-[var(--shadow-card)]">
                {emptyLabel}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
