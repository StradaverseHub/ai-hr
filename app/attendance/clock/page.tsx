import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { myAttendance, myEmployment } from '@/core/read';
import { attendanceForEmploymentRange, attendancePunchesForRange, isoWeekday } from '@/core/attendance';
import { deviceGateRequired, listMyDevices } from '@/core/attendance-device';
import { listEmployeeClockingLocations } from '@/core/clocking-location';
import { listShiftsForTenant } from '@/core/roster';
import { Card, ErrorBanner } from '@/components/ui';
import { cumulativeWorkedSeconds, type ShiftOption } from './clock-display';
import { ClockPageClient, type PunchEvent } from './clock-client';

/**
 * Attendance > Clock in/out (feedback 5249d43f; redesigned by af552c5d) — the phone-first clocking
 * screen: header row with the conditional shift Switch, the matched-location + date block, the big
 * circular state-driven button with the live cumulative-worked counter, the shift-end line, the
 * session/status row, and the full ordered log of today's punches (same engine as the /me card — core
 * checkIn/checkOut).
 *
 * Employee self-service, same trust model as /me: the viewer's OWN employment is resolved from the
 * session and every read below is RLS-scoped to it. State is fetched fresh on every render — a refresh
 * or a different session always shows the server's truth, never browser state. Every displayed punch
 * time is the SERVER-recorded one; the elapsed counter's BASE is computed here from server punches and
 * the server clock (so refreshing never resets it) — only the per-second tick is the client's clock.
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

  const now = new Date(); // SERVER clock — the same clock the punch actions stamp with
  const today = now.toISOString().slice(0, 10); // same day-key convention as the /me card
  const [recent, punchesByDay, requireDevice, devices, todayRange, assignedSites, tenantShifts] =
    await Promise.all([
      myAttendance(s, me.employmentId, 3),
      attendancePunchesForRange(s, me.employmentId, today, today),
      deviceGateRequired(s, me.employmentId),
      listMyDevices(s, me.employmentId),
      // Resolved shift display for today (roster > default shift > policy) — the "shift ends at" line.
      attendanceForEmploymentRange(s, me.employmentId, today, today),
      // Assigned approved work locations — the location block's fallback before the first punch.
      listEmployeeClockingLocations(s, me.employmentId),
      // The shared shift library — the Switch affordance's options (assignable today).
      listShiftsForTenant(s),
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

  // The elapsed counter's SERVER base: cumulative seconds worked today, measured against the server's
  // clock at render. The client only ticks forward from here — a refresh recomputes, never resets.
  const serverNowSeconds = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
  const baseWorkedSeconds = cumulativeWorkedSeconds(events, serverNowSeconds);

  // Location block: the matched approved site frozen on the LATEST punch that carries one (geofence
  // resolution), with its captured coordinates; before any matched punch, the first assigned site's name.
  let matchedLocationName: string | null = null;
  let coords: { lat: number; lng: number } | null = null;
  for (let i = punches.length - 1; i >= 0; i--) {
    if (!matchedLocationName && punches[i].locationName) matchedLocationName = punches[i].locationName;
    if (!coords && punches[i].lat != null && punches[i].lng != null) {
      coords = { lat: punches[i].lat!, lng: punches[i].lng! };
    }
    if (matchedLocationName && coords) break;
  }
  const locationName = matchedLocationName ?? assignedSites[0]?.name ?? null;

  // Shift data. The resolved shift (scheduleFor precedence, via the range read) leads; the Switch options
  // are today-assignable library shifts (weekly pattern includes today, or no pattern = any day) — and
  // only for an employee whose day actually resolves to a SHIFT: someone on the plain company policy has
  // no shift options, so the Switch stays hidden rather than being a dead link (plan GOOD TO KNOW).
  const resolved = todayRange[0] ?? null;
  const dow = isoWeekday(today);
  const shiftOptions: ShiftOption[] = resolved?.shiftCode
    ? tenantShifts
        .filter((sh) => !sh.weeklyPattern || sh.weeklyPattern.includes(dow))
        .map((sh) => ({
          code: sh.code,
          name: sh.name,
          start: sh.startTime.slice(0, 5),
          end: sh.endTime.slice(0, 5),
        }))
    : [];

  return (
    <div className="mx-auto max-w-2xl space-y-6 pb-[env(safe-area-inset-bottom)]">
      <ErrorBanner message={sp.error} />
      <ClockPageClient
        today={today}
        events={events}
        requireDevice={requireDevice}
        registeredDeviceCount={devices.length}
        deviceError={sp.deviceError === '1'}
        baseWorkedSeconds={baseWorkedSeconds}
        locationName={locationName}
        coords={coords}
        resolvedShiftEnd={resolved?.shiftEnd ?? null}
        resolvedShiftCode={resolved?.shiftCode ?? null}
        shiftOptions={shiftOptions}
      />
    </div>
  );
}
