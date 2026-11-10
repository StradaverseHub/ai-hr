/**
 * Import Clocking Data as a background job (draft 9940) against the synchronous import it replaces on the screen.
 *
 * The claim: the job moves WHERE the import runs, not what it decides or writes. So the same two files imported
 * into the same populated fixture (test/helpers/attendance-bulk-fixture.ts: many employees, three weeks of
 * rotating day / early / night shifts, a holiday, Clock-screen and offline clockings, a corrected day, a legacy
 * day, a processed and a closed pay run) must leave every attendance table, the import log, the pay-run marks and
 * the audit trail exactly as the synchronous import leaves them. Then what only the job can do: decide a day
 * against a clocking made while it runs, leave out one employee whose card changed, refuse a mapping deactivated
 * while it waited, and hold the tenant locks one short chunk at a time.
 */
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { BUILTIN_MAPPING_ID } from '../lib/clocking-file';
import { checkIn } from '../core/attendance';
import { commitClockingImport, setClockingMappingActive, type ClockingImportOutcome } from '../core/attendance-clocking-import';
import { CLOCKING_NOT_IMPORTED, ClockingImportJobRefused, clockingImportJobHandler, getClockingImportJob, startClockingImportJob } from '../core/attendance-clocking-import-job';
import { runBulkJobTick } from '../core/bulk-job-worker';
import { attendanceSnapshot, buildAttendanceFixture, fixtureDate, normalizeIds, type AttendanceFixture } from './helpers/attendance-bulk-fixture';

let b: Base;
beforeAll(async () => { await migrateTestDb(); });
afterAll(async () => { await closeAll(); });

const tick = () => runBulkJobTick(owner.client, { handlers: [clockingImportJobHandler] });
async function runJob(id: string, until?: (state: string) => boolean) {
  for (let i = 0; i < 20000; i++) {
    const [row] = await owner.client<{ state: string; notified: boolean }[]>`select state,notified_at is not null as notified from bulk_job where id=${id}::uuid`;
    if (until?.(row.state)) return row.state;
    if (['completed', 'failed', 'cancelled'].includes(row.state) && row.notified) return row.state;
    if (!await tick()) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('clocking import job did not finish');
}
async function viaJob(ctx: SessionContext, p: { mappingId: string; text: string; fileName: string }) {
  const { job } = await startClockingImportJob(ctx, { ...p, fileBytes: Buffer.byteLength(p.text) });
  expect(job.state).toBe('queued');
  expect(await runJob(job.id)).toBe('completed');
  return (await getClockingImportJob(ctx, job.id)).result!;
}
async function runLabels(tenantId: string) {
  const runs = await owner.client<{ id: string; n: number; file: string }[]>`select id,file_name as file,(row_number() over (order by created_at,id))::int as n from clocking_import_run where tenant_id=${tenantId}::uuid`;
  return Object.fromEntries(runs.map((r) => [r.id, `RUN:${r.n}:${r.file}`]));
}
async function importBoth(f: AttendanceFixture, run: (p: { mappingId: string; text: string; fileName: string }) => Promise<ClockingImportOutcome>) {
  return [await run({ mappingId: BUILTIN_MAPPING_ID, text: f.uncodedFile, fileName: 'weeks-1-2.csv' }), await run({ mappingId: f.codedMappingId, text: f.codedFile, fileName: 'week-3.csv' })];
}

it('leaves every attendance table, the import log, the pay-run marks and the audit trail exactly as the synchronous import', async () => {
  await resetDb(); b = await seedBase();
  const syncFixture = await buildAttendanceFixture(b);
  const syncOutcomes = await importBoth(syncFixture, (p) => commitClockingImport(syncFixture.ctx, { ...p, fileBytes: Buffer.byteLength(p.text) }));
  const syncState = await attendanceSnapshot(b.tenantId);
  const syncResult = normalizeIds(syncOutcomes, await runLabels(b.tenantId));

  await resetDb(); b = await seedBase();
  const jobFixture = await buildAttendanceFixture(b);
  const jobOutcomes = await importBoth(jobFixture, (p) => viaJob(jobFixture.ctx, p));
  const jobState = await attendanceSnapshot(b.tenantId);
  expect(normalizeIds(jobOutcomes, await runLabels(b.tenantId))).toEqual(syncResult);
  for (const table of Object.keys(syncState)) expect(jobState[table], table).toEqual(syncState[table]);

  // The fixture exercises what it claims: every refusal, a mark on the processed run, and real work on the days.
  const results = new Set(syncState.clocking_import_line.map((l) => (JSON.parse(l) as { result: string }).result));
  for (const r of ['imported', 'duplicate', 'unmatched_card', 'invalid_date', 'future_date', 'not_employed_on_date', 'period_closed', 'uncoded_on_clocked_day', 'day_corrected'])
    expect(results, r).toContain(r);
  const [processed] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, jobFixture.processedBatchId));
  expect(processed.needsRecalcAt).not.toBeNull();
  const days = syncState.attendance.map((d) => JSON.parse(d) as { status: string; late_minutes: number | null; ot_minutes: number | null; day_type: string });
  expect(days.some((d) => (d.late_minutes ?? 0) > 0)).toBe(true);
  expect(days.some((d) => (d.ot_minutes ?? 0) > 0)).toBe(true);
  expect(days.some((d) => d.day_type === 'holiday')).toBe(true);
  expect(syncOutcomes[0].imported).toBeGreaterThan(500);
  // The job ran one employee per step in many short chunks, with its timings on the job.
  const [job] = await owner.client<{ steps_total: number; counters: Record<string, number>; metrics: Record<string, number> }[]>`select steps_total,counters,metrics from bulk_job where tenant_id=${b.tenantId}::uuid and kind='clocking_import' order by created_at limit 1`;
  expect(Number(job.counters.employees)).toBe(25);
  expect(job.steps_total).toBeGreaterThan(3);
  expect(Number(job.metrics.chunks)).toBeGreaterThan(1);
  expect(Number(job.metrics.chunkHoldMs)).toBeGreaterThan(0);
}, 900_000);

it('decides each employee against their day as it stands when the step runs, and leaves out an employee whose card changed', async () => {
  await resetDb(); b = await seedBase();
  const f = await buildAttendanceFixture(b, { employees: 8 });
  const ctx = adminCtx(b);
  const { job } = await startClockingImportJob(ctx, { mappingId: BUILTIN_MAPPING_ID, text: f.uncodedFile, fileName: 'weeks-1-2.csv', fileBytes: f.uncodedFile.length });
  expect(await runJob(job.id, (s) => s === 'running')).toBe('running');
  // Prepared, nothing written yet. E001 clocks in on the Clock screen; E003's card is replaced.
  await checkIn(ctx, { employmentId: f.employees.get('E001')!, date: fixtureDate(0), time: '08:40:00' });
  await owner.db.update(schema.employment).set({ cardId: 'NEW-CARD' }).where(eq(schema.employment.id, f.employees.get('E003')!));
  expect(await runJob(job.id)).toBe('completed');
  const done = await getClockingImportJob(ctx, job.id);
  const lines = await owner.db.select().from(schema.clockingImportLine).where(eq(schema.clockingImportLine.runId, done.result!.runId!));
  const of = (code: string) => lines.filter((l) => l.employmentId === f.employees.get(code));
  // The day E001 clocked on is now a Clock-screen day: the uncoded lines for it are listed, not added.
  expect(of('E001').filter((l) => l.punchDate === fixtureDate(0)).map((l) => l.result)).toEqual(expect.arrayContaining(['uncoded_on_clocked_day']));
  expect(of('E001').filter((l) => l.punchDate === fixtureDate(0)).every((l) => l.result === 'uncoded_on_clocked_day')).toBe(true);
  // E003 is left out, visibly; everyone else imported.
  expect(of('E003').length).toBeGreaterThan(0);
  expect(of('E003').every((l) => l.result === 'other' && l.message === CLOCKING_NOT_IMPORTED)).toBe(true);
  expect(await owner.db.select().from(schema.attendancePunch).where(and(eq(schema.attendancePunch.employmentId, f.employees.get('E003')!), eq(schema.attendancePunch.method, 'import')))).toHaveLength(0);
  expect(done.errors).toHaveLength(1);
  expect(done.errors[0].message).toMatch(/changed during the import/);
  expect(of('E002').some((l) => l.result === 'imported')).toBe(true);
  const [run] = await owner.db.select().from(schema.clockingImportRun).where(eq(schema.clockingImportRun.id, done.result!.runId!));
  expect(run).toMatchObject({ failureReason: null, importedLines: done.result!.imported, totalLines: lines.length });
}, 300_000);

it('refuses a job whose mapping was deactivated while it waited (no run is logged), and runs one import per tenant at a time', async () => {
  await resetDb(); b = await seedBase();
  const f = await buildAttendanceFixture(b, { employees: 8 });
  const ctx = adminCtx(b);
  const { job } = await startClockingImportJob(ctx, { mappingId: f.codedMappingId, text: f.codedFile, fileName: 'week-3.csv', fileBytes: f.codedFile.length });
  await expect(startClockingImportJob(ctx, { mappingId: BUILTIN_MAPPING_ID, text: f.uncodedFile, fileName: 'other.csv', fileBytes: 10 }))
    .rejects.toMatchObject({ code: 'alreadyRunning' } satisfies Partial<ClockingImportJobRefused>);
  await setClockingMappingActive(ctx, f.codedMappingId, false);
  expect(await runJob(job.id)).toBe('failed');
  expect(await getClockingImportJob(ctx, job.id)).toMatchObject({ state: 'failed', errorCode: 'mappingInactive', result: null });
  expect(await owner.db.select().from(schema.clockingImportRun).where(eq(schema.clockingImportRun.tenantId, b.tenantId))).toHaveLength(0);
  // The inputs are gone once the job ended (the kernel keeps only the outcome).
  const [row] = await owner.client<{ source: boolean; steps: number }[]>`select source_content is not null as source,(select count(*)::int from bulk_job_step where job_id=${job.id}::uuid) as steps from bulk_job where id=${job.id}::uuid`;
  expect(row).toEqual({ source: false, steps: 0 });
  void sql;
}, 300_000);
