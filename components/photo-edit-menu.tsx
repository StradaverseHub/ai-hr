'use client';

/**
 * Profile-photo edit menu (feedback dc23d3b6).
 *
 * Presentation-only client island: the admin photo controls (Upload/Replace form + Remove form) used
 * to sit permanently under the avatar, which cluttered the profile header. This island hides them
 * behind a small pencil/Edit trigger; clicking it opens a popover holding the exact same forms.
 *
 * RSC boundary: the Server Component page BUILDS both <form>s (with their server-action bindings) and
 * passes them in as `children` — this island only toggles their visibility. Nothing exported here is a
 * plain function called from the page (it's rendered as JSX), so the rsc-boundary-guard stays green.
 * `label`/`hint` arrive PRE-TRANSLATED as props (no t() here) so the i18n static-key check keeps
 * meaning and the component stays page-agnostic.
 *
 * CLOSING UNMOUNTS THE CHILDREN — that is deliberate (a stale <form> must not keep a half-filled file
 * input alive off-screen), but it means any state a CALLER derives from those children dies with them.
 * `onClose` exists for exactly that: it fires on every close path (trigger toggle AND backdrop click), so
 * a caller holding, say, a preview of the file the user just picked can drop it instead of leaving the
 * reader staring at an unsaved preview whose submit button no longer exists (3c2f55d7 rev 2).
 *
 * ── WHY THE PANEL IS PORTALLED AND `position: fixed`, NOT `absolute` (r227) ─────────────────────────
 * THE PANEL WAS BEING CLIPPED, NOT OVERLAPPED, and the difference decides the fix. app/layout.tsx gives
 * <main> `overflow-y-auto`; per CSS Overflow 3 a non-visible overflow on ONE axis computes the other axis
 * to `auto` as well, so <main> is a scroll container on both axes. An absolutely-positioned panel is laid
 * out inside that container and is TRIMMED at its edge. Raising z-index fixes nothing: the panel was
 * already z-50 and nothing was competing with it for space.
 *
 * WHICH EDGE, AND AT WHAT WIDTH — measured in Chromium against the shipped classes (main has no
 * horizontal padding, nor does the page's `mx-auto max-w-[100rem]` container; Card is `p-5`; the photo
 * column is 96px wide and is the FIRST item of a `sm:flex-row` header). The 14rem panel is centred on a
 * ~90px trigger sitting ~68px from <main>'s content edge, so it starts ~43px to the LEFT of that edge and
 * ~43px of it is never painted — the left end of every full-width button inside it. It is the LEFT edge,
 * not the right, and it happens at EVERY width where the header is a row (≥640px), not only narrow ones;
 * below 640px the column stretches, the trigger centres, and the panel happens to fit. The item was
 * reported as a narrow-window fault and the approved plan repeats that; the clamp below fixes both
 * readings, so nothing about the remedy changes.
 *
 * THIS EXACT TRAP WAS FIXED HERE BEFORE — r206 / item 65e2d5de, app/payroll/row-actions.tsx, whose
 * docblock states the rule verbatim, and components/attendance-figure-cells.tsx carries the
 * viewport-clamped variant copied below. The remedy is two parts, and both are load-bearing:
 *   1. createPortal to document.body — the panel leaves the scroll container's subtree entirely, so no
 *      ancestor can clip it and no ancestor stacking context can trap it. (`fixed` alone escapes a plain
 *      scroll container, but NOT one whose ancestor grows a transform/filter/contain later; the portal
 *      makes that impossible rather than merely unlikely.)
 *   2. `fixed` coordinates MEASURED from the trigger's own rect and CLAMPED to the viewport, so the panel
 *      can never run off the edge of a narrow screen. It is centred on the trigger where there is room
 *      and slides inward where there is not; `max-w-[calc(100vw-1rem)]` covers a viewport narrower than
 *      the panel itself, where there is no left value that fits 14rem.
 *
 * THE SCROLL/RESIZE LISTENER IS PART OF THE FIX, NOT AN EXTRA. A fixed box does not travel with the page,
 * so the coordinates measured at open-time go stale the moment anything scrolls — the panel would hang in
 * the viewport beside whatever drifted under it. This island had no such listener before, which was
 * harmless only while the panel was absolute. Capture phase, because the scroll that matters is <main>'s
 * own and a scroll event does not bubble.
 *
 * IT RE-PLACES, IT DOES NOT CLOSE — unlike PayrollRowActions, which closes on any scroll. That panel holds
 * links; this one holds a <form> with a FILE INPUT, and closing unmounts it (see above), so closing on
 * scroll would throw away a file the reader had already picked. Following the anchor is the only option
 * that keeps the pick alive.
 *
 * BOTH MOUNT SITES GET THIS. The Personnel employee header (app/admin/personnel/[employmentId]/page.tsx)
 * and the company logo editor (components/company-logo.tsx) render the same island under the same
 * scrolling ancestor; there is no per-caller positioning and there must not be one.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Pencil } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Panel width in px. MUST stay in step with the `w-56` (14rem) class on the panel below — it is the
 *  number the horizontal clamp measures against. */
const PANEL_W = 224;
/** Enough of the panel's height to decide whether it would fall off the bottom. An estimate on purpose:
 *  the real height depends on which forms the caller passed, and measuring it would need a second render
 *  pass to place a panel that is already on screen. Too large only means flipping a little early. */
const PANEL_H = 220;
/** Gap between the trigger and the panel. */
const GAP = 6;
/** Minimum breathing room between the panel and any viewport edge. */
const EDGE = 8;

/** Viewport coordinates for the open panel. `flip` ⇒ it is drawn ABOVE the trigger (`top` is then the
 *  trigger's top edge and the panel is pulled up by its own height with translateY). */
type Anchor = { top: number; left: number; flip: boolean };

export function PhotoEditMenu({
  label,
  hint,
  onClose,
  children,
}: {
  /** Accessible label / tooltip for the pencil trigger, e.g. "Edit photo". */
  label: string;
  /** Small helper line (format + size limit) shown at the bottom of the menu. */
  hint: string;
  /** Fired whenever the popover closes (trigger toggle or backdrop click) — the children have just been
   *  unmounted, so anything the caller derived from them must be dropped here. */
  onClose?: () => void;
  /** The upload/replace + remove <form>s, built by the server page. */
  children: React.ReactNode;
}) {
  // The anchor IS the open state: a non-null `at` means the panel is open, at those coordinates. Keeping
  // them as one value means there is no frame in which the panel is mounted but not yet placed.
  const [at, setAt] = useState<Anchor | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const open = at !== null;

  /** Measure the trigger and clamp the panel into the viewport. */
  const place = useCallback(() => {
    const el = btn.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const flip = r.bottom + PANEL_H > window.innerHeight && r.top > PANEL_H;
    // Centred on the trigger where it fits; slid inward where it does not. The RIGHT edge is clamped
    // first and the left floor applied second — the other order (attendance-figure-cells') yields a
    // NEGATIVE left once the viewport is narrower than the panel, which is precisely the case this fix
    // is about. At that width `max-w-[calc(100vw-1rem)]` shrinks the panel to fit from EDGE.
    const centred = r.left + r.width / 2 - PANEL_W / 2;
    setAt({
      top: flip ? r.top - GAP : r.bottom + GAP,
      left: Math.max(EDGE, Math.min(centred, window.innerWidth - PANEL_W - EDGE)),
      flip,
    });
  }, []);

  const close = () => {
    setAt(null);
    onClose?.();
  };

  // Follow the trigger while the panel is open. Capture phase so <main>'s own scroll (which does not
  // bubble to window) is seen; passive because nothing here calls preventDefault.
  useEffect(() => {
    if (!open) return;
    const sync = () => place();
    window.addEventListener('scroll', sync, { capture: true, passive: true });
    window.addEventListener('resize', sync, { passive: true });
    return () => {
      window.removeEventListener('scroll', sync, { capture: true });
      window.removeEventListener('resize', sync);
    };
  }, [open, place]);

  return (
    <div className="relative">
      <button
        ref={btn}
        type="button"
        onClick={() => (open ? close() : place())}
        aria-expanded={open}
        aria-label={label}
        title={label}
        className={cn(
          'flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-xs font-medium text-foreground transition duration-150 ease-snappy hover:bg-muted active:scale-[0.98]',
          open && 'bg-muted',
        )}
      >
        <Pencil className="size-3.5" />
        <span>{label}</span>
      </button>
      {at &&
        createPortal(
          <>
            <div className="fixed inset-0 z-40" onClick={close} />
            <div
              style={{ top: at.top, left: at.left, transform: at.flip ? 'translateY(-100%)' : undefined }}
              className="fixed z-50 flex w-56 max-w-[calc(100vw-1rem)] flex-col items-center gap-2 rounded-lg border border-border bg-popover p-3 text-popover-foreground opacity-100 shadow-lg transition duration-150 ease-snappy starting:scale-95 starting:opacity-0"
            >
              {children}
              <p className="text-center text-[11px] text-muted-foreground">{hint}</p>
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}
