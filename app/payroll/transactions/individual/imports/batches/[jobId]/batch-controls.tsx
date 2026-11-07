'use client';

import {useEffect, useState, useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import {Button} from '@/components/ui';
import {queueIndividualImportAction} from '../../../../import-excel/individual-actions';

export function ImportBatchControls({id, running, canConfirm}: {id: string; running: boolean; canConfirm: boolean}) {
  const router = useRouter();
  const t = useTranslations('payroll.individualImport');
  const [busy, start] = useTransition();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => router.refresh(), 2500);
    return () => window.clearInterval(timer);
  }, [router, running]);
  if (!canConfirm) return null;
  return <div className="space-y-2">
    <p className="text-sm text-muted-foreground">{t('confirmHint')}</p>
    <Button disabled={busy} onClick={() => start(async () => {
      setFailed(false);
      const result = await queueIndividualImportAction(id);
      setFailed(!result.ok);
      router.refresh();
    })}>{t('confirm')}</Button>
    {failed && <p role="alert" className="text-destructive">{t('confirmationUnavailable')}</p>}
  </div>;
}
