/**
 * 1fff489c PHASE 2 — Branch-driven location assignment.
 *
 * Branch is not a table: it is profile_option category 'branch' (a tenant-wide flat catalogue) stored as
 * free text on employment.org_branch. `location.branch` stores the same text, which is what makes the
 * resolver a plain equality join — and what makes the two rules asserted here load-bearing:
 *
 *   • the branch on a location is validated against the SAME catalogue employment.org_branch is, with the
 *     same legacy-value tolerance, so the two can never drift into different vocabularies; and
 *   • the mapping is unique PER COMPANY, not per tenant, because the catalogue is tenant-wide while
 *     locations are company-scoped. Two companies both mapping BUKIT JALIL to their own location is the
 *     normal case in the live tenant, not a conflict.
 *
 * Also covers the provenance stamp (branch_derived vs manual), the effective date the suggestion offers,
 * and the two ways a branch can fail to propose anything (unmapped, or mapped only to an archived site).
 */
import { and, eq, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { createCompany, createDepartment } from '../core/admin';
import { hireEmployee, setEmploymentInfo } from '../core/org';
import { createProfileOption } from '../core/profile-options';
import {
  archiveLocation,
  branchChangeDateFor,
  createLocation,
  listUnmappedBranches,
  LocationBranchTakenError,
  LocationCodeTakenError,
  recordLocationSource,
  resolveLocationForBranch,
  updateLocation,
} from '../core/location';

let b: Base;
const uniqEmail = () => `br_${randomUUID().slice(0, 8)}@t.local`;

const BUKIT = 'BUKIT JALIL';
const MENARA = 'MENARA CHIN HIN, 23ATH FLOOR';

const hire = (ctx: Parameters<typeof hireEmployee>[0], companyId: string, departmentId: string) =>
  hireEmployee(ctx, {
    person: { fullName: 'Branch Emp', primaryEmail: uniqEmail() },
    companyId,
    departmentId,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });

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

describe('location.branch — validated against the tenant branch catalogue', () => {
  it('accepts an ACTIVE catalogue value and stores it', async () => {
    const a = adminCtx(b);
    await createProfileOption(a, { category: 'branch', value: BUKIT });
    const { id } = await createLocation(a, { companyId: b.companyId, code: 'HQ', name: 'Headquarters', branch: BUKIT });
    const [row] = await owner.db.select().from(schema.location).where(eq(schema.location.id, id));
    expect(row.branch).toBe(BUKIT);
  });

  it('REFUSES a value that is not in the catalogue — the same rule setEmploymentInfo applies', async () => {
    const a = adminCtx(b);
    await createProfileOption(a, { category: 'branch', value: BUKIT });
    await expect(
      createLocation(a, { companyId: b.companyId, code: 'HQ', name: 'Headquarters', branch: 'MADE UP' }),
    ).rejects.toThrow(/not an active branch option/);
  });

  it('an EMPTY catalogue keeps free-text behaviour (the backward-compat fallback)', async () => {
    const a = adminCtx(b);
    const { id } = await createLocation(a, { companyId: b.companyId, code: 'HQ', name: 'Headquarters', branch: 'ANYTHING' });
    const [row] = await owner.db.select().from(schema.location).where(eq(schema.location.id, id));
    expect(row.branch).toBe('ANYTHING');
  });

  it('LEGACY-VALUE TOLERANCE: re-saving a location keeps a branch the catalogue no longer offers', async () => {
    const a = adminCtx(b);
    // Recorded while the catalogue was still empty…
    const { id } = await createLocation(a, { companyId: b.companyId, code: 'HQ', name: 'HQ', branch: 'OLD BRANCH' });
    // …then the catalogue is populated WITHOUT that value.
    await createProfileOption(a, { category: 'branch', value: BUKIT });
    // A save that does not change the branch must not blank it.
    await updateLocation(a, { locationId: id, code: 'HQ', name: 'HQ Renamed', branch: 'OLD BRANCH' });
    const [row] = await owner.db.select().from(schema.location).where(eq(schema.location.id, id));
    expect(row.branch).toBe('OLD BRANCH');
    // But moving it to a DIFFERENT out-of-catalogue value is still refused.
    await expect(
      updateLocation(a, { locationId: id, code: 'HQ', name: 'HQ Renamed', branch: 'ANOTHER MADE UP' }),
    ).rejects.toThrow(/not an active branch option/);
  });

  it('blank clears the mapping', async () => {
    const a = adminCtx(b);
    await createProfileOption(a, { category: 'branch', value: BUKIT });
    const { id } = await createLocation(a, { companyId: b.companyId, code: 'HQ', name: 'HQ', branch: BUKIT });
    await updateLocation(a, { locationId: id, code: 'HQ', name: 'HQ', branch: '' });
    const [row] = await owner.db.select().from(schema.location).where(eq(schema.location.id, id));
    expect(row.branch).toBeNull();
  });

  it('UNIQUENESS IS PER COMPANY: two companies may both map the same branch', async () => {
    const a = adminCtx(b);
    await createProfileOption(a, { category: 'branch', value: BUKIT });
    const { id: coB } = await createCompany(a, { legalName: 'Second Sdn Bhd' });
    await createLocation(a, { companyId: b.companyId, code: 'A-HQ', name: 'A HQ', branch: BUKIT });
    // Same branch, different company — allowed, and this is the live tenant's normal case.
    await createLocation(a, { companyId: coB, code: 'B-HQ', name: 'B HQ', branch: BUKIT });

    // …but a SECOND live location in the SAME company claiming it is refused by the partial unique index,
    // as the TYPED error (never the raw driver message — see the duplicate-message describe below).
    await expect(
      createLocation(a, { companyId: b.companyId, code: 'A-ALT', name: 'A Alt', branch: BUKIT }),
    ).rejects.toThrow(LocationBranchTakenError);
    const liveInA = await owner.db
      .select({ id: schema.location.id })
      .from(schema.location)
      .where(
        and(
          eq(schema.location.companyId, b.companyId),
          eq(schema.location.branch, BUKIT),
          isNull(schema.location.archivedAt),
        ),
      );
    expect(liveInA).toHaveLength(1);
  });

  it('archiving frees the branch for a replacement location in the same company', async () => {
    const a = adminCtx(b);
    await createProfileOption(a, { category: 'branch', value: BUKIT });
    const { id: old } = await createLocation(a, { companyId: b.companyId, code: 'OLD', name: 'Old HQ', branch: BUKIT });
    await archiveLocation(a, { locationId: old });
    const { id: fresh } = await createLocation(a, { companyId: b.companyId, code: 'NEW', name: 'New HQ', branch: BUKIT });
    expect(fresh).toBeTruthy();
  });
});

/**
 * 1fff489c — WHAT THE ADMIN SEES WHEN A SAVE COLLIDES.
 *
 * Measured on this branch before the fix: mapping a branch that another LIVE location in the same company
 * already held put drizzle's own text into the ?error= banner — `Failed query: update "location" set
 * "code" = $1 … params: TWO,Two,MY,,BUKIT JALIL,feb9dc15-…`. SQL and parameter VALUES, on an HR screen.
 * The data was never at risk (the partial unique index rejected the write and the transaction rolled
 * back); the message was. app/admin/_redirects.ts `fail()` copies `(e as Error).message` verbatim into
 * the query string, so whatever core throws IS the banner.
 *
 * These assert the shape the action layer needs — a typed error naming the branch and the CODE of the
 * location already holding it — plus the negative that matters: no driver text on the message. Removing
 * either catch in core/location.ts fails every test in this block (verified).
 */
describe('a duplicate save reports itself, never the raw query', () => {
  const RAW_SQL = /Failed query|insert into|update "location"|params:|\$1/i;

  it('CREATE with a branch another live location holds — typed, names the branch AND the holder’s code', async () => {
    const a = adminCtx(b);
    await createProfileOption(a, { category: 'branch', value: BUKIT });
    await createLocation(a, { companyId: b.companyId, code: 'HQ', name: 'Headquarters', branch: BUKIT });

    const err = await createLocation(a, { companyId: b.companyId, code: 'ALT', name: 'Alt', branch: BUKIT }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LocationBranchTakenError);
    expect((err as LocationBranchTakenError).branch).toBe(BUKIT);
    // Resolved in a SECOND transaction — the one that hit the 23505 is aborted and cannot be read from.
    expect((err as LocationBranchTakenError).conflictCode).toBe('HQ');
    expect((err as Error).message).not.toMatch(RAW_SQL);
  });

  it('UPDATE remapping onto a taken branch — the exact save the verifier measured', async () => {
    const a = adminCtx(b);
    await createProfileOption(a, { category: 'branch', value: BUKIT });
    await createLocation(a, { companyId: b.companyId, code: 'ONE', name: 'One', branch: BUKIT });
    const { id: two } = await createLocation(a, { companyId: b.companyId, code: 'TWO', name: 'Two' });

    const err = await updateLocation(a, { locationId: two, code: 'TWO', name: 'Two', branch: BUKIT }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LocationBranchTakenError);
    // The holder is resolved EXCLUDING the row being saved, so it names ONE and not TWO itself.
    expect((err as LocationBranchTakenError).conflictCode).toBe('ONE');
    expect((err as Error).message).not.toMatch(RAW_SQL);

    // …and the refused save changed nothing.
    const [row] = await owner.db.select().from(schema.location).where(eq(schema.location.id, two));
    expect(row.branch).toBeNull();
  });

  it('a duplicate CODE is the OTHER constraint, told apart by name', async () => {
    const a = adminCtx(b);
    await createLocation(a, { companyId: b.companyId, code: 'HQ', name: 'Headquarters' });

    const err = await createLocation(a, { companyId: b.companyId, code: 'HQ', name: 'Second HQ' }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LocationCodeTakenError);
    expect((err as LocationCodeTakenError).code).toBe('HQ');
    expect((err as Error).message).not.toMatch(RAW_SQL);
  });

  // THE TEST ABOVE DOES NOT ACTUALLY TEST DISCRIMINATION, which is why this one exists. It sets no
  // branch, so `locationUniqueError`'s `n.branch && /location_branch_uq/i` arm is short-circuited by
  // the falsy branch before the constraint name is ever consulted — it would still pass if the name
  // check were deleted. Here BOTH arms are live: a branch is supplied and is FREE, while the code
  // clashes. Only the constraint name can tell the two apart, so this is the case that fails if
  // someone reorders the arms or drops the regex.
  it('a CODE clash while a FREE branch is also being set is still the CODE error, not the branch one', async () => {
    const a = adminCtx(b);
    await createProfileOption(a, { category: 'branch', value: BUKIT });
    await createLocation(a, { companyId: b.companyId, code: 'HQ', name: 'Headquarters' });

    const err = await createLocation(a, {
      companyId: b.companyId,
      code: 'HQ', // taken
      name: 'Second HQ',
      branch: BUKIT, // free — nothing else holds it
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LocationCodeTakenError);
    expect(err).not.toBeInstanceOf(LocationBranchTakenError);
    expect((err as LocationCodeTakenError).code).toBe('HQ');
    expect((err as Error).message).not.toMatch(RAW_SQL);
  });

  // NOT TESTED HERE, DELIBERATELY, AND SAID OUT LOUD RATHER THAN FAKED: the try/catch around the
  // failure-path recovery read in withBranchConflictCode (core/location.ts). Reaching it needs
  // branchConflictCode itself to throw — a dropped connection, a statement timeout, or the holder
  // archived in the window between the 23505 and the follow-up read. None of those is producible
  // from this file's public surface: archiving the holder FREES the branch, so no 23505 is raised at
  // all and the path is never entered. A first draft of this test claimed to race that window and
  // did not — it archived nothing and passed because the code resolved normally, i.e. it passed for
  // a reason other than its name. That is the failure mode this repo keeps writing down, so the test
  // is gone and the gap is recorded instead. The catch is defence in depth; the invariant it protects
  // (a typed error, never raw SQL) IS covered by every other case in this describe block.

  it('an ARCHIVED holder does not collide — the partial index and the message agree', async () => {
    const a = adminCtx(b);
    await createProfileOption(a, { category: 'branch', value: BUKIT });
    const { id: old } = await createLocation(a, { companyId: b.companyId, code: 'OLD', name: 'Old', branch: BUKIT });
    await archiveLocation(a, { locationId: old });
    // No throw at all: archiving frees the branch, so there is nothing to report.
    const { id } = await createLocation(a, { companyId: b.companyId, code: 'NEW', name: 'New', branch: BUKIT });
    expect(id).toBeTruthy();
  });
});

describe('resolveLocationForBranch', () => {
  it('a MAPPED branch resolves to the location in the employee’s OWN company', async () => {
    const a = adminCtx(b);
    await createProfileOption(a, { category: 'branch', value: BUKIT });
    const { id: coB } = await createCompany(a, { legalName: 'Other Sdn Bhd' });
    const { id: mine } = await createLocation(a, { companyId: b.companyId, code: 'A-HQ', name: 'A HQ', branch: BUKIT });
    await createLocation(a, { companyId: coB, code: 'B-HQ', name: 'B HQ', branch: BUKIT });

    const resolved = await resolveLocationForBranch(a, b.companyId, BUKIT);
    expect(resolved?.id).toBe(mine);
    expect(resolved?.code).toBe('A-HQ');
    expect(resolved?.branch).toBe(BUKIT);

    // The other company resolves to ITS own location, not to A's.
    const theirs = await resolveLocationForBranch(a, coB, BUKIT);
    expect(theirs?.code).toBe('B-HQ');
  });

  it('an UNMAPPED branch proposes nothing', async () => {
    const a = adminCtx(b);
    await createProfileOption(a, { category: 'branch', value: BUKIT });
    await createProfileOption(a, { category: 'branch', value: MENARA });
    await createLocation(a, { companyId: b.companyId, code: 'HQ', name: 'HQ', branch: BUKIT });
    expect(await resolveLocationForBranch(a, b.companyId, MENARA)).toBeNull();
  });

  it('a blank or absent branch proposes nothing', async () => {
    const a = adminCtx(b);
    expect(await resolveLocationForBranch(a, b.companyId, null)).toBeNull();
    expect(await resolveLocationForBranch(a, b.companyId, '   ')).toBeNull();
  });

  it('an ARCHIVED location is NEVER proposed', async () => {
    const a = adminCtx(b);
    await createProfileOption(a, { category: 'branch', value: BUKIT });
    const { id } = await createLocation(a, { companyId: b.companyId, code: 'HQ', name: 'HQ', branch: BUKIT });
    expect((await resolveLocationForBranch(a, b.companyId, BUKIT))?.id).toBe(id);
    await archiveLocation(a, { locationId: id });
    // A suggestion the admin cannot then select is worse than no suggestion.
    expect(await resolveLocationForBranch(a, b.companyId, BUKIT)).toBeNull();
  });
});

describe('listUnmappedBranches — the admin count', () => {
  it('reports a branch live employees carry that no live location claims, with its headcount', async () => {
    const a = adminCtx(b);
    await createProfileOption(a, { category: 'branch', value: BUKIT });
    await createProfileOption(a, { category: 'branch', value: MENARA });
    await createLocation(a, { companyId: b.companyId, code: 'HQ', name: 'HQ', branch: BUKIT });

    const mapped = await hire(a, b.companyId, b.deptA);
    const unmapped1 = await hire(a, b.companyId, b.deptA);
    const unmapped2 = await hire(a, b.companyId, b.deptA);
    await setEmploymentInfo(a, { employmentId: mapped.employmentId, orgBranch: BUKIT });
    await setEmploymentInfo(a, { employmentId: unmapped1.employmentId, orgBranch: MENARA });
    await setEmploymentInfo(a, { employmentId: unmapped2.employmentId, orgBranch: MENARA });

    const rows = await listUnmappedBranches(a, [b.companyId]);
    expect(rows).toEqual([{ companyId: b.companyId, branch: MENARA, headcount: 2 }]);
  });

  it('is empty when every branch in use is mapped, and when nobody carries a branch', async () => {
    const a = adminCtx(b);
    await createProfileOption(a, { category: 'branch', value: BUKIT });
    await createLocation(a, { companyId: b.companyId, code: 'HQ', name: 'HQ', branch: BUKIT });
    expect(await listUnmappedBranches(a, [b.companyId])).toEqual([]);

    const e = await hire(a, b.companyId, b.deptA);
    await setEmploymentInfo(a, { employmentId: e.employmentId, orgBranch: BUKIT });
    expect(await listUnmappedBranches(a, [b.companyId])).toEqual([]);
  });

  it('is PER COMPANY: the same branch can be mapped in one company and a gap in the next', async () => {
    const a = adminCtx(b);
    await createProfileOption(a, { category: 'branch', value: BUKIT });
    const { id: coB } = await createCompany(a, { legalName: 'Gap Sdn Bhd' });
    const { id: deptB } = await createDepartment(a, { companyId: coB, name: 'B-Dept' });
    await createLocation(a, { companyId: b.companyId, code: 'HQ', name: 'HQ', branch: BUKIT });

    const inA = await hire(a, b.companyId, b.deptA);
    const inB = await hire(a, coB, deptB);
    await setEmploymentInfo(a, { employmentId: inA.employmentId, orgBranch: BUKIT });
    await setEmploymentInfo(a, { employmentId: inB.employmentId, orgBranch: BUKIT });

    const rows = await listUnmappedBranches(a, [b.companyId, coB]);
    expect(rows).toEqual([{ companyId: coB, branch: BUKIT, headcount: 1 }]);
  });

  it('ignores terminated employments — a branch nobody works at is not a configuration gap', async () => {
    const a = adminCtx(b);
    await createProfileOption(a, { category: 'branch', value: MENARA });
    const e = await hire(a, b.companyId, b.deptA);
    await setEmploymentInfo(a, { employmentId: e.employmentId, orgBranch: MENARA });
    expect(await listUnmappedBranches(a, [b.companyId])).toHaveLength(1);

    await owner.db
      .update(schema.employment)
      .set({ terminatedOn: '2026-01-31' })
      .where(eq(schema.employment.id, e.employmentId));
    expect(await listUnmappedBranches(a, [b.companyId])).toEqual([]);
  });
});

describe('branchChangeDateFor — the effective date the suggestion offers', () => {
  it('is null when the branch has never changed', async () => {
    const a = adminCtx(b);
    const e = await hire(a, b.companyId, b.deptA);
    expect(await branchChangeDateFor(a, e.employmentId)).toBeNull();
  });

  it('reads the date of the LAST branch change, not the last save of anything else', async () => {
    const a = adminCtx(b);
    await createProfileOption(a, { category: 'branch', value: BUKIT });
    await createProfileOption(a, { category: 'branch', value: MENARA });
    const e = await hire(a, b.companyId, b.deptA);
    await setEmploymentInfo(a, { employmentId: e.employmentId, orgBranch: BUKIT });

    // Back-date that change so the assertion cannot pass merely because everything happened today.
    await owner.db
      .update(schema.domainEvent)
      .set({ occurredAt: new Date('2026-05-01T04:00:00Z') })
      .where(
        and(
          eq(schema.domainEvent.subjectEmploymentId, e.employmentId),
          eq(schema.domainEvent.eventType, 'employment.info.updated'),
        ),
      );
    expect(await branchChangeDateFor(a, e.employmentId)).toBe('2026-05-01');

    // A LATER save that does not touch the branch must not move the answer.
    await setEmploymentInfo(a, { employmentId: e.employmentId, confirmationDate: '2026-06-01' });
    expect(await branchChangeDateFor(a, e.employmentId)).toBe('2026-05-01');

    // A later save that DOES change the branch moves it to today.
    await setEmploymentInfo(a, { employmentId: e.employmentId, orgBranch: MENARA });
    const latest = await branchChangeDateFor(a, e.employmentId);
    expect(latest).not.toBe('2026-05-01');
    expect(latest).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('recordLocationSource — branch_derived vs manual provenance', () => {
  it('stamps the source on employment.location.changed without a new column', async () => {
    const a = adminCtx(b);
    await createProfileOption(a, { category: 'branch', value: BUKIT });
    const { id: locationId } = await createLocation(a, { companyId: b.companyId, code: 'HQ', name: 'HQ', branch: BUKIT });
    const e = await hire(a, b.companyId, b.deptA);

    await recordLocationSource(a, {
      employmentId: e.employmentId,
      locationId,
      effectiveDate: '2026-05-01',
      source: 'branch_derived',
    });
    await recordLocationSource(a, {
      employmentId: e.employmentId,
      locationId,
      effectiveDate: '2026-06-01',
      source: 'manual',
    });

    const rows = await owner.db
      .select({ payload: schema.domainEvent.payload, subject: schema.domainEvent.subjectEmploymentId })
      .from(schema.domainEvent)
      .where(
        and(
          eq(schema.domainEvent.tenantId, b.tenantId),
          eq(schema.domainEvent.eventType, 'employment.location.changed'),
        ),
      )
      .orderBy(schema.domainEvent.sequence);
    expect(rows).toHaveLength(2);
    expect((rows[0].payload as { source: string; effectiveDate: string }).source).toBe('branch_derived');
    expect((rows[0].payload as { source: string; effectiveDate: string }).effectiveDate).toBe('2026-05-01');
    expect((rows[1].payload as { source: string }).source).toBe('manual');
    // Subject-scoped so the employee can read their own history (ADR-0015).
    expect(rows[0].subject).toBe(e.employmentId);
  });
});
