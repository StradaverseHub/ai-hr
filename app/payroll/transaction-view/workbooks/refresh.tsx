'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

const STATUS = '/payroll/transaction-view/workbooks/status';
const pollMs = 3_000;

/**
 * While a workbook is preparing, asks the small status route whether the list changed and re-renders the page only
 * when it did. router.refresh() on every tick re-rendered the whole tree, app shell included: about 33 database
 * transactions every 3 s for each open tab (staging, 24 Nov 2026). A hidden tab skips its ticks; a signed-out or
 * refused poll (any 4xx, or a redirect to sign-in) stops; a server error or network blip tries again.
 */
export function RefreshWorkbookList({ signature }: { signature: string }) {
  const router = useRouter();
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let again = true;
      try {
        if (document.visibilityState === 'visible') {
          const response = await fetch(STATUS, { cache: 'no-store', redirect: 'manual' });
          if (!response.ok) again = response.status >= 500;
          else {
            const payload = await response.json() as { signature?: unknown };
            if (alive && payload.signature !== signature) router.refresh();
          }
        }
      } catch { /* a network blip: the next tick tries again */ }
      finally { if (alive && again) timer = setTimeout(poll, pollMs); }
    };
    timer = setTimeout(poll, pollMs);
    return () => { alive = false; clearTimeout(timer); };
  }, [router, signature]);
  return null;
}
