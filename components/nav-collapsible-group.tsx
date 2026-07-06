'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronRight, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Generic one-level collapsible nav group (b3dc0f78 — Attendance menu consolidation).
 *
 * Presentational and data-driven: it renders a parent button row (icon + label + a chevron
 * that rotates on expand) and, when open, the child `<Link>` rows indented one level. It does
 * NOT hard-code any particular group ("Attendance" etc.) so it can be reused for future nav
 * groups. Labels are resolved from the `nav` namespace via the `labelKey` on each child, so the
 * caller passes data, not JSX.
 *
 * Persistence of the open/closed choice is the caller's concern (it owns the cookie + SSR read
 * to avoid a hydration flash); this component only takes `defaultOpen` and manages the runtime
 * toggle, mirroring how the sidebar's whole-rail collapse works.
 *
 * Collapsed rail (icon-only): the parent renders as a single icon that links to its first
 * visible child; expansion is only available in the expanded rail, so children are never
 * orphaned or unreachable — the first child is always one click away.
 */

export type CollapsibleChild = {
  href: string;
  labelKey: string;
  icon: LucideIcon;
  tour?: string;
};

export function NavCollapsibleGroup({
  labelKey,
  icon: ParentIcon,
  items,
  defaultOpen,
  collapsed,
  isActive,
  cookieKey,
  rowBase,
}: {
  /** Parent label key in the `nav` namespace. */
  labelKey: string;
  icon: LucideIcon;
  /** Already permission-filtered children, in display order. */
  items: CollapsibleChild[];
  /** Initial open state (SSR-resolved by the caller to avoid a flash). */
  defaultOpen: boolean;
  /** Whole-rail icon-only mode. */
  collapsed: boolean;
  /** Active-route predicate shared with the sidebar. */
  isActive: (href: string) => boolean;
  /** Cookie key to persist the open/closed choice (written inside the state updater, matching
   *  the sidebar's whole-rail `rail_collapsed` pattern). */
  cookieKey: string;
  /** Shared row base class from the sidebar so this matches the flat rows visually. */
  rowBase: string;
}) {
  const t = useTranslations('nav');
  const label = t(labelKey);
  const anyChildActive = items.some((c) => isActive(c.href));
  // Auto-open when a child route is active (e.g. landing on /admin/locations), else use the
  // persisted default. `anyChildActive` wins so the active row is never hidden behind a closed group.
  const [open, setOpen] = useState(defaultOpen || anyChildActive);

  if (items.length === 0) return null;

  // Icon-only rail: parent is a single icon linking to its first visible child. No accordion here.
  if (collapsed) {
    const FirstIcon = ParentIcon;
    return (
      <Link
        href={items[0].href}
        title={label}
        aria-label={label}
        aria-current={anyChildActive ? 'page' : undefined}
        className={cn(
          rowBase,
          'size-11 justify-center',
          anyChildActive
            ? 'bg-accent font-medium text-accent-foreground'
            : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
        )}
      >
        <FirstIcon className={cn('size-[20px] shrink-0', anyChildActive && 'text-primary')} strokeWidth={2} />
      </Link>
    );
  }

  const controlsId = `nav-group-${labelKey}`;
  const toggle = () => {
    setOpen((o) => {
      const next = !o;
      // Persist inside the state updater, matching the sidebar's `rail_collapsed` write.
      document.cookie = `${cookieKey}=${next ? '1' : '0'}; path=/; max-age=31536000; samesite=lax`;
      return next;
    });
  };

  return (
    <div className="flex w-full flex-col gap-1">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={controlsId}
        aria-label={label}
        className={cn(
          rowBase,
          'w-full gap-3 px-3 py-2',
          anyChildActive && !open
            ? 'bg-accent/60 font-medium text-accent-foreground'
            : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
        )}
      >
        <ParentIcon
          className={cn('size-[20px] shrink-0', anyChildActive && 'text-primary')}
          strokeWidth={2}
        />
        <span className="truncate text-sm">{label}</span>
        <ChevronRight
          className={cn(
            'ml-auto size-4 shrink-0 text-muted-foreground/70 transition-transform duration-150 ease-snappy',
            open && 'rotate-90',
          )}
          strokeWidth={2}
          aria-hidden
        />
      </button>

      {open && (
        <div id={controlsId} className="flex flex-col gap-1 pl-3">
          {items.map((child) => {
            const active = isActive(child.href);
            const ChildIcon = child.icon;
            const childLabel = t(child.labelKey);
            return (
              <Link
                key={child.href}
                href={child.href}
                data-tour={child.tour}
                aria-label={childLabel}
                aria-current={active ? 'page' : undefined}
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
        </div>
      )}
    </div>
  );
}
