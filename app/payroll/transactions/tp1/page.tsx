import Link from 'next/link';
import { cookies } from 'next/headers';
import { getLocale, getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listEmployees } from '@/core/read';
import { listTp1DeclarationsForPersonYear, listTp1YearsForPerson, type Tp1MonthDeclaration } from '@/core/tax-relief';
import { listAppliedTp1Deductions, type AppliedTp1ViewRow } from '@/core/payroll-view';
import {
  Button,
  Card,
  EmployeeName,
  ErrorBanner,
  PageHeader,
  SectionHeader,
  inputCls,
  pageWideCls,
} from '@/components/ui';
import {
  CollapsibleEmployeePanel,
  EmployeeScopePanel,
  type ScopeEmployee,
} from '@/components/collapsible-employee-panel';
import { adminDeleteTp1 } from '../deductions-actions';
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
 * 7ad37961 — THE LIST IS NOW PER DEDUCTION MONTH WITHIN A CHOSEN YEAR. The official LHDN TP1 (1/2026)
 * carries a DEDUCTION MONTH box, so an employee has up to twelve declarations in an assessment year, and
 * the old one-line-per-year list would have hidden eleven of them. The year moved into a SELECTOR, and it
 * lives in the URL (`?year=`) beside `employmentId` rather than in client state, for the same reason the
 * employee selection does: the scope narrowing must stay server-owned, because a value the browser owns
 * is a value the browser can change. The GET form below is the whole mechanism — no client island, no
 * router push. `year` was ALREADY an accepted param (the save actions redirect with it), so a shipped
 * redirect keeps working and now actually selects something.
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
    /** The selected assessment year. Server-owned (see the header); also written by
     *  `adminTp1FormAction`, which redirects back here after a successful save (r352). */
    year?: string;
    /** 27605faa rev 2 — the record a Delete confirmation is about, and whether deleted rows are shown. */
    confirmDelete?: string;
    showDeleted?: string;

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
  // The year the reader picked, validated HERE — a path/query value is untrusted input, and
  // core/tax-relief's own accepted range is 2000–2100, so a year this page offers can never be one the
  // read would refuse. Anything else falls back to the current assessment year rather than erroring.
  const rawYear = Number(sp.year);
  const selectedYear =
    Number.isInteger(rawYear) && rawYear >= 2000 && rawYear <= 2100 ? rawYear : currentYear;

  const [declaredYears, declarations, applied]: [number[], Tp1MonthDeclaration[], AppliedTp1ViewRow[]] =
    selectedEmp
      ? await Promise.all([
          listTp1YearsForPerson(s, { personId: selectedEmp.personId }),
          // 27605faa rev 2 — NO assessmentYear: the Transaction History is a history, and being made to
          // pick a year before any record appears is a filter masquerading as a precondition. The year
          // is a COLUMN in the list now. `selectedYear` still drives the Add flow and the applied-
          // deduction panel below, which genuinely are per-year.
          listTp1DeclarationsForPersonYear(s, { personId: selectedEmp.personId }),
          // Narrowed IN THE QUERY, over the same company fence the employee read uses — and it fails
          // closed on an empty set, so an admin who can see no company sees no rows.
          listAppliedTp1Deductions(s, { companyIds: scopeIds, employmentId: selectedEmp.employmentId }),
        ])
      : [[], [], []];

  // Every year the employee already has a record for, plus the current one — so the selector can never
  // offer a year with nothing behind it, and can never hide one that has something.
  const yearOptions = Array.from(new Set([currentYear, selectedYear, ...declaredYears])).sort((a, b) => b - a);

  // Month names come from Intl in the request's own locale, not from a message catalogue: twelve names in
  // six locales would be six copies of the calendar, and the catalogue check cannot tell a wrong one from
  // a right one. Resolved on the SERVER so the label the reader sees is the label the page rendered.
  const monthFmt = new Intl.DateTimeFormat(await getLocale(), { month: 'long' });
  const monthName = (m: number | null) =>
    m == null ? t('tp1.history.wholeYear') : monthFmt.format(new Date(Date.UTC(2000, m - 1, 1)));

  const monthHref = (year: number, month: number) =>
    `/payroll/transactions/tp1/${year}/${month}?employmentId=${encodeURIComponent(selectedEmploymentId ?? '')}`;
  /**
   * 27605faa rev 2 — a link BACK TO THIS SCREEN with some parameters changed and the rest kept.
   *
   * The url is this screen's state (employee, year, both pagers), so a Delete link or a Show-deleted
   * toggle must carry what is already there rather than resetting it — pressing Delete on page three of
   * the history and landing back on page one is the kind of small wrong that makes a screen feel broken.
   */
  const listHref = (over: Record<string, string | undefined>) => {
    const qp = new URLSearchParams();
    if (selectedEmploymentId) qp.set('employmentId', selectedEmploymentId);
    qp.set('year', String(selectedYear));
    for (const k of ['dPage', 'dSize', 'aPage', 'aSize', 'showDeleted'] as const) {
      const v = sp[k as keyof typeof sp];
      if (typeof v === 'string' && v !== '') qp.set(k, v);
    }
    for (const [k, v] of Object.entries(over)) {
      if (v == null || v === '') qp.delete(k);
      else qp.set(k, v);
    }
    return `/payroll/transactions/tp1?${qp.toString()}`;
  };
  const declarationRows: Tp1DeclarationListRow[] = declarations.map((d) => ({
    id: d.id,
    assessmentYear: d.assessmentYear,
    deductionMonth: d.deductionMonth,
    monthLabel: monthName(d.deductionMonth),
    amount: d.tp1Amount.toFixed(2),
    status: d.status,
    versions: d.versions,
    // "Last saved": a submitted row is stamped at submit; a draft has only its created_at, because
    // tp1_relief has no updated_at and a draft is UPDATEd in place (core/tax-relief.ts records this).
    // Formatted HERE, in the tenant timezone — a client-side format would be a day out for anyone whose
    // device clock sits the other side of MYT midnight.
    lastSaved: myt(d.submittedAt ?? d.createdAt),
    // A month-less legacy declaration opens on the month page for January so it stays reachable and
    // printable; its own stored month stays NULL, because opening a record is not editing it.
    href: monthHref(d.assessmentYear, d.deductionMonth ?? 1),
    // A past assessment year opens read-only, exactly as it did on the old screen.
    readOnly: d.assessmentYear < currentYear,
    /**
     * 27605faa rev 2 — Delete goes to a CONFIRMATION on this same screen, carrying the id and the
     * status. The status rides the url because the action routes on it (draft ⇒ discard, submitted or
     * approved ⇒ cancel), and it is re-read from the ROW server-side before anything is written — a url
     * value decides which button is drawn, never which service runs.
     *
     * NULL for a rejected row: both services refuse one, and offering an action that can only end in a
     * refusal is worse than not offering it.
     */
    deleteHref:
      d.status === 'rejected'
        ? null
        : listHref({ confirmDelete: d.id }),
  }));
  /**
   * 27605faa rev 2 — A DELETED RECORD LEAVES THE LIST, which is what the reporter means by "deleted".
   *
   * The ROW is kept — tp1_relief is a tax record and `cancelTp1ForPerson` writes a status rather than
   * removing anything — so the honest reading of "removed from the transaction history" is that it stops
   * appearing HERE, with a way to look. `showDeleted` is that way, and it is a url flag rather than
   * client state so the choice survives a refresh and can be linked.
   */
  const showDeleted = sp.showDeleted === '1';
  const visibleDeclarationRows = showDeleted
    ? declarationRows
    : declarationRows.filter((r) => r.status !== 'cancelled');
  const deletedCount = declarationRows.length - declarationRows.filter((r) => r.status !== 'cancelled').length;
  /** The record the confirmation is about, re-resolved from the ROWS rather than trusted from the url. */
  const pendingDelete = sp.confirmDelete
    ? declarationRows.find((r) => r.id === sp.confirmDelete && r.status !== 'rejected') ?? null
    : null;
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


  return (
    <div className={pageWideCls}>
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
              {/* 27605faa rev 2 — Add opens its OWN step, which asks for the year and the month. r324
                  put that control here, beside the button, on the VIEWING screen; the reporter's point
                  was that those fields belong where a record is created. The step then redirects to the
                  declaration form, so there is still exactly one place a declaration is written. */}
              <Button asChild size="sm">
                <Link
                  href={`/payroll/transactions/tp1/new?employmentId=${encodeURIComponent(
                    selectedEmploymentId ?? '',
                  )}&year=${selectedYear}`}
                >
                  {t('tp1.addButton')}
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
            {/* ── Year selector — a plain GET form, so the selection lives in the URL and the server
                   owns it. `employmentId` rides along as a hidden field or the choice would drop the
                   employee on the way back. ── */}
            <Card className="p-4">
              <form method="GET" className="flex flex-wrap items-end gap-3">
                <input type="hidden" name="employmentId" value={selectedEmp.employmentId} />
                <label className="block text-sm">
                  <span className="mb-1 block font-medium">{t('tp1.yearLabel')}</span>
                  <select name="year" defaultValue={String(selectedYear)} className={inputCls}>
                    {yearOptions.map((y) => (
                      <option key={y} value={y}>
                        {y}
                      </option>
                    ))}
                  </select>
                </label>
                <Button type="submit" variant="secondary">
                  {t('tp1.viewYear')}
                </Button>
              </form>
            </Card>

            {/* ── The year's declarations — ONE ROW PER DEDUCTION MONTH, never a version chain ── */}
            <Card className="overflow-hidden">
              <SectionHeader title={t('tp1.history.title')} count={declarationRows.length} />
              <p className="px-4 pt-2 text-xs text-muted-foreground">{t('tp1.history.subtitle')}</p>
              {/**
                * 27605faa rev 2 — THE CONFIRMATION, server-rendered above the list it is about.
                *
                * A form on the SERVER rather than a dialog in the client island: the island cannot be
                * handed a server action as a prop (r123 — a 500 on every request with tsc, the suite and
                * next build all green), and this also works with JavaScript off. The status rides a
                * hidden field so the action can route draft-vs-declared, and it is re-read from the row
                * server-side before anything is written.
                */}
              {pendingDelete && (
                <div className="mx-4 mt-4 rounded-xl border border-destructive/30 bg-destructive/5 p-4">
                  <p className="text-sm font-semibold">{t('tp1.history.deleteConfirmTitle')}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {pendingDelete.assessmentYear} · {pendingDelete.monthLabel} · RM {pendingDelete.amount}
                  </p>
                  <p className="mt-2 text-xs text-muted-foreground">{t('tp1.history.deleteConfirmBody')}</p>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <form action={adminDeleteTp1}>
                      <input type="hidden" name="employmentId" value={selectedEmploymentId ?? ''} />
                      <input type="hidden" name="tp1ReliefId" value={pendingDelete.id} />
                      <input type="hidden" name="assessmentYear" value={pendingDelete.assessmentYear} />
                      <input type="hidden" name="status" value={pendingDelete.status} />
                      <Button type="submit" variant="destructive" size="sm">
                        {t('tp1.history.deleteConfirm')}
                      </Button>
                    </form>
                    <Button asChild variant="outline" size="sm">
                      <Link href={listHref({ confirmDelete: undefined })}>{t('tp1.history.deleteCancel')}</Link>
                    </Button>
                  </div>
                </div>
              )}
              <Tp1DeclarationsList rows={visibleDeclarationRows} />
              {/* 27605faa rev 2 — the way back to a deleted record. Only offered when there IS one, so
                  the control never advertises a state the employee's history does not have. */}
              {(deletedCount > 0 || showDeleted) && (
                <div className="border-t border-border px-4 py-2 text-xs">
                  <Link href={listHref({ showDeleted: showDeleted ? undefined : '1' })} className="font-medium text-primary hover:underline">
                    {showDeleted
                      ? t('tp1.history.hideDeleted')
                      : t('tp1.history.showDeleted', { count: deletedCount })}
                  </Link>
                </div>
              )}
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
