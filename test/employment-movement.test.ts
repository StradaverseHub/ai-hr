/**
 * Employment History — Movement tab redesign (78853b97).
 *
 * The history is a read-model PROJECTION over the domain_event ledger (core/movement.ts): no new table,
 * no dual write, pre-launch events visible on day one. This suite proves the projection's classification
 * rules (Hired-first ordering, initial-salary suppression, voluntary-termination → Resignation, review
 * decisions, fallback labels) and the New Event dispatcher's delegation to the existing writers
 * (Transfer via transferEmployee so location/cost-centre carry; Promotion atomic across assignment +
 * grade with ONE primary row; record-only Secondment; friendly no-change error).
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
import { hireEmployee, transferEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { createPosition, createJobGrade } from '../core/admin';
import { createLocation } from '../core/location';
import { createMovementEvent, movementDetail, movementHistory } from '../core/movement';
import * as schema from '../db/schema';
import { expectNoLeakedValue } from './helpers/leaf-values';

let b: Base;
beforeAll(async () => {
  await migrateTestDb();
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

const email = () => `mv_${randomUUID().slice(0, 8)}@t.local`;

async function hireOne(p?: { managerEmploymentId?: string }) {
  return hireEmployee(adminCtx(b), {
    person: { fullName: 'Movement Test', primaryEmail: email() },
    companyId: b.companyId,
    departmentId: b.deptA,
    positionId: b.positionId,
    costCenterId: b.costCenterId,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
    reportingManagerEmploymentId: p?.managerEmploymentId,
  });
}

async function openAssignment(employmentId: string) {
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

describe('movementHistory — projection over the domain_event ledger', () => {
  it('begins with Hired and suppresses the initial compensation.set at the hire date', async () => {
    const hire = await hireOne();
    // Initial salary AT the hire date is part of Hired, not a movement (import path parity).
    await setCompensation(adminCtx(b), {
      employmentId: hire.employmentId,
      basicSalary: 4000,
      effectiveFrom: '2026-01-01',
    });
    const rows = await movementHistory(adminCtx(b), hire.employmentId);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].kind).toBe('hired');
    expect(rows[0].effectiveDate).toBe('2026-01-01');
    expect(rows.some((r) => r.kind === 'salaryAdjustment' || r.kind === 'increment')).toBe(false);
    // The Hired row comes from the REAL employment.hired event, not the synthesized pseudo-row.
    expect(rows[0].id).not.toBe('hired');
  });

  it('synthesizes a Hired row from hiredOn when no employment.hired event exists (seed/legacy)', async () => {
    // Seed an employment directly (owner role), bypassing hireEmployee — no hired event in the ledger.
    const [p] = await owner.db
      .insert(schema.person)
      .values({ tenantId: b.tenantId, fullName: 'Legacy Seed', primaryEmail: email() })
      .returning({ id: schema.person.id });
    const [emp] = await owner.db
      .insert(schema.employment)
      .values({ tenantId: b.tenantId, personId: p.id, companyId: b.companyId, hiredOn: '2024-05-15', employeeCode: `LEG-${randomUUID().slice(0, 4)}` })
      .returning({ id: schema.employment.id });
    const rows = await movementHistory(adminCtx(b), emp.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'hired', kind: 'hired', effectiveDate: '2024-05-15' });
  });

  it('orders same-day rows Hired-first (hire + its own reporting-line.set share the hire date)', async () => {
    const mgr = await hireOne();
    const hire = await hireOne({ managerEmploymentId: mgr.employmentId });
    const rows = await movementHistory(adminCtx(b), hire.employmentId);
    // The hire-time reporting-line.set carries a LOWER event sequence than employment.hired — the
    // kind priority (not raw sequence) must put Hired first.
    expect(rows[0].kind).toBe('hired');
    expect(rows[1].kind).toBe('reportingLineChange');
    expect(rows[1].effectiveDate).toBe('2026-01-01');
  });

  it('classifies a voluntary termination as Resignation (never a generic Termination)', async () => {
    const hire = await hireOne();
    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'termination',
      effectiveDate: '2026-07-31',
      terminationType: 'voluntary',
      remarks: 'Better offer',
    });
    const rows = await movementHistory(adminCtx(b), hire.employmentId);
    const term = rows.find((r) => r.effectiveDate === '2026-07-31');
    expect(term?.kind).toBe('resignation');
    expect(term?.remarks).toBe('Better offer');
  });

  it('shows an approved review decision as Confirmation (the workflow that bypasses setEmploymentInfo)', async () => {
    const hire = await hireOne();
    // Simulate the real employment-review.decided event the review workflow appends.
    await owner.db.insert(schema.domainEvent).values({
      tenantId: b.tenantId,
      aggregateType: 'employment-review',
      aggregateId: randomUUID(),
      eventType: 'employment-review.decided',
      actorType: 'user',
      subjectEmploymentId: hire.employmentId,
      payload: { decision: 'confirm', reviewType: 'probation' },
    });
    const rows = await movementHistory(adminCtx(b), hire.employmentId);
    expect(rows.some((r) => r.kind === 'confirmation')).toBe(true);
  });

  it('passes unknown record-only kinds through for the UI fallback label (extensible set)', async () => {
    const hire = await hireOne();
    await owner.db.insert(schema.domainEvent).values({
      tenantId: b.tenantId,
      aggregateType: 'employment',
      aggregateId: hire.employmentId,
      eventType: 'employment.movement.recorded',
      actorType: 'user',
      subjectEmploymentId: hire.employmentId,
      payload: { type: 'jobRotation', effectiveDate: '2026-03-01', endDate: null, remarks: null },
    });
    const rows = await movementHistory(adminCtx(b), hire.employmentId);
    expect(rows.some((r) => r.kind === 'jobRotation')).toBe(true);
  });
});

describe('createMovementEvent — the New Event dispatcher', () => {
  it('Transfer routes through transferEmployee: department moves, location + cost centre carry', async () => {
    const hire = await hireOne();
    const loc = await createLocation(adminCtx(b), { companyId: b.companyId, code: `L${randomUUID().slice(0, 4)}`, name: 'HQ Tower' });
    // Give the employee a location first (the capability setEmploymentAssignment would have dropped).
    await transferEmployee(adminCtx(b), { employmentId: hire.employmentId, effectiveDate: '2026-02-01', locationId: loc.id });

    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'transfer',
      effectiveDate: '2026-03-01',
      departmentId: b.deptB,
      remarks: 'Ops restructure',
    });

    const open = await openAssignment(hire.employmentId);
    expect(open.departmentId).toBe(b.deptB);
    expect(open.locationId).toBe(loc.id); // carried, not wiped
    expect(open.costCenterId).toBe(b.costCenterId); // carried, not wiped

    const rows = await movementHistory(adminCtx(b), hire.employmentId);
    const transfers = rows.filter((r) => r.kind === 'transfer');
    expect(transfers.some((r) => r.effectiveDate === '2026-03-01' && r.remarks === 'Ops restructure')).toBe(true);

    // Detail view: before/after department names at the effective date.
    const tagged = transfers.find((r) => r.effectiveDate === '2026-03-01')!;
    const detail = await movementDetail(adminCtx(b), hire.employmentId, tagged.id);
    expect(detail?.before?.department).toBe('Finance');
    expect(detail?.after.department).toBe('Operations');
  });

  it('Promotion is atomic and renders exactly ONE primary row (grade event tagged secondary)', async () => {
    const hire = await hireOne();
    const newPos = await createPosition(adminCtx(b), { companyId: b.companyId, title: `Mgr ${randomUUID().slice(0, 6)}` });
    const grade = await createJobGrade(adminCtx(b), { code: `G${randomUUID().slice(0, 8).toUpperCase()}`, name: `Grade ${randomUUID().slice(0, 5)}`, rank: 2 });

    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'promotion',
      effectiveDate: '2026-06-01',
      positionId: newPos.id,
      gradeId: grade.id,
      remarks: 'Annual cycle',
    });

    // Both sides changed.
    const open = await openAssignment(hire.employmentId);
    expect(open.positionId).toBe(newPos.id);
    const [emp] = await owner.db
      .select({ gradeId: schema.employment.gradeId })
      .from(schema.employment)
      .where(eq(schema.employment.id, hire.employmentId))
      .limit(1);
    expect(emp.gradeId).toBe(grade.id);

    // Exactly one Promotion row — the grade companion event is tagged secondary and skipped.
    const rows = await movementHistory(adminCtx(b), hire.employmentId);
    expect(rows.filter((r) => r.kind === 'promotion')).toHaveLength(1);
    const gradePayload = (await latestEventPayload(b.tenantId, hire.employmentId, 'employment.grade.changed')) as {
      movement?: { type?: string; secondary?: boolean };
    };
    expect(gradePayload.movement?.type).toBe('promotion');
    expect(gradePayload.movement?.secondary).toBe(true);
  });

  it('grade-only Promotion falls back to the grade event carrying the primary tag (one row)', async () => {
    const hire = await hireOne();
    const grade = await createJobGrade(adminCtx(b), { code: `G${randomUUID().slice(0, 8).toUpperCase()}`, name: `Grade ${randomUUID().slice(0, 5)}`, rank: 3 });
    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'promotion',
      effectiveDate: '2026-06-01',
      gradeId: grade.id, // nothing else changes
    });
    const rows = await movementHistory(adminCtx(b), hire.employmentId);
    expect(rows.filter((r) => r.kind === 'promotion')).toHaveLength(1);
    // No dated assignment fragmentation for the unchanged assignment side.
    const asg = await owner.db
      .select({ id: schema.assignment.id })
      .from(schema.assignment)
      .where(eq(schema.assignment.employmentId, hire.employmentId));
    expect(asg).toHaveLength(1);
  });

  it('a full no-op New Event throws the friendly no-changes error (remarks never silently lost)', async () => {
    const hire = await hireOne();
    await expect(
      createMovementEvent(adminCtx(b), {
        employmentId: hire.employmentId,
        kind: 'promotion',
        effectiveDate: '2026-06-01',
        remarks: 'would be lost otherwise', // no field actually changes
      }),
    ).rejects.toThrow(/no changes to record/i);
  });

  it('Salary Adjustment CLOSE+INSERTs compensation and renders one row with the comp-row remarks', async () => {
    const hire = await hireOne();
    await setCompensation(adminCtx(b), { employmentId: hire.employmentId, basicSalary: 4000, effectiveFrom: '2026-01-01' });
    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'salaryAdjustment',
      effectiveDate: '2026-04-01',
      basicSalary: 4500,
      remarks: 'Market correction',
    });
    const comps = await owner.db
      .select()
      .from(schema.compensation)
      .where(eq(schema.compensation.employmentId, hire.employmentId))
      .orderBy(schema.compensation.validFrom);
    expect(comps).toHaveLength(2);
    expect(comps[0].validTo).toBe('2026-04-01'); // prior CLOSED, not overwritten
    expect(comps[1].validFrom).toBe('2026-04-01');
    expect(comps[1].validTo).toBeNull();

    const rows = await movementHistory(adminCtx(b), hire.employmentId);
    const adj = rows.filter((r) => r.kind === 'salaryAdjustment');
    expect(adj).toHaveLength(1); // the 2026-01-01 initial set is suppressed
    expect(adj[0].effectiveDate).toBe('2026-04-01');
    // Remarks reconstructed from the compensation row (redact-to-reference — never in the event payload).
    expect(adj[0].remarks).toBe('Market correction');
    const compEvent = (await latestEventPayload(b.tenantId, comps[1].id, 'compensation.set')) as Record<string, unknown>;
    // By VALUE, not substring: the payload carries UUIDs, and a 4-digit decimal needle made only of
    // hex characters collides with a random UUID about 0.04% of the time — rare enough to look like a
    // mystery gate failure rather than a bug. See test/helpers/leaf-values.ts.
    expectNoLeakedValue(compEvent, 'Market correction'); // free-text remark: redacted to a reference
    expectNoLeakedValue(compEvent, 4500); // the salary amount itself
  });

  it('Secondment is record-only: an event with the end date kept, and NO state change', async () => {
    const hire = await hireOne();
    const before = await openAssignment(hire.employmentId);
    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'secondment',
      effectiveDate: '2026-05-01',
      endDate: '2026-08-31',
      remarks: 'Group project',
    });
    const after = await openAssignment(hire.employmentId);
    expect(after.id).toBe(before.id); // no CLOSE+INSERT, nothing moved
    expect(await eventTypesFor(b.tenantId, hire.employmentId)).toContain('employment.movement.recorded');

    const rows = await movementHistory(adminCtx(b), hire.employmentId);
    const sec = rows.find((r) => r.kind === 'secondment');
    expect(sec).toMatchObject({ effectiveDate: '2026-05-01', endDate: '2026-08-31', remarks: 'Group project' });
  });

  it('rejects a non-admin caller (defence-in-depth over the writers)', async () => {
    const hire = await hireOne();
    await expect(
      createMovementEvent(
        { tenantId: b.tenantId, userId: b.adminUserId, roles: ['employee'] },
        { employmentId: hire.employmentId, kind: 'secondment', effectiveDate: '2026-05-01' },
      ),
    ).rejects.toThrow(/only an admin/i);
  });
});
