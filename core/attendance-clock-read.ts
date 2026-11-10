import { clockFingerprint, punchesForCorrectionTx } from './attendance-punch-change';
/** Own live clock read model. This never writes or derives payable payroll figures. */
import { and, asc, desc, eq, gte, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { attendance, attendancePunch, attendanceClockCapture, attendanceCorrection, clockingLocation, employment } from '../db/schema';
import type { SessionContext, Tx } from '../db/client';
import { assertModuleGate, withAttendanceTenant as withTenant } from './module-gate';
import {resolveOwnClockEmployment,OwnClockEmploymentUnavailableError} from './attendance-clock-subject';
import { clockScheduleForTx, workedDayKindForTx, resolveGeofence,OutsideGeofenceError,GeofenceQualityError,
  decodeOwnClockSchedule, ownClockScheduleMemo, type OwnClockScheduleJson, type ScheduleMemo } from './attendance';
import { todayInKualaLumpur } from '../lib/hr-date';
import { clockCommandContext } from '../lib/clock-command-context';
import { anchorAttendanceClockMinute } from './attendance-timeline';
import { clockCaptureInstantTx } from './attendance-clock';
import { isOwnProfileEditEmploymentTx } from './read';

type ClockGeo={lat:number;lng:number;accuracy:number};
type LiveClockPunch={id?:string;direction:'in'|'out';time:string;captureId:string|null;recordedAt:Date|null;instant:number};

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
/** The rows ownClockCoreTx reads, read once for its two candidate dates by app.home_own_clock_day (draft 9870). */
type OwnClockDayJson = OwnClockScheduleJson & {
  openDay: string | null;
  days: { attendanceDate: string; id: string; checkIn: string | null; checkOut: string | null; checkInMethod: (typeof attendance.$inferSelect)['checkInMethod']; trace: (typeof attendance.$inferSelect)['calcTrace'] }[];
  punches: { attendanceId: string; id: string; direction: 'in' | 'out'; time: string; captureId: string | null; recordedAt: string | null }[];
  control: { enabled: boolean; attendancePhotoSetting: (typeof employment.$inferSelect)['attendancePhotoSetting'] } | null;
  locations: { total: number; names: string[] };
};
export type OwnClockDayInputs = {
  now: Date; openDay: string | null; days: OwnClockDayJson['days'];
  punches: { attendanceId: string; id: string; direction: 'in' | 'out'; time: string; captureId: string | null; recordedAt: Date | null }[];
  control: OwnClockDayJson['control']; locations: OwnClockDayJson['locations'];
  /** A fresh schedule memo for yesterday or today, answered from the bundle (core/attendance.ts ownClockScheduleMemo). */
  memo: (date: string) => ScheduleMemo;
};
/** One statement for the own clock day at `now`: the open-day probe, both candidate days, their punches, the switches,
 *  the work locations and every schedule input. Its rows are read under the caller's RLS (SECURITY INVOKER). */
export async function readOwnClockDayInputsTx(tx: Tx, employmentId: string, now: Date): Promise<OwnClockDayInputs> {
  const today = todayInKualaLumpur(now);
  const yesterday = todayInKualaLumpur(new Date(now.getTime() - 86400000));
  const [row] = await tx.execute<{ day: OwnClockDayJson | null }>(sql`select app.home_own_clock_day(${employmentId}::uuid, ${today}::date, ${yesterday}::date) as day`);
  const raw = row?.day;
  if (!raw) throw new Error('The own clock day is unavailable.');
  const schedule = decodeOwnClockSchedule(raw);
  return {
    now, openDay: raw.openDay, days: raw.days, control: raw.control,
    // The capture instant arrives as its driver text and is decoded by the very column mapWith names.
    punches: raw.punches.map(({ attendanceId, id, direction, time, captureId, recordedAt }) => ({ attendanceId, id, direction, time, captureId,
      recordedAt: recordedAt === null ? null : attendanceClockCapture.serverRecordedAt.mapFromDriverValue(recordedAt) as Date })),
    locations: { total: raw.locations.total, names: raw.locations.names },
    memo: (date) => {
      // The bundle holds exactly yesterday's and today's dated rows; any other date would read as "no row".
      if (date !== today && date !== yesterday) throw new Error('The own clock day bundle covers yesterday and today only.');
      return ownClockScheduleMemo(schedule, employmentId, date);
    },
  };
}
/** Shared live punch calculation; neither reader creates a capture or payable figure. `pre` answers every read
 *  from one bundled statement (Home); the calculation is the same lines either way. */
async function ownClockCoreTx(tx:Tx,employmentId:string,geo?:ClockGeo,pre?:OwnClockDayInputs){
    const now = pre?.now ?? new Date();
    const today = todayInKualaLumpur(now);
    const yesterday = todayInKualaLumpur(new Date(now.getTime() - 86400000));
    // Older open rows cannot select the live date. Keep newer rows in the probe so they
    // still take precedence over yesterday, even if a future import left one open.
    const [openDay] = pre ? (pre.openDay === null ? [] : [{ date: pre.openDay }]) : await tx.select({ date: attendance.attendanceDate }).from(attendance)
      .where(and(eq(attendance.employmentId, employmentId), gte(attendance.attendanceDate, yesterday),
        isNotNull(attendance.checkInAt), isNull(attendance.checkOutAt)))
      .orderBy(desc(attendance.attendanceDate)).limit(1);
    const overnightSchedule = openDay?.date === yesterday
      ? await clockScheduleForTx(tx, employmentId, yesterday, pre?.memo(yesterday)) : null;
    const date = overnightSchedule?.crossesMidnight ? yesterday : today;
    const schedule = overnightSchedule?.crossesMidnight
      ? overnightSchedule : await clockScheduleForTx(tx, employmentId, today, pre?.memo(today));
    const [day] = pre ? pre.days.filter(row => row.attendanceDate === date).slice(0, 1).map(({ id, checkIn, checkOut, checkInMethod, trace }) => ({ id, checkIn, checkOut, checkInMethod, trace })) : await tx.select({ id: attendance.id, checkIn: attendance.checkInAt, checkOut: attendance.checkOutAt, checkInMethod: attendance.checkInMethod, trace: attendance.calcTrace }).from(attendance).where(and(eq(attendance.employmentId, employmentId), eq(attendance.attendanceDate, date))).limit(1);
    // A capture's true instant orders and times the day: an offline capture's server_recorded_at is its arrival.
    // Typed nullable: a raw SQL field is not widened by the left join, and a punch without a capture reads NULL.
    const captureInstant = pre ? null : await clockCaptureInstantTx(tx);
    const punches = day ? pre ? pre.punches.filter(row => row.attendanceId === day.id).map(({ id, direction, time, captureId, recordedAt }) => ({ id, direction, time, captureId, recordedAt })) : await tx.select({ id:attendancePunch.id,direction: attendancePunch.direction, time: attendancePunch.punchAt, captureId: attendancePunch.clockCaptureId, recordedAt: captureInstant! as SQL<Date | null> }).from(attendancePunch).leftJoin(attendanceClockCapture, eq(attendanceClockCapture.id, attendancePunch.clockCaptureId)).where(and(eq(attendancePunch.attendanceId, day.id), isNull(attendancePunch.voidedAt))).orderBy(asc(attendancePunch.createdAt), asc(attendancePunch.id)) : [];
    const clockPolicy=day?.trace?.clockPolicy?.attendanceDate===date?day.trace.clockPolicy:undefined;
    const toInstant = (time: string) => {
      const clock = time.slice(0,8).padEnd(8, ':00');
      let ms = new Date(`${date}T${clock}+08:00`).getTime();
      const positioning=clockPolicy?.positioning;
      if(positioning&&(positioning.crossesMidnight||positioning.cutoffMinute!==null)){
        const minute=Number(time.slice(0,2))*60+Number(time.slice(3,5));
        ms+=(anchorAttendanceClockMinute(minute,positioning.startMinute,positioning.cutoffMinute)-minute)*60_000;
      }else if(!positioning&&schedule.crossesMidnight&&schedule.start&&time.slice(0,5)<schedule.start.slice(0,5))ms+=86400000;
      return ms;
    };
    const raw = punches.map(p => ({ ...p, instant: p.recordedAt?.getTime() ?? toInstant(p.time) })).sort((a,b) => a.instant-b.instant);
    const exclusions=new Set(clockPolicy?.exclusions.map(row=>row.punchId));
    let live:LiveClockPunch[] = raw.filter(punch=>!exclusions.has(punch.id));
    // A correction changes the authoritative pair without re-attributing its original photos.
    // The new policy trace already explains why a retained raw boundary can differ from the aggregate.
    const firstIn = live.find(p=>p.direction==='in'), lastOut = live.filter(p=>p.direction==='out').at(-1);
    if (!clockPolicy&&day&&(firstIn?.time.slice(0,5) !== day.checkIn?.slice(0,5) || (lastOut?.time.slice(0,5)??null) !== (day.checkOut?.slice(0,5)??null))) live=[];
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
    const [control] = pre ? (pre.control ? [pre.control] : []) : await tx.select({ enabled: employment.geofencingEnabled, attendancePhotoSetting: employment.attendancePhotoSetting }).from(employment).where(eq(employment.id, employmentId)).limit(1);
    const geofencingRequired = control?.enabled ?? false;
    const attendancePhotoSetting = control?.attendancePhotoSetting ?? 'not_required';
    let locationValid = !geofencingRequired;
    const locationAvailable = !!geo && [geo.lat,geo.lng,geo.accuracy].every(Number.isFinite) && Math.abs(geo.lat)<=90 && Math.abs(geo.lng)<=180 && geo.accuracy>=0;
    if (geo && [geo.lat,geo.lng,geo.accuracy].every(Number.isFinite) && Math.abs(geo.lat)<=90 && Math.abs(geo.lng)<=180 && geo.accuracy>=0) {
      try { const result = await resolveGeofence(tx,{employmentId:employmentId,date,time:new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kuala_Lumpur',hour:'2-digit',minute:'2-digit',hour12:false}).format(now),lat:geo.lat,lng:geo.lng,accuracy:geo.accuracy,punch:anchor==null?'in':'out'}); locationValid = result.enforced ? !!result.clockingLocationId : true; } catch { /* explanatory prerequisite; command rechecks */ }
    }
 return {date,live:clockPolicy?raw:live,crossesMidnight:schedule.crossesMidnight,businessDate:today,todayKind:date===today?schedule.dayKind:null,summary:{serverNow:now.toISOString(),date,clockedIn:anchor!=null,openSince:anchor==null?null:new Date(anchor).toISOString(),workedSeconds:Math.floor(workedMs/1000),locationValid,locationAvailable,geofencingRequired,attendancePhotoSetting,shift:{code:schedule.code,start:schedule.start,end:schedule.end}}};
}

/** The live clock state ownClockToday reports (clocking date, clocked in, open-since instant), in the caller's
 *  transaction and RLS, for a server owner that must sign it. No position, so no geofence read; no write. */
export async function liveClockStateTx(tx:Tx,employmentId:string){
 const {date,summary}=await ownClockCoreTx(tx,employmentId);
 return {date,clockedIn:summary.clockedIn,openSince:summary.openSince===null?null:Date.parse(summary.openSince)};
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
    // recordedAt is the true instant (offline: when it happened, not when it arrived), and orders the log.
    const captureInstant = await clockCaptureInstantTx(tx);
    const captures = await tx.select({ deviceId:attendanceClockCapture.deviceId,lat:attendanceClockCapture.lat,lng:attendanceClockCapture.lng,accuracyM:attendanceClockCapture.accuracyM,locationStatus:attendanceClockCapture.locationCaptureStatus,geofencingRequired:attendanceClockCapture.geofencingRequired,id: attendanceClockCapture.id, direction: attendanceClockCapture.direction, requestId: attendanceClockCapture.requestId, recordedAt: captureInstant, purgedAt: attendanceClockCapture.photoPurgedAt, photoDigest: attendanceClockCapture.photoDigest, locationName: clockingLocation.name }).from(attendanceClockCapture).leftJoin(clockingLocation,eq(clockingLocation.id,attendanceClockCapture.clockingLocationId)).where(and(eq(attendanceClockCapture.employmentId,me.employmentId),eq(attendanceClockCapture.attendanceDate,date))).orderBy(asc(captureInstant),asc(attendanceClockCapture.id));
    const allPunches=await punchesForCorrectionTx(tx,me.employmentId,date);
    const [pendingRemoval]=await tx.select({id:attendanceCorrection.id,punchId:attendanceCorrection.removalPunchId}).from(attendanceCorrection).where(and(eq(attendanceCorrection.employmentId,me.employmentId),eq(attendanceCorrection.attendanceDate,date),eq(attendanceCorrection.status,'pending'))).limit(1);
    return { removalBaseline:clockFingerprint(allPunches),clockContext:clockCommandContext(ctx.tenantId,ctx.userId,me.employmentId),...summary,captures:captures.filter(c=>live.some(p=>p.captureId===c.id)).map(c=>({...c,date,punchId:allPunches.find(p=>p.clockCaptureId===c.id&&!p.voidedAt)?.id??null,removalRequested:pendingRemoval?.punchId===allPunches.find(p=>p.clockCaptureId===c.id)?.id,removalBlocked:!!pendingRemoval||c.deviceId!=null||allPunches.some(p=>p.clockCaptureId===c.id&&p.method==='mobile_offline'),recordedAt:c.recordedAt.toISOString(),photoAvailable:c.purgedAt==null&&c.photoDigest!=null,purgedAt:undefined,photoDigest:undefined})),legacy:live.filter(p=>!p.captureId).map(p=>({direction:p.direction,time:p.time})) };
  });
}

async function readClockSummaryTx(tx:Tx,employmentId:string){
 const value=await ownClockCoreTx(tx,employmentId);
 return {...value.summary,crossesMidnight:value.crossesMidnight};
}

async function assertOwnClockSubjectTx(tx:Tx,ctx:SessionContext,employmentId:string){
 if(!ctx.userId||!ctx.personId||typeof employmentId!=='string'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(employmentId)
  ||!await isOwnProfileEditEmploymentTx(tx,ctx,employmentId))throw new OwnClockEmploymentUnavailableError();
 assertModuleGate(ctx,'attendance');
}
/** Explicit own-subject summary for an existing request transaction. */
export async function ownClockTodaySummaryTx(tx:Tx,ctx:SessionContext,employmentId:string){
 await assertOwnClockSubjectTx(tx,ctx,employmentId);
 const {summary,crossesMidnight,businessDate,todayKind}=await ownClockCoreTx(tx,employmentId);
 // An open overnight clock uses yesterday's shift, while Home describes today's schedule.
 const dayKind=todayKind??await workedDayKindForTx(tx,employmentId,businessDate);
 return {...summary,crossesMidnight,businessDate,dayKind};
}

/** Own clock summary without selecting capture coordinates, photographs or removal commands. */
export async function ownClockTodaySummary(ctx:SessionContext,selectedEmploymentId:string){
 if(typeof selectedEmploymentId!=='string')throw new OwnClockEmploymentUnavailableError();
 const me=await resolveOwnClockEmployment(ctx,selectedEmploymentId);
 if(!me)throw new OwnClockEmploymentUnavailableError();
 return withTenant(ctx,tx=>readClockSummaryTx(tx,me.employmentId));
}

/** Home Today: ownClockTodaySummaryTx and the work location names (employeeClockingLocationLabelsTx) from ONE bundled
 * read. The same own-subject authority is proved first; the same clock, schedule and day-kind lines then run on the
 * bundled rows. No capture coordinates, photographs or removal commands are selected, and nothing is written. */
export async function ownClockTodayHomeTx(tx:Tx,ctx:SessionContext,employmentId:string){
 await assertOwnClockSubjectTx(tx,ctx,employmentId);
 const pre=await readOwnClockDayInputsTx(tx,employmentId,new Date());
 const {summary,crossesMidnight,businessDate,todayKind}=await ownClockCoreTx(tx,employmentId,undefined,pre);
 // An open overnight clock uses yesterday's shift, while Home describes today's schedule.
 const dayKind=todayKind??await workedDayKindForTx(tx,employmentId,businessDate,pre.memo(businessDate));
 return {clock:{...summary,crossesMidnight,businessDate,dayKind},workLocations:pre.locations};
}
