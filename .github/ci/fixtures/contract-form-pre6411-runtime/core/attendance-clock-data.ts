import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { SessionContext,Tx } from '../db/client';
import { appUser, person, employment, attendance, clockingImportLine, clockingImportRun, attendanceClockCapture, domainEvent } from '../db/schema';
import { loopActorOf } from '../lib/ai-centre/loop-attribution';
import { withAttendanceTenant } from './module-gate';
import { clockFingerprint, punchesForCorrectionTx } from './attendance-punch-change';
import { clockCaptureEffectiveAtTx } from './attendance-clock';
import type { TraceClockPolicy } from './attendance-trace';
/** Explicit raw-evidence read, separate from every effective-punch calculation. */
export async function attendanceClockData(ctx: SessionContext, employmentId: string, date: string) {
  return withAttendanceTenant(ctx, async (tx) => {
    if (!await attendanceClockDataAdminAllowedTx(tx,employmentId)) throw new Error('Only an authorised administrator may read raw clock data.');
    const rows = await punchesForCorrectionTx(tx, employmentId, date);
    const [day]=await tx.select({id:attendance.id,trace:attendance.calcTrace}).from(attendance)
      .where(and(eq(attendance.employmentId,employmentId),eq(attendance.attendanceDate,date))).limit(1);
    let clockPolicy=day?.trace?.clockPolicy;
    // An out-only day has no arrival trace. The same write keeps its disposition in the audit ledger.
    if(day&&!day.trace){
      const [event]=await tx.select({payload:domainEvent.payload}).from(domainEvent).where(and(
        eq(domainEvent.tenantId,ctx.tenantId),eq(domainEvent.aggregateType,'attendance'),
        eq(domainEvent.aggregateId,day.id),eq(domainEvent.eventType,'attendance.clock-policy.projected'),
      )).orderBy(desc(domainEvent.sequence)).limit(1);
      const audit=event?.payload as {clockPolicy?:TraceClockPolicy;punchIds?:string[]}|null|undefined;
      const liveIds=rows.filter(row=>!row.voidedAt).map(row=>row.id).sort();
      if(audit?.clockPolicy&&JSON.stringify(audit.punchIds)===JSON.stringify(liveIds))clockPolicy=audit.clockPolicy;
    }
    if(clockPolicy?.attendanceDate!==date||!Array.isArray(clockPolicy.exclusions))clockPolicy=undefined;
    const exclusions=new Map(clockPolicy?.exclusions.map(row=>[row.punchId,row.reason] as const));
    const ids = rows.map(r => r.id);
    const imports = ids.length ? await tx.select({ punchId: clockingImportLine.attendancePunchId, runId: clockingImportLine.runId, fileName: clockingImportRun.fileName }).from(clockingImportLine).innerJoin(clockingImportRun, eq(clockingImportRun.id, clockingImportLine.runId)).where(inArray(clockingImportLine.attendancePunchId, ids)) : [];
    const captureIds = rows.map(r => r.clockCaptureId).filter((id): id is string => !!id);
    // An offline capture carries its effective instant (draft 0647); its server_recorded_at is when it was received.
    const captures = captureIds.length ? await tx.select({ id: attendanceClockCapture.id, digest: attendanceClockCapture.photoDigest, purged: attendanceClockCapture.photoPurgedAt, effectiveAt: await clockCaptureEffectiveAtTx(tx), receivedAt: attendanceClockCapture.serverRecordedAt }).from(attendanceClockCapture).where(inArray(attendanceClockCapture.id, captureIds)) : [];
    const source = (captureId: string | null) => {
      const capture = captureId ? captures.find(c => c.id === captureId) : undefined;
      if (!capture) return { clockSource: null, effectiveAt: null, receivedAt: null };
      return capture.effectiveAt ? { clockSource: 'offline' as const, effectiveAt: capture.effectiveAt.toISOString(), receivedAt: capture.receivedAt.toISOString() } : { clockSource: 'online' as const, effectiveAt: null, receivedAt: null };
    };
    const actors = rows.map(r => r.voidedBy).filter((id): id is string => !!id);
    const names = actors.length ? await tx.select({ id: appUser.id, name: person.fullName }).from(appUser).leftJoin(person, eq(person.id, appUser.personId)).where(and(eq(appUser.tenantId, ctx.tenantId), inArray(sql<string> `${appUser.id}::text`, actors))) : [];
    // AI v2 Phase 2 P2-1: a clocking an AI Centre loop removed (an undo it carried out under its sponsor's authority)
    // names the loop, who asked and its sponsor, from the latest removal's own audit event (migration 0963), never the
    // session's person alone. A clocking a person removed keeps that person's name.
    const voided = rows.filter(r => r.voidedAt).map(r => r.id), removedBy = new Map<string, string | null>();
    if (voided.length) for (const removal of await tx.select({ punchId: domainEvent.aggregateId, payload: domainEvent.payload }).from(domainEvent)
      .where(and(eq(domainEvent.tenantId, ctx.tenantId), eq(domainEvent.aggregateType, 'attendance-punch'), eq(domainEvent.eventType, 'attendance.punch.voided'), inArray(domainEvent.aggregateId, voided)))
      .orderBy(desc(domainEvent.occurredAt), desc(domainEvent.sequence)))
      if (!removedBy.has(removal.punchId)) removedBy.set(removal.punchId, loopActorOf(removal.payload)?.label ?? null);
    return { baseline: clockFingerprint(rows), ...(clockPolicy&&{clockPolicy}), rows: rows.map(r => ({ ...(exclusions.has(r.id)&&{exclusion:exclusions.get(r.id)}),id: r.id, punchAt: r.punchAt, direction: r.direction, method: r.method, captureId: r.clockCaptureId, photoAvailable: captures.some(c => c.id === r.clockCaptureId && !!c.digest && !c.purged), ...source(r.clockCaptureId), lat: r.lat, lng: r.lng, voidedAt: r.voidedAt?.toISOString() ?? null, voidedBy: removedBy.get(r.id) ?? names.find(n => n.id === r.voidedBy)?.name ?? r.voidedBy, voidReason: r.voidReason, importRun: imports.find(i => i.punchId === r.id)?.runId ?? null, importFile: imports.find(i => i.punchId === r.id)?.fileName ?? null })) };
  });
}

/** The exact native administrator predicate; a role label is never substituted for source scope. */
export async function attendanceClockDataAdminAllowedTx(tx:Tx,employmentId:string){
 const [subject] = await tx.select({ allowed: sql<boolean>`app.can_admin_employment(${employment.id})` })
      .from(employment).where(eq(employment.id, employmentId)).limit(1);
 return subject?.allowed===true;
}
/** Caller owns the actual own-actor/config/employee/credit interval before this read. Only editable
 * clock facts leave this source; no photo, coordinates, filename, void reason or actor metadata. */
export async function attendanceCorrectionClockSourceTx(tx:Tx,employmentId:string,date:string){
 if(!await attendanceClockDataAdminAllowedTx(tx,employmentId))throw Error('Clock source unavailable');
 const rows=await punchesForCorrectionTx(tx,employmentId,date);if(rows.length>256)throw Error('Clock source unavailable');
 const baseline=clockFingerprint(rows),current=await punchesForCorrectionTx(tx,employmentId,date);if(clockFingerprint(current)!==baseline)throw Error('Clock source changed');
 return{baseline,rows:current.map(row=>({id:row.id,punchAt:row.punchAt,direction:row.direction,voided:row.voidedAt!==null}))};
}
