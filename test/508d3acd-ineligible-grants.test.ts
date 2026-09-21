/**
 * 508d3acd — the Maternity Leave card, and the 6,566 days behind it.
 *
 * ⚠️ THE REPORTED FAULT WAS A DISPLAY BUG AND IT WAS NOT ONE. The ticket says My Leave shows a Maternity
 * card to an ineligible employee (EMP-0004, male, Entitlement 98.00 / Balance 98.00) and asks for the
 * card to be filtered. Measured on production first: the card is CORRECT. There really is a 98-day
 * Maternity credit in that record, written by a Leave Generation run on 2026-09-20 which credited the
 * type to all 79 employments — 6,566 of those days to 67 people the type's own gender rule excludes.
 *
 * `leaveBalances` already filters the no-activity tail through the eligibility gate, which is also the
 * reporter's own edge case 1 (someone with history keeps their card). It could not fire, because a
 * credit IS activity. Hiding the card would have hidden 6,566 wrong days that still sit in HR screens,
 * reports and anything that ever pays a balance out.
 *
 * SO THE FIX IS IN THE GRANT. `openLeaveYear` consulted no identity condition at all. That was harmless
 * while it granted only the three standing codes; 783bf55a / baea8e5b widened it to EVERY type, and it
 * stopped being harmless the moment a tenant configured Maternity for female married employees.
 *
 * WHAT THIS FILE PINS
 *   1. the engine refuses a pair the type's identity conditions exclude, and still grants everyone else;
 *   2. the split — identity rules gate the GRANT, timing rules (minimum service, probation) do not,
 *      because the year-open runs once and would otherwise skip every new joiner forever;
 *   3. the card rule the reporter asked for, including that minimum service must NOT hide a card;
 *   4. that an unrecorded attribute does not match a configured list, which is why 55 of their 75
 *      profiles matter.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, seedEntitlement, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { isProfileEligible, isLeaveEligible, openLeaveYear } from '../core/leave';
import { leaveBalances } from '../core/read';

let b: Base;

const MATERNITY = { gender: ['female'], maritalStatus: ['married'] };

async function leaveTypeWith(eligibility: unknown, over: Record<string, unknown> = {}) {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      tenantId: b.tenantId,
      code: `T${randomUUID().slice(0, 6).toUpperCase()}`,
      name: `Type ${randomUUID().slice(0, 6)}`,
      paid: true,
      counting: 'calendar_days',
      eligibility: eligibility as never,
      ...over,
    })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

async function hire(gender: string | null, marital: string | null, hiredOn = '2020-01-01') {
  const { employmentId } = await hireEmployee(adminCtx(b), {
    person: { fullName: 'Fixture Person', primaryEmail: `p_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn,
  });
  const [emp] = await owner.db
    .select({ personId: schema.employment.personId })
    .from(schema.employment)
    .where(eq(schema.employment.id, employmentId));
  await owner.db
    .update(schema.person)
    .set({ gender, maritalStatus: marital })
    .where(eq(schema.person.id, emp.personId));
  return employmentId;
}

const accrualDays = async (employmentId: string, leaveTypeId: string) => {
  const rows = await owner.db
    .select({ days: schema.leaveLedger.days, entryType: schema.leaveLedger.entryType })
    .from(schema.leaveLedger)
    .where(eq(schema.leaveLedger.employmentId, employmentId));
  return rows
    .filter((r) => r.entryType === 'accrual' || r.entryType === 'in_lieu_accrual')
    .reduce((n, r) => n + Number(r.days), 0);
};

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

describe('508d3acd · the identity gate, on its own', () => {
  it('refuses the wrong gender and the wrong marital status, and accepts the right one', () => {
    const she = { gender: 'female', marital: 'married' };
    const he = { gender: 'male', marital: 'married' };
    const single = { gender: 'female', marital: 'single' };
    expect(isProfileEligible(MATERNITY, she, 'exclude')).toBe(true);
    expect(isProfileEligible(MATERNITY, he, 'exclude'), 'the reported case — EMP-0004 is male').toBe(false);
    expect(isProfileEligible(MATERNITY, single, 'exclude')).toBe(false);
  });

  /**
   * THE 55-OF-75 CASE. `emp.gender ?? ''` is compared against the configured list, so an unrecorded
   * attribute matches nothing. That is the correct reading — "unknown" is not "female" — but it means
   * an incomplete profile loses the card, and the plan said so in plain words rather than softening it.
   */
  it('treats an unrecorded attribute as NOT matching — unknown is not a match', () => {
    expect(isProfileEligible(MATERNITY, { gender: null, marital: 'married' }, 'exclude')).toBe(false);
    expect(isProfileEligible(MATERNITY, { gender: 'female', marital: null }, 'exclude')).toBe(false);
    expect(isProfileEligible(MATERNITY, undefined, 'exclude')).toBe(false);
  });

  /**
   * ⚠️ THE OTHER READING, AND IT IS THE ONE THAT MATTERS FOR DAYS. A production dry run of the reversal
   * sweep proposed taking Annual Leave off 33 employees — not because they were ineligible, but because
   * ANNUAL lists every gender and their gender is blank, so they matched nothing. 55 of 75 profiles on
   * that account have no gender. Under 'allow', a missing fact is not a missing qualification.
   */
  it('under allow, a MISSING attribute never excludes — only a recorded contradiction does', () => {
    expect(isProfileEligible(MATERNITY, { gender: null, marital: 'married' }, 'allow'), 'unplaced, not ineligible').toBe(true);
    expect(isProfileEligible(MATERNITY, { gender: 'male', marital: 'married' }, 'allow'), 'recorded and contradicted').toBe(false);
    const everyGender = { gender: ['male', 'female'] };
    expect(isProfileEligible(everyGender, { gender: null, marital: null }, 'allow'), 'a list that restricts nobody must exclude nobody').toBe(true);
    expect(isProfileEligible(everyGender, { gender: null, marital: null }, 'exclude'), 'and under exclude it does — which is why the caller must choose').toBe(false);
  });

  it('a type with NO identity condition is open to everybody', () => {
    expect(isProfileEligible(null, { gender: null, marital: null }, 'exclude')).toBe(true);
    expect(isProfileEligible({}, { gender: 'male', marital: 'single' }, 'exclude')).toBe(true);
  });

  /**
   * THE SPLIT, asserted in both directions. It is the whole reason the predicate was extracted: the
   * apply gate must keep counting minimum service, and the grant must not.
   */
  it('carries NO timing rule — minimum service is invisible to it, and still visible to the apply gate', () => {
    const elig = { minServiceMonths: 12, minServiceUnit: 'months' as const };
    const newJoiner = { gender: 'male', marital: 'single', hiredOn: '2026-09-01' };
    expect(isProfileEligible(elig, newJoiner, 'exclude'), 'identity says nothing about service').toBe(true);
    expect(isLeaveEligible(elig, newJoiner, '2026-09-20'), 'the apply gate still refuses').toBe(false);
  });
});

describe('508d3acd · the year-open grant refuses a pair the type excludes', () => {
  it('grants the eligible employee and NOTHING to the excluded one', async () => {
    const mtl = await leaveTypeWith(MATERNITY);
    const she = await hire('female', 'married');
    const he = await hire('male', 'married');
    // 98 days for anyone the type reaches — the reporter's own figure.
    await seedEntitlement(adminCtx(b), { leaveTypeId: mtl, annualDays: 98.00, validFrom: '2026-01-01' });

    const res = await openLeaveYear(adminCtx(b), { year: 2026, leaveTypeIds: [mtl] });
    expect(res, 'the sweep ran').toBeTruthy();

    expect(await accrualDays(she, mtl), 'the eligible employee keeps her entitlement').toBeGreaterThan(0);
    // THE REGRESSION ARM. Before this gate the same run credited him the identical 98 days.
    expect(await accrualDays(he, mtl), 'a man is granted no maternity leave').toBe(0);
  });

  it('reports the skip as not_eligible rather than silently doing nothing', async () => {
    const mtl = await leaveTypeWith(MATERNITY);
    const he = await hire('male', 'married');
    await seedEntitlement(adminCtx(b), { leaveTypeId: mtl, annualDays: 98.00, validFrom: '2026-01-01' });
    const res = await openLeaveYear(adminCtx(b), { year: 2026, leaveTypeIds: [mtl], dryRun: true });
    const mine = (res.rows ?? []).filter((r) => r.employmentId === he);
    expect(mine.length, 'the pair is logged, not dropped').toBeGreaterThan(0);
    expect(mine.map((r) => r.outcome)).toContain('not_eligible');
  });

  /**
   * ⚠️ THE REGRESSION THIS ROUND ALMOST SHIPPED, and the reason the gate takes an explicit policy.
   *
   * Six LIVE leave types on the reporting account list gender ["male","female"] — a list that restricts
   * nobody — and 55 of their 75 active employees have no gender recorded. A gate that reads a missing
   * fact as a failed qualification would have granted those 55 people NOTHING on all six types at the
   * next year-open. It was caught by a production dry run of the reversal sweep, which proposed taking
   * Annual Leave off 33 employees for the same reason; the suite was green throughout.
   */
  it('grants a type that lists every gender to somebody whose gender is not recorded', async () => {
    const openToAll = await leaveTypeWith({ gender: ['male', 'female'] });
    const unplaced = await hire(null, null);
    await seedEntitlement(adminCtx(b), { leaveTypeId: openToAll, annualDays: 14, validFrom: '2026-01-01' });
    await openLeaveYear(adminCtx(b), { year: 2026, leaveTypeIds: [openToAll] });
    expect(
      await accrualDays(unplaced, openToAll),
      'a blank profile field must never withhold entitlement',
    ).toBeGreaterThan(0);
  });

  it('…and STILL refuses the recorded contradiction, so the relaxation is not a hole', async () => {
    const mtl = await leaveTypeWith(MATERNITY);
    const he = await hire('male', 'married');
    const unplaced = await hire(null, null);
    await seedEntitlement(adminCtx(b), { leaveTypeId: mtl, annualDays: 98, validFrom: '2026-01-01' });
    await openLeaveYear(adminCtx(b), { year: 2026, leaveTypeIds: [mtl] });
    expect(await accrualDays(he, mtl), 'recorded male, maternity is female-only').toBe(0);
    // The unplaced employee DOES get it, and that is the deliberate trade: we would rather grant a day
    // we may have to take back than withhold one we owe. The profile is what fixes it.
    expect(await accrualDays(unplaced, mtl), 'unplaced is granted — fill the profile in').toBeGreaterThan(0);
  });

  /**
   * THE OTHER HALF, and the one a careless fix breaks: a type with a MINIMUM SERVICE rule must still be
   * granted to a brand-new joiner. The year-open runs once — refuse them here and they never get it.
   */
  it('still grants a type whose only condition is minimum service, to somebody who has not served it', async () => {
    const annual = await leaveTypeWith({ minServiceMonths: 12, minServiceUnit: 'months' });
    const fresh = await hire('male', 'single', '2026-08-01');
    await seedEntitlement(adminCtx(b), { leaveTypeId: annual, annualDays: 14.00, validFrom: '2026-01-01' });
    await openLeaveYear(adminCtx(b), { year: 2026, leaveTypeIds: [annual] });
    expect(await accrualDays(fresh, annual), 'a timing rule must not withhold the grant').toBeGreaterThan(0);
  });
});

describe('508d3acd · the card, once the data is right', () => {
  it('an ineligible employee with NO activity sees no card at all', async () => {
    const mtl = await leaveTypeWith(MATERNITY);
    const he = await hire('male', 'married');
    const rows = await leaveBalances(adminCtx(b), he, 'en');
    expect(rows.some((r) => r.leaveTypeId === mtl), 'no card, no placeholder, no 0.00').toBe(false);
  });

  it('…and the eligible employee does see it', async () => {
    const mtl = await leaveTypeWith(MATERNITY);
    const she = await hire('female', 'married');
    const rows = await leaveBalances(adminCtx(b), she, 'en');
    expect(rows.some((r) => r.leaveTypeId === mtl)).toBe(true);
  });

  /**
   * EDGE CASE 1, verbatim from the ticket: someone currently ineligible who already has activity keeps
   * the card so her history is not hidden. This already behaved correctly — the wrong credits were
   * exactly why the reported card would not go away — so it is pinned rather than built.
   */
  it('an ineligible employee WITH activity keeps the card, so history is never hidden', async () => {
    const mtl = await leaveTypeWith(MATERNITY);
    const he = await hire('male', 'married');
    await owner.db.insert(schema.leaveLedger).values({
      tenantId: b.tenantId,
      employmentId: he,
      leaveTypeId: mtl,
      entryType: 'accrual',
      days: '98.00',
      effectiveOn: '2026-09-20',
    });
    const rows = await leaveBalances(adminCtx(b), he, 'en');
    expect(rows.some((r) => r.leaveTypeId === mtl), 'the 98.00 must stay visible until it is reversed').toBe(true);
  });

  /** The reporter's explicit exclusion: minimum service must NOT hide a card. */
  it('minimum service does not hide a card, however new the joiner', async () => {
    const annual = await leaveTypeWith({ minServiceMonths: 12, minServiceUnit: 'months' });
    const fresh = await hire('male', 'single', '2026-09-01');
    const rows = await leaveBalances(adminCtx(b), fresh, 'en');
    expect(rows.some((r) => r.leaveTypeId === annual), 'a timing rule is not a reason to hide the card').toBe(true);
  });
});
