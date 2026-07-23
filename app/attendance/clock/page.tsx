import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { myAttendance, myEmployment } from '@/core/read';
import { attendancePunchesForRange } from '@/core/attendance';
import { deviceGateRequired, listMyDevices } from '@/core/attendance-device';
import { Card, ErrorBanner, PageHeader } from '@/components/ui';
import { ClockPageClient, type PunchEvent } from './clock-client';

/**
 * Attendance > Clock in/out (feedback 5249d43f) — the dedicated employee-facing clocking page: live
 * running clock, today's status, the current session's in/out times, the full ordered log of today's
 * punches, and the one primary button (same engine as the /me card — core checkIn/checkOut).
 *
 * Employee self-service, same trust model as /me: the viewer's OWN employment is resolved from the
 * session and every read below is RLS-scoped to it. State is fetched fresh on every render — a refresh
 * or a different session always shows the server's truth, never browser state. Every displayed punch
 * time is the SERVER-recorded one; only the live "current time" ticker is the client's clock.
 */
export default async function AttendanceClockPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; deviceError?: string }>;
}) {
  const t = await getTranslations('attendance.clock');
  const sp = await searchParams;
  const s = await getSession();
  const me = await myEmployment(s);
  if (!me) {
    return (
      <div className="mx-auto max-w-2xl">
        <Card className="p-8 text-center">
          <h1 className="text-lg font-semibold">{t('title')}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{t('notLinked')}</p>
        </Card>
      </div>
    );
  }

  const today = new Date().toISOString().slice(0, 10); // same day-key convention as the /me card
  const [recent, punchesByDay, requireDevice, devices] = await Promise.all([
    myAttendance(s, me.employmentId, 3),
    attendancePunchesForRange(s, me.employmentId, today, today),
    deviceGateRequired(s, me.employmentId),
    listMyDevices(s, me.employmentId),
  ]);
  const todayRow = recent.find((r) => r.date === today) ?? null;

  // Today's ordered punch trail. A legacy row written before the punch table (terminal import) may carry
  // aggregate times but no punch children — synthesize the pair so the log never contradicts the record.
  const punches = [...punchesByDay.values()].flat();
  const events: PunchEvent[] = punches.length
    ? punches.map((p) => ({ time: p.punchAt, direction: p.direction }))
    : [
        ...(todayRow?.checkInAt ? [{ time: todayRow.checkInAt, direction: 'in' as const }] : []),
        ...(todayRow?.checkOutAt ? [{ time: todayRow.checkOutAt, direction: 'out' as const }] : []),
      ];

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader title={t('title')} description={t('description')} />
      <ErrorBanner message={sp.error} />
      <ClockPageClient
        today={today}
        events={events}
        requireDevice={requireDevice}
        registeredDeviceCount={devices.length}
        deviceError={sp.deviceError === '1'}
      />
    </div>
  );
}
