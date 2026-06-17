/**
 * Wave 4A — termination classification capture. terminateEmployment records a termination type +
 * reason on the employment row AND in the employment.terminated event payload, powering the
 * Terminations + Turnover analytics (Wave 4B). Backfill-safe: omitting them leaves nulls.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee, terminateEmployment } from '../core/org';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const hire = (ctx: SessionContext, b: Base, name: string) =>
  hireEmployee(ctx, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase()}@acme.test` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });

const employmentRow = async (id: string) => {
  const [row] = await owner.db.select().from(schema.employment).where(eq(schema.employment.id, id));
  return row;
};
const terminatedEventPayload = async (tenantId: string, employmentId: string) => {
  const [row] = await owner.db
    .select({ payload: schema.domainEvent.payload })
    .from(schema.domainEvent)
    .where(
      and(
        eq(schema.domainEvent.tenantId, tenantId),
        eq(schema.domainEvent.aggregateId, employmentId),
        eq(schema.domainEvent.eventType, 'employment.terminated'),
      ),
    );
  return row?.payload as Record<string, unknown> | undefined;
};

describe('Wave 4A — termination classification capture', () => {
  let base: Base;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
  });
  afterAll(async () => {
    await closeAll();
  });

  it('records the termination type + reason on the row and in the event payload', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'Leaver');
    await terminateEmployment(a, {
      employmentId: e.employmentId,
      terminationDate: '2026-06-30',
      terminationType: 'voluntary',
      terminationReason: '  better offer  ',
    });

    const row = await employmentRow(e.employmentId);
    expect(row.terminatedOn).toBe('2026-06-30');
    expect(row.terminationType).toBe('voluntary');
    expect(row.terminationReason).toBe('better offer'); // trimmed

    const payload = await terminatedEventPayload(base.tenantId, e.employmentId);
    expect(payload).toMatchObject({ terminationType: 'voluntary', terminationReason: 'better offer' });
  });

  it('is backfill-safe: omitting the classification leaves nulls', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'NoClass');
    await terminateEmployment(a, { employmentId: e.employmentId, terminationDate: '2026-06-30' });

    const row = await employmentRow(e.employmentId);
    expect(row.terminatedOn).toBe('2026-06-30');
    expect(row.terminationType).toBeNull();
    expect(row.terminationReason).toBeNull();
  });
});
