/**
 * Grade Management for Leave Entitlement (feedback 728a7db6). Covers the grade-master admin CRUD delta:
 * duplicate-name rejection (create + edit), editable grade code with uniqueness, delete blocked when the
 * grade is referenced (employment or leave policy) vs succeeding + emitting job-grade.deleted when unused,
 * and archived grades being excluded from the default listing while still visible with includeArchived.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hireEmployee } from '../core/org';
import {
  createJobGrade,
  updateJobGrade,
  deleteJobGrade,
  archiveJobGrade,
  createLeavePolicy,
  DuplicateError,
} from '../core/admin';
import { listJobGrades } from '../core/read';
import { adminCtx, closeAll, eventTypesFor, migrateTestDb, resetDb, seedBase, type Base } from './harness';

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

  it('blocks deletion of a grade referenced by a leave policy', async () => {
    const g = await createJobGrade(ctx(), { code: 'PH', name: 'Permanent - Grade H' });
    await createLeavePolicy(ctx(), {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 18,
      gradeId: g.id,
      validFrom: '2026-01-01',
    });
    await expect(deleteJobGrade(ctx(), { id: g.id })).rejects.toThrow();
    // Still present after the blocked delete.
    const rows = await listJobGrades(ctx(), { includeArchived: true });
    expect(rows.some((r) => r.id === g.id)).toBe(true);
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
