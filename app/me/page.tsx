import Link from 'next/link';
import { getSession } from '@/lib/session';
import {
  leaveBalances,
  leaveRequestsFor,
  listLeaveTypes,
  myAttendance,
  myEmployment,
  myEmployments,
  myPayslips,
} from '@/core/read';
import { Button, Card, ErrorBanner, Field, SectionHeader, inputCls } from '@/components/ui';
import { myCheckIn, myCheckOut, myRequestLeave } from './actions';

const rm = (n: unknown) =>
  `RM ${Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const LEAVE_STATUS: Record<string, string> = {
  pending: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  approved: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  rejected: 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400',
};
const ATT_STATUS: Record<string, string> = {
  present: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  late: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  half_day: 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400',
  absent: 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400',
};

function Pill({ status, map }: { status: string; map: Record<string, string> }) {
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium capitalize ${map[status] ?? 'bg-muted text-muted-foreground'}`}>
      {status.replace('_', ' ')}
    </span>
  );
}

export default async function MePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const s = await getSession();
  const { error } = await searchParams;
  const me = await myEmployment(s);

  if (!me) {
    return (
      <div className="mx-auto max-w-2xl">
        <Card className="p-8 text-center">
          <h1 className="text-lg font-semibold">My workspace</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            This account isn’t linked to an employee profile. Use the identity switcher in the top
            bar to act as an employee (e.g. Aisyah or Daniel).
          </p>
        </Card>
      </div>
    );
  }

  const employments = await myEmployments(s);
  const [balances, requests, leaveTypes, payslips, attendance] = await Promise.all([
    leaveBalances(s, me.employmentId),
    leaveRequestsFor(s, me.employmentId),
    listLeaveTypes(s),
    myPayslips(s, employments.map((e) => e.employmentId)),
    myAttendance(s, me.employmentId, 14),
  ]);

  const today = new Date().toISOString().slice(0, 10);
  const todayRow = attendance.find((a) => a.date === today);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">My workspace</h1>
        <p className="text-sm text-muted-foreground">
          {me.name}
          {me.employeeCode ? ` · ${me.employeeCode}` : ''} · {me.position ?? '—'},{' '}
          {me.department ?? '—'}
        </p>
      </div>

      <ErrorBanner message={error} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Attendance */}
        <Card className="p-5">
          <h2 className="text-sm font-semibold">Today</h2>
          <p className="text-xs text-muted-foreground">{today}</p>
          <div className="mt-4">
            {!todayRow ? (
              <form action={myCheckIn}>
                <Button type="submit" className="w-full">
                  Check in
                </Button>
              </form>
            ) : !todayRow.checkOutAt ? (
              <div className="space-y-3">
                <div className="text-sm text-muted-foreground">
                  Checked in at <span className="font-medium text-foreground">{todayRow.checkInAt}</span>{' '}
                  <Pill status={todayRow.status} map={ATT_STATUS} />
                </div>
                <form action={myCheckOut}>
                  <Button type="submit" variant="secondary" className="w-full">
                    Check out
                  </Button>
                </form>
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">
                {todayRow.checkInAt} → {todayRow.checkOutAt} <Pill status={todayRow.status} map={ATT_STATUS} />
              </div>
            )}
          </div>

          <div className="mt-5 border-t border-border pt-4">
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Recent
            </div>
            <ul className="space-y-1.5 text-sm">
              {attendance.slice(0, 6).map((a) => (
                <li key={a.id} className="flex items-center justify-between">
                  <span className="tabular-nums text-muted-foreground">{a.date}</span>
                  <Pill status={a.status} map={ATT_STATUS} />
                </li>
              ))}
              {attendance.length === 0 && <li className="text-muted-foreground">No records yet.</li>}
            </ul>
          </div>
        </Card>

        {/* Leave */}
        <Card className="p-5">
          <h2 className="text-sm font-semibold">Leave</h2>
          <div className="mt-3 space-y-1.5">
            {balances.map((b) => (
              <div key={b.leaveTypeId} className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{b.leaveType}</span>
                <span className="font-medium tabular-nums">{b.balance} days</span>
              </div>
            ))}
            {balances.length === 0 && <p className="text-sm text-muted-foreground">No balances yet.</p>}
          </div>

          <form action={myRequestLeave} className="mt-4 space-y-3 border-t border-border pt-4">
            <Field label="Type">
              <select name="leaveTypeId" required className={inputCls}>
                {leaveTypes.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="From">
                <input type="date" name="startDate" required className={inputCls} />
              </Field>
              <Field label="To">
                <input type="date" name="endDate" required className={inputCls} />
              </Field>
            </div>
            <Button type="submit" size="sm">
              Request leave
            </Button>
          </form>

          <div className="mt-4 border-t border-border pt-4">
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Requests
            </div>
            <ul className="space-y-1.5 text-sm">
              {requests.slice(0, 5).map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-2">
                  <span className="truncate text-muted-foreground">
                    {r.leaveType} · {r.startDate}
                  </span>
                  <Pill status={r.status} map={LEAVE_STATUS} />
                </li>
              ))}
              {requests.length === 0 && <li className="text-muted-foreground">No requests yet.</li>}
            </ul>
          </div>
        </Card>

        {/* My positions (concurrent multi-company, ADR-0009) */}
        <Card className="p-5">
          <h2 className="text-sm font-semibold">
            My position{employments.length > 1 ? 's' : ''}
          </h2>
          <p className="text-xs text-muted-foreground">Joined {me.hiredOn}</p>
          <ul className="mt-3 space-y-3">
            {employments.map((e) => {
              const alloc = (e.costAllocation as { companyId: string; percent: number }[] | null) ?? [];
              return (
                <li key={e.employmentId} className="rounded-lg border border-border p-3">
                  <div className="text-sm font-medium">{e.company}</div>
                  <div className="text-xs text-muted-foreground">
                    {e.position ?? '—'} · {e.department ?? '—'}
                  </div>
                  <div className="mt-1.5 flex justify-between text-xs">
                    <span className="text-muted-foreground">Basic + allowance</span>
                    <span className="tabular-nums">
                      {rm(Number(e.basic ?? 0) + Number(e.allowance ?? 0))}
                    </span>
                  </div>
                  {alloc.length > 0 && (
                    <div className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                      Cost recharged: {alloc.map((a) => `${a.percent}%`).join(' / ')}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      </div>

      {/* Payslips */}
      <Card className="overflow-hidden">
        <SectionHeader title="My payslips" count={payslips.length} />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Period</th>
                <th className="px-4 py-2 font-medium">Company</th>
                <th className="px-4 py-2 text-right font-medium">Gross</th>
                <th className="px-4 py-2 text-right font-medium">Deductions</th>
                <th className="px-4 py-2 text-right font-medium">Net</th>
                <th className="px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {payslips.map((p) => (
                <tr key={p.id}>
                  <td className="px-4 py-2.5 font-medium">{p.payPeriod}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">{p.company}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{rm(p.gross)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{rm(p.deductions)}</td>
                  <td className="px-4 py-2.5 text-right font-medium tabular-nums">{rm(p.net)}</td>
                  <td className="px-4 py-2.5 capitalize text-muted-foreground">{p.status}</td>
                </tr>
              ))}
              {payslips.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                    No payslips yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Annual tax statement (EA / C.P.8A) — self-serve for personal tax filing */}
      <Card className="p-5">
        <SectionHeader title="Tax statement (EA)" />
        <p className="px-1 pt-2 text-xs text-muted-foreground">
          Your annual statement of remuneration (Borang EA) for personal income-tax filing.
        </p>
        <ul className="mt-3 space-y-2">
          {employments.map((e) => (
            <li
              key={e.employmentId}
              className="flex items-center justify-between rounded-lg border border-border p-3 text-sm"
            >
              <span>
                {e.company} · <span className="text-muted-foreground">YA 2026</span>
              </span>
              <Link
                href={`/payroll/reports/ea/${e.employmentId}?year=2026`}
                className="text-primary hover:underline"
              >
                View / download
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
