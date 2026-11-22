'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui';
import { useClientReady } from '@/components/use-client-ready';

export function PrintButton() {
  const t = useTranslations('jobDescriptions');
  const interactive = useClientReady();
  return <Button disabled={!interactive} onClick={() => window.print()}>{t('print')}</Button>;
}
