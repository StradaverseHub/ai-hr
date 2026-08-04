import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listBatches } from '@/core/payroll';
import { listCompanies, listEmployees } from '@/core/read';
import { listPayComponents } from '@/core/pay-components';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { ErrorBanner, PageHeader } from '@/components/ui';
import { TxnWorkspace, type TxnBatch, type TxnEmployee } from './txn-workspace';
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
export default async function IndividualTransactionPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; toast?: string }>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('payroll.transactions');
  const { error } = await searchParams;
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
  const draftBatches = allBatches.filter((b) => b.status === 'draft');
  const payItems = payComponents.map((c) => ({ id: c.id, code: c.code, name: c.name, kind: c.kind }));

  // The Company pre-filter is view-only narrowing on the already access-fenced employee list, so scope the
  // dropdown to the same authorised set (scopeIds) that listEmployees was fenced to — never let the
  // dropdown widen the set. RLS already excludes archived companies here. The currency rides along so the
  // right panel labels its money by the COMPANY's currency rather than assuming ringgit (lib/money).
  const scopedCompanies = companies
    .filter((c) => scopeIds.includes(c.id))
    .map((c) => ({ id: c.id, name: c.name, currency: c.currency ?? null }));

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
  const txnBatches: TxnBatch[] = draftBatches.map((b) => ({
    id: b.id,
    companyId: b.companyId,
    payPeriod: b.payPeriod,
    runType: b.runType,
    runSeq: b.runSeq,
    scope: (b as { scope?: TxnBatch['scope'] }).scope ?? null,
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
    'componentRequired',
    'componentInvalid',
  ]);
  const errorMessage = error && errorKeys.has(error) ? t(`individual.${error}`) : error;

  return (
    <div className="mx-auto max-w-[100rem] space-y-6">
      <PageHeader
        back={{ href: '/payroll/transactions', label: t('title') }}
        title={t('individual.title')}
        description={t('individual.subtitle')}
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
        processHref="/payroll/process"
        requireComponent={individualTxnPayOn}
        // Resolved on the SERVER through the tenant timezone: a browser an hour either side of MYT
        // midnight would otherwise default a new transaction into the wrong month.
        currentPeriod={todayInKualaLumpur().slice(0, 7)}
      />
    </div>
  );
}
