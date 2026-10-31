import { getTranslations } from 'next-intl/server';
export default async function LoadingMyEa() {
  const t=await getTranslations('myEa');
  return <p role="status" className="p-6 text-sm text-muted-foreground">{t('loading')}</p>;
}
