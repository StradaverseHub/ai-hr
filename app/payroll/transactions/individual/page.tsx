import { cookies } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listBatches } from '@/core/payroll';
import { listCompanies, listEmployees } from '@/core/read';
import { listPayComponents } from '@/core/pay-components';
import { listPayrollCycles } from '@/core/payroll-cycle';
import { payRuleAllowsDayByDay, payRuleDerivesAmount, payRuleInputUnit, type PayRule } from '@/core/pay-rule';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { ErrorBanner, PageHeader } from '@/components/ui';
import { TxnWorkspace, type TxnBatch, type TxnEmployee, type TxnPayrollCycle } from './txn-workspace';
import { TxnImportButtons } from '../import-excel/txn-import-dialog';
import { buildTxnTemplateReference } from '../import-excel/reference';
import { isModuleEnabledOrFalse, settingEnabledOrDefault } from '@/core/entitlements';

/**
 * 1.2.2 Individual Transaction — one two-panel workspace for one-off payroll items (feedback 44129979,
 * replacing 65377ed0's four-step wizard).
 *
 * Employees on the left; the selected employee's existing one-off transactions, itemised, on the right,
 * with Create / Edit / Delete / Duplicate in place. The transactions themselves are NOT loaded here: they
 * are fetched per employee, on demand, by a server action (fetchEmployeeTxnPanelAction) — this page loads
 * only what the left panel and the entry form need.
 *
 * STORAGE AND PAYROLL BEHAVIOUR ARE UNCHANGED by the redesign. Entering rows for a month that has no
 * draft run still saves them period-keyed (nullable batch), and generatePayslips attaches them when the
 * month's regular run is created — so early entry keeps working and nothing is deleted or recalculated.
 * This is purely the on-screen surface.
 */
/** One cookie per screen — Individual and Fixed collapse independently (49e7e0a2 / f3ae3245). */
export const INDIVIDUAL_PANEL_COOKIE = 'txn_individual_panel';

export default async function IndividualTransactionPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; toast?: string }>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('payroll.transactions');
  const { error } = await searchParams;
  // 49e7e0a2 — the employee panel's collapsed/expanded choice, resolved on the SERVER from the cookie so
  // first paint is already correct (the same pattern collapsible-card-section documents). Absent cookie ⇒
  // expanded, which is exactly today's layout for anyone who never touches the control.
  const panelDefaultOpen = (await cookies()).get(INDIVIDUAL_PANEL_COOKIE)?.value !== '0';
  const typedComponentsOn = isModuleEnabledOrFalse(s, 'typed_pay_components');
  // f1564110 Phase 3 — with the kernel consuming this ledger, a NEW payable (earning/deduction) row must
  // name a Payroll Item Master item (its statutory flags drive the treatment). The form hides the generic
  // earning/deduction options accordingly; the service re-enforces (ComponentRequiredError).
  const individualTxnPayOn = settingEnabledOrDefault(s, 'payroll.individual_txn_pay_enabled');

  const [allBatches, employees, companies, payComponents] = await Promise.all([
    listBatches(s, scopeIds),
    listEmployees(s, scopeIds),
    listCompanies(s),
    listPayComponents(s), // Payroll Item Master — the form's item picker is sourced from these active items.
  ]);
  // 49e7e0a2 — the form used to be handed DRAFT runs only, which is why a processed run could not even be
  // named as a target. Both writable statuses are offered now; `closed` is not, because the service
  // refuses it and the 0011 database triggers refuse it underneath, so listing one would only produce a
  // save that always fails. The status rides along so the form can warn before it lands on a processed run.
  const writableBatches = allBatches.filter((b) => b.status === 'draft' || b.status === 'processed');
  // 2da9937a — the two things the entry form needs to know about a pay item's rule, resolved on the SERVER
  // with the same pure predicates the write path uses. The rule VALUE never crosses to the client: the
  // form's questions are only "is the Amount box mine to fill?" and "which quantity does it want?", and
  // answering them here is what stops the screen and the service disagreeing about which items calculate.
  const payItems = payComponents.map((c) => ({
    id: c.id,
    code: c.code,
    name: c.name,
    kind: c.kind,
    derives: payRuleDerivesAmount(c.rule as PayRule | null),
    inputUnit: payRuleInputUnit(c.rule as PayRule | null),
    // c11e81aa — the THIRD question, and the same discipline: whether a day can be worth something
    // different from the day beside it is a fact about the item's rule, so it is answered here rather
    // than guessed from `derives` and `inputUnit` on the screen (which cannot tell a `fixed` monthly
    // allowance apart from an item with no rule at all — both read false/null, and only one of them
    // may be keyed day by day).
    variesByDay: payRuleAllowsDayByDay(c.rule as PayRule | null),
  }));

  // The Company pre-filter is view-only narrowing on the already access-fenced employee list, so scope the
  // dropdown to the same authorised set (scopeIds) that listEmployees was fenced to — never let the
  // dropdown widen the set. RLS already excludes archived companies here. The currency rides along so the
  // right panel labels its money by the COMPANY's currency rather than assuming ringgit (lib/money).
  const scopedCompanies = companies
    .filter((c) => scopeIds.includes(c.id))
    .map((c) => ({ id: c.id, name: c.name, currency: c.currency ?? null }));

  /**
   * c11e81aa — THE CONFIGURED PAY CYCLES (Payroll → Settings → Payroll Cycles), per company.
   *
   * The entry form's "Pay cycle" field used to list the payroll RUNS that already existed for the month
   * and print "Awaiting payroll run" when there were none, so an entry keyed ahead of a run could name no
   * cycle at all. These are the catalogue rows it names instead — ACTIVE ones only, because an archived
   * cycle will never have a run opened for it and offering one would be offering a dead end.
   *
   * Read here, on the server, per company the admin is scoped to, and by the SAME `listPayrollCycles` the
   * process wizard and the payroll-readiness check use — one catalogue, not a second view of it. RLS
   * fences the tenant; `scopedCompanies` is the already-authorised set, so this cannot widen it.
   */
  const cyclesByCompany = await Promise.all(
    scopedCompanies.map(async (c) => ({ companyId: c.id, cycles: await listPayrollCycles(s, c.id, { activeOnly: true }) })),
  );
  const payrollCycles: TxnPayrollCycle[] = cyclesByCompany.flatMap(({ companyId, cycles }) =>
    cycles.map((c) => ({ id: c.id, companyId, name: c.name, runType: c.runType })),
  );

  const txnEmployees: TxnEmployee[] = employees.map((e) => ({
    employmentId: e.employmentId,
    name: e.name,
    employeeCode: e.employeeCode,
    department: e.department,
    departmentId: e.departmentId,
    businessUnit: e.businessUnit,
    businessUnitId: e.businessUnitId,
    position: e.position,
    company: e.company,
    companyId: e.companyId,
    // Derive employment status from termination (matches the View page convention) — the status filter.
    status: e.terminatedOn == null ? 'active' : 'ended',
  }));
  const txnBatches: TxnBatch[] = writableBatches.map((b) => ({
    id: b.id,
    companyId: b.companyId,
    payPeriod: b.payPeriod,
    runType: b.runType,
    runSeq: b.runSeq,
    scope: (b as { scope?: TxnBatch['scope'] }).scope ?? null,
    status: b.status === 'processed' ? 'processed' : 'draft',
    // 510f4bd1 — the recalculation mark, serialised. `needsRecalcAt` is a Date on the row; the workspace is
    // a client component and only ever asks "is it set?", so it crosses as an ISO string rather than as a
    // Date that would be re-parsed in the browser's timezone.
    needsRecalcAt: b.needsRecalcAt ? b.needsRecalcAt.toISOString() : null,
    recalcEmploymentIds: Array.isArray(b.recalcEmploymentIds)
      ? b.recalcEmploymentIds.filter((x): x is string => typeof x === 'string')
      : null,
  }));

  const errorKeys = new Set([
    'unsupportedComponent',
    'dateOutOfPeriod',
    'notDraft',
    'amountNotPositive',
    'companyMismatch',
    'employeeNotInScope',
    'rowIncomplete',
    'duplicateRow',
    'periodInvalid',
    // `notDraft` (above) is BatchNotDraftError. 49e7e0a2 did not add a key for it: the throw is unchanged,
    // only the set of states it fires on narrowed to `closed`, so the COPY behind the existing key was
    // rewritten to say that instead of "no longer a draft".
    'componentRequired',
    'componentInvalid',
  ]);
  const errorMessage = error && errorKeys.has(error) ? t(`individual.${error}`) : error;

  // 5c65367d — the Excel import's reference sheets, read from the same catalogues the validator resolves
  // against. Built here rather than inside the template builder because that module is client-safe and a
  // `db/` import in it would drag the data layer into the browser bundle.
  const importReference = await buildTxnTemplateReference(s, scopeIds);

  return (
    <div className="mx-auto max-w-[100rem] space-y-6">
      <PageHeader
        back={{ href: '/payroll/transactions', label: t('title') }}
        title={t('individual.title')}
        description={t('individual.subtitle')}
        // 5c65367d — Import Excel + Download Template, the same pair as Fixed Transaction and the same
        // component. In the page header rather than beside Add, because Add belongs to ONE selected
        // employee and an import does not.
        actions={<TxnImportButtons kind="individual" reference={importReference} />}
      />

      {!typedComponentsOn && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
          <p className="font-medium">{t('gatedTitle')}</p>
          <p className="mt-1 text-xs">{t('gatedBody')}</p>
        </div>
      )}

      <ErrorBanner message={errorMessage} />

      <TxnWorkspace
        employees={txnEmployees}
        batches={txnBatches}
        companies={scopedCompanies}
        payItems={payItems}
        payrollCycles={payrollCycles}
        processHref="/payroll/process"
        requireComponent={individualTxnPayOn}
        panelDefaultOpen={panelDefaultOpen}
        panelCookieKey={INDIVIDUAL_PANEL_COOKIE}
        // Resolved on the SERVER through the tenant timezone: a browser an hour either side of MYT
        // midnight would otherwise default a new transaction into the wrong month.
        currentPeriod={todayInKualaLumpur().slice(0, 7)}
      />
    </div>
  );
}
