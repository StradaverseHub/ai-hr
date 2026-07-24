/**
 * Enhance Leave Criteria Configuration — the eight catalogue-backed Organisation Assignment fields
 * (orgDivision / orgBranch / orgRegion / orgLine / orgSection / orgTeam / orgBase / employmentCategory) join
 * the leave-type Criteria selector ALONGSIDE gender / marital / min-service / probation.
 *
 * Two layers under test:
 *   (a) the PURE gate — isLeaveEligible over an org criterion: match, no-match, empty ⇒ no restriction, a
 *       legacy scalar row, and a backward-compat rule that carries none of the new keys. hasAnyEligibilityRestriction
 *       recognises an org-only rule so the enforcement chokepoints still fetch the employee.
 *   (b) the DB round-trip — updateLeaveType stores the org keys (de-duped, blank-stripped, NO catalogue
 *       hard-validation → legacy tolerance), and requestLeave (throws) + listEligibleLeaveTypesFor (filters)
 *       enforce them: an employee whose org value is outside the configured set is rejected/filtered, one
 *       inside passes, and a rule with none of the new keys is unchanged for every employee.
 *
 * The eight fields are plain text columns ON `employment` (already the FROM root of all four chokepoints), so
 * there is NO join, no as-of choice and no no-current-assignment edge — those belong to the DEFERRED typed
 * fields (Business Unit / Department / Position / Employment Type on `assignment` + the UUID Job Grade).
 */
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { updateLeaveType } from '../core/admin';
import { LeaveIneligibleError, hasAnyEligibilityRestriction, isLeaveEligible, requestLeave } from '../core/leave';
import { listEligibleLeaveTypesFor } from '../core/read';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

// ── (a) PURE unit tests — no DB ────────────────────────────────────────────────────────────────────
describe('org-criteria · isLeaveEligible over an org criterion (pure)', () => {
  const baseEmp = { gender: null as string | null, marital: null as string | null, hiredOn: '2024-01-01' };
  const asOf = '2026-07-01';

  it('MATCH: an employee whose org value is one of the configured values passes', () => {
    const elig = { orgDivision: ['Sales', 'Marketing'] };
    expect(isLeaveEligible(elig, { ...baseEmp, orgDivision: 'Sales' }, asOf)).toBe(true);
    expect(isLeaveEligible(elig, { ...baseEmp, orgDivision: 'Marketing' }, asOf)).toBe(true);
  });

  it('NO-MATCH: an employee whose org value is outside the set (or NULL) is rejected', () => {
    const elig = { orgDivision: ['Sales'] };
    expect(isLeaveEligible(elig, { ...baseEmp, orgDivision: 'Operations' }, asOf)).toBe(false);
    expect(isLeaveEligible(elig, { ...baseEmp, orgDivision: null }, asOf)).toBe(false);
    // The employee simply not carrying the column (undefined) is treated as no value ⇒ rejected.
    expect(isLeaveEligible(elig, baseEmp, asOf)).toBe(false);
  });

  it('EMPTY ⇒ no restriction: an empty list (or absent key) admits everyone', () => {
    expect(isLeaveEligible({ orgDivision: [] }, { ...baseEmp, orgDivision: 'Anything' }, asOf)).toBe(true);
    expect(isLeaveEligible({ orgDivision: [''] }, { ...baseEmp, orgDivision: null }, asOf)).toBe(true);
    expect(isLeaveEligible({}, { ...baseEmp, orgDivision: null }, asOf)).toBe(true);
  });

  it('AND across fields, OR within a field (matches gender/marital semantics)', () => {
    const elig = { orgDivision: ['Sales'], orgRegion: ['North', 'East'] };
    expect(isLeaveEligible(elig, { ...baseEmp, orgDivision: 'Sales', orgRegion: 'North' }, asOf)).toBe(true);
    expect(isLeaveEligible(elig, { ...baseEmp, orgDivision: 'Sales', orgRegion: 'South' }, asOf)).toBe(false);
    expect(isLeaveEligible(elig, { ...baseEmp, orgDivision: 'Ops', orgRegion: 'North' }, asOf)).toBe(false);
  });

  it('BACKWARD-COMPAT: a legacy SCALAR org value normalises like gender/marital', () => {
    const elig = { orgDivision: 'Sales' } as { orgDivision: string };
    expect(isLeaveEligible(elig, { ...baseEmp, orgDivision: 'Sales' }, asOf)).toBe(true);
    expect(isLeaveEligible(elig, { ...baseEmp, orgDivision: 'Ops' }, asOf)).toBe(false);
  });

  it('BACKWARD-COMPAT: a rule with none of the new keys is unaffected — any employee passes', () => {
    // gender-only rule + an employee with org columns all NULL/absent still resolves purely on gender.
    expect(isLeaveEligible({ gender: ['female'] }, { ...baseEmp, gender: 'female', orgDivision: null }, asOf)).toBe(true);
    // A completely open rule (null) is always eligible.
    expect(isLeaveEligible(null, { ...baseEmp, orgDivision: 'X' }, asOf)).toBe(true);
  });

  it('hasAnyEligibilityRestriction recognises an org-only rule (so the emp fetch is not skipped)', () => {
    expect(hasAnyEligibilityRestriction(null)).toBe(false);
    expect(hasAnyEligibilityRestriction({})).toBe(false);
    expect(hasAnyEligibilityRestriction({ orgBase: [] })).toBe(false);
    expect(hasAnyEligibilityRestriction({ orgBase: ['HQ'] })).toBe(true);
    expect(hasAnyEligibilityRestriction({ employmentCategory: 'Executive' })).toBe(true);
  });
});

// ── (b) DB round-trip — store, enforce, filter ─────────────────────────────────────────────────────
let b: Base;

const req = (employmentId: string, leaveTypeId: string) =>
  requestLeave(adminCtx(b), { employmentId, leaveTypeId, startDate: '2026-07-01', endDate: '2026-07-01' });

async function hire(org: Partial<typeof schema.employment.$inferInsert>, hiredOn = '2024-01-01') {
  const e = await hireEmployee(adminCtx(b), {
    person: { fullName: 'Org', primaryEmail: `org_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn,
  });
  await owner.db.update(schema.employment).set(org).where(eq(schema.employment.id, e.employmentId));
  return e;
}

async function leaveType(code: string, eligibility: unknown) {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({ allowNegativeBalance: true, tenantId: b.tenantId, code, name: code, paid: true, counting: 'calendar_days', eligibility })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

const eligibilityOf = async (id: string) => {
  const [row] = await owner.db.select({ e: schema.leaveType.eligibility }).from(schema.leaveType).where(eq(schema.leaveType.id, id));
  return row.e;
};

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

describe('org-criteria · updateLeaveType stores the org keys (de-dupe, blank-strip, legacy tolerance)', () => {
  it('normalises a scalar to an array and de-dupes / drops blanks — WITHOUT catalogue hard-validation', async () => {
    const t = await leaveType('ORG', null);
    // A scalar normalises to the array shape (like gender/marital).
    await updateLeaveType(adminCtx(b), { id: t, name: 'Org', eligibility: { orgDivision: 'Sales' } as never });
    expect(await eligibilityOf(t)).toEqual({ orgDivision: ['Sales'] });
    // De-dupe + blank-strip, and a value NOT seeded in any catalogue still saves cleanly (legacy tolerance —
    // the picker limits NEW picks; a later-deactivated stored value must re-save without a hard error).
    await updateLeaveType(adminCtx(b), {
      id: t,
      name: 'Org',
      eligibility: { orgRegion: ['North', 'North', '', 'Sabah'] } as never,
    });
    expect(await eligibilityOf(t)).toEqual({ orgRegion: ['North', 'Sabah'] });
    // An all-blank org array collapses to null (open to all), like the gender all-blank case.
    await updateLeaveType(adminCtx(b), { id: t, name: 'Org', eligibility: { orgRegion: [''] } as never });
    expect(await eligibilityOf(t)).toBeNull();
  });

  it('omitting eligibility on a rename leaves a stored org rule untouched (data-loss guard)', async () => {
    const t = await leaveType('ORG2', { orgDivision: ['Sales'], gender: ['female'] });
    await updateLeaveType(adminCtx(b), { id: t, name: 'Renamed' }); // no eligibility key
    expect(await eligibilityOf(t)).toEqual({ orgDivision: ['Sales'], gender: ['female'] });
  });
});

describe('org-criteria · requestLeave enforces the org criteria (throws)', () => {
  it('rejects an employee whose orgDivision is outside the set, admits one inside', async () => {
    const t = await leaveType('DIVONLY', { orgDivision: ['Sales', 'Marketing'] });
    const inside = await hire({ orgDivision: 'Sales' });
    const outside = await hire({ orgDivision: 'Operations' });
    const blank = await hire({ orgDivision: null });
    await expect(req(inside.employmentId, t)).resolves.toMatchObject({ days: 1 });
    await expect(req(outside.employmentId, t)).rejects.toBeInstanceOf(LeaveIneligibleError);
    await expect(req(blank.employmentId, t)).rejects.toBeInstanceOf(LeaveIneligibleError);
  });

  it('AND across fields: division AND region must both match', async () => {
    const t = await leaveType('DIVREG', { orgDivision: ['Sales'], orgRegion: ['North'] });
    const both = await hire({ orgDivision: 'Sales', orgRegion: 'North' });
    const wrongRegion = await hire({ orgDivision: 'Sales', orgRegion: 'South' });
    await expect(req(both.employmentId, t)).resolves.toMatchObject({ days: 1 });
    await expect(req(wrongRegion.employmentId, t)).rejects.toBeInstanceOf(LeaveIneligibleError);
  });

  it('BACKWARD-COMPAT: a type with no org keys is unaffected by the employee org values', async () => {
    const open = await leaveType('OPEN', null);
    const anyEmp = await hire({ orgDivision: 'Anything', employmentCategory: 'Executive' });
    await expect(req(anyEmp.employmentId, open)).resolves.toMatchObject({ days: 1 });
  });
});

describe('org-criteria · listEligibleLeaveTypesFor filters on the org criteria (read/visibility path)', () => {
  it('excludes an org-restricted type for a non-matching employee, includes it for a matching one', async () => {
    const t = await leaveType('DIVVIS', { orgDivision: ['Sales'] });
    const inside = await hire({ orgDivision: 'Sales' });
    const outside = await hire({ orgDivision: 'Operations' });
    const insideIds = (await listEligibleLeaveTypesFor(adminCtx(b), inside.employmentId)).map((x) => x.id);
    const outsideIds = (await listEligibleLeaveTypesFor(adminCtx(b), outside.employmentId)).map((x) => x.id);
    expect(insideIds).toContain(t);
    expect(outsideIds).not.toContain(t);
    // the open seed ANNUAL type is visible to both (no org restriction).
    expect(insideIds).toContain(b.annualLeaveTypeId);
    expect(outsideIds).toContain(b.annualLeaveTypeId);
  });

  it('BACKWARD-COMPAT: employmentCategory restriction filters the same way', async () => {
    const t = await leaveType('CATVIS', { employmentCategory: ['Management'] });
    const mgmt = await hire({ employmentCategory: 'Management' });
    const exec = await hire({ employmentCategory: 'Executive' });
    const mgmtIds = (await listEligibleLeaveTypesFor(adminCtx(b), mgmt.employmentId)).map((x) => x.id);
    const execIds = (await listEligibleLeaveTypesFor(adminCtx(b), exec.employmentId)).map((x) => x.id);
    expect(mgmtIds).toContain(t);
    expect(execIds).not.toContain(t);
  });
});
