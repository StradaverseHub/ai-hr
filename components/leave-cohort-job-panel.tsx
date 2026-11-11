'use client';

import {useEffect, useRef, useState} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import {toast} from 'sonner';
import {Card} from '@/components/ui';
import {leaveCohortJobActive, leaveCohortJobPercent, type EarnedAccrualJobResult, type LeaveCohortJobProgress} from '@/lib/leave-cohort-job';
import {leaveGenerationMessages} from '@/lib/leave-generation-message';
import type {LeaveGenerationResult} from '@/core/leave-generation';

const POLL_MS = 2000;

/**
 * A running background leave processing job (Generate Entitlement, Run Earned Accrual), in the pattern of the leave
 * import's progress panel. When it finishes it says what the synchronous run's toast said, and anything left
 * undone, then refreshes the page and hands over to the caller.
 */
export function LeaveCohortJobPanel({job: initial, onDone}: {job: LeaveCohortJobProgress; onDone?: (job: LeaveCohortJobProgress) => void}) {
  const t = useTranslations('admin.leave');
  const tj = useTranslations('admin.leave.processingJob');
  const router = useRouter();
  const [job, setJob] = useState(initial);
  const [checkedAt, setCheckedAt] = useState(0);
  const finished = useRef(false);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let again = true;
      try {
        const response = await fetch(`/admin/leave/jobs/${initial.id}`, {cache: 'no-store'});
        const payload = await response.json().catch(() => null);
        if (alive && response.ok && payload?.job) {
          setJob(payload.job);
          setCheckedAt(Date.now());
          again = leaveCohortJobActive(payload.job.state);
        }
      } finally {
        if (alive && again) timer = setTimeout(poll, POLL_MS);
      }
    };
    void poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [initial.id]);
  useEffect(() => {
    if (finished.current || leaveCohortJobActive(job.state)) return;
    finished.current = true;
    if (job.state === 'completed' && job.result) {
      // A recalculation after a save said nothing when it ran inside the save; the refreshed page shows it.
      if (job.kind === 'leave_recalc' || job.kind === 'leave_a2c') {
        // Nothing to add: the save's own message stood alone when this ran inside it.
      } else if (job.kind === 'leave_generation') {
        const message = leaveGenerationMessages((key, values) => t(key as never, values as never), job.result as LeaveGenerationResult);
        toast.success(message.toast);
        if (message.error) toast.error(message.error);
      } else {
        const result = job.result as EarnedAccrualJobResult;
        toast.success(t('earnedRunToast', {granted: result.granted, forfeits: result.forfeits}));
      }
      if (job.failedEmployees > 0) toast.error(tj('partial', {count: job.failedEmployees, reason: job.error ?? ''}));
    } else {
      // Generate Entitlement and the A2C correction are all-or-nothing: a stopped run changed nothing.
      toast.error(tj(job.kind === 'leave_generation' || job.kind === 'leave_a2c' ? 'failedNothingChanged' : 'failed', {reason: job.error ?? ''}));
    }
    router.refresh();
    onDone?.(job);
  }, [job, onDone, router, t, tj]);
  if (!leaveCohortJobActive(job.state)) return null;
  const stateText = tj(`state.${job.state}`);
  return (
    <Card className="space-y-3 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">{tj(`title.${job.kind}`)}</h3>
        <span role="status" className="text-xs text-muted-foreground">{stateText}</span>
      </div>
      <progress aria-label={stateText} value={leaveCohortJobPercent(job)} max={100} className="h-2 w-full accent-primary" />
      <p className="text-xs text-muted-foreground">{tj('progressCount', {done: job.done, total: job.total})}</p>
      <p className="text-xs text-muted-foreground">{job.worker === 'unavailable' || checkedAt - Date.parse(job.updatedAt) > 90_000 ? tj('waiting') : tj('backgroundHelp')}</p>
    </Card>
  );
}
