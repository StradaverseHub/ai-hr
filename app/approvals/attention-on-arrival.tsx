'use client';

import { useEffect } from 'react';
import { approvalRowDomId, parseApprovalAttentionHash } from '@/lib/approvals-focus';

/** How long the attention outline stays on (inside the requested 3–6s window). */
const ATTENTION_MS = 4500;

/**
 * Attention-on-arrival island (item 8cb7b089, extended by a34eedde). When the page is reached with
 * #approvals-leave / #approvals-leave-cancellation (the dashboard calendar's deep links — the whole
 * pill and its arrow both carry the same href), scroll the target section into view, move focus to
 * it, and stamp a temporary highlight class that a timer removes. The hash may also carry a row id
 * (`<section>--<rowId>`, parsed by the shared parseApprovalAttentionHash): when the matching row is
 * still on the page it gets a companion row flash on the SAME timer; when it is gone (decided
 * meanwhile, or outside the 200-row pending fetch) arrival degrades silently to section-only.
 * Renders nothing.
 *
 * - Mount effect covers every / → /approvals navigation (a cross-route arrival remounts this
 *   subtree); the hashchange listener is cheap insurance for any future same-page hash change.
 * - Reduce-motion: the SCROLL honours prefers-reduced-motion here explicitly, because the global
 *   CSS reset (app/globals.css) cannot suppress a JS smooth-scroll option. Both highlights' bases
 *   are static (outline / tint), so they survive the reset untouched (only the pulses collapse).
 * - The element lookup runs inside requestAnimationFrame with one retry, then gives up silently.
 * - The composite hash matches no DOM id, so the browser's native anchor jump never fires — the
 *   island is the sole scroll owner (accepted: the app requires JS, and the pill links already
 *   carry scroll={false}).
 */
export function AttentionOnArrival() {
  useEffect(() => {
    let timer: number | undefined;
    let raf = 0;
    let target: HTMLElement | null = null;
    let rowTarget: HTMLElement | null = null;

    const clear = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
      target?.classList.remove('approvals-attention');
      target = null;
      rowTarget?.classList.remove('approvals-row-attention');
      rowTarget = null;
    };

    const run = () => {
      const hash = window.location.hash.replace(/^#/, '');
      const parsed = parseApprovalAttentionHash(hash);
      if (!parsed) return;
      const attempt = (retriesLeft: number) => {
        raf = requestAnimationFrame(() => {
          const el = document.getElementById(parsed.sectionId);
          if (!el) {
            if (retriesLeft > 0) attempt(retriesLeft - 1);
            return; // missing target: give up silently
          }
          clear();
          target = el;
          // Row flash (a34eedde): namespaced lookup — a junk rowId simply misses and we fall back
          // to section-only attention. No retries beyond the section's own rAF retry above.
          rowTarget = parsed.rowId ? document.getElementById(approvalRowDomId(parsed.rowId)) : null;
          const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
          el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
          el.focus({ preventScroll: true });
          el.classList.add('approvals-attention');
          rowTarget?.classList.add('approvals-row-attention');
          timer = window.setTimeout(() => {
            el.classList.remove('approvals-attention');
            rowTarget?.classList.remove('approvals-row-attention');
            rowTarget = null;
            timer = undefined;
          }, ATTENTION_MS);
        });
      };
      attempt(1);
    };

    run();
    window.addEventListener('hashchange', run);
    return () => {
      window.removeEventListener('hashchange', run);
      cancelAnimationFrame(raf);
      clear();
    };
  }, []);

  return null;
}
