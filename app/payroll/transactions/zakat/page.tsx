import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { batchInputRows, listBatches } from '@/core/payroll';
import { employeeDetail, listEmployees } from '@/core/read';
import { getStatutoryProfileMY } from '@/localization/my/statutory';
import { MY_STATES } from '@/localization/my/holidays';
import { Button, Card, ErrorBanner, Field, PageHeader, SectionHeader, inputCls } from '@/components/ui';
import { PayrollTabs } from '@/components/payroll-tabs';
import { saveZakatAction } from '../deductions-actions';
import { saveZakatElectionAction } from './election-actions';

/**
 * Zakat screen (feedback 58755260) — the single home for zakat, in two sections:
 *
 *  A. ELECTION (durable, per-employee) — relocated from Personnel > Statutory (MY). Employee-first flow:
 *     pick an employee (?employmentId=), see their basic info, edit state/method/rate/effective dates.
 *     Saves via saveZakatElectionAction → the existing setStatutoryProfileMY (validation + event intact).
 *     The payroll kernel reads this election on every regular run (fixed auto-applied; percent derived
 *     live from the month's pre-offset MTD).
 *
 *  B. ONE-OFF OVERRIDE (per draft batch) — the pre-existing per-run RM table, kept: a manual
 *     payroll_input.zakat wins over the election for that run only (core/payroll.ts precedence).
 *
 * Both GET pickers carry the OTHER section's selection as a hidden input so choosing one never drops
 * the other. Mirrors tp1/page.tsx scaffolding.
 */
export default async function ZakatTransactionPage({
  searchParams,
}: {
  searchParams: Promise<{ batchId?: string; employmentId?: string; error?: string; toast?: string }>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('payroll.transactions');
  const { batchId, employmentId, error } = await searchParams;
  const typedComponentsOn = process.env.TYPED_PAY_COMPONENTS_ENABLED === 'true';

  // ── Section A data — employee election ─────────────────────────────────────
  const employees = (await listEmployees(s, scopeIds)).filter((e) => !e.terminatedOn);
  const selectedEmploymentId =
    employmentId && employees.some((e) => e.employmentId === employmentId) ? employmentId : null;
  const emp = selectedEmploymentId ? await employeeDetail(s, selectedEmploymentId) : null;
  const statutory = emp ? await getStatutoryProfileMY(s, emp.personId) : null;

  // ── Section B data — per-batch override ────────────────────────────────────
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

      {/* ── Section A — durable per-employee election (relocated from Personnel) ── */}
      <Card className="p-4">
        <h2 className="text-sm font-semibold">{t('zakat.election.title')}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{t('zakat.election.subtitle')}</p>
        <form method="GET" className="mt-3 flex flex-wrap items-end gap-3">
          {/* Keep the batch-override selection when switching employees. */}
          {selected && <input type="hidden" name="batchId" value={selected} />}
          <Field label={t('zakat.election.pickEmployee')}>
            <select name="employmentId" defaultValue={selectedEmploymentId ?? ''} className={inputCls}>
              <option value="">—</option>
              {employees.map((e) => (
                <option key={e.employmentId} value={e.employmentId}>
                  {e.name}
                  {e.employeeCode ? ` · ${e.employeeCode}` : ''} · {e.company}
                </option>
              ))}
            </select>
          </Field>
          <Button type="submit" variant="secondary">
            {t('zakat.election.pickEmployee')}
          </Button>
        </form>
        {employees.length === 0 && (
          <p className="mt-3 text-sm text-muted-foreground">{t('zakat.election.noEmployees')}</p>
        )}
      </Card>

      {emp && (
        <Card className="overflow-hidden">
          <SectionHeader title={t('zakat.election.title')} />
          {/* Step 1 basic info: name, employee number, company (ticket's employee card). */}
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1 border-b border-border px-4 py-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-muted-foreground">{t('zakat.election.name')}</dt>
              <dd className="font-medium">{emp.name}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t('zakat.election.employeeNo')}</dt>
              <dd className="font-medium tabular-nums">{emp.employeeCode ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t('zakat.election.company')}</dt>
              <dd className="font-medium">{emp.company}</dd>
            </div>
          </dl>
          {statutory ? (
            /* Step 2 — the exact field set relocated from Personnel > Statutory (MY). Percent shows as
               a %, stored as a decimal; both amount inputs render and the setter keeps only the one for
               the chosen method. Effective dates are display-only metadata (no calc-path filtering). */
            <form action={saveZakatElectionAction} className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
              <input type="hidden" name="employmentId" value={emp.employmentId} />
              <input type="hidden" name="personId" value={emp.personId} />
              {selected && <input type="hidden" name="batchId" value={selected} />}
              <label className="flex items-center gap-2 text-sm sm:col-span-2">
                <input
                  type="checkbox"
                  name="zakatActive"
                  defaultChecked={statutory.zakatActive ?? false}
                  className="size-4 rounded"
                />
                {t('zakat.election.active')}
              </label>
              <Field label={t('zakat.election.state')}>
                <select name="zakatState" defaultValue={statutory.zakatState ?? ''} className={inputCls}>
                  <option value="">—</option>
                  {MY_STATES.map((st) => (
                    <option key={st} value={st}>
                      {st}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('zakat.election.method')}>
                <select name="zakatMethod" defaultValue={statutory.zakatMethod ?? ''} className={inputCls}>
                  <option value="">—</option>
                  <option value="percent_of_pcb">{t('zakat.election.methodPercentOfPcb')}</option>
                  <option value="fixed">{t('zakat.election.methodFixed')}</option>
                </select>
              </Field>
              <Field label={t('zakat.election.percent')}>
                <input
                  name="zakatPercent"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={statutory.zakatPercent ? (Number(statutory.zakatPercent) * 100).toString() : ''}
                  placeholder="2.5"
                  className={inputCls}
                />
              </Field>
              <Field label={t('zakat.election.fixed')}>
                <input
                  name="zakatFixed"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={statutory.zakatFixed ?? ''}
                  className={inputCls}
                />
              </Field>
              <Field label={t('zakat.election.effectiveFrom')}>
                <input
                  name="zakatEffectiveFrom"
                  type="date"
                  defaultValue={statutory.zakatEffectiveFrom ?? ''}
                  className={inputCls}
                />
              </Field>
              <Field label={t('zakat.election.effectiveTo')}>
                <input
                  name="zakatEffectiveTo"
                  type="date"
                  defaultValue={statutory.zakatEffectiveTo ?? ''}
                  className={inputCls}
                />
              </Field>
              <p className="sm:col-span-2 text-xs text-muted-foreground">{t('zakat.election.nonResidentHint')}</p>
              <div className="flex items-end justify-end sm:col-span-2">
                <Button type="submit">{t('zakat.election.save')}</Button>
              </div>
            </form>
          ) : (
            /* No MY statutory row yet (no IC): the election has nowhere to live. Point at Personnel. */
            <p className="p-4 text-sm text-muted-foreground">
              {t('zakat.election.noProfile')}{' '}
              <Link
                href={`/admin/personnel/${emp.employmentId}`}
                className="font-medium text-primary underline-offset-2 hover:underline"
              >
                {t('zakat.election.openPersonnel')}
              </Link>
            </p>
          )}
        </Card>
      )}

      {/* ── Section B — one-off per-batch override (pre-existing, kept) ── */}
      <Card className="p-4">
        <h2 className="text-sm font-semibold">{t('zakat.override.title')}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{t('zakat.override.subtitle')}</p>
        <form method="GET" className="mt-3 flex flex-wrap items-end gap-3">
          {/* Keep the election section's employee when switching batches. */}
          {selectedEmploymentId && <input type="hidden" name="employmentId" value={selectedEmploymentId} />}
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
          <SectionHeader title={t('zakat.override.title')} count={rows.length} />
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
