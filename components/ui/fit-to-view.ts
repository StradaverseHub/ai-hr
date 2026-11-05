'use client';

import { useLayoutEffect, type RefObject } from 'react';

/**
 * KEEP AN OPEN DROPDOWN INSIDE THE PART OF THE SCREEN YOU CAN ACTUALLY SEE.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────────────────────────────────
 * Every in-page dropdown in this app is an `absolute` panel under a `relative` wrapper, opened DOWN, with at
 * most a fixed inner height (`max-h-56`, `max-h-[60vh]`, …). None of them knew how much room was left below
 * the trigger. Opened near the bottom of the window, or inside a box that clips its overflow (a dialog, a
 * card, a table's `overflow-x-auto` wrapper, <main> itself), the bottom of the panel was simply cut off. The
 * window cannot rescue it: <body> is `h-dvh overflow-hidden`, so the only thing that scrolls is <main>, and a
 * panel clipped by an ancestor cannot be scrolled into view at all.
 *
 * ── WHAT THIS DOES ──────────────────────────────────────────────────────────────────────────────────────
 * When the panel opens (and again on any scroll or resize while it is open) it measures:
 *   · the VISIBLE BOX — the viewport, cut down by every ancestor that clips overflow (any non-`visible`
 *     overflow on either axis clips both, per CSS);
 *   · the room BELOW the panel's own top, and the room ABOVE its `relative` wrapper (which holds the trigger).
 * A panel that fits below is left exactly as its classes draw it. One that does not opens UPWARDS when there
 * is more room above, and in either direction is capped to the room it has and scrolls inside itself.
 *
 * It only ever writes inline `top/bottom/margin/max-height/overflow-y`, and clears them first on every pass,
 * so the panel's own classes stay the single description of how it looks when there is room.
 *
 * ── WHAT IT IS NOT ──────────────────────────────────────────────────────────────────────────────────────
 * Not a positioning engine and not a portal: the panel stays in the DOM where it is, so focus order, form
 * submission and a surrounding Radix dialog's outside-click handling are untouched. Panels that are already
 * `position: fixed` place themselves (components/ui/anchored-panel.tsx, app/payroll/row-actions.tsx).
 *
 * jsdom lays nothing out — every height is 0 — so the hook does nothing there, and DOM tests see the panel
 * exactly as before.
 */

/** Space kept between the panel and the edge of the visible box. */
const EDGE = 8;
/** The gap between the trigger and a panel opened upwards (the `mt-1` a downward panel already has). */
const GAP = 4;
/** Never shrink a panel below this; a list two rows tall is worse than one that touches an edge. */
const MIN_HEIGHT = 120;

function clipsOverflow(el: Element): boolean {
  const s = getComputedStyle(el);
  return s.overflowX !== 'visible' || s.overflowY !== 'visible';
}

/** The vertical band of the window in which `el` can be seen. */
function visibleBand(el: Element): { top: number; bottom: number } {
  let top = 0;
  let bottom = window.innerHeight;
  for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
    if (!clipsOverflow(a)) continue;
    const r = a.getBoundingClientRect();
    if (r.height === 0) continue;
    top = Math.max(top, r.top);
    bottom = Math.min(bottom, r.bottom);
  }
  return { top, bottom };
}

export function fitToView(panel: HTMLElement): void {
  const s = panel.style;
  s.top = '';
  s.bottom = '';
  s.marginTop = '';
  s.marginBottom = '';
  s.maxHeight = '';
  s.overflowY = '';

  // offsetHeight / offsetTop are LAYOUT values: an opening scale transition does not distort them.
  const natural = panel.offsetHeight;
  const wrapper = panel.offsetParent;
  if (natural === 0 || !(wrapper instanceof HTMLElement)) return;

  const wrapperTop = wrapper.getBoundingClientRect().top;
  const band = visibleBand(panel);
  const below = band.bottom - (wrapperTop + panel.offsetTop) - EDGE;
  if (natural <= below) return;

  const above = wrapperTop - band.top - GAP - EDGE;
  const up = above > below;
  if (up) {
    s.top = 'auto';
    s.bottom = '100%';
    s.marginTop = '0';
    s.marginBottom = `${GAP}px`;
  }
  const room = up ? above : below;
  if (natural > room) {
    s.maxHeight = `${Math.max(room, MIN_HEIGHT)}px`;
    s.overflowY = 'auto';
  }
}

/**
 * Fit `panel` to the visible screen whenever it is open, and keep it fitted while things scroll.
 * `contentKey` re-fits when what the panel shows changes while it stays open (a search narrowing the list,
 * results arriving) — anything that changes its natural height.
 */
export function useFitToView(open: boolean, panel: RefObject<HTMLElement | null>, contentKey?: unknown): void {
  useLayoutEffect(() => {
    if (!open) return;
    const el = panel.current;
    if (!el) return;
    fitToView(el);
    let frame = 0;
    const refit = (e: Event) => {
      // Scrolling the panel's own list is reading it; nothing moved.
      if (e.type === 'scroll' && e.target instanceof Node && el.contains(e.target)) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => fitToView(el));
    };
    window.addEventListener('scroll', refit, { capture: true, passive: true });
    window.addEventListener('resize', refit, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', refit, { capture: true });
      window.removeEventListener('resize', refit);
    };
  }, [open, panel, contentKey]);
}
