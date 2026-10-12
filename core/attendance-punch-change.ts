import { createHash } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import type { SessionContext, Tx } from '../db/client';
import { attendancePunch, employment, payrollBatch } from '../db/schema';
import { actorOf, appendEvent } from '../db/events';
import { batchesCoveringAttendanceDates, closedBatchesCoveringAttendanceDates, markBatchNeedsRecalc } from '../packs/payroll/service';
export type ClockEntry = {
  id?: string;
  punchAt: string;
  direction: 'in' | 'out';
};
export type ClockChanges = {
  version: 1;
  baseline: string;
  entries: ClockEntry[];
};
type Punch = typeof attendancePunch.$inferSelect;
export class ClockDataChangedError extends Error {
  constructor() { super('Clock data changed. Reload the day before submitting or approving this correction.'); }
}
export class AttendancePayrollClosedError extends Error {
  constructor() { super('This attendance date is included in a closed payroll. Reopen the payroll before correcting it.'); }
}
export function clockFingerprint(rows: Punch[]): string {
  return createHash('sha256').update(JSON.stringify(rows.map(r => [r.id, r.punchAt, r.direction, r.voidedAt?.toISOString() ?? null]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))).digest('hex');
}
export function validateClockEntries(entries: ClockEntry[]): ClockEntry[] {
  if (!Array.isArray(entries) || entries.length > 100)
    throw new Error('At most 100 clockings may be saved together.');
  const keys = new Set<string>(), ids = new Set<string>();
  return entries.map(e => {
    if (!e || !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(e.punchAt) || !['in', 'out'].includes(e.direction))
      throw new Error('Enter a valid clocking time and direction.');
    if (e.id && (!/^[0-9a-f-]{36}$/i.test(e.id) || ids.has(e.id)))
      throw new Error('Invalid or repeated clocking identifier.');
    const punchAt = e.punchAt.length === 5 ? e.punchAt + ':00' : e.punchAt;
    const key = punchAt + ':' + e.direction;
    if (keys.has(key))
      throw new Error('The same time and direction is already in use.');
    keys.add(key);
    if (e.id)
      ids.add(e.id);
    return { ...(e.id ? { id: e.id } : {}), punchAt, direction: e.direction };
  });
}
export function punchesForCorrectionTx(tx: Tx, employmentId: string, date: string) {
  return tx.select().from(attendancePunch).where(and(eq(attendancePunch.employmentId, employmentId), eq(attendancePunch.attendanceDate, date))).orderBy(asc(attendancePunch.punchAt), asc(attendancePunch.id));
}
export async function lockAttendancePayrollTx(tx: Tx, employmentId: string, date: string) {
  const [subject] = await tx.select({ companyId: employment.companyId }).from(employment).where(eq(employment.id, employmentId)).limit(1);
  if (!subject)
    throw new Error('Employee not visible');
  // The same row lock used by payroll close serializes a correction with finalisation.
  await tx.select({ id: payrollBatch.id }).from(payrollBatch).where(eq(payrollBatch.companyId, subject.companyId)).orderBy(asc(payrollBatch.id)).for('update');
  if ((await closedBatchesCoveringAttendanceDates(tx, { companyId: subject.companyId, entries: [{ employmentId, date }] })).length)
    throw new AttendancePayrollClosedError();
  return subject.companyId;
}
export async function markAttendancePayrollTx(tx: Tx, ctx: SessionContext, companyId: string, employmentId: string, date: string) {
  for (const b of await batchesCoveringAttendanceDates(tx, { companyId, entries: [{ employmentId, date }] }))
    await markBatchNeedsRecalc(tx, ctx, { batchId: b.batchId, employmentIds: b.employmentIds });
}
export async function applyClockChangesTx(tx: Tx, ctx: SessionContext, p: {
  attendanceId: string;
  employmentId: string;
  date: string;
  reason: string;
  correctionId: string;
  changes: ClockChanges;
}) {
  const rows = await punchesForCorrectionTx(tx, p.employmentId, p.date);
  if (clockFingerprint(rows) !== p.changes.baseline)
    throw new ClockDataChangedError();
  const entries = validateClockEntries(p.changes.entries);
  for (const e of entries)
    if (e.id && !rows.some(r => r.id === e.id))
      throw new Error('Clocking does not belong to this attendance day.');
  const unchanged = new Set(entries.filter(e => e.id && rows.some(r => r.id === e.id && r.punchAt === e.punchAt && r.direction === e.direction)).map(e => e.id!));
  const now = new Date();
  const event = (eventType: string, id: string, before: unknown, after: unknown) => appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'attendance-punch', aggregateId: id, eventType, actor: actorOf(ctx), subjectEmploymentId: p.employmentId, payload: { correctionId: p.correctionId, reason: p.reason, before, after } });
  // Void superseded entries before restoring/inserting, so the live unique index sees the final set.
  for (const row of rows.filter(r => !r.voidedAt && !unchanged.has(r.id))) {
    const metadata = { voidedAt: now, voidedBy: ctx.userId ?? 'system', voidReason: p.reason };
    await tx.update(attendancePunch).set(metadata).where(eq(attendancePunch.id, row.id));
    await event('attendance.punch.voided', row.id, { punchAt: row.punchAt, direction: row.direction }, metadata);
  }
  for (const e of entries) {
    const original = e.id ? rows.find(r => r.id === e.id)! : null;
    if (original && unchanged.has(original.id)) {
      if (original.voidedAt) {
        await tx.update(attendancePunch).set({ voidedAt: null, voidedBy: null, voidReason: null }).where(eq(attendancePunch.id, original.id));
        await event('attendance.punch.restored', original.id, { voidedAt: original.voidedAt, voidedBy: original.voidedBy, voidReason: original.voidReason }, { punchAt: e.punchAt, direction: e.direction });
      }
    }
    else {
      const [added] = await tx.insert(attendancePunch).values({ tenantId: ctx.tenantId, attendanceId: p.attendanceId, employmentId: p.employmentId, attendanceDate: p.date, punchAt: e.punchAt, direction: e.direction, method: 'admin' }).returning({ id: attendancePunch.id });
      await event('attendance.punch.added', added.id, original ? { supersedes: original.id } : null, { punchAt: e.punchAt, direction: e.direction, method: 'admin' });
    }
  }
}
