import { and, eq, inArray, sql } from 'drizzle-orm';
import type { SessionContext,Tx } from '../db/client';
import { appUser, person, employment, clockingImportLine, clockingImportRun, attendanceClockCapture } from '../db/schema';
import { withAttendanceTenant } from './module-gate';
import { clockFingerprint, punchesForCorrectionTx } from './attendance-punch-change';
/** Explicit raw-evidence read, separate from every effective-punch calculation. */
export async function attendanceClockData(ctx: SessionContext, employmentId: string, date: string) {
  return withAttendanceTenant(ctx, async (tx) => {
    if (!await attendanceClockDataAdminAllowedTx(tx,employmentId)) throw new Error('Only an authorised administrator may read raw clock data.');
    const rows = await punchesForCorrectionTx(tx, employmentId, date);
    const ids = rows.map(r => r.id);
    const imports = ids.length ? await tx.select({ punchId: clockingImportLine.attendancePunchId, runId: clockingImportLine.runId, fileName: clockingImportRun.fileName }).from(clockingImportLine).innerJoin(clockingImportRun, eq(clockingImportRun.id, clockingImportLine.runId)).where(inArray(clockingImportLine.attendancePunchId, ids)) : [];
    const captureIds = rows.map(r => r.clockCaptureId).filter((id): id is string => !!id);
    const captures = captureIds.length ? await tx.select({ id: attendanceClockCapture.id, digest: attendanceClockCapture.photoDigest, purged: attendanceClockCapture.photoPurgedAt }).from(attendanceClockCapture).where(inArray(attendanceClockCapture.id, captureIds)) : [];
    const actors = rows.map(r => r.voidedBy).filter((id): id is string => !!id);
    const names = actors.length ? await tx.select({ id: appUser.id, name: person.fullName }).from(appUser).leftJoin(person, eq(person.id, appUser.personId)).where(and(eq(appUser.tenantId, ctx.tenantId), inArray(sql<string> `${appUser.id}::text`, actors))) : [];
    return { baseline: clockFingerprint(rows), rows: rows.map(r => ({ id: r.id, punchAt: r.punchAt, direction: r.direction, method: r.method, captureId: r.clockCaptureId, photoAvailable: captures.some(c => c.id === r.clockCaptureId && !!c.digest && !c.purged), lat: r.lat, lng: r.lng, voidedAt: r.voidedAt?.toISOString() ?? null, voidedBy: names.find(n => n.id === r.voidedBy)?.name ?? r.voidedBy, voidReason: r.voidReason, importRun: imports.find(i => i.punchId === r.id)?.runId ?? null, importFile: imports.find(i => i.punchId === r.id)?.fileName ?? null })) };
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
