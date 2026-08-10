'use client';

import Link from 'next/link';
import { useEffect, useRef, type Ref } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronRight, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Flyout navigation for modules with sub-items (fdc20776 — replaces the accordion in
 * nav-collapsible-group.tsx). Two pieces, both owned by the sidebar:
 *
 *  - `NavFlyout`   — the parent row rendered INSIDE the rail: a button (icon + label + right
 *    chevron) that opens/closes the panel. No in-place expansion, so the rail keeps a constant
 *    height regardless of how many sub-items a module has.
 *  - `NavFlyoutPanel` — the full-height card rendered BESIDE the rail (a DOM sibling of the
 *    aside, since the aside is overflow-hidden), listing only the open module's sub-items.
 *
 * Single-open behaviour, dismissal and positioning are the sidebar's concern (it owns the
 * `openKey` state and the wrapper the panel anchors to); this file is presentational plus the
 * shared query-aware active predicates.
 *
 * Dismissal uses the repo's popover idiom, NOT a document click listener: a fixed inset-0
 * backdrop (language-switcher.tsx / company-switcher.tsx pattern). The rail sits ABOVE the
 * backdrop (z-50 vs z-40) so clicking another module swaps the panel in a single click — no
 * close-then-reopen race between an outside-click listener and the trigger's own onClick.
 */

export type FlyoutChild = {
  href: string;
  labelKey: string;
  icon: LucideIcon;
  tour?: string;
};

/**
 * Query-aware active predicate. usePathname excludes the query string, so a plain
 * `pathname === href` can never match an href like `/reports?cat=leave` — split each href on
 * the `?`: the path part must match the pathname (exact or segment prefix), and every query
 * param the href carries (e.g. `cat`) must be present with the same value in the current
 * search string.
 */
export function isHrefActive(pathname: string, search: string, href: string): boolean {
  const [path, query] = href.split('?');
  const pathMatches =
    path === '/' ? pathname === '/' : pathname === path || pathname.startsWith(`${path}/`);
  if (!pathMatches) return false;
  if (!query) return true;
  const want = new URLSearchParams(query);
  const have = new URLSearchParams(search);
  for (const [key, value] of want.entries()) {
    if (have.get(key) !== value) return false;
  }
  return true;
}

/**
 * 388e53c2 — the FLAT-ROW active predicate, for the two cases a segment-prefix match gets wrong.
 *
 * `isHrefActive` matches a prefix, which is exactly right for a parent row and exactly wrong for
 * `/leave`: every `/leave/*` screen is a different destination owned by a different row, so the prefix
 * lit "My Leave" while an administrator was reading somebody else's leave record. That was the
 * reporter's original complaint, and after the entry point moved it also lit TWO rows on
 * `/leave/tracker`.
 *
 * A row opts out with `exactHref`, and claims paths that are not below its own href with
 * `ownedSubpaths` — the two leave-inquiry screens kept their `/leave/*` addresses so saved links and
 * export links stay valid, so the row they are reached from has to claim them explicitly.
 *
 * NEITHER FLAG IS A PERMISSION. They decide highlighting only; `adminOnly` / `managerUp` are the gates.
 *
 * Exported (rather than living inside the sidebar) so the truth table can be driven through the real
 * function instead of a copy of it — a copied predicate passes its own test on the day it is written
 * and then drifts.
 */
export function isNavRowActive(
  pathname: string,
  search: string,
  row: { href: string; exactHref?: boolean; ownedSubpaths?: string[] },
): boolean {
  const own = row.exactHref
    ? pathname === row.href.split('?')[0]
    : isHrefActive(pathname, search, row.href);
  if (own) return true;
  return (row.ownedSubpaths ?? []).some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/** A parent module is active when any child's PATH part matches the pathname — the query is
 *  deliberately ignored so e.g. Reports lights up on /reports whatever category is shown. */
export const isParentActive = (pathname: string, hrefs: string[]): boolean =>
  hrefs.some((href) => {
    const path = href.split('?')[0];
    return path === '/' ? pathname === '/' : pathname === path || pathname.startsWith(`${path}/`);
  });

/** Parent row inside the rail. Renders in both rail widths — in the collapsed (icon-only) rail
 *  the icon opens the same panel, replacing the old link-to-first-child shortcut, so admin-only
 *  sub-items stay reachable in slim mode. */
export function NavFlyout({
  labelKey,
  icon: ParentIcon,
  open,
  active,
  collapsed,
  rowBase,
  panelId,
  onToggle,
  triggerRef,
}: {
  /** Parent label key in the `nav` namespace (also the sidebar's `openKey` identity). */
  labelKey: string;
  icon: LucideIcon;
  /** Whether THIS module's panel is the open one (single-open state lives in the sidebar). */
  open: boolean;
  /** Whether any child route is the current one (query-insensitive; see isParentActive). */
  active: boolean;
  /** Whole-rail icon-only mode. */
  collapsed: boolean;
  /** Shared row base class from the sidebar so this matches the flat rows visually. */
  rowBase: string;
  /** id of the panel this trigger controls (aria-controls). */
  panelId: string;
  onToggle: () => void;
  /** Registered with the sidebar so Escape can return focus here. */
  triggerRef: Ref<HTMLButtonElement>;
}) {
  const t = useTranslations('nav');
  const label = t(labelKey);
  return (
    <button
      ref={triggerRef}
      type="button"
      onClick={onToggle}
      aria-haspopup="true"
      aria-expanded={open}
      aria-controls={panelId}
      aria-label={label}
      title={collapsed ? label : undefined}
      className={cn(
        rowBase,
        collapsed ? 'size-11 justify-center' : 'w-full gap-3 px-3 py-2',
        active || open
          ? 'bg-accent font-medium text-accent-foreground'
          : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
      )}
    >
      <ParentIcon className={cn('size-[20px] shrink-0', active && 'text-primary')} strokeWidth={2} />
      {!collapsed && (
        <>
          <span className="truncate text-sm">{label}</span>
          <ChevronRight
            className="ml-auto size-4 shrink-0 text-muted-foreground/70"
            strokeWidth={2}
            aria-hidden
          />
        </>
      )}
    </button>
  );
}

/** The flyout card beside the rail, plus its dismissal backdrop. Mounted only while open. */
export function NavFlyoutPanel({
  labelKey,
  items,
  isActive,
  rowBase,
  panelId,
  onClose,
  onEscape,
}: {
  labelKey: string;
  /** Already permission-filtered children, in display order. */
  items: FlyoutChild[];
  /** Query-aware active predicate shared with the sidebar. */
  isActive: (href: string) => boolean;
  rowBase: string;
  panelId: string;
  /** Close paths: pick an item, click the backdrop. */
  onClose: () => void;
  /** Escape: close AND return focus to the trigger (the sidebar owns the trigger ref). */
  onEscape: () => void;
}) {
  const t = useTranslations('nav');
  const label = t(labelKey);
  const firstLinkRef = useRef<HTMLAnchorElement | null>(null);

  // The panel is a DOM sibling of the aside, so programmatic focus keeps the keyboard flow
  // coherent: focus lands on the first sub-item on open; Escape returns it to the trigger.
  useEffect(() => {
    firstLinkRef.current?.focus();
  }, []);

  // Close on Escape (filter-panel.tsx pattern: the component is mounted only while open, so the
  // listener exists only while open and is removed on close/unmount).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onEscape();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onEscape]);

  return (
    <>
      {/* Backdrop dismissal (language-switcher.tsx idiom). The rail is raised to z-50 by the
          sidebar while open, so its rows stay clickable above this z-40 layer. */}
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        id={panelId}
        aria-label={label}
        className="absolute bottom-0 left-[calc(100%+0.75rem)] top-0 z-50 flex w-64 flex-col overflow-hidden rounded-[1.25rem] border border-border bg-sidebar px-3 py-4 shadow-[var(--shadow-card)] lg:left-[calc(100%+1rem)]"
      >
        <div className="px-3 pb-2 pt-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80">
          {label}
        </div>
        <nav aria-label={label} className="flex flex-1 flex-col gap-1 overflow-y-auto">
          {items.map((child, i) => {
            const active = isActive(child.href);
            const ChildIcon = child.icon;
            const childLabel = t(child.labelKey);
            return (
              <Link
                key={child.href}
                ref={i === 0 ? firstLinkRef : undefined}
                href={child.href}
                data-tour={child.tour}
                aria-label={childLabel}
                aria-current={active ? 'page' : undefined}
                // Mandatory, not belt-and-braces: all Reports children share the /reports
                // pathname and differ only in the `cat` query param, so a usePathname effect
                // never fires when switching report categories — the click itself must close.
                onClick={onClose}
                className={cn(
                  rowBase,
                  'w-full gap-3 px-3 py-2',
                  active
                    ? 'bg-accent font-medium text-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                )}
              >
                <ChildIcon
                  className={cn('size-[18px] shrink-0', active && 'text-primary')}
                  strokeWidth={2}
                />
                <span className="truncate text-sm">{childLabel}</span>
              </Link>
            );
          })}
        </nav>
      </div>
    </>
  );
}
