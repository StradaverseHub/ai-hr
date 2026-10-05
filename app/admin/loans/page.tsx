import Link from 'next/link';
import { cookies } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { listCompanies } from '@/core/read';
import { getEmployeeOption, listEmployeeOptionFacets, listEmployeeOptionsPage } from '@/core/employee-search';
import { listLoansPage, listAppliedLoanRepaymentsPage } from '@/core/loans';
import { Button, Card, EmployeeName, ErrorBanner, PageHeader, SectionHeader, pageWideCls } from '@/components/ui';
import {
  CollapsibleEmployeePanel,
  EmployeeScopePanel,
  type ScopeEmployee,
} from '@/components/collapsible-employee-panel';
import { AppliedInPayrollList, type AppliedInPayrollRow } from '@/components/applied-in-payroll-list';
import { LoanList } from '@/components/loan-list';

/**
 * Loans (feedback 6d72816e) — built the way Fixed Transaction is: choose a person, read their loans, then
 * press Add or View / Edit when you actually want to change something.
 *
 * WHAT r168a LEFT BEHIND, AND WHY THE REPORTER SENT IT BACK. The searchable employee panel landed, it
 * collapses, and the loan list already narrowed to the selection. Two things did not:
 *   - components/loan-new-form.tsx was rendered UNCONDITIONALLY at the bottom of the page with its OWN
 *     employee dropdown, so the screen carried two employee controls that could disagree and "picking an
 *     employee" looked like it opened an Add form;
 *   - there was nowhere to see the instalments a payroll run had ACTUALLY deducted — the schedule was
 *     folded inside a row you had to unfold, and it shows what is DUE, not what was taken.
 * Both are fixed here. Add opens `/admin/loans/new`; a loan opens `/admin/loans/[id]`, where the five
 * lifecycle actions finally have room for the copy that says what each one does.
 *
 * TWO CLAIMS IN THE ORIGINAL TICKET WERE ALREADY STALE WHEN IT WAS RE-PLANNED, and both stay that way:
 *   1. Loans HAS its own row in the Payroll menu (packs/payroll/index.ts registers `/admin/loans`
 *      verbatim). The href is deliberately NOT moved — bookmarks and the Transactions-hub card resolve to
 *      it, and test/payroll-flyout-nav.test.ts guards the exact set.
 *   2. "Loans picks an employee from a plain dropdown" described the NEW-LOAN FORM, not the list. The list
 *      has never had an employee control at all — it showed every loan in every company the admin can see.
 *
 * SO THE PANEL NARROWS, IT DOES NOT GATE. With nobody selected both lists show everything they always did;
 * on a selection they show that person's. Making selection mandatory would remove the everyone-at-once
 * view that is this screen's whole reason for existing, which no one asked for.
 *
 * THE PERMISSION DID NOT MOVE WITH THE REDESIGN. `requireAdmin()` is the gate this page has always sat
 * behind and it is unchanged — deliberately NOT swapped for `scopedAdmin()`, which is a different fence. A
 * page that quietly changed which check it runs while its UI was being redesigned is a privilege change
 * dressed as a UI request, and this one is not that. `?employmentId=` is SCOPE-GUARDED the same way every
 * other screen guards it: resolved against the server's own employee list before it selects anything, so
 * URL tampering can only ever narrow.
 *
 * ONE NAMESPACE ON PURPOSE. Every caption on this page resolves from `loans`, including the payroll cycle
 * and batch-status labels the applied-in-payroll table needs. Reaching into `payroll.transactions` and
 * `payroll.list` for those six strings would make this a multi-namespace file — the shape check C of
 * test/i18n-coverage.test.ts skips ENTIRELY — and this screen gains a dozen new static keys here.
 */

/** One cookie per screen — each collapses independently (the convention f3ae3245 set for Fixed). */
export const LOANS_PANEL_COOKIE = 'loans_panel';

export default async function LoansPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('loans');
  const raw = await searchParams;
  const sp: Record<string, string | undefined> = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, typeof value === 'string' ? value : undefined]));
  const { error, employmentId } = sp;
  const companies = await listCompanies(s, { includeArchived: true });
  const companyIds = companies.filter((c) => !c.archivedAt).map((c) => c.id);
  // The legacy picker included archived-company employments, although the loan book lists live companies.
  const pickerCompanyIds = companies.map((c) => c.id);
  // A selection is resolved independently of the bounded picker and its filters. An unknown or foreign
  // employment still means no selection, preserving the everyone-at-once history view.
  const selectedEmp = employmentId ? await getEmployeeOption(s, pickerCompanyIds, employmentId) : null;
  const selected = selectedEmp?.employmentId ?? null;
  const filterId = (value?: string) => !value ? '' : /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : '00000000-0000-0000-0000-000000000000';
  const picker = {
    query: (sp.pickerQ ?? '').trim().slice(0, 200),
    companyId: filterId(sp.pickerCompany), businessUnitId: filterId(sp.pickerBusinessUnit),
    departmentId: filterId(sp.pickerDepartment), status: sp.pickerStatus === 'ended' ? 'ended' : sp.pickerStatus === 'active' ? 'active' : '',
  };
  const [employeePage, facets, loanPage, appliedPage] = await Promise.all([
    listEmployeeOptionsPage(s, { companyIds: pickerCompanyIds, ...picker, status: picker.status === 'ended' ? 'terminated' : picker.status === 'active' ? 'active' : undefined, limit: 25, offset: 0 }),
    listEmployeeOptionFacets(s, pickerCompanyIds, picker.companyId || undefined),
    listLoansPage(s, { companyIds, employmentId: selected ?? undefined, query: sp.q, page: sp.page, size: sp.size, sort: sp.sort, dir: sp.dir }),
    listAppliedLoanRepaymentsPage(s, {
      companyIds, employmentId: selected ?? undefined, query: sp.aQ, page: sp.aPage, size: sp.aSize, sort: sp.aSort, dir: sp.aDir,
      cycleLabels: { regular: t('cycle.regular'), off_cycle: t('cycle.off_cycle'), bonus: t('cycle.bonus'), adjustment: t('cycle.adjustment') },
    }),
  ]);
  const applied = appliedPage.rows;
  const appliedList: AppliedInPayrollRow[] = applied.map((r) => ({
    id: r.id,
    payPeriod: r.payPeriod,
    cycleLabel: `${t(`cycle.${r.runType}`)}${r.runSeq > 1 ? ` #${r.runSeq}` : ''}`,
    employeeName: r.employeeName,
    employeeCode: r.employeeCode,
    company: r.company,
    amount: r.amount,
    statusLabel: t(`batchStatus.${r.batchStatus}`),
    createdOn: r.createdOn,
  }));

  // Resolved on the SERVER from the cookie so first paint is already correct; absent ⇒ expanded.
  const panelDefaultOpen = (await cookies()).get(LOANS_PANEL_COOKIE)?.value !== '0';
  // ALL employees, not just active ones: a terminated employee can still carry a settled or outstanding
  // loan, and a screen whose whole job is the historical record must be able to reach them. The Employee
  // Status filter in the panel is what narrows to the active ones.
  const panelEmployees: ScopeEmployee[] = employeePage.rows.map((e) => ({
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
    <div className={pageWideCls}>
      <PageHeader title={t('title')} description={t('subtitle')} />
      <ErrorBanner message={error} />

      <CollapsibleEmployeePanel
        defaultOpen={panelDefaultOpen}
        cookieKey={LOANS_PANEL_COOKIE}
        // 009c8a37 — the header row: who is selected, the ONE button, and the Hide/Show control last, on
        // one horizontal line. Copied from the Fixed Transaction call on purpose, and shared in spirit
        // with Zakat and TP1: same three facts, same place, same action, on every screen with this panel.
        // With nobody selected the row still draws, carrying the screen name and the control.
        title={t('title')}
        detailHeader={
          selectedEmp ? (
            <>
              <div className="min-w-0 flex-1">
                <EmployeeName
                  code={selectedEmp.employeeCode}
                  name={selectedEmp.name}
                  className="text-sm font-semibold text-foreground"
                />
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {selectedEmp.company} · {selectedEmp.department ?? '—'} · {selectedEmp.position ?? '—'}
                </p>
              </div>
              <Button asChild size="sm">
                <Link href={`/admin/loans/new?employmentId=${encodeURIComponent(selectedEmp.employmentId)}`}>
                  {t('addButton')}
                </Link>
              </Button>
            </>
          ) : undefined
        }
        panel={
          <Card className="p-4">
            <h2 className="text-sm font-semibold">{t('employee')}</h2>
            <div className="mt-3">
              <EmployeeScopePanel employees={panelEmployees} selectedId={selected} basePath="/admin/loans" serverResults={{ ...picker, ...facets, total: employeePage.total }} />
            </div>
          </Card>
        }
      >
        <div className="space-y-6">
          {/* No Add button with nobody selected, because a loan needs an employee — and no empty state
              either, because this is the only screen carrying the everyone-at-once view. The hint stays
              exactly where it was; only the identity + button moved up into the header row (009c8a37). */}
          {!selectedEmp && <p className="text-xs text-muted-foreground">{t('pickEmployeeHint')}</p>}

          <Card className="overflow-hidden">
            <SectionHeader title={t('loansTitle')} count={loanPage.state.total} />
            <LoanList loans={loanPage.rows} serverPage={{ state: loanPage.state, query: loanPage.query, sort: loanPage.sort, dir: loanPage.dir }} />
          </Card>

          <Card className="overflow-hidden">
            <SectionHeader title={t('appliedTitle')} count={appliedPage.state.total} />
            <p className="px-4 pt-2 text-xs text-muted-foreground">{t('appliedSubtitle')}</p>
            <AppliedInPayrollList
              rows={appliedList}
              serverPage={{ state: appliedPage.state, query: appliedPage.query, sort: appliedPage.sort, dir: appliedPage.dir }}
              emptyLabel={t('appliedEmpty')}
              paramNames={{ page: 'aPage', size: 'aSize' }}
            />
          </Card>
        </div>
      </CollapsibleEmployeePanel>
    </div>
  );
}
