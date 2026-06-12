import Link from 'next/link';
import { CalendarCheck2, CheckCircle2, Clock, XCircle, type LucideIcon } from 'lucide-react';
import { scopedSession } from '@/lib/scope';
import { isAdmin } from '@/lib/authz';
import {
  leaveBalancesAll,
  listEmployees,
  listLeaveTypes,
  listLeaveRequests,
  plannedAbsences,
} from '@/core/read';
import { Avatar, Button, Card, Field, PageHeader, inputCls } from '@/components/ui';
import { PlannedAbsences, styleFor } from '@/components/planned-absences';
import { TimelineNav } from '@/components/timeline-nav';
import { decideLeaveAction, requestLeaveAction } from './actions';

const REQ_STATUS: Record<string, string> = {
  pending: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  approved: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  rejected: 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400',
};
const STATUSES = ['pending', 'approved', 'rejected'] as const;
type ReqStatus = (typeof STATUSES)[number];

export default async function LeavePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; abs?: string; status?: string }>;
}) {
  const { s: session, scopeIds } = await scopedSession();
  const admin = isAdmin(session);
  const today = new Date().toISOString().slice(0, 10);
  const sp = await searchParams;
  const statusFilter = STATUSES.includes(sp.status as ReqStatus) ? (sp.status as ReqStatus) : null;

  // Same 14-day window semantics as the dashboard: default starts 2 days before today,
  // ?abs=YYYY-MM-DD (timeline nav) overrides the window start.
  const now = new Date();
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const todayIso = new Date(todayMs).toISOString().slice(0, 10);
  const ABS_DAYS = 14;
  const absParam = sp.abs && /^\d{4}-\d{2}-\d{2}$/.test(sp.abs) ? sp.abs : null;
  const startMs = absParam ? Date.parse(`${absParam}T00:00:00Z`) : todayMs - 2 * 86_400_000;
  const absFrom = new Date(startMs).toISOString().slice(0, 10);
  const absTo = new Date(startMs + (ABS_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);

  const [employees, leaveTypes, requests, absences, balances] = await Promise.all([
    listEmployees(session, scopeIds),
    listLeaveTypes(session),
    listLeaveRequests(session, scopeIds),
    plannedAbsences(session, scopeIds, { from: absFrom, to: absTo }),
    leaveBalancesAll(session, scopeIds),
  ]);
  const active = employees.filter((e) => !e.terminatedOn);

  // Balances are personal: admins see everyone in scope; everyone else sees ONLY their
  // own (RLS already prevents reading peers; managers' reports are filtered out here too).
  const visibleBalances = admin ? balances : balances.filter((b) => b.personId === session.personId);

  // Pivot balances: one row per employee, one column per leave type seen.
  const balTypes = [...new Map(visibleBalances.map((b) => [b.leaveTypeId, b.leaveType])).entries()].sort(
    (a, b) => a[1].localeCompare(b[1]),
  );
  const balByEmp = new Map<string, { name: string; cells: Map<string, (typeof balances)[number]> }>();
  for (const b of visibleBalances) {
    const e = balByEmp.get(b.employmentId) ?? { name: b.name, cells: new Map() };
    e.cells.set(b.leaveTypeId, b);
    balByEmp.set(b.employmentId, e);
  }

  // Status chips (reference-style) — counts over what the viewer may see; chips filter the table.
  const counts = {
    pending: requests.filter((r) => r.status === 'pending').length,
    approved: requests.filter((r) => r.status === 'approved').length,
    rejected: requests.filter((r) => r.status === 'rejected').length,
  };
  const chipHref = (status?: ReqStatus) => {
    const q = new URLSearchParams();
    if (absParam) q.set('abs', absParam);
    if (status) q.set('status', status);
    const qs = q.toString();
    return qs ? `/leave?${qs}` : '/leave';
  };
  const chips: { key?: ReqStatus; label: string; count: number; Icon: LucideIcon; active: boolean }[] = [
    { label: 'Requested', count: requests.length, Icon: CalendarCheck2, active: !statusFilter },
    { key: 'approved', label: 'Approved', count: counts.approved, Icon: CheckCircle2, active: statusFilter === 'approved' },
    { key: 'pending', label: 'Pending', count: counts.pending, Icon: Clock, active: statusFilter === 'pending' },
    { key: 'rejected', label: 'Rejected', count: counts.rejected, Icon: XCircle, active: statusFilter === 'rejected' },
  ];
  const filtered = statusFilter ? requests.filter((r) => r.status === statusFilter) : requests;
  const showActions = filtered.some(
    (r) => r.status === 'pending' && (admin || (session.personId && r.personId !== session.personId)),
  );

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title="Leave" description="Request leave and approve pending requests" />

      <PlannedAbsences
        rows={absences}
        from={absFrom}
        days={ABS_DAYS}
        todayIso={todayIso}
        controls={<TimelineNav from={absFrom} isDefault={!absParam} basePath="/leave" />}
      />

      {sp.error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
          {sp.error}
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {chips.map((c) => (
          <Link
            key={c.label}
            href={chipHref(c.key)}
            className={`rounded-[1.25rem] border bg-card p-4 shadow-[var(--shadow-card)] transition-colors ${
              c.active ? 'border-primary/60 ring-1 ring-primary/40' : 'border-border hover:border-primary/40'
            }`}
          >
            <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              <c.Icon className="size-3.5" />
              {c.label}
            </div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">{c.count}</div>
          </Link>
        ))}
      </div>

      <Card className="overflow-hidden">
        <div className="border-b border-border px-4 py-3 text-sm font-medium">
          {admin ? 'Balances' : 'My balances'}
          <span className="ml-2 font-normal text-muted-foreground">available / entitled</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Employee</th>
                {balTypes.map(([id, name]) => (
                  <th key={id} className="px-4 py-2 text-right font-medium">
                    {name.replace(/\s*leave$/i, '')}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {[...balByEmp.entries()].map(([empId, e]) => (
                <tr key={empId}>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2.5">
                      <Avatar name={e.name} className="size-7 text-[10px]" />
                      <span className="font-medium">{e.name}</span>
                    </div>
                  </td>
                  {balTypes.map(([typeId]) => {
                    const b = e.cells.get(typeId);
                    return (
                      <td
                        key={typeId}
                        className="px-4 py-2.5 text-right tabular-nums"
                        title={b ? `${b.taken} used · ${b.pending} pending approval` : undefined}
                      >
                        {b ? (
                          <>
                            {b.accrued > 0 || b.balance > 0 ? (
                              <>
                                <span className={b.available <= 0 ? 'font-semibold text-rose-600 dark:text-rose-400' : 'font-semibold'}>
                                  {b.available}
                                </span>
                                <span className="text-muted-foreground"> / {b.accrued}</span>
                              </>
                            ) : (
                              // Non-accrued type (e.g. per-occurrence sick leave): no balance to show.
                              <span className="text-muted-foreground">—</span>
                            )}
                            {b.pending > 0 && (
                              <span className="ml-1 text-[10px] font-medium uppercase text-amber-600 dark:text-amber-400">
                                {b.pending} pend
                              </span>
                            )}
                          </>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
              {balByEmp.size === 0 && (
                <tr>
                  <td colSpan={1 + balTypes.length} className="px-4 py-8 text-center text-muted-foreground">
                    No leave records yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="border-b border-border px-4 py-3 text-sm font-medium">
          Requests
          <span className="ml-2 font-normal text-muted-foreground">
            {statusFilter ? `${statusFilter} · ${filtered.length}` : `${filtered.length} total`}
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Employee</th>
                <th className="px-4 py-2 font-medium">Applied</th>
                <th className="px-4 py-2 font-medium">Type</th>
                <th className="px-4 py-2 font-medium">Dates</th>
                <th className="px-4 py-2 text-right font-medium">Days</th>
                <th className="px-4 py-2 font-medium">Status</th>
                {showActions && <th className="px-4 py-2 text-right font-medium">Action</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map((r) => {
                const { chip, Icon } = styleFor(r.typeCode);
                const canAct =
                  r.status === 'pending' &&
                  (admin || (session.personId != null && r.personId !== session.personId));
                return (
                  <tr key={r.id}>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <Avatar name={r.employee} className="size-7 text-[10px]" />
                        <span className="font-medium">{r.employee}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-muted-foreground">
                      {r.appliedOn ? new Date(r.appliedOn).toISOString().slice(0, 10) : '—'}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${chip}`}>
                        <Icon className="size-3" />
                        {r.leaveType.replace(/\s*leave$/i, '')}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-muted-foreground">
                      {r.startDate} → {r.endDate}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{Number(r.days)}</td>
                    <td className="px-4 py-2.5">
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium capitalize ${REQ_STATUS[r.status] ?? 'bg-muted text-muted-foreground'}`}>
                        {r.status}
                      </span>
                    </td>
                    {showActions && (
                      <td className="px-4 py-2.5">
                        {canAct && (
                          <div className="flex justify-end gap-2">
                            <form action={decideLeaveAction}>
                              <input type="hidden" name="leaveRequestId" value={r.id} />
                              <input type="hidden" name="decision" value="approved" />
                              <Button type="submit" size="sm">
                                Approve
                              </Button>
                            </form>
                            <form action={decideLeaveAction}>
                              <input type="hidden" name="leaveRequestId" value={r.id} />
                              <input type="hidden" name="decision" value="rejected" />
                              <Button type="submit" size="sm" variant="outline">
                                Reject
                              </Button>
                            </form>
                          </div>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={showActions ? 7 : 6} className="px-4 py-10 text-center text-muted-foreground">
                    No {statusFilter ?? ''} requests.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <details>
          <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium">
            + Request leave
          </summary>
          <form action={requestLeaveAction} className="grid grid-cols-1 gap-4 border-t border-border p-4 sm:grid-cols-2">
            <Field label="Employee">
              <select name="employmentId" required className={inputCls}>
                {active.map((e) => (
                  <option key={e.employmentId} value={e.employmentId}>
                    {e.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Leave type">
              <select name="leaveTypeId" required className={inputCls}>
                {leaveTypes.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Start date">
              <input name="startDate" type="date" required defaultValue={today} className={inputCls} />
            </Field>
            <Field label="End date">
              <input name="endDate" type="date" required defaultValue={today} className={inputCls} />
            </Field>
            <Field label="Reason (optional)">
              <input name="reason" className={inputCls} placeholder="Family trip" />
            </Field>
            <div className="flex items-end">
              <Button type="submit">Submit request</Button>
            </div>
          </form>
        </details>
      </Card>
    </div>
  );
}
