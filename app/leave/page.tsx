import { scopedSession } from '@/lib/scope';
import {
  leaveBalancesAll,
  listEmployees,
  listLeaveTypes,
  listPendingLeave,
  plannedAbsences,
} from '@/core/read';
import { Avatar, Card, Field, PageHeader, btnGhost, btnPrimary, inputCls } from '@/components/ui';
import { PlannedAbsences } from '@/components/planned-absences';
import { TimelineNav } from '@/components/timeline-nav';
import { decideLeaveAction, requestLeaveAction } from './actions';

export default async function LeavePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; abs?: string }>;
}) {
  const { s: session, scopeIds } = await scopedSession();
  const { error, abs } = await searchParams;
  // Same 14-day window semantics as the dashboard: default starts 2 days before today,
  // ?abs=YYYY-MM-DD (timeline nav) overrides the window start.
  const now = new Date();
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const todayIso = new Date(todayMs).toISOString().slice(0, 10);
  const ABS_DAYS = 14;
  const absParam = abs && /^\d{4}-\d{2}-\d{2}$/.test(abs) ? abs : null;
  const startMs = absParam ? Date.parse(`${absParam}T00:00:00Z`) : todayMs - 2 * 86_400_000;
  const absFrom = new Date(startMs).toISOString().slice(0, 10);
  const absTo = new Date(startMs + (ABS_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
  const [employees, leaveTypes, pending, absences, balances] = await Promise.all([
    listEmployees(session, scopeIds),
    listLeaveTypes(session),
    listPendingLeave(session, scopeIds),
    plannedAbsences(session, scopeIds, { from: absFrom, to: absTo }),
    leaveBalancesAll(session, scopeIds),
  ]);
  const active = employees.filter((e) => !e.terminatedOn);
  // Pivot balances: one row per employee, one column per leave type seen in scope.
  const balTypes = [...new Map(balances.map((b) => [b.leaveTypeId, b.leaveType])).entries()].sort(
    (a, b) => a[1].localeCompare(b[1]),
  );
  const balByEmp = new Map<string, { name: string; cells: Map<string, (typeof balances)[number]> }>();
  for (const b of balances) {
    const e = balByEmp.get(b.employmentId) ?? { name: b.name, cells: new Map() };
    e.cells.set(b.leaveTypeId, b);
    balByEmp.set(b.employmentId, e);
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title="Leave" description="Request leave and approve pending requests" />

      <PlannedAbsences
        rows={absences}
        from={absFrom}
        days={ABS_DAYS}
        todayIso={todayIso}
        controls={<TimelineNav from={absFrom} isDefault={!absParam} basePath="/leave" />}
      />

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
          {error}
        </div>
      )}

      <Card className="overflow-hidden">
        <div className="border-b border-border px-4 py-3 text-sm font-medium">
          Balances
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

      <Card>
        <div className="border-b border-border px-4 py-3 text-sm font-medium">
          Request leave
        </div>
        <form
          action={requestLeaveAction}
          className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2"
        >
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
            <input name="startDate" type="date" required defaultValue="2026-07-01" className={inputCls} />
          </Field>
          <Field label="End date">
            <input name="endDate" type="date" required defaultValue="2026-07-03" className={inputCls} />
          </Field>
          <Field label="Reason (optional)">
            <input name="reason" className={inputCls} placeholder="Family trip" />
          </Field>
          <div className="flex items-end">
            <button type="submit" className={btnPrimary}>
              Submit request
            </button>
          </div>
        </form>
      </Card>

      <Card className="overflow-hidden">
        <div className="border-b border-border px-4 py-3 text-sm font-medium">
          Pending approvals
          <span className="ml-2 text-muted-foreground">({pending.length})</span>
        </div>
        <table className="w-full text-sm">
          <tbody className="divide-y divide-border">
            {pending.map((r) => (
              <tr key={r.id}>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <Avatar name={r.employee} />
                    <div className="min-w-0">
                      <div className="font-medium text-foreground">{r.employee}</div>
                      <div className="text-xs text-muted-foreground">
                        {r.startDate} → {r.endDate} · {Number(r.days)} day{Number(r.days) === 1 ? '' : 's'}
                      </div>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="inline-flex gap-2">
                    <form action={decideLeaveAction}>
                      <input type="hidden" name="leaveRequestId" value={r.id} />
                      <input type="hidden" name="decision" value="approved" />
                      <button type="submit" className={btnPrimary}>
                        Approve
                      </button>
                    </form>
                    <form action={decideLeaveAction}>
                      <input type="hidden" name="leaveRequestId" value={r.id} />
                      <input type="hidden" name="decision" value="rejected" />
                      <button type="submit" className={btnGhost}>
                        Reject
                      </button>
                    </form>
                  </div>
                </td>
              </tr>
            ))}
            {pending.length === 0 && (
              <tr>
                <td className="px-4 py-10 text-center text-muted-foreground">No pending requests.</td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
