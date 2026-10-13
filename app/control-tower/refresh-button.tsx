'use client';
import { useFormStatus } from 'react-dom';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';

export function RefreshWorkButton() {
  const { pending } = useFormStatus();
  const t = useTranslations('controlTower.orchestrator');
  return <Button type="submit" variant="outline" disabled={pending} aria-disabled={pending}>
    {t(pending ? 'checking' : 'refresh')}
  </Button>;
}
