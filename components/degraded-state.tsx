'use client';

import {useEffect} from 'react';
import {useTranslations} from 'next-intl';
import {Button} from '@/components/ui';
import {isDatabaseCapacityDigest} from '@/lib/database-capacity';

/** Automatic attempts survive the boundary remounting after each failed refetch. */
const MAX_AUTOMATIC_RETRIES = 6;
const RETRY_WINDOW_MS = 120_000;
let automaticRetries = 0;
let lastAutomaticRetryAt = 0;

/** Last-resort state for a failed page render: translated, and it retries by itself when capacity was the cause. */
export function DegradedState({error, retry}: {error: Error & {digest?: string}; retry: () => void}) {
  const t = useTranslations('common.degraded');
  const capacity = isDatabaseCapacityDigest(error.digest);
  useEffect(() => {
    if (!capacity) return;
    if (Date.now() - lastAutomaticRetryAt > RETRY_WINDOW_MS) automaticRetries = 0;
    if (automaticRetries >= MAX_AUTOMATIC_RETRIES) return;
    const delay = Math.min(4000 * 2 ** automaticRetries, 30_000) + Math.random() * 1000;
    const timer = setTimeout(() => {
      automaticRetries += 1;
      lastAutomaticRetryAt = Date.now();
      retry();
    }, delay);
    return () => clearTimeout(timer);
  }, [capacity, retry]);
  return (
    <div role="alert" className="mx-auto max-w-xl space-y-4 px-4 py-8">
      <h2 className="text-lg font-semibold">{capacity ? t('title') : t('unexpectedTitle')}</h2>
      <p className="text-sm text-muted-foreground">{capacity ? t('body') : t('unexpectedBody')}</p>
      <Button variant="secondary" onClick={retry}>{t('retryNow')}</Button>
    </div>
  );
}
