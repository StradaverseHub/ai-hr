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
import { useEffect, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { firstDirtyGuard } from '@/lib/unsaved-changes';

/** Window event a tour engine dispatches with a CSS selector to make the tab holding it visible. */
export const TOUR_REVEAL_EVENT = 'tour:reveal';

export type PersonnelTabKey = 'profile' | 'family' | 'job' | 'careerMovement' | 'attendance' | 'bankStatutory' | 'payroll' | 'leave' | 'documents' | 'qualification' | 'others';

export function ClientTabs<K extends string>({
  tabs,
  panels,
  emptyLabel,
  defaultTab,
  ariaLabel = 'Sections',
  selectRef,
  onTabChange,
}: {
  tabs: { key: K; label: string }[];
  panels: Partial<Record<K, ReactNode>>;
  // Shown when a tab's panel resolves to nothing (e.g. Documents for an employee with no records,
  // or any admin-only tab viewed by a non-admin). Keeps a switched-to tab from looking broken.
  emptyLabel: string;
  // Initial tab (deep-link / reload survival). Falls back to the first tab when absent/unknown.
  defaultTab?: K;
  ariaLabel?: string;
  /**
   * 759dfc7d — OPT-IN imperative handle: the shell writes its own `selectTab` here, so an ancestor can
   * move the shell without owning its state. The draft record (app/admin/personnel/new/wizard.tsx) needs
   * it for the "Activate still needs — Employment: Join date" list, whose whole value is that the name of
   * the missing thing is the way to reach it.
   *
   * IT IS `selectTab` AND NOT `setActive` DELIBERATELY. Everything that makes a tab switch safe lives in
   * `selectTab` — the unsaved-changes prompt, and reflecting the tab into the URL — so a caller-driven
   * jump is the same switch a click is, rather than a second path around the guard. Absent on the
   * employee detail page, which switches only by click and is unaffected.
   */
  selectRef?: MutableRefObject<((key: K) => void) | null>;
  /**
   * 759dfc7d — told AFTER a switch commits, for a caller that has to persist which tab is open. The
   * draft record stores it as `employee_draft.current_step`, so a draft picked up two days later reopens
   * on the tab it was left on. Fires only on a real switch (`commitTab`), never on the initial render.
   */
  onTabChange?: (key: K) => void;
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

  const commitTab = (key: K) => {
    setActive(key);
    onTabChange?.(key);
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.set('tab', key);
      // Preserve every other param (from, asOf, …); replaceState avoids a server round-trip and scroll reset.
      window.history.replaceState(window.history.state, '', url.toString());
    }
  };

  /**
   * 420ebab5 part two — a tab with unsaved edits asks before it is left.
   *
   * The panels stay MOUNTED when hidden (see the note above), so a switch does not itself lose anything;
   * what it loses is the reader's sight of the edit, and with a consolidated per-tab Save the whole point
   * is that an edit is not written until Save is pressed. So the tab strip asks the save scope
   * (components/tab-save-scope.tsx) first. The two are sibling islands with no common React ancestor, so
   * they meet through lib/unsaved-changes.ts — and when nothing is registered, or nothing is dirty, this
   * is the identical immediate switch it always was.
   */
  const selectTab = (key: K) => {
    if (key === active) return;
    const guard = firstDirtyGuard();
    if (guard) {
      guard.prompt(() => commitTab(key));
      return;
    }
    commitTab(key);
  };

  // The handle is refreshed after EVERY render — no dependency array — because `selectTab` closes over
  // `active`, and a stale copy would prompt against the wrong tab. An effect rather than a bare
  // assignment in the render body: writing a ref during render is what `react-hooks/refs` forbids, and
  // an effect is early enough regardless, because the only caller is a click handler that cannot run
  // before the render it belongs to has committed. Cleared on unmount so nothing holds a dead shell.
  useEffect(() => {
    if (!selectRef) return;
    selectRef.current = selectTab;
    return () => {
      selectRef.current = null;
    };
  });

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
        className="flex flex-wrap gap-1 rounded-[1.25rem] border border-border bg-card p-1.5 shadow-[var(--shadow-card)]"
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
        // Panels stay mounted (hidden, not unmounted) so the DOM state of the UNCONTROLLED inputs inside
        // a server-rendered panel — this page's per-section forms, and their server-action targets —
        // survives a tab switch, and so returning to a tab costs no re-render. Note what this does NOT
        // mean: a caller that holds its own state ABOVE this shell and renders controlled inputs from it
        // (the draft record, app/admin/personnel/new/wizard.tsx) does not depend on staying mounted at
        // all — its values would survive an unmount. Do not credit this line for that.
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
