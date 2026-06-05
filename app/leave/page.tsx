import { getSession } from '@/lib/session';
import { listEmployees, listLeaveTypes, listPendingLeave } from '@/core/read';
import { Card, Field, btnGhost, btnPrimary, inputCls } from '@/components/ui';
import { decideLeaveAction, requestLeaveAction } from './actions';

export default async function LeavePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await getSession();
  const { error } = await searchParams;
  const [employees, leaveTypes, pending] = await Promise.all([
    listEmployees(session),
    listLeaveTypes(session),
    listPendingLeave(session),
  ]);
  const active = employees.filter((e) => !e.terminatedOn);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <h1 className="text-xl font-semibold tracking-tight">Leave</h1>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
          {error}
        </div>
      )}

      <Card>
        <div className="border-b border-zinc-200 px-4 py-3 text-sm font-medium dark:border-zinc-800">
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
        <div className="border-b border-zinc-200 px-4 py-3 text-sm font-medium dark:border-zinc-800">
          Pending approvals
          <span className="ml-2 text-zinc-500">({pending.length})</span>
        </div>
        <table className="w-full text-sm">
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {pending.map((r) => (
              <tr key={r.id}>
                <td className="px-4 py-3">
                  <div className="font-medium text-zinc-900 dark:text-zinc-100">{r.employee}</div>
                  <div className="text-xs text-zinc-500">
                    {r.startDate} → {r.endDate} · {Number(r.days)} day{Number(r.days) === 1 ? '' : 's'}
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
                <td className="px-4 py-10 text-center text-zinc-500">No pending requests.</td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
