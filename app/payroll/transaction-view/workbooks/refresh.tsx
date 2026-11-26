'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export const WORKBOOK_POLL_MS = 3_000;
/** After a failed poll (network, sign-out redirect) the next one waits longer. */
export const WORKBOOK_POLL_RETRY_MS = 10_000;

/** Whether a workbook the list shows is still being prepared; null when the answer could not be read. */
async function readPreparing(): Promise<boolean | null> {
  try {
    const response = await fetch('/payroll/transaction-view/workbooks/preparing', { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    return typeof body === 'object' && body !== null && 'preparing' in body && typeof body.preparing === 'boolean' ? body.preparing : null;
  } catch {
    return null;
  }
}

/**
 * While a workbook is being prepared, ask the small preparing route every few seconds and re-render the page once, when
 * none is left. It never re-renders the page (and the app shell with it) on a timer, and the next question is asked only
 * after the previous answer arrived, so a slow answer can never overlap the next one. Polls only while the tab is
 * visible. Mounted by the page only while a workbook is being prepared; a re-render that still shows one keys a new poll.
 */
export function RefreshWorkbookList({ preparing = readPreparing }: { preparing?: () => Promise<boolean | null> }) {
  const router = useRouter();
  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    const schedule = (ms: number) => { timer = window.setTimeout(tick, ms); };
    async function tick() {
      if (stopped) return;
      if (document.visibilityState !== 'visible') return schedule(WORKBOOK_POLL_MS);
      const answer = await preparing();
      if (stopped) return;
      if (answer === false) {
        stopped = true;
        router.refresh();
        return;
      }
      schedule(answer === null ? WORKBOOK_POLL_RETRY_MS : WORKBOOK_POLL_MS);
    }
    schedule(WORKBOOK_POLL_MS);
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [router, preparing]);
  return null;
}
