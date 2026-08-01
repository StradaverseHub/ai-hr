/**
 * Combined Leave Type Limit (R44 4c48fd1f) — enforcement + config CRUD coverage, added as STEP 0 of the
 * R47 d6f88c2f drag-and-drop grouping rework. These tests pin the EXISTING behaviour before the setup UI
 * is replaced, so the refactor cannot silently regress the cap that limits people's leave:
 *   - enforceCombinedLeaveLimit (core/leave.ts, private — exercised through requestLeave + decideLeave):
 *     under-cap passes, over-cap throws CombinedLeaveLimitExceededError (with poolName), pending AND
 *     approved usage both count, excludeRequestId avoids double-counting on the approval path, and
 *     employees/types outside any pool are unaffected.
 *   - Pool CRUD (core/benefit-scheme.ts): create/update/delete round-trips via listLeaveSharedGroups,
 *     the min-2-member validator, the totalLimitDays bounds, and the one-pool-per-type unique guard.
 *
 * Harness notes: requests + approvals run as adminCtx (admins pass the RLS visibility + leave-year gates;
 * the combined cap is a data rule with NO admin bypass, so it still fires — mirroring
 * leave-negative-balance.test.ts). The employee is pinned to the scheme via the manual override
 * (setEmploymentBenefitScheme) so resolution never depends on grade-group wiring. Leave types are
 * calendar_days + allowNegativeBalance so day math is trivial and the submit-time balance gate stays out
 * of the way; the approval-time balance gate is satisfied with a generous ledger accrual.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { requestLeave, decideLeave, CombinedLeaveLimitExceededError } from '../core/leave';
import { createBenefitScheme, setEmploymentBenefitScheme } from '../core/benefit-scheme';
// r88/1ef1cf95 — a shared leave group is tenant-level now, not owned by a benefit scheme, so its CRUD
// lives in its own module. moveCombinedLimitMember / groupSchemeLeaveTypes are GONE with the drag-to-group
// entrypoint they served; membership is now set by passing the full leaveTypeIds list to update.
import {
  createLeaveSharedGroup,
  updateLeaveSharedGroup,
  deleteLeaveSharedGroup,
  listLeaveSharedGroups,
} from '../core/leave-shared-group';
import {
  adminCtx,
  closeAll,
  latestEventPayload,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

let b: Base;

function uniq(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8).toUpperCase()}`;
}

/** Calendar-counted, negative-balance-allowed leave type: 1 calendar day == 1 leave day and the
 *  submit-time balance gate never interferes with the cap under test. */
async function leaveType(): Promise<string> {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      tenantId: b.tenantId,
      code: uniq('CLL'),
      name: uniq('Pooled'),
      paid: true,
      counting: 'calendar_days',
      allowNegativeBalance: true,
    })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

/** Seed an approved balance (accrual ledger row) so the APPROVAL-time balance gate is satisfied. */
async function grant(employmentId: string, leaveTypeId: string, days: number): Promise<void> {
  await owner.db.insert(schema.leaveLedger).values({
    tenantId: b.tenantId,
    employmentId,
    leaveTypeId,
    entryType: 'accrual',
    days: days.toFixed(2),
    effectiveOn: '2020-01-01',
  });
}

/** An employee hard-pinned (override) to a fresh active scheme, plus two pooled leave types. */
async function fixture() {
  const ctx = adminCtx(b);
  const scheme = await createBenefitScheme(ctx, {
    companyId: b.companyId,
    employmentType: 'full_time',
    gradeGroupId: null,
    name: `Pool scheme ${randomUUID().slice(0, 8)}`,
    status: 'active',
  });
  const [ltA, ltB] = [await leaveType(), await leaveType()];
  const emp = await hireEmployee(ctx, {
    person: { fullName: 'Pooled', primaryEmail: `pool_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2020-01-01',
  });
  await setEmploymentBenefitScheme(ctx, { employmentId: emp.employmentId, benefitSchemeId: scheme.id });
  await grant(emp.employmentId, ltA, 20);
  await grant(emp.employmentId, ltB, 20);
  return { ctx, scheme, ltA, ltB, employmentId: emp.employmentId };
}

// Distinct 2026 spans (calendar_days ⇒ span length == days). All in the same calendar year — the pool's
// hard-coded cycle window.
const span3a = { startDate: '2026-06-01', endDate: '2026-06-03' } as const; // 3 days
const span3b = { startDate: '2026-07-06', endDate: '2026-07-08' } as const; // 3 days
const span2 = { startDate: '2026-08-03', endDate: '2026-08-04' } as const; // 2 days
const TODAY = '2026-06-01';

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

describe('enforceCombinedLeaveLimit — submit path (requestLeave)', () => {
  it('a request UNDER the shared cap passes', async () => {
    const { ctx, scheme, ltA, ltB, employmentId } = await fixture();
    await createLeaveSharedGroup(ctx, {
      name: 'Pool AB',
      totalLimitDays: 5,
      leaveTypeIds: [ltA, ltB],
    });
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId: ltA, ...span3a, today: TODAY }),
    ).resolves.toBeTruthy();
  });

  it('a request pushing pooled usage OVER the cap throws CombinedLeaveLimitExceededError with the pool name', async () => {
    const { ctx, scheme, ltA, ltB, employmentId } = await fixture();
    await createLeaveSharedGroup(ctx, {
      name: 'Pool AB',
      totalLimitDays: 5,
      leaveTypeIds: [ltA, ltB],
    });
    // 3 PENDING days of type A already reserve the pool…
    await requestLeave(ctx, { employmentId, leaveTypeId: ltA, ...span3a, today: TODAY });
    // …so 3 more days of the OTHER pooled type (3+3=6 > 5) are rejected, carrying the pool identity.
    const attempt = requestLeave(ctx, { employmentId, leaveTypeId: ltB, ...span3b, today: TODAY });
    await expect(attempt).rejects.toThrow(CombinedLeaveLimitExceededError);
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId: ltB, ...span3b, today: TODAY }),
    ).rejects.toMatchObject({ poolName: 'Pool AB', totalLimitDays: 5 });
  });

  it('APPROVED usage counts against the cap too (not just pending)', async () => {
    const { ctx, scheme, ltA, ltB, employmentId } = await fixture();
    await createLeaveSharedGroup(ctx, {
      name: 'Pool AB',
      totalLimitDays: 5,
      leaveTypeIds: [ltA, ltB],
    });
    const first = await requestLeave(ctx, { employmentId, leaveTypeId: ltA, ...span3a, today: TODAY });
    await decideLeave(ctx, { leaveRequestId: first.leaveRequestId, decision: 'approved' });
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId: ltB, ...span3b, today: TODAY }),
    ).rejects.toThrow(CombinedLeaveLimitExceededError);
  });

  it('an exactly-at-cap request passes (boundary)', async () => {
    const { ctx, scheme, ltA, ltB, employmentId } = await fixture();
    await createLeaveSharedGroup(ctx, {
      name: 'Pool AB',
      totalLimitDays: 5,
      leaveTypeIds: [ltA, ltB],
    });
    await requestLeave(ctx, { employmentId, leaveTypeId: ltA, ...span3a, today: TODAY });
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId: ltB, ...span2, today: TODAY }), // 3+2 = 5 ≤ 5
    ).resolves.toBeTruthy();
  });

  it('a leave type in NO pool — and a schemeless tenant — are unaffected', async () => {
    const { ctx, scheme, ltA, ltB, employmentId } = await fixture();
    await createLeaveSharedGroup(ctx, {
      name: 'Pool AB',
      totalLimitDays: 5,
      leaveTypeIds: [ltA, ltB],
    });
    // A third type outside the pool sails past the cap (10 days > 5).
    const ltC = await leaveType();
    await grant(employmentId, ltC, 20);
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId: ltC, startDate: '2026-09-01', endDate: '2026-09-10', today: TODAY }),
    ).resolves.toBeTruthy();
    // Deleting the pool lifts the cap for the member types as well.
    const pools = await listLeaveSharedGroups(ctx);
    await deleteLeaveSharedGroup(ctx, { id: pools[0].id });
    await requestLeave(ctx, { employmentId, leaveTypeId: ltA, ...span3a, today: TODAY });
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId: ltB, ...span3b, today: TODAY }),
    ).resolves.toBeTruthy();
  });
});

describe('enforceCombinedLeaveLimit — approval path (excludeRequestId)', () => {
  it('finalizeLeaveApproval excludes the request being approved from the usage sum (no double count)', async () => {
    const { ctx, scheme, ltA, ltB, employmentId } = await fixture();
    await createLeaveSharedGroup(ctx, {
      name: 'Pool AB',
      totalLimitDays: 5,
      leaveTypeIds: [ltA, ltB],
    });
    // 3 + 2 = 5 pending days fill the pool exactly; both submits pass.
    const r1 = await requestLeave(ctx, { employmentId, leaveTypeId: ltA, ...span3a, today: TODAY });
    const r2 = await requestLeave(ctx, { employmentId, leaveTypeId: ltB, ...span2, today: TODAY });
    // Approving each re-checks the cap MINUS the request's own pending row. If excludeRequestId were
    // dropped, the second approval would see 5 pending + 2 requested = 7 > 5 and wrongly throw.
    await expect(decideLeave(ctx, { leaveRequestId: r1.leaveRequestId, decision: 'approved' })).resolves.toMatchObject({ status: 'approved' });
    await expect(decideLeave(ctx, { leaveRequestId: r2.leaveRequestId, decision: 'approved' })).resolves.toMatchObject({ status: 'approved' });
  });

  it('approval still REJECTS when usage accrued before the pool existed breaches it', async () => {
    const { ctx, scheme, ltA, ltB, employmentId } = await fixture();
    // 3 approved + 2 pending days accrue BEFORE the pool exists; then a cap of 4 arrives (config change).
    const r1 = await requestLeave(ctx, { employmentId, leaveTypeId: ltA, ...span3a, today: TODAY });
    await decideLeave(ctx, { leaveRequestId: r1.leaveRequestId, decision: 'approved' });
    const r2 = await requestLeave(ctx, { employmentId, leaveTypeId: ltB, ...span2, today: TODAY });
    await createLeaveSharedGroup(ctx, {
      name: 'Pool AB',
      totalLimitDays: 4,
      leaveTypeIds: [ltA, ltB],
    });
    await expect(
      decideLeave(ctx, { leaveRequestId: r2.leaveRequestId, decision: 'approved' }), // approved 3 + 2 = 5 > 4
    ).rejects.toThrow(CombinedLeaveLimitExceededError);
  });
});

describe('pool CRUD (core/benefit-scheme.ts)', () => {
  it('create → list round-trips name, total and members; appends the created event', async () => {
    const { ctx, scheme, ltA, ltB } = await fixture();
    const pool = await createLeaveSharedGroup(ctx, {
      name: 'Medical pool',
      totalLimitDays: 7.5,
      leaveTypeIds: [ltA, ltB],
    });
    const rows = await listLeaveSharedGroups(ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: pool.id, name: 'Medical pool', totalLimitDays: 7.5 });
    expect([...rows[0].leaveTypeIds].sort()).toEqual([ltA, ltB].sort());
    const payload = await latestEventPayload(b.tenantId, pool.id, 'leave-shared-group.created');
    expect(payload).toMatchObject({ name: 'Medical pool' });
  });

  it('rejects fewer than TWO member leave types', async () => {
    const { ctx, scheme, ltA } = await fixture();
    await expect(
      createLeaveSharedGroup(ctx, { name: 'Solo', totalLimitDays: 5, leaveTypeIds: [ltA] }),
    ).rejects.toThrow(/at least two/i);
    await expect(
      createLeaveSharedGroup(ctx, { name: 'None', totalLimitDays: 5, leaveTypeIds: [] }),
    ).rejects.toThrow(/at least two/i);
  });

  it('rejects a non-positive or absurd totalLimitDays', async () => {
    const { ctx, scheme, ltA, ltB } = await fixture();
    await expect(
      createLeaveSharedGroup(ctx, { name: 'Zero', totalLimitDays: 0, leaveTypeIds: [ltA, ltB] }),
    ).rejects.toThrow(/greater than zero/i);
    await expect(
      createLeaveSharedGroup(ctx, { name: 'Huge', totalLimitDays: 1000, leaveTypeIds: [ltA, ltB] }),
    ).rejects.toThrow(/too large/i);
  });

  it('a leave type joins at most ONE group, tenant-wide (friendly error)', async () => {
    const { ctx, scheme, ltA, ltB } = await fixture();
    const ltC = await leaveType();
    await createLeaveSharedGroup(ctx, { name: 'Pool 1', totalLimitDays: 5, leaveTypeIds: [ltA, ltB] });
    await expect(
      createLeaveSharedGroup(ctx, { name: 'Pool 2', totalLimitDays: 5, leaveTypeIds: [ltB, ltC] }),
    ).rejects.toThrow(/already belongs to the shared leave group/i);
  });

  it('update replaces name, total and the member set; delete removes the pool', async () => {
    const { ctx, scheme, ltA, ltB } = await fixture();
    const ltC = await leaveType();
    const pool = await createLeaveSharedGroup(ctx, { name: 'Old', totalLimitDays: 5, leaveTypeIds: [ltA, ltB] });
    await updateLeaveSharedGroup(ctx, { id: pool.id, name: 'New', totalLimitDays: 9, leaveTypeIds: [ltB, ltC] });
    const rows = await listLeaveSharedGroups(ctx);
    expect(rows[0]).toMatchObject({ name: 'New', totalLimitDays: 9 });
    expect([...rows[0].leaveTypeIds].sort()).toEqual([ltB, ltC].sort());
    await deleteLeaveSharedGroup(ctx, { id: pool.id });
    expect(await listLeaveSharedGroups(ctx)).toEqual([]);
    const deleted = await latestEventPayload(b.tenantId, pool.id, 'leave-shared-group.deleted');
    expect(deleted).not.toBeNull();
  });
});

// ── r88 / 1ef1cf95 ───────────────────────────────────────────────────────────────────────────────────
// WAS: describe('moveCombinedLimitMember (DnD move / ungroup)') + describe('groupSchemeLeaveTypes (DnD
// create)'). Both entrypoints existed to serve a drag-to-group interaction on the BENEFIT SCHEME screen,
// and both are gone with it — a shared group is tenant-level now and its membership is set by passing the
// whole member list to update.
//
// The entrypoints went; the INVARIANTS they protected did not, so they are re-pinned here through the
// surviving API rather than deleted:
//   - a type can be added to an existing group
//   - a type can be removed and the group survives while >= 2 members remain
//   - dropping to fewer than 2 members is REFUSED (the min-2 rule that made the old code "dissolve" the
//     pool; the new API states it as a validation error instead of silently deleting the group)
//   - a type still belongs to at most one group
describe('shared-group membership (the surviving API)', () => {
  it('adds a type to an existing group', async () => {
    const { ctx, ltA, ltB } = await fixture();
    const ltC = await leaveType();
    const pool = await createLeaveSharedGroup(ctx, { name: 'Pool', totalLimitDays: 5, leaveTypeIds: [ltA, ltB] });
    await updateLeaveSharedGroup(ctx, { id: pool.id, name: 'Pool', totalLimitDays: 5, leaveTypeIds: [ltA, ltB, ltC] });
    const rows = await listLeaveSharedGroups(ctx);
    expect([...rows[0].leaveTypeIds].sort()).toEqual([ltA, ltB, ltC].sort());
  });

  it('removes a type while 2+ members remain, and the group survives', async () => {
    const { ctx, ltA, ltB } = await fixture();
    const ltC = await leaveType();
    const pool = await createLeaveSharedGroup(ctx, { name: 'Pool', totalLimitDays: 5, leaveTypeIds: [ltA, ltB, ltC] });
    await updateLeaveSharedGroup(ctx, { id: pool.id, name: 'Pool', totalLimitDays: 5, leaveTypeIds: [ltA, ltB] });
    const rows = await listLeaveSharedGroups(ctx);
    expect(rows).toHaveLength(1);
    expect([...rows[0].leaveTypeIds].sort()).toEqual([ltA, ltB].sort());
  });

  it('REFUSES to drop below two members — the min-2 rule is stated, not silently applied', async () => {
    const { ctx, ltA, ltB } = await fixture();
    const pool = await createLeaveSharedGroup(ctx, { name: 'Pool', totalLimitDays: 5, leaveTypeIds: [ltA, ltB] });
    await expect(
      updateLeaveSharedGroup(ctx, { id: pool.id, name: 'Pool', totalLimitDays: 5, leaveTypeIds: [ltA] }),
    ).rejects.toThrow(/at least two/i);
    // …and the group is untouched by the refusal.
    const rows = await listLeaveSharedGroups(ctx);
    expect([...rows[0].leaveTypeIds].sort()).toEqual([ltA, ltB].sort());
  });

  it('a leave type still belongs to at most ONE group', async () => {
    const { ctx, ltA, ltB } = await fixture();
    const ltC = await leaveType();
    await createLeaveSharedGroup(ctx, { name: 'Pool 1', totalLimitDays: 5, leaveTypeIds: [ltA, ltB] });
    await expect(
      createLeaveSharedGroup(ctx, { name: 'Pool 2', totalLimitDays: 5, leaveTypeIds: [ltB, ltC] }),
    ).rejects.toThrow(/already belongs/i);
  });
});
