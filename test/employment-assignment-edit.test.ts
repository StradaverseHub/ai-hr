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
    expect(before.departmentId).toBe(b.deptA);
    expect(before.positionId).toBe(b.positionId);

    const newPos = await createPosition(adminCtx(b), { companyId: b.companyId, title: `Sr ${randomUUID().slice(0, 6)}` });

    const res = await setEmploymentAssignment(adminCtx(b), {
      employmentId: hire.employmentId,
      effectiveDate: '2026-06-01',
      departmentId: b.deptB,
      positionId: newPos.id,
      employmentType: 'contract',
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

    // Audited domain event on the NEW assignment id, with the full before/after diff.
    expect(await eventTypesFor(b.tenantId, open.id)).toContain('employment.assignment.changed');
    const payload = (await latestEventPayload(b.tenantId, open.id, 'employment.assignment.changed')) as any;
    expect(payload.before).toMatchObject({ departmentId: b.deptA, positionId: b.positionId, employmentType: 'full_time' });
    expect(payload.after).toMatchObject({ departmentId: b.deptB, positionId: newPos.id, employmentType: 'contract' });
    // R81 — the before/after diff no longer carries a `status` key at all. There is no stored status to
    // diff, so an audit reader can never be shown a status "change" that did not correspond to an event.
    expect(payload.before).not.toHaveProperty('status');
    expect(payload.after).not.toHaveProperty('status');
    expect(payload.effectiveDate).toBe('2026-06-01');

    // assignmentHistory (the read powering the UI) now exposes the ids for dropdown pre-selection.
    const hist = await assignmentHistory(adminCtx(b), hire.employmentId);
    expect(hist).toHaveLength(2);
    expect(hist[0].departmentId).toBe(b.deptB); // newest first
    expect(hist[0].positionId).toBe(newPos.id);
  });

  // R81 (9cbf5e0d) — THE "NO MANUAL EDITING" TEST. This case used to be "changing only Employee Status
  // carries department/position forward": it set status: 'on_leave' and asserted the new version stored it.
  // That path is the one the reporter's rules abolish. The parameter is gone from the service, so a caller
  // that still supplies one — a stale client, a hand-rolled RPC, anything that knows the exported symbol —
  // gets a NO-OP: no new dated version, no event, and nothing written. Asserting `changed === false` rather
  // than a throw is deliberate; the point is that the status simply has nowhere to go.
  it('supplying a status is a no-op — there is no manual status path left', async () => {
    const hire = await hireOne();
    const first = await openRow(hire.employmentId);
    const res = await setEmploymentAssignment(adminCtx(b), {
      employmentId: hire.employmentId,
      effectiveDate: '2026-03-01',
      // Cast, because the parameter no longer exists in the type — which is itself half the guarantee.
      ...({ status: 'on_leave' } as Record<string, unknown>),
    });
    expect(res.changed).toBe(false);
    const rows = await assignmentRows(hire.employmentId);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(first.id);
    expect(await eventTypesFor(b.tenantId, first.id)).not.toContain('employment.assignment.changed');
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
        departmentId: b.deptB,
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

  // This case used to prove the DB enum was "the last line of defence" against a tampered status string.
  // R81 removes the column, so there is no longer a value to tamper with: a bogus status is inert rather
  // than rejected. Employment TYPE, which IS still an enum column and IS still settable, keeps that guard —
  // so the test now pins the defence where it still applies rather than deleting the coverage.
  it('only valid enum values are accepted (a tampered employment type never reaches the DB column)', async () => {
    const hire = await hireOne();
    await expect(
      setEmploymentAssignment(adminCtx(b), {
        employmentId: hire.employmentId,
        effectiveDate: '2026-06-01',
        employmentType: 'bogus_type' as never,
      }),
    ).rejects.toThrow();
    // History stays intact after the rejected write.
    expect((await assignmentRows(hire.employmentId))).toHaveLength(1);
  });
});
