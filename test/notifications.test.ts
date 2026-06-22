/**
 * ADR-0034 34-2 — notification dispatch + recipient reads. The sweep projects mapped domain events into
 * recipient-scoped notifications; RLS confines reads/mark-read to the recipient (A cannot see B's). Keyset
 * cursor ⇒ idempotent. Gated by NOTIFICATIONS_ENABLED.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as schema from '../db/schema';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import {
  dispatchNotifications,
  listNotifications,
  markNotificationRead,
  unreadNotificationCount,
} from '../core/notifications';

let b: Base;
const uniqEmail = () => `notif_${randomUUID().slice(0, 8)}@t.local`;

async function makeEmployee() {
  const a = adminCtx(b);
  const e = await hireEmployee(a, {
    person: { fullName: 'Notif', primaryEmail: uniqEmail() },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  const userId = await createAppUser(b.tenantId, e.personId, 'employee');
  const ctx: SessionContext = { tenantId: b.tenantId, userId, roles: ['employee'], personId: e.personId };
  return { employmentId: e.employmentId, ctx };
}

const event = (eventType: string, subjectEmploymentId: string, payload: Record<string, unknown>) => ({
  tenantId: b.tenantId,
  aggregateType: 'test',
  aggregateId: randomUUID(),
  eventType,
  actorType: 'system' as const,
  subjectEmploymentId,
  payload,
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
  process.env.NOTIFICATIONS_ENABLED = 'true';
});
afterEach(() => {
  delete process.env.NOTIFICATIONS_ENABLED;
});

describe('notification dispatch + reads (ADR-0034 34-2)', () => {
  it('projects mapped events to the subject; recipient-only RLS isolates them', async () => {
    const A = await makeEmployee();
    const B = await makeEmployee();
    await owner.db.insert(schema.domainEvent).values([
      event('toil.accrued', A.employmentId, { daysCredited: 1, workedDate: '2026-07-04' }),
      event('leave-request.approved', B.employmentId, { decision: 'approved' }),
      event('employee.hired', A.employmentId, {}), // unmapped ⇒ no notification
    ]);

    const r = await dispatchNotifications(adminCtx(b), {});
    expect(r.created).toBe(2); // only the two mapped events

    // A sees only A's (a TOIL one); B sees only B's (a leave one).
    const aList = await listNotifications(A.ctx, A.employmentId);
    expect(aList).toHaveLength(1);
    expect(aList[0].kind).toBe('toil.accrued');
    expect(aList[0].body).toContain('1 day');
    expect((await listNotifications(B.ctx, B.employmentId))[0].kind).toBe('leave.approved');

    // RLS: A cannot read B's notifications even when asking for B's employment id.
    expect(await listNotifications(A.ctx, B.employmentId)).toHaveLength(0);
  });

  it('unread count + mark read', async () => {
    const A = await makeEmployee();
    await owner.db.insert(schema.domainEvent).values(event('toil.accrued', A.employmentId, { daysCredited: 2, workedDate: '2026-07-05' }));
    await dispatchNotifications(adminCtx(b), {});
    expect(await unreadNotificationCount(A.ctx, A.employmentId)).toBe(1);
    const [n] = await listNotifications(A.ctx, A.employmentId);
    await markNotificationRead(A.ctx, n.id);
    expect(await unreadNotificationCount(A.ctx, A.employmentId)).toBe(0);
  });

  it('is idempotent — re-dispatch with no new events creates nothing (cursor)', async () => {
    const A = await makeEmployee();
    await owner.db.insert(schema.domainEvent).values(event('toil.lapsed', A.employmentId, { daysCredited: 1 }));
    expect((await dispatchNotifications(adminCtx(b), {})).created).toBe(1);
    expect((await dispatchNotifications(adminCtx(b), {})).created).toBe(0);
    expect(await unreadNotificationCount(A.ctx, A.employmentId)).toBe(1); // not duplicated
  });

  it('is gated — dispatch is a no-op when NOTIFICATIONS_ENABLED is off', async () => {
    const A = await makeEmployee();
    await owner.db.insert(schema.domainEvent).values(event('toil.accrued', A.employmentId, { daysCredited: 1 }));
    delete process.env.NOTIFICATIONS_ENABLED;
    expect(await dispatchNotifications(adminCtx(b), {})).toEqual({ processed: 0, created: 0 });
    expect(await unreadNotificationCount(A.ctx, A.employmentId)).toBe(0);
  });
});
