'use client';

import { useState, type ReactNode } from 'react';

/**
 * The employee panel + workspace two-column shell, with the panel collapsible — 49e7e0a2 (Individual
 * Transaction) and f3ae3245 (Fixed Transaction), which both ask for it in the same words.
 *
 * BUILT ONCE ON PURPOSE. Both transaction screens asked for the same control and NEITHER had one, and no
 * horizontal panel collapse existed anywhere in this codebase before this. `components/collapsible-card-
 * section.tsx` is the VERTICAL details/summary fold; its cookie-persistence shape is reused here (path=/,
 * one year, samesite=lax, server reads it to resolve `defaultOpen` so first paint is already correct and
 * there is no open-then-collapse flash), but its markup solves a different problem and is not reused.
 *
 * WHY IT OWNS THE GRID RATHER THAN LIVING INSIDE THE PANEL. Collapsing the panel has to give its width to
 * the workspace, and only the element that declares the columns can do that. So this component takes both
 * sides and lays them out, which also means the two screens cannot drift into two slightly different
 * collapse behaviours.
 *
 * EVERY PROP IS PLAIN DATA OR A ReactNode — deliberately, and this is not a style preference. A function
 * passed from a SERVER component to a client one returns a 500 on every request while tsc, the test suite
 * and the render check all stay green, and the Fixed Transaction screen is a server component. Labels
 * arrive PRE-TRANSLATED for the same reason the collapsible-card-section takes them that way: the caller
 * does the literal `t('…')` lookups, so the i18n coverage check can still see them.
 */
export function CollapsibleEmployeePanel({
  panel,
  children,
  defaultOpen,
  cookieKey,
  hideLabel,
  showLabel,
  collapsedTitle,
}: {
  /** The employee list (left). Rendered only while expanded. */
  panel: ReactNode;
  /** The workspace (right). Always rendered; takes the full width while the panel is collapsed. */
  children: ReactNode;
  /** SSR-resolved initial state, read from the cookie by the server page. */
  defaultOpen: boolean;
  /** Cookie persisting the choice. One per screen, so the two do not share a state. */
  cookieKey: string;
  /** Pre-translated label for the control while the panel is OPEN (e.g. "Hide employee list"). */
  hideLabel: string;
  /** Pre-translated label for the control while the panel is COLLAPSED (e.g. "Employees"). */
  showLabel: string;
  /** Pre-translated vertical caption on the collapsed rail, so the strip is self-explaining. */
  collapsedTitle: string;
}) {
  const [open, setOpen] = useState(defaultOpen);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    document.cookie = `${cookieKey}=${next ? '1' : '0'}; path=/; max-age=31536000; samesite=lax`;
  };

  return (
    <div
      className={`grid gap-4 lg:items-start ${
        open ? 'lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]' : 'lg:grid-cols-[auto_minmax(0,1fr)]'
      }`}
    >
      {open ? (
        <div className="min-w-0 space-y-2">
          <button
            type="button"
            onClick={toggle}
            aria-expanded="true"
            className="flex w-full items-center gap-2 rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <span aria-hidden>☰</span>
            {hideLabel}
          </button>
          {panel}
        </div>
      ) : (
        // The collapsed rail keeps the control in the same place on the page rather than moving it into
        // the workspace header, so expanding is where collapsing left it.
        <div className="lg:w-10">
          <button
            type="button"
            onClick={toggle}
            aria-expanded="false"
            title={showLabel}
            className="flex w-full items-center justify-center gap-2 rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:h-40 lg:flex-col"
          >
            <span aria-hidden>◀</span>
            <span className="lg:[writing-mode:vertical-rl]">{collapsedTitle}</span>
          </button>
        </div>
      )}
      <div className="min-w-0">{children}</div>
    </div>
  );
}
