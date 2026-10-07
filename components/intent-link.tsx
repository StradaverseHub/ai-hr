'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type ComponentProps } from 'react';

/** r399: a pointer must rest on the link this long before the full prefetch starts, so sweeping the mouse down a
 *  long list (the feedback board has hundreds of rows) does not ask the server to render every row's page. Focus
 *  and touch are deliberate, so they escalate at once. */
export const INTENT_DWELL_MS = 80;

/**
 * r394 — a `next/link` that prefetches the FULL route once the user shows intent (pointer over it, focus,
 * or a touch starting on it), so the click renders the real page from the client cache instead of a
 * skeleton.
 *
 * Why not just the default: every page here is dynamic, so the default prefetch stops at the loading
 * boundary (components/route-loading.tsx). A click then shows the skeleton and React holds the real
 * content back for its ~300 ms Suspense reveal throttle — measured on the r394 build: 16–36 ms to react,
 * but ~310 ms to content even when the server answered in 36 ms. A full prefetch on intent skips both.
 *
 * Why not `prefetch={true}` everywhere: that renders every visible destination in full on every page
 * load — the sidebar alone shows dozens — which this box cannot afford. Intent narrows it to the one or
 * two links the user is about to click (Next's documented hover-prefetch pattern, applied with `true`).
 * Freshness is bounded by `experimental.staleTimes.static` in next.config.ts (30 s).
 */
export function IntentLink({ prefetch, onPointerEnter, onPointerLeave, onFocus, onTouchStart, ...rest }: ComponentProps<typeof Link>) {
  const [intent, setIntent] = useState(false);
  const dwell = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => { if (dwell.current) { clearTimeout(dwell.current); dwell.current = null; } };
  useEffect(() => clear, []);
  return (
    <Link
      {...rest}
      // An explicit `prefetch={false}` from the caller wins: that link asked never to prefetch.
      prefetch={prefetch === false ? false : intent ? true : prefetch ?? null}
      onPointerEnter={(e) => { if (!intent && !dwell.current) dwell.current = setTimeout(() => { dwell.current = null; setIntent(true); }, INTENT_DWELL_MS); onPointerEnter?.(e); }}
      onPointerLeave={(e) => { clear(); onPointerLeave?.(e); }}
      onFocus={(e) => { clear(); setIntent(true); onFocus?.(e); }}
      onTouchStart={(e) => { clear(); setIntent(true); onTouchStart?.(e); }}
    />
  );
}

export default IntentLink;
