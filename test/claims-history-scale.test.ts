import {sql} from 'drizzle-orm';
import {withTenant} from '../db/client';
import {writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {claimRequest} from '../db/schema';
import {hireEmployee} from '../core/org';
import {createClaimType, listClaimHistoryPage, listClaimDraftsForEmployment, listClaimsForEmployment} from '../packs/claims/service';
import {adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base} from './harness';
let base: Base;
beforeAll(() => migrateTestDb());
beforeEach(async () => {await resetDb(); base = await seedBase();});
afterAll(() => closeAll());
async function fixture() {
  const ctx = adminCtx(base);
  const subject = await hireEmployee(ctx, {person: {fullName: 'Pagination fixture', primaryEmail: 'paging@example.test'},
    companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: '2026-01-01'});
  const type = await createClaimType(ctx, {code: 'PAGE', name: 'Page fixture', defaultTaxable: false, requiresReceipt: false});
  const ids = Array.from({length: 61}, () => randomUUID()).sort().reverse();
  await owner.db.insert(claimRequest).values(ids.map((id, i) => ({id, tenantId: base.tenantId,
    employmentId: subject.employmentId, claimTypeId: type.id, amount: '1.00', incurredOn: '2026-01-02',
    status: i === 60 ? 'draft' as const : 'pending' as const, createdAt: new Date('2026-01-03T00:00:00Z')})));
  return {ctx, subject, ids};
}
describe('claims history scale budget', () => {
  it('measures real paged reads as claim history grows to one million rows', async () => {
    const {ctx, subject} = await fixture();
    const [type] = await owner.client`select claim_type_id from claim_request where employment_id=${subject.employmentId} limit 1`;
    let prior = 61;
    const measurements: unknown[] = [];
    for (const target of [10_000, 100_000, 1_000_000]) {
      await owner.client`insert into claim_request(tenant_id,employment_id,claim_type_id,amount,incurred_on,status,created_at)
        select ${base.tenantId}::uuid,${subject.employmentId}::uuid,${type.claim_type_id}::uuid,1,'2026-01-02'::date,'pending',
          '2026-01-03T00:00:00Z'::timestamptz + n * interval '1 second'
        from generate_series(${prior + 1}::integer,${target}::integer) n`;
      await owner.client`analyze claim_request`;
      const durations: number[] = [];
      let bytes = 0;
      for (let sample = 0; sample < 5; sample++) {
        const started = performance.now();
        const result = await listClaimHistoryPage(ctx, subject.employmentId);
        durations.push(performance.now() - started);
        expect(result.rows).toHaveLength(25); expect(result.state.total).toBe(target - 1);
        bytes = Buffer.byteLength(JSON.stringify(result));
      }
      durations.sort((a,b) => a-b);
      const measurement = {records: target, samples: durations.length,
        medianMs: Number(durations[2].toFixed(1)), maxMs: Number(durations[4].toFixed(1)), returnedRows: 25, responseBytes: bytes};
      if (target === 10_000) {
        const started = performance.now();
        const legacy = await listClaimsForEmployment(ctx, subject.employmentId);
        Object.assign(measurement, {legacyMs: Number((performance.now() - started).toFixed(1)),
          legacyRows: legacy.length, legacyBytes: Buffer.byteLength(JSON.stringify(legacy))});
      }
      if (target === 1_000_000) {
        const plans = await withTenant(ctx, async tx => {
          const countPlan = await tx.execute(sql`explain (analyze, buffers, format json)
            select count(*)::int from claim_request q
            inner join claim_type t on t.id=q.claim_type_id inner join employment e on e.id=q.employment_id
            inner join person p on p.id=e.person_id where q.employment_id=${subject.employmentId}::uuid and q.status<>'draft'`);
          const rowsPlan = await tx.execute(sql`explain (analyze, buffers, format json)
            select q.id from claim_request q
            inner join claim_type t on t.id=q.claim_type_id inner join employment e on e.id=q.employment_id
            inner join person p on p.id=e.person_id where q.employment_id=${subject.employmentId}::uuid and q.status<>'draft'
            order by q.created_at desc,q.id desc limit 25`);
          const time = (rows: unknown) => (rows as {'QUERY PLAN': {'Execution Time': number}[]}[])[0]['QUERY PLAN'][0]['Execution Time'];
          return {countPlanMs: time(countPlan), rowsPlanMs: time(rowsPlan), countPlan, rowsPlan};
        });
        Object.assign(measurement, plans);
      }
      measurements.push(measurement);
      const report = process.env.AIHR_SCALE_REPORT ?? (process.env.AIHR_FOCUSED_EVIDENCE_DIR ? process.env.AIHR_FOCUSED_EVIDENCE_DIR + '/claims-scale.json' : undefined);
      if (report) writeFileSync(report, JSON.stringify(measurements, null, 2));
      console.info('[claims-scale]', JSON.stringify(measurement));
      if (target === 1_000_000) expect(measurement.medianMs).toBeLessThan(1000);
      prior = target;
    }
  }, 240_000);
});
