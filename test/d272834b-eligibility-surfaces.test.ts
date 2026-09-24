/**
 * d272834b — ONE ELIGIBILITY RULE, ON EVERY SURFACE THAT DRAWS A LEAVE TYPE.
 *
 * ⚠️ THE REPORTED FAULT, AND WHY 508d3acd DID NOT ALREADY FIX IT. EMP-0002 (Daniel Tan, male, married —
 * there are TWO Daniel Tans on that account, EMP-0002 and EMP-0005, so the CODE is the identifier and the
 * name is not) still sees a Maternity Leave card reading Entitlement 98.00 while the same screen tells him
 * he can apply for 0.00 of it. 508d3acd gated the year-open grant and the balance read's NO-ACTIVITY tail;
 * it never gated a row that came from the LEDGER, and his record holds both a pre-508d3acd 98-day accrual
 * and the corrective adjustment that took it back. `core/my-leave.ts` `myLeaveDashboard` contained no
 * reference to eligibility of any kind — it took `leaveBalances` and filtered on `placement` alone.
 *
 * TWO CHANGES, AND THE SECOND IS THE ONE TO UNDERSTAND BEFORE EDITING ANYTHING HERE.
 *
 *  1. THE CARD ASKS THE SAME GATE THE DROPDOWN ALWAYS DID. `leaveBalances` gains `includeIneligible`
 *     (default: gated) and runs `isProfileEligible` over EVERY row at the same choke point as its
 *     visibility and archived gates. The dashboard writes no second copy of the check — it consumes the
 *     gated list, so a card and a dropdown entry can no longer disagree about whose leave a type is.
 *
 *  2. A LIST OF EVERY OPTION THE PICKER OFFERS IS NO RESTRICTION (`eligibilityRuleList`, core/leave.ts).
 *     `ELIGIBILITY_GENDER_OPTIONS` is exactly ['male','female'], so a stored `["male","female"]` is how an
 *     administrator says "anybody" — and EIGHT of the eleven live leave types on the reporting account
 *     store precisely that. Read literally it is a restriction, which is why 55 of their 75 active
 *     employees (no gender recorded) were losing all eight types from the gated reads, and why
 *     `UnknownAttributePolicy` was such a dangerous dial: the production dry run recorded in that type's
 *     header would have taken real Annual Leave off 33 people under 'exclude'. Normalising the list to
 *     absent means the policy is never consulted for it, under EITHER value.
 *
 * ⚠️ NOT EVERY LIST IS ALL-INCLUSIVE. `ANNUAL` lists all six marital values (no restriction); `CGL` and
 * `NDL` list five, omitting 'other', and those ARE genuine restrictions. Case (e) pins both directions.
 *
 * WHAT IS DELIBERATELY NOT HERE. The 5,390 days of Maternity Leave standing on 55 employments are NOT
 * reversed by this round — the approved plan promises they are not touched until the reporter says so.
 * They are LISTED, by `scripts/report-ineligible-leave-balances.ts`, and they stay visible to HR through
 * `includeIneligible: true` (pinned in test/508d3acd-ineligible-grants.test.ts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import {
  adminCtx,
  closeAll,
  createAppUser,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  seedEntitlement,
  type Base,
} from './harness';
import { hireEmployee } from '../core/org';
import { openLeaveYear, eligibilityRuleList, ELIGIBILITY_GENDERS, ELIGIBILITY_MARITALS } from '../core/leave';
import { leaveBalances, listEligibleLeaveTypesFor } from '../core/read';
import { myLeaveDashboard } from '../core/my-leave';
import { todayInKualaLumpur } from '../lib/hr-date';

let b: Base;
const TODAY = todayInKualaLumpur();
const YEAR = Number(TODAY.slice(0, 4));

/** The reporter's own rule, verbatim: Maternity Leave is Gender = Female. */
const MATERNITY = { gender: ['female'] };
/** The shape EIGHT of the eleven live types store — every option the picker offers, i.e. no restriction. */
const EVERY_GENDER = { gender: [...ELIGIBILITY_GENDERS] };

async function leaveTypeWith(eligibility: unknown, name = 'Fixture Leave') {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      tenantId: b.tenantId,
      code: `D272_${randomUUID().slice(0, 8).toUpperCase().replace(/-/g, '')}`,
      name,
      paid: true,
      counting: 'calendar_days',
      visibleToEmployee: true,
      employeeCanApply: true,
      eligibility: eligibility as never,
    })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

/** An employee WITH their own session context — every surface below is read as the employee, through RLS,
 *  never as an admin, because "what does this person see" is the whole question. */
async function hire(gender: string | null, marital: string | null, hiredOn = '2020-01-01') {
  const e = await hireEmployee(adminCtx(b), {
    person: { fullName: 'Fixture Person', primaryEmail: `d272_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn,
  });
  await owner.db
    .update(schema.person)
    .set({ gender, maritalStatus: marital })
    .where(eq(schema.person.id, e.personId));
  const ctx: SessionContext = {
    tenantId: b.tenantId,
    userId: await createAppUser(b.tenantId, e.personId, 'employee'),
    personId: e.personId,
    roles: ['employee'],
  };
  return { employmentId: e.employmentId, ctx };
}

const ledger = (
  employmentId: string,
  leaveTypeId: string,
  entryType: 'accrual' | 'adjustment',
  days: number,
  effectiveOn: string,
) =>
  owner.db.insert(schema.leaveLedger).values({
    tenantId: b.tenantId,
    employmentId,
    leaveTypeId,
    entryType,
    days: days.toFixed(2),
    effectiveOn,
  });

/** THE REPORTED RECORD, reproduced exactly: a 98-day accrual and the adjustment that reversed it, so the
 *  card reads Entitlement 98.00 / Balance 0.00 — a net of zero is still two ledger rows, and two ledger
 *  rows are still activity, which is precisely why 508d3acd's tail gate could not fire. */
async function reportedMaternityHistory(employmentId: string, mtl: string) {
  await ledger(employmentId, mtl, 'accrual', 98, `${YEAR}-01-01`);
  await ledger(employmentId, mtl, 'adjustment', -98, `${YEAR}-01-02`);
}

/** THE FOUR SURFACES, read for one employee, in one place. Every case below asserts on all four, because
 *  the reported defect was exactly that three of them agreed and one did not. */
async function surfaces(who: { employmentId: string; ctx: SessionContext }, leaveTypeId: string) {
  const dash = await myLeaveDashboard(who.ctx, who.employmentId, { today: TODAY, locale: 'en' });
  const dropdown = await listEligibleLeaveTypesFor(who.ctx, who.employmentId, 'en');
  const rows = await leaveBalances(who.ctx, who.employmentId, 'en', { includeArchived: false });
  const accruals = await owner.db
    .select({ days: schema.leaveLedger.days, entryType: schema.leaveLedger.entryType })
    .from(schema.leaveLedger)
    .where(eq(schema.leaveLedger.employmentId, who.employmentId));
  return {
    card: dash.cards.some((c) => c.leaveTypeId === leaveTypeId),
    years: dash.years,
    dropdown: dropdown.some((t) => t.id === leaveTypeId),
    balanceRow: rows.some((r) => r.leaveTypeId === leaveTypeId),
    entitlement: accruals
      .filter((r) => r.entryType === 'accrual')
      .reduce((n, r) => n + Number(r.days), 0),
  };
}

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

describe('d272834b · the rule itself — a list of every picker option restricts nobody', () => {
  it('normalises an all-inclusive gender list to absent, and leaves a partial one alone', () => {
    expect(eligibilityRuleList(['male', 'female'], ELIGIBILITY_GENDERS)).toEqual([]);
    expect(eligibilityRuleList(['female', 'male'], ELIGIBILITY_GENDERS), 'order is not a meaning').toEqual([]);
    expect(eligibilityRuleList(['female'], ELIGIBILITY_GENDERS)).toEqual(['female']);
    expect(eligibilityRuleList('female', ELIGIBILITY_GENDERS), 'a legacy scalar row reads the same').toEqual(['female']);
  });

  /**
   * ⚠️ THE COMPARISON IS AGAINST THE PICKER, NOT THE VOCABULARY, and this is the assertion that stops the
   * next reader "fixing" it. `GENDERS` has THREE values — 'undisclosed' is a real, choosable value on an
   * employee RECORD — but no statute writes a leave rule for it, so the picker has always offered two.
   * Compare against `GENDERS` instead and all eight of those live types become restrictions again.
   * Production holds ZERO people with gender 'undisclosed', so the distinction changes no figure today;
   * it decides whether 55 of 75 employees keep eight leave types.
   */
  it('measures "every option" against the PICKER (two values), not the vocabulary (three)', async () => {
    const { GENDERS } = await import('../lib/person-vocabulary');
    expect([...GENDERS]).toEqual(['male', 'female', 'undisclosed']);
    expect([...ELIGIBILITY_GENDERS]).toEqual(['male', 'female']);
    expect(eligibilityRuleList(['male', 'female'], GENDERS), 'against the vocabulary it would still restrict').toEqual([
      'male',
      'female',
    ]);
    expect(eligibilityRuleList(['male', 'female'], ELIGIBILITY_GENDERS), 'against the picker it does not').toEqual([]);
  });

  it('carries no picker for the org-assignment criteria, whose catalogue is open-ended', () => {
    // A list of every ACTIVE division today is not a statement that the rule is open to a division
    // created tomorrow, so "every option offered" is not a fact this module can know for those axes.
    expect(eligibilityRuleList(['HQ', 'Branch'])).toEqual(['HQ', 'Branch']);
  });
});

describe('d272834b · (a) a male employee gets no Maternity Leave on any surface', () => {
  it('no card, no dropdown entry, no balance row — with the reported ledger history present', async () => {
    const mtl = await leaveTypeWith(MATERNITY, 'Maternity Leave');
    const he = await hire('male', 'married');
    await reportedMaternityHistory(he.employmentId, mtl);

    const s = await surfaces(he, mtl);
    expect(s.card, 'the reported card: Entitlement 98.00 on a male employment').toBe(false);
    expect(s.dropdown, 'the dropdown already agreed, and must keep agreeing').toBe(false);
    expect(s.balanceRow, 'the row the card is built from').toBe(false);
  });

  it('and the year-open grants him nothing, so no new 98 days are created', async () => {
    const mtl = await leaveTypeWith(MATERNITY, 'Maternity Leave');
    const he = await hire('male', 'married');
    await seedEntitlement(adminCtx(b), { leaveTypeId: mtl, annualDays: 98, validFrom: `${YEAR}-01-01` });
    await openLeaveYear(adminCtx(b), { year: YEAR, leaveTypeIds: [mtl] });
    expect((await surfaces(he, mtl)).entitlement, 'no entitlement for an ineligible employee').toBe(0);
  });

  /**
   * THE YEAR SELECTOR. A hidden card must not leave its history behind in the control above it: the only
   * ledger rows this employee has are the Maternity ones, and the selector is built from the cycles of the
   * types that DREW A CARD. Offering last year here would be the same leak in a smaller control.
   */
  it('and the year selector offers no year that only the hidden card could justify', async () => {
    const mtl = await leaveTypeWith(MATERNITY, 'Maternity Leave');
    const he = await hire('male', 'married');
    await ledger(he.employmentId, mtl, 'accrual', 98, `${YEAR - 1}-01-01`);

    const s = await surfaces(he, mtl);
    expect(s.years).toContain(YEAR);
    expect(s.years, 'last year was only reachable through a card he must not have').not.toContain(YEAR - 1);
  });
});

describe('d272834b · (b) an eligible employee is untouched on all four surfaces', () => {
  it('a female married employee keeps card, dropdown, balance row and entitlement', async () => {
    const mtl = await leaveTypeWith(MATERNITY, 'Maternity Leave');
    const she = await hire('female', 'married');
    await seedEntitlement(adminCtx(b), { leaveTypeId: mtl, annualDays: 98, validFrom: `${YEAR}-01-01` });
    await openLeaveYear(adminCtx(b), { year: YEAR, leaveTypeIds: [mtl] });

    const s = await surfaces(she, mtl);
    expect(s.card, 'the card the reporter is NOT asking to remove').toBe(true);
    expect(s.dropdown).toBe(true);
    expect(s.balanceRow).toBe(true);
    expect(s.entitlement, 'her 98 days are hers').toBe(98);
  });
});

describe('d272834b · (c) a blank gender keeps every all-genders type — the incident guard', () => {
  /**
   * ⚠️ THIS IS THE REGRESSION GUARD FOR THE DOCUMENTED PRODUCTION INCIDENT, and it fails on `main` as this
   * item was picked up: the READ gates pass 'exclude', so before `eligibilityRuleList` an employee with no
   * gender recorded matched neither entry of `["male","female"]` and lost all eight such types from their
   * cards and their dropdown. That is 55 of 75 active employments on the reporting account.
   *
   * It is also what makes `UnknownAttributePolicy` safe to leave alone: the policy is not consulted for a
   * field carrying no restriction, so this stays green under BOTH 'allow' and 'exclude'. Revert the
   * normalisation and it goes red — which is the point.
   */
  it('card, dropdown and balance row all survive a blank gender on an all-genders type', async () => {
    const openToAll = await leaveTypeWith(EVERY_GENDER, 'Wellness Leave');
    const unplaced = await hire(null, null);
    await ledger(unplaced.employmentId, openToAll, 'accrual', 14, `${YEAR}-01-01`);

    const s = await surfaces(unplaced, openToAll);
    expect(s.card, 'a rule nobody wrote must not remove a card').toBe(true);
    expect(s.dropdown, 'nor a dropdown entry').toBe(true);
    expect(s.balanceRow).toBe(true);
  });

  it('and the year-open still grants it — the 33-people arm of the same incident', async () => {
    const openToAll = await leaveTypeWith(EVERY_GENDER, 'Annual Leave');
    const unplaced = await hire(null, null);
    await seedEntitlement(adminCtx(b), { leaveTypeId: openToAll, annualDays: 14, validFrom: `${YEAR}-01-01` });
    await openLeaveYear(adminCtx(b), { year: YEAR, leaveTypeIds: [openToAll] });
    expect((await surfaces(unplaced, openToAll)).entitlement, 'a blank field must never withhold days').toBe(14);
  });
});

describe('d272834b · (d) a blank gender gets no Maternity Leave', () => {
  /**
   * The other half of (c), and the reason the two must be asserted together: the fix must remove the
   * FALSE restrictions without softening the real one. Maternity lists ONE gender, so it stays a
   * restriction and 'exclude' — the policy every read gate passes — still refuses an unrecorded attribute
   * against it.
   */
  it('no card, no dropdown entry, no balance row, even with the reported ledger history', async () => {
    const mtl = await leaveTypeWith(MATERNITY, 'Maternity Leave');
    const unplaced = await hire(null, 'married');
    await reportedMaternityHistory(unplaced.employmentId, mtl);

    const s = await surfaces(unplaced, mtl);
    expect(s.card, 'this is 55 of the 75 employments, holding 5,390 days between them').toBe(false);
    expect(s.dropdown).toBe(false);
    expect(s.balanceRow).toBe(false);
  });
});

describe('d272834b · (e) marital status reads the same rule, and a five-value list still restricts', () => {
  it('a list of all six marital values restricts nobody — not even an unrecorded status', async () => {
    expect(eligibilityRuleList([...ELIGIBILITY_MARITALS], ELIGIBILITY_MARITALS)).toEqual([]);
    const annualShaped = await leaveTypeWith({ maritalStatus: [...ELIGIBILITY_MARITALS] }, 'Annual Leave');
    const unplaced = await hire('male', null);
    await ledger(unplaced.employmentId, annualShaped, 'accrual', 14, `${YEAR}-01-01`);

    const s = await surfaces(unplaced, annualShaped);
    expect(s.card).toBe(true);
    expect(s.dropdown).toBe(true);
  });

  it("CGL's five-value list omits 'other' and therefore still excludes it", async () => {
    const five = ['single', 'married', 'divorced', 'widowed', 'separated'];
    expect(eligibilityRuleList(five, ELIGIBILITY_MARITALS), 'five of six is a real restriction').toEqual(five);
    const cgl = await leaveTypeWith({ maritalStatus: five }, 'Compassionate Leave');
    const other = await hire('male', 'other');
    const married = await hire('male', 'married');
    await ledger(other.employmentId, cgl, 'accrual', 3, `${YEAR}-01-01`);
    await ledger(married.employmentId, cgl, 'accrual', 3, `${YEAR}-01-01`);

    const excluded = await surfaces(other, cgl);
    expect(excluded.card, "'other' is outside the configured list").toBe(false);
    expect(excluded.dropdown).toBe(false);
    const included = await surfaces(married, cgl);
    expect(included.card, 'and the same rule leaves a married employee alone').toBe(true);
    expect(included.dropdown).toBe(true);
  });
});

describe('d272834b · timing rules are still not identity rules', () => {
  /**
   * The reporter's explicit exclusion from 508d3acd, re-pinned because this item moved the gate onto every
   * row and the easy mistake is to reach for `isLeaveEligible` — which would have started hiding cards for
   * minimum service and probation, i.e. telling a new joiner they have no Annual Leave.
   */
  it('minimum service hides no card, however new the joiner, and still refuses the application', async () => {
    const annual = await leaveTypeWith({ minServiceMonths: 12, minServiceUnit: 'months' }, 'Annual Leave');
    const fresh = await hire('male', 'single', TODAY);
    await ledger(fresh.employmentId, annual, 'accrual', 14, `${YEAR}-01-01`);

    const s = await surfaces(fresh, annual);
    expect(s.card, 'a timing rule is not a reason to hide the card').toBe(true);
    expect(s.balanceRow).toBe(true);
    expect(s.dropdown, 'but the apply gate still counts it — that is the split').toBe(false);
  });
});
