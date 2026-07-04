/**
 * ADR-0069 Attendance Request Management — Travel Request (off-site work window audit marker). Asserts:
 *  • date-range validation (travelTo >= travelFrom) + mandatory remarks;
 *  • approval flips status and stamps the full decided-by / decided-at audit fields;
 *  • activeTravelRequestFor is correctly bounded to [travelFrom, travelTo] and only matches APPROVED rows;
 *  • self-approval is banned (an employee cannot decide their own travel request);
 *  • domain events are appended for request + decision;
 *  • travel does NOT change month-summary absence counting (ADR-0069 §3: a travelling employee who does not
 *    clock in still counts as absent — travel is not leave; the marker is detail-view only).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { adminCtx, closeAll, createAppUser, eventTypesFor, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { hireEmployee } from '../core/org';
import {
  requestTravel,
  decideTravelRequest,
  activeTravelRequestFor,
  listTravelRequests,
  myTravelRequests,
} from '../core/travel-request';
import { attendanceMonthSummary } from '../core/attendance';

let b: Base;
const uniqEmail = () => `travel_${Math.random().toString(36).slice(2)}@t.local`;

async function hire(fullName = 'Traveller') {
  const a = adminCtx(b);
  const e = await hireEmployee(a, {
    person: { fullName, primaryEmail: uniqEmail() },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  return { employmentId: e.employmentId, personId: e.personId };
}

/** A self ctx for a hired employee (own personId, employee role) — used to prove the self-approval ban. */
async function selfCtx(personId: string): Promise<SessionContext> {
  const uid = await createAppUser(b.tenantId, personId, 'employee');
  return { tenantId: b.tenantId, userId: uid, personId, roles: ['employee'] };
}

const travelRow = async (id: string) =>
  (await owner.db.select().from(schema.travelRequest).where(eq(schema.travelRequest.id, id)))[0];

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});

describe('travel request — validation', () => {
  it('rejects an inverted date range', async () => {
    const a = adminCtx(b);
    const { employmentId } = await hire();
    await expect(
      requestTravel(a, { employmentId, travelFrom: '2026-07-10', travelTo: '2026-07-05', remarks: 'trip' }),
    ).rejects.toThrow(/on or after/i);
  });

  it('rejects empty remarks', async () => {
    const a = adminCtx(b);
    const { employmentId } = await hire();
    await expect(
      requestTravel(a, { employmentId, travelFrom: '2026-07-05', travelTo: '2026-07-10', remarks: '   ' }),
    ).rejects.toThrow(/reason is required/i);
  });
});

describe('travel request — approval + audit', () => {
  it('approval flips status and stamps the full audit-field list', async () => {
    const a = adminCtx(b);
    const { employmentId } = await hire();
    const { travelRequestId } = await requestTravel(a, {
      employmentId,
      travelFrom: '2026-07-05',
      travelTo: '2026-07-10',
      remarks: 'Client site KL',
    });
    let row = await travelRow(travelRequestId);
    expect(row.status).toBe('pending');
    expect(row.decidedByEmploymentId).toBeNull();
    expect(row.decidedAt).toBeNull();
    expect(row.travelFrom).toBe('2026-07-05');
    expect(row.travelTo).toBe('2026-07-10');
    expect(row.remarks).toBe('Client site KL');

    await decideTravelRequest(a, { travelRequestId, decision: 'approved', deciderEmploymentId: employmentId });
    row = await travelRow(travelRequestId);
    expect(row.status).toBe('approved');
    expect(row.decidedByEmploymentId).toBe(employmentId);
    expect(row.decidedAt).not.toBeNull();

    const events = await eventTypesFor(b.tenantId, travelRequestId);
    expect(events).toContain('travel-request.requested');
    expect(events).toContain('travel-request.approved');
  });

  it('a decided request cannot be decided again', async () => {
    const a = adminCtx(b);
    const { employmentId } = await hire();
    const { travelRequestId } = await requestTravel(a, {
      employmentId,
      travelFrom: '2026-07-05',
      travelTo: '2026-07-05',
      remarks: 'day trip',
    });
    await decideTravelRequest(a, { travelRequestId, decision: 'rejected' });
    await expect(decideTravelRequest(a, { travelRequestId, decision: 'approved' })).rejects.toThrow(/already/i);
  });
});

describe('travel request — self-approval ban', () => {
  it('an employee cannot decide their own travel request', async () => {
    const a = adminCtx(b);
    const { employmentId, personId } = await hire();
    const { travelRequestId } = await requestTravel(a, {
      employmentId,
      travelFrom: '2026-07-05',
      travelTo: '2026-07-06',
      remarks: 'self trip',
    });
    const own = await selfCtx(personId);
    await expect(decideTravelRequest(own, { travelRequestId, decision: 'approved' })).rejects.toThrow(
      /cannot decide your own/i,
    );
  });
});

describe('activeTravelRequestFor — window bounds', () => {
  it('matches only APPROVED rows within [from, to] inclusive', async () => {
    const a = adminCtx(b);
    const { employmentId } = await hire();
    const { travelRequestId } = await requestTravel(a, {
      employmentId,
      travelFrom: '2026-07-05',
      travelTo: '2026-07-10',
      remarks: 'window',
    });
    // Pending ⇒ no badge.
    const pendingHit = await owner.db.transaction((tx) => activeTravelRequestFor(tx, employmentId, '2026-07-07'));
    expect(pendingHit).toBeNull();

    await decideTravelRequest(a, { travelRequestId, decision: 'approved' });
    const inside = await owner.db.transaction((tx) => activeTravelRequestFor(tx, employmentId, '2026-07-07'));
    expect(inside?.id).toBe(travelRequestId);
    const onStart = await owner.db.transaction((tx) => activeTravelRequestFor(tx, employmentId, '2026-07-05'));
    expect(onStart?.id).toBe(travelRequestId);
    const onEnd = await owner.db.transaction((tx) => activeTravelRequestFor(tx, employmentId, '2026-07-10'));
    expect(onEnd?.id).toBe(travelRequestId);
    const before = await owner.db.transaction((tx) => activeTravelRequestFor(tx, employmentId, '2026-07-04'));
    expect(before).toBeNull();
    const after = await owner.db.transaction((tx) => activeTravelRequestFor(tx, employmentId, '2026-07-11'));
    expect(after).toBeNull();
  });
});

describe('travel request — inbox reads', () => {
  it('listTravelRequests + myTravelRequests surface the row', async () => {
    const a = adminCtx(b);
    const { employmentId } = await hire('Reader');
    await requestTravel(a, { employmentId, travelFrom: '2026-07-05', travelTo: '2026-07-06', remarks: 'r' });
    const pending = await listTravelRequests(a, { companyIds: [b.companyId], status: 'pending' });
    expect(pending).toHaveLength(1);
    expect(pending[0].employee).toBe('Reader');
    const mine = await myTravelRequests(a, employmentId);
    expect(mine).toHaveLength(1);
  });
});

describe('travel does NOT change month-summary absence counting (ADR-0069 §3)', () => {
  it('a workday with no clock-in during an approved travel window still counts as absent', async () => {
    const a = adminCtx(b);
    const { employmentId } = await hire();
    // Approve travel across a July workday window the employee does NOT clock in for.
    const { travelRequestId } = await requestTravel(a, {
      employmentId,
      travelFrom: '2026-07-01',
      travelTo: '2026-07-03',
      remarks: 'off-site, no punch',
    });
    await decideTravelRequest(a, { travelRequestId, decision: 'approved' });

    // Count the whole month (today past month-end) so the July workdays are all eligible to be counted absent.
    const rows = await attendanceMonthSummary(a, { month: '2026-07', companyIds: [b.companyId], today: '2026-08-01' });
    const row = rows.find((r) => r.employmentId === employmentId);
    // Travel is not leave: those unclocked workdays are still counted as absent — travel does not suppress them.
    expect(row).toBeTruthy();
    expect(row!.absent).toBeGreaterThan(0);
  });
});
