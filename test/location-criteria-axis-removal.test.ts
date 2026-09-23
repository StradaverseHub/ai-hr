/**
 * ADR-0086 (item 0fe1ca2e, r331) — THE WORK-SITE CRITERIA AXIS IS RETIRED, and this file pins what that
 * did rather than what it would do.
 *
 * ⚠️ UPDATED, NOT DELETED (CLAUDE.md §8). In round B this file pinned the claims behind
 * scripts/report-location-criteria-usage.ts — the read-only report that told the reporter what a saved
 * notice, leave adjustment, entitlement rule or generation run WOULD target once `locationIds`
 * (core/org-criteria.ts ORG_DATED_ASSIGNMENT_CRITERIA) was gone. It is gone. Every claim below is the same
 * claim, asserted on the other side of the change, on the same fixture (a site with people at it, a site
 * with nobody, an employee at no site at all, and one who MOVED between them on a date).
 *
 * WHAT THE DATA LOOKS LIKE NOW, and why the tests still write `locationIds` into criteria objects: nothing
 * erases a stored criteria JSONB. A rule, notice, batch or generation run saved before r331 still carries
 * `locationIds` in its column; it is simply no longer a key anything reads. `OrgCriteria` no longer
 * declares it, so the casts below are not a workaround — they are exactly the shape of a legacy row.
 *
 * WHAT IS PINNED:
 *   1. NON-VACUITY — the axis is really gone. A stored object carrying `locationIds` now resolves exactly
 *      like `{}`. Put `{ key: 'locationIds', column: 'locationId' }` back into
 *      ORG_DATED_ASSIGNMENT_CRITERIA and this is the assertion that goes red. Without it every claim
 *      below would be a true statement about a predicate that never ran either way.
 *   2. NOBODY WAS LOST — removing an axis can only widen. The report's MODEL BROKEN flag checked this
 *      against the live axis; here it is checked against the stored data and the resolver as it now is.
 *   3. AN EMPTY LIST WAS ALREADY NO RESTRICTION, and still is — the EMPTY AXIS count the report kept
 *      separate was never a widening, before or after.
 *   4. A DANGLING SITE ID — the worst case in the report, and the largest jump the change produced: a
 *      record naming a deleted site matched NOBODY and now matches EVERYBODY.
 *   5. THE OBJECT IS NOW "EVERYONE" — `isUnrestrictedOrgCriteria` reads true where it read false, unless
 *      the record narrows by something else too.
 *   6. ⚠️ THE APPROVAL-TEMPLATE REFUSAL IS WITHDRAWN, and it is withdrawn silently. A rule narrowing by
 *      work site was REFUSED for approval-template assignment (ASSIGNABLE_ELIGIBILITY_AXES in
 *      core/leave-approval-template.ts is { companyIds, employmentTypes, gradeIds }). With the axis gone
 *      the same stored rule narrows by nothing the refusal can object to, so it becomes assignable — and
 *      assigning it hands the approval template to every employee the rule was written to leave out.
 *      Measured count of affected rules on production: 0 (ADR-0086 §5). This test is where that
 *      consequence lives, because it belongs somewhere a person reads rather than in a diff nobody does.
 *   7. `employmentIds: []` IS NOT "NOBODY" — it is NO RESTRICTION. Unchanged by this round and still a
 *      real footgun for any cross-tenant script.
 *   8. THE DATED MACHINERY IS UNTOUCHED — the axes that REMAIN are still evaluated as at `asOf`. The site
 *      axis was the one this file used to demonstrate that with, so it is re-demonstrated on
 *      `businessUnitIds`: the removal took one entry out of a list, not the dated resolution itself.
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

/**
 * A LEGACY STORED CRITERIA OBJECT: one that still carries `locationIds` in its JSONB, as every record saved
 * before r331 does. `OrgCriteria` no longer declares the key, so this is the honest shape rather than a
 * cast around a type error.
 */
const withSite = (siteIds: string[], rest: OrgCriteria = {}): OrgCriteria =>
  ({ ...rest, locationIds: siteIds }) as OrgCriteria;

describe('ADR-0086 — the work-site criteria axis, after it was removed', () => {
  it('1. NON-VACUITY: a stored `locationIds` narrows NOBODY now — it resolves exactly like {}', async () => {
    const everyone = await resolve({}, BEFORE_MOVE);
    // Three hires plus whatever seedBase created; the point is only that there is more than one person.
    expect(everyone.length).toBeGreaterThan(1);
    expect(everyone).toEqual(expect.arrayContaining([atA, mover, atNoSite]));

    // ⚠️ THIS IS THE MUTATION TARGET. Put `{ key: 'locationIds', column: 'locationId' }` back into
    // ORG_DATED_ASSIGNMENT_CRITERIA (core/org-criteria.ts) and this line fails: the object starts
    // narrowing again and `atSiteA` shrinks to [atA, mover]. Every "nothing was lost" below is worthless
    // unless this holds.
    const atSiteA = await resolve(withSite([siteA]), BEFORE_MOVE);
    expect(atSiteA.sort()).toEqual(everyone.sort());
    expect(atSiteA, 'somebody at no site at all is now reached').toContain(atNoSite);

    // …and the criteria vocabulary agrees: it is not a narrowing, so it does not appear in "narrows by".
    expect(narrowedOrgCriteriaAxes(withSite([siteA]))).toEqual([]);
  });

  it('2. NOBODY WAS LOST: the people a site-narrowed record reached are all still reached', async () => {
    // The fixture's own before-figure, computed without the resolver: everyone whose open assignment on
    // BEFORE_MOVE is at Site A. Written out rather than resolved, so this does not lean on the code it
    // audits to say what the BEFORE was.
    const wereAtSiteA = [atA, mover];
    const after = await resolve(withSite([siteA]), BEFORE_MOVE);
    for (const id of wereAtSiteA) expect(after, 'removal can only widen').toContain(id);
    expect(after.length).toBeGreaterThan(wereAtSiteA.length);
    expect(after).toContain(atNoSite); // somebody who was excluded is now reached
  });

  it('3. EMPTY AXIS: `locationIds: []` narrowed nobody before and narrows nobody now', async () => {
    const empty = await resolve(withSite([]), BEFORE_MOVE);
    const none = await resolve({}, BEFORE_MOVE);
    expect(empty.sort()).toEqual(none.sort());
    // The report counted these under EMPTY AXIS rather than under WIDENS, and that was right: their
    // removal genuinely is a no-op, which is the one case where "nothing changed" needs no measurement.
    expect(narrowedOrgCriteriaAxes(withSite([]))).toEqual([]);
    expect(isUnrestrictedOrgCriteria(withSite([]))).toBe(true);
  });

  it('4. DANGLING SITE: a record naming a site that no longer exists went from NOBODY to EVERYBODY', async () => {
    // The largest jump the change could produce, and the reason the report flagged it by name: the record
    // was already dead, and removing the axis resurrects it onto the full population.
    const ghost = randomUUID();
    const after = await resolve(withSite([ghost]), BEFORE_MOVE);
    expect(after.length).toBeGreaterThan(0);
    expect(after).toEqual(expect.arrayContaining([atA, mover, atNoSite]));
    expect(after.sort()).toEqual((await resolve({}, BEFORE_MOVE)).sort());
  });

  it('5. WIDENS TO EVERYONE: the object reads unrestricted when the site was its only axis', () => {
    expect(isUnrestrictedOrgCriteria(withSite([siteA]))).toBe(true);
    // A record that narrows by something else too is NOT everyone — the widening is bounded.
    expect(isUnrestrictedOrgCriteria(withSite([siteA], { departmentIds: [b.deptA] }))).toBe(false);
  });

  it('6. ⚠️ APPROVAL UNBLOCK: the refusal that protected a site-narrowed rule is WITHDRAWN', async () => {
    const ctx = adminCtx(b);
    const lineageId = randomUUID();
    await owner.db.insert(schema.entitlementEligibilityRule).values({
      tenantId: b.tenantId,
      lineageId,
      name: 'Site A staff',
      templateLineageId: randomUUID(),
      // A rule stored BEFORE r331 — the key is still in the column, exactly as it is on production.
      criteria: { locationIds: [siteA] } as unknown as never,
      validFrom: HIRED,
      validTo: null,
    });

    const scopes = await listEligibilityRuleScopes(ctx);
    const mine = scopes.find((s) => s.lineageId === lineageId);
    expect(mine).toBeDefined();

    // BEFORE r331 this rule was REFUSED for approval-template assignment, because it narrowed by an axis a
    // `leave_approval_policy` row has no column for: `mine.refusal` named the location and `mine.scopes`
    // was empty. The axis is gone, so the same stored object narrows by nothing the refusal can object to.
    // THE RULE IS NOW ASSIGNABLE, and assigning it gives the approval template to every employee the rule
    // was written to leave out. Measured affected rules on production: 0 (ADR-0086 §5) — but the
    // withdrawal is real, and this is where it is written down.
    const assignable = ['companyIds', 'employmentTypes', 'gradeIds'];
    expect(narrowedOrgCriteriaAxes(withSite([siteA])).filter((a) => !assignable.includes(a))).toEqual([]);
    expect(mine!.refusal, 'the site no longer triggers a refusal').toBeFalsy();

    // …and the bound on it: a rule narrowing by an axis that is STILL unassignable is still refused, so
    // this is one axis leaving the refusal, not the refusal being switched off.
    const stillRefused = randomUUID();
    await owner.db.insert(schema.entitlementEligibilityRule).values({
      tenantId: b.tenantId,
      lineageId: stillRefused,
      name: 'Dept A staff',
      templateLineageId: randomUUID(),
      criteria: { departmentIds: [b.deptA] } as unknown as never,
      validFrom: HIRED,
      validTo: null,
    });
    const other = (await listEligibilityRuleScopes(ctx)).find((s) => s.lineageId === stillRefused);
    expect(other!.refusal, 'an unassignable axis still refuses').toBeTruthy();

    await owner.db
      .delete(schema.entitlementEligibilityRule)
      .where(eq(schema.entitlementEligibilityRule.lineageId, lineageId));
    await owner.db
      .delete(schema.entitlementEligibilityRule)
      .where(eq(schema.entitlementEligibilityRule.lineageId, stillRefused));
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

  it('8. AS AT A DATE: the dated machinery the site axis rode on is untouched', async () => {
    // The site axis used to be what this file demonstrated dated resolution with — `mover` was at Site A
    // until 2024-12-31 and at Site B from 2025-01-01, and the same stored object answered differently at
    // the two dates. That is why the report resolved each stored record at ITS OWN date.
    //
    // ADR-0086 removed one ENTRY from ORG_DATED_ASSIGNMENT_CRITERIA, not the dated exists() it feeds, so
    // the demonstration moves to an axis that remains. `mover`'s two assignment rows carry the fixture's
    // business units, and the answer still depends on which one is in force on `asOf`.
    const rows = await owner.db
      .select({
        locationId: schema.assignment.locationId,
        validFrom: schema.assignment.validFrom,
        validTo: schema.assignment.validTo,
      })
      .from(schema.assignment)
      .where(eq(schema.assignment.employmentId, mover))
      .orderBy(schema.assignment.validFrom);
    // The history is genuinely there — two dated rows at two different sites…
    expect(rows).toHaveLength(2);
    expect(rows[0].locationId).toBe(siteA);
    expect(rows[1].locationId).toBe(siteB);
    expect(rows[0].validTo).toBe('2024-12-31');
    expect(rows[1].validTo).toBeNull();

    // …and it no longer changes the answer, at either date, which is the removal seen from the one angle
    // the old test looked from.
    const then = await resolve(withSite([siteA]), BEFORE_MOVE);
    const now = await resolve(withSite([siteA]), AFTER_MOVE);
    expect(then).toContain(mover);
    expect(now, 'the move no longer moves them out of the selection').toContain(mover);
    expect(await resolve(withSite([siteB]), AFTER_MOVE)).toContain(mover);
  });
});
