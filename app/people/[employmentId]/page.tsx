import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getSession } from '@/lib/session';
import { isAdmin } from '@/lib/authz';
import {
  assignmentHistory,
  employeeDetail,
  leaveBalances,
  leaveRequestsFor,
  listDepartments,
  listEmployees,
  reportingLinesFor,
} from '@/core/read';
import { Card, ErrorBanner, Field, SectionHeader, StatusBadge, btnPrimary, inputCls } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import {
  addReportingLineAction,
  endReportingLineAction,
  setCompensationAction,
  setPersonAction,
  setStatutoryAction,
  terminateAction,
  transferAction,
} from './actions';
import { currentCompensation } from '@/core/comp';
import { getStatutoryProfileMY } from '@/localization/my/statutory';

const LEAVE_STATUS: Record<string, string> = {
  pending: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  approved: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  rejected: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400',
  cancelled: 'bg-muted text-muted-foreground',
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
    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
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
  const admin = isAdmin(s);
  const { employmentId } = await params;
  const { error } = await searchParams;

  const emp = await employeeDetail(s, employmentId);
  if (!emp) notFound();

  const [history, balances, requests, departments, reporting, employees, comp, statutory] =
    await Promise.all([
      assignmentHistory(s, employmentId),
      leaveBalances(s, employmentId),
      leaveRequestsFor(s, employmentId),
      listDepartments(s),
      reportingLinesFor(s, employmentId),
      listEmployees(s),
      currentCompensation(s, employmentId),
      getStatutoryProfileMY(s, emp.personId),
    ]);
  const current = history.find((h) => !h.validTo) ?? history[0];
  const others = employees.filter((e) => e.employmentId !== employmentId && !e.terminatedOn);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Link href="/people" className="text-sm text-muted-foreground transition-colors hover:text-foreground">
        ← People
      </Link>

      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{emp.name}</h1>
          <p className="text-sm text-muted-foreground">
            {emp.employeeCode ?? '—'} · {emp.email} · {emp.company} · hired {emp.hiredOn}
          </p>
        </div>
        <StatusBadge status={emp.terminatedOn ? 'terminated' : (current?.status ?? null)} />
      </div>

      <ErrorBanner message={error} />

      {admin && (
        <Card>
          <SectionHeader title="Personal details" />
          <form
            action={setPersonAction}
            className="grid grid-cols-1 items-end gap-3 p-4 sm:grid-cols-3"
          >
            <input type="hidden" name="employmentId" value={emp.employmentId} />
            <input type="hidden" name="personId" value={emp.personId} />
            <Field label="Full name">
              <input name="fullName" required defaultValue={emp.name} className={inputCls} />
            </Field>
            <Field label="Email">
              <input name="primaryEmail" type="email" required defaultValue={emp.email} className={inputCls} />
            </Field>
            <Field label="Phone">
              <input name="phone" defaultValue={emp.phone ?? ''} placeholder="+60…" className={inputCls} />
            </Field>
            <div className="sm:col-span-3 flex justify-end">
              <button className={btnPrimary}>Save details</button>
            </div>
          </form>
        </Card>
      )}

      <Card>
        <SectionHeader title="Leave balance" />
        <div className="grid grid-cols-1 divide-y divide-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          {balances.map((b) => (
            <div key={b.leaveTypeId} className="p-4">
              <div className="text-xs text-muted-foreground">{b.leaveType}</div>
              <div className="text-2xl font-semibold tabular-nums">{b.balance}</div>
              <div className="text-xs text-muted-foreground">
                {b.accrued} accrued · {b.taken} taken
              </div>
            </div>
          ))}
          {balances.length === 0 && <div className="p-4 text-sm text-muted-foreground">No leave records.</div>}
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <SectionHeader title="Compensation" />
          <div className="p-4">
            {comp ? (
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-2xl font-semibold tabular-nums">
                  {comp.currency} {Number(comp.basicSalary).toLocaleString()}
                </span>
                <span className="text-xs text-muted-foreground">
                  basic / mo
                  {Number(comp.monthlyAllowance) > 0 && ` · +${Number(comp.monthlyAllowance).toLocaleString()} allowance`}
                  {' · since '}
                  {comp.validFrom}
                </span>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No compensation set.</p>
            )}
          </div>
          {!emp.terminatedOn && (
            <form
              action={setCompensationAction}
              className="grid grid-cols-1 items-end gap-3 border-t border-border p-4 sm:grid-cols-3"
            >
              <input type="hidden" name="employmentId" value={emp.employmentId} />
              <input type="hidden" name="effectiveFrom" value="2026-06-05" />
              <Field label="Basic salary (MYR)">
                <input
                  name="basicSalary"
                  type="number"
                  min="0"
                  step="0.01"
                  required
                  defaultValue={comp ? Number(comp.basicSalary) : ''}
                  className={inputCls}
                />
              </Field>
              <Field label="Allowance">
                <input
                  name="monthlyAllowance"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={comp ? Number(comp.monthlyAllowance) : 0}
                  className={inputCls}
                />
              </Field>
              <button className={btnPrimary}>Update pay</button>
            </form>
          )}
        </Card>

        <Card>
          <SectionHeader title="Statutory (Malaysia)" />
          <form action={setStatutoryAction} className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
            <input type="hidden" name="employmentId" value={emp.employmentId} />
            <input type="hidden" name="personId" value={emp.personId} />
            <Field label="IC number">
              <input name="icNumber" required defaultValue={statutory?.icNumber ?? ''} placeholder="900101011234" className={inputCls} />
            </Field>
            <Field label="EPF number">
              <input name="epfNumber" defaultValue={statutory?.epfNumber ?? ''} className={inputCls} />
            </Field>
            <Field label="SOCSO number">
              <input name="socsoNumber" defaultValue={statutory?.socsoNumber ?? ''} className={inputCls} />
            </Field>
            <Field label="Tax number">
              <input name="taxNumber" defaultValue={statutory?.taxNumber ?? ''} className={inputCls} />
            </Field>
            <Field label="Bank">
              <input name="bankName" defaultValue={statutory?.bankName ?? ''} className={inputCls} />
            </Field>
            <Field label="Bank account">
              <input name="bankAccountNo" defaultValue={statutory?.bankAccountNo ?? ''} className={inputCls} />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="eisEligible" defaultChecked={statutory ? statutory.eisEligible : true} className="size-4 rounded" />
              EIS eligible
            </label>
            <div className="flex items-end justify-end">
              <button className={btnPrimary}>Save statutory</button>
            </div>
          </form>
        </Card>
      </div>

      <Card className="overflow-hidden">
        <SectionHeader title="Assignment history" count={history.length} />
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">Period (valid time)</th>
              <th className="px-4 py-2 font-medium">Department</th>
              <th className="px-4 py-2 font-medium">Position</th>
              <th className="px-4 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {history.map((h) => (
              <tr key={h.id} className={!h.validTo ? 'bg-primary/5' : ''}>
                <td className="px-4 py-2.5 font-mono text-xs">
                  {h.validFrom} → {h.validTo ?? 'present'}
                </td>
                <td className="px-4 py-2.5 text-foreground">{h.department ?? '—'}</td>
                <td className="px-4 py-2.5 text-muted-foreground">{h.position ?? '—'}</td>
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
        <div className="grid grid-cols-1 divide-border sm:grid-cols-2 sm:divide-x">
          <div className="p-4">
            <div className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">Reports to</div>
            {reporting.managers.length === 0 ? (
              <div className="text-sm text-muted-foreground">No managers.</div>
            ) : (
              <ul className="space-y-2">
                {reporting.managers.map((m) => (
                  <li key={m.id} className="flex items-center justify-between text-sm">
                    <span className="flex items-center gap-2">
                      <Link
                        href={`/people/${m.employmentId}`}
                        className="text-foreground hover:text-primary"
                      >
                        {m.name}
                      </Link>
                      <LineTypeBadge type={m.lineType} />
                    </span>
                    <form action={endReportingLineAction}>
                      <input type="hidden" name="employmentId" value={emp.employmentId} />
                      <input type="hidden" name="reportingLineId" value={m.id} />
                      <input type="hidden" name="endDate" value="2026-06-05" />
                      <button type="submit" title="End reporting line" className="text-muted-foreground transition-colors hover:text-red-500">
                        ×
                      </button>
                    </form>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="p-4">
            <div className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">Direct reports</div>
            {reporting.reports.length === 0 ? (
              <div className="text-sm text-muted-foreground">No direct reports.</div>
            ) : (
              <ul className="space-y-2">
                {reporting.reports.map((r) => (
                  <li key={r.id} className="flex items-center gap-2 text-sm">
                    <Link
                      href={`/people/${r.employmentId}`}
                      className="text-foreground hover:text-primary"
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
            className="grid grid-cols-1 items-end gap-3 border-t border-border p-4 sm:grid-cols-4"
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
                <ConfirmSubmit
                  title="Terminate employment?"
                  description={`This ends ${emp.name}'s employment on the chosen date. Assignment history is preserved.`}
                  confirmLabel="Terminate"
                  size="sm"
                >
                  Terminate employment
                </ConfirmSubmit>
              </div>
            </form>
          </Card>
        </div>
      )}

      <Card className="overflow-hidden">
        <SectionHeader title="Leave requests" count={requests.length} />
        <table className="w-full text-sm">
          <tbody className="divide-y divide-border">
            {requests.map((r) => (
              <tr key={r.id}>
                <td className="px-4 py-2.5 text-foreground">{r.leaveType}</td>
                <td className="px-4 py-2.5 text-muted-foreground">
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
                <td className="px-4 py-6 text-center text-sm text-muted-foreground">No leave requests.</td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
