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
import { myAttendanceCorrections } from '@/core/attendance';
import { myProfile, myProfileChangeRequests } from '@/core/profile';
import { myReviews } from '@/core/performance';
import { Button, Card, ErrorBanner, Field, PageHeader, SectionHeader, inputCls } from '@/components/ui';
import {
  myCheckIn,
  myCheckOut,
  myRequestCorrection,
  myRequestLeave,
  myRequestProfileChange,
  myUpdateContact,
} from './actions';

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

const PCB_LABEL: Record<number, string> = {
  1: 'Single',
  2: 'Married · spouse not working',
  3: 'Married · spouse working',
};
const PROPOSED_LABEL: Record<string, string> = {
  bankName: 'Bank name',
  bankAccountNo: 'Account no.',
  taxCategory: 'PCB category',
  numChildren: 'Children',
};
const maskAcct = (no?: string | null) =>
  no ? `•••• ${no.slice(-4)}` : '—';
function summarizeProposed(p: unknown): string {
  const o = (p ?? {}) as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => k in PROPOSED_LABEL);
  return keys.length ? keys.map((k) => PROPOSED_LABEL[k]).join(', ') : 'change';
}

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
  const [balances, requests, leaveTypes, payslips, attendance, corrections, profile, profileRequests, reviews] =
    await Promise.all([
      leaveBalances(s, me.employmentId),
      leaveRequestsFor(s, me.employmentId),
      listLeaveTypes(s),
      myPayslips(s, employments.map((e) => e.employmentId)),
      myAttendance(s, me.employmentId, 14),
      myAttendanceCorrections(s, me.employmentId),
      myProfile(s),
      myProfileChangeRequests(s, me.employmentId),
      myReviews(s),
    ]);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  const today = new Date().toISOString().slice(0, 10);
  const todayRow = attendance.find((a) => a.date === today);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title="My workspace"
        description={`${me.name}${me.employeeCode ? ` · ${me.employeeCode}` : ''} · ${me.position ?? '—'}, ${me.department ?? '—'}`}
      />

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
                <li key={a.id} className="flex items-center justify-between gap-2">
                  <span className="tabular-nums text-muted-foreground">{a.date}</span>
                  {a.workedMinutes != null && (
                    <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                      {Math.floor(a.workedMinutes / 60)}h {String(a.workedMinutes % 60).padStart(2, '0')}m
                      {(a.otMinutes ?? 0) > 0 && (
                        <span className="text-amber-600 dark:text-amber-400"> +OT</span>
                      )}
                    </span>
                  )}
                  <Pill status={a.status} map={ATT_STATUS} />
                </li>
              ))}
              {attendance.length === 0 && <li className="text-muted-foreground">No records yet.</li>}
            </ul>
          </div>

          {/* Missed-punch correction (manager/admin approves — ADR-0011 Phase B) */}
          <details className="mt-4 border-t border-border pt-4">
            <summary className="cursor-pointer select-none text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Fix a missed punch
            </summary>
            <form action={myRequestCorrection} className="mt-3 space-y-2.5">
              <Field label="Date">
                <input type="date" name="date" required defaultValue={yesterday} className={inputCls} />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Check-in">
                  <input type="time" name="checkIn" required defaultValue="09:00" className={inputCls} />
                </Field>
                <Field label="Check-out">
                  <input type="time" name="checkOut" defaultValue="18:00" className={inputCls} />
                </Field>
              </div>
              <Field label="Reason (optional)">
                <input name="reason" placeholder="Forgot to clock out" className={inputCls} />
              </Field>
              <Button type="submit" size="sm">
                Request correction
              </Button>
            </form>
            {corrections.length > 0 && (
              <ul className="mt-3 space-y-1.5 text-xs">
                {corrections.map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-2">
                    <span className="tabular-nums text-muted-foreground">
                      {c.attendanceDate} · {c.proposedCheckIn.slice(0, 5)}
                      {c.proposedCheckOut ? `–${c.proposedCheckOut.slice(0, 5)}` : ''}
                    </span>
                    <Pill status={c.status} map={LEAVE_STATUS} />
                  </li>
                ))}
              </ul>
            )}
          </details>
        </Card>

        {/* Leave */}
        <Card className="p-5">
          <h2 className="text-sm font-semibold">Leave</h2>
          <div className="mt-3 space-y-3">
            {balances.map((b) => {
              const pctUsed = b.accrued > 0 ? Math.min(100, (b.taken / b.accrued) * 100) : 0;
              const pctPending = b.accrued > 0 ? Math.min(100 - pctUsed, (b.pending / b.accrued) * 100) : 0;
              const tracked = b.accrued > 0 || b.balance > 0;
              return (
                <div key={b.leaveTypeId}>
                  <div className="flex items-baseline justify-between text-sm">
                    <span className="text-muted-foreground">{b.leaveType}</span>
                    <span className="font-semibold tabular-nums">
                      {tracked ? (
                        <>
                          {b.available}
                          <span className="font-normal text-muted-foreground"> / {b.accrued}</span>
                        </>
                      ) : (
                        <span className="font-normal text-muted-foreground">—</span>
                      )}
                    </span>
                  </div>
                  {tracked && (
                    /* Usage bar: solid = used, translucent = pending approval. */
                    <div className="mt-1.5 flex h-1.5 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-l-full bg-primary" style={{ width: `${pctUsed}%` }} />
                      <div className="h-full bg-primary/40" style={{ width: `${pctPending}%` }} />
                    </div>
                  )}
                  <div className="mt-1 text-xs text-muted-foreground">
                    {b.taken} used{b.pending > 0 ? ` · ${b.pending} pending` : ''}
                    {tracked ? ` · ${b.available} available` : ''}
                  </div>
                </div>
              );
            })}
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

      {/* My details — contact self-edit (direct) + pay-affecting changes (approval-gated, ADR-0012) */}
      <Card className="p-5">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div>
            <h2 className="text-sm font-semibold">My details</h2>
            <p className="text-xs text-muted-foreground">Contact info updates immediately.</p>
            <form action={myUpdateContact} className="mt-3 space-y-3">
              <Field label="Phone">
                <input name="phone" defaultValue={profile?.person?.phone ?? ''} className={inputCls} />
              </Field>
              <Field label="Address">
                <input name="address" defaultValue={profile?.person?.address ?? ''} className={inputCls} />
              </Field>
              <Field label="Date of birth">
                <input
                  type="date"
                  name="dateOfBirth"
                  defaultValue={profile?.person?.dateOfBirth ?? ''}
                  className={inputCls}
                />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Emergency contact">
                  <input
                    name="emergencyContactName"
                    defaultValue={profile?.person?.emergencyContactName ?? ''}
                    className={inputCls}
                  />
                </Field>
                <Field label="Emergency phone">
                  <input
                    name="emergencyContactPhone"
                    defaultValue={profile?.person?.emergencyContactPhone ?? ''}
                    className={inputCls}
                  />
                </Field>
              </div>
              <Button type="submit" size="sm">
                Save details
              </Button>
            </form>
          </div>

          <div className="lg:border-l lg:border-border lg:pl-6">
            <h2 className="text-sm font-semibold">Bank &amp; tax</h2>
            <p className="text-xs text-muted-foreground">
              Changes need admin approval before they affect your pay.
            </p>
            <dl className="mt-3 space-y-2 text-sm">
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">Bank</dt>
                <dd>{profile?.statutory?.bankName ?? '—'}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">Account</dt>
                <dd className="tabular-nums">{maskAcct(profile?.statutory?.bankAccountNo)}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">PCB category</dt>
                <dd>{PCB_LABEL[profile?.statutory?.taxCategory ?? 1]}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">Dependent children</dt>
                <dd className="tabular-nums">{profile?.statutory?.numChildren ?? 0}</dd>
              </div>
            </dl>

            <details className="mt-4 border-t border-border pt-3">
              <summary className="cursor-pointer select-none text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Request a change
              </summary>
              <form action={myRequestProfileChange} className="mt-3 space-y-2.5">
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Bank name">
                    <input name="bankName" placeholder="Maybank" className={inputCls} />
                  </Field>
                  <Field label="Account no.">
                    <input name="bankAccountNo" placeholder="1234567890" className={inputCls} />
                  </Field>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="PCB category">
                    <select name="taxCategory" defaultValue="" className={inputCls}>
                      <option value="">— no change —</option>
                      <option value="1">1 · Single</option>
                      <option value="2">2 · Married, spouse not working</option>
                      <option value="3">3 · Married, spouse working</option>
                    </select>
                  </Field>
                  <Field label="Dependent children">
                    <input type="number" name="numChildren" min="0" placeholder="—" className={inputCls} />
                  </Field>
                </div>
                <p className="text-xs text-muted-foreground">Leave a field blank to keep it unchanged.</p>
                <Button type="submit" size="sm">
                  Submit for approval
                </Button>
              </form>
              {profileRequests.length > 0 && (
                <ul className="mt-3 space-y-1.5 text-xs">
                  {profileRequests.map((r) => (
                    <li key={r.id} className="flex items-center justify-between gap-2">
                      <span className="truncate text-muted-foreground">{summarizeProposed(r.proposed)}</span>
                      <Pill status={r.status} map={LEAVE_STATUS} />
                    </li>
                  ))}
                </ul>
              )}
            </details>
          </div>
        </div>
      </Card>

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
                  <td className="px-4 py-2.5 font-medium">
                    <Link href={`/me/payslip/${p.id}`} className="text-primary hover:underline">
                      {p.payPeriod}
                    </Link>
                  </td>
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

      {/* Performance reviews */}
      {reviews.length > 0 && (
        <Card className="overflow-hidden">
          <SectionHeader title="My reviews" count={reviews.length} />
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Cycle</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 text-center font-medium">Overall</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {reviews.map((r) => {
                // Employee-facing status: their own perspective, not the raw enum.
                const label =
                  r.status === 'self_review'
                    ? 'Action needed: self-review'
                    : r.status === 'manager_review'
                      ? 'With your manager'
                      : r.status === 'submitted'
                        ? r.released
                          ? 'Ready to acknowledge'
                          : 'Awaiting release'
                        : 'Acknowledged';
                const action =
                  r.status === 'self_review'
                    ? 'Self-review →'
                    : r.status === 'submitted' && r.released
                      ? 'Acknowledge →'
                      : r.released || r.status === 'acknowledged'
                        ? 'View →'
                        : null; // nothing to do yet (with manager / awaiting release)
                return (
                  <tr key={r.reviewId}>
                    <td className="px-4 py-2.5 font-medium">{r.cycleName}</td>
                    <td className="px-4 py-2.5 text-muted-foreground">{label}</td>
                    <td className="px-4 py-2.5 text-center tabular-nums">
                      {r.released && r.overallRating != null ? r.overallRating : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {action ? (
                        <Link href={`/performance/review/${r.reviewId}`} className="text-xs text-primary hover:underline">
                          {action}
                        </Link>
                      ) : (
                        <span className="text-xs text-muted-foreground">no action needed</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

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
