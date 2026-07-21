/**
 * Combined Leave Type Limit (R44 4c48fd1f) — enforcement + config CRUD coverage, added as STEP 0 of the
 * R47 d6f88c2f drag-and-drop grouping rework. These tests pin the EXISTING behaviour before the setup UI
 * is replaced, so the refactor cannot silently regress the cap that limits people's leave:
 *   - enforceCombinedLeaveLimit (core/leave.ts, private — exercised through requestLeave + decideLeave):
 *     under-cap passes, over-cap throws CombinedLeaveLimitExceededError (with poolName), pending AND
 *     approved usage both count, excludeRequestId avoids double-counting on the approval path, and
 *     employees/types outside any pool are unaffected.
 *   - Pool CRUD (core/benefit-scheme.ts): create/update/delete round-trips via listSchemeCombinedLimits,
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
import {
  createBenefitScheme,
  createSchemeCombinedLimit,
  updateSchemeCombinedLimit,
  deleteSchemeCombinedLimit,
  listSchemeCombinedLimits,
  moveCombinedLimitMember,
  groupSchemeLeaveTypes,
  setEmploymentBenefitScheme,
} from '../core/benefit-scheme';
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
    await createSchemeCombinedLimit(ctx, {
      benefitSchemeId: scheme.id,
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
    await createSchemeCombinedLimit(ctx, {
      benefitSchemeId: scheme.id,
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
    await createSchemeCombinedLimit(ctx, {
      benefitSchemeId: scheme.id,
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
    await createSchemeCombinedLimit(ctx, {
      benefitSchemeId: scheme.id,
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
    await createSchemeCombinedLimit(ctx, {
      benefitSchemeId: scheme.id,
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
    const pools = await listSchemeCombinedLimits(ctx, { benefitSchemeId: scheme.id });
    await deleteSchemeCombinedLimit(ctx, { id: pools[0].id });
    await requestLeave(ctx, { employmentId, leaveTypeId: ltA, ...span3a, today: TODAY });
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId: ltB, ...span3b, today: TODAY }),
    ).resolves.toBeTruthy();
  });
});

describe('enforceCombinedLeaveLimit — approval path (excludeRequestId)', () => {
  it('finalizeLeaveApproval excludes the request being approved from the usage sum (no double count)', async () => {
    const { ctx, scheme, ltA, ltB, employmentId } = await fixture();
    await createSchemeCombinedLimit(ctx, {
      benefitSchemeId: scheme.id,
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
    await createSchemeCombinedLimit(ctx, {
      benefitSchemeId: scheme.id,
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
    const pool = await createSchemeCombinedLimit(ctx, {
      benefitSchemeId: scheme.id,
      name: 'Medical pool',
      totalLimitDays: 7.5,
      leaveTypeIds: [ltA, ltB],
    });
    const rows = await listSchemeCombinedLimits(ctx, { benefitSchemeId: scheme.id });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: pool.id, name: 'Medical pool', totalLimitDays: 7.5 });
    expect([...rows[0].leaveTypeIds].sort()).toEqual([ltA, ltB].sort());
    const payload = await latestEventPayload(b.tenantId, pool.id, 'scheme-leave-combined-limit.created');
    expect(payload).toMatchObject({ benefitSchemeId: scheme.id, name: 'Medical pool' });
  });

  it('rejects fewer than TWO member leave types', async () => {
    const { ctx, scheme, ltA } = await fixture();
    await expect(
      createSchemeCombinedLimit(ctx, { benefitSchemeId: scheme.id, name: 'Solo', totalLimitDays: 5, leaveTypeIds: [ltA] }),
    ).rejects.toThrow(/at least two/i);
    await expect(
      createSchemeCombinedLimit(ctx, { benefitSchemeId: scheme.id, name: 'None', totalLimitDays: 5, leaveTypeIds: [] }),
    ).rejects.toThrow(/at least two/i);
  });

  it('rejects a non-positive or absurd totalLimitDays', async () => {
    const { ctx, scheme, ltA, ltB } = await fixture();
    await expect(
      createSchemeCombinedLimit(ctx, { benefitSchemeId: scheme.id, name: 'Zero', totalLimitDays: 0, leaveTypeIds: [ltA, ltB] }),
    ).rejects.toThrow(/greater than zero/i);
    await expect(
      createSchemeCombinedLimit(ctx, { benefitSchemeId: scheme.id, name: 'Huge', totalLimitDays: 1000, leaveTypeIds: [ltA, ltB] }),
    ).rejects.toThrow(/too large/i);
  });

  it('a leave type joins at most ONE pool per scheme (friendly unique-violation error)', async () => {
    const { ctx, scheme, ltA, ltB } = await fixture();
    const ltC = await leaveType();
    await createSchemeCombinedLimit(ctx, { benefitSchemeId: scheme.id, name: 'Pool 1', totalLimitDays: 5, leaveTypeIds: [ltA, ltB] });
    await expect(
      createSchemeCombinedLimit(ctx, { benefitSchemeId: scheme.id, name: 'Pool 2', totalLimitDays: 5, leaveTypeIds: [ltB, ltC] }),
    ).rejects.toThrow(/already belongs to another pool/i);
  });

  it('update replaces name, total and the member set; delete removes the pool', async () => {
    const { ctx, scheme, ltA, ltB } = await fixture();
    const ltC = await leaveType();
    const pool = await createSchemeCombinedLimit(ctx, { benefitSchemeId: scheme.id, name: 'Old', totalLimitDays: 5, leaveTypeIds: [ltA, ltB] });
    await updateSchemeCombinedLimit(ctx, { id: pool.id, name: 'New', totalLimitDays: 9, leaveTypeIds: [ltB, ltC] });
    const rows = await listSchemeCombinedLimits(ctx, { benefitSchemeId: scheme.id });
    expect(rows[0]).toMatchObject({ name: 'New', totalLimitDays: 9 });
    expect([...rows[0].leaveTypeIds].sort()).toEqual([ltB, ltC].sort());
    await deleteSchemeCombinedLimit(ctx, { id: pool.id });
    expect(await listSchemeCombinedLimits(ctx, { benefitSchemeId: scheme.id })).toEqual([]);
    const deleted = await latestEventPayload(b.tenantId, pool.id, 'scheme-leave-combined-limit.deleted');
    expect(deleted).not.toBeNull();
  });
});

// ── R47 d6f88c2f — the narrow DnD entrypoints ────────────────────────────────────────────────────────
describe('moveCombinedLimitMember (DnD move / ungroup)', () => {
  it('moves an ungrouped type INTO a pool and appends the member.moved event', async () => {
    const { ctx, scheme, ltA, ltB } = await fixture();
    const ltC = await leaveType();
    const pool = await createSchemeCombinedLimit(ctx, { benefitSchemeId: scheme.id, name: 'Pool', totalLimitDays: 5, leaveTypeIds: [ltA, ltB] });
    await moveCombinedLimitMember(ctx, { benefitSchemeId: scheme.id, leaveTypeId: ltC, toCombinedLimitId: pool.id });
    const rows = await listSchemeCombinedLimits(ctx, { benefitSchemeId: scheme.id });
    expect([...rows[0].leaveTypeIds].sort()).toEqual([ltA, ltB, ltC].sort());
    const moved = await latestEventPayload(b.tenantId, pool.id, 'scheme-leave-combined-limit.member.moved');
    expect(moved).toMatchObject({ leaveTypeId: ltC, fromCombinedLimitId: null, toCombinedLimitId: pool.id });
  });

  it('ungroups a member of a ≥3 pool (pool survives); ungrouping from a 2-member pool DISSOLVES it', async () => {
    const { ctx, scheme, ltA, ltB } = await fixture();
    const ltC = await leaveType();
    const pool = await createSchemeCombinedLimit(ctx, { benefitSchemeId: scheme.id, name: 'Pool', totalLimitDays: 5, leaveTypeIds: [ltA, ltB, ltC] });
    await moveCombinedLimitMember(ctx, { benefitSchemeId: scheme.id, leaveTypeId: ltC, toCombinedLimitId: null });
    let rows = await listSchemeCombinedLimits(ctx, { benefitSchemeId: scheme.id });
    expect([...rows[0].leaveTypeIds].sort()).toEqual([ltA, ltB].sort());
    // Second detach leaves 1 member — under the min-2 invariant the pool must dissolve, not persist.
    await moveCombinedLimitMember(ctx, { benefitSchemeId: scheme.id, leaveTypeId: ltB, toCombinedLimitId: null });
    rows = await listSchemeCombinedLimits(ctx, { benefitSchemeId: scheme.id });
    expect(rows).toEqual([]);
    const dissolved = await latestEventPayload(b.tenantId, pool.id, 'scheme-leave-combined-limit.deleted');
    expect(dissolved).toMatchObject({ dissolvedBy: 'member-detach' });
  });

  it('moving between pools MOVES (never copies) and dissolves a source left under 2 members', async () => {
    const { ctx, scheme, ltA, ltB } = await fixture();
    const [ltC, ltD] = [await leaveType(), await leaveType()];
    const p1 = await createSchemeCombinedLimit(ctx, { benefitSchemeId: scheme.id, name: 'P1', totalLimitDays: 5, leaveTypeIds: [ltA, ltB] });
    const p2 = await createSchemeCombinedLimit(ctx, { benefitSchemeId: scheme.id, name: 'P2', totalLimitDays: 6, leaveTypeIds: [ltC, ltD] });
    await moveCombinedLimitMember(ctx, { benefitSchemeId: scheme.id, leaveTypeId: ltA, toCombinedLimitId: p2.id });
    const rows = await listSchemeCombinedLimits(ctx, { benefitSchemeId: scheme.id });
    expect(rows).toHaveLength(1); // P1 (left with only ltB) dissolved
    expect(rows[0].id).toBe(p2.id);
    expect([...rows[0].leaveTypeIds].sort()).toEqual([ltA, ltC, ltD].sort());
    const moved = await latestEventPayload(b.tenantId, p2.id, 'scheme-leave-combined-limit.member.moved');
    expect(moved).toMatchObject({ fromCombinedLimitId: p1.id, toCombinedLimitId: p2.id, dissolvedCombinedLimitId: p1.id });
  });

  it('is a quiet no-op when the type is already in the target pool / already ungrouped', async () => {
    const { ctx, scheme, ltA, ltB } = await fixture();
    const ltC = await leaveType();
    const pool = await createSchemeCombinedLimit(ctx, { benefitSchemeId: scheme.id, name: 'Pool', totalLimitDays: 5, leaveTypeIds: [ltA, ltB] });
    await moveCombinedLimitMember(ctx, { benefitSchemeId: scheme.id, leaveTypeId: ltA, toCombinedLimitId: pool.id });
    await moveCombinedLimitMember(ctx, { benefitSchemeId: scheme.id, leaveTypeId: ltC, toCombinedLimitId: null });
    const rows = await listSchemeCombinedLimits(ctx, { benefitSchemeId: scheme.id });
    expect([...rows[0].leaveTypeIds].sort()).toEqual([ltA, ltB].sort());
  });

  it('rejects a target pool from a different scheme', async () => {
    const { ctx, scheme, ltA, ltB } = await fixture();
    const other = await createBenefitScheme(ctx, {
      companyId: b.companyId,
      employmentType: 'contract',
      gradeGroupId: null,
      name: 'Other scheme',
      status: 'active',
    });
    const foreign = await createSchemeCombinedLimit(ctx, { benefitSchemeId: other.id, name: 'Foreign', totalLimitDays: 5, leaveTypeIds: [ltA, ltB] });
    await expect(
      moveCombinedLimitMember(ctx, { benefitSchemeId: scheme.id, leaveTypeId: ltA, toCombinedLimitId: foreign.id }),
    ).rejects.toThrow(/not found in this scheme/i);
  });
});

describe('groupSchemeLeaveTypes (DnD create)', () => {
  it('creates a pool from two rows, detaching a dragged type from its old pool (dissolving it at <2)', async () => {
    const { ctx, scheme, ltA, ltB } = await fixture();
    const ltC = await leaveType();
    const old = await createSchemeCombinedLimit(ctx, { benefitSchemeId: scheme.id, name: 'Old', totalLimitDays: 5, leaveTypeIds: [ltA, ltB] });
    // Dragging the grouped A onto the ungrouped C forms a NEW pool {A, C}; Old (left with B) dissolves.
    const created = await groupSchemeLeaveTypes(ctx, { benefitSchemeId: scheme.id, name: 'Pooled + Pooled', totalLimitDays: 4, leaveTypeIds: [ltA, ltC] });
    const rows = await listSchemeCombinedLimits(ctx, { benefitSchemeId: scheme.id });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: created.id, name: 'Pooled + Pooled', totalLimitDays: 4 });
    expect([...rows[0].leaveTypeIds].sort()).toEqual([ltA, ltC].sort());
    const payload = await latestEventPayload(b.tenantId, created.id, 'scheme-leave-combined-limit.created');
    expect(payload).toMatchObject({ dissolvedCombinedLimitIds: [old.id] });
  });

  it('keeps the create validators (min-2 members, positive total)', async () => {
    const { ctx, scheme, ltA, ltB } = await fixture();
    await expect(
      groupSchemeLeaveTypes(ctx, { benefitSchemeId: scheme.id, name: 'Solo', totalLimitDays: 5, leaveTypeIds: [ltA] }),
    ).rejects.toThrow(/at least two/i);
    await expect(
      groupSchemeLeaveTypes(ctx, { benefitSchemeId: scheme.id, name: 'Zero', totalLimitDays: 0, leaveTypeIds: [ltA, ltB] }),
    ).rejects.toThrow(/greater than zero/i);
  });

  it('the cap created by grouping ENFORCES on requestLeave (end-to-end wiring)', async () => {
    const { ctx, scheme, ltA, ltB, employmentId } = await fixture();
    await groupSchemeLeaveTypes(ctx, { benefitSchemeId: scheme.id, name: 'DnD pool', totalLimitDays: 5, leaveTypeIds: [ltA, ltB] });
    await requestLeave(ctx, { employmentId, leaveTypeId: ltA, ...span3a, today: TODAY });
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId: ltB, ...span3b, today: TODAY }),
    ).rejects.toMatchObject({ poolName: 'DnD pool' });
  });
});
