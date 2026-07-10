/**
 * #25 visibility — eligibility CONFIG (admin writes the rule) + the /me apply-dropdown VISIBILITY filter.
 *
 * Two deliverables under test:
 *   (a) updateLeaveType folds in the tri-state eligibility rule (validate, normalize, untouched-on-rename,
 *       before/after event) — the write path.
 *   (b) listEligibleLeaveTypesFor filters the apply menu through the same gate as requestLeave — the read
 *       path that stops an employee seeing a type they can't take. The historical-activity case proves the
 *       filter does NOT reintroduce the leaveBalances ledger-row leak.
 */
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { updateLeaveType } from '../core/admin';
import { LeaveIneligibleError, requestLeave } from '../core/leave';
import { listEligibleLeaveTypesFor } from '../core/read';
import {
  adminCtx,
  closeAll,
  latestEventPayload,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

let b: Base;

const req = (employmentId: string, leaveTypeId: string) =>
  requestLeave(adminCtx(b), { employmentId, leaveTypeId, startDate: '2026-07-01', endDate: '2026-07-01' });

async function hire(gender: string | null, marital: string | null, hiredOn = '2024-01-01') {
  const e = await hireEmployee(adminCtx(b), {
    person: { fullName: 'Elig', primaryEmail: `elig_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn,
  });
  await owner.db
    .update(schema.person)
    .set({ gender, maritalStatus: marital })
    .where(eq(schema.person.id, e.personId));
  return e;
}

async function leaveType(code: string, eligibility: unknown) {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({ tenantId: b.tenantId, code, name: code, paid: true, counting: 'calendar_days', eligibility })
    .returning({ id: schema.leaveType.id, eligibility: schema.leaveType.eligibility });
  return row.id;
}

const eligibilityOf = async (id: string) => {
  const [row] = await owner.db
    .select({ e: schema.leaveType.eligibility })
    .from(schema.leaveType)
    .where(eq(schema.leaveType.id, id));
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

describe('#25 — updateLeaveType eligibility (write path)', () => {
  it('setting gender:female makes a male request reject and a female resolve', async () => {
    const mat = await leaveType('MATERNITY', null); // starts open
    await updateLeaveType(adminCtx(b), { id: mat, name: 'Maternity', eligibility: { gender: 'female' } });
    // #badc5966: a single-select still normalizes to the array shape.
    expect(await eligibilityOf(mat)).toEqual({ gender: ['female'] });
    const female = await hire('female', 'married');
    const male = await hire('male', 'married');
    await expect(req(female.employmentId, mat)).resolves.toMatchObject({ days: 1 });
    await expect(req(male.employmentId, mat)).rejects.toBeInstanceOf(LeaveIneligibleError);
  });

  it('an all-blank object normalizes to null and reopens the type to everyone', async () => {
    const t = await leaveType('SPECIAL', { gender: 'female' });
    await updateLeaveType(adminCtx(b), { id: t, name: 'Special', eligibility: { gender: '', maritalStatus: '' } });
    expect(await eligibilityOf(t)).toBeNull();
    const male = await hire('male', 'single');
    await expect(req(male.employmentId, t)).resolves.toMatchObject({ days: 1 });
  });

  it('explicit null reopens the type', async () => {
    const t = await leaveType('SPECIAL2', { gender: 'female' });
    await updateLeaveType(adminCtx(b), { id: t, name: 'Special2', eligibility: null });
    expect(await eligibilityOf(t)).toBeNull();
  });

  it('omitting eligibility on a rename leaves an existing rule untouched (data-loss guard)', async () => {
    const t = await leaveType('PAT', { gender: ['male'], maritalStatus: ['married'], minServiceMonths: 12 });
    await updateLeaveType(adminCtx(b), { id: t, name: 'Paternity (renamed)' }); // no eligibility key
    expect(await eligibilityOf(t)).toEqual({ gender: ['male'], maritalStatus: ['married'], minServiceMonths: 12 });
  });

  it('validates and strips: bad values reject, stray keys are dropped', async () => {
    const t = await leaveType('VALID', null);
    const ctx = adminCtx(b);
    await expect(
      updateLeaveType(ctx, { id: t, name: 'V', eligibility: { gender: 'other' } as never }),
    ).rejects.toThrow();
    await expect(
      updateLeaveType(ctx, { id: t, name: 'V', eligibility: { minServiceMonths: 'abc' } as never }),
    ).rejects.toThrow();
    await expect(
      updateLeaveType(ctx, { id: t, name: 'V', eligibility: { minServiceMonths: -3 } as never }),
    ).rejects.toThrow();
    // a populated object with a stray key keeps only the three known fields
    await updateLeaveType(ctx, {
      id: t,
      name: 'V',
      eligibility: { gender: 'female', department: 'Finance' } as never,
    });
    expect(await eligibilityOf(t)).toEqual({ gender: ['female'] });
  });

  it('appends leave-type.updated with { before, after } carrying the eligibility change', async () => {
    const t = await leaveType('EV', null);
    await updateLeaveType(adminCtx(b), { id: t, name: 'EV', eligibility: { gender: 'female' } });
    const payload = await latestEventPayload(b.tenantId, t, 'leave-type.updated');
    expect(payload).toMatchObject({
      before: { eligibility: null },
      after: { eligibility: { gender: ['female'] } },
    });
  });
});

describe('#badc5966 — multi-select gender + marital eligibility', () => {
  it('stores a multi-gender rule and admits ANY selected gender while rejecting others', async () => {
    const wellness = await leaveType('WELLNESS', null);
    await updateLeaveType(adminCtx(b), {
      id: wellness,
      name: 'Wellness',
      eligibility: { gender: ['male', 'female'] },
    });
    expect(await eligibilityOf(wellness)).toEqual({ gender: ['male', 'female'] });
    const male = await hire('male', 'single');
    const female = await hire('female', 'single');
    const undisclosed = await hire(null, 'single');
    await expect(req(male.employmentId, wellness)).resolves.toMatchObject({ days: 1 });
    await expect(req(female.employmentId, wellness)).resolves.toMatchObject({ days: 1 });
    await expect(req(undisclosed.employmentId, wellness)).rejects.toBeInstanceOf(LeaveIneligibleError);
  });

  it('stores a multi-marital rule and admits ANY selected status while rejecting others', async () => {
    const family = await leaveType('FAMILYCARE', null);
    await updateLeaveType(adminCtx(b), {
      id: family,
      name: 'Family Care',
      eligibility: { maritalStatus: ['single', 'married'] },
    });
    expect(await eligibilityOf(family)).toEqual({ maritalStatus: ['single', 'married'] });
    const single = await hire('female', 'single');
    const married = await hire('male', 'married');
    const other = await hire('male', 'other');
    await expect(req(single.employmentId, family)).resolves.toMatchObject({ days: 1 });
    await expect(req(married.employmentId, family)).resolves.toMatchObject({ days: 1 });
    await expect(req(other.employmentId, family)).rejects.toBeInstanceOf(LeaveIneligibleError);
  });

  it('de-dupes, drops blanks, and rejects out-of-allow-list values', async () => {
    const t = await leaveType('MULTI', null);
    const ctx = adminCtx(b);
    // de-dupe + blank-strip
    await updateLeaveType(ctx, { id: t, name: 'M', eligibility: { gender: ['male', 'male', ''] } as never });
    expect(await eligibilityOf(t)).toEqual({ gender: ['male'] });
    // an array with a bad element throws
    await expect(
      updateLeaveType(ctx, { id: t, name: 'M', eligibility: { gender: ['male', 'divorced'] } as never }),
    ).rejects.toThrow();
    // an all-blank array collapses to null (open to all), same as the scalar all-blank case
    await updateLeaveType(ctx, { id: t, name: 'M', eligibility: { gender: [], maritalStatus: [''] } as never });
    expect(await eligibilityOf(t)).toBeNull();
  });

  it('BACKWARD-COMPAT: a legacy SCALAR row (pre-multi-select, no backfill) still gates correctly', async () => {
    // Insert the eligibility exactly as pre-#badc5966 rows stored it — a scalar string, NOT an array.
    const mat = await leaveType('LEGACYMAT', { gender: 'female' });
    const female = await hire('female', 'married');
    const male = await hire('male', 'married');
    // enforcement path (requestLeave) tolerates the scalar via normalize-on-read
    await expect(req(female.employmentId, mat)).resolves.toMatchObject({ days: 1 });
    await expect(req(male.employmentId, mat)).rejects.toBeInstanceOf(LeaveIneligibleError);
    // visibility path agrees
    const maleTypes = (await listEligibleLeaveTypesFor(adminCtx(b), male.employmentId)).map((x) => x.id);
    const femaleTypes = (await listEligibleLeaveTypesFor(adminCtx(b), female.employmentId)).map((x) => x.id);
    expect(maleTypes).not.toContain(mat);
    expect(femaleTypes).toContain(mat);
  });
});

describe('#25 — listEligibleLeaveTypesFor (read/visibility path)', () => {
  it('excludes a female-only type for a male and includes it for a female', async () => {
    const mat = await leaveType('MATERNITY', { gender: 'female' });
    const male = await hire('male', 'married');
    const female = await hire('female', 'married');
    const maleTypes = (await listEligibleLeaveTypesFor(adminCtx(b), male.employmentId)).map((t) => t.id);
    const femaleTypes = (await listEligibleLeaveTypesFor(adminCtx(b), female.employmentId)).map((t) => t.id);
    expect(maleTypes).not.toContain(mat);
    expect(femaleTypes).toContain(mat);
    // the open seed ANNUAL type is visible to both
    expect(maleTypes).toContain(b.annualLeaveTypeId);
  });

  it('excludes paternity (married male) for a single male', async () => {
    const pat = await leaveType('PATERNITY', { gender: 'male', maritalStatus: 'married', minServiceMonths: 12 });
    const single = await hire('male', 'single');
    const ids = (await listEligibleLeaveTypesFor(adminCtx(b), single.employmentId)).map((t) => t.id);
    expect(ids).not.toContain(pat);
  });

  it('returns exactly the isLeaveEligible-filtered set and preserves requiresDocument', async () => {
    const mat = await leaveType('MATERNITY', { gender: 'female' });
    // a doc-required open type to prove the projection keeps requiresDocument
    const [sick] = await owner.db
      .insert(schema.leaveType)
      .values({ tenantId: b.tenantId, code: 'SICK2', name: 'Sick', paid: true, counting: 'calendar_days', requiresDocument: true })
      .returning({ id: schema.leaveType.id });
    const female = await hire('female', 'married');
    const types = await listEligibleLeaveTypesFor(adminCtx(b), female.employmentId);
    const ids = types.map((t) => t.id).sort();
    expect(ids).toEqual([b.annualLeaveTypeId, mat, sick.id].sort());
    expect(types.find((t) => t.id === sick.id)?.requiresDocument).toBe(true);
  });

  it('excludes a gated type for an employee whose attribute is undisclosed/NULL (v1 lawful default)', async () => {
    const mat = await leaveType('MATERNITY', { gender: 'female' });
    const undisclosed = await hire(null, null); // gender NULL
    const ids = (await listEligibleLeaveTypesFor(adminCtx(b), undisclosed.employmentId)).map((t) => t.id);
    expect(ids).not.toContain(mat);
    // and the server backstop agrees — requestLeave also rejects
    await expect(req(undisclosed.employmentId, mat)).rejects.toBeInstanceOf(LeaveIneligibleError);
  });

  it('historical activity does NOT resurface a gated type (no leaveBalances leak)', async () => {
    const mat = await leaveType('MATERNITY', { gender: 'female' });
    const male = await hire('male', 'married');
    // give the male a ledger accrual on the now-female-only type (e.g. a pre-restriction grant)
    await owner.db.insert(schema.leaveLedger).values({
      tenantId: b.tenantId,
      employmentId: male.employmentId,
      leaveTypeId: mat,
      entryType: 'accrual',
      days: '5.00',
      effectiveOn: '2024-01-01',
    });
    const ids = (await listEligibleLeaveTypesFor(adminCtx(b), male.employmentId)).map((t) => t.id);
    expect(ids).not.toContain(mat); // sourced from the eligibility filter, not the ledger
  });
});
