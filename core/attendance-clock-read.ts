/** Own live clock read model. This never writes or derives payable payroll figures. */
import { and, asc, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { attendance, attendancePunch, attendanceClockCapture, clockingLocation, employment } from '../db/schema';
import type { SessionContext } from '../db/client';
import { withAttendanceTenant as withTenant } from './module-gate';
import { myEmployment, myEmployments } from './read';
import { clockScheduleForTx, resolveGeofence } from './attendance';
import { todayInKualaLumpur } from '../lib/hr-date';

// r430 — deviceToken is GONE (Web Clocking no longer registers or presents a device).
export async function ownClockToday(ctx: SessionContext, geo?: { lat: number; lng: number; accuracy: number }, selectedEmploymentId?: string) {
  const me = selectedEmploymentId ? (await myEmployments(ctx)).find(e => e.employmentId === selectedEmploymentId) : await myEmployment(ctx);
  if (!me) throw new Error('No active employee profile');
  return withTenant(ctx, async tx => {
    const now = new Date();
    let date = todayInKualaLumpur(now);
    const [openDay] = await tx.select({ date: attendance.attendanceDate }).from(attendance).where(and(eq(attendance.employmentId, me.employmentId), isNotNull(attendance.checkInAt), isNull(attendance.checkOutAt))).orderBy(desc(attendance.attendanceDate)).limit(1);
    if (openDay && openDay.date === todayInKualaLumpur(new Date(now.getTime() - 86400000)) && (await clockScheduleForTx(tx, me.employmentId, openDay.date)).crossesMidnight) date = openDay.date;
    const schedule = await clockScheduleForTx(tx, me.employmentId, date);
    const [day] = await tx.select({ id: attendance.id, checkIn: attendance.checkInAt, checkOut: attendance.checkOutAt, checkInMethod: attendance.checkInMethod }).from(attendance).where(and(eq(attendance.employmentId, me.employmentId), eq(attendance.attendanceDate, date))).limit(1);
    const punches = day ? await tx.select({ direction: attendancePunch.direction, time: attendancePunch.punchAt, captureId: attendancePunch.clockCaptureId, recordedAt: attendanceClockCapture.serverRecordedAt }).from(attendancePunch).leftJoin(attendanceClockCapture, eq(attendanceClockCapture.id, attendancePunch.clockCaptureId)).where(and(eq(attendancePunch.attendanceId, day.id), isNull(attendancePunch.voidedAt))).orderBy(asc(attendancePunch.createdAt), asc(attendancePunch.id)) : [];
    const toInstant = (time: string) => {
      const clock = time.slice(0,8).padEnd(8, ':00');
      let ms = new Date(`${date}T${clock}+08:00`).getTime();
      if (schedule.crossesMidnight && schedule.start && time.slice(0,5) < schedule.start.slice(0,5)) ms += 86400000;
      return ms;
    };
    let live = punches.map(p => ({ ...p, instant: p.recordedAt?.getTime() ?? toInstant(p.time) })).sort((a,b) => a.instant-b.instant);
    // A correction changes the authoritative pair without re-attributing its original photos.
    const firstIn = live.find(p=>p.direction==='in'), lastOut = live.filter(p=>p.direction==='out').at(-1);
    if (day && (firstIn?.time.slice(0,5) !== day.checkIn?.slice(0,5) || (lastOut?.time.slice(0,5)??null) !== (day.checkOut?.slice(0,5)??null))) live=[];
    if (!live.length && day?.checkIn) {
      live.push({direction:'in', time:day.checkIn, captureId:null, recordedAt:null, instant:toInstant(day.checkIn)});
      if (day.checkOut) live.push({direction:'out', time:day.checkOut, captureId:null, recordedAt:null, instant:toInstant(day.checkOut)});
    }
    let anchor: number | null = null, workedMs = 0;
    for (const p of live) {
      if (p.direction === 'in' && anchor == null) anchor = p.instant;
      if (p.direction === 'out' && anchor != null) { workedMs += Math.max(0,p.instant-anchor); anchor = null; }
    }
    if (anchor != null) workedMs += Math.max(0,now.getTime()-anchor);
    // r430 — photoDigest selected too: a capture with NO photo (Not Required, or Optional skipped) has
    // purgedAt null just like an un-purged one, which would otherwise misreport a photo that was never
    // taken as available (see the identical fix in core/attendance-clock.ts publicReceipt).
    const captures = await tx.select({ id: attendanceClockCapture.id, direction: attendanceClockCapture.direction, requestId: attendanceClockCapture.requestId, recordedAt: attendanceClockCapture.serverRecordedAt, purgedAt: attendanceClockCapture.photoPurgedAt, photoDigest: attendanceClockCapture.photoDigest, locationName: clockingLocation.name }).from(attendanceClockCapture).leftJoin(clockingLocation,eq(clockingLocation.id,attendanceClockCapture.clockingLocationId)).where(and(eq(attendanceClockCapture.employmentId,me.employmentId),eq(attendanceClockCapture.attendanceDate,date))).orderBy(asc(attendanceClockCapture.serverRecordedAt),asc(attendanceClockCapture.id));
    // r423 — the switch decides. ON: valid only inside an active assigned location open to the employee's
    // company. OFF: a valid position fix is all that is needed (it is recorded, not compared), and
    // `geofencingRequired: false` lets the screen say "Location recorded — geofencing not required".
    // r430 — attendancePhotoSetting joins the same row: the client needs it to know which capture flow to
    // run (required / optional / not_required), though the SERVER re-reads and enforces it independently
    // at submit time (core/attendance-clock.ts) — this is display-only.
    const [control] = await tx.select({ enabled: employment.geofencingEnabled, attendancePhotoSetting: employment.attendancePhotoSetting }).from(employment).where(eq(employment.id, me.employmentId)).limit(1);
    const geofencingRequired = control?.enabled ?? false;
    const attendancePhotoSetting = control?.attendancePhotoSetting ?? 'not_required';
    let locationValid = false;
    if (geo && [geo.lat,geo.lng,geo.accuracy].every(Number.isFinite) && Math.abs(geo.lat)<=90 && Math.abs(geo.lng)<=180 && geo.accuracy>=0) {
      try { const result = await resolveGeofence(tx,{employmentId:me.employmentId,date,time:new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kuala_Lumpur',hour:'2-digit',minute:'2-digit',hour12:false}).format(now),lat:geo.lat,lng:geo.lng,punch:anchor==null?'in':'out'}); locationValid = result.enforced ? !!result.clockingLocationId : true; } catch { /* explanatory prerequisite; command rechecks */ }
    }
    return { serverNow:now.toISOString(),date,clockedIn:anchor!=null,openSince:anchor==null?null:new Date(anchor).toISOString(),workedSeconds:Math.floor(workedMs/1000),locationValid,geofencingRequired,attendancePhotoSetting,shift:{code:schedule.code,start:schedule.start,end:schedule.end},captures:captures.filter(c=>live.some(p=>p.captureId===c.id)).map(c=>({...c,recordedAt:c.recordedAt.toISOString(),photoAvailable:c.purgedAt==null&&c.photoDigest!=null,purgedAt:undefined,photoDigest:undefined})),legacy:live.filter(p=>!p.captureId).map(p=>({direction:p.direction,time:p.time})) };
  });
}
