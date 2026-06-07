import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';
import { batchDetail } from '@/core/payroll';
import { Button, Card, ErrorBanner, SectionHeader } from '@/components/ui';
import { closeAction, generateAction } from '../actions';

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

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <Link href="/payroll" className="text-sm text-muted-foreground transition-colors hover:text-foreground">
        ← Payroll
      </Link>

      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{batch.payPeriod}</h1>
          <p className="text-sm text-muted-foreground">
            Payroll batch · <span className="capitalize">{batch.status}</span>
          </p>
        </div>
        <div className="flex gap-2">
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
        </div>
      </div>

      <ErrorBanner message={error} />

      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
        ⚠️ Figures use the <span className="font-medium">official 2026 LHDN / PERKESO tables</span> but still require
        accountant sign-off before real use. PCB now uses each employee&apos;s tax profile (category + children) and pay is
        prorated for mid-month joiners/leavers. Remaining simplifications: the SOCSO RM5,000–6,000 ceiling band and EIS
        are rate-based; bonuses are not yet in the MTD additional-remuneration formula; overtime / unpaid-leave inputs are
        not yet captured. See <span className="font-mono">docs/architecture/STATUTORY-SOURCES.md</span>.
      </div>

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
                    <td className="px-4 py-2.5 font-medium">{sl.name}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{rm(sl.gross)}</td>
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
                  <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
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
