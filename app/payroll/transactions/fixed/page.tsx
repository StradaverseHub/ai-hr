import Link from 'next/link';
import { cookies } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listEmployees } from '@/core/read';
import { listEmploymentPayComponents, listPayComponents, FIXED_TRANSACTION_CYCLES } from '@/core/pay-components';
import { listPayrollCycles } from '@/core/payroll-cycle';
import { Card, EmployeeName, ErrorBanner, PageHeader, SectionHeader, pageWideCls } from '@/components/ui';
import { CollapsibleEmployeePanel } from '@/components/collapsible-employee-panel';
import { EmployeePicker, type PickerEmployee } from './employee-picker';
import { FixedToolbar } from './add-fixed-dialog';
import { TxnImportButtons } from '../import-excel/txn-import-dialog';
import { queueFixedTransactionImportAction } from '../import-excel/fixed-actions';
import { FIXED_TXN_IMPORT_LOG } from '@/lib/fixed-transaction-import-log';
import { buildTxnTemplateReference } from '../import-excel/reference';
import { FixedTxnList, type FixedTxnRow } from './fixed-list';
import type { EditFixedDialogLabels } from './edit-fixed-dialog';
import { FIXED_ERROR_KEYS, fixedErrorValues, fixedEditCycleOptions } from './edit-model';
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
 *  - Edit unfolded a form INSIDE the Action cell of the row you clicked. It became a dedicated page,
 *    `fixed/[id]`, where the effective-dating warning could be stated properly rather than as one line
 *    squeezed beside a Save button. cc8bd87f then made it a POP-UP over this list (edit-fixed-dialog.tsx)
 *    with the same room, one End Date (Last Date to Pay) field in place of the separate Stop box, and
 *    `fixed/[id]` reduced to a redirect here with `?edit=<id>`.
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
 *
 * 4fffe638 — the Add dialog's Payroll Cycle list is the employee's OWN company's ACTIVE configured cycles
 * (Payroll > Settings > Payroll Cycles, in that screen's order), and the choice links the row to that
 * exact cycle. Still display and record only: the kernel reads neither the link nor the run type.
 */

/** One cookie per screen — Individual and Fixed collapse independently (49e7e0a2 / f3ae3245). */
export const FIXED_PANEL_COOKIE = 'txn_fixed_panel';

export default async function FixedTransactionPage({
  searchParams,
}: {
  searchParams: Promise<{
    employmentId?: string;
    error?: string;
    toast?: string;
    // 2aed39d4 — the clashing record's identity, carried beside the error key so the banner can name it.
    clashCode?: string;
    clashFrom?: string;
    clashTo?: string;
    clashPeriod?: string;
    // a3d485f6 — the first-of-month the mid-month refusal offers instead.
    nextFirst?: string;
    // cc8bd87f — the latest end date the same-month refusal offers instead.
    latestEnd?: string;
    // cc8bd87f — open the View / Edit pop-up on this row (an old link to fixed/[id], or a refused removal).
    edit?: string;
  }>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('payroll.transactions');
  const tImport = await getTranslations('payroll.individualImport');
  const { employmentId, error, clashCode, clashFrom, clashTo, clashPeriod, nextFirst, latestEnd, edit } = await searchParams;
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

  const [components, existing, cycles] = selectedEmp
    ? await Promise.all([
        listPayComponents(s, { readyOnly: true, companyId: selectedEmp.companyId }),
        listEmploymentPayComponents(s, selectedEmp.employmentId),
        listPayrollCycles(s, selectedEmp.companyId, { activeOnly: true }),
      ])
    : [[], [], []];
  const activeComponents = components.filter((c) => c.archivedAt == null);

  // 5c65367d — the Excel import's reference sheets. Read WITHOUT a selected employee on purpose: an
  // import is multi-employee by nature (the reporter's whole point is loading a month for forty people),
  // so requiring somebody to be picked first would be the friction it exists to remove.
  const importReference = await buildTxnTemplateReference(s, scopeIds, { preferredCompanyId: selectedEmp?.companyId });

  // ENDED is derived against the TENANT timezone, on the server. Deriving it in the browser would call an
  // item ended a day early or late for anyone whose device clock sits either side of MYT midnight.
  const today = todayInKualaLumpur();
  // 4fffe638 — the View / Edit pop-up's cycle choices: this company's ACTIVE cycles (read above for Add),
  // with a row's since-inactivated linked cycle prepended and marked. No extra read per row.
  const activeCycles = cycles.map((c) => ({ id: c.id, name: c.name }));
  const rows: FixedTxnRow[] = existing.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    amount: r.amount,
    currency: r.currency ?? null,
    validFrom: r.validFrom,
    validTo: r.validTo,
    runType: r.runType,
    // 4fffe638 — the linked configured cycle's name; the list falls back to the run-type label, then to
    // "unspecified".
    cycleName: r.payrollCycleName ?? null,
    remarks: r.remarks,
    ended: r.validTo != null && r.validTo < today,
    payrollCycleId: r.payrollCycleId ?? null,
    cycleOptions: fixedEditCycleOptions(activeCycles, r, (name) => t('fixed.cycleInactive', { name })),
    cyclePlaceholder: !r.payrollCycleId && r.runType ? t(`individual.cycle.${r.runType}` as never) : '—',
  }));
  // Pre-translated cycle labels: the list is a client component and these live in a DIFFERENT namespace
  // (`payroll.transactions.individual.cycle.*`), so resolving them there would make it a two-namespace
  // file — the shape i18n-coverage check C skips ENTIRELY, static keys included.
  const cycleLabels = Object.fromEntries(
    FIXED_TRANSACTION_CYCLES.map((c) => [c, t(`individual.cycle.${c}` as never)]),
  ) as Record<string, string>;

  // Friendly error keys thrown by an action → localised; anything else is a raw message. The key set and
  // the argument filling are shared with the View / Edit pop-up (edit-model.ts).
  const errorMessage =
    error && FIXED_ERROR_KEYS.has(error)
      ? t(
          `fixed.${error}` as never,
          fixedErrorValues(
            { code: clashCode, from: clashFrom, to: clashTo, period: clashPeriod, nextFirst, latestEnd },
            t('fixed.openEnded'),
          ) as never,
        )
      : error;
  // cc8bd87f — `?edit=` opens the pop-up only when it names a LIVE row of the selected, in-scope employee
  // (`rows` is already that); anything else is ignored. A refusal that came with it is shown inside it.
  const editId = edit && rows.some((r) => r.id === edit) ? edit : null;
  const editLabels: EditFixedDialogLabels = {
    subtitle: t('fixed.detailSubtitle'),
    notChangedHere: t('fixed.notChangedHere'),
    employee: t('fixed.colEmployee'),
    currentAmount: t('fixed.currentAmount'),
    status: t('fixed.status'),
    statusActive: t('fixed.statusActive'),
    statusEnded: t('fixed.statusEnded'),
    versioningTitle: t('fixed.versioningTitle'),
    versioningBody: t('fixed.versioningBody'),
    amount: t('fixed.amount'),
    payrollCycle: t('fixed.payrollCycle'),
    startDate: t('fixed.startDate'),
    endDate: t('fixed.endDate'),
    endDateHint: t('fixed.endDateHint'),
    remarks: t('fixed.remarks'),
    requiredField: t('fixed.requiredField'),
    save: t('fixed.save'),
    saving: t('fixed.saving'),
    cancel: t('fixed.cancel'),
    close: t('fixed.close'),
    remove: t('fixed.delete'),
    removeTitle: t('fixed.deleteTitle'),
    removeBody: t('fixed.deleteBody'),
    saved: t('fixed.savedToast'),
    removed: t('fixed.removedToast'),
    openEnded: t('fixed.openEnded'),
  };

  return (
    <div className={pageWideCls}>
      <PageHeader
        back={{ href: '/payroll/transactions', label: t('title') }}
        title={t('fixed.title')}
        description={t('fixed.subtitle')}
        // 5c65367d — Import Excel + Download Template. In the page header rather than beside Add,
        // because Add belongs to ONE selected employee and an import does not: these two must be
        // reachable before anybody is picked.
        actions={
          <>
            <TxnImportButtons kind="fixed" reference={importReference} queueFixedAction={queueFixedTransactionImportAction} />
            <Link className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted"
              href={FIXED_TXN_IMPORT_LOG}>{tImport('log')}</Link>
          </>
        }
      />

      {!typedComponentsOn && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
          <p className="font-medium">{t('gatedTitle')}</p>
          <p className="mt-1 text-xs">{t('gatedBody')}</p>
        </div>
      )}

      {/* A refusal for the item being reopened is shown inside its pop-up instead (cc8bd87f). */}
      <ErrorBanner message={editId ? undefined : errorMessage} />

      <CollapsibleEmployeePanel
        defaultOpen={panelDefaultOpen}
        cookieKey={FIXED_PANEL_COOKIE}
        hideLabel={t('fixed.hideEmployees')}
        showLabel={t('fixed.showEmployees')}
        // 009c8a37 — the screen name carries the header row until somebody is picked. Before this the row
        // did not exist at all in that state, which is where the reporter's screenshot was taken.
        title={t('fixed.title')}
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
              <FixedToolbar
                employmentId={selected!}
                // 2aed39d4 — was `selectedEmp.hiredOn`. A hire date GUARANTEES an overlap with any item
                // the employee already holds (every live row starts on or after it), so the default
                // value of the Add form was itself a reliable way to produce the refusal this item adds.
                // Today, resolved server-side in the tenant timezone like the `ended` flag below.
                defaultStart={today}
                components={activeComponents.map((c) => ({ id: c.id, code: c.code, name: c.name }))}
                cycles={cycles.map((c) => ({ id: c.id, name: c.name }))}
                // 2aed39d4 — what the employee ALREADY holds, so the dialog can show it on selection and
                // turn amber before the save rather than after it. Superseded rows are already excluded
                // by listEmploymentPayComponents; ENDED rows are deliberately included, because an ended
                // row still blocks an overlapping window (it is the case this whole item exists for).
                existing={existing.map((r) => ({
                  componentId: r.componentId,
                  code: r.code,
                  amount: r.amount,
                  validFrom: r.validFrom,
                  validTo: r.validTo,
                  ended: r.validTo != null && r.validTo < today,
                }))}
              />
            </>
          ) : undefined
        }
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
            {/* 009c8a37 — the identity + Add button that used to open this Card now open the shell's
                header row instead, on the same horizontal line as the Hide/Show control. */}
            <SectionHeader title={t('fixed.title')} count={rows.length} />

            {/* A CHANGE ADDS A LINE — said here, and again in the item's View / Edit pop-up. Editing a
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
              employee={{ code: selectedEmp.employeeCode ?? null, name: selectedEmp.name }}
              cycleLabels={cycleLabels}
              cycleUnspecifiedLabel={t('fixed.cycleUnspecified')}
              editLabels={editLabels}
              initialEditId={editId}
              initialEditError={editId ? (errorMessage ?? null) : null}
            />
          </Card>
        )}
      </CollapsibleEmployeePanel>
    </div>
  );
}
