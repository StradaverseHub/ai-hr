/** Employee web command. A private capture and the existing attendance writer share one transaction. */
import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull, isNotNull, sql } from 'drizzle-orm';
import type { SessionContext } from '../db/client';
import { attendance, attendanceClockCapture, attendancePunch, attendanceCorrection, clockingLocation, employment, domainEvent } from '../db/schema';
import { actorOf, appendEvent } from '../db/events';
import { withAttendanceTenant as withTenant } from './module-gate';
import { myEmployment } from './read';
import { ClockConflictError, CorrectedClockConflictError, assertDayNotOwnedByCorrectionTx, appendGeofenceBlockedEvent, checkInTx, checkOutTx, resolveGeofence, clockScheduleForTx, OutsideGeofenceError } from './attendance';
import { decodeClockPhoto } from '../lib/attendance-photo';
import { todayInKualaLumpur, timeInKualaLumpur } from '../lib/hr-date';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// r434 — both classes now live in core/attendance.ts (the shared writers throw them too); re-exported so
// every existing import and `instanceof` keeps the same identity.
export { ClockConflictError, CorrectedClockConflictError };
export class ClockLocationError extends Error {}
// r430 — thrown server-side when the employee's attendance_photo_setting is 'required' and the request
// carried no photo. Never trust the client's own idea of the setting (components/attendance-clock-button.tsx
// and the admin Daily page are untouched by this — this is Web Clocking's own capture path only).
export class AttendancePhotoRequiredError extends Error {}
// r430 — deviceToken is GONE (Web Clocking no longer registers or presents a device); photo/mime are now
// OPTIONAL — whether one is required, optional or ignored is decided server-side from the employee's own
// attendance_photo_setting, never from what the client chooses to send.
export type ClockIntent = { action: 'in' | 'out'; requestId: string; lat: number; lng: number; accuracy: number; photo?: Buffer; mime?: string };
// r430 — photoAvailable must also check photoDigest: a capture with NO photo (not_required, or optional
// skipped) has photoPurgedAt null too (nothing was ever purged), which would otherwise misreport a photo
// that was never taken as available.
const publicReceipt = (row: typeof attendanceClockCapture.$inferSelect) => ({ id: row.id, direction: row.direction, recordedAt: row.serverRecordedAt.toISOString(), date: row.attendanceDate, photoAvailable: row.photoDigest != null && row.photoPurgedAt == null });

/**
 * r423 — the employee's "Use Geofencing for Clocking" switch decides the geofence here, as it does for every
 * other punch (core/attendance.ts resolveGeofence). ON: the position must fall inside an active assigned
 * location open to the employee's company, and the capture stores that site, the distance and the radius.
 * OFF: no site is needed; the capture stores the position (lat / lng / accuracy) with NO site, distance or
 * radius, and the punch is `not_enforced`. The photo and the registered phone are required either way.
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

async function captureEmployeeClockTx(ctx: SessionContext, p: ClockIntent) {
  const me = await myEmployment(ctx);
  if (!me) throw new Error('No active employee profile');
  if (!['in', 'out'].includes(p.action) || !UUID.test(p.requestId)) throw new Error('Invalid clock request');
  if (![p.lat, p.lng, p.accuracy].every(Number.isFinite) || Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180 || p.accuracy < 0) throw new ClockLocationError('Valid location and accuracy are required');
  return withTenant(ctx, async tx => {
    // Lock the subject even before its first attendance row exists. Concurrent tabs serialize here.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.tenantId + ':' + me.employmentId}, 0))`);
    // r430 — the employee's OWN attendance_photo_setting decides, read fresh from the row every time
    // (never trusted from the client). required: refuse outright with no photo, before any write.
    // optional: validate a photo if one was sent, otherwise proceed without one. not_required: a photo is
    // never decoded or stored even if the client sent one.
    const [empRow] = await tx.select({ attendancePhotoSetting: employment.attendancePhotoSetting }).from(employment).where(eq(employment.id, me.employmentId)).limit(1);
    const photoSetting = empRow?.attendancePhotoSetting ?? 'not_required';
    if (photoSetting === 'required' && !p.photo) throw new AttendancePhotoRequiredError();
    const photo = photoSetting !== 'not_required' && p.photo ? await decodeClockPhoto(p.photo, p.mime ?? 'image/jpeg') : null;
    const commandDigest = createHash('sha256').update(JSON.stringify([p.action, p.lat, p.lng, p.accuracy, photo?.photoDigest ?? ''])).digest('hex');
    const [accepted] = await tx.select().from(attendanceClockCapture).where(and(eq(attendanceClockCapture.employmentId, me.employmentId), eq(attendanceClockCapture.requestId, p.requestId))).limit(1);
    if (accepted) {
      if (accepted.commandDigest !== commandDigest) throw new ClockConflictError('This request already recorded a different clock action');
      return publicReceipt(accepted);
    }
    const now = new Date();
    let date = todayInKualaLumpur(now);
    const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kuala_Lumpur', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(now);
    const [unclosed] = await tx.select({ date: attendance.attendanceDate }).from(attendance).where(and(eq(attendance.employmentId, me.employmentId), isNotNull(attendance.checkInAt), isNull(attendance.checkOutAt))).orderBy(desc(attendance.attendanceDate)).limit(1);
    if (unclosed && unclosed.date !== date) {
      const previousDate = new Date(now.getTime() - 86400000);
      const overnight = await clockScheduleForTx(tx, me.employmentId, unclosed.date);
      // Keep the existing day-based clock policy. Only an actual overnight OUT anchors to yesterday;
      // historical incomplete records never become invented receipts or block a new ordinary day.
      if (unclosed.date === todayInKualaLumpur(previousDate) && overnight.crossesMidnight && p.action === 'out') date = unclosed.date;
    }
    const [lastCapture] = await tx.select({ direction: attendanceClockCapture.direction, time: attendanceClockCapture.serverRecordedAt }).from(attendanceClockCapture).where(eq(attendanceClockCapture.employmentId, me.employmentId)).orderBy(desc(attendanceClockCapture.serverRecordedAt), desc(attendanceClockCapture.id)).limit(1);
    const [day] = await tx.select({ id: attendance.id, checkIn: attendance.checkInAt, checkOut: attendance.checkOutAt }).from(attendance).where(and(eq(attendance.employmentId, me.employmentId), eq(attendance.attendanceDate, date))).limit(1).for('update');
    // r430 — the direction/state mismatch guard that used to require strict in-then-out is GONE: Clock In
    // and Clock Out are both always allowed, in any order. checkInTx/checkOutTx (core/attendance.ts) accept
    // either on an already-open or already-closed day; checkOutTx creates the day row itself when none
    // exists yet (an out-first day), and the aggregate stores and flags it rather than refusing it.
    if (lastCapture && now.getTime() <= lastCapture.time.getTime()) throw new ClockConflictError('Clocking must follow the previous accepted event');
    const priorPunches = day ? await tx.select({time:attendancePunch.punchAt,captureId:attendancePunch.clockCaptureId}).from(attendancePunch).where(eq(attendancePunch.attendanceId,day.id)) : [];
    // Approved clock corrections own the aggregate. Retained punches remain evidence and must not recompute
    // that corrected day. The rule is shared with checkInTx/checkOutTx (r434); it stays HERE too so a corrected
    // day is refused before the ordering checks below, with the same typed error. Locking the day above
    // sequences concurrent correction writers.
    await assertDayNotOwnedByCorrectionTx(tx, me.employmentId, date);
    const minute = (clock:string) => Number(clock.slice(0,2))*60+Number(clock.slice(3,5));
    const schedule = await clockScheduleForTx(tx,me.employmentId,date);
    if (!schedule.crossesMidnight && priorPunches.some(punch=>minute(punch.time)>minute(time))) throw new ClockConflictError('Clocking must follow the previous attendance punch');
    // Same-minute relaxation requires a recorded server instant for every same-minute anchor.
    // Legacy/imported/manual anchors keep the existing minute guard and are never reconstructed.
    const sameMinute = priorPunches.filter(punch=>minute(punch.time)===minute(time));
    const legacyAggregateAnchor = p.action==='out' && !priorPunches.length && day?.checkIn && minute(day.checkIn)===minute(time);
    const preciseOrder = !legacyAggregateAnchor && sameMinute.every(punch=>punch.captureId!=null);
    const geo = await resolveGeofence(tx, { employmentId: me.employmentId, date, time, lat: p.lat, lng: p.lng, punch: p.action });
    // Geofenced → a matched site with its distance and radius, or resolveGeofence has already thrown. Not
    // geofenced → the three are stored NULL together (0517) and the position alone is the record.
    if (geo.enforced && (!geo.clockingLocationId || geo.radiusM == null || geo.distanceM == null)) throw new Error('An assigned clocking location is required');
    const site = geo.enforced ? { clockingLocationId: geo.clockingLocationId, distanceM: geo.distanceM, radiusM: geo.radiusM } : { clockingLocationId: null, distanceM: null, radiusM: null };
    const captureId = randomUUID();
    // r430 — the six photo columns are spread ONLY when a photo exists (nullable since 0520; CHECK enforces
    // they land null together). deviceId is never set any more for a Web Clocking capture (nullable since
    // 0520 too) — there is no registered device to attribute it to.
    const [capture] = await tx.insert(attendanceClockCapture).values({ id: captureId, tenantId: ctx.tenantId, employmentId: me.employmentId, attendanceDate: date, direction: p.action, requestId: p.requestId, serverRecordedAt: now, ...(photo ? { photoCapturedAt: now, photoMimeType: 'image/jpeg', ...photo } : {}), lat: p.lat, lng: p.lng, accuracyM: p.accuracy, ...site, commandDigest }).returning();
    // r430 — deviceGateExempt:true: Web Clocking's own self-capture path is fully exempt from the
    // registered-device policy regardless of whether any tenant has it ON (ADR-0070 amendment). The
    // any other caller (the administrator's manual checkIn/checkOut, which has no screen since r435) never
    // sets this and stays fully policy-gated.
    await (p.action === 'in' ? checkInTx : checkOutTx)(ctx, { employmentId: me.employmentId, date, time, geo: { lat: p.lat, lng: p.lng }, deviceGateExempt: true, clockCaptureId: captureId, preciseOrder }, tx);
    await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'attendance-clock-capture', aggregateId: captureId, eventType: 'attendance.clock.captured', actor: actorOf(ctx), subjectEmploymentId: me.employmentId, payload: { captureId, direction: p.action, serverRecordedAt: now.toISOString(), clockingLocationId: site.clockingLocationId, geofence: geo.enforced ? 'pass' : 'not_enforced' } });
    return publicReceipt(capture);
  });
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
  return withTenant(ctx, tx => tx.select({ id: attendanceClockCapture.id, direction: attendanceClockCapture.direction, recordedAt: attendanceClockCapture.serverRecordedAt, date: attendanceClockCapture.attendanceDate, photoPurgedAt: attendanceClockCapture.photoPurgedAt, locationId: attendanceClockCapture.clockingLocationId }).from(attendanceClockCapture).where(and(eq(attendanceClockCapture.employmentId, employmentId), eq(attendanceClockCapture.attendanceDate, date))).orderBy(desc(attendanceClockCapture.serverRecordedAt), desc(attendanceClockCapture.id)));
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
  captureId: string;
  geofenced: boolean;
  locationName: string | null;
  distanceM: number | null;
  radiusM: number | null;
  lat: number;
  lng: number;
  accuracyM: number;
};

export async function clockCaptureEvidence(ctx: SessionContext, captureIds: readonly string[]): Promise<Map<string, ClockCaptureEvidence>> {
  const ids = [...new Set(captureIds.filter((id) => UUID.test(id)))];
  const out = new Map<string, ClockCaptureEvidence>();
  if (!ids.length) return out;
  const rows = await withTenant(ctx, (tx) =>
    tx
      .select({
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
