'use client';

import { useEffect } from 'react';
import { APPROVAL_SECTION_ID } from '@/lib/approvals-focus';

/** Only the two known section ids may ever receive the class — never an arbitrary element. */
const VALID_TARGETS = new Set<string>(Object.values(APPROVAL_SECTION_ID));

/** How long the attention outline stays on (inside the requested 3–6s window). */
const ATTENTION_MS = 4500;

/**
 * Attention-on-arrival island (item 8cb7b089). When the page is reached with
 * #approvals-leave / #approvals-leave-cancellation (the dashboard calendar's deep-link arrows),
 * scroll the target section into view, move focus to it, and stamp a temporary highlight class
 * that a timer removes. Renders nothing.
 *
 * - Mount effect covers every / → /approvals navigation (a cross-route arrival remounts this
 *   subtree); the hashchange listener is cheap insurance for any future same-page hash change.
 * - Reduce-motion: the SCROLL honours prefers-reduced-motion here explicitly, because the global
 *   CSS reset (app/globals.css) cannot suppress a JS smooth-scroll option. The highlight's base
 *   is a static outline, so it survives the reset untouched (the pulse alone collapses).
 * - The element lookup runs inside requestAnimationFrame with one retry, then gives up silently.
 */
export function AttentionOnArrival() {
  useEffect(() => {
    let timer: number | undefined;
    let raf = 0;
    let target: HTMLElement | null = null;

    const clear = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
      target?.classList.remove('approvals-attention');
      target = null;
    };

    const run = () => {
      const hash = window.location.hash.replace(/^#/, '');
      if (!VALID_TARGETS.has(hash)) return;
      const attempt = (retriesLeft: number) => {
        raf = requestAnimationFrame(() => {
          const el = document.getElementById(hash);
          if (!el) {
            if (retriesLeft > 0) attempt(retriesLeft - 1);
            return; // missing target: give up silently
          }
          clear();
          target = el;
          const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
          el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
          el.focus({ preventScroll: true });
          el.classList.add('approvals-attention');
          timer = window.setTimeout(() => {
            el.classList.remove('approvals-attention');
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
