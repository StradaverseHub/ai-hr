'use client';
import * as React from 'react';

/** On a phone the centre tab bar scrolls sideways, and the current tab (for example How it works, the last
 * one) could sit off-screen with nothing hinting it is there (review L7). This brings the tab marked
 * aria-current into view inside its own bar once, after mount. It moves only the bar's horizontal scroll,
 * never the page, and does nothing when the bar already fits (it wraps from the sm breakpoint up). */
export function ScrollCurrentTabIntoView({ navId }: { navId: string }) {
  React.useEffect(() => {
    const nav = document.getElementById(navId);
    const current = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !current || nav.scrollWidth <= nav.clientWidth) return;
    const left = current.offsetLeft - nav.offsetLeft, right = left + current.offsetWidth;
    if (left < nav.scrollLeft || right > nav.scrollLeft + nav.clientWidth) nav.scrollLeft = Math.max(0, left - 16);
  }, [navId]);
  return null;
}
