/**
 * b7b22514 — "New Movement Event: Entity Transfer".
 *
 * WHAT WAS ACTUALLY MISSING, which is much narrower than the request reads. The reporter proposed a data
 * model — a staff ID that never changes, a group hire date that never changes, a company hire date that
 * moves on transfer, service computed from the group date — and that model ALREADY EXISTS verbatim
 * (`employment.hired_on` / `employment.join_date`, 89ea527b). The gap was one thing: no movement writer took
 * a companyId, so there was no way on any screen to move an employee from one legal entity to another.
 *
 * WHY IT IS A BUILT-IN KIND AND NOT A CATALOGUE ROW. `movement_event_type` (476f23ed) lets a tenant add an
 * event type of its own, but every catalogue row maps onto a BUILT-IN behaviour, and the only behaviour a
 * "Entity Transfer" row could have mapped onto is `transfer` — which cannot change company. The catalogue
 * looks like the answer and is not; the module header of core/movement-kinds.ts says so in as many words.
 *
 * THE RISK IS CROSS-COMPANY COHERENCE AND RLS CANNOT CATCH IT. core/org.ts already warns that a location
 * must belong to the employment's company because "RLS checks assignment and location independently, so it
 * can't enforce this; the service does". Changing the company invalidates department, position, business
 * unit, cost centre, location AND the reporting manager the same way, all at once. Every one is re-resolved
 * against the DESTINATION in the same transaction, whether or not its id moved — because on a company move
 * the UNCHANGED value is the dangerous one, and the changed-only guards elsewhere would wave it through.
 *
 * What this suite pins:
 *   • the gap itself — a plain Transfer still cannot move a company, and an Entity Transfer can;
 *   • coherence, field by field, including the carried-forward cost centre no form can touch;
 *   • the dates: `hired_on` byte-identical, `join_date` moved to the effective date, automatically;
 *   • that leave entitlement still counts from GROUP service after the move (the reporter's real worry);
 *   • the history row names BOTH companies, and rows before the transfer still name the old one;
 *   • rollback puts the company AND the join date back, and the as-of replay follows;
 *   • a backdated transfer leaves a closed payroll run alone;
 *   • the boundaries: no tenant can mint a type that moves a legal entity, and no correction can
 *     re-classify across the Entity Transfer line in either direction.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  adminCtx,
  closeAll,
  eventTypesFor,
  ledgerBalance,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  seedEntitlement,
  type Base,
} from './harness';
import { CrossCompanyError, hireEmployee, setReportingLine } from '../core/org';
import {
  COMPARISON_KINDS,
  INTERCHANGEABLE_COMPARISON_KINDS,
  MOVEMENT_KINDS,
  createMovementEvent,
  editMovementEvent,
  movementDetail,
  movementHistory,
  MovementNotCorrectableError,
  reverseMovementEvent,
} from '../core/movement';
import { CONFIGURABLE_BEHAVIOUR_KINDS, saveMovementEventType } from '../core/movement-type';
import { sweepDueMovements } from '../core/movement-apply';
import { openLeaveYear, serviceYearsAt } from '../core/leave';
import { employeeDetail } from '../core/read';
import type { ServiceBand } from '../core/leave-compute';
import { todayInKualaLumpur } from '../lib/hr-date';
import * as schema from '../db/schema';

let b: Base;
/** The DESTINATION legal entity and its own org master data — a second company in the same tenant. */
let coB: string;
let deptB2: string;
let posB: string;
let buB: string;
let locB: string;
/** A location in the ORIGINAL company — the cross-company case that must be refused. */
let locA: string;

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(closeAll);

beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  const [co] = await owner.db
    .insert(schema.company)
    .values({ tenantId: b.tenantId, legalName: 'Beta Sdn Bhd' })
    .returning({ id: schema.company.id });
  coB = co.id;
  const [d] = await owner.db
    .insert(schema.department)
    .values({ tenantId: b.tenantId, companyId: coB, name: 'Beta Operations' })
    .returning({ id: schema.department.id });
  deptB2 = d.id;
  const [pp] = await owner.db
    .insert(schema.position)
    .values({ tenantId: b.tenantId, companyId: coB, title: 'Beta Executive' })
    .returning({ id: schema.position.id });
  posB = pp.id;
  const [bu] = await owner.db
    .insert(schema.businessUnit)
    .values({ tenantId: b.tenantId, companyId: coB, code: 'BBU', name: 'Beta BU' })
    .returning({ id: schema.businessUnit.id });
  buB = bu.id;
  const [lb] = await owner.db
    .insert(schema.location)
    .values({ tenantId: b.tenantId, companyId: coB, code: 'KL', name: 'Kuala Lumpur', country: 'MY' })
    .returning({ id: schema.location.id });
  locB = lb.id;
  const [la] = await owner.db
    .insert(schema.location)
    .values({ tenantId: b.tenantId, companyId: b.companyId, code: 'JHR', name: 'Johor', country: 'MY' })
    .returning({ id: schema.location.id });
  locA = la.id;
});

const email = () => `et_${randomUUID().slice(0, 8)}@t.local`;

/** ISO date + n days, pure UTC string maths (the codebase's dayBefore/plusDays convention). */
function plusDays(iso: string, n: number): string {
  const t = Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
  return new Date(t + n * 86_400_000).toISOString().slice(0, 10);
}
const TODAY = todayInKualaLumpur();

/** Hire into the ORIGINAL company. `hiredOn` is the GROUP join date; join_date is seeded equal to it. */
async function hireOne(p?: { hiredOn?: string; locationId?: string }) {
  const hire = await hireEmployee(adminCtx(b), {
    person: { fullName: 'Transfer Subject', primaryEmail: email() },
    companyId: b.companyId,
    departmentId: b.deptA,
    positionId: b.positionId,
    costCenterId: b.costCenterId,
    employmentType: 'full_time',
    hiredOn: p?.hiredOn ?? '2018-01-01',
  });
  // hireEmployee takes no location (ADR-0054 keeps it on the assignment), so the fixture writes it
  // straight onto the open version — which is exactly the shape the carry-forward guard must see.
  if (p?.locationId) {
    await owner.db
      .update(schema.assignment)
      .set({ locationId: p.locationId })
      .where(eq(schema.assignment.employmentId, hire.employmentId));
  }
  return hire;
}

async function employmentRow(employmentId: string) {
  const [row] = await owner.db
    .select({
      companyId: schema.employment.companyId,
      hiredOn: schema.employment.hiredOn,
      joinDate: schema.employment.joinDate,
      payrollPolicyId: schema.employment.payrollPolicyId,
      costAllocation: schema.employment.costAllocation,
    })
    .from(schema.employment)
    .where(eq(schema.employment.id, employmentId))
    .limit(1);
  return row;
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

/** The submission that moves EVERY company-scoped field onto the destination — the coherent transfer. */
const coherentMove = (employmentId: string, effectiveDate = TODAY) => ({
  employmentId,
  kind: 'entityTransfer' as const,
  effectiveDate,
  companyId: coB,
  departmentId: deptB2,
  positionId: posB,
  businessUnitId: buB,
  locationId: locB,
  remarks: 'Group restructure',
});

// ───────────────────────────── the gap this item closes ─────────────────────────────

describe('the gap: no movement writer took a companyId', () => {
  it('a plain Transfer still cannot move a company — a submitted companyId is IGNORED, not obeyed', async () => {
    const hire = await hireOne();
    // The forged-field case. Nothing on the Transfer form posts companyId; the guard that matters is the
    // service's, because an absent control is not a permission.
    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'transfer',
      effectiveDate: TODAY,
      companyId: coB,
      departmentId: b.deptB,
    });
    const emp = await employmentRow(hire.employmentId);
    expect(emp.companyId).toBe(b.companyId);
    // …and the department move it WAS asked for still happened, so the field was dropped, not the movement.
    expect((await openAssignment(hire.employmentId)).departmentId).toBe(b.deptB);
  });

  it('an Entity Transfer moves the company, and clears the defaults that pointed at the old one', async () => {
    const hire = await hireOne();
    const [pol] = await owner.db
      .insert(schema.payrollPolicy)
      .values({ tenantId: b.tenantId, companyId: b.companyId, name: 'Monthly', policyType: 'monthly' })
      .returning({ id: schema.payrollPolicy.id });
    await owner.db
      .update(schema.employment)
      .set({ payrollPolicyId: pol.id, costAllocation: [{ companyId: b.companyId, percent: 100 }] })
      .where(eq(schema.employment.id, hire.employmentId));

    const asg = await openAssignment(hire.employmentId);
    await owner.db.update(schema.assignment).set({ costCenterId: null }).where(eq(schema.assignment.id, asg.id));
    await createMovementEvent(adminCtx(b), coherentMove(hire.employmentId));

    const emp = await employmentRow(hire.employmentId);
    expect(emp.companyId).toBe(coB);
    // Both pointed at the company they just left. Nulled rather than re-pointed: each resolves per company
    // at render, so null re-resolves correctly and a stale id would not.
    expect(emp.payrollPolicyId).toBeNull();
    expect(emp.costAllocation).toBeNull();
  });

  it('an Entity Transfer with no destination is refused by name, not as a no-op', async () => {
    const hire = await hireOne();
    await expect(
      createMovementEvent(adminCtx(b), {
        employmentId: hire.employmentId,
        kind: 'entityTransfer',
        effectiveDate: TODAY,
        departmentId: deptB2,
      }),
    ).rejects.toThrow(/transferring to/i);
  });

  it('moving to the company the employee is already in is refused', async () => {
    const hire = await hireOne();
    await expect(
      createMovementEvent(adminCtx(b), {
        employmentId: hire.employmentId,
        kind: 'entityTransfer',
        effectiveDate: TODAY,
        companyId: b.companyId,
      }),
    ).rejects.toThrow();
  });
});

// ──────────────────── cross-company coherence: the risk RLS cannot catch ────────────────────

describe('cross-company coherence — every org field is re-resolved against the DESTINATION', () => {
  it('REFUSES a department belonging to the old company — the carried-forward case', async () => {
    const hire = await hireOne();
    // HR moves only the company. The department is never touched, so it is the ORIGINAL company's — and a
    // changed-only guard would skip it precisely because nobody edited it. That is the whole trap.
    await expect(
      createMovementEvent(adminCtx(b), {
        employmentId: hire.employmentId,
        kind: 'entityTransfer',
        effectiveDate: TODAY,
        companyId: coB,
      }),
    ).rejects.toThrow(CrossCompanyError);
    // And nothing landed half-done: the refusal is raised before the flip, inside the movement's tx.
    expect((await employmentRow(hire.employmentId)).companyId).toBe(b.companyId);
  });

  it('REFUSES a department belonging to the old company — the explicitly re-supplied case', async () => {
    const hire = await hireOne();
    await expect(
      createMovementEvent(adminCtx(b), {
        employmentId: hire.employmentId,
        kind: 'entityTransfer',
        effectiveDate: TODAY,
        companyId: coB,
        departmentId: b.deptA, // the old company's, typed in deliberately
      }),
    ).rejects.toThrow(CrossCompanyError);
  });

  it('REFUSES an old-company position, business unit and work location', async () => {
    for (const bad of [
      { positionId: b.positionId },
      { businessUnitId: await (async () => {
          const [bu] = await owner.db
            .insert(schema.businessUnit)
            .values({ tenantId: b.tenantId, companyId: b.companyId, code: `A${randomUUID().slice(0, 4)}`, name: 'Alpha BU' })
            .returning({ id: schema.businessUnit.id });
          return bu.id;
        })() },
      { locationId: locA },
    ]) {
      const hire = await hireOne();
      await expect(
        createMovementEvent(adminCtx(b), {
          employmentId: hire.employmentId,
          kind: 'entityTransfer',
          effectiveDate: TODAY,
          companyId: coB,
          departmentId: deptB2,
          ...bad,
        }),
      ).rejects.toThrow(CrossCompanyError);
      expect((await employmentRow(hire.employmentId)).companyId).toBe(b.companyId);
    }
  });

  it('REFUSES a CARRIED-FORWARD work location no form field touched', async () => {
    // The employee holds a Johor (old-company) location from hire. The submission never mentions it, so a
    // changed-only guard sees nothing to check and the employee would land in KL still assigned to Johor.
    const hire = await hireOne({ locationId: locA });
    expect((await openAssignment(hire.employmentId)).locationId).toBe(locA);
    await expect(
      createMovementEvent(adminCtx(b), {
        employmentId: hire.employmentId,
        kind: 'entityTransfer',
        effectiveDate: TODAY,
        companyId: coB,
        departmentId: deptB2,
      }),
    ).rejects.toThrow(CrossCompanyError);
  });

  it('REFUSES a CARRIED-FORWARD cost centre — the field NO movement surface can move', async () => {
    // hireEmployee sets costCenterId; the comparison form has no control for it, so it can only ever be
    // carried forward. That makes it the one field a caller-assembled placement would silently drop.
    const hire = await hireOne();
    expect((await openAssignment(hire.employmentId)).costCenterId).toBe(b.costCenterId);
    await expect(
      createMovementEvent(adminCtx(b), {
        employmentId: hire.employmentId,
        kind: 'entityTransfer',
        effectiveDate: TODAY,
        companyId: coB,
        departmentId: deptB2,
      }),
    ).rejects.toThrow(CrossCompanyError);
  });

  it('REFUSES leaving the employee reporting to a manager in the company they LEFT', async () => {
    // APPROVAL ROUTING is why. leave_approval_policy scopes by company and grade group, so an employee
    // still reporting across the entity boundary has approvers the destination's policy cannot route to —
    // discovered by the employee, when their leave application has nowhere to go.
    const mgr = await hireOne();
    const hire = await hireOne();
    await setReportingLine(adminCtx(b), {
      subordinateEmploymentId: hire.employmentId,
      managerEmploymentId: mgr.employmentId,
      lineType: 'administrative',
      validFrom: '2018-01-01',
    });
    await expect(
      createMovementEvent(adminCtx(b), {
        employmentId: hire.employmentId,
        kind: 'entityTransfer',
        effectiveDate: TODAY,
        companyId: coB,
        departmentId: deptB2,
        positionId: posB,
        locationId: null,
      }),
    ).rejects.toThrow(CrossCompanyError);
  });

  it('ACCEPTS the transfer once every field names the destination, and re-homes them all in one go', async () => {
    const hire = await hireOne({ locationId: locA });
    // The cost centre must be cleared too — nothing on the form does it, so the guard would refuse. Doing
    // it here is the test standing in for "HR clears it on the Employment tab first", which is the
    // documented route for the two fields Movement deliberately does not own.
    const asg = await openAssignment(hire.employmentId);
    await owner.db
      .update(schema.assignment)
      .set({ costCenterId: null })
      .where(eq(schema.assignment.id, asg.id));

    await createMovementEvent(adminCtx(b), coherentMove(hire.employmentId));

    const emp = await employmentRow(hire.employmentId);
    expect(emp.companyId).toBe(coB);
    const next = await openAssignment(hire.employmentId);
    expect(next.departmentId).toBe(deptB2);
    expect(next.positionId).toBe(posB);
    expect(next.businessUnitId).toBe(buB);
    expect(next.locationId).toBe(locB);
    // CLOSE + INSERT, not an overwrite: the pre-transfer placement is still on the record.
    expect(next.validFrom).toBe(TODAY);
  });
});

// ──────────────────────── the two dates: the model the reporter proposed ────────────────────────

describe('the dates — hired_on is the anchor, join_date follows the transfer', () => {
  it('hired_on is byte-identical after the transfer, and join_date becomes the effective date', async () => {
    const hire = await hireOne({ hiredOn: '2018-03-15' });
    const before = await employmentRow(hire.employmentId);
    expect(before.hiredOn).toBe('2018-03-15');
    expect(before.joinDate).toBe('2018-03-15'); // seeded equal at hire

    const effective = plusDays(TODAY, -1);
    const asg = await openAssignment(hire.employmentId);
    await owner.db.update(schema.assignment).set({ costCenterId: null }).where(eq(schema.assignment.id, asg.id));
    await createMovementEvent(adminCtx(b), coherentMove(hire.employmentId, effective));

    const after = await employmentRow(hire.employmentId);
    expect(after.hiredOn).toBe('2018-03-15'); // the group anchor — untouched, and untouchable from here
    // The auto-sync the schema comment called a documented V1 follow-up. It is not a form field: the
    // effective date IS the new join date, so the two can never be keyed in disagreement.
    expect(after.joinDate).toBe(effective);
  });
});

describe('leave entitlement still counts from GROUP service after an Entity Transfer', () => {
  /** The 89ea527b worked example: under-2 = 14 days, 2-to-under-5 = 16, 5-and-above = 18. */
  const BANDS: ServiceBand[] = [
    { fromYears: 0, toYears: 2, days: 14 },
    { fromYears: 2, toYears: 5, days: 16 },
    { fromYears: 5, toYears: null, days: 18 },
  ];

  it('an employee with 8 years in the group who transfers today still has 8 years tomorrow', async () => {
    await seedEntitlement(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      serviceBands: BANDS,
      validFrom: '2010-01-01',
    });
    const hire = await hireEmployee(adminCtx(b), {
      person: { fullName: 'Long Server', primaryEmail: email() },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2018-01-01',
      grantLeaveTypes: [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }],
    });
    expect(await ledgerBalance(hire.employmentId, b.annualLeaveTypeId)).toBe(14); // 0 years at hire

    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'entityTransfer',
      effectiveDate: '2026-08-01',
      companyId: coB,
      departmentId: deptB2,
    });
    const d = await employeeDetail(adminCtx(b), hire.employmentId);
    expect(d!.joinDate).toBe('2026-08-01');
    expect(d!.hiredOn).toBe('2018-01-01');

    // At 2027-01-01 GROUP service is 9 years ⇒ the top band. Were entitlement ever to read join_date, this
    // employee would show ~0 years and drop to 14 days the moment they moved between group companies —
    // which is precisely the loss the reporter's data model exists to prevent.
    await openLeaveYear(adminCtx(b), { year: 2027 });
    expect(await ledgerBalance(hire.employmentId, b.annualLeaveTypeId)).toBe(18);
    expect(serviceYearsAt(d!.hiredOn, '2027-01-01')).toBe(9);
    expect(serviceYearsAt(d!.joinDate!, '2027-01-01')).toBe(0); // what the WRONG mapping would have used
  });
});

// ─────────────────────────────── the history it leaves ───────────────────────────────

describe('Employment History — the row names BOTH companies', () => {
  it('records ONE row whose Before column is the old company and After the new', async () => {
    const hire = await hireOne();
    const asg = await openAssignment(hire.employmentId);
    await owner.db.update(schema.assignment).set({ costCenterId: null }).where(eq(schema.assignment.id, asg.id));
    await createMovementEvent(adminCtx(b), coherentMove(hire.employmentId));

    const rows = await movementHistory(adminCtx(b), hire.employmentId);
    const transfers = rows.filter((r) => r.kind === 'entityTransfer');
    expect(transfers).toHaveLength(1); // one movement, one line — every other leg is `secondary`
    expect(transfers[0].effectiveDate).toBe(TODAY);
    expect(transfers[0].remarks).toBe('Group restructure');

    const detail = await movementDetail(adminCtx(b), hire.employmentId, transfers[0].id);
    expect(detail!.before!.company).toBe('Acme Sdn Bhd');
    expect(detail!.after.company).toBe('Beta Sdn Bhd');
    expect(detail!.before!.department).toBe('Finance');
    expect(detail!.after.department).toBe('Beta Operations');
  });

  it('rows recorded BEFORE the transfer still name the company the employee was in then', async () => {
    // The regression this replaces: placementColumnsTx read the company LIVE, which was fine while nothing
    // could change it. A live read now would stamp the destination onto a promotion recorded years earlier.
    const hire = await hireOne();
    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'promotion',
      effectiveDate: '2024-06-01',
      departmentId: b.deptB,
    });
    const asg = await openAssignment(hire.employmentId);
    await owner.db.update(schema.assignment).set({ costCenterId: null }).where(eq(schema.assignment.id, asg.id));
    await createMovementEvent(adminCtx(b), coherentMove(hire.employmentId));

    const rows = await movementHistory(adminCtx(b), hire.employmentId);
    expect(rows.find((r) => r.kind === 'promotion')!.company).toBe('Acme Sdn Bhd');
    expect(rows.find((r) => r.kind === 'entityTransfer')!.company).toBe('Beta Sdn Bhd');
    expect(rows.find((r) => r.kind === 'hired')!.company).toBe('Acme Sdn Bhd');
  });

  it('the company leg is its OWN event type — the pre-transaction correction is not dragged onto the history', async () => {
    const hire = await hireOne();
    const asg = await openAssignment(hire.employmentId);
    await owner.db.update(schema.assignment).set({ costCenterId: null }).where(eq(schema.assignment.id, asg.id));
    await createMovementEvent(adminCtx(b), coherentMove(hire.employmentId));
    const types = await eventTypesFor(b.tenantId, hire.employmentId);
    expect(types).toContain('employment.company.transferred');
    // `employment.company.changed` (9464bd56, the hire-time correction) stays OFF the movement projection.
    // Reusing it here would have been the cheap move and would have retroactively turned every past
    // correction into a career movement.
    expect(types).not.toContain('employment.company.changed');
  });
});

// ─────────────────────────────── rollback ───────────────────────────────

describe('rollback — the company AND the join date go back', () => {
  it('restores both, and the as-of replay stops reporting the destination', async () => {
    const hire = await hireOne({ hiredOn: '2018-03-15' });
    const asg = await openAssignment(hire.employmentId);
    await owner.db.update(schema.assignment).set({ costCenterId: null }).where(eq(schema.assignment.id, asg.id));
    await createMovementEvent(adminCtx(b), coherentMove(hire.employmentId));
    expect((await employmentRow(hire.employmentId)).companyId).toBe(coB);

    const row = (await movementHistory(adminCtx(b), hire.employmentId)).find((r) => r.kind === 'entityTransfer')!;
    expect(row.canReverse).toBe(true);
    await reverseMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      movementId: row.id,
      reason: 'Transferred the wrong person',
    });

    const emp = await employmentRow(hire.employmentId);
    expect(emp.companyId).toBe(b.companyId);
    // Without the join-date restore the employee would be back in the company they started in, dated from
    // a transfer that no longer exists.
    expect(emp.joinDate).toBe('2018-03-15');
    expect(emp.hiredOn).toBe('2018-03-15');

    // The row STAYS, marked reversed — and the replay must follow the rollback, or every row after it
    // would keep naming the destination company.
    const after = await movementHistory(adminCtx(b), hire.employmentId);
    const reversed = after.find((r) => r.id === row.id)!;
    expect(reversed.reversed).not.toBeNull();
    expect(after.find((r) => r.kind === 'hired')!.company).toBe('Acme Sdn Bhd');
  });
});

// ─────────────────────────────── payroll ───────────────────────────────

describe('a backdated transfer does not rewrite a closed payroll run', () => {
  it('the run is untouched and the movement is locked against correction', async () => {
    const hire = await hireOne();
    const period = '2026-01';
    const [pp] = await owner.db
      .insert(schema.payPeriod)
      .values({ tenantId: b.tenantId, companyId: b.companyId, period, status: 'closed' })
      .returning({ id: schema.payPeriod.id });
    const [batch] = await owner.db
      .insert(schema.payrollBatch)
      .values({
        tenantId: b.tenantId,
        companyId: b.companyId,
        payPeriodId: pp.id,
        payPeriod: period,
        batchDate: `${period}-25`,
        status: 'closed',
      })
      .returning({ id: schema.payrollBatch.id });
    await owner.db.insert(schema.payslip).values({
      tenantId: b.tenantId,
      batchId: batch.id,
      employmentId: hire.employmentId,
      basicSalary: '4000.00',
      grossPay: '4000.00',
      statutory: {},
      totalDeductions: '0.00',
      netPay: '4000.00',
      employerCost: '4000.00',
    });

    const asg = await openAssignment(hire.employmentId);
    await owner.db.update(schema.assignment).set({ costCenterId: null }).where(eq(schema.assignment.id, asg.id));
    // Dated INSIDE the closed period.
    await createMovementEvent(adminCtx(b), coherentMove(hire.employmentId, '2026-01-10'));

    // The transfer itself saved — a closed run does not veto recording history.
    expect((await employmentRow(hire.employmentId)).companyId).toBe(coB);
    // …and the run is exactly as it was. Nothing reprocesses, nothing re-companies a paid payslip.
    const [slip] = await owner.db
      .select({ netPay: schema.payslip.netPay, batchId: schema.payslip.batchId })
      .from(schema.payslip)
      .where(eq(schema.payslip.employmentId, hire.employmentId));
    expect(slip.netPay).toBe('4000.00');
    expect(slip.batchId).toBe(batch.id);
    const [runRow] = await owner.db
      .select({ companyId: schema.payrollBatch.companyId, status: schema.payrollBatch.status })
      .from(schema.payrollBatch)
      .where(eq(schema.payrollBatch.id, batch.id));
    expect(runRow.companyId).toBe(b.companyId); // the run stays with the company that paid it
    expect(runRow.status).toBe('closed');

    // And correcting it is REFUSED while the run is closed — the affordance and the rule agree.
    const row = (await movementHistory(adminCtx(b), hire.employmentId)).find((r) => r.kind === 'entityTransfer')!;
    expect(row.payrollLocked).toBe(true);
    expect(row.canReverse).toBe(false);
    expect(row.canEdit).toBe(false);
  });
});

// ─────────────────────────────── scheduling ───────────────────────────────

describe('a FUTURE-dated Entity Transfer is held as an intent and applied on its date', () => {
  it('writes nothing today, and the sweep applies it with the destination intact', async () => {
    const hire = await hireOne();
    const asg = await openAssignment(hire.employmentId);
    await owner.db.update(schema.assignment).set({ costCenterId: null }).where(eq(schema.assignment.id, asg.id));
    const future = plusDays(TODAY, 30);
    await createMovementEvent(adminCtx(b), coherentMove(hire.employmentId, future));

    // Nothing moved: a pending movement writes no dated row and no flat column.
    expect((await employmentRow(hire.employmentId)).companyId).toBe(b.companyId);
    const pending = (await movementHistory(adminCtx(b), hire.employmentId)).find(
      (r) => r.kind === 'entityTransfer',
    )!;
    expect(pending.status).toBe('pending');

    // The sweep, run on the morning the movement is due. The destination company must have been FROZEN onto
    // the scheduled event — without it the replay arrives months later with nothing to transfer to.
    await sweepDueMovements(adminCtx(b), { today: future });
    const emp = await employmentRow(hire.employmentId);
    expect(emp.companyId).toBe(coB);
    expect(emp.joinDate).toBe(future);
    const rows = await movementHistory(adminCtx(b), hire.employmentId);
    const applied = rows.filter((r) => r.kind === 'entityTransfer');
    expect(applied).toHaveLength(1); // still ONE row — its status moved Pending → Applied
    expect(applied[0].status).toBe('applied');
  });
});

// ─────────────────────────── the boundaries that are NOT crossed ───────────────────────────

describe('no tenant can mint a type that moves a legal entity', () => {
  it('entityTransfer is a built-in comparison kind but is NOT configurable or interchangeable', () => {
    expect(MOVEMENT_KINDS).toContain('entityTransfer');
    expect(COMPARISON_KINDS).toContain('entityTransfer'); // same grid, same fields, same writer
    // The two exclusions are the whole point. A catalogue row maps onto a BUILT-IN behaviour; letting one
    // map onto this would hand tenants the power to invent a company move under any name they liked.
    expect(INTERCHANGEABLE_COMPARISON_KINDS).not.toContain('entityTransfer');
    expect(CONFIGURABLE_BEHAVIOUR_KINDS).not.toContain('entityTransfer');
  });

  it('Movement Settings REFUSES a custom type mapped onto entityTransfer', async () => {
    await expect(
      saveMovementEventType(adminCtx(b), {
        label: 'Redeployment Abroad',
        behaviourKind: 'entityTransfer',
      }),
    ).rejects.toThrow();
  });
});

describe('a correction cannot re-classify across the Entity Transfer line', () => {
  it('refuses turning an Entity Transfer into a plain Transfer', async () => {
    const hire = await hireOne();
    const asg = await openAssignment(hire.employmentId);
    await owner.db.update(schema.assignment).set({ costCenterId: null }).where(eq(schema.assignment.id, asg.id));
    await createMovementEvent(adminCtx(b), coherentMove(hire.employmentId));
    const row = (await movementHistory(adminCtx(b), hire.employmentId)).find((r) => r.kind === 'entityTransfer')!;
    await expect(
      editMovementEvent(adminCtx(b), {
        employmentId: hire.employmentId,
        movementId: row.id,
        kind: 'transfer',
        effectiveDate: TODAY,
        reason: 'Should have been a plain transfer',
      }),
    ).rejects.toThrow(MovementNotCorrectableError);
  });

  it('refuses turning a plain Transfer into an Entity Transfer', async () => {
    const hire = await hireOne();
    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'transfer',
      effectiveDate: TODAY,
      departmentId: b.deptB,
    });
    const row = (await movementHistory(adminCtx(b), hire.employmentId)).find((r) => r.kind === 'transfer')!;
    await expect(
      editMovementEvent(adminCtx(b), {
        employmentId: hire.employmentId,
        movementId: row.id,
        kind: 'entityTransfer',
        effectiveDate: TODAY,
        companyId: coB,
        departmentId: deptB2,
        reason: 'Should have been an entity transfer',
      }),
    ).rejects.toThrow(MovementNotCorrectableError);
  });
});

// ─────────────────────────────── the screen ───────────────────────────────

describe('SOURCE GUARDS — the New Event form', () => {
  const NEW_EVENT = fs.readFileSync(
    path.resolve(__dirname, '../app/admin/personnel/[employmentId]/movement-new-event.tsx'),
    'utf8',
  );

  it('carries entityTransfer in its OWN mirrored comparison list, or the grid never renders', () => {
    // The island must not import a server module, so it keeps a copy of COMPARISON_KINDS. If the two drift,
    // Entity Transfer renders the LIFECYCLE form — no Company row, no grid — and the whole item reverts.
    const mirrored = NEW_EVENT.slice(
      NEW_EVENT.indexOf('const COMPARISON_KINDS'),
      NEW_EVENT.indexOf('/** 66a63bd6'),
    );
    expect(mirrored.includes("'entityTransfer'")).toBe(true);
  });

  it('makes Company editable ONLY for entityTransfer, and keeps the read-only note otherwise', () => {
    expect(NEW_EVENT.includes("const isEntityTransfer = behaviour === 'entityTransfer';")).toBe(true);
    expect(NEW_EVENT.includes('name="companyId"')).toBe(true);
    // The read-only branch must survive: every other kind still shows the note it always did.
    expect(NEW_EVENT.includes("t('form.companyReadOnly')")).toBe(true);
  });

  it('re-scopes the org pickers to the destination company', () => {
    // A form that lets HR keep a Johor department while moving to a KL company is a form that manufactures
    // the exact incoherence the service then has to refuse.
    expect(NEW_EVENT.includes('scoped.departments')).toBe(true);
    expect(NEW_EVENT.includes('scoped.positions')).toBe(true);
    expect(NEW_EVENT.includes('scoped.businessUnits')).toBe(true);
    expect(NEW_EVENT.includes('scoped.locations')).toBe(true);
    expect(NEW_EVENT.includes('scopedManagers')).toBe(true);
  });

  it('every new user-visible string has a key in ALL SIX locale catalogs', () => {
    for (const loc of ['en', 'ms', 'ta', 'th', 'vi', 'zh']) {
      const msg = JSON.parse(fs.readFileSync(path.resolve(__dirname, `../messages/${loc}.json`), 'utf8'));
      const mv = msg?.people?.detail?.movement;
      expect(typeof mv?.eventType?.entityTransfer, `${loc}: movement.eventType.entityTransfer`).toBe('string');
      expect(typeof mv?.form?.entityTransferHint, `${loc}: movement.form.entityTransferHint`).toBe('string');
      expect(typeof mv?.form?.entityTransferDateHint, `${loc}: movement.form.entityTransferDateHint`).toBe(
        'string',
      );
      expect(typeof mv?.form?.selectPlaceholder, `${loc}: movement.form.selectPlaceholder`).toBe('string');
    }
  });
});
