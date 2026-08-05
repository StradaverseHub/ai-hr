import { cookies } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listEmployees } from '@/core/read';
import { listEmploymentPayComponents, listPayComponents, FIXED_TRANSACTION_CYCLES } from '@/core/pay-components';
import { Card, EmployeeName, ErrorBanner, PageHeader, SectionHeader } from '@/components/ui';
import { CollapsibleEmployeePanel } from '@/components/collapsible-employee-panel';
import { EmployeePicker, type PickerEmployee } from './employee-picker';
import { FixedToolbar } from './add-fixed-dialog';
import { FixedTxnList, type FixedTxnRow } from './fixed-list';
import { isModuleEnabledOrFalse } from '@/core/entitlements';

import { todayInKualaLumpur } from '@/lib/hr-date';

/**
 * Fixed Transaction (feedback b7fc8583, redesigned by f3ae3245) — recurring per-employee pay items.
 *
 * f3ae3245 REDESIGNED THE SURFACE AND CHANGED NO BUSINESS LOGIC. What moved:
 *  - The employee list was a wide card across the TOP; it is now a side panel, matching Individual
 *    Transaction, sharing the identical collapse control (components/collapsible-employee-panel.tsx,
 *    built once for both screens because NEITHER had one).
 *  - The item list had no search, no sorting and no paging. It has all three now, which matters most on
 *    this screen precisely because every edit ADDS a row (see the versioning note below).
 *  - Edit unfolded a form INSIDE the Action cell of the row you clicked. It is now a dedicated page,
 *    `fixed/[id]`, where the effective-dating warning can be stated properly rather than as one line
 *    squeezed beside a Save button.
 *
 * WHAT WAS DELIBERATELY NOT CHANGED, though "match Individual Transaction" could be read as asking for it:
 *  - ADD still opens a MODAL. That was an approved decision of its own (ee21508c: the always-on add form
 *    was replaced by a button so the LIST is the primary surface). Individual's Add is inline; matching it
 *    would silently reverse ee21508c, so it stays and the reversal is raised rather than assumed.
 *  - No Input / Input Type / Input Value / Calculated Amount columns. They do not exist for a recurring
 *    item — they are the one-off ledger's quantity/unit — and empty columns are worse than absent ones.
 *  - The Payroll Cycle field stays, though the request's sketch omitted it: it is mandatory on Add.
 *
 * The Payroll Cycle is captured + stored + shown but does NOT route which payroll run pays the item
 * (payout follows the valid_from/valid_to window). Unchanged by this redesign.
 */

/** One cookie per screen — Individual and Fixed collapse independently (49e7e0a2 / f3ae3245). */
export const FIXED_PANEL_COOKIE = 'txn_fixed_panel';

export default async function FixedTransactionPage({
  searchParams,
}: {
  searchParams: Promise<{ employmentId?: string; error?: string; toast?: string }>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('payroll.transactions');
  const { employmentId, error } = await searchParams;
  const typedComponentsOn = isModuleEnabledOrFalse(s, 'typed_pay_components');
  // Resolved on the SERVER from the cookie so first paint is already correct; absent ⇒ expanded.
  const panelDefaultOpen = (await cookies()).get(FIXED_PANEL_COOKIE)?.value !== '0';

  const employees = await listEmployees(s, scopeIds);
  // SCOPE-GUARD the param (mirror individual/page.tsx): the ?employmentId= must be in the admin's
  // scoped list. Company scope is an application concern (RLS only isolates tenants), so without this an
  // admin could cross-company read/write by URL tampering. An out-of-scope param is treated as no selection.
  const selected = employmentId && employees.some((e) => e.employmentId === employmentId) ? employmentId : null;
  const selectedEmp = selected ? (employees.find((e) => e.employmentId === selected) ?? null) : null;

  // Step-1 search/filter panel source (feedback ee21508c). Derive employment status ('active' when not
  // terminated, else 'ended') for the Status filter — matches the Individual Transaction convention.
  const pickerEmployees: PickerEmployee[] = employees.map((e) => ({
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

  const [components, existing] = selected
    ? await Promise.all([listPayComponents(s), listEmploymentPayComponents(s, selected)])
    : [[], []];
  const activeComponents = components.filter((c) => c.archivedAt == null);

  // ENDED is derived against the TENANT timezone, on the server. Deriving it in the browser would call an
  // item ended a day early or late for anyone whose device clock sits either side of MYT midnight.
  const today = todayInKualaLumpur();
  const rows: FixedTxnRow[] = existing.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    amount: r.amount,
    currency: r.currency ?? null,
    validFrom: r.validFrom,
    validTo: r.validTo,
    runType: r.runType,
    remarks: r.remarks,
    ended: r.validTo != null && r.validTo < today,
  }));
  // Pre-translated cycle labels: the list is a client component and these live in a DIFFERENT namespace
  // (`payroll.transactions.individual.cycle.*`), so resolving them there would make it a two-namespace
  // file — the shape i18n-coverage check C skips ENTIRELY, static keys included.
  const cycleLabels = Object.fromEntries(
    FIXED_TRANSACTION_CYCLES.map((c) => [c, t(`individual.cycle.${c}` as never)]),
  ) as Record<string, string>;

  // Friendly error keys thrown by the action → localised; anything else is a raw message.
  const errorKeys = new Set([
    'dateError',
    'currencyUnsupported',
    'amountError',
    'required',
    'outOfScope',
    'notFound',
    // f1123afd — removal refused because the item was paid on a processed payslip.
    'paidOnPayslip',
  ]);
  const errorMessage = error && errorKeys.has(error) ? t(`fixed.${error}`) : error;

  return (
    <div className="mx-auto max-w-[100rem] space-y-6">
      <PageHeader
        back={{ href: '/payroll/transactions', label: t('title') }}
        title={t('fixed.title')}
        description={t('fixed.subtitle')}
      />

      {!typedComponentsOn && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
          <p className="font-medium">{t('gatedTitle')}</p>
          <p className="mt-1 text-xs">{t('gatedBody')}</p>
        </div>
      )}

      <ErrorBanner message={errorMessage} />

      <CollapsibleEmployeePanel
        defaultOpen={panelDefaultOpen}
        cookieKey={FIXED_PANEL_COOKIE}
        hideLabel={t('fixed.hideEmployees')}
        showLabel={t('fixed.showEmployees')}
        collapsedTitle={t('fixed.pickEmployee')}
        panel={
          <Card className="p-4">
            <h2 className="text-sm font-medium">{t('fixed.pickEmployee')}</h2>
            {employees.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">{t('fixed.empty')}</p>
            ) : (
              <div className="mt-3">
                <EmployeePicker employees={pickerEmployees} selectedId={selected} />
              </div>
            )}
          </Card>
        }
      >
        {!selectedEmp && (
          <Card className="px-6 py-16 text-center">
            <p className="text-sm font-medium text-foreground">{t('fixed.pickEmployeeTitle')}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t('fixed.pickEmployeeBody')}</p>
          </Card>
        )}

        {selectedEmp && (
          <Card className="overflow-hidden">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
              <div className="min-w-0">
                <EmployeeName
                  code={selectedEmp.employeeCode}
                  name={selectedEmp.name}
                  className="text-sm font-semibold text-foreground"
                />
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {selectedEmp.company} · {selectedEmp.department ?? '—'} · {selectedEmp.position ?? '—'}
                </p>
              </div>
              <FixedToolbar
                employmentId={selected!}
                defaultStart={selectedEmp.hiredOn}
                components={activeComponents.map((c) => ({ id: c.id, code: c.code, name: c.name }))}
                cycles={FIXED_TRANSACTION_CYCLES}
              />
            </div>

            <SectionHeader title={t('fixed.title')} count={rows.length} />

            {/* A CHANGE ADDS A LINE — said here, and again in full on the item's own page. Editing a
                recurring item closes the current value from the chosen date and starts a new one, so the
                history stays intact and nobody is paid twice for the same period. A bigger screen makes
                the extra rows MORE visible, so saying nothing would have made the redesign harder to
                understand rather than easier. */}
            <p className="border-b border-border bg-muted/20 px-4 py-2 text-xs text-muted-foreground">
              {t('fixed.versioningNote')}
            </p>

            <FixedTxnList
              rows={rows}
              employmentId={selected!}
              cycleLabels={cycleLabels}
              cycleUnspecifiedLabel={t('fixed.cycleUnspecified')}
            />
          </Card>
        )}
      </CollapsibleEmployeePanel>
    </div>
  );
}
