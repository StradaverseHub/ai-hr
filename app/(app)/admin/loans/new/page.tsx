import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { listEmployees } from '@/core/read';
import { Card, EmployeeName, ErrorBanner, PageHeader, SectionHeader } from '@/components/ui';
import { LoanNewForm } from '@/components/loan-new-form';

/**
 * 6d72816e — the dedicated Add page for a new loan.
 *
 * WHAT IT REPLACES. `components/loan-new-form.tsx` used to be rendered unconditionally at the bottom of
 * `/admin/loans`, permanently open, with its OWN employee dropdown. So the screen had two employee controls
 * that could disagree — you picked somebody on the left and the form was still addressed to whoever came
 * first alphabetically — and simply LOOKING at a person's loans presented a form to create one.
 *
 * THE EMPLOYEE IS FIXED FROM THE URL AND SCOPE-GUARDED HERE. `?employmentId=` is resolved against this
 * admin's own employee list before anything renders; an id that does not resolve is a 404, not an empty
 * form. That is the refusal `requireAdmin()` alone cannot give: the gate says "an admin", the guard says
 * "an employee this admin can already see". The gate itself is UNCHANGED — `requireAdmin()`, exactly as the
 * loans screen has always used, deliberately not swapped for `scopedAdmin()` during a UI redesign.
 *
 * The client-side instalment preview is kept exactly as it was: `computeLoan` is the same pure engine the
 * server runs, so what the operator sees before saving is what gets written. `loan-new-form.tsx` therefore
 * still imports `core/loans-compute` (pure) and never `core/loans`, which imports postgres at module scope
 * and would be dragged into the client bundle, failing `next build`.
 */
export default async function NewLoanPage({
  searchParams,
}: {
  searchParams: Promise<{ employmentId?: string; error?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('loans');
  const { employmentId, error } = await searchParams;

  const employees = await listEmployees(s);
  const emp = employmentId ? (employees.find((e) => e.employmentId === employmentId) ?? null) : null;
  if (!emp) notFound();
  // A loan may only be opened for someone still employed — a terminated employment has no future payroll
  // run to deduct an instalment from. Reading a terminated person's EXISTING loans stays possible (the list
  // panel offers them on purpose); creating a new one does not.
  if (emp.terminatedOn) notFound();

  const backHref = `/admin/loans?employmentId=${encodeURIComponent(emp.employmentId)}`;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader back={{ href: backHref, label: t('title') }} title={t('newTitle')} description={t('newSubtitle')} />

      <ErrorBanner message={error} />

      {/* Employee identity, stated as fact — this page cannot change WHO the loan belongs to. */}
      <Card className="p-4">
        <EmployeeName code={emp.employeeCode} name={emp.name} className="text-sm font-semibold text-foreground" />
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {emp.company} · {emp.department ?? '—'} · {emp.position ?? '—'}
        </p>
      </Card>

      <Card className="overflow-hidden">
        <SectionHeader title={t('newTitle')} />
        <div className="p-4">
          <LoanNewForm employmentId={emp.employmentId} cancelHref={backHref} />
        </div>
      </Card>
    </div>
  );
}
