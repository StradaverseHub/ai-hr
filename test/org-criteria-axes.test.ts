/**
 * 18103ba4 — the criteria axes the Leave Adjustments step flow added to the SHARED resolver.
 *
 * The reporter asked Step 2 to narrow on ~30 fields; the screen offered eleven. This file covers the ones
 * that were added, and it exists mostly to pin the two properties that are easy to get wrong and impossible
 * to notice afterwards:
 *
 *  1. EVERY AXIS IS EVALUATED AS AT `asOf`. Department and employment type always were, because they live
 *     on the effective-dated `assignment` row. The four axes added from that same row must go through the
 *     SAME window, and the two DERIVED axes (employee status, confirmation status) plus the years-of-service
 *     band must be computed against `asOf` too. An axis read "as of now" while its neighbours read "as of
 *     the effective date" produces a target set nobody can reproduce — and a bulk adjustment that cannot be
 *     reproduced cannot honestly be reversed either.
 *
 *  2. THE NOTICE BOARD'S ANSWER IS UNCHANGED. 6e122302 lifted this resolver out of core/leave-adjustment.ts
 *     precisely so there would be ONE definition of "who does this apply to"; widening it for a leave screen
 *     is only safe if a notice-shaped criteria set still selects exactly the people it selected before. It
 *     does, because an axis nobody posts is an EMPTY axis and an empty axis is no restriction — the last
 *     describe block builds a fixture where every new axis WOULD discriminate and then shows a
 *     notice-shaped query stepping straight over all of them.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import {
  isUnrestrictedOrgCriteria,
  orgCriteriaFromFields,
  resolveOrgCriteriaTargets,
  type OrgCriteria,
} from '../core/org-criteria';
import { withTenant } from '../db/client';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(closeAll);

async function hire(name: string, opts: { hiredOn?: string; gradeId?: string; positionId?: string } = {}) {
  const e = await hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `axes_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: opts.hiredOn ?? '2020-01-01',
    gradeId: opts.gradeId,
    positionId: opts.positionId,
  });
  return e.employmentId;
}

const resolve = (criteria: OrgCriteria, asOf = '2026-06-01') =>
  withTenant(adminCtx(b), (tx) => resolveOrgCriteriaTargets(tx, { criteria, asOf }));

/** The open assignment row hireEmployee created (validTo null). */
async function openAssignmentId(employmentId: string): Promise<string> {
  const [row] = await owner.db
    .select({ id: schema.assignment.id })
    .from(schema.assignment)
    .where(eq(schema.assignment.employmentId, employmentId));
  return row.id;
}

async function makeCostCenter(code: string): Promise<string> {
  const [cc] = await owner.db
    .insert(schema.costCenter)
    .values({ tenantId: b.tenantId, companyId: b.companyId, code, name: `${code} centre` })
    .returning({ id: schema.costCenter.id });
  return cc.id;
}

describe('18103ba4 · the four ASSIGNMENT axes are resolved AS AT the date, like department already was', () => {
  it('cost centre follows the assignment in force on the date, not today’s', async () => {
    // The failure this pins: an adjustment backdated to before a transfer must select the people who were
    // in that cost centre THEN. Reading the CURRENT assignment row would quietly act on a different set of
    // people from the one the administrator described — the exact defect the department join already avoids.
    const e = await hire('Transferred');
    const oldCc = await makeCostCenter('CCOLD');
    const newCc = await makeCostCenter('CCNEW');
    const first = await openAssignmentId(e);
    await owner.db
      .update(schema.assignment)
      .set({ costCenterId: oldCc, validFrom: '2020-01-01', validTo: '2026-03-31' })
      .where(eq(schema.assignment.id, first));
    await owner.db.insert(schema.assignment).values({
      tenantId: b.tenantId,
      employmentId: e,
      departmentId: b.deptA,
      costCenterId: newCc,
      employmentType: 'full_time',
      validFrom: '2026-04-01',
      validTo: null,
    });

    expect(await resolve({ costCenterIds: [oldCc] }, '2026-01-15')).toContain(e);
    expect(await resolve({ costCenterIds: [oldCc] }, '2026-06-01')).not.toContain(e);
    expect(await resolve({ costCenterIds: [newCc] }, '2026-06-01')).toContain(e);
    expect(await resolve({ costCenterIds: [newCc] }, '2026-01-15')).not.toContain(e);
  });

  it('business unit and position narrow on the dated row; ADR-0086 — the SITE no longer does', async () => {
    const [bu] = await owner.db
      .insert(schema.businessUnit)
      .values({ tenantId: b.tenantId, companyId: b.companyId, code: 'BU1', name: 'Shared Services' })
      .returning({ id: schema.businessUnit.id });
    const [loc] = await owner.db
      .insert(schema.location)
      .values({ tenantId: b.tenantId, companyId: b.companyId, code: 'HQ', name: 'Head Office' })
      .returning({ id: schema.location.id });
    const inScope = await hire('InBU', { positionId: b.positionId });
    const outOfScope = await hire('NoBU');
    await owner.db
      .update(schema.assignment)
      .set({ businessUnitId: bu.id, locationId: loc.id })
      .where(eq(schema.assignment.id, await openAssignmentId(inScope)));

    expect(await resolve({ businessUnitIds: [bu.id] })).toEqual([inScope]);
    expect(await resolve({ positionIds: [b.positionId] })).toEqual([inScope]);
    expect(await resolve({})).toEqual(expect.arrayContaining([inScope, outOfScope]));

    // ⚠️ UPDATED, NOT DELETED (CLAUDE.md §8). `{ locationIds: [loc.id] }` used to select exactly
    // [inScope], like its two neighbours above. ADR-0086 (item 0fe1ca2e, r331) retired the work-site axis
    // with the work-site register — the key is no longer declared on OrgCriteria, and a legacy stored
    // object that still carries it (as every record saved before r331 does) narrows nobody. The site is
    // still set on the dated row, so this is the resolver changing rather than the fixture.
    const legacy = { locationIds: [loc.id] } as unknown as OrgCriteria;
    expect(await resolve(legacy)).toEqual(await resolve({}));
    expect(await resolve(legacy)).toEqual(expect.arrayContaining([inScope, outOfScope]));
  });

  it('AND-combines the dated axes on ONE assignment row', async () => {
    // "was in Finance, at HQ" must mean one assignment satisfying both — not "was in Finance at some point
    // and at HQ at some other point".
    const ccA = await makeCostCenter('CCA');
    const ccB = await makeCostCenter('CCB');
    const e = await hire('Split');
    const first = await openAssignmentId(e);
    await owner.db
      .update(schema.assignment)
      .set({ costCenterId: ccA, departmentId: b.deptA, validFrom: '2020-01-01', validTo: '2026-03-31' })
      .where(eq(schema.assignment.id, first));
    await owner.db.insert(schema.assignment).values({
      tenantId: b.tenantId,
      employmentId: e,
      departmentId: b.deptB,
      costCenterId: ccB,
      employmentType: 'full_time',
      validFrom: '2026-04-01',
      validTo: null,
    });
    // Finance (deptA) + CCB never co-existed on a single row.
    expect(await resolve({ departmentIds: [b.deptA], costCenterIds: [ccB] }, '2026-06-01')).toEqual([]);
    expect(await resolve({ departmentIds: [b.deptB], costCenterIds: [ccB] }, '2026-06-01')).toEqual([e]);
  });
});

describe('18103ba4 · job grade and the person demographics', () => {
  it('narrows by job grade', async () => {
    const [g] = await owner.db
      .insert(schema.jobGrade)
      .values({ tenantId: b.tenantId, code: 'G5', name: 'Grade 5', rank: 5 })
      .returning({ id: schema.jobGrade.id });
    const graded = await hire('Graded', { gradeId: g.id });
    const ungraded = await hire('Ungraded');
    expect(await resolve({ gradeIds: [g.id] })).toEqual([graded]);
    expect(await resolve({})).toEqual(expect.arrayContaining([graded, ungraded]));
  });

  it('narrows by gender / nationality / religion / race, which live on person', async () => {
    const her = await hire('Her');
    const him = await hire('Him');
    const setPerson = async (employmentId: string, patch: Record<string, string>) => {
      const [row] = await owner.db
        .select({ personId: schema.employment.personId })
        .from(schema.employment)
        .where(eq(schema.employment.id, employmentId));
      await owner.db.update(schema.person).set(patch).where(eq(schema.person.id, row.personId));
    };
    await setPerson(her, { gender: 'female', nationality: 'MY', religion: 'Buddhist', race: 'Chinese' });
    await setPerson(him, { gender: 'male', nationality: 'SG', religion: 'Hindu', race: 'Indian' });

    expect(await resolve({ genders: ['female'] })).toEqual([her]);
    expect(await resolve({ nationalities: ['SG'] })).toEqual([him]);
    expect(await resolve({ religions: ['Buddhist'] })).toEqual([her]);
    expect(await resolve({ races: ['Indian'] })).toEqual([him]);
    // OR within a field, AND across fields — the semantics the whole vocabulary shares.
    expect(await resolve({ genders: ['male', 'female'] })).toEqual(expect.arrayContaining([her, him]));
    expect(await resolve({ genders: ['female'], nationalities: ['SG'] })).toEqual([]);
  });
});

describe('18103ba4 · the DERIVED axes, computed as at the date rather than stored', () => {
  it('employee status is the bucket the employee was in ON the effective date', async () => {
    const e = await hire('Probationer');
    await owner.db
      .update(schema.employment)
      .set({ finalConfirmationDate: '2026-03-01' })
      .where(eq(schema.employment.id, e));

    // Before confirmation they are on probation; after it they are active. Same employment, same row —
    // only the date the question is asked about changes, which is the entire point of a derived status.
    expect(await resolve({ employmentStatuses: ['probation'] }, '2026-01-15')).toEqual([e]);
    expect(await resolve({ employmentStatuses: ['probation'] }, '2026-06-01')).toEqual([]);
    expect(await resolve({ employmentStatuses: ['active'] }, '2026-06-01')).toEqual([e]);
    expect(await resolve({ employmentStatuses: ['active'] }, '2026-01-15')).toEqual([]);
  });

  it('confirmation status is the SAME rule as the status ladder’s probation branch', async () => {
    const unconfirmed = await hire('Unconfirmed');
    const confirmed = await hire('Confirmed');
    await owner.db
      .update(schema.employment)
      .set({ finalConfirmationDate: '2026-09-01' })
      .where(eq(schema.employment.id, unconfirmed));
    await owner.db
      .update(schema.employment)
      .set({ finalConfirmationDate: '2021-01-01' })
      .where(eq(schema.employment.id, confirmed));

    expect(await resolve({ confirmationStatuses: ['probation'] })).toEqual([unconfirmed]);
    expect(await resolve({ confirmationStatuses: ['confirmed'] })).toEqual([confirmed]);
    // …and the two agree with the status axis, which is why there is one coalesce and not two.
    expect(await resolve({ employmentStatuses: ['probation'] })).toEqual([unconfirmed]);
    // Exhaustive: picking both restricts nothing.
    expect(await resolve({ confirmationStatuses: ['confirmed', 'probation'] })).toEqual(
      expect.arrayContaining([unconfirmed, confirmed]),
    );
  });

  it('an employment with NO confirmation date recorded reads as confirmed, matching deriveEmploymentStatus', async () => {
    const e = await hire('NeverConfirmed');
    expect(await resolve({ confirmationStatuses: ['confirmed'] })).toEqual([e]);
    expect(await resolve({ confirmationStatuses: ['probation'] })).toEqual([]);
  });
});

describe('18103ba4 · hire date and years of service', () => {
  it('narrows by a hire-date band', async () => {
    const old = await hire('Veteran', { hiredOn: '2015-05-05' });
    const recent = await hire('Newcomer', { hiredOn: '2025-05-05' });
    expect(await resolve({ hiredFrom: '2020-01-01' })).toEqual([recent]);
    expect(await resolve({ hiredTo: '2020-01-01' })).toEqual([old]);
    expect(await resolve({ hiredFrom: '2010-01-01', hiredTo: '2030-01-01' })).toEqual(
      expect.arrayContaining([old, recent]),
    );
  });

  it('YEARS OF SERVICE IS COUNTED TO THE EFFECTIVE DATE, and turns over on the anniversary', async () => {
    // The boundary is the claim the SQL makes: extract(year from age(asOf, hired_on)) is whole COMPLETED
    // years, the same day-of-month rule as monthsBetween/12 in core/leave.ts. Hired 2020-06-15, so on
    // 2026-06-14 they have completed 5 years and on 2026-06-15 they have completed 6.
    const e = await hire('Server', { hiredOn: '2020-06-15' });
    expect(await resolve({ minYearsOfService: 6 }, '2026-06-14')).toEqual([]);
    expect(await resolve({ minYearsOfService: 6 }, '2026-06-15')).toEqual([e]);
    expect(await resolve({ maxYearsOfService: 5 }, '2026-06-14')).toEqual([e]);
    expect(await resolve({ maxYearsOfService: 5 }, '2026-06-15')).toEqual([]);
  });

  it('bands together — "between 3 and 5 years" as at the effective date', async () => {
    const four = await hire('FourYears', { hiredOn: '2022-01-01' });
    const ten = await hire('TenYears', { hiredOn: '2016-01-01' });
    expect(await resolve({ minYearsOfService: 3, maxYearsOfService: 5 }, '2026-06-01')).toEqual([four]);
    expect(await resolve({ minYearsOfService: 6 }, '2026-06-01')).toEqual([ten]);
  });
});

describe('18103ba4 · the form reader and the "this means everyone" guard', () => {
  it('reads the range fields only when a `get` accessor is supplied', () => {
    const getAll = (n: string) => (n === 'companyIds' ? ['c1'] : []);
    const get = (n: string) =>
      ({ hiredFrom: '2020-01-01', minYearsOfService: '3', maxYearsOfService: '', hiredTo: 'not-a-date' })[n] ?? null;

    // The Notice Board's existing ONE-ARGUMENT call keeps meaning exactly what it did: no ranges.
    expect(orgCriteriaFromFields(getAll)).toEqual({ companyIds: ['c1'] });
    // With a `get`, well-formed values land and malformed ones are dropped rather than silently matching
    // nobody — a half-typed date box posts things like '0002-01-01' on every keystroke.
    expect(orgCriteriaFromFields(getAll, get)).toEqual({
      companyIds: ['c1'],
      hiredFrom: '2020-01-01',
      minYearsOfService: 3,
    });
  });

  it('a range-only criteria set is NOT "everyone"', () => {
    // The screen greets an unrestricted set with "this applies to EVERY employee". A set that says
    // "hired since 2024" is emphatically not that, and saying so would be lying to the operator.
    expect(isUnrestrictedOrgCriteria({})).toBe(true);
    expect(isUnrestrictedOrgCriteria({ hiredFrom: '2024-01-01' })).toBe(false);
    expect(isUnrestrictedOrgCriteria({ minYearsOfService: 3 })).toBe(false);
    expect(isUnrestrictedOrgCriteria({ genders: ['female'] })).toBe(false);
    expect(isUnrestrictedOrgCriteria({ companyIds: [] })).toBe(true);
  });
});

describe('18103ba4 · THE NOTICE BOARD RESOLVES THE SAME PEOPLE IT ALWAYS DID', () => {
  it('a notice-shaped criteria set steps over every new axis', async () => {
    // A fixture where all of the new axes WOULD discriminate if they were being applied by accident:
    // different grades, genders, hire dates, cost centres and confirmation dates across two employees who
    // are alike only in department. A criteria set using ONLY the field names the Notice Board posts must
    // still select both of them.
    const [g] = await owner.db
      .insert(schema.jobGrade)
      .values({ tenantId: b.tenantId, code: 'G9', name: 'Grade 9', rank: 9 })
      .returning({ id: schema.jobGrade.id });
    const cc = await makeCostCenter('CCX');
    const one = await hire('One', { hiredOn: '2015-01-01', gradeId: g.id });
    const two = await hire('Two', { hiredOn: '2025-01-01' });
    await owner.db
      .update(schema.assignment)
      .set({ costCenterId: cc })
      .where(eq(schema.assignment.id, await openAssignmentId(one)));
    await owner.db
      .update(schema.employment)
      .set({ finalConfirmationDate: '2026-12-01' })
      .where(eq(schema.employment.id, two));

    const noticeShaped: OrgCriteria = { companyIds: [b.companyId], departmentIds: [b.deptA] };
    expect((await resolve(noticeShaped, '2026-06-01')).sort()).toEqual([one, two].sort());
    // …and the empty set still means everyone, which is the property every caller's confirm-the-count
    // discipline is built on.
    expect((await resolve({}, '2026-06-01')).sort()).toEqual([one, two].sort());
  });

  it('the reader the Notice Board calls produces the same object it always produced', () => {
    // Its action calls orgCriteriaFromFields(list) with ONE argument over the field names its form posts.
    // Adding names to ORG_CRITERIA_FIELDS can only add keys for fields that are actually posted, and the
    // notice form posts none of the new ones — so the object is byte-identical.
    const noticeForm: Record<string, string[]> = {
      companyIds: ['c1'],
      departmentIds: ['d1'],
      employmentTypes: ['full_time'],
      orgDivision: ['North'],
    };
    expect(orgCriteriaFromFields((n) => noticeForm[n] ?? [])).toEqual(noticeForm);
  });
});
