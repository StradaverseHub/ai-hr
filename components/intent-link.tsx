'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type ComponentProps } from 'react';

/** r399: a pointer must rest on the link this long before the full prefetch starts, so sweeping the mouse down a
 *  long list does not ask the server to render every row's page. Focus and touch escalate at once. */
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
 * End eligibility when the interaction ends so persistent links do not re-prefetch on later cache invalidations.
 * Leave viewport prefetch off unless the caller explicitly requests it.
 * Freshness is bounded by `experimental.staleTimes.static` in next.config.ts (30 s).
 */
type IntentLinkProps = ComponentProps<typeof Link> & { prefetchOnIntentOnly?: boolean };

export function IntentLink({
  prefetch, prefetchOnIntentOnly = true, onPointerEnter, onPointerLeave, onFocus, onBlur,
  onTouchStart, onTouchEnd, onTouchCancel, ...rest
}: IntentLinkProps) {
  const [hovering, setHovering] = useState(false);
  const [focused, setFocused] = useState(false);
  const [touching, setTouching] = useState(false);
  const dwell = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (dwell.current !== null) clearTimeout(dwell.current);
  }, []);
  const intent = hovering || focused || touching;
  const initialPrefetch = prefetch === undefined ? (prefetchOnIntentOnly ? false : null) : prefetch;
  return (
    <Link
      {...rest}
      // An explicit `prefetch={false}` from the caller wins: that link asked never to prefetch.
      prefetch={intent && prefetch !== false ? true : initialPrefetch}
      onPointerEnter={(e) => {
        onPointerEnter?.(e);
        if (prefetch === false || e.defaultPrevented || e.pointerType === 'touch' || dwell.current !== null) return;
        dwell.current = setTimeout(() => {
          dwell.current = null;
          setHovering(true);
        }, INTENT_DWELL_MS);
      }}
      onPointerLeave={(e) => {
        if (dwell.current !== null) {
          clearTimeout(dwell.current);
          dwell.current = null;
        }
        setHovering(false);
        onPointerLeave?.(e);
      }}
      onFocus={(e) => {
        onFocus?.(e);
        if (prefetch !== false && !e.defaultPrevented) setFocused(true);
      }}
      onBlur={(e) => {
        setFocused(false);
        onBlur?.(e);
      }}
      onTouchStart={(e) => {
        onTouchStart?.(e);
        if (prefetch !== false && !e.defaultPrevented) setTouching(true);
      }}
      onTouchEnd={(e) => {
        setTouching(false);
        onTouchEnd?.(e);
      }}
      onTouchCancel={(e) => {
        setTouching(false);
        onTouchCancel?.(e);
      }}
    />
  );
}

export default IntentLink;
