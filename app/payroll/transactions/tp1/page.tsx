import Link from 'next/link';
import { cookies } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listEmployees } from '@/core/read';
import { listTp1DeclarationsForPerson, type Tp1DeclarationSummary } from '@/core/tax-relief';
import { listAppliedTp1Deductions, type AppliedTp1ViewRow } from '@/core/payroll-view';
import { Button, Card, EmployeeName, ErrorBanner, PageHeader, SectionHeader } from '@/components/ui';
import {
  CollapsibleEmployeePanel,
  EmployeeScopePanel,
  type ScopeEmployee,
} from '@/components/collapsible-employee-panel';
import { AppliedInPayrollList, type AppliedInPayrollRow } from '@/components/applied-in-payroll-list';
import { Tp1DeclarationsList, type Tp1DeclarationListRow } from '@/components/tp1-declarations-list';
import { timeInKualaLumpur, todayInKualaLumpur } from '@/lib/hr-date';

/**
 * HR Payroll — TP1 Relief (Standardize-TP1 item 0cde61f3; redesigned by 3e3d3fb2).
 *
 * WHAT THIS SCREEN IS. HR maintains the employee's ACTUAL LHDN TP1 declaration — the SAME single
 * tp1_relief master row the employee edits on My Profile › Pay › Personal Tax Relief. There is exactly one
 * declaration per employee per assessment year: what HR sees is what the employee sees, and either side's
 * save is immediately the current truth for both (no duplicate store). None of that changes here.
 *
 * WHAT 3e3d3fb2 CHANGED, AND WHY. The reporter asked for one thing: that TP1 Relief stop being the odd one
 * out. It was a narrow single column with a server-side search box, no employee panel, no filters, nothing
 * that collapsed — and picking somebody made the search vanish and dropped you straight into their
 * declaration FORM, with no list of what had been declared and for which years. It is now built the way
 * Fixed Transaction, Zakat and Loans are: choose a person, read their record, press Add or View / Edit when
 * you actually want to change something. The form moved to its own page (`tp1/[year]`).
 *
 * THE TRADE IN THE PANEL IS DELIBERATE. This screen used to search SERVER-SIDE with paging
 * (listEmployeesPage); the shared panel filters CLIENT-SIDE over the already access-fenced scoped set, at
 * a cap of 25 shown. That is what the other five screens do, it is what the reporter asked for by asking
 * for consistency, and production carries 31 employees. If that set ever grows to where the cap bites, the
 * fix belongs in components/collapsible-employee-panel.tsx for all six screens at once — not here.
 *
 * WITH NOBODY SELECTED THERE IS NO EVERYONE-AT-ONCE VIEW, and this differs from Zakat and Loans on
 * purpose: this screen has never had one (its old no-selection state was a bare search prompt), so there
 * is none to keep. Selection here GATES the two lists rather than narrowing them, and the empty state says
 * so instead of showing every employee's tax declarations to anyone who opens the page.
 *
 * WHAT REVISION 1 OF THE PLAN GOT WRONG, RECORDED SO IT IS NOT RE-FIXED. It called the `?employmentId=`
 * handling a SECURITY GAP. It is not, and test/tp1-scope-guard.test.ts is the evidence: employment's RLS is
 *     tenant_id = current_tenant AND (can_see_employment(id) OR can_admin_payroll_for(company_id) OR …)
 * and both helpers route through app.is_admin_for(), so a cross-company read fails closed at the database —
 * measured three ways, including the administrative-manager branch the plan predicted would leak. The
 * `employees.some(...)` narrowing below is DEFENCE IN DEPTH: it makes the reachable set and the visible set
 * the same thing, which is the property the sibling screens have. Nothing was ever exposed.
 *
 * RSC BOUNDARY: this is a server component driving GET navigation, and the panel plus the two list tables
 * are the only client islands. Selection stays in the URL — lifting it into a client wrapper would move the
 * scope narrowing to where a user can edit it. Every prop crossing into an island is plain data (the View /
 * Edit destination is a STRING this file builds): r123's 500 was a function prop crossing this exact
 * boundary while tsc, the suite and `next build` all stayed green.
 *
 * ONE NAMESPACE ON PURPOSE. Every caption here resolves from `payroll.transactions`, the payroll-cycle and
 * batch-status labels for the applied-in-payroll table included. Reaching into `payroll.list` for those two
 * would make this a multi-namespace file — the shape check C of test/i18n-coverage.test.ts skips ENTIRELY —
 * and this screen gains a dozen new static keys here. (The same reasoning app/admin/loans/page.tsx records.)
 */

/** One cookie per screen — each collapses independently (the convention f3ae3245 set for Fixed). */
export const TP1_PANEL_COOKIE = 'txn_tp1_panel';

export default async function Tp1DeclarationPage({
  searchParams,
}: {
  searchParams: Promise<{
    employmentId?: string;
    error?: string;
    toast?: string;
    /** Written by adminSaveTp1Draft / adminSubmitTp1, which redirect back here after a save. Those actions
     *  are UNCHANGED by this redesign, so the param still arrives; the year now lives in the list rather
     *  than in a selector, so it is accepted and ignored rather than removed from a shipped redirect. */
    year?: string;
    // Two independently paged listings sit below the header, so each carries its own page/size pair.
    dPage?: string;
    dSize?: string;
    aPage?: string;
    aSize?: string;
  }>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('payroll.transactions');
  const sp = await searchParams;
  const { employmentId, error } = sp;

  // ── Selection ──────────────────────────────────────────────────────────────
  // NARROW THE SELECTION TO THE ADMIN'S OWN COMPANY SCOPE, the way every sibling transaction screen does
  // (fixed/page.tsx and zakat/page.tsx both run employees.some(...) before trusting the id). See the
  // header comment for what this is and is not — the database already fails closed; this makes the
  // reachable set and the visible set the same. The selected row is taken from THIS list rather than
  // re-read through employmentSubject: one read, and the row that passed the guard is the row rendered.
  const employees = await listEmployees(s, scopeIds);
  const selectedEmp =
    (employmentId ? employees.find((e) => e.employmentId === employmentId) : undefined) ?? null;
  const selectedEmploymentId = selectedEmp?.employmentId ?? null;

  // Resolved on the SERVER from the cookie so first paint is already correct; absent ⇒ expanded.
  const panelDefaultOpen = (await cookies()).get(TP1_PANEL_COOKIE)?.value !== '0';
  // ALL scoped employees, terminated included — and the guard above accepts exactly this set, so the panel
  // can never offer a row the server would then refuse. A leaver still has declared assessment years and an
  // EA form to answer for; the panel's Employee Status filter is what narrows to the active ones.
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

  // ── The selected employee's two lists (nothing is read for nobody) ─────────
  // The assessment year is a MYT calendar fact: between 00:00 and 08:00 MYT on 1 January, a host-clock
  // year is still last year's (lib/hr-date.ts).
  const currentYear = Number(todayInKualaLumpur().slice(0, 4));
  const [declarations, applied]: [Tp1DeclarationSummary[], AppliedTp1ViewRow[]] = selectedEmp
    ? await Promise.all([
        listTp1DeclarationsForPerson(s, { personId: selectedEmp.personId }),
        // Narrowed IN THE QUERY, over the same company fence the employee read uses — and it fails closed
        // on an empty set, so an admin who can see no company sees no rows.
        listAppliedTp1Deductions(s, { companyIds: scopeIds, employmentId: selectedEmp.employmentId }),
      ])
    : [[], []];

  const declarationHref = (year: number) =>
    `/payroll/transactions/tp1/${year}?employmentId=${encodeURIComponent(selectedEmploymentId ?? '')}`;
  const declarationRows: Tp1DeclarationListRow[] = declarations.map((d) => ({
    id: d.id,
    assessmentYear: d.assessmentYear,
    amount: d.tp1Amount.toFixed(2),
    status: d.status,
    versions: d.versions,
    // "Last saved": a submitted row is stamped at submit; a draft has only its created_at, because
    // tp1_relief has no updated_at and a draft is UPDATEd in place (core/tax-relief.ts records this).
    // Formatted HERE, in the tenant timezone — a client-side format would be a day out for anyone whose
    // device clock sits the other side of MYT midnight.
    lastSaved: myt(d.submittedAt ?? d.createdAt),
    href: declarationHref(d.assessmentYear),
    // A past assessment year opens read-only, exactly as it did on the old screen.
    readOnly: d.assessmentYear < currentYear,
  }));
  // Cycle and batch-status labels are resolved HERE (the shared table takes them pre-translated) — see the
  // one-namespace note in the header.
  const appliedRows: AppliedInPayrollRow[] = applied.map((r) => ({
    id: r.id,
    payPeriod: r.payPeriod,
    cycleLabel: `${t(`tp1.cycle.${r.runType}`)}${r.runSeq > 1 ? ` #${r.runSeq}` : ''}`,
    employeeName: r.employeeName,
    employeeCode: r.employeeCode,
    company: r.company,
    amount: r.amount,
    statusLabel: t(`tp1.batchStatus.${r.batchStatus}`),
    createdOn: r.createdOn,
  }));

  // Add vs Edit, decided by the SAME list the reader is looking at, so the button and the rows under it
  // can never disagree about whether this year has been declared. Add opens the CURRENT assessment year:
  // that is the only year the old screen could start either (its selector offered declared years + this
  // one), so nothing became unreachable — and a year already declared is an Edit, not a second Add.
  const currentDeclared = declarations.some((d) => d.assessmentYear === currentYear);

  return (
    <div className="mx-auto max-w-[100rem] space-y-6">
      <PageHeader
        back={{ href: '/payroll/transactions', label: t('title') }}
        title={t('tp1.title')}
        description={t('tp1.subtitle')}
      />

      <ErrorBanner message={error} />

      <CollapsibleEmployeePanel
        defaultOpen={panelDefaultOpen}
        cookieKey={TP1_PANEL_COOKIE}
        // 009c8a37 — the header row: who is selected, the ONE button that opens the declaration, and the
        // Hide/Show control last, on one horizontal line. Same shape as Fixed / Individual / Zakat / Loans.
        title={t('tp1.title')}
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
                <Link href={declarationHref(currentYear)}>
                  {currentDeclared
                    ? t('tp1.editButton', { year: String(currentYear) })
                    : t('tp1.addButton', { year: String(currentYear) })}
                </Link>
              </Button>
            </>
          ) : undefined
        }
        panel={
          /* ── The searchable employee panel (shared with Fixed / Individual / Zakat / Loans / Payslip) ── */
          <Card className="p-4">
            <h2 className="text-sm font-semibold">{t('tp1.pickEmployee')}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{t('tp1.subtitle')}</p>
            {employees.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">{t('tp1.noEmployees')}</p>
            ) : (
              <div className="mt-3">
                <EmployeeScopePanel
                  employees={panelEmployees}
                  selectedId={selectedEmploymentId}
                  basePath="/payroll/transactions/tp1"
                />
              </div>
            )}
          </Card>
        }
      >
        {selectedEmp ? (
          <div className="space-y-6">
            {/* ── Transaction history — ONE ROW PER ASSESSMENT YEAR, never a version chain ── */}
            <Card className="overflow-hidden">
              <SectionHeader title={t('tp1.history.title')} count={declarationRows.length} />
              <p className="px-4 pt-2 text-xs text-muted-foreground">{t('tp1.history.subtitle')}</p>
              <Tp1DeclarationsList rows={declarationRows} />
            </Card>

            {/* ── Applied in payroll — the TP1 figure each processed run actually carried ── */}
            <Card className="overflow-hidden">
              <SectionHeader title={t('tp1.applied.title')} count={appliedRows.length} />
              <p className="px-4 pt-2 text-xs text-muted-foreground">{t('tp1.applied.subtitle')}</p>
              <AppliedInPayrollList
                rows={appliedRows}
                emptyLabel={t('tp1.applied.empty')}
                paramNames={{ page: 'aPage', size: 'aSize' }}
              />
            </Card>
          </div>
        ) : (
          /* No selection is the screen's OPENING state, not an error: unlike Zakat and Loans there has
             never been an everyone-at-once view here to fall back to. Say what picking somebody does. */
          <Card className="px-4 py-10 text-center">
            <p className="text-sm text-muted-foreground">{t('tp1.pickEmployeeHint')}</p>
          </Card>
        )}
      </CollapsibleEmployeePanel>
    </div>
  );
}

/** An instant as 'YYYY-MM-DD HH:MM' in the tenant's calendar (never the host's, never UTC). */
function myt(at: Date): string {
  return `${todayInKualaLumpur(at)} ${timeInKualaLumpur(at)}`;
}
