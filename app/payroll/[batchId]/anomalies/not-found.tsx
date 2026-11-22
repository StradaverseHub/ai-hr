import { getTranslations } from 'next-intl/server';
import { PageHeader } from '@/components/ui';

export default async function PayrollAnomaliesNotFound() {
  const t = await getTranslations('nav');
  return <PageHeader title="404" back={{ href: '/payroll', label: t('payroll') }} />;
}
