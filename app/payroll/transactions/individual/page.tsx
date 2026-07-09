import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listBatches } from '@/core/payroll';
import { listCompanies, listEmployees } from '@/core/read';
import { listPayComponents } from '@/core/pay-components';
import {
  listIndividualTxns,
  listUnattachedIndividualTxns,
  TXN_KINDS,
  TXN_UNITS,
  type UnattachedTxnRow,
} from '@/core/payroll-individual-txn';

/** Alias used by the ledger's dual-view row map below (batch rows lack the month/company columns). */
type UnattachedRow = UnattachedTxnRow;
import { Badge, Button, Card, EmployeeName, ErrorBanner, Field, PageHeader, SectionHeader, inputCls } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { PayrollTabs } from '@/components/payroll-tabs';
import { TxnGrid, type WizardBatch, type WizardEmployee } from './txn-grid';
import { updateIndividualTxnAction, deleteIndividualTxnAction } from './actions';

/**
 * 1.2.2 Individual Transaction — a guided four-step flow for one-off payroll items.
 * Primary path: the TxnGrid wizard (Step 1 pick employee → Step 2 pick period+cycle+run resolving a draft
 * batch in the employee's company → Step 3 an editable spreadsheet-like grid → Step 4 one atomic Save).
 * Below it, a batch-scoped ledger of the resulting transactions with inline edit/delete. The page is kept
 * strictly focused on pay-item management; CSV bulk import lives on the batch detail page, and TP1 relief /
 * zakat each have their own dedicated screen linked from the Transactions hub.
 */
export default async function IndividualTransactionPage({
  searchParams,
}: {
  searchParams: Promise<{ batchId?: string; error?: string; toast?: string }>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('payroll.transactions');
  const { batchId, error } = await searchParams;
  const typedComponentsOn = process.env.TYPED_PAY_COMPONENTS_ENABLED === 'true';

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

  // The ledger below the wizard has two views (f1564110 Phase 2): per-draft-batch (as before) and
  // "unattached" — period-keyed rows awaiting the month's regular run (?batchId=unattached). An explicit
  // ?batchId= selection wins; else the first draft; else the unattached view when only unattached rows exist.
  const unattachedTxns = await listUnattachedIndividualTxns(s);
  const unattachedView =
    batchId === 'unattached' || (!batchId && draftBatches.length === 0 && unattachedTxns.length > 0);
  const selected =
    !unattachedView && batchId && draftBatches.some((b) => b.id === batchId)
      ? batchId
      : unattachedView
        ? null
        : draftBatches[0]?.id ?? null;
  const selectedBatch = selected ? draftBatches.find((b) => b.id === selected) ?? null : null;
  const txns = selected ? await listIndividualTxns(s, { batchId: selected }) : [];
  // The rows the ledger table renders — the unattached (period-keyed) set or the selected batch's set.
  const ledgerRows = unattachedView ? unattachedTxns : txns;
  const multiCycleOn = process.env.MULTI_CYCLE_PAYROLL_ENABLED === 'true';
  const periodRunCount = new Map<string, number>();
  for (const b of draftBatches) periodRunCount.set(b.payPeriod, (periodRunCount.get(b.payPeriod) ?? 0) + 1);
  const cycleLabel = (b: (typeof draftBatches)[number]) =>
    `${t(`individual.cycle.${b.runType}`)}${b.runSeq > 1 ? ` #${b.runSeq}` : ''}`;
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

      {/* ── Primary: the four-step wizard ── */}
      <TxnGrid
        employees={wizardEmployees}
        batches={wizardBatches}
        companies={scopedCompanies}
        payItems={wizardPayItems}
        processHref="/payroll/process"
      />
      {/* ── The resulting ledger: per-draft-batch view, or the UNATTACHED view (period-keyed rows awaiting
          the month's regular run — f1564110 Phase 2). Edit / delete inline in both views. ── */}
      {(selected || unattachedView || unattachedTxns.length > 0) && (
        <Card className="overflow-hidden">
          <SectionHeader
            title={unattachedView ? t('individual.unattachedTitle') : t('individual.txnTitle')}
            count={ledgerRows.length}
          />
          {unattachedView ? (
            <p className="px-4 pt-3 text-xs text-muted-foreground">{t('individual.unattachedHint')}</p>
          ) : (
            <div className="flex flex-wrap items-center gap-x-6 gap-y-1 px-4 pt-3 text-xs text-muted-foreground">
              <span>
                {t('individual.monthLabel')}:{' '}
                <span className="font-medium text-foreground">{selectedBatch?.payPeriod}</span>
              </span>
              <span>
                {t('individual.cycleLabel')}:{' '}
                <span className="font-medium text-foreground">{selectedBatch ? cycleLabel(selectedBatch) : '—'}</span>
              </span>
            </div>
          )}

          {/* View picker: the draft batches + the unattached view (the wizard resolves its own target). */}
          <form method="GET" className="flex flex-wrap items-end gap-3 px-4 pt-3">
            <Field label={t('individual.pickBatch')}>
              <select name="batchId" defaultValue={unattachedView ? 'unattached' : selected ?? ''} className={inputCls}>
                {draftBatches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.payPeriod} · {b.company}
                    {multiCycleOn && (periodRunCount.get(b.payPeriod) ?? 0) > 1 ? ` · ${cycleLabel(b)}` : ''}
                  </option>
                ))}
                <option value="unattached">
                  {t('individual.unattachedOption')} ({unattachedTxns.length})
                </option>
              </select>
            </Field>
            <Button type="submit" variant="secondary">
              {t('individual.pickBatch')}
            </Button>
          </form>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  {unattachedView && <th className="px-4 py-2 font-medium">{t('individual.monthLabel')}</th>}
                  <th className="px-4 py-2 font-medium">{t('individual.txnDate')}</th>
                  <th className="px-4 py-2 font-medium">{t('individual.employee')}</th>
                  {unattachedView && <th className="px-4 py-2 font-medium">{t('individual.company')}</th>}
                  <th className="px-4 py-2 font-medium">{t('individual.kind')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('individual.amount')}</th>
                  <th className="px-4 py-2 font-medium">{t('individual.quantity')}</th>
                  <th className="px-4 py-2 font-medium">{t('individual.notes')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('individual.actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {ledgerRows.map((tx) => {
                  // Date bounds for the inline edit: the owning batch's month, or the row's own pay month.
                  const rowPeriod = unattachedView ? (tx as UnattachedRow).payPeriod : selectedBatch?.payPeriod;
                  return (
                  <tr key={tx.id}>
                    {unattachedView && (
                      <td className="whitespace-nowrap px-4 py-2.5 font-medium">{(tx as UnattachedRow).payPeriod}</td>
                    )}
                    <td className="whitespace-nowrap px-4 py-2.5">{tx.txnDate}</td>
                    <td className="px-4 py-2.5 font-medium"><EmployeeName code={tx.employeeCode} name={tx.name} /></td>
                    {unattachedView && (
                      <td className="px-4 py-2.5 text-muted-foreground">{(tx as UnattachedRow).companyName}</td>
                    )}
                    <td className="px-4 py-2.5">
                      <Badge>{t(`individual.kindLabel.${tx.kind}`)}</Badge>
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{tx.amount}</td>
                    <td className="px-4 py-2.5 text-muted-foreground">
                      {tx.quantity != null ? `${tx.quantity}${tx.unit ? ` ${t(`individual.unitLabel.${tx.unit}`)}` : ''}` : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">{tx.notes ?? '—'}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center justify-end gap-2">
                        <details className="group">
                          <summary className="cursor-pointer list-none rounded-md border border-border px-2 py-1 text-xs text-foreground hover:bg-muted">
                            {t('individual.edit')}
                          </summary>
                          <form
                            action={updateIndividualTxnAction}
                            className="mt-2 grid grid-cols-2 gap-2 rounded-md border border-border bg-muted/30 p-3"
                          >
                            {/* 'unattached' keeps the redirect on this view; a real id scopes back to the batch. */}
                            <input type="hidden" name="batchId" value={unattachedView ? 'unattached' : selected ?? ''} />
                            <input type="hidden" name="id" value={tx.id} />
                            <label className="text-[10px] uppercase text-muted-foreground">
                              {t('individual.kind')}
                              <select name="kind" defaultValue={tx.kind} className={inputCls}>
                                {TXN_KINDS.map((k) => (
                                  <option key={k} value={k}>
                                    {t(`individual.kindLabel.${k}`)}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label className="text-[10px] uppercase text-muted-foreground">
                              {t('individual.txnDate')}
                              <input
                                name="txnDate"
                                type="date"
                                defaultValue={tx.txnDate}
                                min={rowPeriod ? `${rowPeriod}-01` : undefined}
                                max={rowPeriod ? `${rowPeriod}-31` : undefined}
                                className={inputCls}
                              />
                            </label>
                            <label className="text-[10px] uppercase text-muted-foreground">
                              {t('individual.amount')}
                              <input name="amount" type="number" min="0" step="0.01" defaultValue={tx.amount} className={`${inputCls} text-right`} />
                            </label>
                            <label className="text-[10px] uppercase text-muted-foreground">
                              {t('individual.quantity')}
                              <div className="flex gap-1">
                                <input name="quantity" type="number" step="0.01" defaultValue={tx.quantity ?? ''} className={`${inputCls} text-right`} />
                                <select name="unit" defaultValue={tx.unit ?? ''} className={inputCls}>
                                  <option value="">—</option>
                                  {TXN_UNITS.map((u) => (
                                    <option key={u} value={u}>
                                      {t(`individual.unitLabel.${u}`)}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            </label>
                            <label className="col-span-2 text-[10px] uppercase text-muted-foreground">
                              {t('individual.notes')}
                              <input name="notes" type="text" defaultValue={tx.notes ?? ''} className={inputCls} />
                            </label>
                            <div className="col-span-2 flex justify-end">
                              <Button type="submit" size="sm">
                                {t('individual.save')}
                              </Button>
                            </div>
                          </form>
                        </details>
                        <form action={deleteIndividualTxnAction}>
                          <input type="hidden" name="batchId" value={unattachedView ? 'unattached' : selected ?? ''} />
                          <input type="hidden" name="id" value={tx.id} />
                          <ConfirmSubmit
                            size="sm"
                            title={t('individual.deleteTitle')}
                            description={t('individual.deleteBody')}
                            confirmLabel={t('individual.delete')}
                          >
                            {t('individual.delete')}
                          </ConfirmSubmit>
                        </form>
                      </div>
                    </td>
                  </tr>
                  );
                })}
                {ledgerRows.length === 0 && (
                  <tr>
                    <td colSpan={unattachedView ? 9 : 7} className="px-4 py-8 text-center text-muted-foreground">
                      {unattachedView ? t('individual.unattachedEmpty') : t('individual.txnEmpty')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
