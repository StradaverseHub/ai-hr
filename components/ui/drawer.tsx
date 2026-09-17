'use client';

import * as React from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

/**
 * r304 (board 85875e4b) — THE SHARED RIGHT-SIDE DRAWER.
 *
 * A thin wrapper over @radix-ui/react-dialog in MODAL mode, so the focus trap, Escape, the dimmed overlay
 * and `aria-modal` semantics are Radix's rather than a fourth hand-rolled copy. Before this file the same
 * side sheet had been built separately in components/leave/LeaveDetailsPanel.tsx,
 * components/leave/leave-history-cards.tsx and components/leave-type-workspace.tsx; those three are
 * deliberately NOT moved onto it this round (the plan promises they can move later with no visible change).
 *
 * GENERIC ON PURPOSE: it knows nothing about what it holds. Header (title + optional extra + close X), a body
 * that scrolls, and a footer that does NOT scroll — so Cancel / Save stay on screen however long the body is.
 *
 * ⚠️ THE EXIT ANIMATION IS REAL, AND THAT IS WHY `present` EXISTS. Radix unmounts closed content through its
 * `Presence`, which waits for an exit animation only when it can read a CHANGED `animationName` off a live
 * computed style. That works in a browser but is invisible to jsdom (a static CSSStyleDeclaration), so a
 * test could never tell a drawer that slides out from one that vanishes. Instead the content is
 * `forceMount`ed while `present`: on close Radix flips `data-state` to `closed` (which starts the
 * `ui-drawer-panel-out` keyframes in app/globals.css) and this component unmounts on that animation's
 * `animationend` — with a timer as the floor, so a missing stylesheet can never leave an invisible modal
 * layer eating clicks. Under `prefers-reduced-motion: reduce` there is no animation to wait for (the CSS
 * sets `animation: none`) and it unmounts at once.
 *
 * FOCUS. Opening moves focus inside (Radix). Closing returns it to whatever was focused when the drawer
 * opened — normally the button that opened it. Radix's own return goes to a `Dialog.Trigger`, and a drawer
 * shared by many rows has no single trigger, so the element is remembered at open instead. A caller that
 * wants focus somewhere else (a row that did not exist when the drawer opened) passes `onCloseAutoFocus`
 * and calls `preventDefault()`.
 */

/** The keyframes name in app/globals.css whose end unmounts a closing drawer. */
export const DRAWER_EXIT_ANIMATION = 'ui-drawer-panel-out';
/** The longest a closed drawer stays mounted when no `animationend` arrives (the animation is 240ms). */
export const DRAWER_EXIT_FALLBACK_MS = 400;

const WIDTHS = {
  /** Full screen below `md`; about 40% of a desktop, never narrower than 36rem or wider than 48rem. */
  default: 'md:w-[clamp(36rem,40vw,48rem)]',
  /** Full screen below `md`; a reading-width sheet from `md` up. */
  narrow: 'md:w-[28rem]',
} as const;

export type DrawerWidth = keyof typeof WIDTHS;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function Drawer({
  open,
  onOpenChange,
  title,
  description,
  headerExtra,
  footer,
  children,
  width = 'default',
  closeLabel,
  onCloseAutoFocus,
  className,
}: {
  open: boolean;
  /** Called with `false` for X, Escape and a click on the overlay. The caller decides whether to close. */
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Rendered in the header beside the close button (a badge, a status). */
  headerExtra?: React.ReactNode;
  /** Sticky: stays at the foot of the panel while the body scrolls. */
  footer?: React.ReactNode;
  /** The scrolling body. */
  children: React.ReactNode;
  width?: DrawerWidth;
  closeLabel?: string;
  onCloseAutoFocus?: (event: Event) => void;
  className?: string;
}) {
  const t = useTranslations('components.drawer');
  const [present, setPresent] = React.useState(open);
  // Mount in the same render that opens it — never one frame late, so the entry animation starts from open.
  if (open && !present) setPresent(true);

  const panelRef = React.useRef<HTMLDivElement>(null);
  const returnFocusRef = React.useRef<HTMLElement | null>(null);

  React.useEffect(() => {
    if (open || !present) return;
    const panel = panelRef.current;
    if (!panel || prefersReducedMotion()) {
      setPresent(false);
      return;
    }
    const finish = () => setPresent(false);
    const onEnd = (e: AnimationEvent) => {
      if (e.target === panel && e.animationName === DRAWER_EXIT_ANIMATION) finish();
    };
    panel.addEventListener('animationend', onEnd);
    const timer = window.setTimeout(finish, DRAWER_EXIT_FALLBACK_MS);
    return () => {
      panel.removeEventListener('animationend', onEnd);
      window.clearTimeout(timer);
    };
  }, [open, present]);

  if (!present) return null;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal forceMount>
        <Dialog.Overlay forceMount className="ui-drawer-overlay fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content
          forceMount
          ref={panelRef}
          {...(description ? {} : { 'aria-describedby': undefined })}
          onOpenAutoFocus={() => {
            const active = typeof document !== 'undefined' ? document.activeElement : null;
            returnFocusRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
          }}
          onCloseAutoFocus={(event) => {
            onCloseAutoFocus?.(event);
            if (event.defaultPrevented) return;
            event.preventDefault();
            const back = returnFocusRef.current;
            if (back?.isConnected) back.focus();
          }}
          className={cn(
            'ui-drawer-panel fixed inset-y-0 right-0 z-50 flex h-full w-full max-w-full flex-col border-l border-border bg-popover text-popover-foreground shadow-xl outline-none',
            WIDTHS[width],
            className,
          )}
        >
          <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-5 py-4">
            <div className="min-w-0">
              <Dialog.Title className="break-words text-base font-semibold">{title}</Dialog.Title>
              {description ? (
                <Dialog.Description className="mt-0.5 text-xs text-muted-foreground">{description}</Dialog.Description>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {headerExtra}
              <Dialog.Close asChild>
                <button
                  type="button"
                  aria-label={closeLabel ?? t('close')}
                  className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground dark:hover:bg-muted/40"
                >
                  <X className="size-4" aria-hidden />
                </button>
              </Dialog.Close>
            </div>
          </div>
          <div data-drawer-body="" className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {children}
          </div>
          {footer ? (
            <div data-drawer-footer="" className="shrink-0 border-t border-border bg-popover px-5 py-3">
              {footer}
            </div>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
