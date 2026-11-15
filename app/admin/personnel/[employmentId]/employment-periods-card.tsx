// Board 511aa74a — the Employment Periods card: each employment period of this person (core/rehire.ts
// employmentPeriods, already authorized and bounded), newest first, so a previous period is one click away.
// Pure presentation: every label arrives translated and every date pre-formatted from the server page.
import Link from 'next/link';
import { StatusBadge } from '@/components/ui';
import type { EmploymentStatus } from '@/core/employment-status';

export type EmploymentPeriodRow = {
  employmentId: string;
  employeeCode: string | null;
  companyName: string | null;
  dates: string;
  status: EmploymentStatus;
  statusLabel: string;
  periodLabel: string;
  note: string | null;
  noteHref: string | null;
  isThis: boolean;
};

export function EmploymentPeriodsCard({ title, columns, rows }: {
  title: string;
  columns: { period: string; employeeId: string; company: string; dates: string; status: string };
  rows: EmploymentPeriodRow[];
}) {
  return (
    <section id="section-employment-periods" aria-label={title} className="overflow-hidden rounded-xl border border-border bg-card">
      <h2 className="border-b border-border px-4 py-3 text-sm font-semibold text-foreground">{title}</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">{columns.period}</th>
              <th scope="col" className="px-4 py-2 font-medium">{columns.employeeId}</th>
              <th scope="col" className="px-4 py-2 font-medium">{columns.company}</th>
              <th scope="col" className="px-4 py-2 font-medium">{columns.dates}</th>
              <th scope="col" className="px-4 py-2 font-medium">{columns.status}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((row) => (
              <tr key={row.employmentId} data-employment-period={row.employmentId} aria-current={row.isThis ? 'true' : undefined} className={row.isThis ? 'bg-accent/40' : undefined}>
                <td className="px-4 py-2.5">{row.periodLabel}</td>
                <td className="px-4 py-2.5 font-mono text-xs">
                  {row.isThis ? (row.employeeCode ?? '—') : (
                    <Link href={`/admin/personnel/${row.employmentId}?tab=careerMovement`} className="text-primary hover:underline">{row.employeeCode ?? '—'}</Link>
                  )}
                  {row.note && (
                    <span className="mt-0.5 block font-sans text-xs text-muted-foreground">
                      {row.noteHref ? <Link href={row.noteHref} className="text-primary hover:underline">{row.note}</Link> : row.note}
                    </span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-muted-foreground">{row.companyName ?? '—'}</td>
                <td className="px-4 py-2.5 whitespace-nowrap">{row.dates}</td>
                <td className="px-4 py-2.5"><StatusBadge status={row.status} label={row.statusLabel} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
