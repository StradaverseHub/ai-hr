import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listEmployees } from '@/core/read';
import { getTp1ForPerson } from '@/core/tax-relief';
import { Card, EmployeeName, ErrorBanner, PageHeader, SectionHeader } from '@/components/ui';
import { Tp1DeclarationForm } from '@/components/tp1-declaration-form';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { adminSaveTp1Draft, adminSubmitTp1 } from '../../deductions-actions';

/**
 * 3e3d3fb2 — the dedicated Add / View / Edit page for ONE employee's TP1 declaration for ONE assessment
 * year. Reached from the TP1 Relief list's Add button and from every View / Edit in its history table.
 *
 * WHAT IT REPLACES. The declaration form used to render on the LIST screen the moment an employee
 * resolved, so picking somebody to READ their record opened a form to CHANGE it — before anyone had asked
 * for anything, and with no list of which years had been declared. Same three steps, same order, as Fixed
 * Transaction (fixed/[id]/page.tsx) and Zakat (zakat/election/page.tsx).
 *
 * THE FORM IS MOVED, NOT FORKED — AND NOT COPIED. `<Tp1DeclarationForm>` is the SHARED component the
 * employee's own screen (/me/tax-relief) renders, unchanged, and it still posts to the unchanged
 * adminSaveTp1Draft / adminSubmitTp1. That is what keeps the two surfaces byte-identical: HR maintains the
 * SAME single tp1_relief master row the employee edits, and either side's save is immediately the truth for
 * both. Nothing here changes a tax figure, an assessment-year rule, or how a relief reaches the monthly PCB.
 *
 * THE YEAR IS A PATH SEGMENT, THE EMPLOYEE IS A QUERY PARAM, and both are validated before anything is
 * read. The employment is resolved against THIS admin's own scoped list — the same fence the list screen
 * applies — so an out-of-scope or unknown id is a 404 here rather than a cross-company read of a tax
 * declaration. (RLS refuses it at the database too; see the note on the list page.) A year outside
 * 2000–2100 is a 404 rather than a query, matching core/tax-relief.ts's own validateYear range.
 *
 * A PAST ASSESSMENT YEAR OPENS READ-ONLY, exactly as it did on the old screen — that rule lives in the
 * shared form and is passed in, not re-decided here. So the action on a closed year reads View, not Edit.
 *
 * SAVE RETURNS TO THE LIST. The two actions redirect to `/payroll/transactions/tp1?employmentId=…` and are
 * deliberately UNCHANGED by this redesign, so a save lands back on the record it belonged to — the same
 * place Fixed Transaction and Zakat return to. Cancel is the same journey without a write.
 *
 * ONE NAMESPACE ON PURPOSE (`payroll.transactions`), so check C of test/i18n-coverage.test.ts validates
 * every caption on this page key by key. The form's own labels come from `taxRelief`, resolved inside the
 * shared component where they already were.
 */
export default async function Tp1DeclarationYearPage({
  params,
  searchParams,
}: {
  params: Promise<{ year: string }>;
  searchParams: Promise<{ employmentId?: string; error?: string; toast?: string }>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('payroll.transactions');
  const { year: rawYear } = await params;
  const { employmentId, error } = await searchParams;

  // The year first: a path segment is untrusted input like any other. 2000–2100 is core/tax-relief's own
  // accepted range, so a year this page opened could never be one the save would refuse.
  const year = /^\d{4}$/.test(rawYear) ? Number(rawYear) : NaN;
  if (!Number.isInteger(year) || year < 2000 || year > 2100) notFound();

  // Scope-guard the employment exactly as the list does: RLS isolates tenants, company scope does not
  // travel with it, so an out-of-scope (or absent) employmentId is simply not found.
  const employees = await listEmployees(s, scopeIds);
  const emp = employmentId ? (employees.find((e) => e.employmentId === employmentId) ?? null) : null;
  if (!emp) notFound();

  // `personId` is taken from the ALREADY scope-guarded row — never from a form field, which is the rule the
  // admin-on-behalf service (core/tax-relief.ts requireAdminTarget) is built around.
  const latest = await getTp1ForPerson(s, { personId: emp.personId, assessmentYear: year });
  const currentYear = Number(todayInKualaLumpur().slice(0, 4));
  const readOnly = year < currentYear; // a past assessment year is a read-only historical view
  const backHref = `/payroll/transactions/tp1?employmentId=${encodeURIComponent(emp.employmentId)}`;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        back={{ href: backHref, label: t('tp1.title') }}
        title={readOnly ? t('tp1.viewTitle') : latest ? t('tp1.editTitle') : t('tp1.addTitle')}
        description={t('tp1.yearSubtitle', { year: String(year) })}
      />

      <ErrorBanner message={error} />

      {/* Employee identity, stated as fact — this page cannot change WHO the declaration belongs to, and a
          disabled picker would offer a change the action is designed to refuse. */}
      <Card className="overflow-hidden">
        <SectionHeader title={t('tp1.employeeSection')} />
        <div className="p-4">
          <EmployeeName code={emp.employeeCode} name={emp.name} className="text-sm font-semibold text-foreground" />
          <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
            <div>
              <dt className="text-xs text-muted-foreground">{t('tp1.employeeCode')}</dt>
              <dd className="text-sm font-medium tabular-nums">{emp.employeeCode ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t('tp1.employee')}</dt>
              <dd className="text-sm font-medium">{emp.name}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t('tp1.companyLabel')}</dt>
              <dd className="text-sm font-medium">{emp.company}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t('tp1.departmentLabel')}</dt>
              <dd className="text-sm font-medium">{emp.department ?? '—'}</dd>
            </div>
          </dl>
        </div>
      </Card>

      {/* The SHARED declaration form — identical to the employee's own screen, writing on-behalf. */}
      <Tp1DeclarationForm
        selectedYear={year}
        latest={latest}
        readOnly={readOnly}
        saveDraftAction={adminSaveTp1Draft}
        submitAction={adminSubmitTp1}
        hiddenFields={{ employmentId: emp.employmentId }}
      />

      {/* Cancel sits OUTSIDE the shared form on purpose: that component is rendered by the employee's screen
          too, and a Cancel there would need a destination this page cannot speak for. Save and Submit are
          the form's own buttons, directly above. */}
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={backHref}
          className="rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {t('tp1.cancel')}
        </Link>
        <p className="text-xs text-muted-foreground">{t('tp1.historyNote')}</p>
      </div>
    </div>
  );
}
