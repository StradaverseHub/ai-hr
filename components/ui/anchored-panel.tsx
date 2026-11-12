'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * r365 cbfa8b0b · THE ANCHORED PANEL, EXTRACTED — one copy of the positioning, two callers.
 *
 * ── WHERE THIS CAME FROM, AND WHY IT IS NOT A NEW DEPENDENCY ────────────────────────────────────────────
 * This is components/attendance-figure-cells.tsx's panel, lifted out unchanged. That file has carried a
 * working anchored popover since 7c834696; the Leave Credit request row needs the same thing for its
 * Attendance › View button, and the choice was between a second hand-rolled copy, a new package, or this.
 *   · A SECOND COPY is how the four side-sheets in this repo came to differ from one another before
 *     components/ui/drawer.tsx (that file's header records it). The flip-up rule and the capture-phase
 *     re-place below are exactly the kind of detail one copy grows and the other does not.
 *   · A NEW PACKAGE — @radix-ui/react-popover or react-tooltip — is a dependency decision, and neither is
 *     installed (package.json carries radix's alert-dialog, dialog, label, select and slot only). The
 *     approved plan says plainly: do not add one for this.
 * So the maths moved here and BOTH callers were moved onto it in the same round. The attendance caller is
 * the proof the extraction is behaviour-preserving: it had the behaviour first, and it still has it
 * (test/r365-anchored-panel.dom.test.tsx drives it through this module).
 *
 * ── ⚠️ `position: fixed`, NOT `absolute`, AND THAT IS THE LOAD-BEARING PART ──────────────────────────────
 * Both callers live inside `<div className="overflow-x-auto">` (components/ui.tsx's `tableWrapCls`). A CSS
 * box that sets ONE overflow axis computes the other to `auto` as well, so an absolutely-positioned panel
 * is clipped by the very scroller it is trying to escape — it would be cut off at the row's bottom edge. A
 * fixed box is laid out against the viewport and no plain scroll container clips it.
 *
 * The cost of `fixed` is that the panel does NOT travel with the page, which is what the scroll/resize
 * listener below is for, and the listener is registered in the CAPTURE phase because the scroll that
 * matters is the TABLE CONTAINER's own and a scroll event does not bubble.
 *
 * ── WHAT THIS DELIBERATELY IS NOT ───────────────────────────────────────────────────────────────────────
 * Not a modal, not a focus trap, and not a sheet. Below `lg` both callers are expected to use
 * components/ui/drawer.tsx instead (full screen on a phone and a tablet), because a 360px panel anchored to
 * a cell inside a horizontally-scrolling table is unusable at that width. This module owns placement and
 * dismissal only; it never decides which of the two a caller should render.
 */

/**
 * Where the panel goes, in viewport coordinates. `flip` ⇒ it opens UPWARDS from `top`. `maxHeight` is the room
 * left between the anchor and the window edge it opens towards: a panel taller than that scrolls inside itself
 * instead of running off the screen, where a fixed box can never be scrolled into view.
 */
export type AnchoredPlacement = { top: number; left: number; flip: boolean; maxHeight?: number; width?: number };

/**
 * aa045103 · a panel whose width follows its anchor (the Personnel search suggestions: at least the box's
 * width). Measured on every place, so a scroll, a resize or the sidebar collapsing re-measures it with the
 * position. A value of 0 or less means "no layout to measure" (jsdom, a hidden ancestor): the placement then
 * carries no width and the panel keeps its own class width.
 */
export type AnchoredPanelWidth = number | ((anchor: HTMLElement, rect: DOMRect) => number);

/** The panel's width in px. 360 = the `w-[22.5rem]` the attendance panel has always rendered at. */
export const ANCHORED_PANEL_WIDTH = 360;
/** The height the flip decision is taken against — a panel taller than this near the fold opens upwards. */
export const ANCHORED_PANEL_FLIP_HEIGHT = 340;
/** The gap between the trigger's edge and the panel. */
export const ANCHORED_PANEL_GAP = 6;

/**
 * The horizontal room an element can actually be SEEN in: the viewport, narrowed by every ancestor that
 * clips or scrolls horizontally. In the app shell that ancestor is <main> (`overflow-y-auto`, so its x axis
 * computes to `auto` too) — the box beside the sidebar. A popup that opens left of `left` slides under the
 * sidebar; one that opens right of `right` scrolls the page sideways. Measured on the content box, so a
 * scroll container's border and scrollbar are not counted as room.
 */
export function visibleHorizontalBounds(el: HTMLElement): { left: number; right: number } {
  let left = 0;
  let right = document.documentElement.clientWidth || window.innerWidth;
  for (let node = el.parentElement; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
    const overflowX = window.getComputedStyle(node).overflowX;
    if (!overflowX || overflowX === 'visible') continue;
    const r = node.getBoundingClientRect();
    left = Math.max(left, r.left + node.clientLeft);
    right = Math.min(right, r.left + node.clientLeft + (node.clientWidth || r.width));
  }
  return { left, right };
}

/**
 * aa045103 · a START-aligned panel's left edge: the trigger's own left edge, moved left only as far as the
 * panel needs to fit before the visible right edge, and never past the visible left edge (the sidebar).
 *
 * Round 2: never further left than "right edges meet" for a trigger that is itself in view. The 8px gutter
 * is for a panel WIDER than its trigger; a box-width list under a box that already ends at the content's
 * right edge would otherwise start 8px left of the box it belongs to.
 */
export function startAlignedLeft(rect: { left: number; right?: number }, bounds: { left: number; right: number }, width: number, edge = 8): number {
  const fit = rect.right === undefined ? bounds.right - width - edge : Math.max(bounds.right - width - edge, Math.min(rect.right, bounds.right) - width);
  return Math.max(bounds.left, Math.min(rect.left, fit));
}

/**
 * Placement state for ONE open panel, plus the dismissal listeners.
 *
 * `open` is the CALLER's state, not this hook's: which cell is open, and what it should show, is the
 * caller's business (the attendance island keys on the cell, the Leave Credit row keys on the row). What
 * this owns is where the box goes and when the browser has moved it.
 *
 * `onClose` is called for Escape only. Outside-click dismissal is NOT here: the two callers dismiss
 * differently on purpose (hover-out for the attendance figures, an explicit toggle for the View button),
 * and folding a `document` mousedown listener in here would take that choice away from them.
 */
export function useAnchoredPanel({
  open,
  onClose,
  width = ANCHORED_PANEL_WIDTH,
  flipHeight = ANCHORED_PANEL_FLIP_HEIGHT,
  gap = ANCHORED_PANEL_GAP,
  align = 'end',
}: {
  open: boolean;
  onClose: () => void;
  /** A fixed width in px, or a measure of the anchor (see AnchoredPanelWidth); pass a STABLE function. */
  width?: AnchoredPanelWidth;
  flipHeight?: number;
  gap?: number;
  /**
   * `end` (the attendance panel's original rule): the panel's right edge meets the trigger's, clamped to
   * the window. `start` (aa045103, the Personnel column filters): the panel opens from the trigger's LEFT
   * edge and stays inside the content area — an end-aligned panel on a narrow first column would reach left
   * over the sidebar.
   */
  align?: 'start' | 'end';
}): {
  at: AnchoredPlacement | null;
  /** Anchor the panel to this element and place it now. */
  anchorTo: (el: HTMLElement) => void;
  /** Forget the anchor. The caller still owns closing its own `open` state. */
  release: () => void;
} {
  const [at, setAt] = useState<AnchoredPlacement | null>(null);
  const anchor = useRef<HTMLElement | null>(null);
  // Escape must call the CALLER's latest closer without re-registering the listener on every render.
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  const place = useCallback(
    (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      const measured = typeof width === 'function' ? width(el, r) : null;
      const w = measured != null && measured > 0 ? measured : typeof width === 'number' ? width : ANCHORED_PANEL_WIDTH;
      const flip = r.bottom + flipHeight > window.innerHeight && r.top > flipHeight;
      setAt({
        top: flip ? r.top - gap : r.bottom + gap,
        left: align === 'start'
          ? startAlignedLeft(r, visibleHorizontalBounds(el), w)
          : Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8),
        flip,
        maxHeight: Math.max(160, (flip ? r.top : window.innerHeight - r.bottom) - gap - 8),
        ...(measured != null && measured > 0 ? { width: measured } : {}),
      });
    },
    [width, flipHeight, gap, align],
  );

  const anchorTo = useCallback(
    (el: HTMLElement) => {
      anchor.current = el;
      place(el);
    },
    [place],
  );

  const release = useCallback(() => {
    anchor.current = null;
  }, []);

  useEffect(() => {
    if (!open) return;
    const sync = () => {
      if (anchor.current) place(anchor.current);
    };
    const onKey = (e: KeyboardEvent) => {
      // Escape RELEASES THE ANCHOR TOO, which is what the inline version did: its `hide` cleared both the
      // open cell and `anchor.current`. Dropping the ref here is not cosmetic — a released anchor is what
      // stops a `sync` that races the unsubscribe from re-placing a panel that is on its way out.
      if (e.key !== 'Escape') return;
      anchor.current = null;
      closeRef.current();
    };
    window.addEventListener('scroll', sync, { capture: true, passive: true });
    window.addEventListener('resize', sync, { passive: true });
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', sync, { capture: true });
      window.removeEventListener('resize', sync);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, place]);

  return { at, anchorTo, release };
}

/** The attendance panel's own chrome, kept here so the two callers cannot drift apart visually either. */
const PANEL_CLS =
  'fixed z-50 w-[22.5rem] max-w-[calc(100vw-1rem)] overflow-y-auto overscroll-contain rounded-lg border border-border bg-popover p-3 text-left shadow-lg';

/**
 * The positioned box. Renders nothing until `at` is known, so a panel never paints at 0,0 for one frame
 * on its way to the anchor.
 */
export function AnchoredPanel({
  at,
  id,
  role,
  className,
  children,
  ...rest
}: {
  at: AnchoredPlacement | null;
  id?: string;
  role?: string;
  className?: string;
  children: React.ReactNode;
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'id' | 'role' | 'className' | 'children' | 'style'>) {
  if (!at) return null;
  return (
    <div
      id={id}
      role={role}
      className={cn(PANEL_CLS, className)}
      style={{ top: at.top, left: at.left, maxHeight: at.maxHeight, width: at.width, transform: at.flip ? 'translateY(-100%)' : undefined }}
      {...rest}
    >
      {children}
    </div>
  );
}

/**
 * r365 · IS THIS TOO NARROW FOR AN ANCHORED PANEL — DOES IT BELONG IN THE SHEET?
 *
 * `lg` (1024px) is the SAME breakpoint components/ui/drawer.tsx goes full-screen at, and it is deliberately
 * not `md`: a tablet held upright is 768-834px wide, and the approved plan for the drawer (85875e4b) says
 * "full screen on a phone or tablet". Keeping one number means a caller cannot pick the panel at a width
 * where the sheet has already taken the whole screen.
 *
 * ⚠️ IT STARTS `false`, AND THAT IS NOT A GUESS ABOUT THE DEVICE. There is no viewport on the server, so
 * the first client render must match the server's — and it does, because a caller renders NEITHER surface
 * until something is open and nothing is open on the first render; the effect then reports the truth before
 * any open can happen. Reading `matchMedia` during render instead would be the hydration mismatch.
 *
 * ⚠️ AND IT IS ASKED AS A **max-width**, WHICH IS WHY IT IS PHRASED "BELOW" RATHER THAN "ABOVE". jsdom
 * supplies a `matchMedia` whose `matches` is ALWAYS false, so a `min-width` question would answer "this is
 * a phone" in every DOM test in this repo and silently move every one of them onto the sheet. Asked this
 * way round, the environments that cannot answer — jsdom, and anything with no `matchMedia` at all — get
 * the anchored panel, which is the surface those tests are written against; the sheet is reached only by a
 * real viewport, or by a test that installs a `matchMedia` saying so.
 */
export const ANCHORED_PANEL_SHEET_QUERY = '(max-width: 1023.98px)';

export function useBelowLg(): boolean {
  const [below, setBelow] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(ANCHORED_PANEL_SHEET_QUERY);
    const sync = () => setBelow(mq.matches);
    sync();
    mq.addEventListener?.('change', sync);
    return () => mq.removeEventListener?.('change', sync);
  }, []);
  return below;
}
