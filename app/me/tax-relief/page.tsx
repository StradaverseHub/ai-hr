import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { getTp1, getTp1Accumulated, getTp1FormIdentity, listTp1Years } from '@/core/tax-relief';
import { myEmployment } from '@/core/read';
import { Button, Card, ErrorBanner, PageHeader, inputCls } from '@/components/ui';
import { Tp1DeclarationForm } from '@/components/tp1-declaration-form';
import { mySaveTp1Draft, mySubmitTp1 } from '../actions';

/**
 * Self Personal Tax Relief — LHDN TP1 yearly self-service (ADR-0050, #1.1.3; a2f1fa24).
 *
 * 7ad37961 — the declaration is now the FULL official LHDN TP1 (1/2026): Section A employer, Section B
 * employee, Section C's seventeen numbered deduction items with their lettered sub-lines and their annual
 * limits, Section D rebate, and Section E's declaration. SECTION F — employer consent — is visible here
 * as an OUTCOME and never as a control: this page passes no `consent` prop, so the approve / reject /
 * cancel buttons do not render for an employee, and the service would refuse them if they did.
 *
 * The server sums the deduction items into the authoritative annual total that feeds monthly PCB — the
 * client never sends the total, at item level or at form level. A submitted year is read-only with a
 * "Submit correction" affordance (a correction is just a new submitted row); a past assessment year is a
 * read-only historical view.
 *
 * NO DEDUCTION MONTH ON THIS SCREEN. Self-service declares for the assessment YEAR, exactly as it always
 * has, so `deductionMonth` is null here and the record stays month-less. Choosing the month a relief
 * takes effect from is Section F's job, and Section F is HR's.
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

  const [latest, accumulated] = await Promise.all([
    getTp1(s, { assessmentYear: selectedYear }),
    getTp1Accumulated(s, { assessmentYear: selectedYear }),
  ]);
  // Sections A and B, read from the company and employee records that already hold them — read-only, so
  // nobody re-keys a tax number onto a form. Null when this account has no employment resolved.
  // `personId` comes from the SESSION, never from the page's own data — the same rule every self-service
  // write in core/tax-relief.ts follows. The company is resolved from the person's employment in core.
  const identity = s.personId ? await getTp1FormIdentity(s, { personId: s.personId }) : null;
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
      {/* Sections A and B are INSIDE the shared form now — the employee header this page used to draw
          itself was a second, thinner copy of the same two sections, and two copies drift. */}
      <Tp1DeclarationForm
        selectedYear={selectedYear}
        deductionMonth={null}
        latest={latest}
        accumulated={accumulated}
        readOnly={readOnly}
        employer={identity?.employer ?? null}
        employee={identity?.employee ?? { name: me?.name ?? '', idNumber: null, tin: null }}
        saveDraftAction={mySaveTp1Draft}
        submitAction={mySubmitTp1}
      />

      <p className="text-xs text-muted-foreground">{t('historyNote')}</p>
    </div>
  );
}
