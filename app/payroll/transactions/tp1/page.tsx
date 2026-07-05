import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { batchInputRows, listBatches } from '@/core/payroll';
import { Button, Card, ErrorBanner, Field, PageHeader, SectionHeader, inputCls } from '@/components/ui';
import { PayrollTabs } from '@/components/payroll-tabs';
import { saveTp1Action } from '../deductions-actions';

/**
 * Separated TP1 Relief screen (approved plan). Split OUT of the crowded Individual Transaction screen into
 * a dedicated single-column editor: pick a DRAFT batch, edit each employee's TP1 relief, save. Delegates to
 * setPayrollDeductionInput (TP1 only) so earnings and zakat on the same row are preserved. No history link
 * (deferred — the audit substrate has no per-field/per-batch filter). Mirrors individual/page.tsx scaffolding.
 */
export default async function Tp1TransactionPage({
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
  const rows = selected ? await batchInputRows(s, selected) : [];
  const multiCycleOn = process.env.MULTI_CYCLE_PAYROLL_ENABLED === 'true';
  // Multi-cycle disambiguation: when several draft runs share a payPeriod, show the cycle so the admin
  // selects the exact target batch, not just the month (same as individual/page.tsx).
  const periodRunCount = new Map<string, number>();
  for (const b of batches) periodRunCount.set(b.payPeriod, (periodRunCount.get(b.payPeriod) ?? 0) + 1);
  const cycleLabel = (b: (typeof batches)[number]) =>
    `${t(`individual.cycle.${b.runType}`)}${b.runSeq > 1 ? ` #${b.runSeq}` : ''}`;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        back={{ href: '/payroll/transactions', label: t('title') }}
        title={t('tp1.title')}
        description={t('tp1.subtitle')}
      />
      <PayrollTabs active="transactions" />

      {!typedComponentsOn && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
          <p className="font-medium">{t('gatedTitle')}</p>
          <p className="mt-1 text-xs">{t('gatedBody')}</p>
        </div>
      )}

      <ErrorBanner message={error} />

      <Card className="p-4">
        <form method="GET" className="flex flex-wrap items-end gap-3">
          <Field label={t('tp1.pickBatch')}>
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
            {t('tp1.pickBatch')}
          </Button>
        </form>
        {batches.length === 0 && <p className="mt-3 text-sm text-muted-foreground">{t('tp1.noBatches')}</p>}
      </Card>

      {selected && (
        <Card className="overflow-hidden">
          <SectionHeader title={t('tp1.title')} count={rows.length} />
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">{t('tp1.employee')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('tp1.amount')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => (
                  <tr key={r.employmentId}>
                    <td className="px-4 py-2.5 font-medium">{r.name}</td>
                    <td className="px-4 py-2.5">
                      <form action={saveTp1Action} className="flex items-center justify-end gap-2">
                        <input type="hidden" name="batchId" value={selected} />
                        <input type="hidden" name="employmentId" value={r.employmentId} />
                        <input
                          name="tp1Deduction"
                          type="number"
                          min="0"
                          step="0.01"
                          defaultValue={r.tp1Deduction}
                          className={`${inputCls} w-28 text-right`}
                        />
                        <Button type="submit" variant="secondary">
                          {t('tp1.save')}
                        </Button>
                      </form>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={2} className="px-4 py-8 text-center text-muted-foreground">
                      {t('tp1.empty')}
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
