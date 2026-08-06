import { cookies } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { listCompanies, listEmployees } from '@/core/read';
import { getLoanWithSchedule, listActiveLoans, type LoanRow, type RepaymentRow } from '@/core/loans';
import { Card, ErrorBanner, PageHeader, SectionHeader } from '@/components/ui';
import {
  CollapsibleEmployeePanel,
  EmployeeScopePanel,
  type ScopeEmployee,
} from '@/components/collapsible-employee-panel';
import { LoanList } from '@/components/loan-list';
import { LoanNewForm } from '@/components/loan-new-form';

/**
 * Loans (feedback 6d72816e) — the searchable employee panel, matching the transaction screens beside it.
 *
 * TWO THINGS THE TICKET GOT WRONG, REPRODUCED BEFORE ANYTHING WAS CHANGED:
 *
 *  1. IT IS NOT AT Payroll > Transaction > Loans. That menu row does not exist; Loans lives here, under
 *     Admin. The approved plan proposes moving it into the payroll transaction menu, and THAT MOVE IS NOT
 *     PART OF THIS CHANGE — the payroll nav is an exact-set registry with a matching drift guard that only
 *     one owner may touch per round, and this round that owner is someone else. The screen is ready for the
 *     move; the link is not moved here.
 *
 *  2. "Loans picks an employee from a plain dropdown" describes the NEW-LOAN form, not the list. The list
 *     has never had an employee control at all — it showed every loan in every company the admin can see.
 *
 * SO THE PANEL NARROWS, IT DOES NOT GATE. With nobody selected the list shows everything it always did; on
 * a selection it shows that person's loans. Making selection mandatory would have removed the
 * everyone-at-once view that is this screen's whole reason for existing, which no one asked for.
 *
 * THE PERMISSION DID NOT MOVE WITH THE PANEL. `requireAdmin()` is the gate this page has always sat behind
 * and it is unchanged — deliberately NOT swapped for `scopedAdmin()`, which is a different fence. A page
 * that quietly changed which check it runs while its UI was being redesigned is a privilege change dressed
 * as a UI request, and this one is not that.
 *
 * `?employmentId=` is SCOPE-GUARDED the same way every other screen guards it: resolved against the
 * server's own employee list before it selects anything, so URL tampering can only ever narrow.
 */

/** One cookie per screen — each collapses independently (the convention f3ae3245 set for Fixed). */
export const LOANS_PANEL_COOKIE = 'loans_panel';

export default async function LoansPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; toast?: string; employmentId?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('loans');
  const { error, employmentId } = await searchParams;

  const [companies, employees] = await Promise.all([listCompanies(s), listEmployees(s)]);

  // SCOPE-GUARD the param: the ?employmentId= must be in the list this admin can already see. An unknown or
  // out-of-scope value is treated as NO selection (the whole list), never as an error and never as a read.
  const selected = employmentId && employees.some((e) => e.employmentId === employmentId) ? employmentId : null;

  // Gather every loan across the companies the admin can see, with its repayment schedule.
  const loanRows: LoanRow[] = (await Promise.all(companies.map((c) => listActiveLoans(s, c.id)))).flat();
  // Narrow AFTER the read, not before: the read is per-company and already access-fenced, and filtering
  // here keeps the "no selection ⇒ everything" case byte-identical to what this page did before.
  const visibleLoans = selected ? loanRows.filter((l) => l.employmentId === selected) : loanRows;
  const withSchedules = (
    await Promise.all(
      visibleLoans.map(async (l) => {
        const full = await getLoanWithSchedule(s, l.id);
        return full ? { ...l, schedule: full.schedule } : { ...l, schedule: [] as RepaymentRow[] };
      }),
    )
  ).sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  // Active-employee options for the new-loan form (exclude terminated).
  const empOptions = employees
    .filter((e) => e.terminatedOn == null)
    .map((e) => ({ employmentId: e.employmentId, name: e.company ? `${e.name} · ${e.company}` : e.name }));

  // Resolved on the SERVER from the cookie so first paint is already correct; absent ⇒ expanded.
  const panelDefaultOpen = (await cookies()).get(LOANS_PANEL_COOKIE)?.value !== '0';
  // ALL employees, not just active ones: a terminated employee can still carry a settled or outstanding
  // loan, and a screen whose whole job is the historical record must be able to reach them. The Employee
  // Status filter in the panel is what narrows to the active ones.
  const panelEmployees: ScopeEmployee[] = employees.map((e) => ({
    employmentId: e.employmentId,
    name: e.name,
    employeeCode: e.employeeCode,
    company: e.company,
    companyId: e.companyId,
    department: e.department,
    departmentId: e.departmentId,
    businessUnit: e.businessUnit,
    businessUnitId: e.businessUnitId,
    status: e.terminatedOn == null ? 'active' : 'ended',
  }));

  return (
    <div className="mx-auto max-w-[100rem] space-y-6">
      <PageHeader title={t('title')} description={t('subtitle')} />
      <ErrorBanner message={error} />

      <CollapsibleEmployeePanel
        defaultOpen={panelDefaultOpen}
        cookieKey={LOANS_PANEL_COOKIE}
        panel={
          <Card className="p-4">
            <h2 className="text-sm font-semibold">{t('employee')}</h2>
            <div className="mt-3">
              <EmployeeScopePanel
                employees={panelEmployees}
                selectedId={selected}
                basePath="/admin/loans"
              />
            </div>
          </Card>
        }
      >
        <div className="space-y-6">
          <Card className="overflow-hidden">
            <SectionHeader title={t('loansTitle')} count={withSchedules.length} />
            <LoanList loans={withSchedules} />
          </Card>

          <Card className="p-4">
            <h2 className="mb-3 text-sm font-semibold">{t('newTitle')}</h2>
            <LoanNewForm employees={empOptions} />
          </Card>
        </div>
      </CollapsibleEmployeePanel>
    </div>
  );
}
