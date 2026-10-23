'use client';
import { useTranslations } from 'next-intl';
import { Button, Card } from '@/components/ui';
export default function MyEaError({reset}:{reset:()=>void}) {
  const t=useTranslations('myEa');
  return <Card role="alert" className="space-y-4 p-6"><h2 className="font-semibold">{t('loadError')}</h2><Button type="button" onClick={reset}>{t('retry')}</Button></Card>;
}
