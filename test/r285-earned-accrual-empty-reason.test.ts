/**
 * feedback cf9dcb98 (r285) — WHY THE EARNED-ACCRUAL PREVIEW CAME BACK EMPTY, NAMED BY THE ENGINE.
 *
 * ⚠️ THE REPORTED FAULT WAS NOT A FAULT, AND THE PLAN'S DIAGNOSIS OF IT WAS STILL WRONG. HR ran Run Earned
 * Accrual for Annual Leave and got "No earned-accrual entitlement to generate for this scope." The
 * approved plan said the type they could pick, `AL` "*Annual Leave", produced nothing because its two
 * entitlement tables only came into force on 14 and 15 September. Measured on production on 2026-09-15:
 * both tables ARE in force at that date, and the two eligibility rules behind them reach SIX employments
 * (4 + 2). So the plan's reason was not the reason.
 *
 * THE REAL ONE is `accrueEarnedLeave`'s very first filter, `code IN STANDING_LEAVE_CODES`
 * ('ANNUAL', 'SICK', 'HOSPITALIZATION'). `AL` is not one of them, so the sweep returns before it reads an
 * employment — whatever tables, rules or accrual method that type carries. The picker, meanwhile, offers
 * EVERY active leave type. That is the defect this file pins: not the gate, which is deliberate (see the
 * ADR-0066 note on the constant), but a screen that offers a choice the engine can never act on and then
 * declines to say so. §A is that case, and it reproduces the production account exactly.
 *
 * WHAT ELSE IS PINNED: one case per exit in `accrueEarnedLeave`, because the single flat sentence
 * described all of them identically and each wants a different action from the administrator. Every case
 * carries a POSITIVE CONTROL in the same test — the same fixture with the one condition released, which
 * must then preview something. Without it a reason test passes just as well against an engine that
 * returns nothing no matter what, which is the exact failure mode a reason string is supposed to end.
 *
 * AND THE FIGURES DO NOT MOVE: §J re-asserts the shipped dry-run/commit equality over a fixture that
 * carries all of the above, so a reason added to the result type cannot quietly become an arithmetic edit.
 */
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { accrueEarnedLeave, normaliseLeaveTypeName } from '../core/leave';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, seedEntitlement, type Base } from './harness';

let b: Base;

// Dates derive from the clock, never hardcoded: an assertion pinned to a literal year silently stops
// meaning anything the moment the calendar passes it.
const YEAR = Number(todayInKualaLumpur().slice(0, 4));
const JAN = `${YEAR}-01-01`;
const MID = `${YEAR}-06-15`;
const LAST_YEAR_END = `${YEAR - 1}-12-31`;

const run = (p: Parameters<typeof accrueEarnedLeave>[1]) => accrueEarnedLeave(adminCtx(b), p);

const mkGrade = async (code: string, name: string, rank: number) => {
  const [g] = await owner.db
    .insert(schema.jobGrade)
    .values({ tenantId: b.tenantId, code, name, rank })
    .returning({ id: schema.jobGrade.id });
  return g.id;
};

const mkType = async (code: string, name: string) => {
  const [lt] = await owner.db
    .insert(schema.leaveType)
    .values({ tenantId: b.tenantId, code, name, paid: true, allowNegativeBalance: true })
    .returning({ id: schema.leaveType.id });
  return lt.id;
};

const setEarned = (leaveTypeId: string, method: string | null = 'earned_monthly') =>
  owner.db
    .update(schema.leaveType)
    .set({ accrualMethod: method as never })
    .where(eq(schema.leaveType.id, leaveTypeId));

const archiveType = (leaveTypeId: string) =>
  owner.db
    .update(schema.leaveType)
    .set({ archivedAt: new Date() })
    .where(eq(schema.leaveType.id, leaveTypeId));

/** A fully configured earned type: template + eligibility rule (optionally narrowed to one grade). */
const configure = (leaveTypeId: string, p: { gradeId?: string | null; validFrom?: string; days?: number } = {}) =>
  seedEntitlement(adminCtx(b), {
    leaveTypeId,
    annualDays: p.days ?? 12,
    gradeId: p.gradeId ?? null,
    validFrom: p.validFrom ?? JAN,
  });

const hire = (gradeId: string | null = null) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: 'Acc', primaryEmail: `acc_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: JAN,
    gradeId,
    grantLeaveTypes: [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }],
  });

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

describe('§A the production case — a leave type the earned sweep does not cover', () => {
  it('names the type AND the types that ARE covered, and does not blame its configuration', async () => {
    // The production shape, reproduced: an ACTIVE custom type that looks in every way like an accruing
    // Annual Leave — earned method, a table in force, a rule that reaches the employee — beside an
    // ARCHIVED 'ANNUAL' whose name it nearly shares.
    const al = await mkType('AL', '*Annual Leave');
    await setEarned(al);
    await configure(al);
    await hire();
    await setEarned(b.annualLeaveTypeId);
    await archiveType(b.annualLeaveTypeId);

    const res = await run({ asOf: MID, leaveTypeIds: [al], dryRun: true });

    expect(res.breakdown).toHaveLength(0);
    expect(res.emptyReason?.kind).toBe('type_not_swept');
    // NAMES THE THING — the type declined, and the types that are not.
    const reason = res.emptyReason as Extract<typeof res.emptyReason, { kind: 'type_not_swept' }>;
    expect(reason.leaveTypeNames).toEqual(['*Annual Leave']);
    expect(reason.sweptLeaveTypeNames).not.toContain('*Annual Leave');
    // reason (d): the archived near-twin is named beside it, because on this account both are true at once.
    expect(res.archivedHint.map((a) => a.name)).toEqual(['Annual Leave']);

    // POSITIVE CONTROL — the identical configuration on a type the sweep DOES cover previews rows. Without
    // this the assertions above hold just as well against an engine that can never produce anything.
    const annual = await mkType('SICK', 'Medical Leave');
    await setEarned(annual);
    await configure(annual);
    const ok = await run({ asOf: MID, leaveTypeIds: [annual], dryRun: true });
    expect(ok.breakdown.length).toBeGreaterThan(0);
    expect(ok.emptyReason).toBeNull();
  });

  it('an archived type asked for by id says ARCHIVED, not "not covered"', async () => {
    await setEarned(b.annualLeaveTypeId);
    await configure(b.annualLeaveTypeId);
    await hire();
    const before = await run({ asOf: MID, leaveTypeIds: [b.annualLeaveTypeId], dryRun: true });
    expect(before.breakdown.length).toBeGreaterThan(0); // positive control, before the one change

    await archiveType(b.annualLeaveTypeId);
    const res = await run({ asOf: MID, leaveTypeIds: [b.annualLeaveTypeId], dryRun: true });
    expect(res.emptyReason).toEqual({ kind: 'type_archived', leaveTypeNames: ['Annual Leave'] });
  });
});

describe('§B the entitlement table is not in force yet — the date is the answer', () => {
  it('names the table start date and the as-at date it is being asked about', async () => {
    await setEarned(b.annualLeaveTypeId);
    await configure(b.annualLeaveTypeId, { validFrom: JAN });
    await hire();

    // Ask for LAST leave year: the table exists and starts after the date this run is calculated at.
    const res = await run({ asOf: LAST_YEAR_END, leaveTypeIds: [b.annualLeaveTypeId], dryRun: true });
    expect(res.emptyReason).toEqual({
      kind: 'table_not_yet_in_force',
      leaveTypeName: 'Annual Leave',
      validFrom: JAN,
      asOf: LAST_YEAR_END,
    });

    // POSITIVE CONTROL — the same fixture at a date the table covers previews rows.
    const ok = await run({ asOf: MID, leaveTypeIds: [b.annualLeaveTypeId], dryRun: true });
    expect(ok.breakdown.length).toBeGreaterThan(0);
  });

  it('with no table at any date it says NO TABLE, not a date it cannot name', async () => {
    await setEarned(b.annualLeaveTypeId);
    await hire();
    const res = await run({ asOf: MID, leaveTypeIds: [b.annualLeaveTypeId], dryRun: true });
    expect(res.emptyReason).toEqual({
      kind: 'no_entitlement_table',
      leaveTypeNames: ['Annual Leave'],
      asOf: MID,
    });

    // POSITIVE CONTROL — write the table and the same call previews rows.
    await configure(b.annualLeaveTypeId);
    expect((await run({ asOf: MID, leaveTypeIds: [b.annualLeaveTypeId], dryRun: true })).breakdown.length)
      .toBeGreaterThan(0);
  });
});

describe('§C a type that grants its days rather than earning them', () => {
  it('names the type instead of implying its configuration is missing', async () => {
    await configure(b.annualLeaveTypeId);
    await hire();
    await setEarned(b.annualLeaveTypeId, 'grant_on_hire_prorated');

    const res = await run({ asOf: MID, leaveTypeIds: [b.annualLeaveTypeId], dryRun: true });
    expect(res.emptyReason).toEqual({ kind: 'type_not_earned', leaveTypeNames: ['Annual Leave'] });

    // POSITIVE CONTROL — flip only the earning method.
    await setEarned(b.annualLeaveTypeId, 'earned_monthly');
    expect((await run({ asOf: MID, leaveTypeIds: [b.annualLeaveTypeId], dryRun: true })).breakdown.length)
      .toBeGreaterThan(0);
  });
});

describe('§D nobody in the scope was on the books', () => {
  it('names the grade that was asked for, not a count', async () => {
    await setEarned(b.annualLeaveTypeId);
    await configure(b.annualLeaveTypeId);
    const staffed = await mkGrade('A', 'Executive', 1);
    const empty = await mkGrade('B', 'Director', 2);
    await hire(staffed);

    const res = await run({ asOf: MID, gradeIds: [empty], dryRun: true });
    expect(res.emptyReason).toEqual({
      kind: 'no_employment_in_scope',
      asOf: MID,
      scopeNames: ['Director'],
    });

    // POSITIVE CONTROL — the SAME call against the grade that has somebody in it.
    expect((await run({ asOf: MID, gradeIds: [staffed], dryRun: true })).breakdown.length).toBeGreaterThan(0);
  });
});

describe('§E tables exist and no eligibility rule reaches anybody (r209s second zero)', () => {
  it('says the tables are there and nothing connects them, naming the type', async () => {
    await setEarned(b.annualLeaveTypeId);
    const reached = await mkGrade('A', 'Executive', 1);
    const unreached = await mkGrade('B', 'Director', 2);
    // Two tables, so the sole-table fallback stays out of the way, both narrowed to a grade nobody holds.
    await configure(b.annualLeaveTypeId, { gradeId: reached, validFrom: JAN });
    await configure(b.annualLeaveTypeId, { gradeId: reached, validFrom: `${YEAR}-01-02`, days: 14 });
    await hire(unreached);

    const res = await run({ asOf: MID, leaveTypeIds: [b.annualLeaveTypeId], dryRun: true });
    expect(res.emptyReason).toEqual({ kind: 'no_eligibility_match', leaveTypeNames: ['Annual Leave'] });

    // POSITIVE CONTROL — hire into the grade the rules DO reach and the same call previews rows.
    await hire(reached);
    expect((await run({ asOf: MID, leaveTypeIds: [b.annualLeaveTypeId], dryRun: true })).breakdown.length)
      .toBeGreaterThan(0);
  });
});

describe('§F every employment is in a country with no active pack', () => {
  it('names the country rather than reporting an empty scope', async () => {
    await setEarned(b.annualLeaveTypeId);
    await configure(b.annualLeaveTypeId);
    await hire();
    await owner.db
      .update(schema.company)
      .set({ country: 'ZZ' })
      .where(eq(schema.company.id, b.companyId));

    const res = await run({ asOf: MID, leaveTypeIds: [b.annualLeaveTypeId], dryRun: true });
    expect(res.emptyReason).toEqual({ kind: 'country_pack_inactive', countries: ['ZZ'] });
    expect(res.packBlocked).toHaveLength(1);

    // POSITIVE CONTROL — put the company back in a jurisdiction that has a pack.
    await owner.db.update(schema.company).set({ country: 'MY' }).where(eq(schema.company.id, b.companyId));
    expect((await run({ asOf: MID, leaveTypeIds: [b.annualLeaveTypeId], dryRun: true })).breakdown.length)
      .toBeGreaterThan(0);
  });
});

describe('§G every balance is frozen for encashment (ADR-0069)', () => {
  it('says the balances are frozen instead of blaming the configuration', async () => {
    await setEarned(b.annualLeaveTypeId);
    await configure(b.annualLeaveTypeId);
    const emp = await hire();
    expect((await run({ asOf: MID, leaveTypeIds: [b.annualLeaveTypeId], dryRun: true })).breakdown.length)
      .toBeGreaterThan(0); // positive control, before the freeze

    const [p] = await owner.db
      .select({ personId: schema.employment.personId })
      .from(schema.employment)
      .where(eq(schema.employment.id, emp.employmentId));
    const [req] = await owner.db
      .insert(schema.resignationRequest)
      .values({
        tenantId: b.tenantId,
        employmentId: emp.employmentId,
        personId: p.personId,
        lastWorkingDay: `${YEAR}-12-31`,
        status: 'accepted',
      })
      .returning({ id: schema.resignationRequest.id });
    await owner.db.insert(schema.leaveEncashmentSnapshot).values({
      tenantId: b.tenantId,
      employmentId: emp.employmentId,
      resignationRequestId: req.id,
      leaveTypeId: b.annualLeaveTypeId,
      balanceDays: '5.00',
      encashableDays: '5.00',
      calculatedAsOf: MID,
      status: 'frozen',
    });

    const res = await run({ asOf: MID, leaveTypeIds: [b.annualLeaveTypeId], dryRun: true });
    expect(res.emptyReason).toEqual({ kind: 'balance_frozen', leaveTypeNames: ['Annual Leave'] });
  });
});

describe('§H the archived near-twin is a NAME match, not an equality match', () => {
  it('connects "*Annual Leave" to an archived "Annual Leave"', () => {
    // The production pair. Equality would miss it, and missing it is what cost the reporter a day.
    expect(normaliseLeaveTypeName('*Annual Leave')).toBe(normaliseLeaveTypeName('Annual Leave'));
    expect(normaliseLeaveTypeName(' annual  leave ')).toBe(normaliseLeaveTypeName('Annual-Leave'));
    // Non-Latin names survive normalisation rather than collapsing to the empty string, which would make
    // every Chinese or Tamil type name collide with every other one.
    expect(normaliseLeaveTypeName('年假')).toBe('年假');
    expect(normaliseLeaveTypeName('年假')).not.toBe(normaliseLeaveTypeName('病假'));
    // A name made only of punctuation normalises to empty and must never match anything.
    expect(normaliseLeaveTypeName('***')).toBe('');
  });

  it('a scope with no type picked still names an archived STANDING earned type', async () => {
    // HR leaves the type picker on "all". The sweep finds nothing because the only earned standing type
    // is archived — which is invisible on every screen unless this says so.
    await setEarned(b.annualLeaveTypeId);
    await configure(b.annualLeaveTypeId);
    await hire();
    await archiveType(b.annualLeaveTypeId);

    const res = await run({ asOf: MID, dryRun: true });
    expect(res.breakdown).toHaveLength(0);
    expect(res.archivedHint.map((a) => a.code)).toEqual(['ANNUAL']);
  });
});

describe('§I reason (c) — already posted is NOT an empty preview', () => {
  it('a re-run returns FULL rows reading 0.00, and earnedToDateTotal is what tells it apart', async () => {
    await setEarned(b.annualLeaveTypeId);
    await configure(b.annualLeaveTypeId);
    await hire();

    const first = await run({ asOf: MID, leaveTypeIds: [b.annualLeaveTypeId] });
    expect(first.granted).toBe(1);
    expect(first.earnedToDateTotal).toBeGreaterThan(0);

    const second = await run({ asOf: MID, leaveTypeIds: [b.annualLeaveTypeId], dryRun: true });
    // ⚠️ THE PLAN CALLED THIS AN EMPTY-PREVIEW REASON AND IT IS NOT ONE. The engine counts an eligible
    // employee into their group BEFORE working out the top-up, so an accrual already posted comes back as
    // a full table of zeroes — never through `emptyReason` at all.
    expect(second.breakdown.length).toBeGreaterThan(0);
    expect(second.emptyReason).toBeNull();
    expect(second.breakdown.reduce((s, g) => s + g.entitlementGenerated, 0)).toBe(0);
    expect(second.earnedToDateTotal).toBe(first.earnedToDateTotal);

    // And the OTHER zero, which the screen must not call "already posted": a type whose table says zero
    // days. Same grid of zeroes, opposite action — HR has to go and put days in the table, not stop
    // worrying. Nothing has been EARNED, so the Σ is 0 and the two states separate on the engine's figure.
    const sick = await mkType('SICK', 'Medical Leave');
    await setEarned(sick);
    await configure(sick, { days: 0 });
    const nothingEarned = await run({ asOf: MID, leaveTypeIds: [sick], dryRun: true });
    expect(nothingEarned.breakdown.length).toBeGreaterThan(0);
    expect(nothingEarned.breakdown.reduce((s, g) => s + g.entitlementGenerated, 0)).toBe(0);
    expect(nothingEarned.earnedToDateTotal).toBe(0);
  });
});

describe('§J the figures did not move', () => {
  it('dry-run still equals the commit, and a preview still writes nothing', async () => {
    await setEarned(b.annualLeaveTypeId);
    await configure(b.annualLeaveTypeId);
    const gradeA = await mkGrade('A', 'Executive', 1);
    await hire(gradeA);
    await hire(null);

    const preview = await run({ asOf: MID, dryRun: true });
    const [{ n }] = await owner.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.leaveLedger)
      .where(eq(schema.leaveLedger.tenantId, b.tenantId));
    expect(n).toBe(0);

    const commit = await run({ asOf: MID });
    const norm = (rows: typeof preview.breakdown) =>
      rows
        .map((g) => `${g.companyId}|${g.gradeId ?? ''}|${g.leaveTypeId}|${g.employeeCount}|${g.entitlementGenerated}`)
        .sort();
    expect(norm(commit.breakdown)).toEqual(norm(preview.breakdown));
    expect(commit.granted).toBe(preview.granted);
    expect(commit.forfeits).toBe(preview.forfeits);
    expect(commit.earnedToDateTotal).toBe(preview.earnedToDateTotal);
  });
});
