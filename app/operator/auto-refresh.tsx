'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Poll the server while any request is mid-flight, by asking Next to re-render the page.
 *
 * This is NEW code, not an existing idiom — there is no interval poller anywhere else in this codebase,
 * and it is worth being honest about that rather than implying a pattern was reused. It exists because
 * provisioning happens out-of-band on a one-minute cron tick, so the page has no other way to notice
 * that 'pending' became 'done'.
 *
 * Mounted ONLY when something is actually pending or running (see page.tsx), so a settled console does
 * no background work at all. router.refresh() re-runs the server component and reconciles in place —
 * it does not remount the tree, so an activation link the operator has already revealed and is in the
 * middle of copying survives the refresh.
 */
export function AutoRefresh({ intervalMs = 5000 }: { intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(t);
  }, [router, intervalMs]);
  return null;
}
