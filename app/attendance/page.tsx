import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { scopedSession } from '@/lib/scope';
import { attendanceForDate, attendanceMonthSummary, listAttendanceCorrections } from '@/core/attendance';
import { Avatar, Button, Card, ErrorBanner, PageHeader, SectionHeader, inputCls } from '@/components/ui';
import { TimelineNav } from '@/components/timeline-nav';
import { checkInAction, checkOutAction, decideCorrectionAction } from './actions';

const STATUS: Record<string, string> = {
  present: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  late: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  half_day: 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400',
  absent: 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400',
};
const CONTEXT: Record<string, { label: string; cls: string }> = {
  on_leave: { label: 'On leave', cls: 'bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300' },
  holiday: { label: 'Holiday', cls: 'bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300' },
  rest_day: { label: 'Rest day', cls: 'bg-muted text-muted-foreground' },
};

function Pill({ label, cls }: { label: string; cls: string }) {
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium capitalize ${cls}`}>{label}</span>
  );
}

const fmtMin = (m: number | null | undefined) =>
  m == null ? '—' : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
const fmtOt = (m: number | null | undefined) => (!m ? '—' : fmtMin(m));

const monthLabel = (month: string) =>
  new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
const shiftMonth = (month: string, by: number) => {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

export default async function AttendancePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; date?: string; month?: string }>;
}) {
  const { s, scopeIds } = await scopedSession();
  const sp = await searchParams;
  const todayIso = new Date().toISOString().slice(0, 10);
  const date = sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : todayIso;
  const month = sp.month && /^\d{4}-\d{2}$/.test(sp.month) ? sp.month : date.slice(0, 7);
  const [rows, summary, corrections] = await Promise.all([
    attendanceForDate(s, date, scopeIds),
    attendanceMonthSummary(s, { month, companyIds: scopeIds, today: todayIso }),
    listAttendanceCorrections(s, { companyIds: scopeIds, status: 'pending' }),
  ]);
  const monthHref = (m: string) => `/attendance?date=${date}&month=${m}`;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title="Attendance"
        actions={<TimelineNav from={date} isDefault={date === todayIso} basePath="/attendance" param="date" stepDays={1} />}
      />
      <ErrorBanner message={sp.error} />

      <Card className="overflow-hidden">
        <SectionHeader title={date === todayIso ? 'Today' : date} count={rows.length} />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Employee</th>
                <th className="px-4 py-2 font-medium">Check-in</th>
                <th className="px-4 py-2 font-medium">Check-out</th>
                <th className="px-4 py-2 text-right font-medium">Hours</th>
                <th className="px-4 py-2 text-right font-medium">Overtime</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 text-right font-medium">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <tr key={r.employmentId}>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2.5">
                      <Avatar name={r.name} className="size-7 text-[10px]" />
                      <span className="font-medium">{r.name}</span>
                    </div>
                  </td>
                  <td className="px-4 py-2.5 tabular-nums text-muted-foreground">
                    {r.checkInAt?.slice(0, 5) ?? '—'}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums text-muted-foreground">
                    {r.checkOutAt?.slice(0, 5) ?? '—'}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                    {fmtMin(r.workedMinutes)}
                  </td>
                  <td
                    className="px-4 py-2.5 text-right tabular-nums text-muted-foreground"
                    title={r.dayType && r.dayType !== 'workday' ? `OT class: ${r.dayType.replace('_', ' ')}` : undefined}
                  >
                    {fmtOt(r.otMinutes)}
                    {(r.otMinutes ?? 0) > 0 && r.dayType !== 'workday' && (
                      <span className="ml-1 text-[10px] uppercase text-amber-600 dark:text-amber-400">
                        {r.dayType === 'holiday' ? 'PH' : 'RD'}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    {r.attendanceId && r.status ? (
                      <Pill label={r.status.replace(/_/g, ' ')} cls={STATUS[r.status] ?? STATUS.absent} />
                    ) : r.context ? (
                      <Pill label={CONTEXT[r.context].label} cls={CONTEXT[r.context].cls} />
                    ) : (
                      <Pill label="absent" cls={STATUS.absent} />
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex justify-end">
                      {!r.attendanceId ? (
                        <form action={checkInAction} className="flex items-center gap-2">
                          <input type="hidden" name="employmentId" value={r.employmentId} />
                          <input type="hidden" name="date" value={date} />
                          <input name="time" type="time" defaultValue="09:00" className={`${inputCls} h-8 w-28`} />
                          <Button type="submit" size="sm">
                            Check in
                          </Button>
                        </form>
                      ) : !r.checkOutAt ? (
                        <form action={checkOutAction} className="flex items-center gap-2">
                          <input type="hidden" name="employmentId" value={r.employmentId} />
                          <input type="hidden" name="date" value={date} />
                          <input name="time" type="time" defaultValue="18:00" className={`${inputCls} h-8 w-28`} />
                          <Button type="submit" size="sm" variant="secondary">
                            Check out
                          </Button>
                        </form>
                      ) : (
                        <span className="text-xs text-muted-foreground">done</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {corrections.length > 0 && (
        <Card className="overflow-hidden">
          <SectionHeader title="Correction requests" count={corrections.length} />
          <div className="overflow-x-auto">
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
                {corrections.map((c) => {
                  // No self-approval (the service enforces it too — this just hides the buttons).
                  const canAct = s.personId == null || c.personId !== s.personId;
                  return (
                    <tr key={c.id}>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2.5">
                          <Avatar name={c.employee} className="size-7 text-[10px]" />
                          <span className="font-medium">{c.employee}</span>
                        </div>
                      </td>
                      <td className="px-4 py-2.5 tabular-nums text-muted-foreground">{c.attendanceDate}</td>
                      <td className="px-4 py-2.5 tabular-nums">
                        {c.proposedCheckIn.slice(0, 5)}
                        {c.proposedCheckOut ? ` → ${c.proposedCheckOut.slice(0, 5)}` : ''}
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">{c.reason ?? '—'}</td>
                      <td className="px-4 py-2.5">
                        {canAct ? (
                          <div className="flex justify-end gap-2">
                            <form action={decideCorrectionAction}>
                              <input type="hidden" name="correctionId" value={c.id} />
                              <input type="hidden" name="decision" value="approved" />
                              <Button type="submit" size="sm">
                                Approve
                              </Button>
                            </form>
                            <form action={decideCorrectionAction}>
                              <input type="hidden" name="correctionId" value={c.id} />
                              <input type="hidden" name="decision" value="rejected" />
                              <Button type="submit" size="sm" variant="outline">
                                Reject
                              </Button>
                            </form>
                          </div>
                        ) : (
                          <span className="flex justify-end text-xs text-muted-foreground">your request</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
            Approving amends the day&rsquo;s record (re-derived through the time engine, so corrected
            overtime flows to payroll). You cannot approve your own request.
          </p>
        </Card>
      )}

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="text-sm font-medium">
            Month summary
            <span className="ml-2 text-muted-foreground">{monthLabel(month)}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Link
              href={monthHref(shiftMonth(month, -1))}
              aria-label="Previous month"
              className="grid size-7 place-items-center rounded-lg border border-border bg-card text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <ChevronLeft className="size-4" />
            </Link>
            <Link
              href={monthHref(shiftMonth(month, 1))}
              aria-label="Next month"
              className="grid size-7 place-items-center rounded-lg border border-border bg-card text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <ChevronRight className="size-4" />
            </Link>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Employee</th>
                <th className="px-4 py-2 text-right font-medium">Present</th>
                <th className="px-4 py-2 text-right font-medium">Late</th>
                <th className="px-4 py-2 text-right font-medium">Half day</th>
                <th className="px-4 py-2 text-right font-medium">Leave</th>
                <th className="px-4 py-2 text-right font-medium">Absent</th>
                <th className="px-4 py-2 text-right font-medium">Hours</th>
                <th className="px-4 py-2 text-right font-medium">Overtime</th>
                <th className="px-4 py-2 font-medium">Flags</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {summary.map((r) => (
                <tr key={r.employmentId}>
                  <td className="px-4 py-2.5 font-medium">{r.name}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{r.present}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{r.late || '—'}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{r.halfDay || '—'}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{r.leaveDays || '—'}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">
                    {r.absent ? <span className="text-rose-600 dark:text-rose-400">{r.absent}</span> : '—'}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                    {fmtMin(r.workedMinutes)}
                  </td>
                  <td
                    className="px-4 py-2.5 text-right tabular-nums text-muted-foreground"
                    title={`Workday ${fmtOt(r.otWorkday)} · Rest day ${fmtOt(r.otRestDay)} · Holiday ${fmtOt(r.otHoliday)}`}
                  >
                    {fmtOt(r.otWorkday + r.otRestDay + r.otHoliday)}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap gap-1.5">
                      {r.otCapExceeded && (
                        <Pill label="OT > 104h" cls="bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400" />
                      )}
                      {r.over45hWeek && (
                        <Pill label="45h+ week" cls="bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400" />
                      )}
                      {!r.otCapExceeded && !r.over45hWeek && <span className="text-xs text-muted-foreground">—</span>}
                    </div>
                  </td>
                </tr>
              ))}
              {summary.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-muted-foreground">
                    No employees in scope.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
          Hours and overtime derive from the company work schedule; rest-day and holiday work is
          OT-class in full (EA 1955 — ADR-0011). Flags: OT above the statutory 104h/month cap;
          45h+ week is indicative. Absent counts elapsed working days only.
        </p>
      </Card>
    </div>
  );
}
