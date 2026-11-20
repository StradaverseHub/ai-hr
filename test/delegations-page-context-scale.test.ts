import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { readDelegationPageContext } from '../app/delegations/read-page-context';
import { withIndependentTransactions } from '../db/client';
import { employment, reportingLine } from '../db/schema';
import type { SharedReadStats } from '../db/shared-read';
import { closeAll, createAppUser, entitledCtx, migrateTestDb, owner, resetDb, seedBase } from './harness';
import { buildScaleFixture, type ScaleFixture } from './helpers/ai-centre-scale-fixture';

let fixture: ScaleFixture;
let employee: Awaited<ReturnType<typeof entitledCtx>>;
let delegationId: string;
beforeAll(async () => {
  await migrateTestDb();
  await resetDb();
  const base = await seedBase();
  fixture = await buildScaleFixture(base, { events: 0 });
  const [delegator, delegate] = await owner.db.select({ id: employment.id, personId: employment.personId })
    .from(employment)
    .where(and(eq(employment.companyId, fixture.singleCompanyId), isNull(employment.terminatedOn)))
    .limit(2);
  const [row] = await owner.db.insert(reportingLine).values({
    tenantId: base.tenantId,
    subordinateEmploymentId: delegator.id,
    managerEmploymentId: delegate.id,
    lineType: 'delegate',
    validFrom: '2025-01-01',
  }).returning({ id: reportingLine.id });
  delegationId = row.id;
  employee = {
    ...await entitledCtx(base, ['employee']),
    userId: await createAppUser(base.tenantId, delegator.personId, 'employee'),
    personId: delegator.personId,
    roles: ['employee'],
    grants: [{ role: 'employee', companyId: null }],
  };
}, 90000);
afterAll(closeAll);

it('preserves scoped delegation rows, history and form choices on one connection at group scale', async () => {
  expect(fixture.companyIds.length).toBeGreaterThanOrEqual(70);
  expect(fixture.employmentIds.length).toBeGreaterThanOrEqual(1000);
  const hooks = globalThis as { __aihrPerfSharedRead?: (stats: SharedReadStats) => void };
  const priorHook = hooks.__aihrPerfSharedRead;
  try {
    for (const session of [fixture.personas.group, fixture.personas.single, employee]) {
      const proof: SharedReadStats[] = [];
      hooks.__aihrPerfSharedRead = (stats) => { proof.push(stats); };
      const shared = await readDelegationPageContext(session, true);
      const independent = await withIndependentTransactions(() => readDelegationPageContext(session, true));
      expect(shared).toEqual(independent);
      expect(shared.initialContext.rows.map(row => row.id)).toContain(delegationId);
      expect(shared.history).toBe(session !== employee);
      expect(proof).toHaveLength(1);
      expect(proof[0]).toMatchObject({ carriers: 1, fallbacks: 0 });
    }
  } finally {
    hooks.__aihrPerfSharedRead = priorHook;
  }
});
