import { getTranslations } from 'next-intl/server';
export default async function LoadingMyPayslip() {
  const t=await getTranslations('myPayslip');
  return <p role="status" className="p-6 text-sm text-muted-foreground">{t('loading')}</p>;
}
