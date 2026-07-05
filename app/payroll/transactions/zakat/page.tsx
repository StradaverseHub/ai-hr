import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { batchInputRows, listBatches } from '@/core/payroll';
import { Button, Card, ErrorBanner, Field, PageHeader, SectionHeader, inputCls } from '@/components/ui';
import { PayrollTabs } from '@/components/payroll-tabs';
import { saveZakatAction } from '../deductions-actions';

/**
 * Separated Zakat screen (approved plan). Split OUT of the crowded Individual Transaction screen into a
 * dedicated single-column editor: pick a DRAFT batch, edit each employee's zakat, save. Delegates to
 * setPayrollDeductionInput (zakat only) so earnings and TP1 (and its 'tp1_self' provenance, ADR-0050 §0.4)
 * on the same row are preserved. No history link (deferred). Mirrors tp1/page.tsx scaffolding.
 */
export default async function ZakatTransactionPage({
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
        title={t('zakat.title')}
        description={t('zakat.subtitle')}
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
          <Field label={t('zakat.pickBatch')}>
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
            {t('zakat.pickBatch')}
          </Button>
        </form>
        {batches.length === 0 && <p className="mt-3 text-sm text-muted-foreground">{t('zakat.noBatches')}</p>}
      </Card>

      {selected && (
        <Card className="overflow-hidden">
          <SectionHeader title={t('zakat.title')} count={rows.length} />
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">{t('zakat.employee')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('zakat.amount')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => (
                  <tr key={r.employmentId}>
                    <td className="px-4 py-2.5 font-medium">{r.name}</td>
                    <td className="px-4 py-2.5">
                      <form action={saveZakatAction} className="flex items-center justify-end gap-2">
                        <input type="hidden" name="batchId" value={selected} />
                        <input type="hidden" name="employmentId" value={r.employmentId} />
                        <input
                          name="zakat"
                          type="number"
                          min="0"
                          step="0.01"
                          defaultValue={r.zakat}
                          className={`${inputCls} w-28 text-right`}
                        />
                        <Button type="submit" variant="secondary">
                          {t('zakat.save')}
                        </Button>
                      </form>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={2} className="px-4 py-8 text-center text-muted-foreground">
                      {t('zakat.empty')}
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
