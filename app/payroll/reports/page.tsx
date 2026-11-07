import { redirect } from 'next/navigation';

export default async function LegacyPayrollReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ companyId?: string; reportId?: string; periodKey?: string }>;
}) {
  const { companyId, reportId, periodKey } = await searchParams;
  if (typeof companyId === 'string' && typeof reportId === 'string' && typeof periodKey === 'string') {
    const query = new URLSearchParams({ companyId, reportId, periodKey });
    redirect(`/payroll/statutory-forms/filing-history?${query}`);
  }
  redirect('/payroll/statutory-forms');
}
