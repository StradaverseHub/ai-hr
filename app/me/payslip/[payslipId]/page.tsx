import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getSession } from '@/lib/session';
import { payslipDetail } from '@/core/payroll';
import { Card } from '@/components/ui';
import { PrintButton } from '@/components/print-button';

const rm = (n: unknown) =>
  `RM ${Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

type Stat = {
  epfEmployee?: number;
  epfEmployer?: number;
  socsoEmployee?: number;
  socsoEmployer?: number;
  eisEmployee?: number;
  eisEmployer?: number;
  pcb?: number;
};

function Row({ label, value, muted }: { label: string; value: React.ReactNode; muted?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border/60 py-1.5 text-sm last:border-0">
      <span className={muted ? 'text-muted-foreground' : ''}>{label}</span>
      <span className={`tabular-nums ${muted ? 'text-muted-foreground' : 'font-medium'}`}>{value}</span>
    </div>
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function PayslipPage({ params }: { params: Promise<{ payslipId: string }> }) {
  const { payslipId } = await params;
  if (!UUID.test(payslipId)) notFound(); // malformed id → 404, not a DB-error 500
  const s = await getSession();
  const p = await payslipDetail(s, payslipId);
  if (!p) notFound();
  const st = (p.statutory ?? {}) as Stat;

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div className="flex items-start justify-between gap-4 print:hidden">
        <Link href="/me" className="text-sm text-muted-foreground transition-colors hover:text-foreground">
          ← My workspace
        </Link>
        <PrintButton />
      </div>

      <Card className="space-y-5 p-6">
        <div className="flex items-start justify-between gap-4 border-b border-border pb-4">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Payslip · {p.payPeriod}</h1>
            <p className="text-sm text-muted-foreground">
              {p.employee} · {p.company}
            </p>
          </div>
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium capitalize text-muted-foreground">
            {p.status}
          </span>
        </div>

        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Earnings
          </h2>
          <Row label="Basic salary" value={rm(p.basic)} />
          <Row label="Allowances" value={rm(p.allowance)} />
          <Row label="Overtime" value={rm(p.overtime)} />
          <Row label="Bonus" value={rm(p.bonus)} />
          <div className="mt-2 flex items-baseline justify-between border-t border-border pt-2 text-sm font-semibold">
            <span>Gross pay</span>
            <span className="tabular-nums">{rm(p.gross)}</span>
          </div>
        </section>

        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Deductions (your share)
          </h2>
          <Row label="EPF / KWSP" value={rm(st.epfEmployee)} />
          <Row label="SOCSO / PERKESO" value={rm(st.socsoEmployee)} />
          <Row label="EIS / SIP" value={rm(st.eisEmployee)} />
          <Row label="PCB / MTD (income tax)" value={rm(st.pcb)} />
          {Number(p.otherDeductions) > 0 && <Row label="Other deductions" value={rm(p.otherDeductions)} />}
          <div className="mt-2 flex items-baseline justify-between border-t border-border pt-2 text-sm font-semibold">
            <span>Total deductions</span>
            <span className="tabular-nums">−{rm(p.totalDeductions)}</span>
          </div>
        </section>

        <div className="flex items-baseline justify-between rounded-lg bg-primary/5 px-4 py-3">
          <span className="text-sm font-semibold">Net pay</span>
          <span className="text-lg font-bold tabular-nums text-primary">{rm(p.net)}</span>
        </div>

        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Employer contributions (not deducted from you)
          </h2>
          <Row label="EPF / KWSP" value={rm(st.epfEmployer)} muted />
          <Row label="SOCSO / PERKESO" value={rm(st.socsoEmployer)} muted />
          <Row label="EIS / SIP" value={rm(st.eisEmployer)} muted />
          <Row label="Total employer cost" value={rm(p.employerCost)} muted />
        </section>

        {p.daysWorked != null && (
          <p className="text-xs text-muted-foreground">
            Prorated on {Number(p.daysWorked)} day(s) worked in this period.
          </p>
        )}
      </Card>
    </div>
  );
}
