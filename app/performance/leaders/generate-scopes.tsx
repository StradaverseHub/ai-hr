'use client';
/** WP-B2 — cycle administration: build one calibration scope per leader (HOD, BU CEO, BG CEO, group chief). */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Button } from '@/components/ui';
import { generateCalibrationScopesAction } from './actions';
import type { GeneratedScopesView } from './model';

export function GenerateCalibrationScopes({ cycleId }: { cycleId: string }) {
  const t = useTranslations('onehr.leaders');
  const router = useRouter();
  const [result, setResult] = useState<GeneratedScopesView | null>(null);
  const [error, setError] = useState('');
  const [pending, start] = useTransition();
  const run = () => start(async () => {
    const r = await generateCalibrationScopesAction(cycleId);
    if ('error' in r) { setError(r.error); setResult(null); return; }
    setError(''); setResult(r.data); router.refresh();
  });
  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <p className="text-sm text-muted-foreground">{t('generate.help')} <Link href="/performance/leaders" className="text-primary hover:underline">{t('generate.leadersLink')}</Link></p>
      <Button type="button" variant="secondary" disabled={pending} onClick={run}>{pending ? t('generate.working') : t('generate.button')}</Button>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {result && <p role="status" className="text-sm">{t('generate.result', result)}</p>}
    </div>
  );
}
