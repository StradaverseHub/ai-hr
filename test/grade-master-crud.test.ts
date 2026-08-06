/**
 * Grade Management (feedback 728a7db6, extended by b1b81a08). Covers the grade-master admin CRUD delta:
 * duplicate-name rejection (create + edit), editable grade code with uniqueness, delete blocked when the
 * grade is referenced vs succeeding + emitting job-grade.deleted when unused, and archived grades being
 * excluded from the default listing while still visible with includeArchived.
 *
 * b1b81a08 widened the in-use guard from two referencing tables (employment, leave_policy) to five, adding
 * leave_approval_policy, claim_policy and grade_group_member — asserted here alongside the original two.
 *
 * 6e9a126e RELEASE THREE — REPOINTED, not reduced. `leave_policy` is dropped (0405), so the referrer that
 * used to hold a grade is now `entitlement_eligibility_rule.criteria->gradeIds`. Everything else in this
 * file is grade-master CRUD and GRADE GROUPS, both of which survive the entitlement cut untouched.
 *
 * ⚠️ The repointed case is the one that matters most in this file now, and for a NEW reason. The other five
 * referrers are real foreign keys: forget one and Postgres still refuses the delete with a raw 23503. An
 * eligibility rule names the grade inside JSONB with NO foreign key, so nothing under this guard stops the
 * delete — it succeeds, and the rule goes on selecting a grade id that resolves to nobody. This test IS the
 * constraint.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hireEmployee } from '../core/org';
import {
  createJobGrade,
  updateJobGrade,
  deleteJobGrade,
  archiveJobGrade,
  DuplicateError,
} from '../core/admin';
import { createGradeGroup } from '../core/benefit-scheme';
import { createLeaveApprovalRule } from '../core/leave-approval-policy';
import { createClaimType, setClaimPolicy } from '../core/claims';
import { listJobGrades } from '../core/read';
import {
  adminCtx,
  closeAll,
  eventTypesFor,
  migrateTestDb,
  resetDb,
  seedBase,
  seedEntitlement,
  type Base,
} from './harness';

let b: Base;
const ctx = () => adminCtx(b);

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

describe('Grade Management (728a7db6) — grade-master CRUD', () => {
  it('rejects a duplicate grade NAME on create (case-insensitive)', async () => {
    await createJobGrade(ctx(), { code: 'PH', name: 'Permanent - Grade H' });
    await expect(
      createJobGrade(ctx(), { code: 'PH2', name: 'permanent - grade h' }),
    ).rejects.toBeInstanceOf(DuplicateError);
  });

  it('rejects a duplicate grade CODE on create', async () => {
    await createJobGrade(ctx(), { code: 'PH', name: 'Permanent - Grade H' });
    await expect(
      createJobGrade(ctx(), { code: 'PH', name: 'Another Name' }),
    ).rejects.toBeInstanceOf(DuplicateError);
  });

  it('rejects a duplicate NAME when editing one grade into another grade’s name', async () => {
    await createJobGrade(ctx(), { code: 'PH', name: 'Permanent - Grade H' });
    const g2 = await createJobGrade(ctx(), { code: 'P1215', name: 'Permanent - Grade 12-15' });
    await expect(
      updateJobGrade(ctx(), { id: g2.id, code: 'P1215', name: 'Permanent - Grade H' }),
    ).rejects.toBeInstanceOf(DuplicateError);
  });

  it('rejects a duplicate CODE when editing a grade’s code onto another grade’s code', async () => {
    await createJobGrade(ctx(), { code: 'PH', name: 'Permanent - Grade H' });
    const g2 = await createJobGrade(ctx(), { code: 'P1215', name: 'Permanent - Grade 12-15' });
    await expect(
      updateJobGrade(ctx(), { id: g2.id, code: 'PH', name: 'Permanent - Grade 12-15' }),
    ).rejects.toBeInstanceOf(DuplicateError);
  });

  it('edits Code / Name / Rank and persists all three, appending job-grade.updated', async () => {
    const g = await createJobGrade(ctx(), { code: 'PH', name: 'Permanent - Grade H', rank: 5 });
    await updateJobGrade(ctx(), { id: g.id, code: 'PGH', name: 'Permanent Grade H', rank: 2 });
    const rows = await listJobGrades(ctx(), { includeArchived: true });
    const row = rows.find((r) => r.id === g.id)!;
    expect(row.code).toBe('PGH');
    expect(row.name).toBe('Permanent Grade H');
    expect(row.rank).toBe(2);
    expect(await eventTypesFor(b.tenantId, g.id)).toContain('job-grade.updated');
  });

  // 6e9a126e RELEASE THREE — was "blocks deletion of a grade referenced by a leave policy". The grade-scoped
  // leave_policy row is gone; the same targeting is now an eligibility rule whose criteria name the grade.
  // Every assertion is carried over and one is ADDED (inUse), because this referrer has no foreign key
  // behind it: if the predicate stops naming entitlement_eligibility_rule, nothing else refuses the delete.
  it('blocks deletion of a grade referenced ONLY by an entitlement eligibility rule, and reports inUse', async () => {
    const g = await createJobGrade(ctx(), { code: 'PH', name: 'Permanent - Grade H' });
    await seedEntitlement(ctx(), {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 18,
      gradeId: g.id,
      validFrom: '2026-01-01',
    });
    const row = (await listJobGrades(ctx(), { includeArchived: true })).find((r) => r.id === g.id)!;
    expect(row.inUse).toBe(true);
    await expect(deleteJobGrade(ctx(), { id: g.id })).rejects.toThrow();
    // Still present after the blocked delete.
    const rows = await listJobGrades(ctx(), { includeArchived: true });
    expect(rows.some((r) => r.id === g.id)).toBe(true);
  });

  // The other half of the same guard: a rule that names a DIFFERENT grade must not pin this one, or the
  // predicate would degenerate into "any eligibility rule exists" and Delete would never enable again.
  it('an eligibility rule naming a DIFFERENT grade does not pin this one', async () => {
    const used = await createJobGrade(ctx(), { code: 'PH', name: 'Permanent - Grade H' });
    const free = await createJobGrade(ctx(), { code: 'TMP', name: 'Temporary Band' });
    await seedEntitlement(ctx(), {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 18,
      gradeId: used.id,
      validFrom: '2026-01-01',
    });
    const row = (await listJobGrades(ctx(), { includeArchived: true })).find((r) => r.id === free.id)!;
    expect(row.inUse).toBe(false);
    await deleteJobGrade(ctx(), { id: free.id });
    expect((await listJobGrades(ctx(), { includeArchived: true })).some((r) => r.id === free.id)).toBe(false);
  });

  it('blocks deletion of a grade assigned to an employee', async () => {
    const g = await createJobGrade(ctx(), { code: 'PH', name: 'Permanent - Grade H' });
    await hireEmployee(ctx(), {
      person: { fullName: 'Graded One', primaryEmail: `g_${randomUUID().slice(0, 8)}@t.local` },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
      gradeId: g.id,
    });
    await expect(deleteJobGrade(ctx(), { id: g.id })).rejects.toThrow();
  });

  // b1b81a08 — the in-use predicate (both listJobGrades' `inUse` and deleteJobGrade's in-tx re-check)
  // widened from two referencing tables to five. Before, a grade used only by an approval rule or a claim
  // limit reported inUse=false and raised a raw 23503; grade_group_member CASCADED, so its delete silently
  // dropped benefit-scheme membership.
  it('blocks deletion of a grade referenced ONLY by a leave approval rule and reports inUse', async () => {
    const g = await createJobGrade(ctx(), { code: 'PH', name: 'Permanent - Grade H' });
    await createLeaveApprovalRule(ctx(), { companyId: b.companyId, gradeId: g.id, levels: ['direct_manager'] });
    const row = (await listJobGrades(ctx(), { includeArchived: true })).find((r) => r.id === g.id)!;
    expect(row.inUse).toBe(true);
    await expect(deleteJobGrade(ctx(), { id: g.id })).rejects.toThrow();
  });

  it('blocks deletion of a grade referenced ONLY by a claim limit and reports inUse', async () => {
    const g = await createJobGrade(ctx(), { code: 'PH', name: 'Permanent - Grade H' });
    const ct = await createClaimType(ctx(), {
      code: 'MED',
      name: 'Medical',
      defaultTaxable: false,
      requiresReceipt: true,
    });
    await setClaimPolicy(ctx(), {
      claimTypeId: ct.id,
      annualBudget: 1000,
      perClaimCap: null,
      effectiveFrom: '2026-01-01',
      gradeId: g.id,
    });
    const row = (await listJobGrades(ctx(), { includeArchived: true })).find((r) => r.id === g.id)!;
    expect(row.inUse).toBe(true);
    await expect(deleteJobGrade(ctx(), { id: g.id })).rejects.toThrow();
  });

  it('blocks deletion of a grade that is ONLY a grade-group member and reports inUse', async () => {
    const g = await createJobGrade(ctx(), { code: 'PH', name: 'Permanent - Grade H' });
    await createGradeGroup(ctx(), { name: 'Senior band', gradeIds: [g.id] });
    const row = (await listJobGrades(ctx(), { includeArchived: true })).find((r) => r.id === g.id)!;
    expect(row.inUse).toBe(true);
    await expect(deleteJobGrade(ctx(), { id: g.id })).rejects.toThrow();
    // grade_group_member cascades, so the pre-b1b81a08 delete would have SUCCEEDED and dropped membership.
    expect((await listJobGrades(ctx(), { includeArchived: true })).some((r) => r.id === g.id)).toBe(true);
  });

  it('deletes an unused grade and appends job-grade.deleted', async () => {
    const g = await createJobGrade(ctx(), { code: 'TMP', name: 'Temporary Band' });
    await deleteJobGrade(ctx(), { id: g.id });
    const rows = await listJobGrades(ctx(), { includeArchived: true });
    expect(rows.some((r) => r.id === g.id)).toBe(false);
    expect(await eventTypesFor(b.tenantId, g.id)).toContain('job-grade.deleted');
  });

  it('excludes archived grades from the default listing but includes them with includeArchived', async () => {
    const g = await createJobGrade(ctx(), { code: 'OLD', name: 'Retired Band' });
    await archiveJobGrade(ctx(), { id: g.id, archived: true });
    const active = await listJobGrades(ctx());
    const all = await listJobGrades(ctx(), { includeArchived: true });
    expect(active.some((r) => r.id === g.id)).toBe(false);
    expect(all.some((r) => r.id === g.id)).toBe(true);
    const row = all.find((r) => r.id === g.id)!;
    expect(row.archivedAt).not.toBeNull();
  });

  it('frees an archived grade’s name — a new active grade may reuse it', async () => {
    const g = await createJobGrade(ctx(), { code: 'PH', name: 'Permanent - Grade H' });
    await archiveJobGrade(ctx(), { id: g.id, archived: true });
    // Name index is partial on archived_at IS NULL, so the archived row no longer holds the name.
    await expect(
      createJobGrade(ctx(), { code: 'PH2', name: 'Permanent - Grade H' }),
    ).resolves.toBeTruthy();
  });
});
