import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getSession } from '@/lib/session';
import { employeeEaStatement } from '@/core/reporting';
import { Card } from '@/components/ui';
import { PrintButton } from '@/components/print-button';

const rm = (n: unknown) =>
  `RM ${Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const CATEGORY: Record<number, string> = {
  1: 'Category 1 — Single',
  2: 'Category 2 — Married, spouse not working',
  3: 'Category 3 — Married, spouse working',
};

function Row({ label, value, muted }: { label: string; value: React.ReactNode; muted?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border/60 py-1.5 text-sm last:border-0">
      <span className={muted ? 'text-muted-foreground' : ''}>{label}</span>
      <span className={`tabular-nums ${muted ? 'text-muted-foreground' : 'font-medium'}`}>{value}</span>
    </div>
  );
}

export default async function EaStatementPage({
  params,
  searchParams,
}: {
  params: Promise<{ employmentId: string }>;
  searchParams: Promise<{ year?: string }>;
}) {
  await getSession(); // ensure a session; the read is RLS-scoped to what this user may see
  const { employmentId } = await params;
  const { year } = await searchParams;
  const yr = year || '2026';
  const s = await getSession();
  const ea = await employeeEaStatement(s, { employmentId, year: yr });
  if (!ea) notFound();

  const period =
    ea.employee.hiredOn || ea.employee.terminatedOn
      ? `${ea.employee.hiredOn ?? '—'} → ${ea.employee.terminatedOn ?? 'present'}`
      : '—';

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div className="flex items-start justify-between gap-4 print:hidden">
        <Link href="/payroll/reports" className="text-sm text-muted-foreground transition-colors hover:text-foreground">
          ← Reports
        </Link>
        <PrintButton />
      </div>

      <Card className="space-y-5 p-6">
        <div className="border-b border-border pb-4">
          <h1 className="text-lg font-semibold tracking-tight">Statement of Remuneration · EA (C.P.8A)</h1>
          <p className="text-sm text-muted-foreground">
            Year ended 31 December {ea.year} · {ea.employer.name}
            {ea.employer.eNumber ? ` · E ${ea.employer.eNumber}` : ''}
          </p>
        </div>

        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            A · Employee particulars
          </h2>
          <Row label="Name" value={ea.employee.name} />
          <Row label="Income tax no. (TIN)" value={ea.employee.taxNo || '—'} />
          <Row label="IC no." value={ea.employee.ic || '—'} />
          <Row label="EPF no." value={ea.employee.epfNo || '—'} />
          <Row label="SOCSO no." value={ea.employee.socsoNo || '—'} />
          <Row label="MTD category" value={CATEGORY[ea.employee.category] ?? ea.employee.category} />
          <Row label="Children (tax relief)" value={ea.employee.children} />
          <Row label="Employment period" value={period} />
        </section>

        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            B · Employment income (cash)
          </h2>
          <Row label="1(a) Gross salary / wages (incl. overtime)" value={rm(ea.partB.grossSalary)} />
          <Row label="1(b) Bonus" value={rm(ea.partB.bonus)} />
          <Row label="1(c) Allowances / perquisites" value={rm(ea.partB.allowances)} />
          <Row label="3 Benefits in kind" value="not tracked" muted />
          <Row label="4 Value of living accommodation" value="not tracked" muted />
          <div className="mt-2 flex items-baseline justify-between border-t border-border pt-2 text-sm font-semibold">
            <span>Total gross remuneration</span>
            <span className="tabular-nums">{rm(ea.partB.gross)}</span>
          </div>
        </section>

        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            D · Total deductions
          </h2>
          <Row label="1 Monthly tax deduction (MTD / PCB)" value={rm(ea.partD.mtd)} />
          <Row label="2 CP38 deductions" value="not tracked" muted />
          <Row label="3 Zakat via salary deduction" value="not tracked" muted />
        </section>

        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            E · Contributions to approved fund & SOCSO (employee&apos;s share)
          </h2>
          <Row label="1 EPF / KWSP" value={rm(ea.partE.epf)} />
          <Row label="2 SOCSO" value={rm(ea.partE.socso)} />
          <Row label="EIS / SIP" value={rm(ea.partE.eis)} />
        </section>

        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            F · Total tax-exempt allowances / perquisites
          </h2>
          <Row label="Tax-exempt allowances" value="not tracked" muted />
        </section>

        <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-xs text-blue-800 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-300">
          ℹ️ Generated from payroll for YA {ea.year} (statutory tables {ea.statutoryVersion}). Covers cash
          remuneration, EPF, SOCSO/EIS and MTD. Benefits-in-kind, living accommodation, ESOS, gratuity,
          tax-exempt allowances, zakat and CP38 are not tracked in payroll — add any of these before filing.
          Verify against your records; this is not a substitute for the official LHDN form.
        </div>
      </Card>
    </div>
  );
}
