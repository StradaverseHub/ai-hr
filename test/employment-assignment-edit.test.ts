/**
 * Employment tab org-info edit (feedback 594323a6) — HR maintains Department, Position, Employment Type and
 * Employee Status from the Personnel Employment tab through setEmploymentAssignment (effective-dated
 * CLOSE+INSERT: history preserved, audited `employment.assignment.changed` event), and Job Grade through
 * setEmploymentGrade. This suite proves: each dimension edits; a dated assignment row is created so the
 * prior version stays intact; only valid enum values reach the DB column (via the action's guard); no-ops
 * do not fragment history; and an out-of-order effective date is rejected.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  adminCtx,
  closeAll,
  eventTypesFor,
  latestEventPayload,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';
import { hireEmployee, setEmploymentAssignment, setEmploymentGrade } from '../core/org';
import { createPosition, createJobGrade } from '../core/admin';
import { assignmentHistory } from '../core/read';
import * as schema from '../db/schema';

let b: Base;
beforeAll(async () => {
  await migrateTestDb();
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

const email = () => `asg_${randomUUID().slice(0, 8)}@t.local`;

async function assignmentRows(employmentId: string) {
  return owner.db
    .select()
    .from(schema.assignment)
    .where(eq(schema.assignment.employmentId, employmentId))
    .orderBy(schema.assignment.validFrom);
}
async function openRow(employmentId: string) {
  const [row] = await owner.db
    .select()
    .from(schema.assignment)
    .where(
      and(
        eq(schema.assignment.employmentId, employmentId),
        isNull(schema.assignment.validTo),
        isNull(schema.assignment.supersededAt),
      ),
    )
    .limit(1);
  return row;
}

async function hireOne() {
  return hireEmployee(adminCtx(b), {
    person: { fullName: 'Assign Test', primaryEmail: email() },
    companyId: b.companyId,
    departmentId: b.deptA,
    positionId: b.positionId,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
}

describe('setEmploymentAssignment — effective-dated org edit', () => {
  it('changes all four dimensions, preserves history, and emits a before/after event', async () => {
    const hire = await hireOne();
    const before = await openRow(hire.employmentId);
    expect(before.status).toBe('active'); // full_time, no provisional end
    expect(before.departmentId).toBe(b.deptA);
    expect(before.positionId).toBe(b.positionId);

    const newPos = await createPosition(adminCtx(b), { companyId: b.companyId, title: `Sr ${randomUUID().slice(0, 6)}` });

    const res = await setEmploymentAssignment(adminCtx(b), {
      employmentId: hire.employmentId,
      effectiveDate: '2026-06-01',
      departmentId: b.deptB,
      positionId: newPos.id,
      employmentType: 'contract',
      status: 'probation',
    });
    expect(res.changed).toBe(true);

    // Prior version is CLOSED at the effective date (history preserved), not overwritten.
    const rows = await assignmentRows(hire.employmentId);
    expect(rows).toHaveLength(2);
    const closed = rows.find((r) => r.id === before.id)!;
    expect(closed.validTo).toBe('2026-06-01');
    expect(closed.departmentId).toBe(b.deptA); // old row untouched
    expect(closed.positionId).toBe(b.positionId);
    expect(closed.employmentType).toBe('full_time');

    // New open version carries the changed values.
    const open = await openRow(hire.employmentId);
    expect(open.id).not.toBe(before.id);
    expect(open.validFrom).toBe('2026-06-01');
    expect(open.validTo).toBeNull();
    expect(open.departmentId).toBe(b.deptB);
    expect(open.positionId).toBe(newPos.id);
    expect(open.employmentType).toBe('contract');
    expect(open.status).toBe('probation');

    // Audited domain event on the NEW assignment id, with the full before/after diff.
    expect(await eventTypesFor(b.tenantId, open.id)).toContain('employment.assignment.changed');
    const payload = (await latestEventPayload(b.tenantId, open.id, 'employment.assignment.changed')) as any;
    expect(payload.before).toMatchObject({ departmentId: b.deptA, positionId: b.positionId, employmentType: 'full_time', status: 'active' });
    expect(payload.after).toMatchObject({ departmentId: b.deptB, positionId: newPos.id, employmentType: 'contract', status: 'probation' });
    expect(payload.effectiveDate).toBe('2026-06-01');

    // assignmentHistory (the read powering the UI) now exposes the ids for dropdown pre-selection.
    const hist = await assignmentHistory(adminCtx(b), hire.employmentId);
    expect(hist).toHaveLength(2);
    expect(hist[0].departmentId).toBe(b.deptB); // newest first
    expect(hist[0].positionId).toBe(newPos.id);
  });

  it('changing only Employee Status carries department/position forward', async () => {
    const hire = await hireOne();
    const res = await setEmploymentAssignment(adminCtx(b), {
      employmentId: hire.employmentId,
      effectiveDate: '2026-03-01',
      status: 'on_leave',
    });
    expect(res.changed).toBe(true);
    const open = await openRow(hire.employmentId);
    expect(open.status).toBe('on_leave');
    expect(open.departmentId).toBe(b.deptA); // unchanged, carried forward
    expect(open.positionId).toBe(b.positionId);
    expect((await assignmentRows(hire.employmentId))).toHaveLength(2);
  });

  it('is a no-op (no new row, no event) when nothing actually changed', async () => {
    const hire = await hireOne();
    const first = await openRow(hire.employmentId);
    const res = await setEmploymentAssignment(adminCtx(b), {
      employmentId: hire.employmentId,
      effectiveDate: '2026-06-01',
      departmentId: b.deptA, // same as current
      positionId: b.positionId,
      employmentType: 'full_time',
      status: 'active',
    });
    expect(res.changed).toBe(false);
    const rows = await assignmentRows(hire.employmentId);
    expect(rows).toHaveLength(1); // no fragmentation
    expect(rows[0].id).toBe(first.id);
    expect(await eventTypesFor(b.tenantId, first.id)).not.toContain('employment.assignment.changed');
  });

  it('rejects an effective date before the current assignment start', async () => {
    const hire = await hireOne(); // hired 2026-01-01
    await expect(
      setEmploymentAssignment(adminCtx(b), {
        employmentId: hire.employmentId,
        effectiveDate: '2025-12-01',
        status: 'on_leave',
      }),
    ).rejects.toThrow(/before the current assignment/i);
  });

  it('Job Grade edits through its own audited writer (employment.gradeId)', async () => {
    const hire = await hireOne();
    const grade = await createJobGrade(adminCtx(b), { code: `G${randomUUID().slice(0, 8).toUpperCase()}`, name: `Grade ${randomUUID().slice(0, 5)}`, rank: 1 });
    await setEmploymentGrade(adminCtx(b), { employmentId: hire.employmentId, gradeId: grade.id });
    const [emp] = await owner.db
      .select({ gradeId: schema.employment.gradeId })
      .from(schema.employment)
      .where(eq(schema.employment.id, hire.employmentId))
      .limit(1);
    expect(emp.gradeId).toBe(grade.id);
    expect(await eventTypesFor(b.tenantId, hire.employmentId)).toContain('employment.grade.changed');
  });

  it('only valid enum values are accepted (an unknown value never reaches the DB column)', async () => {
    // The DB enum column is the last line of defence: a tampered status string is rejected by Postgres.
    const hire = await hireOne();
    await expect(
      setEmploymentAssignment(adminCtx(b), {
        employmentId: hire.employmentId,
        effectiveDate: '2026-06-01',
        status: 'bogus_status' as any,
      }),
    ).rejects.toThrow();
    // History stays intact after the rejected write.
    expect((await assignmentRows(hire.employmentId))).toHaveLength(1);
  });
});
