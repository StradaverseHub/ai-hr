'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { isAuthRoute } from '@/lib/auth-routes';

const RELOAD_KEY = 'aihr-auth-route-reload';
const LOOP_WINDOW_MS = 10_000;
const replaceDocument = (href: string) => window.location.replace(href);
/** The address this document already asked to reload; a repeat effect run must not count as a loop. */
let requested: string | null = null;

/**
 * Leaves the authenticated shell when a client navigation lands on a login-flow route.
 *
 * app/layout.tsx is the root layout for both the shell and the login flow and picks between them from
 * `x-pathname`, which only happens on a full document load. When a session expires, the next navigation's
 * server redirect to /login is followed by the client router, which keeps the mounted root layout and swaps
 * only the page: the login form appeared inside the old sidebar and top bar, still showing the signed-out
 * user's name, notification count and menu. This guard covers the shell at once and reloads the document so
 * the server renders the bare login layout.
 *
 * Interim fix: separate (auth)/(app) root layouts would make Next.js do this itself.
 */
export function AuthRouteReload({ reload = replaceDocument }: { reload?: (href: string) => void }) {
  const pathname = usePathname();
  const leaving = isAuthRoute(pathname);
  const [suppressed, setSuppressed] = useState<string | null>(null);

  useEffect(() => {
    if (!leaving) return;
    const href = window.location.href;
    if (requested === href) return;
    // A shell rendered on an auth route by the server itself (x-pathname missing) would otherwise reload
    // forever; reload at most once per address within the window.
    try {
      const last = window.sessionStorage.getItem(RELOAD_KEY) ?? '';
      const at = last.slice(0, last.indexOf('|'));
      if (last.slice(last.indexOf('|') + 1) === href && Date.now() - Number(at) < LOOP_WINDOW_MS) return setSuppressed(pathname);
      window.sessionStorage.setItem(RELOAD_KEY, `${Date.now()}|${href}`);
    } catch {
      // Storage unavailable: still leave the stale shell.
    }
    requested = href;
    reload(href);
  }, [leaving, pathname, reload]);

  if (!leaving || suppressed === pathname) return null;
  return <div data-auth-route-reload aria-busy="true" className="fixed inset-0 z-[2147483647] bg-canvas" />;
}
