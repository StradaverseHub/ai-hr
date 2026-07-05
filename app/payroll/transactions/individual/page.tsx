import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { batchInputRows, listBatches } from '@/core/payroll';
import { listSupportedBatchComponents } from '@/core/pay-components';
import { listIndividualTxns, TXN_KINDS, TXN_UNITS } from '@/core/payroll-individual-txn';
import { Badge, Button, Card, ErrorBanner, Field, PageHeader, SectionHeader, inputCls } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { PayrollTabs } from '@/components/payroll-tabs';
import { ComponentImport } from '../../[batchId]/component-import';
import {
  addBatchComponentAction,
  createIndividualTxnAction,
  updateIndividualTxnAction,
  deleteIndividualTxnAction,
} from './actions';

/**
 * Feature 1.2 — Individual Transaction (one-off batch components + TP1/zakat).
 * Pick a DRAFT batch, then: (1) a guided single-row create form posting through the event-logged
 * setPayrollBatchComponent — its component picker is FILTERED to supported components only; (2) the
 * existing bulk CSV importer; (3) a TP1 + zakat section that read-modify-writes through
 * setPayrollDeductionInput so editing relief/zakat never zeroes overtime/bonus on the same row.
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

  const batches = (await listBatches(s, scopeIds)).filter((b) => b.status === 'draft');
  const selected = batchId && batches.some((b) => b.id === batchId) ? batchId : null;
  const selectedBatch = selected ? batches.find((b) => b.id === selected) ?? null : null;
  const [rows, components, txns] = selected
    ? await Promise.all([
        batchInputRows(s, selected),
        listSupportedBatchComponents(s),
        listIndividualTxns(s, { batchId: selected }),
      ])
    : [[], [], []];
  const multiCycleOn = process.env.MULTI_CYCLE_PAYROLL_ENABLED === 'true';
  // Multi-cycle disambiguation: when several draft runs share a payPeriod, the option must show the cycle
  // (runType + runSeq) so the admin selects the exact target batch, not just the month.
  const periodRunCount = new Map<string, number>();
  for (const b of batches) periodRunCount.set(b.payPeriod, (periodRunCount.get(b.payPeriod) ?? 0) + 1);
  const cycleLabel = (b: (typeof batches)[number]) =>
    `${t(`individual.cycle.${b.runType}`)}${b.runSeq > 1 ? ` #${b.runSeq}` : ''}`;
  // The friendly key for a thrown error is namespaced under individual.* ; any other error is a plain string.
  const errorKeys = new Set(['unsupportedComponent', 'dateOutOfPeriod', 'notDraft']);
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

      <Card className="p-4">
        <form method="GET" className="flex flex-wrap items-end gap-3">
          <Field label={t('individual.pickBatch')}>
            <select name="batchId" defaultValue={selected ?? ''} className={inputCls}>
              <option value="">—</option>
              {batches.map((b) => (
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
        {batches.length === 0 && (
          <p className="mt-3 text-sm text-muted-foreground">{t('individual.noBatches')}</p>
        )}
      </Card>

      {selected && (
        <>
          <Card className="overflow-hidden">
            <SectionHeader title={t('individual.addTitle')} />
            <p className="px-4 pt-3 text-xs text-muted-foreground">{t('individual.addIntro')}</p>
            <form action={addBatchComponentAction} className="grid grid-cols-1 items-end gap-3 p-4 sm:grid-cols-5">
              <input type="hidden" name="batchId" value={selected} />
              <Field label={t('individual.employee')}>
                <select name="employmentId" required className={inputCls}>
                  {rows.map((r) => (
                    <option key={r.employmentId} value={r.employmentId}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('individual.component')}>
                <select name="componentId" required className={inputCls}>
                  {components.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.code})
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('individual.amount')}>
                <input name="amount" type="number" min="0" step="0.01" required className={`${inputCls} text-right`} />
              </Field>
              <Field label={t('individual.notes')}>
                <input name="notes" type="text" placeholder={t('individual.notesPlaceholder')} className={inputCls} />
              </Field>
              <Button type="submit">{t('individual.add')}</Button>
            </form>
          </Card>

          {typedComponentsOn && (
            <Card>
              <SectionHeader title={t('individual.csvTitle')} />
              <div className="px-4 pb-4">
                <p className="mb-3 text-xs text-muted-foreground">{t('individual.csvIntro')}</p>
                <ComponentImport batchId={selected} />
              </div>
            </Card>
          )}

          {/* TP1 relief & zakat moved to dedicated screens (/payroll/transactions/tp1 and /zakat) — this
              screen no longer edits them (approved plan: separate TP1/Zakat into their own functions). */}

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
            <p className="px-4 pt-2 text-xs text-muted-foreground">{t('individual.txnIntro')}</p>

            {/* Add-row form — server validates draft-state + date-in-period; client min/max is a hint. */}
            <form
              action={createIndividualTxnAction}
              className="grid grid-cols-1 items-end gap-3 p-4 sm:grid-cols-6"
            >
              <input type="hidden" name="batchId" value={selected} />
              <Field label={t('individual.employee')}>
                <select name="employmentId" required className={inputCls}>
                  {rows.map((r) => (
                    <option key={r.employmentId} value={r.employmentId}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('individual.kind')}>
                <select name="kind" required defaultValue="earning" className={inputCls}>
                  {TXN_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {t(`individual.kindLabel.${k}`)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('individual.txnDate')}>
                <input
                  name="txnDate"
                  type="date"
                  required
                  min={selectedBatch ? `${selectedBatch.payPeriod}-01` : undefined}
                  max={selectedBatch ? `${selectedBatch.payPeriod}-31` : undefined}
                  className={inputCls}
                />
              </Field>
              <Field label={t('individual.amount')}>
                <input name="amount" type="number" min="0" step="0.01" required className={`${inputCls} text-right`} />
              </Field>
              <Field label={t('individual.quantity')}>
                <div className="flex gap-1">
                  <input name="quantity" type="number" step="0.01" className={`${inputCls} text-right`} />
                  <select name="unit" defaultValue="" className={inputCls}>
                    <option value="">—</option>
                    {TXN_UNITS.map((u) => (
                      <option key={u} value={u}>
                        {t(`individual.unitLabel.${u}`)}
                      </option>
                    ))}
                  </select>
                </div>
              </Field>
              <Field label={t('individual.notes')}>
                <input name="notes" type="text" placeholder={t('individual.notesPlaceholder')} className={inputCls} />
              </Field>
              <Button type="submit">{t('individual.txnAdd')}</Button>
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
                          {/* Inline edit — submit the same form fields the create action uses. */}
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
        </>
      )}
    </div>
  );
}
