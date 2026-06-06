import { getSession } from '@/lib/session';
import { attendanceForDate } from '@/core/attendance';
import { Button, Card, ErrorBanner, SectionHeader, inputCls } from '@/components/ui';
import { checkInAction, checkOutAction } from './actions';

const TODAY = '2026-06-05';

const STATUS: Record<string, string> = {
  present: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  late: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  half_day: 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400',
  absent: 'bg-muted text-muted-foreground',
};

function StatusPill({ status }: { status: string | null }) {
  const cls = (status && STATUS[status]) || 'bg-muted text-muted-foreground';
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium capitalize ${cls}`}>
      {status ? status.replace(/_/g, ' ') : 'absent'}
    </span>
  );
}

export default async function AttendancePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const s = await getSession();
  const { error } = await searchParams;
  const rows = await attendanceForDate(s, TODAY);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Attendance</h1>
        <span className="text-sm text-muted-foreground">{TODAY}</span>
      </div>
      <ErrorBanner message={error} />

      <Card className="overflow-hidden">
        <SectionHeader title="Today" count={rows.length} />
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">Employee</th>
              <th className="px-4 py-2 font-medium">Check-in</th>
              <th className="px-4 py-2 font-medium">Check-out</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 text-right font-medium">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => (
              <tr key={r.employmentId}>
                <td className="px-4 py-2.5 font-medium">{r.name}</td>
                <td className="px-4 py-2.5 tabular-nums text-muted-foreground">{r.checkInAt?.slice(0, 5) ?? '—'}</td>
                <td className="px-4 py-2.5 tabular-nums text-muted-foreground">{r.checkOutAt?.slice(0, 5) ?? '—'}</td>
                <td className="px-4 py-2.5">
                  <StatusPill status={r.attendanceId ? r.status : null} />
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex justify-end">
                    {!r.attendanceId ? (
                      <form action={checkInAction} className="flex items-center gap-2">
                        <input type="hidden" name="employmentId" value={r.employmentId} />
                        <input name="time" type="time" defaultValue="09:00" className={`${inputCls} h-8 w-28`} />
                        <Button type="submit" size="sm">
                          Check in
                        </Button>
                      </form>
                    ) : !r.checkOutAt ? (
                      <form action={checkOutAction} className="flex items-center gap-2">
                        <input type="hidden" name="employmentId" value={r.employmentId} />
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
      </Card>
    </div>
  );
}
