import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { listCompanies, listEmployees } from '@/core/read';
import { getLoanWithSchedule, listActiveLoans, type LoanRow, type RepaymentRow } from '@/core/loans';
import { Card, ErrorBanner, PageHeader, SectionHeader } from '@/components/ui';
import { LoanList } from '@/components/loan-list';
import { LoanNewForm } from '@/components/loan-new-form';

export default async function LoansPage({ searchParams }: { searchParams: Promise<{ error?: string; toast?: string }> }) {
  const s = await requireAdmin();
  const t = await getTranslations('loans');
  const { error } = await searchParams;

  const [companies, employees] = await Promise.all([listCompanies(s), listEmployees(s)]);
  // Gather every loan across the companies the admin can see, with its repayment schedule.
  const loanRows: LoanRow[] = (await Promise.all(companies.map((c) => listActiveLoans(s, c.id)))).flat();
  const withSchedules = (
    await Promise.all(
      loanRows.map(async (l) => {
        const full = await getLoanWithSchedule(s, l.id);
        return full ? { ...l, schedule: full.schedule } : { ...l, schedule: [] as RepaymentRow[] };
      }),
    )
  ).sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  // Active-employee options for the new-loan form (exclude terminated).
  const empOptions = employees
    .filter((e) => e.terminatedOn == null)
    .map((e) => ({ employmentId: e.employmentId, name: e.company ? `${e.name} · ${e.company}` : e.name }));

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={t('title')} description={t('subtitle')} />
      <ErrorBanner message={error} />

      <Card className="overflow-hidden">
        <SectionHeader title={t('loansTitle')} count={withSchedules.length} />
        <LoanList loans={withSchedules} />
      </Card>

      <Card className="p-4">
        <h2 className="mb-3 text-sm font-semibold">{t('newTitle')}</h2>
        <LoanNewForm employees={empOptions} />
      </Card>
    </div>
  );
}
