import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getSession } from '@/lib/session';
import {
  assignmentHistory,
  employeeDetail,
  leaveBalances,
  leaveRequestsFor,
  listDepartments,
  listEmployees,
  reportingLinesFor,
} from '@/core/read';
import { Card, ErrorBanner, Field, SectionHeader, StatusBadge, btnGhost, btnPrimary, inputCls } from '@/components/ui';
import {
  addReportingLineAction,
  endReportingLineAction,
  terminateAction,
  transferAction,
} from './actions';

const LEAVE_STATUS: Record<string, string> = {
  pending: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  approved: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  rejected: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400',
  cancelled: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
};

function LeaveStatus({ status }: { status: string }) {
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium capitalize ${LEAVE_STATUS[status] ?? ''}`}>
      {status}
    </span>
  );
}

function LineTypeBadge({ type }: { type: string }) {
  return (
    <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
      {type === 'dotted' ? 'dotted-line' : type}
    </span>
  );
}

export default async function EmployeePage({
  params,
  searchParams,
}: {
  params: Promise<{ employmentId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const s = await getSession();
  const { employmentId } = await params;
  const { error } = await searchParams;

  const emp = await employeeDetail(s, employmentId);
  if (!emp) notFound();

  const [history, balances, requests, departments, reporting, employees] = await Promise.all([
    assignmentHistory(s, employmentId),
    leaveBalances(s, employmentId),
    leaveRequestsFor(s, employmentId),
    listDepartments(s),
    reportingLinesFor(s, employmentId),
    listEmployees(s),
  ]);
  const current = history.find((h) => !h.validTo) ?? history[0];
  const others = employees.filter((e) => e.employmentId !== employmentId && !e.terminatedOn);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Link href="/people" className="text-sm text-zinc-500 transition-colors hover:text-zinc-900 dark:hover:text-zinc-200">
        ← People
      </Link>

      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{emp.name}</h1>
          <p className="text-sm text-zinc-500">
            {emp.email} · {emp.company} · hired {emp.hiredOn}
          </p>
        </div>
        <StatusBadge status={emp.terminatedOn ? 'terminated' : (current?.status ?? null)} />
      </div>

      <ErrorBanner message={error} />

      <Card>
        <SectionHeader title="Leave balance" />
        <div className="grid grid-cols-1 divide-y divide-zinc-100 sm:grid-cols-3 sm:divide-x sm:divide-y-0 dark:divide-zinc-800">
          {balances.map((b) => (
            <div key={b.leaveTypeId} className="p-4">
              <div className="text-xs text-zinc-500">{b.leaveType}</div>
              <div className="text-2xl font-semibold tabular-nums">{b.balance}</div>
              <div className="text-xs text-zinc-500">
                {b.accrued} accrued · {b.taken} taken
              </div>
            </div>
          ))}
          {balances.length === 0 && <div className="p-4 text-sm text-zinc-500">No leave records.</div>}
        </div>
      </Card>

      <Card className="overflow-hidden">
        <SectionHeader title="Assignment history" count={history.length} />
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900/50 dark:text-zinc-400">
            <tr>
              <th className="px-4 py-2 font-medium">Period (valid time)</th>
              <th className="px-4 py-2 font-medium">Department</th>
              <th className="px-4 py-2 font-medium">Position</th>
              <th className="px-4 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {history.map((h) => (
              <tr key={h.id} className={!h.validTo ? 'bg-indigo-50/40 dark:bg-indigo-500/5' : ''}>
                <td className="px-4 py-2.5 font-mono text-xs">
                  {h.validFrom} → {h.validTo ?? 'present'}
                </td>
                <td className="px-4 py-2.5 text-zinc-700 dark:text-zinc-300">{h.department ?? '—'}</td>
                <td className="px-4 py-2.5 text-zinc-500">{h.position ?? '—'}</td>
                <td className="px-4 py-2.5">
                  <StatusBadge status={h.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card>
        <SectionHeader title="Reporting lines" />
        <div className="grid grid-cols-1 divide-zinc-100 sm:grid-cols-2 sm:divide-x dark:divide-zinc-800">
          <div className="p-4">
            <div className="mb-3 text-xs font-medium uppercase tracking-wide text-zinc-400">Reports to</div>
            {reporting.managers.length === 0 ? (
              <div className="text-sm text-zinc-500">No managers.</div>
            ) : (
              <ul className="space-y-2">
                {reporting.managers.map((m) => (
                  <li key={m.id} className="flex items-center justify-between text-sm">
                    <span className="flex items-center gap-2">
                      <Link
                        href={`/people/${m.employmentId}`}
                        className="text-zinc-800 hover:text-indigo-600 dark:text-zinc-200 dark:hover:text-indigo-400"
                      >
                        {m.name}
                      </Link>
                      <LineTypeBadge type={m.lineType} />
                    </span>
                    <form action={endReportingLineAction}>
                      <input type="hidden" name="employmentId" value={emp.employmentId} />
                      <input type="hidden" name="reportingLineId" value={m.id} />
                      <input type="hidden" name="endDate" value="2026-06-05" />
                      <button type="submit" title="End reporting line" className="text-zinc-400 transition-colors hover:text-red-500">
                        ×
                      </button>
                    </form>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="p-4">
            <div className="mb-3 text-xs font-medium uppercase tracking-wide text-zinc-400">Direct reports</div>
            {reporting.reports.length === 0 ? (
              <div className="text-sm text-zinc-500">No direct reports.</div>
            ) : (
              <ul className="space-y-2">
                {reporting.reports.map((r) => (
                  <li key={r.id} className="flex items-center gap-2 text-sm">
                    <Link
                      href={`/people/${r.employmentId}`}
                      className="text-zinc-800 hover:text-indigo-600 dark:text-zinc-200 dark:hover:text-indigo-400"
                    >
                      {r.name}
                    </Link>
                    <LineTypeBadge type={r.lineType} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        {!emp.terminatedOn && others.length > 0 && (
          <form
            action={addReportingLineAction}
            className="grid grid-cols-1 items-end gap-3 border-t border-zinc-200 p-4 sm:grid-cols-4 dark:border-zinc-800"
          >
            <input type="hidden" name="employmentId" value={emp.employmentId} />
            <input type="hidden" name="validFrom" value="2026-06-05" />
            <Field label="Manager">
              <select name="managerEmploymentId" required className={inputCls}>
                {others.map((o) => (
                  <option key={o.employmentId} value={o.employmentId}>
                    {o.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Line type">
              <select name="lineType" defaultValue="administrative" className={inputCls}>
                <option value="administrative">Administrative</option>
                <option value="functional">Functional</option>
                <option value="project">Project</option>
                <option value="dotted">Dotted-line</option>
              </select>
            </Field>
            <div className="sm:col-span-2">
              <button className={btnPrimary}>Add reporting line</button>
            </div>
          </form>
        )}
      </Card>

      {!emp.terminatedOn && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Card>
            <SectionHeader title="Transfer (effective-dated)" />
            <form action={transferAction} className="grid grid-cols-1 items-end gap-3 p-4 sm:grid-cols-2">
              <input type="hidden" name="employmentId" value={emp.employmentId} />
              <Field label="New department">
                <select name="departmentId" required className={inputCls}>
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Effective date">
                <input name="effectiveDate" type="date" required defaultValue="2026-06-05" className={inputCls} />
              </Field>
              <div className="sm:col-span-2">
                <button className={btnPrimary}>Transfer</button>
              </div>
            </form>
          </Card>

          <Card>
            <SectionHeader title="Terminate" />
            <form action={terminateAction} className="grid grid-cols-1 items-end gap-3 p-4 sm:grid-cols-2">
              <input type="hidden" name="employmentId" value={emp.employmentId} />
              <Field label="Termination date">
                <input name="terminationDate" type="date" required defaultValue="2026-06-30" className={inputCls} />
              </Field>
              <div className="sm:col-span-2">
                <button className={btnGhost}>Terminate employment</button>
              </div>
            </form>
          </Card>
        </div>
      )}

      <Card className="overflow-hidden">
        <SectionHeader title="Leave requests" count={requests.length} />
        <table className="w-full text-sm">
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {requests.map((r) => (
              <tr key={r.id}>
                <td className="px-4 py-2.5 text-zinc-700 dark:text-zinc-300">{r.leaveType}</td>
                <td className="px-4 py-2.5 text-zinc-500">
                  {r.startDate} → {r.endDate}
                </td>
                <td className="px-4 py-2.5 tabular-nums">{Number(r.days)} days</td>
                <td className="px-4 py-2.5">
                  <LeaveStatus status={r.status} />
                </td>
              </tr>
            ))}
            {requests.length === 0 && (
              <tr>
                <td className="px-4 py-6 text-center text-sm text-zinc-500">No leave requests.</td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
