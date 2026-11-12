'use client';

import {useEffect, useRef, useState} from 'react';
import {useTranslations} from 'next-intl';
import {Card} from '@/components/ui';
import {leaveImportJobActive, leaveImportJobPercent, type LeaveImportJobProgress} from '@/lib/leave-import-job';
import type {LeaveImportResult} from '@/lib/leave-import-schema';

const POLL_MS = 2000;

/** Shows a running background leave import (shared bulk-job kernel) and hands the finished outcome to the existing
 * result panel. A queued import with no import service serving it says it is waiting, never that it is running. */
export function LeaveImportJobPanel({job: initial, onFinished}: {job: LeaveImportJobProgress; onFinished: (result: LeaveImportResult | null) => void}) {
  const t = useTranslations('admin.leave.import.job');
  const [job, setJob] = useState(initial);
  const [checkedAt, setCheckedAt] = useState(0);
  const finished = useRef(false);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let again = true;
      try {
        const response = await fetch(`/admin/leave/import/jobs/${initial.id}`, {cache: 'no-store'});
        const payload = await response.json().catch(() => null);
        if (alive && response.ok && payload?.job) {
          setJob(payload.job);
          setCheckedAt(Date.now());
          again = leaveImportJobActive(payload.job.state);
        }
      } finally {
        if (alive && again) timer = setTimeout(poll, POLL_MS);
      }
    };
    void poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [initial.id]);
  useEffect(() => {
    if (finished.current || leaveImportJobActive(job.state)) return;
    finished.current = true;
    onFinished(job.result);
  }, [job, onFinished]);
  const stateText = t(`state.${job.state}`);
  return (
    <Card className="space-y-3 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">{t('title')}</h3>
        <span role="status" className="text-xs text-muted-foreground">{stateText}</span>
      </div>
      {leaveImportJobActive(job.state) && (
        <>
          <progress aria-label={stateText} value={leaveImportJobPercent(job)} max={100} className="h-2 w-full accent-primary" />
          <p className="text-xs text-muted-foreground">{t('progressCount', {done: job.done, total: job.total})}</p>
          <p className="text-xs text-muted-foreground">{job.worker === 'unavailable' || checkedAt - Date.parse(job.updatedAt) > 90_000 ? t('waiting') : t('backgroundHelp')}</p>
        </>
      )}
    </Card>
  );
}
