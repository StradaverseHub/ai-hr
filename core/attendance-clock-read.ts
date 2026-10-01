/** Own live clock read model. This never writes or derives payable payroll figures. */
import { and, asc, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { attendance, attendancePunch, attendanceClockCapture, employeeDevice, clockingLocation } from '../db/schema';
import type { SessionContext } from '../db/client';
import { withAttendanceTenant as withTenant } from './module-gate';
import { myEmployment } from './read';
import { clockScheduleForTx, resolveGeofence } from './attendance';
import { todayInKualaLumpur } from '../lib/hr-date';

export async function ownClockToday(ctx: SessionContext, deviceToken?: string, geo?: { lat: number; lng: number; accuracy: number }) {
  const me = await myEmployment(ctx);
  if (!me) throw new Error('No active employee profile');
  return withTenant(ctx, async tx => {
    const now = new Date();
    let date = todayInKualaLumpur(now);
    const [openDay] = await tx.select({ date: attendance.attendanceDate }).from(attendance).where(and(eq(attendance.employmentId, me.employmentId), isNotNull(attendance.checkInAt), isNull(attendance.checkOutAt))).orderBy(desc(attendance.attendanceDate)).limit(1);
    if (openDay && openDay.date === todayInKualaLumpur(new Date(now.getTime() - 86400000)) && (await clockScheduleForTx(tx, me.employmentId, openDay.date)).crossesMidnight) date = openDay.date;
    const schedule = await clockScheduleForTx(tx, me.employmentId, date);
    const [day] = await tx.select({ id: attendance.id, checkIn: attendance.checkInAt, checkOut: attendance.checkOutAt, checkInMethod: attendance.checkInMethod }).from(attendance).where(and(eq(attendance.employmentId, me.employmentId), eq(attendance.attendanceDate, date))).limit(1);
    const punches = day ? await tx.select({ direction: attendancePunch.direction, time: attendancePunch.punchAt, captureId: attendancePunch.clockCaptureId, recordedAt: attendanceClockCapture.serverRecordedAt }).from(attendancePunch).leftJoin(attendanceClockCapture, eq(attendanceClockCapture.id, attendancePunch.clockCaptureId)).where(eq(attendancePunch.attendanceId, day.id)).orderBy(asc(attendancePunch.createdAt), asc(attendancePunch.id)) : [];
    const toInstant = (time: string) => {
      const clock = time.slice(0,8).padEnd(8, ':00');
      let ms = new Date(`${date}T${clock}+08:00`).getTime();
      if (schedule.crossesMidnight && schedule.start && time.slice(0,5) < schedule.start.slice(0,5)) ms += 86400000;
      return ms;
    };
    let live = punches.map(p => ({ ...p, instant: p.recordedAt?.getTime() ?? toInstant(p.time) })).sort((a,b) => a.instant-b.instant);
    // A correction changes the authoritative pair without re-attributing its original photos.
    const firstIn = live.find(p=>p.direction==='in'), lastOut = live.filter(p=>p.direction==='out').at(-1);
    if (day && (day.checkInMethod == null || firstIn?.time.slice(0,5) !== day.checkIn?.slice(0,5) || (lastOut?.time.slice(0,5)??null) !== (day.checkOut?.slice(0,5)??null))) live=[];
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
    const captures = await tx.select({ id: attendanceClockCapture.id, direction: attendanceClockCapture.direction, requestId: attendanceClockCapture.requestId, recordedAt: attendanceClockCapture.serverRecordedAt, purgedAt: attendanceClockCapture.photoPurgedAt, locationName: clockingLocation.name }).from(attendanceClockCapture).leftJoin(clockingLocation,eq(clockingLocation.id,attendanceClockCapture.clockingLocationId)).where(and(eq(attendanceClockCapture.employmentId,me.employmentId),eq(attendanceClockCapture.attendanceDate,date))).orderBy(asc(attendanceClockCapture.serverRecordedAt),asc(attendanceClockCapture.id));
    const [device] = deviceToken && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deviceToken) ? await tx.select({id:employeeDevice.id}).from(employeeDevice).where(and(eq(employeeDevice.employmentId,me.employmentId),eq(employeeDevice.deviceToken,deviceToken),isNull(employeeDevice.revokedAt))).limit(1) : [];
    let locationValid = false;
    if (geo && [geo.lat,geo.lng,geo.accuracy].every(Number.isFinite) && Math.abs(geo.lat)<=90 && Math.abs(geo.lng)<=180 && geo.accuracy>=0) {
      try { const result = await resolveGeofence(tx,{employmentId:me.employmentId,date,time:new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kuala_Lumpur',hour:'2-digit',minute:'2-digit',hour12:false}).format(now),lat:geo.lat,lng:geo.lng,punch:anchor==null?'in':'out',required:true}); locationValid = result.enforced && !!result.clockingLocationId; } catch { /* explanatory prerequisite; command rechecks */ }
    }
    return { serverNow:now.toISOString(),date,clockedIn:anchor!=null,openSince:anchor==null?null:new Date(anchor).toISOString(),workedSeconds:Math.floor(workedMs/1000),deviceValid:!!device,locationValid,shift:{code:schedule.code,start:schedule.start,end:schedule.end},captures:captures.map(c=>({...c,recordedAt:c.recordedAt.toISOString(),photoAvailable:c.purgedAt==null,purgedAt:undefined})),legacy:live.filter(p=>!p.captureId).map(p=>({direction:p.direction,time:p.time})) };
  });
}
