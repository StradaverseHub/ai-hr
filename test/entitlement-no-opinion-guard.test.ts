/**
 * 6e9a126e RELEASE ONE — "NOTHING IS SET UP" IS NOT "ZERO DAYS".
 *
 * THE HAZARD THIS GUARD REMOVES, in the approved plan's own words to the reporter: "While nothing is
 * configured, the system's honest answer for every employee is zero days… saving anything at all on an
 * employee's profile triggers an automatic recheck, and that recheck would post a NEGATIVE correction —
 * days SUBTRACTED from what people currently have left."
 *
 * The mechanism, precisely: `entitledDays` composes `schemeDays ?? policyDays` and its callers pass
 * `pol?.days ?? 0`, so an employee with NO scheme entitlement and NO matching policy row composes to a
 * confident 0. `projectExpectedEntitlement` then returns expected 0, and every caller computes
 * `delta = 0 − alreadyPosted` and posts an `adjustment` for the difference. And the EA-1955 floor no
 * longer props the number up: fa3f4ccb made it ADVISORY at the reporter's written request.
 *
 * The guard ships in RELEASE ONE, which clears nothing, rather than in release three, which clears
 * everything — a safety property landing in the same change as its hazard has never been observed working
 * without it.
 *
 * WHAT IS PINNED HERE:
 *  1. the pure predicate's absence-vs-explicit-zero distinction;
 *  2. the live path: an employee holding a granted balance, with the configuration then removed, is left
 *     ALONE — delta exactly 0, balance untouched. WATCHED FAIL: with the guard removed this posts −14 and
 *     drives the balance to 0, which is the reported hazard reproduced;
 *  3. THE NEGATIVE CONTROL, and it matters as much: a policy that says 0 days is an OPINION somebody
 *     typed, and it must still claw back. A guard that swallowed that too would silently break every
 *     legitimate downward correction.
 *  4. `openLeaveYear` writes NO ledger row for an unconfigured standing type — the property the plan's
 *     blast-radius argument actually rests on (`if (days <= 0) continue;` sits after the composition and
 *     before every write), rather than the false claim that openLeaveYear only visits configured types.
 *  5. `accrueEarnedLeave` against an empty configuration is INERT. The plan asserts this and says to prove
 *     it rather than assume it, because it shares the composition the guard changes.
 */
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { createLeavePolicy } from '../core/admin';
import {
  accrueEarnedLeave,
  noEntitlementOpinion,
  openLeaveYear,
  reprojectEntitlementForEmployment,
} from '../core/leave';
import { adminCtx, closeAll, ledgerBalance, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
const ASOF = '2026-06-30';
const uniqEmail = () => `noopinion_${randomUUID().slice(0, 8)}@t.local`;

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

const hire = (hiredOn: string) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: 'Nina Simone', primaryEmail: uniqEmail() },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn,
    gradeId: null,
    grantLeaveTypes: [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }],
  });

/** Every leave_policy row for the tenant — the reset, simulated at the owner level. */
const wipeAllPolicies = () => owner.db.delete(schema.leavePolicy);

const annualLedgerRows = (employmentId: string) =>
  owner.db
    .select({ entryType: schema.leaveLedger.entryType, days: schema.leaveLedger.days })
    .from(schema.leaveLedger)
    .where(
      and(
        eq(schema.leaveLedger.employmentId, employmentId),
        eq(schema.leaveLedger.leaveTypeId, b.annualLeaveTypeId),
      ),
    );

describe('noEntitlementOpinion — absence and an explicit zero are different facts', () => {
  it('no template, no scheme and no policy is NO OPINION', () => {
    expect(noEntitlementOpinion({ templateDays: null, schemeDays: null, policy: null })).toBe(true);
  });

  it('a policy resolving ZERO days is an opinion somebody typed, not an absence', () => {
    // This is the distinction the whole guard turns on. `pol?.days ?? 0` flattens these two into the same
    // number, which is exactly why the predicate reads the RESOLUTIONS and not the composed figure.
    expect(noEntitlementOpinion({ templateDays: null, schemeDays: null, policy: { days: 0, carryMax: 0 } })).toBe(
      false,
    );
  });

  it('a scheme band of ZERO days is an opinion too', () => {
    expect(noEntitlementOpinion({ templateDays: null, schemeDays: 0, policy: null })).toBe(false);
  });

  it('a resolved template supersedes the question — release two passes it, release one always passes null', () => {
    expect(noEntitlementOpinion({ templateDays: 0, schemeDays: null, policy: null })).toBe(false);
    expect(noEntitlementOpinion({ templateDays: 18, schemeDays: null, policy: null })).toBe(false);
  });
});

describe('the reset cannot claw back days: an unconfigured type is left alone', () => {
  it('clearing every policy leaves the balance EXACTLY where it was — delta 0, no adjustment row', async () => {
    const ctx = adminCtx(b);
    await createLeavePolicy(ctx, { leaveTypeId: b.annualLeaveTypeId, annualDays: 14, validFrom: '2020-01-01' });
    const emp = await hire('2026-01-01');
    expect(await ledgerBalance(emp.employmentId, b.annualLeaveTypeId)).toBe(14);

    // THE RESET, in miniature: the configuration goes, the ledger stays.
    await wipeAllPolicies();

    const res = await reprojectEntitlementForEmployment(ctx, {
      employmentId: emp.employmentId,
      asOf: ASOF,
      trigger: 'profile_saved',
    });
    // WATCHED FAIL: without the guard this is { affected: 1, totalDelta: -14 } and the balance is 0 —
    // the reported hazard, reproduced by an ordinary profile save.
    expect(res).toEqual({ affected: 0, totalDelta: 0 });
    expect(await ledgerBalance(emp.employmentId, b.annualLeaveTypeId)).toBe(14);
    const rows = await annualLedgerRows(emp.employmentId);
    expect(rows.filter((r) => r.entryType === 'adjustment')).toHaveLength(0);
  });

  it('and it stays inert on repeat — a second save posts nothing either', async () => {
    const ctx = adminCtx(b);
    await createLeavePolicy(ctx, { leaveTypeId: b.annualLeaveTypeId, annualDays: 14, validFrom: '2020-01-01' });
    const emp = await hire('2026-01-01');
    await wipeAllPolicies();
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await reprojectEntitlementForEmployment(ctx, {
        employmentId: emp.employmentId,
        asOf: ASOF,
        trigger: 'profile_saved',
      });
      expect(res).toEqual({ affected: 0, totalDelta: 0 });
    }
    expect(await ledgerBalance(emp.employmentId, b.annualLeaveTypeId)).toBe(14);
  });

  it('NEGATIVE CONTROL — a policy that SAYS zero still claws back, because that is a real answer', async () => {
    const ctx = adminCtx(b);
    await createLeavePolicy(ctx, { leaveTypeId: b.annualLeaveTypeId, annualDays: 14, validFrom: '2020-01-01' });
    const emp = await hire('2026-01-01');
    expect(await ledgerBalance(emp.employmentId, b.annualLeaveTypeId)).toBe(14);

    // Not a reset: somebody deliberately superseded the running version with a zero-day one. The guard
    // must NOT swallow this, or every legitimate downward correction disappears with it.
    await createLeavePolicy(ctx, { leaveTypeId: b.annualLeaveTypeId, annualDays: 0, validFrom: '2026-01-02' });
    const res = await reprojectEntitlementForEmployment(ctx, {
      employmentId: emp.employmentId,
      asOf: ASOF,
      trigger: 'policy_changed',
    });
    expect(res).toEqual({ affected: 1, totalDelta: -14 });
    expect(await ledgerBalance(emp.employmentId, b.annualLeaveTypeId)).toBe(0);
  });
});

describe('the blast radius during the blank window', () => {
  it('openLeaveYear writes NO ledger row for an unconfigured STANDING type', async () => {
    // The plan's blast-radius argument was originally that openLeaveYear only visits configured types.
    // THAT IS FALSE — ANNUAL, SICK and HOSPITALIZATION are entered whatever the configuration says
    // (STANDING_LEAVE_CODES). What actually holds is the `if (days <= 0) continue;` that sits immediately
    // after the entitlement composition and BEFORE the carry-forfeit and accrual-marker writes. So an
    // unconfigured standing type is visited, composes to 0, and is skipped before anything is written —
    // which is why the reprojection later finds no accrual row to correct against. Pinned, because the
    // guard's whole safety case rests on it.
    const emp = await hire('2025-01-01');
    await openLeaveYear(adminCtx(b), { year: 2026 });
    const rows = await annualLedgerRows(emp.employmentId);
    expect(rows).toHaveLength(0);
    expect(await ledgerBalance(emp.employmentId, b.annualLeaveTypeId)).toBe(0);
  });

  it('accrueEarnedLeave against an empty configuration grants nothing', async () => {
    // ASSERTED BY THE PLAN, NOT TESTED BY ANYTHING UNTIL NOW — and it shares the composition hook the
    // guard changes, which is precisely why "it only grants when the shortfall is positive, so it should
    // be inert" was not good enough. It is the second scheduled engine that will run against the cleared
    // configuration every month of the blank window.
    const emp = await hire('2025-01-01');
    const before = await ledgerBalance(emp.employmentId, b.annualLeaveTypeId);
    const res = await accrueEarnedLeave(adminCtx(b), { asOf: ASOF });
    expect(res.granted).toBe(0);
    expect(await ledgerBalance(emp.employmentId, b.annualLeaveTypeId)).toBe(before);
    expect(await annualLedgerRows(emp.employmentId)).toHaveLength(0);
  });
});
