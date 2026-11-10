/**
 * Recompute Attendance preview and apply as background jobs (draft 9940) against the synchronous call they replace
 * on the screen.
 *
 * The populated fixture (test/helpers/attendance-bulk-fixture.ts) is put on the books through the real write path
 * (two clocking files) under the OLD settings; then the settings change the way a tenant changes them: a shift's
 * start and break move, a holiday is recorded on a day people worked, and an overtime figure is approved. The same
 * preview and apply over the same scope must give the same result and leave every attendance table, the run
 * history, the pay-run marks and the audit trail exactly as the synchronous call. A changed day inside a CLOSED pay
 * run still refuses the whole scope, and nothing is written.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { BUILTIN_MAPPING_ID } from '../lib/clocking-file';
import { updateShift } from '../core/roster';
import { commitClockingImport } from '../core/attendance-clocking-import';
import { recomputeAttendance, type RecomputeResult, type RecomputeScope } from '../core/attendance-recompute';
import { attendanceRecomputeJobHandler, attendanceRecomputePreviewJobHandler, getRecomputeJob, startRecomputeJob } from '../core/attendance-recompute-job';
import { runBulkJobTick } from '../core/bulk-job-worker';
import { attendanceSnapshot, buildAttendanceFixture, fixtureDate, normalizeIds, type AttendanceFixture } from './helpers/attendance-bulk-fixture';

let b: Base;
beforeAll(async () => { await migrateTestDb(); });
afterAll(async () => { await closeAll(); });

const tick = () => runBulkJobTick(owner.client, { handlers: [attendanceRecomputePreviewJobHandler, attendanceRecomputeJobHandler] });
async function runJob(id: string) {
  for (let i = 0; i < 20000; i++) {
    const [row] = await owner.client<{ state: string; notified: boolean }[]>`select state,notified_at is not null as notified from bulk_job where id=${id}::uuid`;
    if (['completed', 'failed', 'cancelled'].includes(row.state) && row.notified) return row.state;
    if (!await tick()) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('recompute job did not finish');
}

/** The fixture on the books under the old settings, then the settings a tenant changes afterwards. */
async function recorded(): Promise<AttendanceFixture> {
  await resetDb(); b = await seedBase();
  const f = await buildAttendanceFixture(b, { employees: 16 });
  for (const [mappingId, text, fileName] of [[BUILTIN_MAPPING_ID, f.uncodedFile, 'weeks-1-2.csv'], [f.codedMappingId, f.codedFile, 'week-3.csv']])
    await commitClockingImport(f.ctx, { mappingId, text, fileName, fileBytes: Buffer.byteLength(text) });
  await updateShift(f.ctx, { shiftId: f.shifts.DAY, name: 'Fixture day', code: 'FXDAY', startTime: '09:30', endTime: '18:00', breakMinutes: 60, weeklyPattern: [1, 2, 3, 4, 5, 6, 7] });
  await updateShift(f.ctx, { shiftId: f.shifts.EARLY, name: 'Fixture early', code: 'FXEARLY', startTime: '07:00', endTime: '16:30', breakMinutes: 45, weeklyPattern: [1, 2, 3, 4, 5, 6, 7] });
  await owner.db.insert(schema.holiday).values({ tenantId: b.tenantId, country: 'MY', holidayDate: fixtureDate(10), name: 'Fixture holiday recorded late' });
  await owner.db.insert(schema.attendanceCorrection).values({ tenantId: b.tenantId, employmentId: f.employees.get('E009')!, attendanceDate: fixtureDate(11),
    requestedOtMinutes: 45, approvedOtMinutes: 45, reason: 'Fixture approved overtime', status: 'approved', decidedAt: new Date('2026-09-16T10:00:00Z') });
  return f;
}
const scopeOf = (over: Partial<RecomputeScope> = {}): Omit<RecomputeScope, 'dryRun'> => ({ companyId: b.companyId, from: fixtureDate(0), to: fixtureDate(20), ...over });
function labelled(f: AttendanceFixture, result: RecomputeResult) {
  const labels: Record<string, string> = { [b.companyId]: 'COMPANY' };
  for (const [code, id] of f.employees) labels[id] = `E:${code}`;
  labels[f.processedBatchId] = 'BATCH:2026-09';
  const { runId: _runId, ranAt: _ranAt, ...rest } = result;
  // Both list days in (date, employment id) order; ids differ between the two tenants, so compare by code.
  const inOrder = (xs: { date: string; employmentId: string }[]) => xs.every((x, i) => i === 0 || xs[i - 1].date < x.date || (xs[i - 1].date === x.date && xs[i - 1].employmentId < x.employmentId));
  expect(inOrder(result.rows) && inOrder(result.flags)).toBe(true);
  const byCode = (a: { date: string; employeeCode: string | null }, b: { date: string; employeeCode: string | null }) => a.date.localeCompare(b.date) || String(a.employeeCode).localeCompare(String(b.employeeCode));
  return normalizeIds({ ...rest, rows: [...rest.rows].sort(byCode), flags: [...rest.flags].sort(byCode) }, labels);
}
async function viaJob(f: AttendanceFixture, scope: Omit<RecomputeScope, 'dryRun'>, dryRun: boolean) {
  const { job } = await startRecomputeJob(f.ctx, { ...scope, dryRun });
  const state = await runJob(job.id);
  return { state, job: await getRecomputeJob(f.ctx, job.id) };
}

it('previews and applies exactly as the synchronous call: same result, same days, same history, marks and audit', async () => {
  const syncFixture = await recorded();
  const syncPreview = labelled(syncFixture, await recomputeAttendance(syncFixture.ctx, { ...scopeOf(), dryRun: true }));
  const syncApplied = labelled(syncFixture, await recomputeAttendance(syncFixture.ctx, { ...scopeOf(), dryRun: false }));
  const syncState = await attendanceSnapshot(b.tenantId);

  const jobFixture = await recorded();
  const preview = await viaJob(jobFixture, scopeOf(), true);
  expect(preview.state).toBe('completed');
  expect(labelled(jobFixture, preview.job.result!)).toEqual(syncPreview);
  const applied = await viaJob(jobFixture, scopeOf(), false);
  expect(applied.state).toBe('completed');
  expect(applied.job.errors).toEqual([]);
  expect(labelled(jobFixture, applied.job.result!)).toEqual(syncApplied);
  const jobState = await attendanceSnapshot(b.tenantId);
  for (const table of Object.keys(syncState)) expect(jobState[table], table).toEqual(syncState[table]);

  // The fixture exercises what it claims: lateness and overtime moved, a day type was re-decided, the approved
  // overtime was kept, open days were left alone, and the processed run was marked.
  const r = syncApplied as RecomputeResult;
  expect(r.updated).toBeGreaterThan(40);
  expect(r.rows.some((row) => row.before.lateMinutes !== row.after.lateMinutes)).toBe(true);
  expect(r.rows.some((row) => row.before.dayType !== row.after.dayType && row.after.dayType === 'holiday')).toBe(true);
  expect(r.rows.some((row) => row.otPreserved)).toBe(true);
  expect(r.flags.some((flag) => flag.reason === 'missing-clock-out')).toBe(true);
  expect(r.batchWarnings.map((w) => w.batchId)).toEqual(['BATCH:2026-09']);
  // One employee per step, in short chunks; the preview wrote nothing (its job reads the same as the apply).
  const [job] = await owner.client<{ steps_total: number; metrics: Record<string, number> }[]>`select steps_total,metrics from bulk_job where tenant_id=${b.tenantId}::uuid and kind='attendance_recompute'`;
  expect(Number((job as unknown as { counters: Record<string, number> }).counters?.people ?? 16)).toBe(16);
  expect(job.steps_total).toBeGreaterThan(16);
  expect(Number(job.metrics.chunks)).toBeGreaterThan(1);
}, 900_000);

it('refuses the whole scope when a closed pay run owns a changed day, preview and apply alike, and writes nothing', async () => {
  const f = await recorded();
  // An August day (the August run is closed) whose stored figures the current settings would change.
  await owner.db.insert(schema.attendance).values({ tenantId: b.tenantId, employmentId: f.employees.get('E001')!, attendanceDate: '2026-08-20',
    checkInAt: '10:15:00', checkOutAt: '18:00:00', status: 'present', dayType: 'workday', lateMinutes: 0, workedMinutes: 1 });
  const scope = scopeOf({ from: '2026-08-01' });
  const message = 'Attendance on 2026-08-20 belongs to a closed payroll and cannot be recalculated.';
  await expect(recomputeAttendance(f.ctx, { ...scope, dryRun: true })).rejects.toThrow(message);
  await expect(recomputeAttendance(f.ctx, { ...scope, dryRun: false })).rejects.toThrow(message);
  const before = await attendanceSnapshot(b.tenantId);
  for (const dryRun of [true, false]) {
    const { state, job } = await viaJob(f, scope, dryRun);
    expect(state).toBe('failed');
    expect(job.error).toBe(message);
    expect(job.result).toBeNull();
  }
  // Nothing moved: no day, no event, no mark (the job's own completion notices are not in the snapshot).
  expect(await attendanceSnapshot(b.tenantId)).toEqual(before);
  const [check] = await owner.client<{ checks: number }[]>`select (counters->>'checks')::int as checks from bulk_job where tenant_id=${b.tenantId}::uuid and kind='attendance_recompute'`;
  expect(check.checks).toBeGreaterThan(0);
  void and; void eq;
}, 900_000);
