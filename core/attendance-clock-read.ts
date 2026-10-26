import { clockFingerprint, punchesForCorrectionTx } from './attendance-punch-change';
/** Own live clock read model. This never writes or derives payable payroll figures. */
import { and, asc, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { attendance, attendancePunch, attendanceClockCapture, attendanceCorrection, clockingLocation, employment } from '../db/schema';
import type { SessionContext, Tx } from '../db/client';
import { withAttendanceTenant as withTenant } from './module-gate';
import {resolveOwnClockEmployment,OwnClockEmploymentUnavailableError} from './attendance-clock-subject';
import { clockScheduleForTx, resolveGeofence,OutsideGeofenceError,GeofenceQualityError } from './attendance';
import { todayInKualaLumpur } from '../lib/hr-date';
import { clockCommandContext } from '../lib/clock-command-context';

type ClockGeo={lat:number;lng:number;accuracy:number};

/** Explanatory only: the authoritative writer rechecks live policy and never trusts this result. */
export async function previewOwnClockLocation(ctx:SessionContext,selectedEmploymentId:string,geo:ClockGeo&{sampledAt:number}){
  const me=await resolveOwnClockEmployment(ctx,selectedEmploymentId);
  if(!me)throw new OwnClockEmploymentUnavailableError();
  const base={siteId:null,siteName:null,distanceM:null,radiusM:null,accuracyM:geo.accuracy,maximumAccuracyM:null};
  if(!Number.isFinite(geo.sampledAt)||Math.abs(Date.now()-geo.sampledAt)>120000)
    return {...base,outcome:geo.sampledAt>Date.now()?'future_fix' as const:'stale_fix' as const};
  return withTenant(ctx,async tx=>{
    try{
      const result=await resolveGeofence(tx,{employmentId:me.employmentId,date:todayInKualaLumpur(),time:'00:00',...geo,punch:'in'});
      if(!result.enforced)return {...base,outcome:'not_enforced' as const};
      const [site]=await tx.select({name:clockingLocation.name}).from(clockingLocation).where(eq(clockingLocation.id,result.clockingLocationId!)).limit(1);
      return {...result.assessment,siteName:site?.name??null};
    }catch(error){
      if(error instanceof GeofenceQualityError)return {...error.assessment,siteName:null};
      if(error instanceof OutsideGeofenceError){
        const [site]=error.info.nearestLocationId?await tx.select({name:clockingLocation.name}).from(clockingLocation).where(eq(clockingLocation.id,error.info.nearestLocationId)).limit(1):[];
        return {...base,outcome:error.info.reason??'outside_site',siteId:error.info.nearestLocationId,siteName:site?.name??null,distanceM:error.info.distanceM,radiusM:error.info.radiusM};
      }
      throw error;
    }
  });
}
/** Shared live punch calculation; neither reader creates a capture or payable figure. */
async function ownClockCoreTx(tx:Tx,employmentId:string,geo?:ClockGeo){
    const now = new Date();
    let date = todayInKualaLumpur(now);
    const [openDay] = await tx.select({ date: attendance.attendanceDate }).from(attendance).where(and(eq(attendance.employmentId, employmentId), isNotNull(attendance.checkInAt), isNull(attendance.checkOutAt))).orderBy(desc(attendance.attendanceDate)).limit(1);
    if (openDay && openDay.date === todayInKualaLumpur(new Date(now.getTime() - 86400000)) && (await clockScheduleForTx(tx, employmentId, openDay.date)).crossesMidnight) date = openDay.date;
    const schedule = await clockScheduleForTx(tx, employmentId, date);
    const [day] = await tx.select({ id: attendance.id, checkIn: attendance.checkInAt, checkOut: attendance.checkOutAt, checkInMethod: attendance.checkInMethod }).from(attendance).where(and(eq(attendance.employmentId, employmentId), eq(attendance.attendanceDate, date))).limit(1);
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
    // r423 — the switch decides. ON: valid only inside an active assigned location open to the employee's
    // company. OFF: a position is optional (recorded when available, never fabricated), and
    // `geofencingRequired: false` lets the screen say "Location recorded — geofencing not required".
    // r430 — attendancePhotoSetting joins the same row: the client needs it to know which capture flow to
    // run (required / optional / not_required), though the SERVER re-reads and enforces it independently
    // at submit time (core/attendance-clock.ts) — this is display-only.
    const [control] = await tx.select({ enabled: employment.geofencingEnabled, attendancePhotoSetting: employment.attendancePhotoSetting }).from(employment).where(eq(employment.id, employmentId)).limit(1);
    const geofencingRequired = control?.enabled ?? false;
    const attendancePhotoSetting = control?.attendancePhotoSetting ?? 'not_required';
    let locationValid = !geofencingRequired;
    const locationAvailable = !!geo && [geo.lat,geo.lng,geo.accuracy].every(Number.isFinite) && Math.abs(geo.lat)<=90 && Math.abs(geo.lng)<=180 && geo.accuracy>=0;
    if (geo && [geo.lat,geo.lng,geo.accuracy].every(Number.isFinite) && Math.abs(geo.lat)<=90 && Math.abs(geo.lng)<=180 && geo.accuracy>=0) {
      try { const result = await resolveGeofence(tx,{employmentId:employmentId,date,time:new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kuala_Lumpur',hour:'2-digit',minute:'2-digit',hour12:false}).format(now),lat:geo.lat,lng:geo.lng,accuracy:geo.accuracy,punch:anchor==null?'in':'out'}); locationValid = result.enforced ? !!result.clockingLocationId : true; } catch { /* explanatory prerequisite; command rechecks */ }
    }
 return {date,live,crossesMidnight:schedule.crossesMidnight,summary:{serverNow:now.toISOString(),date,clockedIn:anchor!=null,openSince:anchor==null?null:new Date(anchor).toISOString(),workedSeconds:Math.floor(workedMs/1000),locationValid,locationAvailable,geofencingRequired,attendancePhotoSetting,shift:{code:schedule.code,start:schedule.start,end:schedule.end}}};
}

// r430 — deviceToken is GONE (Web Clocking no longer registers or presents a device).
export async function ownClockToday(ctx: SessionContext, geo?: { lat: number; lng: number; accuracy: number }, selectedEmploymentId?: string) {
  const me=await resolveOwnClockEmployment(ctx,selectedEmploymentId);
  if(!me)throw new OwnClockEmploymentUnavailableError();
  return withTenant(ctx, async tx => {
    const {date,live,summary}=await ownClockCoreTx(tx,me.employmentId,geo);
    // r430 — photoDigest selected too: a capture with NO photo (Not Required, or Optional skipped) has
    // purgedAt null just like an un-purged one, which would otherwise misreport a photo that was never
    // taken as available (see the identical fix in core/attendance-clock.ts publicReceipt).
    const captures = await tx.select({ deviceId:attendanceClockCapture.deviceId,lat:attendanceClockCapture.lat,lng:attendanceClockCapture.lng,accuracyM:attendanceClockCapture.accuracyM,locationStatus:attendanceClockCapture.locationCaptureStatus,geofencingRequired:attendanceClockCapture.geofencingRequired,id: attendanceClockCapture.id, direction: attendanceClockCapture.direction, requestId: attendanceClockCapture.requestId, recordedAt: attendanceClockCapture.serverRecordedAt, purgedAt: attendanceClockCapture.photoPurgedAt, photoDigest: attendanceClockCapture.photoDigest, locationName: clockingLocation.name }).from(attendanceClockCapture).leftJoin(clockingLocation,eq(clockingLocation.id,attendanceClockCapture.clockingLocationId)).where(and(eq(attendanceClockCapture.employmentId,me.employmentId),eq(attendanceClockCapture.attendanceDate,date))).orderBy(asc(attendanceClockCapture.serverRecordedAt),asc(attendanceClockCapture.id));
    const allPunches=await punchesForCorrectionTx(tx,me.employmentId,date);
    const [pendingRemoval]=await tx.select({id:attendanceCorrection.id,punchId:attendanceCorrection.removalPunchId}).from(attendanceCorrection).where(and(eq(attendanceCorrection.employmentId,me.employmentId),eq(attendanceCorrection.attendanceDate,date),eq(attendanceCorrection.status,'pending'))).limit(1);
    return { removalBaseline:clockFingerprint(allPunches),clockContext:clockCommandContext(ctx.tenantId,ctx.userId,me.employmentId),...summary,captures:captures.filter(c=>live.some(p=>p.captureId===c.id)).map(c=>({...c,date,punchId:allPunches.find(p=>p.clockCaptureId===c.id&&!p.voidedAt)?.id??null,removalRequested:pendingRemoval?.punchId===allPunches.find(p=>p.clockCaptureId===c.id)?.id,removalBlocked:!!pendingRemoval||c.deviceId!=null,recordedAt:c.recordedAt.toISOString(),photoAvailable:c.purgedAt==null&&c.photoDigest!=null,purgedAt:undefined,photoDigest:undefined})),legacy:live.filter(p=>!p.captureId).map(p=>({direction:p.direction,time:p.time})) };
  });
}

/** Own clock summary without selecting capture coordinates, photographs or removal commands. */
export async function ownClockTodaySummary(ctx:SessionContext,selectedEmploymentId:string){
 if(typeof selectedEmploymentId!=='string')throw new OwnClockEmploymentUnavailableError();
 const me=await resolveOwnClockEmployment(ctx,selectedEmploymentId);
 if(!me)throw new OwnClockEmploymentUnavailableError();
 return withTenant(ctx,async tx=>{const value=await ownClockCoreTx(tx,me.employmentId);return {...value.summary,crossesMidnight:value.crossesMidnight};});
}
