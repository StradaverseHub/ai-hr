'use client';
import { useFormStatus } from 'react-dom';
import { useTranslations } from 'next-intl';
import { btnSecondary } from '@/components/ui';

export function RefreshWorkButton() {
  const { pending } = useFormStatus();
  const t = useTranslations('controlTower.orchestrator');
  return <button type="submit" disabled={pending} aria-disabled={pending} className={btnSecondary}>
    {t(pending ? 'checking' : 'refresh')}
  </button>;
}
