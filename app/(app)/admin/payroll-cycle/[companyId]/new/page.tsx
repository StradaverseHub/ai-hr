import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listCompanies } from '@/core/read';
import { ErrorBanner, PageHeader } from '@/components/ui';
import { CycleForm } from '../../cycle-form';
import { cycleCompanyHref } from '../../nav';

/**
 * 6df24751 — ADD NEW CYCLE, on a screen of its own (step 3a).
 *
 * The plan's promise, verbatim: "Add New and Edit each open their own screen with Save and Cancel at the
 * bottom. No form ever appears underneath a list again." This is the Add half; ../[cycleId] is the other.
 *
 * Narrower than the listing (max-w-3xl, the width the payroll-config form has always used) — a form is
 * read down a column, not across a table.
 *
 * Back goes ONE step, to this company's cycle catalog, carrying the company listing's search term.
 */
export default async function NewPayrollCyclePage({
  params,
  searchParams,
}: {
  params: Promise<{ companyId: string }>;
  searchParams: Promise<{ error?: string; q?: string }>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('payrollCycleConfig');
  const { companyId } = await params;
  const { error, q } = await searchParams;

  const all = await listCompanies(s);
  const company = all.find((c) => c.id === companyId && scopeIds.includes(c.id));
  if (!company) notFound();

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title={t('addTitle')}
        description={company.name}
        back={{ href: cycleCompanyHref(company.id, q), label: company.name }}
      />
      {error && <ErrorBanner message={error} />}
      <CycleForm companyId={company.id} companyName={company.name} cycle={null} q={q} />
    </div>
  );
}
