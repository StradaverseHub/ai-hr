'use client';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui';
export default function RewardErrorPage({ reset }: { error: Error; reset: () => void }) {
  const t = useTranslations('rewards');
  return <div role="alert" className="max-w-xl space-y-4 py-8"><h2 className="text-lg font-semibold">{t('unavailable')}</h2><p className="text-sm text-muted-foreground">{t('unavailableHelp')}</p><Button variant="secondary" onClick={reset}>{t('retry')}</Button></div>;
}
