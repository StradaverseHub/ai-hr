import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listBatches } from '@/core/payroll';
import { listCompanies, listEmployees } from '@/core/read';
import { listPayComponents } from '@/core/pay-components';
import { ErrorBanner, PageHeader } from '@/components/ui';
import { PayrollTabs } from '@/components/payroll-tabs';
import { TxnGrid, type WizardBatch, type WizardEmployee } from './txn-grid';
import { isModuleEnabled, settingEnabled } from '@/core/entitlements';

/**
 * 1.2.2 Individual Transaction — a guided four-step flow for one-off payroll items (feedback 65377ed0).
 * The whole page is the TxnGrid wizard: Step 1 search/filter + multi-select employees → Step 2 pick the
 * period + cycle (resolving or creating a draft batch, or a period-keyed target when no run exists yet) →
 * Step 3 an editable grid → Step 4 a review summary then one atomic Save.
 *
 * The old "Unattached Transactions" ledger that used to sit below the wizard has been removed from the
 * screen (the reporter found it confusing). Its STORAGE mechanism is untouched: entering rows for a month
 * that has no draft run yet still saves them period-keyed (nullable batch), and generatePayslips attaches
 * them automatically when the month's regular run is created — so early entry keeps working and nothing is
 * deleted. No calc / attach behaviour changed; this is purely the on-screen surface.
 */
export default async function IndividualTransactionPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; toast?: string }>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('payroll.transactions');
  const { error } = await searchParams;
  const typedComponentsOn = isModuleEnabled(s, 'typed_pay_components');
  // f1564110 Phase 3 — with the kernel consuming this ledger, a NEW payable (earning/deduction) row must
  // name a Payroll Item Master item (its statutory flags drive the treatment). The wizard hides the generic
  // earning/deduction options accordingly; the service re-enforces (ComponentRequiredError).
  const individualTxnPayOn = settingEnabled(s, 'payroll.individual_txn_pay_enabled');

  const [allBatches, employees, companies, payComponents] = await Promise.all([
    listBatches(s, scopeIds),
    listEmployees(s, scopeIds),
    listCompanies(s),
    listPayComponents(s), // Payroll Item Master — the wizard item picker is sourced from these active items.
  ]);
  const draftBatches = allBatches.filter((b) => b.status === 'draft');
  // Active payable earning/deduction items from the master (archived already excluded by listPayComponents).
  const wizardPayItems = payComponents.map((c) => ({ id: c.id, code: c.code, name: c.name, kind: c.kind }));

  // The wizard's Company pre-filter is view-only narrowing on the already access-fenced employee list, so
  // scope the dropdown to the same authorised set (scopeIds) that listEmployees was fenced to — never let
  // the dropdown widen the set. RLS already excludes archived companies here.
  const scopedCompanies = companies
    .filter((c) => scopeIds.includes(c.id))
    .map((c) => ({ id: c.id, name: c.name }));

  const wizardEmployees: WizardEmployee[] = employees.map((e) => ({
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
    // Derive employment status from termination (matches the View page convention) — the Step-1 status filter.
    status: e.terminatedOn == null ? 'active' : 'ended',
  }));
  const wizardBatches: WizardBatch[] = draftBatches.map((b) => ({
    id: b.id,
    companyId: b.companyId,
    payPeriod: b.payPeriod,
    runType: b.runType,
    runSeq: b.runSeq,
    scope: (b as { scope?: WizardBatch['scope'] }).scope ?? null,
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
    // f1564110 Phase 3 — component required/invalid on payable rows (kernel-consumed ledger).
    'componentRequired',
    'componentInvalid',
  ]);
  const errorMessage = error && errorKeys.has(error) ? t(`individual.${error}`) : error;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        back={{ href: '/payroll/transactions', label: t('title') }}
        title={t('individual.title')}
        description={t('individual.subtitle')}
      />
      <PayrollTabs active="transactions" />

      {!typedComponentsOn && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
          <p className="font-medium">{t('gatedTitle')}</p>
          <p className="mt-1 text-xs">{t('gatedBody')}</p>
        </div>
      )}

      <ErrorBanner message={errorMessage} />

      {/* The four-step wizard is the whole screen (the old unattached ledger was removed — see the file docstring). */}
      <TxnGrid
        employees={wizardEmployees}
        batches={wizardBatches}
        companies={scopedCompanies}
        payItems={wizardPayItems}
        processHref="/payroll/process"
        requireComponent={individualTxnPayOn}
      />
    </div>
  );
}
