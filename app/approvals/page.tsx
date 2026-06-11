import { redirect } from 'next/navigation';
import { scopedSession } from '@/lib/scope';
import { isAdmin } from '@/lib/authz';
import { listLeaveRequests } from '@/core/read';
import { listAttendanceCorrections } from '@/core/attendance';
import { listProfileChangeRequests } from '@/core/profile';
import { Button, Card, ErrorBanner, PageHeader, SectionHeader } from '@/components/ui';
import { approveCorrectionAction, approveLeaveAction, approveProfileChangeAction } from './actions';

function DecideButtons({
  action,
  id,
  disabled,
}: {
  action: (fd: FormData) => void | Promise<void>;
  id: string;
  disabled?: boolean;
}) {
  if (disabled) {
    return <span className="text-xs text-muted-foreground">your request</span>;
  }
  return (
    <div className="flex items-center justify-end gap-2">
      <form action={action}>
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="decision" value="approved" />
        <Button type="submit" size="sm">
          Approve
        </Button>
      </form>
      <form action={action}>
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="decision" value="rejected" />
        <Button type="submit" size="sm" variant="outline">
          Reject
        </Button>
      </form>
    </div>
  );
}

/** One inbox for everything awaiting a decision: leave, attendance corrections and (admin-only)
 *  profile changes. The decide authz lives in the services — this page only assembles the
 *  queues; RLS already trims each list to what the viewer may see. */
export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { s, scopeIds } = await scopedSession();
  const admin = isAdmin(s);
  const manager = (s.roles ?? []).includes('manager');
  if (!admin && !manager) redirect('/');
  const { error } = await searchParams;

  const [leave, corrections, profileChanges] = await Promise.all([
    listLeaveRequests(s, scopeIds),
    listAttendanceCorrections(s, { companyIds: scopeIds, status: 'pending' }),
    admin ? listProfileChangeRequests(s, { companyIds: scopeIds, status: 'pending' }) : Promise.resolve([]),
  ]);
  const pendingLeave = leave.filter((r) => r.status === 'pending');
  const mine = (personId: string | null) => s.personId != null && personId === s.personId;
  const total = pendingLeave.length + corrections.length + profileChanges.length;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title="Approvals"
        description={total === 0 ? 'Nothing waiting on you' : `${total} item(s) awaiting a decision`}
      />
      <ErrorBanner message={error} />

      <Card className="overflow-hidden">
        <SectionHeader title="Leave requests" count={pendingLeave.length} />
        {pendingLeave.length === 0 ? (
          <p className="px-4 py-5 text-center text-sm text-muted-foreground">No pending leave.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Employee</th>
                <th className="px-4 py-2 font-medium">Type</th>
                <th className="px-4 py-2 font-medium">Dates</th>
                <th className="px-4 py-2 text-right font-medium">Days</th>
                <th className="px-4 py-2 text-right font-medium">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {pendingLeave.map((r) => (
                <tr key={r.id}>
                  <td className="px-4 py-2.5 font-medium">{r.employee}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">{r.leaveType}</td>
                  <td className="px-4 py-2.5 tabular-nums text-muted-foreground">
                    {r.startDate} → {r.endDate}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{Number(r.days)}</td>
                  <td className="px-4 py-2.5">
                    <DecideButtons action={approveLeaveAction} id={r.id} disabled={mine(r.personId)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card className="overflow-hidden">
        <SectionHeader title="Attendance corrections" count={corrections.length} />
        {corrections.length === 0 ? (
          <p className="px-4 py-5 text-center text-sm text-muted-foreground">No pending corrections.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Employee</th>
                <th className="px-4 py-2 font-medium">Date</th>
                <th className="px-4 py-2 font-medium">Proposed</th>
                <th className="px-4 py-2 font-medium">Reason</th>
                <th className="px-4 py-2 text-right font-medium">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {corrections.map((c) => (
                <tr key={c.id}>
                  <td className="px-4 py-2.5 font-medium">{c.employee}</td>
                  <td className="px-4 py-2.5 tabular-nums text-muted-foreground">{c.attendanceDate}</td>
                  <td className="px-4 py-2.5 tabular-nums text-muted-foreground">
                    {c.proposedCheckIn.slice(0, 5)}
                    {c.proposedCheckOut ? ` → ${c.proposedCheckOut.slice(0, 5)}` : ''}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">{c.reason ?? '—'}</td>
                  <td className="px-4 py-2.5">
                    <DecideButtons action={approveCorrectionAction} id={c.id} disabled={mine(c.personId)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {admin && (
        <Card className="overflow-hidden">
          <SectionHeader title="Profile changes (bank / tax)" count={profileChanges.length} />
          {profileChanges.length === 0 ? (
            <p className="px-4 py-5 text-center text-sm text-muted-foreground">No pending changes.</p>
          ) : (
            <ul className="divide-y divide-border">
              {profileChanges.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{r.employee}</div>
                    <div className="text-xs text-muted-foreground">
                      {Object.entries((r.proposed ?? {}) as Record<string, unknown>)
                        .map(([k, v]) => `${k} → ${v}`)
                        .join(' · ')}
                    </div>
                  </div>
                  <DecideButtons action={approveProfileChangeAction} id={r.id} disabled={mine(r.personId)} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}
