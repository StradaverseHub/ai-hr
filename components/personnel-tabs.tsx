'use client';

/**
 * Client tab shell — originally the admin Employee Detail page (feedback f2904eeb), now also the
 * employee ESS "My Workspace" page (feedback 311ad7ba). The page is a server component that pre-loads
 * every section's data, so this shell takes the already-rendered section JSX as per-tab `panels` and
 * just shows/hides them on click — no data fetching moves client-side and every existing server-action
 * <form> stays wired exactly as it was on the long-scroll page.
 *
 * Why client `useState` rather than route segments: switching tabs must keep in-progress form state
 * and server-action bindings alive (a leave application half-typed, an unsaved contact edit), and the
 * whole record is already in memory, so switching is instant with no reload and no scroll jump. Adding
 * a future tab = one more `{ key, label }` + one more panel; existing tabs are untouched (the
 * scalability requirement). The responsive strip styling mirrors the proven `section-jump-nav.tsx`
 * rail (horizontal, scrollable on narrow screens).
 *
 * Deep links / reload survival: `defaultTab` lets the server pick the initial tab from a `?tab=` param,
 * so a native GET round-trip (payslip month selector, leave as-at date) that reloads the whole document
 * can land back on the tab it came from instead of resetting to the first tab.
 *
 * Guided tour: the shell listens for a `tour:reveal` window event carrying a CSS selector. If a panel
 * inside this shell contains the target, it activates that panel so the tour spotlight can measure a
 * visible element (panels stay mounted-but-hidden, so `querySelector` finds targets in hidden tabs).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Window event a tour engine dispatches with a CSS selector to make the tab holding it visible. */
export const TOUR_REVEAL_EVENT = 'tour:reveal';

export type PersonnelTabKey = 'profile' | 'family' | 'job' | 'payroll' | 'leave' | 'documents' | 'others';

export function ClientTabs<K extends string>({
  tabs,
  panels,
  emptyLabel,
  defaultTab,
  ariaLabel = 'Sections',
}: {
  tabs: { key: K; label: string }[];
  panels: Partial<Record<K, ReactNode>>;
  // Shown when a tab's panel resolves to nothing (e.g. Documents for an employee with no records,
  // or any admin-only tab viewed by a non-admin). Keeps a switched-to tab from looking broken.
  emptyLabel: string;
  // Initial tab (deep-link / reload survival). Falls back to the first tab when absent/unknown.
  defaultTab?: K;
  ariaLabel?: string;
}) {
  const initial = defaultTab && tabs.some((tab) => tab.key === defaultTab) ? defaultTab : tabs[0]?.key;
  const [active, setActive] = useState<K | undefined>(initial);

  // Tab retention across save→redirect→reload (feedback bd2f0bb2). Every per-section Save on this page is a
  // server-action <form> that finishes with redirect(`.../${employmentId}?toast=Saved`) — a tab-less URL that
  // re-initialises this shell to the first tab (Profile). Two moves keep the user where they were:
  //   (a) reflect the active tab into the URL as `?tab=<key>` on every switch (replaceState — no RSC refetch,
  //       no scroll jump), so a native GET reload already lands on the right tab; and
  //   (b) a capture-phase submit listener on the shell injects the current tab as a hidden `tab` field into
  //       whichever <form> is submitting, delivering it into that action's FormData without editing any panel
  //       JSX (the panels are opaque server-rendered ReactNodes). The actions append `&tab=<key>` to their
  //       redirect, so the post-save reload returns to the originating tab instead of Profile.
  // `activeRef` mirrors `active` so the once-registered listener always reads the latest value.
  const activeRef = useRef<K | undefined>(active);
  activeRef.current = active;
  const shellRef = useRef<HTMLDivElement>(null);

  const selectTab = (key: K) => {
    setActive(key);
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.set('tab', key);
      // Preserve every other param (from, asOf, …); replaceState avoids a server round-trip and scroll reset.
      window.history.replaceState(window.history.state, '', url.toString());
    }
  };

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const onSubmit = (e: Event) => {
      const form = e.target as HTMLFormElement | null;
      if (!form || form.tagName !== 'FORM' || !shell.contains(form)) return;
      const key = activeRef.current;
      if (!key) return;
      let input = form.querySelector<HTMLInputElement>('input[data-tab-tracker]');
      if (!input) {
        input = document.createElement('input');
        input.type = 'hidden';
        input.name = 'tab';
        input.setAttribute('data-tab-tracker', '');
        form.appendChild(input);
      }
      input.value = key;
    };
    // Capture phase → runs before React reads the form to build the server-action FormData.
    shell.addEventListener('submit', onSubmit, true);
    return () => shell.removeEventListener('submit', onSubmit, true);
  }, []);

  // Guided tour: when a step targets an element inside a currently-hidden panel, reveal that panel so
  // its spotlight can measure a laid-out (non-zero) rect. We match by walking up from the target to the
  // nearest `[data-tabpanel]` and, if it belongs to this shell, switch to it.
  useEffect(() => {
    const onReveal = (e: Event) => {
      const selector = (e as CustomEvent<string>).detail;
      if (!selector) return;
      const el = document.querySelector(selector);
      const panelEl = el?.closest('[data-tabpanel]') as HTMLElement | null;
      const key = panelEl?.dataset.tabpanel as K | undefined;
      if (key && tabs.some((tab) => tab.key === key)) setActive(key);
    };
    window.addEventListener(TOUR_REVEAL_EVENT, onReveal as EventListener);
    return () => window.removeEventListener(TOUR_REVEAL_EVENT, onReveal as EventListener);
  }, [tabs]);

  return (
    <div ref={shellRef} className="space-y-6">
      <nav
        aria-label={ariaLabel}
        className="flex gap-1 overflow-x-auto rounded-[1.25rem] border border-border bg-card p-1.5 shadow-[var(--shadow-card)]"
      >
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={active === tab.key}
            aria-current={active === tab.key ? 'true' : undefined}
            onClick={() => selectTab(tab.key)}
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
            data-tabpanel={tab.key}
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

// Back-compat alias: the admin Employee Detail page imports `PersonnelTabs` with `PersonnelTabKey`.
export const PersonnelTabs = ClientTabs;
