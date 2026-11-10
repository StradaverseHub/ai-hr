'use client';

import {useEffect, useRef, useState} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import {toast} from 'sonner';
import {Card} from '@/components/ui';
import {TOIL_SWEEP_PAGE, toilSweepJobActive, toilSweepJobPercent, toilSweepResultHref, type ToilSweepJobProgress} from '@/lib/toil-sweep-job';

const POLL_MS = 2000;

/**
 * A running replacement-leave sweep (Process expirations, Close replacement-leave year), in the pattern of the leave
 * processing panel (components/leave/leave-cohort-job-panel.tsx). When it finishes the page shows what the
 * synchronous action showed: it opens the same address the action redirected to, so the same banner reports the
 * result, and says which employees were left unchanged, if any.
 */
export function ToilSweepJobPanel({job: initial, onDone}: {job: ToilSweepJobProgress; onDone?: (job: ToilSweepJobProgress) => void}) {
  const tj = useTranslations('admin.toilPolicy.sweepJob');
  const router = useRouter();
  const [job, setJob] = useState(initial);
  const [checkedAt, setCheckedAt] = useState(0);
  const finished = useRef(false);
  useEffect(() => {
    if (!toilSweepJobActive(initial.state)) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let again = true;
      try {
        const response = await fetch(`${TOIL_SWEEP_PAGE}/jobs/${initial.id}`, {cache: 'no-store'});
        const payload = await response.json().catch(() => null);
        if (alive && response.ok && payload?.job) {
          setJob(payload.job);
          setCheckedAt(Date.now());
          again = toilSweepJobActive(payload.job.state);
        }
      } finally {
        if (alive && again) timer = setTimeout(poll, POLL_MS);
      }
    };
    void poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [initial.id, initial.state]);
  useEffect(() => {
    if (finished.current || toilSweepJobActive(job.state)) return;
    finished.current = true;
    if (job.state === 'completed' && job.result) {
      if (job.failedEmployees > 0) toast.error(tj('partial', {count: job.failedEmployees, reason: job.error ?? ''}));
      router.replace(toilSweepResultHref(job));
    } else {
      toast.error(tj('failed', {reason: job.error ?? ''}));
      router.replace(TOIL_SWEEP_PAGE);
    }
    onDone?.(job);
  }, [job, onDone, router, tj]);
  if (!toilSweepJobActive(job.state)) return null;
  const stateText = tj(`state.${job.state}`);
  return (
    <Card className="space-y-3 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">{tj(`title.${job.kind}`)}</h3>
        <span role="status" className="text-xs text-muted-foreground">{stateText}</span>
      </div>
      <progress aria-label={stateText} value={toilSweepJobPercent(job)} max={100} className="h-2 w-full accent-primary" />
      <p className="text-xs text-muted-foreground">{tj('progressCount', {done: job.done, total: job.total})}</p>
      <p className="text-xs text-muted-foreground">{job.worker === 'unavailable' || checkedAt - Date.parse(job.updatedAt) > 90_000 ? tj('waiting') : tj('backgroundHelp')}</p>
    </Card>
  );
}
