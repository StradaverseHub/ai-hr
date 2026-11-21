'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui';
import { generateAttendanceWorkflowPreviewAction } from './actions';
import { previewHistoryHref } from './navigation';
/** Runs Preview Assignment on the latest saved version and opens the stored result. */
export function GeneratePreviewButton({ lineageId, version }: { lineageId: string; version: number }) {
  const t = useTranslations('attendanceWorkflow.previewHistory'), router = useRouter();
  const [pending, start] = useTransition(), [error, setError] = useState('');
  return <div className="space-y-2">
    <Button type="button" aria-busy={pending} disabled={pending} onClick={() => start(async () => {
      setError('');
      try {
        const result = await generateAttendanceWorkflowPreviewAction(lineageId, version);
        if (result.ok) router.push(previewHistoryHref(lineageId, result.previewId));
        else setError(result.error);
      } catch { setError(t('failed')); }
    })}>{pending ? t('generating') : t('generate')}</Button>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>;
}
