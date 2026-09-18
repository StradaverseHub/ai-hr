'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * d990f14a — "FULL SCREEN" FOR ONE WIDE TABLE. The reporter asked for an expand option at the bottom right
 * of the Employee Balances table, so a thirteen-column balance row can be read without the rest of the
 * screen around it. There was no precedent for this anywhere in the repo (no fullscreen, Maximize or
 * requestFullscreen call existed), so it is ONE shared component used by every inquiry tab rather than
 * three near-copies.
 *
 * NOT THE NATIVE FULLSCREEN API. `requestFullscreen` needs a user gesture, is refused outright in some
 * embedded contexts, paints its own letterbox behind our background and drops out on an OS space change.
 * An in-page overlay behaves identically in every browser, keeps our own theming, and closes on the same
 * Escape the platform version would have used. The reporter wants to READ a table, not present one.
 *
 * THE TABLE IS PROMOTED IN PLACE, NOT RE-RENDERED OR PORTALLED, and that is the whole design:
 * `children` is the server-rendered table and it stays at ONE position in the React tree, with only this
 * wrapper's className changing. The two alternatives are both worse:
 *   · rendering `children` a second time inside an overlay duplicates every id and `title` in the widest
 *     table in the product, and doubles its DOM;
 *   · moving it into a portal when it opens is a CONTAINER change at the same tree position, which React
 *     reconciles as a different element — so the table unmounts and remounts, resetting its horizontal
 *     scroll and closing any open Explanation panel. Keeping the scroll is the point of the feature.
 * Promoting the wrapper keeps the nodes untouched in both directions.
 *
 * THE ONE RISK THIS CARRIES, STATED RATHER THAN DISCOVERED LATER: `position: fixed` escapes an
 * `overflow: hidden` ancestor (which `Card` is), but it does NOT escape one that has a transform, filter
 * or `contain`. If `Card` ever gains a hover-lift transform, this overlay silently becomes a box inside the
 * card instead of covering the viewport. test/d990f14a-inquiry-fullscreen.test.ts pins Card as
 * transform-free for that reason; if that assertion ever has to be relaxed, this must move to a portal and
 * accept the remount.
 *
 * SERVER/CLIENT BOUNDARY (test/server-client-boundary.test.ts): every label crosses as a plain string and
 * the table crosses as children. No translator and no closure is passed.
 */
export function TableFullscreen({
  title,
  subtitle,
  openLabel,
  closeLabel,
  escHint,
  children,
}: {
  title: string;
  subtitle?: string;
  openLabel: string;
  closeLabel: string;
  escHint: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    // The page behind must not scroll under the overlay, and locking it also holds the page's own scroll
    // position while this wrapper is out of the flow.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
      // Focus returns to the control that opened it, not to the top of the document.
      openerRef.current?.focus();
    };
  }, [open]);

  return (
    <div
      className={open ? 'fixed inset-0 z-50 flex flex-col bg-background' : undefined}
      role={open ? 'dialog' : undefined}
      aria-modal={open ? true : undefined}
      aria-label={open ? title : undefined}
    >
      {open ? (
        <div className="flex items-center justify-between gap-4 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{title}</div>
            {subtitle ? <div className="truncate text-xs text-muted-foreground">{subtitle}</div> : null}
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <span className="hidden text-xs text-muted-foreground sm:inline">{escHint}</span>
            <button
              ref={closeRef}
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted/60"
            >
              {closeLabel}
            </button>
          </div>
        </div>
      ) : null}

      <div className={open ? 'min-h-0 flex-1 overflow-auto' : undefined}>{children}</div>

      {/* The reporter asked for it at the BOTTOM RIGHT of the table, which is why this is a footer strip
          rather than a control in the card heading. Hidden while open: the overlay has its own Close. */}
      <div className="flex justify-end border-t border-border px-4 py-2" hidden={open}>
        <button
          ref={openerRef}
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-primary transition-colors hover:bg-muted/60"
        >
          <svg
            aria-hidden
            viewBox="0 0 16 16"
            className="h-3.5 w-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
          >
            <path d="M6 2H2v4M10 14h4v-4M14 6V2h-4M2 10v4h4" strokeLinecap="round" />
          </svg>
          {openLabel}
        </button>
      </div>
    </div>
  );
}
