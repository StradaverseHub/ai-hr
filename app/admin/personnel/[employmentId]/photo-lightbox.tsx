'use client';

/**
 * VIEW PROFILE PHOTO (item 597c810a, point 3).
 *
 * The reporter's ask: "Do not rely only on a small thumbnail to allow the user to inspect the photo."
 * The header already renders the photo — as a 96px CIRCLE with `object-cover`, which is exactly the
 * rendering that cannot answer the questions a photo has to be checked for: is it the right person, is it
 * sideways, is it fit for a pass. A circle with a centre crop hides the edges of the frame by design. So
 * this island shows the SAME bytes with NO crop: `object-contain` at the photo's natural aspect ratio,
 * bounded by the viewport, over the page the reader was already on.
 *
 * NO NEW ROUTE. The panel's <img> points at the same `/personnel/photo/<personId>` URL the header uses, so
 * the access rule is unchanged (app.can_see_person, enforced by RLS in the route, never by this component)
 * and the second fetch is a 304 against the ETag that route now sets.
 *
 * ── WHY AN ISLAND, AND WHY PORTALLED ────────────────────────────────────────────────────────────────
 * It follows the PhotoEditMenu precedent already on this page (components/photo-edit-menu.tsx): the server
 * component keeps owning the data and passes what the island needs as PROPS — the URL and four
 * pre-translated captions, no t() here — so the RSC boundary is respected and the i18n static-key guard
 * still sees the lookups on the page that owns the namespace.
 *
 * It is portalled to document.body for the reason that file documents at length: app/layout.tsx gives
 * <main> `overflow-y-auto`, which per CSS Overflow 3 makes it a scroll container on BOTH axes, and a
 * `fixed` overlay laid out inside it is TRIMMED at its edge. A full-viewport overlay is precisely the
 * thing that must not be clipped by the page it covers.
 *
 * ── THE FOUR ACCESSIBILITY OBLIGATIONS, AND HOW EACH IS MET ─────────────────────────────────────────
 *   1. `role="dialog"` + `aria-modal="true"` + `aria-label` — a screen reader announces a modal with a
 *      name, rather than an unlabelled region the reader is silently now inside.
 *   2. ESCAPE CLOSES. Keydown is bound on `document` (capture-free, while open only): the focused element
 *      is inside the portal, which is not a descendant of this component's own subtree, so a handler on the
 *      panel alone would miss a key pressed before focus lands.
 *   3. FOCUS IS TRAPPED. Tab and Shift+Tab cycle within the panel. Without it the reader tabs into the
 *      page BEHIND a modal overlay they cannot see, and every subsequent keystroke goes somewhere
 *      invisible. The trap is computed on each Tab rather than cached: the panel's focusable set is small
 *      and recomputing it cannot go stale.
 *   4. FOCUS RETURNS TO THE TRIGGER on every close path — Escape, the close button, and the backdrop —
 *      because the alternative is focus on <body>, which puts a keyboard reader back at the top of a very
 *      long page instead of where they were. `openRef` is what makes "every path" true: the return is done
 *      in the one `close()` the three paths share.
 *
 * Pinned by test/photo-lightbox-597c810a.dom.test.tsx.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Expand, X } from 'lucide-react';

/** Everything focusable a panel of ours can contain. Queried live on each Tab (see obligation 3). */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function PhotoLightbox({
  src,
  viewLabel,
  closeLabel,
  dialogLabel,
  alt,
}: {
  /** The serve URL — the SAME one the header <img> uses. No route of this island's own. */
  src: string;
  /** Caption/accessible name of the trigger, e.g. "View photo". */
  viewLabel: string;
  /** Accessible name of the close control, e.g. "Close". */
  closeLabel: string;
  /** Accessible name of the dialog itself, e.g. "Jane Tan — profile photo". */
  dialogLabel: string;
  /** Alt text for the enlarged image. The employee's name: this one is content, not decoration. */
  alt: string;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  /** The ONE close path. Restores focus to the trigger, so no caller can forget to. */
  const close = useCallback(() => {
    setOpen(false);
    trigger.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    // Focus the close control as the panel appears: the reader must be INSIDE the trap before their next
    // keystroke, and it is the panel's only interactive control.
    panel.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== 'Tab') return;
      const nodes = Array.from(panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      // Wrap at both ends, and pull focus back in if it has somehow escaped the panel already.
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey ? active === first || !panel.current?.contains(active) : active === last) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, close]);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-xs font-medium text-foreground transition duration-150 ease-snappy hover:bg-muted active:scale-[0.98]"
      >
        <Expand className="size-3.5" />
        <span>{viewLabel}</span>
      </button>
      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
            onClick={close}
          >
            <div
              ref={panel}
              role="dialog"
              aria-modal="true"
              aria-label={dialogLabel}
              // The backdrop closes; the panel must not, or a click on the photo would dismiss it.
              onClick={(e) => e.stopPropagation()}
              className="relative flex max-h-full max-w-full flex-col items-center gap-2"
            >
              <button
                type="button"
                onClick={close}
                aria-label={closeLabel}
                title={closeLabel}
                className="self-end rounded-md bg-card/90 p-1.5 text-foreground shadow-sm transition duration-150 ease-snappy hover:bg-card active:scale-[0.98]"
              >
                <X className="size-4" />
              </button>
              {/* object-CONTAIN, not cover: the whole frame at its own aspect ratio, which is the entire
                  difference between this and the circle in the header. The two max-* bounds are what keep a
                  portrait photo inside the viewport instead of running off the bottom of it. */}
              {/* eslint-disable-next-line @next/next/no-img-element -- dynamic bytea served by our RLS route; not a static asset */}
              <img
                src={src}
                alt={alt}
                data-photo-lightbox-image
                className="max-h-[80vh] max-w-full rounded-lg object-contain shadow-lg ring-1 ring-white/20"
              />
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
