'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { readPayrollOutstandingRefreshAction, requestPayrollOutstandingRefreshAction } from './outstanding-actions';

/** How often the list looks at its refresh job, and for how long at most before it stops looking. */
const POLL_MS = 2_000;
const POLL_LIMIT_MS = 90_000;

/**
 * a1a80747 r2 — KEEPS THE "REPROCESS REQUIRED" COUNTS ON THIS LIST CURRENT.
 *
 * The server renders the list from each processed run's stored answer (core/payroll-view.ts
 * `payrollRunOutstandingCounts`) and hands this island the runs whose answer is missing or more than a minute old,
 * visible ones first. On arrival it asks once for those runs to be worked out again in the background
 * (core/payroll-run-outstanding.ts), follows that one job, and refreshes the server render when it finishes, so a new
 * or pending employee shows up on the list within moments of opening it. Nothing is processed: the answer only says who
 * is still waiting.
 *
 * Asked once per set of runs: the refreshed render names fewer (or no) runs, and a run asked for within the last minute
 * is never asked for again, so a refresh cannot loop. Without payroll administration, or with the module off, the
 * server asks for nothing and this renders nothing.
 */
export function PayrollOutstandingRefresh({ batchIds }: { batchIds: string[] }) {
  const router = useRouter();
  const t = useTranslations('payroll.list');
  const [busy, setBusy] = useState(false);
  // The one request per set of runs, kept across a remount of the effect so following the job never asks twice, and
  // marked settled once the job has ended so a later render does not follow it again.
  const request = useRef<{ key: string; job: Promise<string | null>; settled: boolean } | null>(null);
  // The router is read through a ref: following the job must not restart whenever the router object changes.
  const routerRef = useRef(router);
  useEffect(() => {
    routerRef.current = router;
  }, [router]);
  const key = batchIds.join(',');

  useEffect(() => {
    if (!key) return;
    if (request.current?.key !== key) {
      request.current = {
        key,
        job: requestPayrollOutstandingRefreshAction(key.split(','))
          .then((r) => r.jobId)
          .catch(() => null),
        settled: false,
      };
    }
    const current = request.current;
    if (current.settled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void (async () => {
      const jobId = await current.job;
      if (cancelled) return;
      if (!jobId) {
        current.settled = true;
        return;
      }
      setBusy(true);
      const started = Date.now();
      const poll = async () => {
        if (cancelled) return;
        const state = await readPayrollOutstandingRefreshAction(jobId).catch(() => 'failed' as const);
        if (cancelled) return;
        if (state === 'running' && Date.now() - started < POLL_LIMIT_MS) {
          timer = setTimeout(poll, POLL_MS);
          return;
        }
        current.settled = true;
        setBusy(false);
        if (state === 'done') routerRef.current.refresh();
      };
      timer = setTimeout(poll, POLL_MS);
    })();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [key]);

  return busy ? (
    <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
      {t('outstandingUpdating')}
    </p>
  ) : null;
}
