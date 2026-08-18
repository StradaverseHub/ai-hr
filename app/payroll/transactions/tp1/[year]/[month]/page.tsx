import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listEmployees } from '@/core/read';
import {
  getTp1AccumulatedForPerson,
  getTp1ByIdForPerson,
  getTp1FormIdentity,
  listTp1DeclarationsForPersonYear,
} from '@/core/tax-relief';
import { Button, Card, EmployeeName, ErrorBanner, PageHeader, SectionHeader } from '@/components/ui';
import { Tp1DeclarationForm } from '@/components/tp1-declaration-form';
import { todayInKualaLumpur } from '@/lib/hr-date';
import {
  adminApproveTp1,
  adminCancelTp1,
  adminRejectTp1,
  adminSaveTp1Draft,
  adminSubmitTp1,
} from '../../../deductions-actions';

/**
 * 7ad37961 — the Add / View / Edit page for ONE employee's LHDN TP1 declaration for ONE DEDUCTION MONTH
 * of ONE assessment year. Reached from the TP1 Relief list's "+ Add New TP1" button and from every
 * View / Edit in its month table.
 *
 * WHAT IT REPLACES, AND WHAT IT KEEPS. `tp1/[year]` was the same page at YEAR grain, and 3e3d3fb2 built
 * it to get the declaration form off the list screen. Nothing about that decision is reversed: the form
 * still has its own page, still opens only when somebody asks for it, and `[year]` still exists — as a
 * redirect to this page, so every shipped link and bookmark keeps working. What changed is the grain,
 * because the official 2026 form has a DEDUCTION MONTH box and a year now holds up to twelve records.
 *
 * THE FORM IS SHARED, NOT FORKED. `<Tp1DeclarationForm>` is the SAME component /me/tax-relief renders.
 * Sections A–E are identical on both surfaces. SECTION F — employer consent — renders its buttons ONLY
 * here, because `consent` is passed ONLY here: an employee must not be able to approve their own claim.
 * The service refuses it anyway (requireAdminTarget) and the tp1_relief RLS refuses it under that; this
 * is the third layer, and it is the one that keeps the button out of sight.
 *
 * BOTH PATH SEGMENTS ARE VALIDATED BEFORE ANYTHING IS READ, and the employment is resolved against THIS
 * admin's own scoped list — the same fence the list screen applies — so an out-of-scope or unknown id is
 * a 404 rather than a cross-company read of a tax declaration. A year outside 2000–2100 or a month
 * outside 1–12 is a 404 rather than a query.
 *
 * EVERY PROP CROSSING INTO THE FORM IS PLAIN DATA except the five server actions, which are the form's
 * own submit targets and cross into a SERVER component. r123's 500 was a function prop crossing into a
 * CLIENT island while tsc, the suite and `next build` all stayed green — there is no client island here.
 *
 * ONE NAMESPACE ON PURPOSE (`payroll.transactions`), so check C of test/i18n-coverage.test.ts validates
 * every caption on this page key by key. The form's own labels come from `taxRelief`, resolved inside the
 * shared component where they already were.
 */
export default async function Tp1DeclarationMonthPage({
  params,
  searchParams,
}: {
  params: Promise<{ year: string; month: string }>;
  searchParams: Promise<{ employmentId?: string; error?: string; toast?: string }>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('payroll.transactions');
  const { year: rawYear, month: rawMonth } = await params;
  const { employmentId, error } = await searchParams;

  const year = /^\d{4}$/.test(rawYear) ? Number(rawYear) : NaN;
  if (!Number.isInteger(year) || year < 2000 || year > 2100) notFound();
  const month = /^\d{1,2}$/.test(rawMonth) ? Number(rawMonth) : NaN;
  if (!Number.isInteger(month) || month < 1 || month > 12) notFound();

  const employees = await listEmployees(s, scopeIds);
  const emp = employmentId ? (employees.find((e) => e.employmentId === employmentId) ?? null) : null;
  if (!emp) notFound();

  // `personId` comes from the ALREADY scope-guarded row — never from a form field, which is the rule the
  // admin-on-behalf service (core/tax-relief.ts requireAdminTarget) is built around.
  const [monthRows, identity] = await Promise.all([
    listTp1DeclarationsForPersonYear(s, { personId: emp.personId, assessmentYear: year }),
    getTp1FormIdentity(s, { personId: emp.personId, companyId: emp.companyId }),
  ]);
  // The winning record for THIS month, from the same collapse the list uses — so the page and the row
  // that linked to it can never disagree about which declaration this is. A month-less legacy
  // declaration is reachable at month 1 (the list links it there) and opens as itself.
  const latest =
    monthRows.find((r) => r.deductionMonth === month) ??
    (month === 1 ? (monthRows.find((r) => r.deductionMonth == null) ?? null) : null);
  // EXCLUDING THIS ROW from its own accumulation. Without that, editing an already-approved declaration
  // would count the figure currently on it as "already claimed" and refuse the very number it holds.
  const [full, accumulated] = await Promise.all([
    latest ? getTp1ByIdForPerson(s, { personId: emp.personId, id: latest.id }) : Promise.resolve(null),
    getTp1AccumulatedForPerson(s, {
      personId: emp.personId,
      assessmentYear: year,
      excludeRowId: latest?.id ?? null,
    }),
  ]);

  const currentYear = Number(todayInKualaLumpur().slice(0, 4));
  const readOnly = year < currentYear; // a past assessment year is a read-only historical view
  const backHref = `/payroll/transactions/tp1?employmentId=${encodeURIComponent(emp.employmentId)}&year=${year}`;
  const hidden = { employmentId: emp.employmentId };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        back={{ href: backHref, label: t('tp1.title') }}
        title={readOnly ? t('tp1.viewTitle') : full ? t('tp1.editTitle') : t('tp1.addTitle')}
        description={t('tp1.monthSubtitle', { month: String(month), year: String(year) })}
      />

      <ErrorBanner message={error} />

      {/* Employee identity, stated as fact — this page cannot change WHO the declaration belongs to, and
          a disabled picker would offer a change the action is designed to refuse. */}
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
              <dt className="text-xs text-muted-foreground">{t('tp1.companyLabel')}</dt>
              <dd className="text-sm font-medium">{emp.company}</dd>
            </div>
          </dl>
        </div>
      </Card>

      {/* The SHARED declaration form — identical to the employee's own screen, writing on-behalf, plus
          Section F, which only an admin session ever gets. */}
      <Tp1DeclarationForm
        selectedYear={year}
        deductionMonth={month}
        latest={full}
        accumulated={accumulated}
        readOnly={readOnly}
        employer={identity.employer}
        employee={identity.employee}
        consent={
          full
            ? {
                approveAction: adminApproveTp1,
                rejectAction: adminRejectTp1,
                cancelAction: adminCancelTp1,
                // The approver's name is not stored on the row; it is resolved through approved_by, so a
                // renamed user is never two names on two screens. Not yet joined here — the column is
                // rendered from the row's own stamps and shows an em dash until that join lands.
                approvedByName: null,
                hiddenFields: { ...hidden, tp1ReliefId: full.id, assessmentYear: String(year) },
              }
            : undefined
        }
        saveDraftAction={adminSaveTp1Draft}
        submitAction={adminSubmitTp1}
        hiddenFields={hidden}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={backHref}
          className="rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {t('tp1.cancel')}
        </Link>
        {/* Downloading the completed form is a READ, and it is a route rather than a page — see the
            route's own header for why it is not on the function-access matrix. */}
        {full && (
          <Button asChild size="sm" variant="secondary">
            <a
              href={`/payroll/transactions/tp1/${year}/${month}/pdf?employmentId=${encodeURIComponent(emp.employmentId)}`}
            >
              {t('tp1.downloadForm')}
            </a>
          </Button>
        )}
        <p className="text-xs text-muted-foreground">{t('tp1.historyNote')}</p>
      </div>
    </div>
  );
}
