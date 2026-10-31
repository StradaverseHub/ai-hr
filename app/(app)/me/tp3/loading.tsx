import { getTranslations } from 'next-intl/server';
export default async function LoadingMyTp3() {
  const t=await getTranslations('myTp3');
  return <p role="status" className="p-6 text-sm text-muted-foreground">{t('loading')}</p>;
}
