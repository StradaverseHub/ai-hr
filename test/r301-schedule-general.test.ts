/**
 * 6d091cc0 (r301) — Attendance › Schedule › General becomes the one schedule setup page.
 *
 * WORK IN PROGRESS: the Last-updated RLS probe first (the brief's precondition for rendering that column).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { setAttendancePolicy } from '../core/attendance';
import { policyLastUpdated } from '../app/admin/attendance-policy/policy-last-updated';

let b: Base;
let companyB: string;

const POLICY = (companyId: string) => ({
  companyId,
  workStart: '08:00',
  workEnd: '17:00',
  breakMinutes: 60,
  lateAfter: '08:15',
  halfDayBefore: '12:00',
  workingDays: [1, 2, 3, 4, 5],
});

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  const [c] = await owner.db
    .insert(schema.company)
    .values({ tenantId: b.tenantId, legalName: 'Beta Sdn Bhd' })
    .returning({ id: schema.company.id });
  companyB = c.id;
});

describe('Last updated — an HR admin session can read attendance-policy.updated under RLS', () => {
  it('group-wide hr_admin, company-scoped hr_admin: both read the latest save per company; an employee reads nothing', async () => {
    const admin = adminCtx(b);
    await setAttendancePolicy(admin, POLICY(b.companyId));
    // A later save for company A, so "latest" is a real choice between two events.
    await setAttendancePolicy(admin, { ...POLICY(b.companyId), workStart: '07:30', lateAfter: '07:45' });

    const groupWide = await policyLastUpdated(admin, [b.companyId, companyB]);
    expect(groupWide.has(b.companyId), 'the group-wide HR admin sees company A’s save').toBe(true);
    expect(groupWide.has(companyB), 'company B was never saved — no entry, never an invented date').toBe(false);

    // The newest of the two events, straight off the ledger as the owner.
    const events = await owner.db
      .select({ at: schema.domainEvent.occurredAt, seq: schema.domainEvent.sequence })
      .from(schema.domainEvent)
      .where(
        (await import('drizzle-orm')).and(
          (await import('drizzle-orm')).eq(schema.domainEvent.tenantId, b.tenantId),
          (await import('drizzle-orm')).eq(schema.domainEvent.eventType, 'attendance-policy.updated'),
        ),
      )
      .orderBy((await import('drizzle-orm')).desc(schema.domainEvent.sequence));
    expect(events).toHaveLength(2);
    expect(groupWide.get(b.companyId)!.getTime()).toBe(events[0].at.getTime());

    const scoped: SessionContext = { ...admin, grants: [{ role: 'hr_admin', companyId: b.companyId }] };
    const scopedRead = await policyLastUpdated(scoped, [b.companyId]);
    expect(scopedRead.get(b.companyId)?.getTime(), 'a company-scoped HR admin reads it too').toBe(events[0].at.getTime());

    const employee: SessionContext = { tenantId: b.tenantId, userId: b.adminUserId, roles: ['employee'], entitlements: admin.entitlements };
    const employeeRead = await policyLastUpdated(employee, [b.companyId]);
    expect(employeeRead.size, 'RLS is really in play: a non-admin reads no policy events').toBe(0);
  });
});
