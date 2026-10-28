import { LOCATION_CAPTURE_STATUSES, type LocationCaptureStatus } from '../lib/attendance-removal';
/** Employee web command. A private capture and the existing attendance writer share one transaction. */
import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, getTableColumns, inArray, isNull, isNotNull, sql, type DriverValueEncoder, type SQL } from 'drizzle-orm';
import type { SessionContext,Tx } from '../db/client';
import { attendance, attendanceClockCapture, attendancePunch, attendanceCorrection, clockingLocation, employment, domainEvent, employeeDevice } from '../db/schema';
import { actorOf, appendEvent } from '../db/events';
import { withAttendanceTenant as withTenant } from './module-gate';
import {resolveOwnClockEmployment,OwnClockEmploymentUnavailableError} from './attendance-clock-subject';
import {myEmployments, myEmployment, myOwnEmploymentSubjectsTx} from './read';
import { lockAttendanceLeaveDependenciesTx, ClockConflictError, CorrectedClockConflictError, assertDayNotOwnedByCorrectionTx, appendGeofenceBlockedEvent, checkInTx, checkOutTx, clockPunchOrderRefusal, resolveGeofence, clockScheduleForTx, GeofenceQualityError, OutsideGeofenceError } from './attendance';
import { enforceDeviceGateTx, DeviceNotRegisteredError } from './attendance-device';
import { ClockPhotoError, decodeClockPhoto } from '../lib/attendance-photo';
import { clockCommandContext } from '../lib/clock-command-context';
import { todayInKualaLumpur, timeInKualaLumpur } from '../lib/hr-date';
import {abandonSubmissionTx,submissionAbandonedTx} from './mobile-submission-state';
import {assertLegacySelfServiceClockTx} from './mobile-clock-policy';
export {ClockIntegrityRequiredError,ClockPolicyUnavailableError} from './mobile-clock-policy';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// r434 — both classes now live in core/attendance.ts (the shared writers throw them too); re-exported so
// every existing import and `instanceof` keeps the same identity.
export { ClockConflictError, CorrectedClockConflictError };
export class ClockLocationError extends Error {}
export class ClockContextChangedError extends Error {}
// r430 — thrown server-side when the employee's attendance_photo_setting is 'required' and the request
// carried no photo. Never trust the client's own idea of the setting (components/attendance-clock-button.tsx
// and the admin Daily page are untouched by this — this is Web Clocking's own capture path only).
export class AttendancePhotoRequiredError extends Error {}
// r430 — deviceToken is GONE (Web Clocking no longer registers or presents a device); photo/mime are now
// OPTIONAL — whether one is required, optional or ignored is decided server-side from the employee's own
// attendance_photo_setting, never from what the client chooses to send.
export type ClockIntent = { action: 'in' | 'out'; requestId: string; lat: number | null; lng: number | null; accuracy: number | null; photo?: Buffer; mime?: string; clockContext?: string; locationStatus?: LocationCaptureStatus; employmentId?:string };
/** Missing location is explicit, never a numeric placeholder or a partial coordinate pair. */
function clockLocation(p: Pick<ClockIntent, 'lat' | 'lng' | 'accuracy'>) {
  if (p.lat === null && p.lng === null && p.accuracy === null) return null;
  if (p.lat == null || p.lng == null || p.accuracy == null ||
      ![p.lat, p.lng, p.accuracy].every(Number.isFinite) || Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180 || p.accuracy < 0) {
    throw new ClockLocationError('Supply a complete valid location and accuracy, or explicitly leave them unavailable');
  }
  return { lat: p.lat, lng: p.lng, accuracy: p.accuracy };
}

// r430 — photoAvailable must also check photoDigest: a capture with NO photo (not_required, or optional
// skipped) has photoPurgedAt null too (nothing was ever purged), which would otherwise misreport a photo
// that was never taken as available.
const publicReceipt = (row: typeof attendanceClockCapture.$inferSelect) => ({ id: row.id, direction: row.direction, recordedAt: row.serverRecordedAt.toISOString(), date: row.attendanceDate, photoAvailable: row.photoDigest != null && row.photoPurgedAt == null });

/** Look up an accepted command only under the same own-employment selector as its submission. */
export async function ownClockReceipt(ctx: SessionContext, requestId: string,selectedEmploymentId?:string) {
  if (!UUID.test(requestId)) return null;
  const me=await resolveOwnClockEmployment(ctx,selectedEmploymentId);
  if (!me) return null;
  return withTenant(ctx, async tx => {
    const [row] = await tx.select().from(attendanceClockCapture).where(and(
      eq(attendanceClockCapture.employmentId, me.employmentId),
      eq(attendanceClockCapture.requestId, requestId),
    )).limit(1);
    return row ? publicReceipt(row) : null;
  });
}

/** Native recovery binds the immutable capture to its original actor as well as own employment. */
export async function ownNativeClockReceipt(ctx:SessionContext,employmentId:string,requestId:string){
  return (await ownNativeClockDisposition(ctx,employmentId,requestId)).receipt;
}
async function nativeClockReceiptTx(tx:Tx,ctx:SessionContext,employmentId:string,requestId:string){
  if(!ctx.userId)return null;
  const [row]=await tx.select({capture:attendanceClockCapture}).from(attendanceClockCapture)
      .innerJoin(domainEvent,and(eq(domainEvent.aggregateId,attendanceClockCapture.id),eq(domainEvent.aggregateType,'attendance-clock-capture'),eq(domainEvent.eventType,'attendance.clock.captured')))
      .where(and(eq(attendanceClockCapture.employmentId,employmentId),eq(attendanceClockCapture.requestId,requestId),eq(domainEvent.tenantId,ctx.tenantId),eq(domainEvent.actorId,ctx.userId))).limit(1);
  return row?publicReceipt(row.capture):null;
}
export async function ownNativeClockDisposition(ctx:SessionContext,employmentId:string,requestId:string){
  if(!ctx.userId||!UUID.test(requestId)||!(await myEmployments(ctx)).some(e=>e.employmentId===employmentId))return {receipt:null};
  return withTenant(ctx,async tx=>{
    const receipt=await nativeClockReceiptTx(tx,ctx,employmentId,requestId);
    const abandoned=!receipt&&await submissionAbandonedTx(tx,ctx,employmentId,'clock',requestId);
    return {receipt,...(abandoned?{abandoned:true as const}:{})};
  });
}
/** Accept-or-abandon is serialized with the original capture; it never changes a recorded punch. */
export async function abandonNativeClock(ctx:SessionContext,employmentId:string,requestId:string){
  if(!ctx.userId||!UUID.test(requestId)||!(await myEmployments(ctx)).some(e=>e.employmentId===employmentId))throw new OwnClockEmploymentUnavailableError();
  return withTenant(ctx,async tx=>{
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.tenantId+':'+employmentId},0))`);
    const receipt=await nativeClockReceiptTx(tx,ctx,employmentId,requestId);
    if(receipt)return {receipt,abandoned:false};
    const [used]=await tx.select({id:attendanceClockCapture.id}).from(attendanceClockCapture).where(and(
      eq(attendanceClockCapture.employmentId,employmentId),eq(attendanceClockCapture.requestId,requestId),
    )).limit(1);
    if(used)throw new ClockContextChangedError('The retained clock reference cannot be abandoned under this actor.');
    await abandonSubmissionTx(tx,ctx,employmentId,'clock',requestId);
    return {receipt:null,abandoned:true};
  });
}

/**
 * r423 — the employee's "Use Geofencing for Clocking" switch decides the geofence here, as it does for every
 * other punch (core/attendance.ts resolveGeofence). ON: the position must fall inside an active assigned
 * location open to the employee's company, and the capture stores that site, the distance and the radius.
 * OFF: no site or position is required. Available coordinates are retained; absent coordinates stay NULL.
 * Site, distance and radius stay NULL, and the punch is `not_enforced`. Photo policy remains independent.
 * This narrows r378's "a clock capture requires an enforced geofence" to employees whose switch is ON.
 *
 * A refused attempt (outside every site, or no usable site) is written to the audit trail as
 * attendance.geofence.blocked in its OWN transaction after the capture transaction rolls back — the same
 * mechanism checkIn/checkOut use (ADR-0070 §3); an event inside a transaction that rolls back never lands.
 */
export async function captureEmployeeClock(ctx: SessionContext, p: ClockIntent) {
  try {
    return await captureEmployeeClockTx(ctx, p);
  } catch (e) {
    if (e instanceof OutsideGeofenceError) await appendGeofenceBlockedEvent(ctx, e);
    throw e;
  }
}

type NativeCarrier = { employmentId: string; deviceToken?: string; sampledAt: number };
type JoinedCarrier = { tx: Tx; requireNew: boolean };
/** Who records the punch. An online instant is read where it always was, after the subject lock and the request
 * lookup, never at the call site (a tab that waited on the lock must still order after its sibling). An offline
 * instant is the accepted claim's effective time, fixed before planning; its receipt instant is read at planning. */
type ClockSource = { source: 'web' | 'native_online' } | { source: 'mobile_offline'; at: Date; claimDigest: string };
type ClockSubject = { employmentId: string };

async function captureEmployeeClockTx(ctx: SessionContext, p: ClockIntent, native?: NativeCarrier,joined?:JoinedCarrier) {
  ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
  p={...p,...(p.photo?{photo:Buffer.from(p.photo)}:{})}; native=native?{...native}:undefined;
  const me=native?(await (joined?myOwnEmploymentSubjectsTx(joined.tx,ctx,{profileEdit:true}):myEmployments(ctx))).find(e=>e.employmentId===native.employmentId):await resolveOwnClockEmployment(ctx,p.employmentId);
  if(!me)throw new OwnClockEmploymentUnavailableError();
  if(!native&&p.employmentId!==undefined&&p.clockContext==null)throw new ClockContextChangedError('Reopen the selected employee clock context.');
  if (p.clockContext != null && p.clockContext !== clockCommandContext(ctx.tenantId, ctx.userId, me.employmentId)) throw new ClockContextChangedError('Sign in to the original employee account to recover this clocking.');
  if (!['in', 'out'].includes(p.action) || !UUID.test(p.requestId)) throw new Error('Invalid clock request');
  const point = clockLocation(p);
  if(p.locationStatus!=null&&(!LOCATION_CAPTURE_STATUSES.includes(p.locationStatus)||(p.locationStatus==='recorded')!==!!point))throw new ClockLocationError('Location status must agree with the supplied coordinates.');
  if (native && !point) throw new ClockLocationError('Native clocking requires a sampled location');
  const execute=async(tx:Tx)=>{
    const plan=await planClockTx(tx,ctx,me,p,point,native?{source:'native_online'}:{source:'web'},native,joined);
    if(plan.kind==='recorded')return plan.receipt;
    const receipt=await applyClockTx(tx,ctx,plan);
    if(!joined)await assertLegacySelfServiceClockTx(tx,ctx,me.employmentId);
    return receipt;
  };
  return joined?execute(joined.tx):withTenant(ctx,execute);
}

/** Every validation and typed refusal of a clocking, in the online order, with no write: locks and reads only.
 *  First in the transaction on EVERY carrier (web, native online, joined signed native, offline claim): the
 *  Attendance→leave dependency ownership, then the in-transaction re-selection of the own employment through the
 *  SAME selection owner the carrier used outside (or, for a joined/offline carrier, the owner it used in this Tx),
 *  before the subject advisory lock, replay, device, policy, capture, schedule and legacy day locks. */
async function planClockTx(tx:Tx,ctx:SessionContext,me:ClockSubject,p:ClockIntent,point:ReturnType<typeof clockLocation>,clock:ClockSource,native?:NativeCarrier,joined?:JoinedCarrier) {
    const offline=clock.source==='mobile_offline';
    await lockAttendanceLeaveDependenciesTx(tx, ctx, [me.employmentId]);
    // Outside-Tx selection nominates only. Repeat the SAME original selection owner after Access/
    // configuration/subject ownership before replay, policy, capture, schedule or legacy day locks.
    const fresh = joined ? (await myOwnEmploymentSubjectsTx(tx,ctx,{profileEdit:true})).find(row=>row.employmentId===me.employmentId)
      : native ? (await myEmployments(ctx, {}, tx)).find(row=>row.employmentId===native.employmentId)
      : p.employmentId !== undefined ? (await myOwnEmploymentSubjectsTx(tx,ctx,{profileEdit:true})).find(row=>row.employmentId===p.employmentId)
      : await myEmployment(ctx, undefined, tx);
    if (!fresh || fresh.employmentId !== me.employmentId) throw new OwnClockEmploymentUnavailableError();
    // Lock the subject even before its first attendance row exists. Concurrent tabs serialize here.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.tenantId + ':' + me.employmentId}, 0))`);
    if(joined&&!(await myOwnEmploymentSubjectsTx(tx,ctx,{profileEdit:true})).some(e=>e.employmentId===me.employmentId))throw new OwnClockEmploymentUnavailableError();
    if(await submissionAbandonedTx(tx,ctx,me.employmentId,'clock',p.requestId))throw new ClockConflictError('This submission was abandoned before it recorded.');
    // An offline claim carries no legacy device token: a company requiring a registered device refuses it.
    if (native || offline) await enforceDeviceGateTx(tx, { employmentId: me.employmentId, deviceToken: native?.deviceToken });
    const [nativeDevice] = native?.deviceToken ? await tx.select({id:employeeDevice.id}).from(employeeDevice).where(and(eq(employeeDevice.employmentId,me.employmentId),eq(employeeDevice.deviceToken,native.deviceToken),isNull(employeeDevice.revokedAt))).limit(1) : [];
    if (native?.deviceToken && !nativeDevice) throw new DeviceNotRegisteredError();
    // r430 — the employee's OWN attendance_photo_setting decides, read fresh from the row every time
    // (never trusted from the client). required: refuse outright with no photo, before any write.
    // optional: validate a photo if one was sent, otherwise proceed without one. not_required: a photo is
    // never decoded or stored even if the client sent one.
    const [empRow] = await tx.select({ attendancePhotoSetting: employment.attendancePhotoSetting }).from(employment).where(eq(employment.id, me.employmentId)).limit(1);
    const photoSetting = empRow?.attendancePhotoSetting ?? 'not_required';
    if (photoSetting === 'required' && !p.photo) throw new AttendancePhotoRequiredError();
    const photo = photoSetting !== 'not_required' && p.photo ? await decodeClockPhoto(p.photo, p.mime ?? 'image/jpeg') : null;
    // An offline command is its signed claim: same digest whatever the photo setting did, and never an online one's.
    const commandDigest = createHash('sha256').update(JSON.stringify(offline?['mobile_offline',clock.claimDigest]:[p.action, p.lat, p.lng, p.accuracy, photo?.photoDigest ?? '',...(p.locationStatus?[p.locationStatus]:[])])).digest('hex');
    const [accepted] = await tx.select().from(attendanceClockCapture).where(and(eq(attendanceClockCapture.employmentId, me.employmentId), eq(attendanceClockCapture.requestId, p.requestId))).limit(1);
    if (accepted) {
      // A new proof must never retroactively upgrade a capture accepted through another carrier.
      // The signed-command owner recovers its committed receipt before invoking this writer again.
      if(joined?.requireNew)throw new ClockConflictError('This clock reference already recorded before this proof');
      if (accepted.commandDigest !== commandDigest) throw new ClockConflictError('This request already recorded a different clock action');
      return { kind: 'recorded' as const, receipt: publicReceipt(accepted) };
    }
    if(!joined)await assertLegacySelfServiceClockTx(tx,ctx,me.employmentId);
    const now = offline ? clock.at : new Date(), recordedAt = offline ? new Date() : now;
    if (native && (!Number.isFinite(native.sampledAt) || Math.abs(now.getTime()-native.sampledAt)>120000)) throw new ClockLocationError('Capture a fresh location before clocking');
    // Offline skips the fresh-sample rule; its instant must be a whole second (as online punch_at is) not after receipt.
    if (offline && (!Number.isFinite(now.getTime()) || now.getTime() % 1000 !== 0 || now.getTime() > recordedAt.getTime())) throw new OfflineClockPlanRefusal('effective_time_invalid', 'The offline instant must be a whole second before its receipt');
    const date = await clockAttendanceDateTx(tx, me.employmentId, p.action, now, await openClockSessionDateTx(tx, me.employmentId));
    const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kuala_Lumpur', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(now);
    // Ordering is by each capture's own instant: the offline effective time where one exists (draft 0647).
    const [lastCapture] = offline
      ? await tx.select({ direction: attendanceClockCapture.direction, time: sql<Date>`coalesce(${captureEffectiveAt}, ${attendanceClockCapture.serverRecordedAt})`.mapWith(attendanceClockCapture.serverRecordedAt) }).from(attendanceClockCapture).where(eq(attendanceClockCapture.employmentId, me.employmentId)).orderBy(desc(sql`coalesce(${captureEffectiveAt}, ${attendanceClockCapture.serverRecordedAt})`), desc(attendanceClockCapture.id)).limit(1)
      : await tx.select({ direction: attendanceClockCapture.direction, time: attendanceClockCapture.serverRecordedAt }).from(attendanceClockCapture).where(eq(attendanceClockCapture.employmentId, me.employmentId)).orderBy(desc(attendanceClockCapture.serverRecordedAt), desc(attendanceClockCapture.id)).limit(1);
    const [day] = await tx.select({ id: attendance.id, checkIn: attendance.checkInAt, checkOut: attendance.checkOutAt }).from(attendance).where(and(eq(attendance.employmentId, me.employmentId), eq(attendance.attendanceDate, date))).limit(1).for('update');
    // r430 — the direction/state mismatch guard that used to require strict in-then-out is GONE: Clock In
    // and Clock Out are both always allowed, in any order. checkInTx/checkOutTx (core/attendance.ts) accept
    // either on an already-open or already-closed day; checkOutTx creates the day row itself when none
    // exists yet (an out-first day), and the aggregate stores and flags it rather than refusing it.
    if (lastCapture && now.getTime() <= lastCapture.time.getTime()) throw new ClockConflictError('Clocking must follow the previous accepted event');
    const priorPunches = day ? await tx.select({time:attendancePunch.punchAt,captureId:attendancePunch.clockCaptureId}).from(attendancePunch).where(and(eq(attendancePunch.attendanceId,day.id),isNull(attendancePunch.voidedAt))) : [];
    // Approved clock corrections own the aggregate. Retained punches remain evidence and must not recompute
    // that corrected day. The rule is shared with checkInTx/checkOutTx (r434); it stays HERE too so a corrected
    // day is refused before the ordering checks below, with the same typed error. Locking the day above
    // sequences concurrent correction writers.
    await assertDayNotOwnedByCorrectionTx(tx, me.employmentId, date);
    const minute = (wall:string) => Number(wall.slice(0,2))*60+Number(wall.slice(3,5));
    const schedule = await clockScheduleForTx(tx,me.employmentId,date);
    if (!schedule.crossesMidnight && priorPunches.some(punch=>minute(punch.time)>minute(time))) throw new ClockConflictError('Clocking must follow the previous attendance punch');
    // Same-minute relaxation requires a recorded server instant for every same-minute anchor.
    // Legacy/imported/manual anchors keep the existing minute guard and are never reconstructed.
    const sameMinute = priorPunches.filter(punch=>minute(punch.time)===minute(time));
    const legacyAggregateAnchor = p.action==='out' && !priorPunches.length && day?.checkIn && minute(day.checkIn)===minute(time);
    const preciseOrder = !legacyAggregateAnchor && sameMinute.every(punch=>punch.captureId!=null);
    const geo = await resolveGeofence(tx, { employmentId: me.employmentId, date, time, lat: point?.lat, lng: point?.lng,accuracy:point?.accuracy, punch: p.action });
    // Geofenced → a matched site with its distance and radius, or resolveGeofence has already thrown. Not
    // geofenced → the three are stored NULL together (0517) and the position alone is the record.
    if (geo.enforced && (!geo.clockingLocationId || geo.radiusM == null || geo.distanceM == null)) throw new Error('An assigned clocking location is required');
    const site = geo.enforced ? { clockingLocationId: geo.clockingLocationId, distanceM: geo.distanceM, radiusM: geo.radiusM } : { clockingLocationId: null, distanceM: null, radiusM: null };
    // checkInTx/checkOutTx refuse with this same predicate after the capture insert; deciding it here, where they
    // would, keeps the online error order and lets an offline plan refuse before any write.
    const order = clockPunchOrderRefusal({ direction: p.action, time, preciseOrder, crossesMidnight: schedule.crossesMidnight, durationOnly: schedule.durationOnly, dayExists: !!day, punchTimes: priorPunches.map(punch=>punch.time), checkInAt: day?.checkIn ?? null });
    if (order) throw offline ? new ClockConflictError(order) : new Error(order);
    return { kind: 'plan' as const, me, p, point, clock, native, now, recordedAt, date, time, photo, commandDigest, geo, site, preciseOrder, nativeDevice };
}
type ClockPlan = Extract<Awaited<ReturnType<typeof planClockTx>>, { kind: 'plan' }>;
type CaptureValues = typeof attendanceClockCapture.$inferInsert & { id: string };

/** The writes of a planned clocking, in its caller's transaction: capture, canonical punch and audit. */
async function applyClockTx(tx:Tx,ctx:SessionContext,plan:ClockPlan) {
    const { me, p, point, clock, native, now, recordedAt, date, time, photo, commandDigest, geo, site, preciseOrder, nativeDevice } = plan;
    const offline = clock.source === 'mobile_offline';
    const captureId = randomUUID();
    // r430 — the six photo columns are spread ONLY when a photo exists (nullable since 0520; CHECK enforces
    // they land null together). deviceId is never set any more for a Web Clocking capture (nullable since
    // 0520 too) — there is no registered device to attribute it to.
    const values: CaptureValues = { id: captureId, tenantId: ctx.tenantId, employmentId: me.employmentId, attendanceDate: date, direction: p.action, requestId: p.requestId, serverRecordedAt: recordedAt, ...(nativeDevice ? { deviceId:nativeDevice.id } : {}), ...(photo ? { photoCapturedAt: now, photoMimeType: 'image/jpeg', ...photo } : {}), lat: p.lat, lng: p.lng, accuracyM: p.accuracy, ...site, locationCaptureStatus:p.locationStatus??(point?'recorded':null),geofencingRequired:geo.enforced,commandDigest };
    const [capture] = offline ? [await insertOfflineCaptureTx(tx, values, now)] : await tx.insert(attendanceClockCapture).values(values).returning();
    // r430 — deviceGateExempt:true: Web Clocking's own self-capture path is fully exempt from the
    // registered-device policy regardless of whether any tenant has it ON (ADR-0070 amendment). The
    // any other caller (the administrator's manual checkIn/checkOut, which has no screen since r435) never
    // sets this and stays fully policy-gated.
    await (p.action === 'in' ? checkInTx : checkOutTx)(ctx, { employmentId: me.employmentId, date, time, geo: point ?? undefined, deviceGateExempt: clock.source === 'web', deviceToken: native?.deviceToken, clockCaptureId: captureId, preciseOrder, ...(offline ? { method: 'mobile_offline' as const } : {}) }, tx);
    await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'attendance-clock-capture', aggregateId: captureId, eventType: 'attendance.clock.captured', actor: actorOf(ctx), subjectEmploymentId: me.employmentId, payload: { ...(native ? { clientSource: 'native_online', clientLocationTimestamp: native.sampledAt } : {}), ...(offline ? { clientSource: 'mobile_offline', effectiveAt: now.toISOString() } : {}), captureId, direction: p.action, serverRecordedAt: recordedAt.toISOString(), clockingLocationId: site.clockingLocationId, geofence: geo.enforced ? 'pass' : 'not_enforced' } });
    return publicReceipt(capture);
}

// Draft 0647's column, named explicitly: db/schema.ts declares it only once 0647 is journaled (see the note there).
export const attendanceClockCaptureEffectiveAt = sql`${attendanceClockCapture}.effective_at`;
const captureEffectiveAt = attendanceClockCaptureEffectiveAt;
// Readers outside the offline writer run where draft 0647 may be ABSENT (production today, every suite that does
// not apply it), so they never name effective_at unconditionally. The column's presence is read once per
// transaction from pg_attribute (readable by every role, no RLS) and never cached per process: a hosted worker
// installs and drops the draft at runtime, so a process-wide answer would describe the wrong schema.
const effectiveColumnByTx = new WeakMap<Tx, Promise<boolean>>();
function clockCaptureEffectiveColumnTx(tx: Tx): Promise<boolean> {
  let present = effectiveColumnByTx.get(tx);
  if (!present) {
    present = tx.execute<{ present: boolean }>(sql`select exists(select 1 from pg_attribute where attrelid = to_regclass('attendance_clock_capture') and attname = 'effective_at' and not attisdropped) as present`).then(([row]) => row?.present === true);
    effectiveColumnByTx.set(tx, present);
  }
  return present;
}
/** A capture's offline effective instant, or NULL for an online capture and on a database without draft 0647. */
export async function clockCaptureEffectiveAtTx(tx: Tx): Promise<SQL<Date | null>> {
  // mapWith decodes a non-NULL value only; its type is the column's, so the nullable result is stated here.
  return ((await clockCaptureEffectiveColumnTx(tx)) ? sql`${captureEffectiveAt}`.mapWith(attendanceClockCapture.serverRecordedAt) : sql`null::timestamptz`.mapWith(attendanceClockCapture.serverRecordedAt)) as SQL<Date | null>;
}
/** A capture's true instant, coalesce(effective_at, server_recorded_at): an offline capture's server_recorded_at is
 * when it ARRIVED, not when it happened. Without the draft every capture is online and the receipt instant is exact. */
export async function clockCaptureInstantTx(tx: Tx): Promise<SQL<Date>> {
  return (await clockCaptureEffectiveColumnTx(tx)) ? sql<Date>`coalesce(${captureEffectiveAt}, ${attendanceClockCapture.serverRecordedAt})`.mapWith(attendanceClockCapture.serverRecordedAt) : sql<Date>`${attendanceClockCapture.serverRecordedAt}`.mapWith(attendanceClockCapture.serverRecordedAt);
}
/** The canonical capture row plus its effective instant, from the same values object as the online insert. */
async function insertOfflineCaptureTx(tx:Tx,values:CaptureValues,effectiveAt:Date) {
  const columns = getTableColumns(attendanceClockCapture), set = Object.entries(values).filter(([, value]) => value !== undefined) as [keyof typeof columns, unknown][];
  await tx.execute(sql`insert into ${attendanceClockCapture} (${sql.join(set.map(([key]) => sql.identifier(columns[key].name)), sql`,`)},effective_at)
    values (${sql.join(set.map(([key, value]) => sql.param(value, columns[key] as unknown as DriverValueEncoder<unknown, unknown>)), sql`,`)},${effectiveAt.toISOString()}::timestamptz)`);
  const [row] = await tx.select().from(attendanceClockCapture).where(eq(attendanceClockCapture.id, values.id)).limit(1);
  if (!row) throw new Error('Offline clock capture unavailable');
  return row;
}

/** An accepted offline claim's command. Whole-second effectiveAt; claimDigest is the signed claim's sha256. */
export type OfflineClockCommand = { employmentId: string; requestId: string; action: 'in' | 'out'; lat: number; lng: number; accuracy: number;
  photo?: { bytes: Buffer; mimeType: 'image/jpeg' | 'image/png' }; effectiveAt: Date; claimDigest: string };
export type OfflineClockRefusalReason = 'invalid_command' | 'employment_unavailable' | 'clock_conflict' | 'corrected_day' | 'device_unavailable'
  | 'photo_required' | 'photo_invalid' | 'location_invalid' | 'geofence_quality' | 'outside_geofence' | 'effective_time_invalid';
export type OfflineClockRefusal = { kind: 'refused'; reason: OfflineClockRefusalReason; message: string };
export type OfflineClockPlan = ClockPlan;
class OfflineClockPlanRefusal extends Error {
  constructor(readonly reason: OfflineClockRefusalReason, message: string) { super(message); this.name = 'OfflineClockPlanRefusal'; }
}
/** Typed refusals only; anything else (SQL, RLS, a missing site) stays a fault for the caller's transaction. */
function offlineClockRefusal(error: unknown): OfflineClockRefusal | null {
  const reason: OfflineClockRefusalReason | null = error instanceof OfflineClockPlanRefusal ? error.reason
    : error instanceof OwnClockEmploymentUnavailableError ? 'employment_unavailable'
    : error instanceof CorrectedClockConflictError ? 'corrected_day'
    : error instanceof ClockConflictError ? 'clock_conflict'
    : error instanceof DeviceNotRegisteredError ? 'device_unavailable'
    : error instanceof AttendancePhotoRequiredError ? 'photo_required'
    : error instanceof ClockPhotoError ? 'photo_invalid'
    : error instanceof ClockLocationError ? 'location_invalid'
    : error instanceof GeofenceQualityError ? 'geofence_quality'
    : error instanceof OutsideGeofenceError ? 'outside_geofence' : null;
  return reason && error instanceof Error ? { kind: 'refused', reason, message: error.message } : null;
}
/** Plans an offline punch in the CALLER's transaction: every online rule except the 120 s fresh-sample rule,
 * ordered by the effective instant, under the subject lock. Writes nothing; a refusal leaves the transaction usable. */
export async function planOfflineClockTx(tx: Tx, ctx: SessionContext, p: OfflineClockCommand): Promise<OfflineClockPlan | OfflineClockRefusal> {
  try {
    if (!['in', 'out'].includes(p.action) || !UUID.test(p.requestId) || !UUID.test(p.employmentId) || !/^[a-f0-9]{64}$/.test(p.claimDigest) || !(p.effectiveAt instanceof Date))
      throw new OfflineClockPlanRefusal('invalid_command', 'Invalid offline clock command');
    const intent: ClockIntent = { action: p.action, requestId: p.requestId, lat: p.lat, lng: p.lng, accuracy: p.accuracy, ...(p.photo ? { photo: p.photo.bytes, mime: p.photo.mimeType } : {}), locationStatus: 'recorded', employmentId: p.employmentId };
    const point = clockLocation(intent);
    if (!point) throw new ClockLocationError('Offline clocking requires its sampled location');
    const me = (await myOwnEmploymentSubjectsTx(tx, ctx, { profileEdit: true })).find(e => e.employmentId === p.employmentId);
    if (!me) throw new OwnClockEmploymentUnavailableError();
    const plan = await planClockTx(tx, ctx, me, intent, point, { source: 'mobile_offline', at: new Date(p.effectiveAt.getTime()), claimDigest: p.claimDigest }, undefined, { tx, requireNew: true });
    // requireNew refuses any held request ID, so a replayed receipt cannot reach here.
    if (plan.kind !== 'plan') throw new ClockConflictError('This clock reference already recorded');
    return plan;
  } catch (error) {
    const refusal = offlineClockRefusal(error);
    if (refusal) return refusal;
    throw error;
  }
}
/** The canonical offline attendance writer: plans, then writes capture (effective_at), punch (mobile_offline) and
 * audit in the CALLER's transaction; no nested transaction. A refusal writes nothing. Any throw after the first
 * write also aborts that transaction, so a caller that catches it can still never commit a partial clocking. */
export async function captureOfflineClockTx(tx: Tx, ctx: SessionContext, p: OfflineClockCommand) {
  const plan = await planOfflineClockTx(tx, ctx, p);
  if (plan.kind === 'refused') return plan;
  try {
    const receipt = await applyClockTx(tx, ctx, plan);
    return { kind: 'recorded' as const, captureId: receipt.id, date: plan.date, effectiveAt: plan.now.getTime(), receipt };
  } catch (error) {
    await tx.execute(sql`select cast('offline clock write failed; transaction aborted' as integer)`).catch(() => undefined);
    throw error;
  }
}

/** The newest open session (a check-in with no check-out) that a clock-out may close. Read under the subject lock. */
export async function openClockSessionDateTx(tx:Tx,employmentId:string){
  const [unclosed] = await tx.select({ date: attendance.attendanceDate }).from(attendance).where(and(eq(attendance.employmentId, employmentId), isNotNull(attendance.checkInAt), isNull(attendance.checkOutAt))).orderBy(desc(attendance.attendanceDate)).limit(1);
  return unclosed?.date ?? null;
}
/** Sole owner of a clocking's attendance day, online and offline (owner decision 2026-10-28): the instant's
 * MYT day, except that an actual overnight OUT belongs to the open session's start day. punch_at stays the
 * instant's MYT wall time either way, so that out's instant is (start day + 1) + punch_at. `unclosed` is
 * openClockSessionDateTx read before the punch is written. */
export async function clockAttendanceDateTx(tx:Tx,employmentId:string,action:'in'|'out',at:Date,unclosed:string|null){
  const date = todayInKualaLumpur(at);
  if (!unclosed || unclosed === date) return date;
  const previousDate = new Date(at.getTime() - 86400000);
  const overnight = await clockScheduleForTx(tx, employmentId, unclosed);
  // Keep the existing day-based clock policy. Only an actual overnight OUT anchors to yesterday;
  // historical incomplete records never become invented receipts or block a new ordinary day.
  return unclosed === todayInKualaLumpur(previousDate) && overnight.crossesMidnight && action === 'out' ? unclosed : date;
}

/** Native online carrier: own active employment, same transaction and rules, device policy enforced. */
export async function captureNativeClock(ctx: SessionContext, p: ClockIntent & { lat: number; lng: number; accuracy: number; employmentId: string; deviceToken?: string; sampledAt: number }) {
  try { return await captureEmployeeClockTx(ctx, p, { employmentId: p.employmentId, deviceToken: p.deviceToken, sampledAt: p.sampledAt }); }
  catch (e) { if (e instanceof OutsideGeofenceError) await appendGeofenceBlockedEvent(ctx, e); throw e; }
}

/** Internal signed-command seam. The parent owns an attendance-gated tenant transaction, verifies
 * proof and recovers committed receipts. This creates only a NEW capture, with all existing rules;
 * any throw must escape that parent so proof counters and attendance roll back together. */
export async function captureNativeClockInTx(ctx:SessionContext,p:ClockIntent&{lat:number;lng:number;accuracy:number;employmentId:string;deviceToken?:string;sampledAt:number},tx:Tx){
  return captureEmployeeClockTx(ctx,p,{employmentId:p.employmentId,deviceToken:p.deviceToken,sampledAt:p.sampledAt},{tx,requireNew:true});
}

/** Photo bytes are selected only here, under existing subject visibility. */
export async function clockCapturePhoto(ctx: SessionContext, id: string, thumbnail: boolean) {
  if (!UUID.test(id)) return null;
  return withTenant(ctx, async tx => {
    const [photo] = await tx.select({ bytes: thumbnail ? attendanceClockCapture.thumbnailBytes : attendanceClockCapture.photoBytes, purgedAt: attendanceClockCapture.photoPurgedAt }).from(attendanceClockCapture).where(eq(attendanceClockCapture.id, id)).limit(1);
    return photo ?? null;
  });
}

export async function ownClockCaptures(ctx: SessionContext, employmentId: string, date: string) {
  // recordedAt is each capture's true instant (an offline capture's effective time), and orders the list.
  return withTenant(ctx, async tx => { const instant = await clockCaptureInstantTx(tx); return tx.select({ id: attendanceClockCapture.id, direction: attendanceClockCapture.direction, recordedAt: instant, date: attendanceClockCapture.attendanceDate, photoPurgedAt: attendanceClockCapture.photoPurgedAt, locationId: attendanceClockCapture.clockingLocationId }).from(attendanceClockCapture).where(and(eq(attendanceClockCapture.employmentId, employmentId), eq(attendanceClockCapture.attendanceDate, date))).orderBy(desc(instant), desc(attendanceClockCapture.id)); });
}

export async function purgeClockPhoto(ctx: SessionContext, captureId: string) {
  return withTenant(ctx, async tx => {
    const [capture] = await tx.select({ employmentId: attendanceClockCapture.employmentId, purgedAt: attendanceClockCapture.photoPurgedAt }).from(attendanceClockCapture).where(eq(attendanceClockCapture.id, captureId)).limit(1);
    if (!capture) throw new Error('Capture not visible');
    if (capture.purgedAt) {
      // The definer checks admin authority before its idempotent return.
      await tx.execute(sql`select app.purge_attendance_clock_photo(${captureId}::uuid, ${randomUUID()}::uuid)`);
      return;
    }
    await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'attendance-clock-capture', aggregateId: captureId, eventType: 'attendance.clock.photo-purged', actor: actorOf(ctx), subjectEmploymentId: capture.employmentId, payload: { captureId } });
    const [event] = await tx.select({ id: domainEvent.id }).from(domainEvent).where(and(eq(domainEvent.aggregateId, captureId), eq(domainEvent.eventType, 'attendance.clock.photo-purged'))).orderBy(desc(domainEvent.occurredAt), desc(domainEvent.id)).limit(1);
    await tx.execute(sql`select app.purge_attendance_clock_photo(${captureId}::uuid, ${event.id}::uuid)`);
  });
}

/**
 * r423 (83c0d3c8, plan point 13) — the LOCATION EVIDENCE of self-service clock captures, for HR's day
 * detail. A capture carries the phone's position (lat / lng / accuracy) always, and the matched site, the
 * distance and the allowed radius only when geofencing was checked (the employee's switch ON); NULL site
 * means "geofencing not required". Photo bytes are NOT selected here.
 *
 * Read under the caller's own session: attendance_clock_capture's SELECT policy is
 * app.can_see_employment(employment_id), the same visibility as the attendance rows the page already
 * shows, so this widens nothing. An id the caller may not see simply has no entry.
 */
export type ClockCaptureEvidence = {
  locationStatus: LocationCaptureStatus|null;
  captureId: string;
  geofenced: boolean;
  locationName: string | null;
  distanceM: number | null;
  radiusM: number | null;
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
};

export async function clockCaptureEvidence(ctx: SessionContext, captureIds: readonly string[]): Promise<Map<string, ClockCaptureEvidence>> {
  const ids = [...new Set(captureIds.filter((id) => UUID.test(id)))];
  const out = new Map<string, ClockCaptureEvidence>();
  if (!ids.length) return out;
  const rows = await withTenant(ctx, (tx) =>
    tx
      .select({
        locationStatus: attendanceClockCapture.locationCaptureStatus,
        captureId: attendanceClockCapture.id,
        clockingLocationId: attendanceClockCapture.clockingLocationId,
        locationName: clockingLocation.name,
        distanceM: attendanceClockCapture.distanceM,
        radiusM: attendanceClockCapture.radiusM,
        lat: attendanceClockCapture.lat,
        lng: attendanceClockCapture.lng,
        accuracyM: attendanceClockCapture.accuracyM,
      })
      .from(attendanceClockCapture)
      .leftJoin(clockingLocation, eq(clockingLocation.id, attendanceClockCapture.clockingLocationId))
      .where(inArray(attendanceClockCapture.id, ids)),
  );
  for (const r of rows) {
    out.set(r.captureId, {
      locationStatus:r.locationStatus,
      captureId: r.captureId,
      geofenced: r.clockingLocationId != null,
      locationName: r.locationName,
      distanceM: r.distanceM,
      radiusM: r.radiusM,
      lat: r.lat,
      lng: r.lng,
      accuracyM: r.accuracyM,
    });
  }
  return out;
}
