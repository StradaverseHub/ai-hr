/**
 * 0fe1ca2e ROUND B — the claims behind scripts/report-location-criteria-usage.ts.
 *
 * The report tells the reporter what a saved notice, leave adjustment, entitlement rule or generation run
 * would target once the work-site criteria axis (`locationIds`, core/org-criteria.ts:79) is gone. Its whole
 * value rests on a handful of statements about `resolveOrgCriteriaTargets` that a report cannot prove about
 * itself, so they are pinned here instead — on a fixture shaped like the production one (a site with people
 * at it, a site with nobody, and an employee at no site at all).
 *
 * WHAT IS PINNED, and why each one is the report being honest rather than reassuring:
 *   1. NON-VACUITY — the axis really does narrow today. Take the `locationIds` entry out of
 *      ORG_DATED_ASSIGNMENT_CRITERIA and this is the assertion that goes red; without it every other
 *      "BEFORE == AFTER" in the report would be a true statement about a predicate that never ran.
 *   2. AFTER ⊇ BEFORE — removing an axis can only widen. The report prints a MODEL BROKEN flag when a
 *      record loses somebody, and this is the rule that flag is checking against.
 *   3. AN EMPTY LIST IS ALREADY NO RESTRICTION — `{ locationIds: [] }` resolves exactly like `{}`. The
 *      report counts these separately (EMPTY AXIS) instead of dropping them, and that is only correct if
 *      they genuinely narrow nobody.
 *   4. A DANGLING SITE ID MATCHES NOBODY — the worst case in the report, because the record is already
 *      dead and removal resurrects it onto the full population.
 *   5. THE OBJECT BECOMES "EVERYONE" — `isUnrestrictedOrgCriteria` flips from false to true when the site
 *      was the only axis. That flip is the WIDENS TO EVERYONE flag, and it is the plan's own warning.
 *   6. THE APPROVAL-TEMPLATE REFUSAL IS REAL — a rule narrowing by work site is refused for approval-
 *      template assignment TODAY (core/leave-approval-template.ts:579, whose assignable set is
 *      companyIds / employmentTypes / gradeIds). Removing the axis silently withdraws that refusal, which
 *      is a consequence the brief and the plan both miss.
 *   7. `employmentIds: []` IS NOT "NOBODY" — it is NO RESTRICTION, so a cross-tenant script that passes an
 *      empty array asks about every tenant at once. The report guards this; the guard is only load-bearing
 *      if the footgun is real.
 *   8. THE AXIS IS EVALUATED AS AT A DATE — an employee who has since moved site is still selected by where
 *      they were on `asOf`. This is why the report resolves each stored record at ITS OWN date rather than
 *      at today.
 *
 * Dates are HISTORICAL and derived from a fixed hire date: no hardcoded future dates, and nothing here
 * moves when the clock does.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as schema from '../db/schema';
import { withTenant } from '../db/client';
import { listEligibilityRuleScopes } from '../core/leave-approval-template';
import { createLocation } from '../core/location';
import { hireEmployee } from '../core/org';
import {
  isUnrestrictedOrgCriteria,
  narrowedOrgCriteriaAxes,
  resolveOrgCriteriaTargets,
  type OrgCriteria,
} from '../core/org-criteria';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const HIRED = '2024-01-01';
const BEFORE_MOVE = '2024-06-30'; // everybody still at the site they were hired into
const AFTER_MOVE = '2025-06-30'; // after `mover` has been transferred to the second site
const MOVED_ON = '2025-01-01';

let b: Base;
let siteA = ''; // has `atA` and (until MOVED_ON) `mover`
let siteB = ''; // has `mover` from MOVED_ON
let atA = '';
let mover = '';
let atNoSite = '';

beforeAll(async () => {
  await migrateTestDb();
  await resetDb();
  b = await seedBase();
  const ctx = adminCtx(b);

  const a = await createLocation(ctx, { companyId: b.companyId, code: 'SITE-A', name: 'Site A', state: 'Selangor' });
  const bb = await createLocation(ctx, { companyId: b.companyId, code: 'SITE-B', name: 'Site B', state: 'Sarawak' });
  siteA = a.id;
  siteB = bb.id;

  const hire = async (label: string) => {
    const e = await hireEmployee(ctx, {
      person: { fullName: label, primaryEmail: `${label}_${randomUUID().slice(0, 8)}@t.local` },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: HIRED,
    });
    return e.employmentId;
  };
  // The OPEN assignment row is what the resolver's dated exists() reads; set the site on it directly, the
  // same way test/location-holiday-whatif.test.ts does, so nothing here depends on a transfer service.
  const putAtSite = (employmentId: string, locationId: string) =>
    owner.db
      .update(schema.assignment)
      .set({ locationId })
      .where(
        and(
          eq(schema.assignment.employmentId, employmentId),
          isNull(schema.assignment.validTo),
          isNull(schema.assignment.supersededAt),
        ),
      );

  atA = await hire('atA');
  await putAtSite(atA, siteA);
  atNoSite = await hire('atNoSite');

  // `mover` is the dated case: at Site A from the hire date until MOVED_ON, at Site B from MOVED_ON on.
  // Two assignment rows, an explicit closed window and an open one, because "as at asOf" is only testable
  // when the history is actually there.
  mover = await hire('mover');
  await owner.db
    .update(schema.assignment)
    .set({ locationId: siteA, validTo: '2024-12-31' })
    .where(
      and(
        eq(schema.assignment.employmentId, mover),
        isNull(schema.assignment.validTo),
        isNull(schema.assignment.supersededAt),
      ),
    );
  const [old] = await owner.db
    .select()
    .from(schema.assignment)
    .where(eq(schema.assignment.employmentId, mover));
  await owner.db.insert(schema.assignment).values({
    ...old,
    id: undefined as unknown as string,
    locationId: siteB,
    validFrom: MOVED_ON,
    validTo: null,
  });
});

afterAll(closeAll);

const resolve = (criteria: OrgCriteria, asOf: string, employmentIds?: string[]) =>
  withTenant(adminCtx(b), (tx) => resolveOrgCriteriaTargets(tx, { criteria, asOf, employmentIds }));

/** The report's own AFTER: the SAME stored object with the one key deleted. Nothing else changes. */
const withoutAxis = (c: OrgCriteria): OrgCriteria => {
  const out = { ...c };
  delete (out as Record<string, unknown>).locationIds;
  return out;
};

describe('0fe1ca2e — removing the work-site criteria axis', () => {
  it('1. NON-VACUITY: the axis narrows TODAY — it is not already a dead key', async () => {
    const everyone = await resolve({}, BEFORE_MOVE);
    // Three hires plus whatever seedBase created; the point is only that there is more than one person.
    expect(everyone.length).toBeGreaterThan(1);
    expect(everyone).toEqual(expect.arrayContaining([atA, mover, atNoSite]));

    const atSiteA = await resolve({ locationIds: [siteA] }, BEFORE_MOVE);
    // ⚠️ THIS IS THE MUTATION TARGET. Delete `{ key: 'locationIds', column: 'locationId' }` from
    // ORG_DATED_ASSIGNMENT_CRITERIA (core/org-criteria.ts:79) and this line fails: the criteria object
    // stops narrowing and `atSiteA` becomes `everyone`. Every "nothing moves" the report can print is
    // worthless unless this holds.
    expect(atSiteA.sort()).toEqual([atA, mover].sort());
    expect(atSiteA).not.toContain(atNoSite);
    expect(atSiteA.length).toBeLessThan(everyone.length);

    // And it is the criteria vocabulary's own idea of "set", which is what drives the report's
    // "narrows by" line and its EMPTY AXIS count.
    expect(narrowedOrgCriteriaAxes({ locationIds: [siteA] })).toEqual(['locationIds']);
  });

  it('2. AFTER ⊇ BEFORE: removing the axis widens and can never lose anybody (the MODEL BROKEN rule)', async () => {
    const stored: OrgCriteria = { locationIds: [siteA] };
    const before = await resolve(stored, BEFORE_MOVE);
    const after = await resolve(withoutAxis(stored), BEFORE_MOVE);

    const lost = before.filter((id) => !after.includes(id));
    expect(lost).toEqual([]); // the invariant the report's MODEL BROKEN flag checks
    const gained = after.filter((id) => !before.includes(id));
    expect(gained).toContain(atNoSite); // somebody who was excluded is now reached
    expect(after.length).toBeGreaterThan(before.length);
  });

  it('3. EMPTY AXIS: `locationIds: []` already narrows nobody, so its removal is a no-op', async () => {
    const empty = await resolve({ locationIds: [] }, BEFORE_MOVE);
    const none = await resolve({}, BEFORE_MOVE);
    expect(empty.sort()).toEqual(none.sort());
    // …and the vocabulary agrees: an empty list is not a narrowing, which is why the report counts these
    // records under EMPTY AXIS rather than under WIDENS.
    expect(narrowedOrgCriteriaAxes({ locationIds: [] })).toEqual([]);
    expect(isUnrestrictedOrgCriteria({ locationIds: [] })).toBe(true);
  });

  it('4. DANGLING SITE: a criteria object naming a site that no longer exists matches NOBODY', async () => {
    const ghost = randomUUID();
    const before = await resolve({ locationIds: [ghost] }, BEFORE_MOVE);
    expect(before).toEqual([]);

    // …and removal takes it from nobody to everybody in one step. This is the largest jump the change can
    // produce, and the reason the report flags it by name.
    const after = await resolve(withoutAxis({ locationIds: [ghost] }), BEFORE_MOVE);
    expect(after.length).toBeGreaterThan(0);
    expect(after).toEqual(expect.arrayContaining([atA, mover, atNoSite]));
  });

  it('5. WIDENS TO EVERYONE: the object flips from restricted to unrestricted when the site was its only axis', () => {
    expect(isUnrestrictedOrgCriteria({ locationIds: [siteA] })).toBe(false);
    expect(isUnrestrictedOrgCriteria(withoutAxis({ locationIds: [siteA] }))).toBe(true);
    // A record that narrows by something else too does NOT become everyone — the report must not cry wolf.
    const alsoDept: OrgCriteria = { locationIds: [siteA], departmentIds: [b.deptA] };
    expect(isUnrestrictedOrgCriteria(withoutAxis(alsoDept))).toBe(false);
  });

  it('6. APPROVAL UNBLOCK: a rule narrowing by work site is REFUSED for approval templates today', async () => {
    const ctx = adminCtx(b);
    const lineageId = randomUUID();
    await owner.db.insert(schema.entitlementEligibilityRule).values({
      tenantId: b.tenantId,
      lineageId,
      name: 'Site A staff',
      templateLineageId: randomUUID(),
      criteria: { locationIds: [siteA] } as unknown as never,
      validFrom: HIRED,
      validTo: null,
    });

    const scopes = await listEligibilityRuleScopes(ctx);
    const mine = scopes.find((s) => s.lineageId === lineageId);
    expect(mine).toBeDefined();
    // The refusal names the axis, in the operator's words, and leaves the scope list EMPTY.
    expect(mine!.refusal).toContain('location');
    expect(mine!.scopes).toEqual([]);

    // ⚠️ AND THIS IS THE CONSEQUENCE NOBODY ASKED FOR. The refusal exists because the rule narrows by an
    // axis a `leave_approval_policy` row has no column for. Take the axis away and the same stored object
    // narrows by NOTHING the refusal can object to — so the rule becomes silently assignable, and
    // assigning it gives the approval template to every employee the rule was written to leave out.
    const assignable = ['companyIds', 'employmentTypes', 'gradeIds'];
    expect(narrowedOrgCriteriaAxes({ locationIds: [siteA] }).filter((a) => !assignable.includes(a))).toEqual([
      'locationIds',
    ]);
    expect(narrowedOrgCriteriaAxes(withoutAxis({ locationIds: [siteA] })).filter((a) => !assignable.includes(a))).toEqual(
      [],
    );

    await owner.db
      .delete(schema.entitlementEligibilityRule)
      .where(eq(schema.entitlementEligibilityRule.lineageId, lineageId));
  });

  it('7. THE FOOTGUN: `employmentIds: []` is NO RESTRICTION, not "nobody"', async () => {
    // core/org-criteria.ts: "an empty / absent array means NO RESTRICTION". A cross-tenant report that
    // passed an empty array for a tenant with no employments would therefore ask about EVERY tenant at
    // once. scripts/report-location-criteria-usage.ts short-circuits to [] before the call; this is the
    // behaviour that makes the short-circuit necessary rather than decorative.
    const unrestricted = await resolve({}, BEFORE_MOVE);
    const withEmptyList = await resolve({}, BEFORE_MOVE, []);
    expect(withEmptyList.sort()).toEqual(unrestricted.sort());
    expect(withEmptyList.length).toBeGreaterThan(0);

    // A NON-empty list really is a restriction, so the pattern the report uses is sound.
    const scoped = await resolve({}, BEFORE_MOVE, [atNoSite]);
    expect(scoped).toEqual([atNoSite]);
  });

  it('8. AS AT A DATE: the site is read from the assignment in force on `asOf`, not from today', async () => {
    // `mover` was at Site A until 2024-12-31 and at Site B from 2025-01-01.
    const aThen = await resolve({ locationIds: [siteA] }, BEFORE_MOVE);
    expect(aThen).toContain(mover);
    const aNow = await resolve({ locationIds: [siteA] }, AFTER_MOVE);
    expect(aNow).not.toContain(mover);
    const bNow = await resolve({ locationIds: [siteB] }, AFTER_MOVE);
    expect(bNow).toContain(mover);

    // Which is exactly why the report resolves each stored record at ITS OWN date: a batch effective in
    // 2024 asks a different question from the same object read today, and answering the wrong one would
    // hand the reporter a before/after for a selection that never happened.
    expect(aThen.sort()).not.toEqual(aNow.sort());
  });
});
