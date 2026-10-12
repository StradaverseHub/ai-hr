import { and, eq, inArray, sql } from 'drizzle-orm';
import type { SessionContext } from '../db/client';
import { appUser, person, clockingImportLine, clockingImportRun, attendanceClockCapture } from '../db/schema';
import { withAttendanceTenant } from './module-gate';
import { clockFingerprint, punchesForCorrectionTx } from './attendance-punch-change';
/** Explicit raw-evidence read, separate from every effective-punch calculation. */
export async function attendanceClockData(ctx: SessionContext, employmentId: string, date: string) {
  return withAttendanceTenant(ctx, async (tx) => {
    const allowed = await tx.execute(sql `select app.can_admin_employment(${employmentId}::uuid) as ok`);
    if (!(allowed as unknown as {
      ok: boolean;
    }[])[0]?.ok)
      throw new Error('Only an authorised administrator may read raw clock data.');
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
