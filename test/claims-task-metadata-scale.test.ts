import { afterAll, beforeAll, expect, it } from 'vitest';
import { pendingClaimTaskMetadata } from '../packs/claims/service';
import { observeNativeRead } from './helpers/native-read-observer';
import { closeAll, migrateTestDb, owner } from './harness';
import { seedClaimQueueScaleFixture } from './performance/claims-approval-queue-scale-fixture';

beforeAll(migrateTestDb);
afterAll(closeAll);

it('measures the full ordered Claims task headers under current authority', async () => {
  const shape = { employees: 250, claimsPerEmployee: 200, managerReports: 40 };
  const fixture = await seedClaimQueueScaleFixture(shape, {}, () => {});
  const subjects = await owner.client<{ id: string }[]>`
    select subordinate_employment_id as id from reporting_line
    where tenant_id=${fixture.b.tenantId}::uuid and line_type='administrative'`;
  const reports = new Set(subjects.map(row => row.id));
  const actors = [
    { name: 'groupHR', context: fixture.groupHr, expected: fixture.counts.claims - fixture.ownClaims },
    { name: 'manager', context: fixture.lineManager, expected: fixture.counts.managerClaims - fixture.ownClaims },
  ] as const;
  for (const { name, context, expected } of actors) {
    const read = observeNativeRead({
      captureQueries: false,
      classify: statement => /from\s+(?:"public"\.)?"employment"/i.test(statement) ? 'employment' : 'other',
    });
    const started = performance.now();
    let rows: Awaited<ReturnType<typeof pendingClaimTaskMetadata>>;
    try {
      rows = await pendingClaimTaskMetadata(context, [fixture.b.companyId]);
    } finally {
      read.restore();
    }
    const elapsedMs = Math.round(performance.now() - started);
    const telemetry = read.telemetry();
    const subjectChecks = telemetry.summaries.filter(row => row.classification === 'employment')
      .reduce((count, row) => count + row.count, 0);
    expect(rows).toHaveLength(expected);
    expect(new Set(rows.map(row => row.id)).size).toBe(expected);
    expect(rows.every(row => row.personId !== context.personId)).toBe(true);
    if (name === 'manager') expect(new Set(rows.map(row => row.employmentId))).toEqual(reports);
    expect(rows.every((row, index) => {
      const previous = rows[index - 1];
      return !previous || previous.createdAt > row.createdAt
        || (previous.createdAt.getTime() === row.createdAt.getTime() && previous.id < row.id);
    })).toBe(true);
    expect(telemetry.totals.failed).toBe(0);
    console.info('CLAIMS_TASK_METADATA_SCALE', JSON.stringify({
      role: name, rows: rows.length, elapsedMs, statements: telemetry.totals.statements, subjectChecks,
    }));
  }
}, 240000);
