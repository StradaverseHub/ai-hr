import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';
import { batchDetail, batchInputRows } from '@/core/payroll';
import { Button, Card, ErrorBanner, PageHeader, SectionHeader, inputCls } from '@/components/ui';
import { closeAction, generateAction, prefillOvertimeAction, setPayrollInputAction } from '../actions';

const rm = (n: unknown) =>
  `RM ${Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default async function BatchPage({
  params,
  searchParams,
}: {
  params: Promise<{ batchId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const s = await requireAdmin();
  const { batchId } = await params;
  const { error } = await searchParams;
  const data = await batchDetail(s, batchId);
  if (!data) notFound();
  const { batch, slips } = data;
  const totals = (batch.totals ?? {}) as Record<string, number>;
  const inputs = batch.status === 'draft' ? await batchInputRows(s, batchId) : [];
  const [pYear, pMonth] = batch.payPeriod.split('-').map(Number);
  const periodDays = new Date(pYear, pMonth, 0).getDate(); // calendar days in the pay period

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        back={{ href: '/payroll', label: 'Payroll' }}
        title={batch.payPeriod}
        description={
          <>
            Payroll batch · <span className="capitalize">{batch.status}</span>
          </>
        }
        actions={
          <>
            {batch.status === 'draft' && (
              <form action={generateAction}>
                <input type="hidden" name="batchId" value={batch.id} />
                <Button type="submit">Generate payslips</Button>
              </form>
            )}
            {batch.status === 'processed' && (
              <form action={closeAction}>
                <input type="hidden" name="batchId" value={batch.id} />
                <Button type="submit" variant="secondary">
                  Close batch
                </Button>
              </form>
            )}
          </>
        }
      />

      <ErrorBanner message={error} />

      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
        ⚠️ Figures use the <span className="font-medium">official 2026 LHDN / PERKESO tables</span> but still require
        accountant sign-off before real use. PCB uses each employee&apos;s tax profile (category + children); pay is prorated
        for mid-month joiners/leavers; overtime, bonus and unpaid leave are captured; bonuses use the LHDN
        additional-remuneration (difference) method; and SOCSO + EIS apply the exact Act 4 / Act 800 schedule amounts to
        the RM6,000 ceiling. Remaining simplifications: EPF low-wage RM20 banding is approximated by % + round-up, and
        PCB uses the steady-state monthly model without prior-month accumulators.
        See <span className="font-mono">docs/architecture/STATUTORY-SOURCES.md</span>.
      </div>

      {batch.status === 'draft' && (
        <Card className="overflow-hidden">
          <SectionHeader title="Inputs · overtime, bonus + unpaid leave" count={inputs.length} />
          <p className="px-4 pt-3 text-xs text-muted-foreground">
            Enter overtime and bonus per employee. Bonus is taxed as additional remuneration (EPF + PCB
            difference method, excluded from SOCSO/EIS). Unpaid-leave days are derived automatically from
            approved unpaid leave requests starting in this period and deducted at the EA-1955 daily rate. Set
            inputs before generating payslips.
          </p>
          <div className="mx-4 mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-muted/40 px-3 py-2.5">
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">Overtime from attendance:</span> monetizes this
              period&rsquo;s classified OT at EA rates (ORP = wages/26 · workday 1.5× · rest day ½/1 day + 2× ·
              holiday +2 days + 3×). Wages above RM4,000 are not statutorily entitled and stay manual. You can
              still override any figure.
            </p>
            <form action={prefillOvertimeAction}>
              <input type="hidden" name="batchId" value={batch.id} />
              <Button type="submit" size="sm" variant="secondary">
                Prefill OT from attendance
              </Button>
            </form>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">Employee</th>
                  <th className="px-4 py-2 text-right font-medium">Basic</th>
                  <th className="px-4 py-2 text-right font-medium">Overtime · Bonus (RM)</th>
                  <th className="px-4 py-2 text-right font-medium">Unpaid days</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {inputs.map((r) => (
                  <tr key={r.employmentId}>
                    <td className="px-4 py-2.5 font-medium">{r.name}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{rm(r.basic)}</td>
                    <td className="px-4 py-2.5">
                      <form action={setPayrollInputAction} className="flex items-center justify-end gap-2">
                        <input type="hidden" name="batchId" value={batch.id} />
                        <input type="hidden" name="employmentId" value={r.employmentId} />
                        <label className="flex items-center gap-1 text-[10px] uppercase text-muted-foreground">
                          OT
                          <input
                            name="overtimeAmount"
                            type="number"
                            min="0"
                            step="0.01"
                            defaultValue={r.overtimeAmount}
                            className={`${inputCls} w-24 text-right`}
                          />
                        </label>
                        <label className="flex items-center gap-1 text-[10px] uppercase text-muted-foreground">
                          Bonus
                          <input
                            name="bonusAmount"
                            type="number"
                            min="0"
                            step="0.01"
                            defaultValue={r.bonusAmount}
                            className={`${inputCls} w-24 text-right`}
                          />
                        </label>
                        <Button type="submit" variant="secondary">
                          Save
                        </Button>
                      </form>
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                      {r.unpaidDays > 0 ? r.unpaidDays : '—'}
                    </td>
                  </tr>
                ))}
                {inputs.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">
                      No active employees for this period.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {batch.status !== 'draft' && (
        <div className="grid grid-cols-2 divide-x divide-border rounded-lg border border-border sm:grid-cols-4">
          {(
            [
              ['Gross', totals.gross],
              ['Deductions', totals.deductions],
              ['Net pay', totals.net],
              ['Employer cost', totals.employerCost],
            ] as const
          ).map(([label, v]) => (
            <div key={label} className="p-4">
              <div className="text-xs text-muted-foreground">{label}</div>
              <div className="text-lg font-semibold tabular-nums">{rm(v)}</div>
            </div>
          ))}
        </div>
      )}

      <Card className="overflow-hidden">
        <SectionHeader title="Payslips" count={slips.length} />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Employee</th>
                <th className="px-4 py-2 text-right font-medium">Gross</th>
                <th className="px-4 py-2 text-right font-medium">Bonus</th>
                <th className="px-4 py-2 text-right font-medium">EPF</th>
                <th className="px-4 py-2 text-right font-medium">SOCSO</th>
                <th className="px-4 py-2 text-right font-medium">EIS</th>
                <th className="px-4 py-2 text-right font-medium">PCB</th>
                <th className="px-4 py-2 text-right font-medium">Net</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {slips.map((sl) => {
                const st = sl.statutory as Record<string, number>;
                return (
                  <tr key={sl.id}>
                    <td className="px-4 py-2.5 font-medium">
                      {sl.name}
                      {sl.daysWorked != null && Number(sl.daysWorked) < periodDays && (
                        <span className="ml-2 text-xs font-normal text-amber-600 dark:text-amber-400">
                          prorated · {Number(sl.daysWorked)}/{periodDays} days
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{rm(sl.gross)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                      {Number(sl.bonus) > 0 ? rm(sl.bonus) : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{rm(st.epfEmployee)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{rm(st.socsoEmployee)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{rm(st.eisEmployee)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{rm(st.pcb)}</td>
                    <td className="px-4 py-2.5 text-right font-medium tabular-nums">{rm(sl.net)}</td>
                  </tr>
                );
              })}
              {slips.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">
                    No payslips yet — generate them.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
