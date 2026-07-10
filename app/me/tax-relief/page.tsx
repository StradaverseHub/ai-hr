import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { getTp1, listTp1Years } from '@/core/tax-relief';
import { myEmployment } from '@/core/read';
import { Button, Card, ErrorBanner, PageHeader, inputCls } from '@/components/ui';
import { Tp1DeclarationForm } from '@/components/tp1-declaration-form';
import { mySaveTp1Draft, mySubmitTp1 } from '../actions';

/**
 * Self Personal Tax Relief — LHDN TP1 yearly self-service (ADR-0050, #1.1.3; a2f1fa24).
 *
 * The declaration is a STRUCTURED, sectioned form mirroring the paper LHDN TP1: a read-only employee
 * header, then one number input per relief category (individual, spouse, children, parent,
 * medical/insurance, lifestyle, education, other) and a remarks note. The server sums the categories into
 * the authoritative annual total that feeds monthly PCB — the client never sends the total. A submitted
 * year is read-only with a "Submit correction" affordance (a correction is just a new submitted row); a
 * past assessment year is a read-only historical view.
 *
 * Standardize-TP1 (item 0cde61f3): the declaration form is now the shared `<Tp1DeclarationForm>` — the
 * SAME component the HR admin-on-behalf screen (/payroll/transactions/tp1) renders — so the two surfaces
 * cannot drift in layout, fields, help text, or rules. Both read/write the ONE tp1_relief master row.
 */
export default async function TaxReliefPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string; error?: string }>;
}) {
  const { year: spYear, error } = await searchParams;
  const s = await getSession();
  const t = await getTranslations('taxRelief');

  const currentYear = new Date().getFullYear();
  const [years, me] = await Promise.all([listTp1Years(s), myEmployment(s)]);
  // Year options: every year the employee already has a row for, plus the current assessment year.
  const yearOptions = Array.from(new Set([currentYear, ...years])).sort((a, b) => b - a);
  const selectedYear = spYear && /^\d{4}$/.test(spYear) ? Number(spYear) : currentYear;

  const latest = await getTp1(s, { assessmentYear: selectedYear });
  const isHistorical = selectedYear < currentYear;
  // A past assessment year is read-only (historical view); the current year is editable.
  const readOnly = isHistorical;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <Link href="/me" className="text-sm text-muted-foreground transition-colors hover:text-foreground">
        ← {t('backToWorkspace')}
      </Link>
      <PageHeader title={t('title')} description={t('intro')} />

      <ErrorBanner message={error} />

      {/* Employee header — read-only, mirrors the top of the paper TP1 form. */}
      {me && (
        <Card className="p-5">
          <h2 className="text-sm font-semibold">{t('employeeSection')}</h2>
          <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
            <div>
              <dt className="text-xs text-muted-foreground">{t('employeeName')}</dt>
              <dd className="text-sm font-medium">{me.name}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t('employeeNumber')}</dt>
              <dd className="text-sm font-medium tabular-nums">{me.employeeCode ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t('company')}</dt>
              <dd className="text-sm font-medium">{me.company}</dd>
            </div>
          </dl>
        </Card>
      )}

      {/* Year selector */}
      <Card className="p-5">
        <form method="GET" className="flex flex-wrap items-end gap-3">
          <label className="block text-sm">
            <span className="mb-1 block font-medium">{t('yearLabel')}</span>
            <select name="year" defaultValue={String(selectedYear)} className={inputCls}>
              {yearOptions.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" variant="secondary">
            {t('viewYear')}
          </Button>
        </form>
      </Card>

      {/* Declaration — the SHARED form (identical on the HR admin screen). */}
      <Tp1DeclarationForm
        selectedYear={selectedYear}
        latest={latest}
        readOnly={readOnly}
        saveDraftAction={mySaveTp1Draft}
        submitAction={mySubmitTp1}
      />

      <p className="text-xs text-muted-foreground">{t('historyNote')}</p>
    </div>
  );
}
