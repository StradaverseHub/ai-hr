/**
 * 6e9a126e RELEASE ONE — the new entitlement layer: named templates, eligibility rules, and the ONE
 * criteria engine they resolve through.
 *
 *     leave_type  →  entitlement_template  →  entitlement_eligibility_rule
 *
 * WHAT IS PINNED HERE, and why each one:
 *  - THE CRITERIA ARE core/org-criteria.ts's, NOT A THIRD ENGINE. This item exists because "who does this
 *    apply to" is answered in several places at once; a private matcher here would be the defect wearing
 *    the fix's clothes. The tests below narrow by department and employment type and expect the SAME
 *    as-at-date semantics the Notice Board and bulk Leave Adjustments already have.
 *  - AS-AT RESOLUTION IS REAL, not aspirational. An employee who transferred department mid-year resolves
 *    to the rule that matched them ON THAT DATE, not today's. This is the capability the plan says the
 *    approval matcher could not have supplied (it is handed its attributes as of NOW by its caller).
 *  - EFFECTIVE DATING IS CLOSE-THEN-INSERT. Three readers resolve entitlement at a PAST date today; an
 *    in-place UPDATE would make all three report closed years against today's figures.
 *  - LINEAGE, NOT VERSION. A rule keeps pointing at "the Executive table" across every future edit of it.
 *  - THE BAND CEILING MOVED 10 → 20 IN BOTH PLACES. A writer that accepts what the resolver rejects does
 *    not throw: it resolves to NO band, i.e. a wrong day count with nothing on screen to say so.
 *  - deleteLeaveType STILL REFUSES a type carrying entitlement configuration once leave_policy is gone.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hireEmployee, setEmploymentAssignment } from '../core/org';
import { createLeaveType, deleteLeaveType } from '../core/admin';
import {
  beatsEligibility,
  createEligibilityRule,
  createEntitlementTemplate,
  listEligibilityRules,
  listEntitlementTemplates,
  resolveEntitlementForEmployment,
  templateDaysForYears,
  updateEligibilityRule,
  updateEntitlementTemplate,
  usesUndatedEligibilityAxis,
  UNDATED_ELIGIBILITY_AXES,
} from '../core/entitlement-template';
import { isWellFormedBands, MAX_SERVICE_BANDS, type ServiceBand } from '../core/leave-compute';
import { withTenant } from '../db/client';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
// 4fdb69b2 — the cascade/refusal assertions read the rows back as the owner, outside RLS.
import * as schema from '../db/schema';
import { eq } from 'drizzle-orm';

let b: Base;
const uniqEmail = () => `tmpl_${randomUUID().slice(0, 8)}@t.local`;

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

/** The reporter's own worked example, verbatim from the request. */
const REPORTER_TABLE: ServiceBand[] = [
  { fromYears: 0, toYears: 2, days: 14, carryForwardDays: 5, maxBalanceDays: 19 },
  { fromYears: 2, toYears: 5, days: 16, carryForwardDays: 5, maxBalanceDays: 21 },
  { fromYears: 5, toYears: 10, days: 18, carryForwardDays: 8, maxBalanceDays: 26 },
  { fromYears: 10, toYears: null, days: 22, carryForwardDays: 10, maxBalanceDays: 32 },
];
const flat = (days: number): ServiceBand[] => [{ fromYears: 0, toYears: null, days }];

const hire = (p: { hiredOn: string; departmentId?: string; employmentType?: 'full_time' | 'contract' }) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: 'Ada Lovelace', primaryEmail: uniqEmail() },
    companyId: b.companyId,
    departmentId: p.departmentId ?? b.deptA,
    employmentType: p.employmentType ?? 'full_time',
    hiredOn: p.hiredOn,
    gradeId: null,
    grantLeaveTypes: [],
  });

const resolveFor = (employmentId: string, asOf: string, leaveTypeId = b.annualLeaveTypeId) =>
  withTenant(adminCtx(b), (tx) => resolveEntitlementForEmployment(tx, { employmentId, leaveTypeId, asOf }));

describe('entitlement templates — the reporter\'s named service-band tables', () => {
  it('stores the reporter\'s own four-band example unchanged, and resolves days by service length', async () => {
    const ctx = adminCtx(b);
    const tpl = await createEntitlementTemplate(ctx, {
      leaveTypeId: b.annualLeaveTypeId,
      name: 'Grade 12-15 Permanent',
      serviceBands: REPORTER_TABLE,
      validFrom: '2026-01-01',
    });
    expect(tpl.serviceBands).toEqual(REPORTER_TABLE);
    // The lineage IS the first version's own id — that identity is what an eligibility rule points at.
    expect(tpl.lineageId).toBe(tpl.id);

    // Days come from the SAME `bandFor` the benefit schemes and leave_policy already go through: one band
    // resolver, four columns mapping exactly onto the reporter's table.
    const days = templateDaysForYears({
      ruleName: 'x',
      ruleLineageId: 'x',
      templateName: tpl.name,
      templateLineageId: tpl.lineageId,
      serviceBands: tpl.serviceBands,
      specificity: 0,
      alsoMatched: [],
      viaSoleTemplate: false,
    });
    expect(days(0)).toBe(14);
    expect(days(1)).toBe(14);
    expect(days(2)).toBe(16);
    expect(days(4)).toBe(16);
    expect(days(5)).toBe(18);
    expect(days(9)).toBe(18);
    expect(days(10)).toBe(22);
    expect(days(40)).toBe(22);
  });

  it('editing CLOSES the running version and inserts a successor — the past keeps its own figures', async () => {
    const ctx = adminCtx(b);
    const v1 = await createEntitlementTemplate(ctx, {
      leaveTypeId: b.annualLeaveTypeId,
      name: 'Executive',
      serviceBands: flat(14),
      validFrom: '2024-01-01',
    });
    const v2 = await updateEntitlementTemplate(ctx, {
      lineageId: v1.lineageId,
      serviceBands: flat(18),
      validFrom: '2026-01-01',
    });
    expect(v2.lineageId).toBe(v1.lineageId);
    expect(v2.id).not.toBe(v1.id);

    const all = await listEntitlementTemplates(ctx);
    expect(all).toHaveLength(2);
    expect(all.find((r) => r.id === v1.id)!.validTo).toBe('2026-01-01');
    expect(all.find((r) => r.id === v2.id)!.validTo).toBeNull();

    // The whole reason both tables are dated: the Carry Forward report and the balance breakdown resolve
    // at a PAST date, and an in-place UPDATE would answer 2025 with 2026's figure.
    const at2025 = await listEntitlementTemplates(ctx, { asOf: '2025-06-30' });
    expect(at2025.map((r) => r.serviceBands[0].days)).toEqual([14]);
    const at2026 = await listEntitlementTemplates(ctx, { asOf: '2026-06-30' });
    expect(at2026.map((r) => r.serviceBands[0].days)).toEqual([18]);
  });

  /**
   * ⚠️ r219 (ca7766ab) UPDATED THIS CASE RATHER THAN DELETING IT, and the two halves are worth keeping
   * apart. STILL TRUE: a version that HAS been in force cannot be given an EARLIER start date — changing
   * the start of a table that was in force would quietly change what a closed leave year says an employee
   * was entitled to, and that is the one thing the versioning exists to prevent. RETIRED: the SAME date
   * used to be refused too, by `open.validFrom >= p.validFrom` comparing the running version against
   * ITSELF, and the message told the operator to "edit that version instead" of a version they had no way
   * to reach. Saving a version with its own date is now an in-place save, pinned in
   * test/r219-entitlement-effective-date.test.ts along with the rest of the new rule.
   */
  it('refuses an EARLIER date once the running version has been in force — and names that version\'s date', async () => {
    const ctx = adminCtx(b);
    const v1 = await createEntitlementTemplate(ctx, {
      leaveTypeId: b.annualLeaveTypeId,
      name: 'Executive',
      serviceBands: flat(14),
      validFrom: '2026-01-01',
    });
    await expect(
      updateEntitlementTemplate(ctx, {
        lineageId: v1.lineageId,
        serviceBands: flat(18),
        validFrom: '2025-12-31',
        today: '2026-06-30', // the running version started six months ago
      }),
    ).rejects.toThrow(/in force since 2026-01-01/i);
  });

  it('refuses a band table the RESOLVER would reject — the writer and the resolver share one ceiling', async () => {
    const ctx = adminCtx(b);
    const over: ServiceBand[] = [];
    for (let i = 0; i <= MAX_SERVICE_BANDS; i++) {
      over.push({ fromYears: i, toYears: i === MAX_SERVICE_BANDS ? null : i + 1, days: 10 });
    }
    expect(over).toHaveLength(MAX_SERVICE_BANDS + 1);
    // Both halves of the pair, asserted together. If only the validator moved, the writer would accept
    // this and `isWellFormedBands` would then resolve NO band — a silently wrong day count.
    expect(isWellFormedBands(over)).toBe(false);
    await expect(
      createEntitlementTemplate(ctx, {
        leaveTypeId: b.annualLeaveTypeId,
        name: 'Too many',
        serviceBands: over,
        validFrom: '2026-01-01',
      }),
    ).rejects.toThrow(new RegExp(`${MAX_SERVICE_BANDS} bands`));

    // …and exactly at the ceiling it is accepted by BOTH.
    const atLimit = over.slice(0, MAX_SERVICE_BANDS);
    atLimit[MAX_SERVICE_BANDS - 1] = { fromYears: MAX_SERVICE_BANDS - 1, toYears: null, days: 10 };
    expect(isWellFormedBands(atLimit)).toBe(true);
    const ok = await createEntitlementTemplate(ctx, {
      leaveTypeId: b.annualLeaveTypeId,
      name: 'At the limit',
      serviceBands: atLimit,
      validFrom: '2026-01-01',
    });
    expect(ok.serviceBands).toHaveLength(MAX_SERVICE_BANDS);
  });

  it('THE TEMPLATE GROWS NO SECOND CARRY DEFINITION — carry forward stays on the leave type (7cd914b1)', () => {
    // Not a runtime assertion but a shape one: the band columns are the reporter's four, and none of them
    // is a percentage. 7cd914b1 put carry forward (fixed cap AND percentage) on `leave_type`, where
    // applyLeaveTypeRules overlays it wholesale for a consolidated type. A `carryForwardPercent` appearing
    // on a band would be a second, disagreeing home for the same rule.
    const keys = new Set(REPORTER_TABLE.flatMap((band) => Object.keys(band)));
    expect(keys.has('carryForwardPercent')).toBe(false);
    expect([...keys].sort()).toEqual(['carryForwardDays', 'days', 'fromYears', 'maxBalanceDays', 'toYears']);
  });
});

describe('eligibility rules — ONE criteria engine, resolved as at a date', () => {
  it('assigns a department to a table and resolves it for an employee in that department', async () => {
    const ctx = adminCtx(b);
    const tpl = await createEntitlementTemplate(ctx, {
      leaveTypeId: b.annualLeaveTypeId,
      name: 'Finance Annual',
      serviceBands: flat(18),
      validFrom: '2020-01-01',
    });
    await createEligibilityRule(ctx, {
      name: 'Finance',
      templateLineageId: tpl.lineageId,
      criteria: { departmentIds: [b.deptA] },
      validFrom: '2020-01-01',
    });

    const inFinance = await hire({ hiredOn: '2025-01-01', departmentId: b.deptA });
    const inOps = await hire({ hiredOn: '2025-01-01', departmentId: b.deptB });

    const hit = await resolveFor(inFinance.employmentId, '2026-06-30');
    expect(hit?.templateName).toBe('Finance Annual');
    expect(hit?.ruleName).toBe('Finance');
    expect(templateDaysForYears(hit)(1)).toBe(18);

    // No rule matches Operations — and the caller must read that as NO OPINION, never as zero days.
    expect(await resolveFor(inOps.employmentId, '2026-06-30')).toBeNull();
    expect(templateDaysForYears(null)(1)).toBeNull();
  });

  it('AS AT THE DATE, not as at today — a transfer changes which rule applied back then', async () => {
    const ctx = adminCtx(b);
    const finance = await createEntitlementTemplate(ctx, {
      leaveTypeId: b.annualLeaveTypeId,
      name: 'Finance Annual',
      serviceBands: flat(18),
      validFrom: '2020-01-01',
    });
    const ops = await createEntitlementTemplate(ctx, {
      leaveTypeId: b.annualLeaveTypeId,
      name: 'Operations Annual',
      serviceBands: flat(12),
      validFrom: '2020-01-01',
    });
    await createEligibilityRule(ctx, {
      name: 'Finance',
      templateLineageId: finance.lineageId,
      criteria: { departmentIds: [b.deptA] },
      validFrom: '2020-01-01',
    });
    await createEligibilityRule(ctx, {
      name: 'Operations',
      templateLineageId: ops.lineageId,
      criteria: { departmentIds: [b.deptB] },
      validFrom: '2020-01-01',
    });

    const emp = await hire({ hiredOn: '2025-01-01', departmentId: b.deptA });
    await setEmploymentAssignment(ctx, {
      employmentId: emp.employmentId,
      effectiveDate: '2026-04-01',
      departmentId: b.deptB,
    });

    // THIS is the property the plan flagged as "specified but not designed": dating the RULE rows alone
    // would have resolved TODAY'S department against a 2025 question. `resolveOrgCriteriaTargets` reads
    // the `assignment` version in force on asOf, so the answer moves with the employee's history.
    expect((await resolveFor(emp.employmentId, '2026-01-15'))?.templateName).toBe('Finance Annual');
    expect((await resolveFor(emp.employmentId, '2026-06-30'))?.templateName).toBe('Operations Annual');
  });

  it('MOST SPECIFIC WINS, and the loser is named so the win is never a guess', async () => {
    const ctx = adminCtx(b);
    const broad = await createEntitlementTemplate(ctx, {
      leaveTypeId: b.annualLeaveTypeId,
      name: 'Company default',
      serviceBands: flat(12),
      validFrom: '2020-01-01',
    });
    const narrow = await createEntitlementTemplate(ctx, {
      leaveTypeId: b.annualLeaveTypeId,
      name: 'Finance contract',
      serviceBands: flat(20),
      validFrom: '2020-01-01',
    });
    await createEligibilityRule(ctx, {
      name: 'Everyone in the company',
      templateLineageId: broad.lineageId,
      criteria: { companyIds: [b.companyId] },
      validFrom: '2020-01-01',
    });
    await createEligibilityRule(ctx, {
      name: 'Finance contract staff',
      templateLineageId: narrow.lineageId,
      criteria: { companyIds: [b.companyId], departmentIds: [b.deptA], employmentTypes: ['contract'] },
      validFrom: '2020-01-01',
    });

    const emp = await hire({ hiredOn: '2025-01-01', departmentId: b.deptA, employmentType: 'contract' });
    const hit = await resolveFor(emp.employmentId, '2026-06-30');
    expect(hit?.templateName).toBe('Finance contract');
    expect(hit?.specificity).toBe(3);
    // The plan promises "the screen tells you which one won so it is never a guess" — which needs the
    // runners-up, not just the winner.
    expect(hit?.alsoMatched).toEqual([{ ruleName: 'Everyone in the company', specificity: 1 }]);
  });

  it('an EMPTY criteria object means EVERYONE — the same semantics every other consumer has', async () => {
    const ctx = adminCtx(b);
    const tpl = await createEntitlementTemplate(ctx, {
      leaveTypeId: b.annualLeaveTypeId,
      name: 'The only table',
      serviceBands: flat(15),
      validFrom: '2020-01-01',
    });
    await createEligibilityRule(ctx, {
      name: 'Everyone',
      templateLineageId: tpl.lineageId,
      criteria: {},
      validFrom: '2020-01-01',
    });
    const emp = await hire({ hiredOn: '2025-01-01', departmentId: b.deptB });
    expect((await resolveFor(emp.employmentId, '2026-06-30'))?.templateName).toBe('The only table');
    // …which is also how somebody assigns the whole company by accident, so every screen that writes one
    // is required to show `countOrgCriteriaTargets` first. That obligation is the reason this is pinned.
  });

  it('a rule follows the template LINEAGE across an edit — it never points at a superseded version', async () => {
    const ctx = adminCtx(b);
    const v1 = await createEntitlementTemplate(ctx, {
      leaveTypeId: b.annualLeaveTypeId,
      name: 'Executive',
      serviceBands: flat(14),
      validFrom: '2020-01-01',
    });
    await createEligibilityRule(ctx, {
      name: 'Everyone',
      templateLineageId: v1.lineageId,
      criteria: {},
      validFrom: '2020-01-01',
    });
    await updateEntitlementTemplate(ctx, {
      lineageId: v1.lineageId,
      serviceBands: flat(21),
      validFrom: '2026-01-01',
    });
    const emp = await hire({ hiredOn: '2019-01-01' });
    // The rule was never rewritten, and it resolves the version in force on each date.
    expect(templateDaysForYears(await resolveFor(emp.employmentId, '2025-06-30'))(3)).toBe(14);
    expect(templateDaysForYears(await resolveFor(emp.employmentId, '2026-06-30'))(3)).toBe(21);
  });

  it('editing a rule closes it and inserts a successor, exactly as a template edit does', async () => {
    const ctx = adminCtx(b);
    const tpl = await createEntitlementTemplate(ctx, {
      leaveTypeId: b.annualLeaveTypeId,
      name: 'T',
      serviceBands: flat(10),
      validFrom: '2020-01-01',
    });
    const r1 = await createEligibilityRule(ctx, {
      name: 'Finance',
      templateLineageId: tpl.lineageId,
      criteria: { departmentIds: [b.deptA] },
      validFrom: '2020-01-01',
    });
    const r2 = await updateEligibilityRule(ctx, {
      lineageId: r1.lineageId,
      criteria: { departmentIds: [b.deptB] },
      validFrom: '2026-01-01',
    });
    expect(r2.lineageId).toBe(r1.lineageId);
    const all = await listEligibilityRules(ctx);
    expect(all).toHaveLength(2);
    expect(all.find((r) => r.id === r1.id)!.validTo).toBe('2026-01-01');

    const emp = await hire({ hiredOn: '2019-01-01', departmentId: b.deptA });
    expect(await resolveFor(emp.employmentId, '2025-06-30')).not.toBeNull();
    expect(await resolveFor(emp.employmentId, '2026-06-30')).toBeNull();
  });

  it('refuses a rule pointing at a table that does not exist', async () => {
    await expect(
      createEligibilityRule(adminCtx(b), {
        name: 'Orphan',
        templateLineageId: randomUUID(),
        criteria: {},
        validFrom: '2026-01-01',
      }),
    ).rejects.toThrow(/does not exist/i);
  });
});

describe('the tie-break, and what a past-date answer cannot reconstruct', () => {
  const rule = (p: Partial<Parameters<typeof beatsEligibility>[0]>) =>
    ({
      id: 'x',
      lineageId: 'x',
      name: 'x',
      templateLineageId: 't',
      criteria: {},
      validFrom: '2020-01-01',
      validTo: null,
      createdAt: new Date('2020-01-01T00:00:00Z'),
      ...p,
    }) as Parameters<typeof beatsEligibility>[0];

  it('more narrowed axes wins, then the later start date, then the later creation', () => {
    expect(beatsEligibility(rule({ criteria: { companyIds: ['a'] } }), rule({ criteria: {} }))).toBe(true);
    expect(
      beatsEligibility(rule({ validFrom: '2026-01-01' }), rule({ validFrom: '2020-01-01' })),
    ).toBe(true);
    expect(
      beatsEligibility(
        rule({ createdAt: new Date('2026-01-01T00:00:00Z') }),
        rule({ createdAt: new Date('2020-01-01T00:00:00Z') }),
      ),
    ).toBe(true);
    // A hire-date band and a service band each count ONCE, like the approval matcher's day range.
    expect(
      beatsEligibility(
        rule({ criteria: { hiredFrom: '2020-01-01', hiredTo: '2024-12-31' } }),
        rule({ criteria: { companyIds: ['a'] } }),
      ),
    ).toBe(false);
  });

  it('names the axes a past-date answer resolves at TODAY\'S value, rather than implying precision', () => {
    // Stated honestly rather than papered over: gender / nationality / religion / race live on `person`
    // and job grade on `employment`, and none of the five is effective-dated anywhere in this schema.
    expect([...UNDATED_ELIGIBILITY_AXES]).toEqual(['gradeIds', 'genders', 'nationalities', 'religions', 'races']);
    expect(usesUndatedEligibilityAxis({ departmentIds: ['d'] })).toBe(false);
    expect(usesUndatedEligibilityAxis({ genders: ['female'] })).toBe(true);
    expect(usesUndatedEligibilityAxis({ gradeIds: ['g'] })).toBe(true);
    expect(usesUndatedEligibilityAxis({})).toBe(false);
    expect(usesUndatedEligibilityAxis(null)).toBe(false);
  });
});

describe('deleteLeaveType and the entitlement layer, after 4fdb69b2 made the delete CASCADE', () => {
  /**
   * ⚠️ THIS TEST WAS INVERTED BY 1ae7f3ab + 4fdb69b2, and the inversion is deliberate — read this before
   * "restoring" it.
   *
   * As written for 6e9a126e it asserted that an entitlement template BLOCKS the delete. The concern behind
   * it was real and is quoted in the original comment: a delete that takes live entitlement configuration
   * with it would orphan the ledger rows granted under it.
   *
   * 4fdb69b2 is the reporter's answer to that, approved after they were told the alternative: they asked
   * for the configuration to be cleared automatically rather than by hand ("please automatically remove
   * all approval workflow references, balance source mappings, entitlement mappings, and any other backend
   * dependencies"). So an entitlement template is CONFIG and is now cascaded.
   *
   * THE ORIGINAL CONCERN IS STILL HONOURED, by a stronger rule than the one it asked for: the orphaned-
   * ledger case cannot arise, because leave_ledger and leave_request are HISTORY and refuse the delete
   * outright. You can only delete a configured type that nobody has ever taken leave under. Both halves
   * are asserted below, so weakening either one fails here.
   */
  it('cascades the entitlement template when the type has no leave history', async () => {
    const ctx = adminCtx(b);
    const lt = await createLeaveType(ctx, { code: `SPECIAL${randomUUID().slice(0, 4)}`, name: 'Special leave' });
    const spare = await createLeaveType(ctx, { code: `SPARE${randomUUID().slice(0, 4)}`, name: 'Spare' });
    await deleteLeaveType(ctx, { id: spare.id });

    const tpl = await createEntitlementTemplate(ctx, {
      leaveTypeId: lt.id,
      name: 'Special table',
      serviceBands: flat(3),
      validFrom: '2026-01-01',
    });
    expect(tpl.id, 'the template really exists before the delete').toBeTruthy();

    await deleteLeaveType(ctx, { id: lt.id });

    const templates = await owner.db
      .select({ id: schema.entitlementTemplate.id })
      .from(schema.entitlementTemplate)
      .where(eq(schema.entitlementTemplate.leaveTypeId, lt.id));
    expect(templates, 'the template goes with the type — that is the cascade').toHaveLength(0);
  });

  it('REFUSES when the type carries leave history, so no ledger row is ever orphaned', async () => {
    // This is the half that replaces the old assertion, and it is the one that actually protects the
    // ledger. A configured type that somebody has taken leave under cannot be deleted at all.
    const ctx = adminCtx(b);
    const lt = await createLeaveType(ctx, { code: `USED${randomUUID().slice(0, 4)}`, name: 'Used leave' });
    await createEntitlementTemplate(ctx, {
      leaveTypeId: lt.id,
      name: 'Used table',
      serviceBands: flat(3),
      validFrom: '2026-01-01',
    });
    await owner.db.insert(schema.leaveLedger).values({
      tenantId: b.tenantId,
      employmentId: (await hire({ hiredOn: '2026-01-01' })).employmentId,
      leaveTypeId: lt.id,
      entryType: 'adjustment',
      days: '1.00',
      effectiveOn: '2026-01-05',
      reason: 'orphan guard',
    });

    await expect(deleteLeaveType(ctx, { id: lt.id })).rejects.toThrow(/leave_ledger/);

    const still = await owner.db
      .select({ id: schema.entitlementTemplate.id })
      .from(schema.entitlementTemplate)
      .where(eq(schema.entitlementTemplate.leaveTypeId, lt.id));
    expect(still, 'a refused delete cascades nothing').toHaveLength(1);
  });
});

/**
 * 3214cb11 / 813fd22a — THE ORDER THE READ HANDS BACK, through real Postgres.
 *
 * lib/entitlement-table-order.ts is unit-tested on its own (test/entitlement-table-order.test.ts). This
 * case is the other half: that `listEntitlementTemplates` — the ONE read behind both reported surfaces
 * — actually applies it, against the database rather than an array. The comparator could be perfect and
 * the screens still scrambled if the query's `orderBy` were the last word, and that is precisely the
 * shape of the bug being fixed.
 *
 * The sixteen names are production's, read from `entitlement_template` on 2026-08-13, and the expected
 * order is the reporter's list position for position.
 */
describe('3214cb11 / 813fd22a — listEntitlementTemplates returns HR’s order, not A-to-Z', () => {
  const REPORTERS_ORDER = [
    'PERMANENT - GRADE H',
    'PERMANENT - GRADE 12 - 15',
    'PERMANENT - GRADE 16 - 19',
    'PERMANENT - GRADE 20 - 23',
    'CONTRACT - GRADE H',
    'CONTRACT - GRADE 12 - 18',
    'CONTRACT - GRADE >= 19',
    'CONTRACT - SPECIAL (40 AL)',
    'CONTRACT - GRADE H (SPECIAL)',
    'CONTRACT - GRADE 12 - 18 (SPECIAL)',
    'CONTRACT - GRADE >= 19 (SPECIAL)',
    'CONTRACT - GRADE H (RETIREE)',
    'CONTRACT - GRADE 12 - 15 (RETIREE)',
    'CONTRACT - GRADE 16 - 19 (RETIREE)',
    'CONTRACT - GRADE 20 - 23 (RETIREE)',
    'PART TIMER',
  ];

  it('the sixteen Annual Leave tables come back in the requested order, whatever order they were created in', async () => {
    const ctx = adminCtx(b);
    // Created in A-to-Z order — the order the old query returned, so a read that ignored the comparator
    // would hand back exactly the scrambled list the reporter photographed and still "pass" by accident.
    for (const name of [...REPORTERS_ORDER].sort((x, y) => x.localeCompare(y))) {
      await createEntitlementTemplate(ctx, {
        leaveTypeId: b.annualLeaveTypeId,
        name,
        serviceBands: flat(14),
        validFrom: '2026-01-01',
      });
    }
    const rows = await listEntitlementTemplates(ctx, { leaveTypeId: b.annualLeaveTypeId });
    expect(rows.map((r) => r.name)).toEqual(REPORTERS_ORDER);
  });

  it('the SAME read feeds the eligibility select, so both surfaces get that order', async () => {
    // The select is built from the RUNNING versions of this very list (entitlement-tables-block.tsx:
    // `running = templates.filter(...)` → `templateOptions`). Filtering preserves order, so pinning the
    // running slice here is pinning what the dropdown shows.
    const ctx = adminCtx(b);
    for (const name of ['PART TIMER', 'CONTRACT - GRADE H', 'PERMANENT - GRADE H']) {
      await createEntitlementTemplate(ctx, {
        leaveTypeId: b.annualLeaveTypeId,
        name,
        serviceBands: flat(14),
        validFrom: '2026-01-01',
      });
    }
    const running = (await listEntitlementTemplates(ctx, { leaveTypeId: b.annualLeaveTypeId })).filter(
      (r) => r.validTo == null,
    );
    expect(running.map((r) => r.name)).toEqual([
      'PERMANENT - GRADE H',
      'CONTRACT - GRADE H',
      'PART TIMER',
    ]);
  });

  it('two versions of one table stay in date order under their shared name', async () => {
    const ctx = adminCtx(b);
    const v1 = await createEntitlementTemplate(ctx, {
      leaveTypeId: b.annualLeaveTypeId,
      name: 'PERMANENT - GRADE H',
      serviceBands: flat(14),
      validFrom: '2024-01-01',
    });
    await updateEntitlementTemplate(ctx, {
      lineageId: v1.lineageId,
      serviceBands: flat(18),
      validFrom: '2026-01-01',
    });
    const rows = await listEntitlementTemplates(ctx, { leaveTypeId: b.annualLeaveTypeId });
    expect(rows.map((r) => r.validFrom)).toEqual(['2024-01-01', '2026-01-01']);
  });
});
