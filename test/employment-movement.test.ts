/**
 * Employment History — Movement tab redesign (78853b97).
 *
 * The history is a read-model PROJECTION over the domain_event ledger (core/movement.ts): no new table,
 * no dual write, pre-launch events visible on day one. This suite proves the projection's classification
 * rules (Hired-first ordering, initial-salary suppression, voluntary-termination → Resignation, review
 * decisions, fallback labels) and the New Event dispatcher's delegation to the existing writers
 * (Promotion atomic across assignment + grade with ONE primary row; record-only Secondment; friendly
 * no-change error).
 *
 * 08913328 added the Current / After comparison screen, so the dispatcher's DELTA rule is proven here
 * too: resubmitting the current values writes nothing, and one submit spanning org + grade + a flat
 * column + pay commits atomically as ONE history row.
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
import { hireEmployee, setEmploymentAssignment, transferEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { createBusinessUnit, createPosition, createJobGrade } from '../core/admin';
import { createLocation } from '../core/location';
import { createMovementEvent, movementCurrentState, movementDetail, movementHistory } from '../core/movement';
import { sweepDueMovements } from '../core/movement-apply';
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

  it('a hire with a manager projects ONE row — its own reporting line is part of the hire, not a movement', async () => {
    const mgr = await hireOne();
    const hire = await hireOne({ managerEmploymentId: mgr.employmentId });
    const rows = await movementHistory(adminCtx(b), hire.employmentId);
    // r78c — this assertion INVERTED. It used to pin rows[1].kind === 'reportingLineChange': the hire-time
    // reporting-line.set went out untagged, and reporting-line.set is a MOVEMENT_EVENT_TYPE, so every
    // employee hired with a manager opened their history with TWO rows dated the same day for ONE action —
    // the same one-event-two-rows fault the reporter raised about Promotion. hireEmployee now tags that leg
    // `secondary`, so the projection skips it and the hire reads as one event.
    expect(rows[0].kind).toBe('hired');
    expect(rows[0].effectiveDate).toBe('2026-01-01');
    expect(rows).toHaveLength(1);
    // The EVENT itself is untouched — only its payload gained the tag; that the audit trail did not shrink
    // is asserted in test/employment-history-untagged-writers.test.ts (2), which reads it by SUBJECT
    // employment (a reporting-line event's aggregate is the LINE, not the employment).
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
  // 08913328 — Transfer no longer routes through transferEmployee. That writer predates business_unit_id
  // and drops it on the version it inserts, which would silently wipe the BU of every employee moved from
  // a comparison form that shows it. setEmploymentAssignment carries every dimension and now owns Work
  // Location too, so ONE writer covers the whole assignment leg. The substantive guarantees are unchanged
  // (department moves; location, cost centre and BU carry) and BU carry is newly asserted.
  it('Transfer moves the department while location, cost centre and business unit all carry', async () => {
    const hire = await hireOne();
    const loc = await createLocation(adminCtx(b), { companyId: b.companyId, code: `L${randomUUID().slice(0, 4)}`, name: 'HQ Tower' });
    // Give the employee a location + business unit first, so the carry-forward is actually tested.
    await transferEmployee(adminCtx(b), { employmentId: hire.employmentId, effectiveDate: '2026-02-01', locationId: loc.id });
    const bu = await createBusinessUnit(adminCtx(b), {
      companyId: b.companyId,
      code: `BU${randomUUID().slice(0, 6).toUpperCase()}`,
      name: `Unit ${randomUUID().slice(0, 5)}`,
    });
    await setEmploymentAssignment(adminCtx(b), {
      employmentId: hire.employmentId,
      effectiveDate: '2026-02-01',
      businessUnitId: bu.id,
    });

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
    expect(open.businessUnitId).toBe(bu.id); // transferEmployee used to drop this

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

  // ── 08913328: the Current / After comparison form ────────────────────────────────────────────────
  // The screen submits the WHOLE right column, so these prove the dispatcher writes DELTAS only.

  it('resubmitting every current value unchanged writes nothing at all', async () => {
    const hire = await hireOne();
    await setCompensation(adminCtx(b), { employmentId: hire.employmentId, basicSalary: 4000, effectiveFrom: '2026-01-01' });
    const cur = await movementCurrentState(adminCtx(b), hire.employmentId);
    const before = await eventTypesFor(b.tenantId, hire.employmentId);

    await expect(
      createMovementEvent(adminCtx(b), {
        employmentId: hire.employmentId,
        kind: 'promotion',
        effectiveDate: '2026-06-01',
        // Exactly what the form would post for an untouched screen.
        departmentId: cur.departmentId,
        positionId: cur.positionId,
        businessUnitId: cur.businessUnitId,
        locationId: cur.locationId,
        gradeId: cur.gradeId,
        employmentType: cur.employmentType as 'full_time',
        managerEmploymentId: cur.managerEmploymentId,
        basicSalary: Number(cur.basicSalary),
        currency: cur.currency ?? undefined,
        payMode: cur.payMode ?? undefined,
        paymentTerm: cur.paymentTerm ?? undefined,
        orgDivision: cur.orgDivision,
        employmentCategory: cur.employmentCategory,
        remarks: 'nothing moved',
      }),
    ).rejects.toThrow(/no changes to record/i);

    // No assignment version, no compensation revision, no new events.
    const asg = await owner.db
      .select({ id: schema.assignment.id })
      .from(schema.assignment)
      .where(eq(schema.assignment.employmentId, hire.employmentId));
    expect(asg).toHaveLength(1);
    const comps = await owner.db
      .select({ id: schema.compensation.id })
      .from(schema.compensation)
      .where(eq(schema.compensation.employmentId, hire.employmentId));
    expect(comps).toHaveLength(1);
    expect(await eventTypesFor(b.tenantId, hire.employmentId)).toEqual(before);
  });

  it('one submit moves org, grade, a flat column and pay atomically, and renders ONE history row', async () => {
    const hire = await hireOne();
    await setCompensation(adminCtx(b), { employmentId: hire.employmentId, basicSalary: 4000, effectiveFrom: '2026-01-01' });
    const gradeName = `Grade ${randomUUID().slice(0, 5)}`;
    const grade = await createJobGrade(adminCtx(b), { code: `G${randomUUID().slice(0, 8).toUpperCase()}`, name: gradeName, rank: 4 });

    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'promotion',
      effectiveDate: '2026-06-01',
      departmentId: b.deptB,
      gradeId: grade.id,
      orgDivision: 'Retail',
      basicSalary: 5200,
      remarks: 'Annual cycle',
    });

    const open = await openAssignment(hire.employmentId);
    expect(open.departmentId).toBe(b.deptB);
    const [emp] = await owner.db
      .select({ gradeId: schema.employment.gradeId, orgDivision: schema.employment.orgDivision })
      .from(schema.employment)
      .where(eq(schema.employment.id, hire.employmentId))
      .limit(1);
    expect(emp.gradeId).toBe(grade.id);
    expect(emp.orgDivision).toBe('Retail');

    // Four legs, ONE row: the companions are tagged secondary and share the primary's groupId.
    const rows = await movementHistory(adminCtx(b), hire.employmentId);
    expect(rows.filter((r) => r.kind === 'promotion')).toHaveLength(1);
    expect(rows.filter((r) => r.kind === 'salaryAdjustment' || r.kind === 'gradeChange')).toHaveLength(0);

    // The detail spans the WHOLE group: grade came from a leg with a higher sequence than the primary.
    const primary = rows.find((r) => r.kind === 'promotion')!;
    const detail = await movementDetail(adminCtx(b), hire.employmentId, primary.id);
    expect(detail?.after.department).toBe('Operations');
    expect(detail?.after.grade).toBe(gradeName);
    expect(detail?.after.salary).toBe('MYR 5200.00');
    // The flat column is not effective-dated, so its before/after comes from the movement's own event.
    expect(detail?.flatChanges).toEqual([{ field: 'orgDivision', before: null, after: 'Retail' }]);
  });

  /**
   * 941c9dac — this test's guarantee (an earlier payroll period keeps the old rate) is unchanged, but the
   * mechanism behind it is now stronger and the test says so. It used to assert that a future-dated
   * increment wrote its compensation row IMMEDIATELY and relied on the dated window to keep June honest.
   * That immediate write is the very fault 941c9dac fixed — it also made the future rate the OPEN row,
   * which is what the Employment tab, the ESS profile and the directory all read as "current".
   *
   * Now the increment writes NOTHING until its effective date arrives, and the sweep writes it then. June
   * is protected twice over: before the date there is no new record at all, and after it the record starts
   * in September.
   */
  it('a future-dated pay change writes nothing until it applies, and never disturbs an earlier period', async () => {
    const hire = await hireOne();
    await setCompensation(adminCtx(b), { employmentId: hire.employmentId, basicSalary: 4000, effectiveFrom: '2026-01-01' });
    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'increment',
      effectiveDate: '2026-09-01',
      basicSalary: 4800,
    });

    const compsOf = () =>
      owner.db
        .select()
        .from(schema.compensation)
        .where(eq(schema.compensation.employmentId, hire.employmentId))
        .orderBy(schema.compensation.validFrom);

    // Before the effective date: no revision exists, and the OPEN row is still the current rate — so no
    // reader anywhere can show September's salary as today's.
    const pending = await compsOf();
    expect(pending).toHaveLength(1);
    expect(pending[0].basicSalary).toBe('4000.00');
    expect(pending[0].validTo).toBeNull();

    // On the effective date the sweep applies it.
    await sweepDueMovements(adminCtx(b), { today: '2026-09-01' });
    const comps = await compsOf();
    expect(comps).toHaveLength(2);
    // The window a June payroll run resolves is still the OLD record — the new one starts in September.
    const june = comps.filter((c) => c.validFrom <= '2026-06-01' && (c.validTo == null || c.validTo > '2026-06-01'));
    expect(june).toHaveLength(1);
    expect(june[0].basicSalary).toBe('4000.00');
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
