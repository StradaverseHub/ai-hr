import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listBatches } from '@/core/payroll';
import { listCompanies, listEmployees } from '@/core/read';
import { listIndividualTxns, TXN_KINDS, TXN_UNITS } from '@/core/payroll-individual-txn';
import { Badge, Button, Card, ErrorBanner, Field, PageHeader, SectionHeader, inputCls } from '@/components/ui';
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

  const [allBatches, employees, companies] = await Promise.all([
    listBatches(s, scopeIds),
    listEmployees(s, scopeIds),
    listCompanies(s),
  ]);
  const draftBatches = allBatches.filter((b) => b.status === 'draft');

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
  }));
  const wizardBatches: WizardBatch[] = draftBatches.map((b) => ({
    id: b.id,
    companyId: b.companyId,
    payPeriod: b.payPeriod,
    runType: b.runType,
    runSeq: b.runSeq,
    scope: (b as { scope?: WizardBatch['scope'] }).scope ?? null,
  }));

  // The batch-scoped ledger below the wizard: an explicit ?batchId= selection wins; else the first draft.
  const selected = batchId && draftBatches.some((b) => b.id === batchId) ? batchId : draftBatches[0]?.id ?? null;
  const selectedBatch = selected ? draftBatches.find((b) => b.id === selected) ?? null : null;
  const txns = selected ? await listIndividualTxns(s, { batchId: selected }) : [];
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
        processHref="/payroll/process"
      />
      {draftBatches.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('individual.noBatches')}</p>
      )}

      {/* ── The resulting ledger for the selected draft batch (edit / delete inline) ── */}
      {selected && (
        <Card className="overflow-hidden">
          <SectionHeader title={t('individual.txnTitle')} count={txns.length} />
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

          {/* Batch picker for the ledger below (the wizard resolves its own batch; this only scopes the list). */}
          <form method="GET" className="flex flex-wrap items-end gap-3 px-4 pt-3">
            <Field label={t('individual.pickBatch')}>
              <select name="batchId" defaultValue={selected ?? ''} className={inputCls}>
                {draftBatches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.payPeriod} · {b.company}
                    {multiCycleOn && (periodRunCount.get(b.payPeriod) ?? 0) > 1 ? ` · ${cycleLabel(b)}` : ''}
                  </option>
                ))}
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
                  <th className="px-4 py-2 font-medium">{t('individual.txnDate')}</th>
                  <th className="px-4 py-2 font-medium">{t('individual.employee')}</th>
                  <th className="px-4 py-2 font-medium">{t('individual.kind')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('individual.amount')}</th>
                  <th className="px-4 py-2 font-medium">{t('individual.quantity')}</th>
                  <th className="px-4 py-2 font-medium">{t('individual.notes')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('individual.actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {txns.map((tx) => (
                  <tr key={tx.id}>
                    <td className="whitespace-nowrap px-4 py-2.5">{tx.txnDate}</td>
                    <td className="px-4 py-2.5 font-medium">{tx.name}</td>
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
                            <input type="hidden" name="batchId" value={selected} />
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
                                min={selectedBatch ? `${selectedBatch.payPeriod}-01` : undefined}
                                max={selectedBatch ? `${selectedBatch.payPeriod}-31` : undefined}
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
                          <input type="hidden" name="batchId" value={selected} />
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
                ))}
                {txns.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                      {t('individual.txnEmpty')}
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
