/**
 * 73ddd5a1 (r338) — A BLANK PROFILE FIELD NO LONGER EARNS AN ENTITLEMENT AT THE GRANT PATH.
 *
 * THE REPORTER'S DECISION, VERBATIM, reaffirmed after being challenged on it:
 *
 *   "If the required information is blank or missing, no leave entitlement should be granted. The
 *    entitlement should only be applied once the relevant employee information has been updated in the
 *    system."
 *
 * So `openLeaveYear` passes `isProfileEligible(..., 'exclude')` where it passed `'allow'`. One argument.
 * `UnknownAttributePolicy` still has no default — a caller that has not thought about it cannot compile.
 *
 * ⚠️ READ THIS BEFORE CHANGING ANYTHING IN HERE. `'exclude'` on the grant path was CATASTROPHIC before
 * d272834b: eight of eleven live leave types stored `["male","female"]`, read literally that is a
 * restriction, and a production dry run showed it taking real Annual Leave off 33 people because their
 * gender is blank. What makes the flip safe is not a change of mind about that incident — it is
 * `eligibilityRuleList`, which normalises a list holding EVERY picker option to the empty list, so the
 * `unknown` policy is never consulted for such a field under EITHER value. Case (c) below is the
 * regression guard for that incident and it must never be weakened or deleted.
 *
 * MEASURED ON PRODUCTION 2026-09-25 — `select code, eligibility from leave_type where archived_at is null`.
 * Only FOUR live types carry a rule that survives normalisation, and the fixtures below are those four
 * shapes plus the shapes that do not:
 *
 *   MTL  {"gender":["female"],"maritalStatus":["married"]}                      genuine, both fields
 *   PTL  {"gender":["male"],"maritalStatus":["married"],minService 12 months}   genuine, both fields
 *   MRL  {"maritalStatus":["single"]}                                           genuine, marital only
 *   CGL  {"gender":[all],"maritalStatus":[five of six, 'other' omitted]}        genuine, marital only
 *   CPL / EXM / GD / STD   both lists hold every picker option                  NO restriction
 *   AL / EL / MC / HOSPITALIZATION / REPLACEMENT / SP / UPL / NDL   eligibility IS NULL   NO restriction
 *
 * ⚠️ NDL — THE APPROVED PLAN IS WRONG ABOUT IT, AND SO IS r334's NOTE. Both say a blank marital status
 * would cost "Caregiver AND Natural Disaster Leave". `NDL` has `eligibility IS NULL` on production today,
 * so it never reaches the predicate at all (`if (!elig) return true`). The cost is `CGL` only. Pinned as
 * its own case below rather than left as prose, because prose is what was wrong.
 *
 * ⚠️ WHAT THIS ROUND DELIBERATELY DOES NOT DO. Nothing is clawed back. The reporter's words are
 * forward-looking ("should only be applied once the information has been updated") and reversing existing
 * balances is their own separate trigger: "we will not do that until you say so — those are balances on
 * real employees' records and we are not deleting them on a guess." Case (e) asserts that every existing
 * ledger row survives a grant run byte-for-byte.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { and, asc, eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, seedEntitlement, type Base } from './harness';
import { hireEmployee } from '../core/org';
import {
  ELIGIBILITY_GENDERS,
  ELIGIBILITY_MARITALS,
  isProfileEligible,
  openLeaveYear,
  type LeaveEligibility,
} from '../core/leave';
import { leaveBalances } from '../core/read';
import { todayInKualaLumpur } from '../lib/hr-date';

let b: Base;
const YEAR = Number(todayInKualaLumpur().slice(0, 4));
const JAN = `${YEAR}-01-01`;
/** Every fixture employee is long-tenured, so no TIMING rule can be mistaken for an identity verdict. */
const LONG_AGO = '2020-01-01';

/**
 * ⚠️ THE UNIVERSAL LISTS ARE DERIVED FROM THE PICKER CONSTANTS, NEVER TYPED OUT. `ELIGIBILITY_GENDERS` is
 * ['male','female'] and `ELIGIBILITY_MARITALS` is the six marital values; spelling either list literally
 * here would let the fixture and the rule drift apart, and a fixture that stopped being all-inclusive would
 * turn case (c) green for the wrong reason — which is the exact failure mode of the recorded incident.
 */
const EVERY_GENDER = [...ELIGIBILITY_GENDERS];
const EVERY_MARITAL = [...ELIGIBILITY_MARITALS];
/** CGL's real shape: five of six marital values, omitting 'other'. A GENUINE restriction. */
const FIVE_OF_SIX_MARITAL = EVERY_MARITAL.filter((m) => m !== 'other');

/** The production rule shapes, by the code they are configured under on the reporting account. */
const RULES = {
  MTL: { gender: ['female'], maritalStatus: ['married'] },
  PTL: { gender: ['male'], maritalStatus: ['married'], minServiceMonths: 12, minServiceUnit: 'months' },
  MRL: { maritalStatus: ['single'] },
  CGL: { gender: EVERY_GENDER, maritalStatus: FIVE_OF_SIX_MARITAL },
  CPL: { gender: EVERY_GENDER, maritalStatus: EVERY_MARITAL },
  EXM: { gender: EVERY_GENDER, maritalStatus: EVERY_MARITAL },
  GD: { gender: EVERY_GENDER, maritalStatus: EVERY_MARITAL },
  STD: { gender: EVERY_GENDER, maritalStatus: EVERY_MARITAL },
  AL: null,
  MC: null,
  NDL: null,
} as const;
type Code = keyof typeof RULES;
const CODES = Object.keys(RULES) as Code[];
/** The four the measurement says genuinely restrict — everything else must be untouched by this round. */
const GENUINELY_RESTRICTING: Code[] = ['MTL', 'PTL', 'MRL', 'CGL'];
/** A list of every picker option on both fields: no restriction, and the incident's shape. */
const UNIVERSAL_LIST: Code[] = ['CPL', 'EXM', 'GD', 'STD'];
/** `eligibility IS NULL` on production: the predicate returns true before it looks at anything. */
const NO_RULE: Code[] = ['AL', 'MC', 'NDL'];

const DAYS = 14;

async function leaveTypeFor(code: Code) {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      tenantId: b.tenantId,
      // Unique per row: the fixture set is created inside one tenant and (tenant, country, lower(code))
      // is unique, so the real code goes in the NAME and the stored code is disambiguated.
      code: `R338_${code}_${randomUUID().slice(0, 8).toUpperCase().replace(/-/g, '')}`,
      name: code,
      paid: true,
      counting: 'calendar_days',
      visibleToEmployee: true,
      employeeCanApply: true,
      eligibility: RULES[code] as never,
    })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

/** All eleven fixture types, with an entitlement table so a granted pair posts a non-zero figure. */
async function allTypes(): Promise<Record<Code, string>> {
  const out = {} as Record<Code, string>;
  for (const code of CODES) {
    out[code] = await leaveTypeFor(code);
    await seedEntitlement(adminCtx(b), { leaveTypeId: out[code], annualDays: DAYS, validFrom: JAN });
  }
  return out;
}

async function hire(gender: string | null, marital: string | null) {
  const { employmentId, personId } = await hireEmployee(adminCtx(b), {
    person: { fullName: 'Fixture Person', primaryEmail: `r338_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: LONG_AGO,
  });
  await owner.db
    .update(schema.person)
    .set({ gender, maritalStatus: marital })
    .where(eq(schema.person.id, personId));
  return employmentId;
}

/**
 * Accrued days for one (employment, type) PAIR — the only thing "was it granted" can honestly mean.
 *
 * ⚠️ THE `leaveTypeId` PREDICATE IS LOAD-BEARING and the first draft of this file omitted it, copying a
 * helper from test/508d3acd-ineligible-grants.test.ts that is correct there because each of its cases
 * creates exactly ONE leave type. This file grants eleven at once, so a sum over the employment reported
 * 126 days for every pair and five assertions failed for a reason that had nothing to do with the gate.
 */
async function accrued(employmentId: string, leaveTypeId: string) {
  const rows = await owner.db
    .select({ days: schema.leaveLedger.days, entryType: schema.leaveLedger.entryType })
    .from(schema.leaveLedger)
    .where(and(eq(schema.leaveLedger.employmentId, employmentId), eq(schema.leaveLedger.leaveTypeId, leaveTypeId)));
  return rows
    .filter((r) => r.entryType === 'accrual' || r.entryType === 'in_lieu_accrual')
    .reduce((n, r) => n + Number(r.days), 0);
}

/** Every ledger row in the tenant, ordered, as a comparable snapshot. ORDER BY id — never a position. */
async function ledgerSnapshot() {
  const rows = await owner.db
    .select({
      id: schema.leaveLedger.id,
      employmentId: schema.leaveLedger.employmentId,
      leaveTypeId: schema.leaveLedger.leaveTypeId,
      entryType: schema.leaveLedger.entryType,
      days: schema.leaveLedger.days,
      effectiveOn: schema.leaveLedger.effectiveOn,
    })
    .from(schema.leaveLedger)
    .orderBy(asc(schema.leaveLedger.id));
  return rows;
}

/** The GRANT-PATH verdict for one pair, read out of the engine's own log rather than inferred. */
function verdictFor(rows: { employmentId: string; leaveTypeId: string; outcome: string }[], emp: string, type: string) {
  const mine = rows.filter((r) => r.employmentId === emp && r.leaveTypeId === type);
  expect(mine.length, 'the engine logs every pair it considered — a dropped pair is a different bug').toBe(1);
  return mine[0].outcome;
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

// ── (a) a blank GENDER is granted neither Maternity nor Paternity ────────────────────────────────────
describe('73ddd5a1 (a) · a blank gender earns no gender-restricted entitlement', () => {
  /**
   * MUTATION EVIDENCE. Revert `core/leave.ts` `openLeaveYear` to `isProfileEligible(..., 'allow')` and
   * this test fails on the first expect with
   *   "MTL is female-only and this employee's gender is not recorded: expected 14 to be +0".
   */
  it('grants a blank-gender employee NOTHING on MTL or PTL, and still grants the recorded woman her MTL', async () => {
    const t = await allTypes();
    const blankGender = await hire(null, 'married');
    const recorded = await hire('female', 'married');

    await openLeaveYear(adminCtx(b), { year: YEAR, leaveTypeIds: [t.MTL, t.PTL] });

    expect(
      await accrued(blankGender, t.MTL),
      "MTL is female-only and this employee's gender is not recorded",
    ).toBe(0);
    expect(
      await accrued(blankGender, t.PTL),
      "PTL is male-only and this employee's gender is not recorded",
    ).toBe(0);
    // The type is not broken, only the unplaced pair is refused.
    expect(await accrued(recorded, t.MTL), 'a recorded female married employee still gets her MTL').toBe(DAYS);
  });

  it('reports the refusal as not_eligible rather than silently granting zero', async () => {
    const t = await allTypes();
    const blankGender = await hire(null, 'married');
    const res = await openLeaveYear(adminCtx(b), { year: YEAR, leaveTypeIds: [t.MTL], dryRun: true });
    expect(
      verdictFor(res.rows ?? [], blankGender, t.MTL),
      'a refusal HR cannot see is a refusal HR cannot fix — the reporter fixes it by filling the profile in',
    ).toBe('not_eligible');
  });
});

// ── (b) a blank MARITAL STATUS is granted neither Marriage nor Caregiver leave ───────────────────────
describe('73ddd5a1 (b) · a blank marital status earns no marital-restricted entitlement', () => {
  /**
   * MUTATION EVIDENCE. Under `'allow'` this fails with
   *   "MRL is single-only and this employee's marital status is not recorded: expected 14 to be +0".
   */
  it('grants a blank-marital employee NOTHING on MRL or CGL', async () => {
    const t = await allTypes();
    const blankMarital = await hire('female', null);
    const single = await hire('female', 'single');

    await openLeaveYear(adminCtx(b), { year: YEAR, leaveTypeIds: [t.MRL, t.CGL] });

    expect(
      await accrued(blankMarital, t.MRL),
      "MRL is single-only and this employee's marital status is not recorded",
    ).toBe(0);
    expect(
      await accrued(blankMarital, t.CGL),
      "CGL lists five of six marital values ('other' omitted), so it IS a restriction and a blank field fails it",
    ).toBe(0);
    expect(await accrued(single, t.MRL), 'a recorded single employee still gets MRL').toBe(DAYS);
  });

  /**
   * ⚠️ THE CORRECTION TO THE APPROVED PLAN, AS AN ASSERTION. The plan and r334's note both say blank
   * marital costs "Caregiver AND Natural Disaster Leave". On production `NDL.eligibility IS NULL`, so it
   * carries no rule and nothing about a blank field can touch it. If a tenant ever configures NDL with a
   * partial marital list this test goes red, which is the right time to re-tell the reporter.
   */
  it('…but NDL is NOT among them: it carries no eligibility rule at all, so a blank field costs CGL only', async () => {
    const t = await allTypes();
    const blankMarital = await hire('female', null);
    await openLeaveYear(adminCtx(b), { year: YEAR, leaveTypeIds: [t.NDL, t.CGL] });
    expect(
      await accrued(blankMarital, t.NDL),
      'Natural Disaster Leave has no eligibility rule on production — the plan was wrong about it',
    ).toBe(DAYS);
    expect(await accrued(blankMarital, t.CGL), 'Caregiver Leave is the one real cost of this decision').toBe(0);
  });

  it('the measurement itself: exactly four of the eleven production shapes genuinely restrict', () => {
    const restricting = CODES.filter((c) => {
      const e = RULES[c] as LeaveEligibility | null;
      // A shape restricts iff SOME recorded, in-vocabulary person fails it. Probed rather than asserted
      // from the JSON, so the universal-list normalisation is what decides — not a reading of the literal.
      const everyone = EVERY_GENDER.flatMap((g) => EVERY_MARITAL.map((m) => ({ gender: g, marital: m })));
      return everyone.some((p) => !isProfileEligible(e, p, 'exclude'));
    });
    expect(restricting.sort(), 'MTL, PTL, MRL, CGL — and nothing else, on production 2026-09-25').toEqual(
      [...GENUINELY_RESTRICTING].sort(),
    );
  });
});

// ── (c) THE REGRESSION GUARD FOR THE 33-PERSON INCIDENT ──────────────────────────────────────────────
describe('73ddd5a1 (c) · a blank gender still earns EVERY universal-list and no-rule type', () => {
  /**
   * ⚠️ DO NOT WEAKEN OR DELETE THIS. It is the recorded production incident, as a test: `'exclude'` on the
   * grant path once meant a blank-gender employee was granted nothing on the eight types storing
   * `["male","female"]`, and a reversal sweep under the same reading proposed taking Annual Leave off 33
   * real people. `eligibilityRuleList` is what makes that impossible now. Weaken the universal-list rule —
   * compare against `GENDERS` instead of `ELIGIBILITY_GENDERS`, drop the `pickerOptions` argument, "fix" a
   * list to be read literally — and this goes red before anything reaches production.
   *
   * MUTATION EVIDENCE (the rule, not the policy): change `eligibilityRuleList` to `return list` and this
   * fails with "CPL lists every gender AND every marital status — a rule nobody wrote must not withhold a
   * single day (the 33-person incident): expected +0 to be 14".
   */
  it('grants every universal-list type to an employee with NO gender and NO marital status recorded', async () => {
    const t = await allTypes();
    const unplaced = await hire(null, null);
    const ids = UNIVERSAL_LIST.map((c) => t[c]);

    await openLeaveYear(adminCtx(b), { year: YEAR, leaveTypeIds: ids });

    for (const code of UNIVERSAL_LIST) {
      expect(
        await accrued(unplaced, t[code]),
        `${code} lists every gender AND every marital status — a rule nobody wrote must not withhold a single day (the 33-person incident)`,
      ).toBe(DAYS);
    }
  });

  it('grants every no-rule type to an employee with NO gender and NO marital status recorded', async () => {
    const t = await allTypes();
    const unplaced = await hire(null, null);
    const ids = NO_RULE.map((c) => t[c]);

    await openLeaveYear(adminCtx(b), { year: YEAR, leaveTypeIds: ids });

    for (const code of NO_RULE) {
      expect(
        await accrued(unplaced, t[code]),
        `${code} has eligibility IS NULL on production — Annual Leave and Medical Leave are in this set and must never be withheld for a blank field`,
      ).toBe(DAYS);
    }
  });

  it('the predicate answers a universal list identically under BOTH policies, so the flip cannot reach it', () => {
    const unplaced = { gender: null, marital: null };
    for (const code of [...UNIVERSAL_LIST, ...NO_RULE]) {
      const e = RULES[code] as LeaveEligibility | null;
      expect(isProfileEligible(e, unplaced, 'allow'), `${code} under allow`).toBe(true);
      expect(
        isProfileEligible(e, unplaced, 'exclude'),
        `${code} under exclude — the policy is never consulted for a field carrying no restriction`,
      ).toBe(true);
    }
  });
});

// ── (d) an employee whose fields ARE recorded is byte-identical to today ─────────────────────────────
describe('73ddd5a1 (d) · a fully recorded employee is unchanged by this round', () => {
  /**
   * MUTATION EVIDENCE is the INVERSE here, and that is the point: this test must stay green under BOTH
   * policies. If it ever goes red on the policy argument alone, the change has reached somebody whose
   * profile is complete, which is nothing the reporter asked for.
   */
  it('every one of the eleven verdicts is identical under allow and under exclude', () => {
    const recorded = [
      { gender: 'female', marital: 'married' },
      { gender: 'male', marital: 'married' },
      { gender: 'female', marital: 'single' },
      { gender: 'male', marital: 'other' },
    ];
    for (const p of recorded) {
      for (const code of CODES) {
        const e = RULES[code] as LeaveEligibility | null;
        expect(
          isProfileEligible(e, p, 'exclude'),
          `${code} for ${p.gender}/${p.marital} must not move: a recorded fact is never an unknown one`,
        ).toBe(isProfileEligible(e, p, 'allow'));
      }
    }
  });

  it('grants a recorded female married employee exactly the same set, at exactly the same days', async () => {
    const t = await allTypes();
    const her = await hire('female', 'married');
    const res = await openLeaveYear(adminCtx(b), { year: YEAR, leaveTypeIds: CODES.map((c) => t[c]) });
    const rows = res.rows ?? [];

    // Her verdicts, spelled out rather than derived, so a change to the predicate has to be argued for.
    const expected: Record<Code, number> = {
      MTL: DAYS, // female + married
      PTL: 0, // male-only — a RECORDED contradiction, refused before this round and after it
      MRL: 0, // single-only — recorded married
      CGL: DAYS, // 'married' is among the five
      CPL: DAYS,
      EXM: DAYS,
      GD: DAYS,
      STD: DAYS,
      AL: DAYS,
      MC: DAYS,
      NDL: DAYS,
    };
    for (const code of CODES) {
      expect(await accrued(her, t[code]), `${code} for a recorded female married employee`).toBe(expected[code]);
      expect(verdictFor(rows, her, t[code]), `${code} verdict`).toBe(expected[code] > 0 ? 'granted' : 'not_eligible');
    }
  });
});

// ── (e) no existing ledger row is touched ────────────────────────────────────────────────────────────
describe('73ddd5a1 (e) · nothing is clawed back', () => {
  /**
   * ⚠️ THE REPORTER'S SEPARATE TRIGGER, PINNED SO NOBODY QUIETLY ADDS IT: "we will not do that until you
   * say so — those are balances on real employees' records and we are not deleting them on a guess."
   *
   * The fixture is the production shape that makes this tempting: a blank-marital employee already holding
   * a real CGL accrual from a pre-73ddd5a1 run, on a type the new gate refuses. The run must add nothing
   * for that pair AND leave the existing row exactly as it stands — same id, same days, same date, no
   * reversal, no adjustment, no delete.
   */
  /**
   * ⚠️ TWO ASSERTIONS, NOT ONE, AND THE SPLIT IS THE POINT. The first draft asserted only that the WHOLE
   * snapshot was unchanged. That is a weaker guard than it looks: under the pre-73ddd5a1 `'allow'` policy it
   * fails because rows are ADDED, which is a different fact from an existing row being touched, and a
   * single `toEqual` cannot tell the two apart. So the no-clawback claim is asserted on the original rows
   * BY ID — true under any policy, and the only form in which it is the reporter's guarantee.
   */
  it('the pre-existing rows are byte-identical after a grant run, looked up by id', async () => {
    const t = await allTypes();
    const blankMarital = await hire('female', null);
    const seeded = await owner.db
      .insert(schema.leaveLedger)
      .values([
        { tenantId: b.tenantId, employmentId: blankMarital, leaveTypeId: t.CGL, entryType: 'accrual', days: '5.00', effectiveOn: `${YEAR - 1}-01-01` },
        { tenantId: b.tenantId, employmentId: blankMarital, leaveTypeId: t.MRL, entryType: 'accrual', days: '3.00', effectiveOn: `${YEAR - 1}-06-01` },
        { tenantId: b.tenantId, employmentId: blankMarital, leaveTypeId: t.AL, entryType: 'adjustment', days: '-1.50', effectiveOn: `${YEAR - 1}-07-01` },
      ])
      .returning({ id: schema.leaveLedger.id });
    const seededIds = new Set(seeded.map((r) => r.id));
    const before = (await ledgerSnapshot()).filter((r) => seededIds.has(r.id));
    expect(before.length, 'the fixture really is three rows').toBe(3);

    await openLeaveYear(adminCtx(b), { year: YEAR, leaveTypeIds: [t.CGL, t.MRL] });

    const after = (await ledgerSnapshot()).filter((r) => seededIds.has(r.id));
    expect(
      after,
      'not one existing ledger row may be reversed, adjusted or deleted by this round — those are balances on real employees and the reporter reverses them on their own trigger, not ours',
    ).toEqual(before);
    expect(after.length, 'nor may one be deleted outright, which a filtered compare would otherwise hide').toBe(3);
  });

  it('…and a refused pair adds nothing either, so the whole snapshot is unchanged', async () => {
    const t = await allTypes();
    const blankMarital = await hire('female', null);
    await owner.db.insert(schema.leaveLedger).values([
      { tenantId: b.tenantId, employmentId: blankMarital, leaveTypeId: t.CGL, entryType: 'accrual', days: '5.00', effectiveOn: `${YEAR - 1}-01-01` },
    ]);

    const before = await ledgerSnapshot();
    await openLeaveYear(adminCtx(b), { year: YEAR, leaveTypeIds: [t.CGL, t.MRL] });
    const after = await ledgerSnapshot();
    expect(after, 'a run that grants nothing writes nothing').toEqual(before);
  });

  it('…and the refused pair gains no row at all, rather than a zero-day one', async () => {
    const t = await allTypes();
    const blankMarital = await hire('female', null);
    await openLeaveYear(adminCtx(b), { year: YEAR, leaveTypeIds: [t.CGL] });
    const rows = await owner.db
      .select({ id: schema.leaveLedger.id })
      .from(schema.leaveLedger)
      .where(eq(schema.leaveLedger.leaveTypeId, t.CGL));
    expect(rows.length, 'a refusal writes no ledger row — 0.00 would assert a balance that does not exist').toBe(0);
  });
});

// ── (f) the grant path and the read gates now agree ──────────────────────────────────────────────────
describe('73ddd5a1 (f) · the grant path and the read gates give the same answer', () => {
  /**
   * ⚠️ THIS IS THE COHERENCE THE REPORTER IS ASKING FOR, AND IT IS A CONTRACT BETWEEN TWO FILES —
   * `openLeaveYear` (core/leave.ts) and `leaveBalances` (core/read.ts) — so it is pinned across both
   * rather than at the predicate, where it would be a tautology. The read gates have passed `'exclude'`
   * since 508d3acd. Before this round a blank-gender employee was GRANTED Maternity Leave and then could
   * not see it: 5,390 days that existed in the ledger and on no screen the employee could open. Now the
   * two halves agree — such a balance is simply never granted.
   *
   * Every fixture employee is hired in 2020, so no TIMING rule (PTL's 12-month minimum service) can be
   * mistaken for an identity verdict; the split between the two is 508d3acd's to pin, not this file's.
   *
   * MUTATION EVIDENCE. Under `'allow'` this fails with
   *   "MTL for blank gender: the grant path and the balance card must not disagree about whose leave a
   *    type is: expected 'granted' to be 'not_eligible'".
   */
  it('for every employee and every type, granted ⇔ the balance card shows it', async () => {
    const t = await allTypes();
    const people: [string, string][] = [
      ['recorded female married', await hire('female', 'married')],
      ['blank gender', await hire(null, 'married')],
      ['blank marital', await hire('female', null)],
      ['blank both', await hire(null, null)],
    ];

    const res = await openLeaveYear(adminCtx(b), { year: YEAR, leaveTypeIds: CODES.map((c) => t[c]) });
    const rows = res.rows ?? [];

    for (const [label, emp] of people) {
      // The GATED read — `includeIneligible` defaults to false, which is what the employee's own surfaces
      // and the Employee Balances screen consume.
      const cards = await leaveBalances(adminCtx(b), emp, 'en');
      const visible = new Set(cards.map((c) => c.leaveTypeId));
      for (const code of CODES) {
        const grantedHere = verdictFor(rows, emp, t[code]) !== 'not_eligible';
        expect(
          grantedHere,
          `${code} for ${label}: the grant path and the balance card must not disagree about whose leave a type is`,
        ).toBe(visible.has(t[code]));
      }
    }
  });
});

// ── the source guards: the one argument, and the three things around it that must not move ───────────
describe('73ddd5a1 · source guards', () => {
  const leaveSrc = readFileSync(new URL('../core/leave.ts', import.meta.url), 'utf8');

  it('the grant path passes exclude', () => {
    expect(
      leaveSrc,
      "openLeaveYear's identity gate is the whole of this round — flipping it back is the regression",
    ).toContain("isProfileEligible(t.eligibility as LeaveEligibility | null, e, 'exclude')");
  });

  it('UnknownAttributePolicy still has NO default, so a new caller cannot avoid the decision', () => {
    expect(leaveSrc).toContain('unknown: UnknownAttributePolicy,');
    expect(leaveSrc, 'a default value here is how the next incident gets in').not.toMatch(
      /unknown: UnknownAttributePolicy\s*=/,
    );
    expect(leaveSrc).toContain("export type UnknownAttributePolicy = 'exclude' | 'allow';");
  });

  it('the universal-list rule is still applied to BOTH identity fields inside the predicate', () => {
    expect(leaveSrc).toContain('fails(eligibilityRuleList(elig.gender, ELIGIBILITY_GENDERS), emp?.gender)');
    expect(leaveSrc).toContain('fails(eligibilityRuleList(elig.maritalStatus, MARITAL_STATUSES), emp?.marital)');
  });

  /**
   * The asymmetry is deliberate and is the lesson of the incident: granting a day we may not owe is
   * recoverable, TAKING one away because a field is blank is not. The reversal sweep keeps `'allow'`.
   */
  it('the reversal sweep still passes allow', () => {
    const rev = readFileSync(new URL('../scripts/reverse-ineligible-leave-grants.ts', import.meta.url), 'utf8');
    expect(rev, 'a sweep that takes days away must stay on the safe side of a blank field').toContain(
      "isProfileEligible(t.eligibility as LeaveEligibility | null, emp, 'allow')",
    );
  });
});
