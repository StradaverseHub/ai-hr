/**
 * THE TYPE-LEVEL RULE EDITOR (feedback 9816a5ad step 2, revision 8).
 *
 * WHY THIS TEST EXISTS AT ALL. Step 1 added the rule columns to `leave_type`; step 2 makes the engines
 * READ them; step 3 (`fa3f4ccb`) DELETES the old per-policy editors. Nothing in that sequence ever built
 * a writer, and `updateLeaveType` sets name/code/eligibility/probation and none of the rule columns. Ship
 * all three as originally planned and Earning Method, Carry Forward + expiry, Rounding and Maximum Balance
 * are frozen forever at whatever migration 0325 backfilled. That gap is the reason the item reached
 * revision 8, and this file is the proof it is closed.
 *
 * WHAT EACH SECTION CATCHES
 *   §1  The writer actually persists, and the engines read what it wrote — a round trip through
 *       applyLeaveTypeRules, not merely a successful UPDATE.
 *   §2  The tri-state. Earning and Carry are two separate forms over one row; a patch keyed on truthiness
 *       lets an earning-only save wipe the carry configuration. This is the regression that would be
 *       invisible until somebody's carry-forward quietly stopped working.
 *   §3  Validation refuses what the 0325 CHECK constraints refuse, with a NAMED error, so an operator
 *       never meets a raw 23514.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { setLeaveTypeRules, LeaveTypeRuleError } from '../core/admin';
import { applyLeaveTypeRules } from '../core/leave-compute';

let b: Base;

beforeAll(async () => {
  await migrateTestDb();
});
beforeAll(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(closeAll);

const annualId = async () => {
  const [t] = await owner.db
    .select({ id: schema.leaveType.id })
    .from(schema.leaveType)
    .where(eq(schema.leaveType.code, 'ANNUAL'))
    .limit(1);
  return t!.id;
};

const rulesOf = async (id: string) => {
  const [t] = await owner.db
    .select({
      accrualMethod: schema.leaveType.accrualMethod,
      carryForwardEnabled: schema.leaveType.carryForwardEnabled,
      carryForwardMax: schema.leaveType.carryForwardMax,
      carryForwardExpiryMode: schema.leaveType.carryForwardExpiryMode,
      carryForwardExpiryMonths: schema.leaveType.carryForwardExpiryMonths,
      roundingMethod: schema.leaveType.roundingMethod,
      maxBalanceDays: schema.leaveType.maxBalanceDays,
    })
    .from(schema.leaveType)
    .where(eq(schema.leaveType.id, id))
    .limit(1);
  return t!;
};

describe('§1 the writer persists, and the engine reads it back', () => {
  it('writes every rule and the engine resolves the written values', async () => {
    const id = await annualId();
    await setLeaveTypeRules(adminCtx(b), {
      id,
      accrualMethod: 'earned_monthly',
      carryForwardEnabled: true,
      carryForwardMax: 10,
      carryForwardExpiryMode: 'months',
      carryForwardExpiryMonths: 6,
      roundingMethod: 'up',
      maxBalanceDays: 25,
    });
    const r = await rulesOf(id);
    expect(r.accrualMethod).toBe('earned_monthly');
    expect(r.carryForwardExpiryMonths).toBe(6);
    expect(r.roundingMethod).toBe('up');

    // The proof that matters: the overlay the engines use resolves what was just written, rather than the
    // policy row it used to come from. A stored value nothing reads would pass a column assertion alone.
    const resolved = applyLeaveTypeRules({ days: 12, carryMax: 0 }, r);
    expect(resolved?.method).toBe('earned_monthly');
    expect(resolved?.roundingMethod).toBe('up');
  });

  it('records the change with both sides, because these rules decide what everyone accrues', async () => {
    const id = await annualId();
    await setLeaveTypeRules(adminCtx(b), { id, roundingMethod: 'down' });
    const events = await owner.db
      .select({ t: schema.domainEvent.eventType, p: schema.domainEvent.payload })
      .from(schema.domainEvent)
      .where(eq(schema.domainEvent.aggregateId, id));
    const ev = events.filter((e) => e.t === 'leave-type.rules.updated').at(-1);
    expect(ev).toBeTruthy();
    const payload = ev!.p as { before: Record<string, unknown>; after: Record<string, unknown> };
    expect(payload.after.roundingMethod).toBe('down');
    // `after` must be the resulting STATE, not the posted patch — a reader has to see what it became.
    expect(payload.after).toHaveProperty('accrualMethod');
  });
});

describe('§2 the tri-state — one row, two forms, disjoint halves', () => {
  it('an earning-only save leaves the carry configuration untouched', async () => {
    const id = await annualId();
    await setLeaveTypeRules(adminCtx(b), {
      id,
      carryForwardEnabled: true,
      carryForwardMax: 10,
      carryForwardExpiryMode: 'months',
      carryForwardExpiryMonths: 6,
    });
    // The Earning Method form posts ONLY its half.
    await setLeaveTypeRules(adminCtx(b), { id, accrualMethod: 'lump_sum', roundingMethod: 'down' });

    const r = await rulesOf(id);
    expect(r.accrualMethod).toBe('lump_sum');
    expect(r.roundingMethod).toBe('down');
    // ...and the carry half survived. Without the tri-state this is where carry-forward silently dies.
    expect(r.carryForwardEnabled).toBe(true);
    expect(Number(r.carryForwardMax)).toBe(10);
    expect(r.carryForwardExpiryMonths).toBe(6);
  });

  it('an explicit null CLEARS, which is different from omitting the field', async () => {
    const id = await annualId();
    await setLeaveTypeRules(adminCtx(b), { id, roundingMethod: 'up' });
    await setLeaveTypeRules(adminCtx(b), { id, roundingMethod: null });
    expect((await rulesOf(id)).roundingMethod).toBeNull();
  });

  it('a call with no fields at all is a no-op rather than a wipe', async () => {
    const id = await annualId();
    await setLeaveTypeRules(adminCtx(b), { id, accrualMethod: 'earned_monthly', carryForwardMax: 7 });
    await setLeaveTypeRules(adminCtx(b), { id });
    const r = await rulesOf(id);
    expect(r.accrualMethod).toBe('earned_monthly');
    expect(Number(r.carryForwardMax)).toBe(7);
  });
});

describe('§3 validation refuses what the constraints refuse, by name', () => {
  const cases: [string, Parameters<typeof setLeaveTypeRules>[1]][] = [
    ['expiry months out of range', { id: '', carryForwardExpiryMonths: 13 }],
    ['expiry months not whole', { id: '', carryForwardExpiryMonths: 2.5 }],
    ['carry cap negative', { id: '', carryForwardMax: -1 }],
    ['max balance beyond the column domain', { id: '', maxBalanceDays: 10000 }],
    ['a day that is not a real date in that month', { id: '', carryForwardExpiryMonth: 2, carryForwardExpiryDay: 30 }],
  ];
  for (const [label, patch] of cases) {
    it(`refuses ${label} with a named error`, async () => {
      const id = await annualId();
      // Asserted by CLASS, not with a bare rejects.toThrow() — this repo has twice had a test pass on the
      // wrong throw, and an id-not-found would throw here too.
      await expect(setLeaveTypeRules(adminCtx(b), { ...patch, id })).rejects.toBeInstanceOf(LeaveTypeRuleError);
    });
  }

  it('accepts 29 February, because the engine does', async () => {
    const id = await annualId();
    await setLeaveTypeRules(adminCtx(b), { id, carryForwardExpiryMode: 'date', carryForwardExpiryMonth: 2, carryForwardExpiryDay: 29 });
    const [t] = await owner.db
      .select({ d: schema.leaveType.carryForwardExpiryDay })
      .from(schema.leaveType)
      .where(eq(schema.leaveType.id, id))
      .limit(1);
    expect(t!.d).toBe(29);
  });
});
