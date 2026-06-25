import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { batchInputRows, listBatches } from '@/core/payroll';
import { listSupportedBatchComponents } from '@/core/pay-components';
import { Button, Card, ErrorBanner, Field, PageHeader, SectionHeader, inputCls } from '@/components/ui';
import { PayrollTabs } from '@/components/payroll-tabs';
import { ComponentImport } from '../../[batchId]/component-import';
import { addBatchComponentAction, setDeductionInputAction } from './actions';

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
  const [rows, components] = selected
    ? await Promise.all([batchInputRows(s, selected), listSupportedBatchComponents(s)])
    : [[], []];
  // The friendly key for a thrown unsupported-component error is namespaced under individual.* ;
  // any other error is already a plain message string.
  const errorMessage = error === 'unsupportedComponent' ? t('individual.unsupportedComponent') : error;

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

          <Card className="overflow-hidden">
            <SectionHeader title={t('individual.deductionTitle')} count={rows.length} />
            <p className="px-4 pt-3 text-xs text-muted-foreground">{t('individual.deductionIntro')}</p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">{t('individual.employee')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('individual.deductionTitle')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((r) => (
                    <tr key={r.employmentId}>
                      <td className="px-4 py-2.5 font-medium">{r.name}</td>
                      <td className="px-4 py-2.5">
                        <form action={setDeductionInputAction} className="flex items-center justify-end gap-2">
                          <input type="hidden" name="batchId" value={selected} />
                          <input type="hidden" name="employmentId" value={r.employmentId} />
                          <label className="flex items-center gap-1 text-[10px] uppercase text-muted-foreground" title={t('individual.tp1Title')}>
                            {t('individual.tp1')}
                            <input name="tp1Deduction" type="number" min="0" step="0.01" defaultValue={r.tp1Deduction} className={`${inputCls} w-24 text-right`} />
                          </label>
                          <label className="flex items-center gap-1 text-[10px] uppercase text-muted-foreground" title={t('individual.zakatTitle')}>
                            {t('individual.zakat')}
                            <input name="zakat" type="number" min="0" step="0.01" defaultValue={r.zakat} className={`${inputCls} w-24 text-right`} />
                          </label>
                          <Button type="submit" variant="secondary">
                            {t('individual.save')}
                          </Button>
                        </form>
                      </td>
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={2} className="px-4 py-8 text-center text-muted-foreground">
                        {t('individual.noBatches')}
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
