import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { withTenant } from '../../db/client';
import { hireEmployee } from '../../core/org';
import { checkIn, checkOut } from '../../core/attendance';
import { punchesForCorrectionTx, clockFingerprint } from '../../core/attendance-punch-change';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase } from '../harness';

const file='test/performance/attendance-punch-index.profile.test.ts';
const selection:unknown=JSON.parse(process.env.AIHR_FOCUSED_TESTS??'[]');
const requested=process.env.GITHUB_ACTIONS==='true'&&Array.isArray(selection)&&selection.length===1&&selection[0]===file;
beforeAll(migrateTestDb);
afterAll(closeAll);

it.skipIf(!requested)('benchmarks the canonical correction snapshot on a million-row retained punch table', async () => {
  const evidenceDir=process.env.AIHR_FOCUSED_EVIDENCE_DIR;
  if(!evidenceDir)throw Error('Focused evidence directory is required');
  await resetDb();
  const base = await seedBase();
  const ctx = adminCtx(base);
  const worker = await hireEmployee(ctx, {
    person: { fullName: 'Indexed employee', primaryEmail: 'punch-index@example.test' },
    companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: '2020-01-01',
  });
  const day = '2026-07-15';
  await checkIn(ctx, { employmentId: worker.employmentId, date: day, time: '08:00', manual: true });
  await checkOut(ctx, { employmentId: worker.employmentId, date: day, time: '17:00', manual: true });
  await owner.db.transaction(async tx => {
    // Bulk-load valid synthetic IDs and references with row-level business triggers bypassed only
    // during fixture construction. The queried employee's punches were inserted by the normal path.
    await tx.execute(sql`set local session_replication_role = replica`);
    await tx.execute(sql`with people as (
      insert into person (tenant_id, full_name, primary_email)
      select ${base.tenantId}, 'Retained ' || n, 'retained-' || n || '@example.test' from generate_series(1, 1000) n returning id
    ) insert into employment (tenant_id, company_id, person_id, hired_on)
      select ${base.tenantId}, ${base.companyId}, id, '2020-01-01' from people`);
    await tx.execute(sql`insert into attendance (tenant_id, employment_id, attendance_date)
      select p.tenant_id, e.id, date '2022-01-01' + d from employment e join person p on p.id=e.person_id
      cross join generate_series(0,499) d where p.tenant_id=${base.tenantId} and p.primary_email like 'retained-%@example.test'`);
    await tx.execute(sql`insert into attendance_punch (tenant_id, employment_id, attendance_id, attendance_date, punch_at, direction)
      select a.tenant_id, a.employment_id, a.id, a.attendance_date, v.t::time, v.d::attendance_punch_direction
      from attendance a cross join (values ('08:00','in'),('17:00','out')) v(t,d) where a.tenant_id=${base.tenantId} and a.attendance_date<'2024-01-01'`);
    // Include a historical voided punch on the target day to prove it remains in the fingerprint.
    await tx.execute(sql`insert into attendance_punch (tenant_id, employment_id, attendance_id, attendance_date, punch_at, direction, voided_at, voided_by, void_reason)
      select tenant_id, employment_id, id, attendance_date, '08:30', 'in', '2026-07-15T09:22:11.123Z', 'benchmark', 'Historical correction'
      from attendance where employment_id=${worker.employmentId} and attendance_date=${day}`);
  });
  await owner.db.execute(sql`analyze attendance_punch`);
  const count = await owner.db.execute(sql`select count(*)::int as count from attendance_punch`);
  expect(count[0].count).toBe(1000003);
  const read = () => withTenant(ctx, async tx => {
    const [identity]=await tx.execute<{role:string}>(sql`select current_user as role`);
    expect(identity.role).toBe('ai_hr_app');
    const rows = await punchesForCorrectionTx(tx, worker.employmentId, day);
    const plans = [];
    for (let i=0; i<5; i++) plans.push((await tx.execute(sql`explain (analyze, buffers, format json) ${punchesForCorrectionTx(tx, worker.employmentId, day)}`))[0]['QUERY PLAN']);
    return { rows, plans, fingerprint: clockFingerprint(rows) };
  });
  const write = () => withTenant(ctx, async tx => {
    const plans = [];
    for (let i=0; i<5; i++) {
      await tx.execute(sql`savepoint punch_benchmark_write`);
      plans.push((await tx.execute(sql`explain (analyze, buffers, wal, format json)
        insert into attendance_punch(tenant_id, employment_id, attendance_id, attendance_date, punch_at, direction, method)
        select tenant_id, employment_id, id, attendance_date, '12:31', 'in', 'admin'
        from attendance where employment_id=${worker.employmentId} and attendance_date=${day}`))[0]['QUERY PLAN']);
      await tx.execute(sql`rollback to savepoint punch_benchmark_write`);
      await tx.execute(sql`release savepoint punch_benchmark_write`);
    }
    return plans;
  });
  const baseline = { read: await read(), write: await write() };
  const start = performance.now();
  await owner.db.execute(sql`CREATE INDEX CONCURRENTLY attendance_punch_subject_day_order_idx ON public.attendance_punch (employment_id, attendance_date, punch_at, id)`);
  const buildMs = performance.now() - start;
  try {
    const indexed = { read: await read(), write: await write() };
    expect(indexed.read.rows).toEqual(baseline.read.rows);
    expect(indexed.read.rows.map(row => !!row.voidedAt)).toEqual([false, true, false]);
    expect(indexed.read.fingerprint).toBe(baseline.read.fingerprint);
    const size = await owner.db.execute(sql`select pg_relation_size('attendance_punch_subject_day_order_idx')::int as bytes`);
    const after=await owner.db.execute(sql`select count(*)::int as count from attendance_punch`);
    expect(after).toEqual(count);
    writeFileSync(join(evidenceDir,'attendance-punch-index-results.json'),JSON.stringify({
      kind:'ATTENDANCE_PUNCH_INDEX_COMPONENT_ONLY',releaseEligible:false,
      limitations:'Fictional retained punches, single reader, rolled-back table inserts. No workflow or concurrent load timings.',
      count,baseline,indexed,buildMs,size,
    },null,2));
  } finally {
    await owner.db.execute(sql`DROP INDEX CONCURRENTLY public.attendance_punch_subject_day_order_idx`);
  }
}, 180_000);
