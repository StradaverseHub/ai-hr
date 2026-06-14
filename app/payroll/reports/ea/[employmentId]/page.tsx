import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { employeeEaStatement } from '@/core/reporting';
import { Card } from '@/components/ui';
import { PrintButton } from '@/components/print-button';

const rm = (n: unknown) =>
  `RM ${Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function Row({ label, value, muted }: { label: string; value: React.ReactNode; muted?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border/60 py-1.5 text-sm last:border-0">
      <span className={muted ? 'text-muted-foreground' : ''}>{label}</span>
      <span className={`tabular-nums ${muted ? 'text-muted-foreground' : 'font-medium'}`}>{value}</span>
    </div>
  );
}

export default async function EaStatementPage({
  params,
  searchParams,
}: {
  params: Promise<{ employmentId: string }>;
  searchParams: Promise<{ year?: string }>;
}) {
  const { employmentId } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(employmentId)) notFound();
  const { year } = await searchParams;
  const yr = /^\d{4}$/.test(year ?? '') ? (year as string) : '2026';
  const s = await getSession(); // RLS-scopes the read to what this user may see
  const ea = await employeeEaStatement(s, { employmentId, year: yr });
  if (!ea) notFound();

  const t = await getTranslations('payroll.ea');

  const CATEGORY: Record<number, string> = {
    1: t('category1'),
    2: t('category2'),
    3: t('category3'),
  };

  const period =
    ea.employee.hiredOn || ea.employee.terminatedOn
      ? `${ea.employee.hiredOn ?? '—'} → ${ea.employee.terminatedOn ?? t('present')}`
      : '—';

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div className="flex items-start justify-between gap-4 print:hidden">
        <Link href="/payroll/reports" className="text-sm text-muted-foreground transition-colors hover:text-foreground">
          ← {t('backToReports')}
        </Link>
        <PrintButton />
      </div>

      <Card className="space-y-5 p-6">
        <div className="border-b border-border pb-4">
          <h1 className="text-lg font-semibold tracking-tight">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('yearEnded', { year: ea.year, employer: ea.employer.name })}
            {ea.employer.eNumber ? ` · E ${ea.employer.eNumber}` : ''}
          </p>
        </div>

        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('sectionAEmployeeParticulars')}
          </h2>
          <Row label={t('name')} value={ea.employee.name} />
          <Row label={t('incomeTaxNo')} value={ea.employee.taxNo || '—'} />
          <Row label={t('icNo')} value={ea.employee.ic || '—'} />
          <Row label={t('epfNo')} value={ea.employee.epfNo || '—'} />
          <Row label={t('socsoNo')} value={ea.employee.socsoNo || '—'} />
          <Row label={t('mtdCategory')} value={CATEGORY[ea.employee.category] ?? ea.employee.category} />
          <Row label={t('childrenTaxRelief')} value={ea.employee.children} />
          <Row label={t('employmentPeriod')} value={period} />
        </section>

        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('sectionBEmploymentIncome')}
          </h2>
          <Row label={t('grossSalary')} value={rm(ea.partB.grossSalary)} />
          <Row label={t('bonus')} value={rm(ea.partB.bonus)} />
          <Row label={t('allowancesPerquisites')} value={rm(ea.partB.allowances)} />
          <Row label={t('benefitsInKind')} value={t('notTracked')} muted />
          <Row label={t('livingAccommodation')} value={t('notTracked')} muted />
          <div className="mt-2 flex items-baseline justify-between border-t border-border pt-2 text-sm font-semibold">
            <span>{t('totalGrossRemuneration')}</span>
            <span className="tabular-nums">{rm(ea.partB.gross)}</span>
          </div>
        </section>

        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('sectionDTotalDeductions')}
          </h2>
          <Row label={t('monthlyTaxDeduction')} value={rm(ea.partD.mtd)} />
          <Row label={t('cp38Deductions')} value={t('notTracked')} muted />
          <Row label={t('zakatViaSalary')} value={t('notTracked')} muted />
        </section>

        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('sectionEContributions')}
          </h2>
          <Row label={t('epfKwsp')} value={rm(ea.partE.epf)} />
          <Row label={t('socso')} value={rm(ea.partE.socso)} />
          <Row label={t('eisSip')} value={rm(ea.partE.eis)} />
        </section>

        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('sectionFTaxExempt')}
          </h2>
          <Row label={t('taxExemptAllowances')} value={t('notTracked')} muted />
        </section>

        <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-xs text-blue-800 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-300">
          ℹ️ {t('disclaimer', { year: ea.year, version: ea.statutoryVersion })}
        </div>
      </Card>
    </div>
  );
}
