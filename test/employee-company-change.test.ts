/**
 * Personnel — Company change before any transaction (feedback 9464bd56).
 *
 * A mis-picked Company on a BRAND-NEW employee can be corrected inline while the employee has NO operational
 * activity; once ANY transaction exists the field locks and HR is steered to Movement / Transfer. This suite
 * proves: the pre-transaction gate (one representative head per operational module, with the hire-time leave
 * grant excluded), the audited writer (company flip + dependent-default refresh + assignment re-home into the
 * destination company, delegating to setEmploymentAssignment's guards), the destination-admin authz, location
 * handling, the race re-check, and i18n parity.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
import type { SessionContext } from '../db/client';
import {
  changeEmploymentCompany,
  CompanyLockedError,
  DestinationCompanyNotAdministered,
  hireEmployee,
} from '../core/org';
import { employmentCompanyEditable, listDepartments } from '../core/read';
import { movementHistory } from '../core/movement';
import * as schema from '../db/schema';

let b: Base;
// Move target: a second company + its own department, in the same tenant.
let newCompanyId: string;
let newDeptId: string;

beforeAll(async () => {
  await migrateTestDb();
  await resetDb();
  b = await seedBase();
  const [co] = await owner.db
    .insert(schema.company)
    .values({ tenantId: b.tenantId, legalName: 'Beta Sdn Bhd' })
    .returning({ id: schema.company.id });
  newCompanyId = co.id;
  const [dep] = await owner.db
    .insert(schema.department)
    .values({ tenantId: b.tenantId, companyId: newCompanyId, name: 'Beta Ops' })
    .returning({ id: schema.department.id });
  newDeptId = dep.id;
});
afterAll(async () => {
  await closeAll();
});

const email = () => `cc_${randomUUID().slice(0, 8)}@t.local`;

/** Hire a fresh employee in the ORIGINAL company (b.companyId), optionally under a manager. */
async function hireFresh(p?: { managerEmploymentId?: string }) {
  return hireEmployee(adminCtx(b), {
    person: { fullName: 'Company Change Test', primaryEmail: email() },
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

async function companyIdOf(employmentId: string): Promise<string> {
  const [row] = await owner.db
    .select({ companyId: schema.employment.companyId })
    .from(schema.employment)
    .where(eq(schema.employment.id, employmentId))
    .limit(1);
  return row.companyId;
}

describe('employmentCompanyEditable + changeEmploymentCompany — happy path', () => {
  it('(a) flips company, re-homes the assignment, clears reportingLine/costAllocation/payrollPolicyId, audits once, stays out of movement history', async () => {
    const mgr = await hireFresh();
    const hire = await hireFresh({ managerEmploymentId: mgr.employmentId });

    // Give the fresh hire the dependent defaults the move must clear: a company-scoped payroll policy, a
    // cost-allocation JSON pointing at the old company, and a hire-time leave accrual (which must NOT lock).
    const [pol] = await owner.db
      .insert(schema.payrollPolicy)
      .values({ tenantId: b.tenantId, companyId: b.companyId, name: 'Monthly', policyType: 'monthly' })
      .returning({ id: schema.payrollPolicy.id });
    await owner.db
      .update(schema.employment)
      .set({ payrollPolicyId: pol.id, costAllocation: [{ companyId: b.companyId, percent: 100 }] })
      .where(eq(schema.employment.id, hire.employmentId));
    await owner.db.insert(schema.leaveLedger).values({
      tenantId: b.tenantId,
      employmentId: hire.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      entryType: 'accrual',
      days: '8.00',
      effectiveOn: '2026-01-01', // == hiredOn → the excluded hire-time grant.
    });

    // A hire-time accrual alone leaves it editable.
    expect(await employmentCompanyEditable(adminCtx(b), hire.employmentId)).toBe(true);

    const res = await changeEmploymentCompany(adminCtx(b), {
      employmentId: hire.employmentId,
      newCompanyId,
      departmentId: newDeptId,
    });
    expect(res).toMatchObject({ from: b.companyId, to: newCompanyId });

    // Company flipped; company-scoped defaults cleared.
    const [emp] = await owner.db
      .select({
        companyId: schema.employment.companyId,
        payrollPolicyId: schema.employment.payrollPolicyId,
        costAllocation: schema.employment.costAllocation,
      })
      .from(schema.employment)
      .where(eq(schema.employment.id, hire.employmentId))
      .limit(1);
    expect(emp.companyId).toBe(newCompanyId);
    expect(emp.payrollPolicyId).toBeNull();
    expect(emp.costAllocation).toBeNull();

    // Assignment re-homed onto the destination company's department.
    const assign = await openAssignment(hire.employmentId);
    expect(assign.departmentId).toBe(newDeptId);

    // The open reporting line to the old-company manager is gone.
    const openLines = await owner.db
      .select({ id: schema.reportingLine.id })
      .from(schema.reportingLine)
      .where(
        and(
          eq(schema.reportingLine.subordinateEmploymentId, hire.employmentId),
          isNull(schema.reportingLine.validTo),
          isNull(schema.reportingLine.supersededAt),
        ),
      );
    expect(openLines).toHaveLength(0);

    // Exactly one audit event, with before/after.
    const types = await eventTypesFor(b.tenantId, hire.employmentId);
    expect(types.filter((t) => t === 'employment.company.changed')).toHaveLength(1);
    const payload = await latestEventPayload(b.tenantId, hire.employmentId, 'employment.company.changed');
    expect(payload).toEqual({ before: { companyId: b.companyId }, after: { companyId: newCompanyId } });

    // The correction stays OUT of the Movement / Transfer history projection.
    const [changeEvent] = await owner.db
      .select({ id: schema.domainEvent.id })
      .from(schema.domainEvent)
      .where(
        and(
          eq(schema.domainEvent.tenantId, b.tenantId),
          eq(schema.domainEvent.aggregateId, hire.employmentId),
          eq(schema.domainEvent.eventType, 'employment.company.changed'),
        ),
      )
      .limit(1);
    const movements = await movementHistory(adminCtx(b), hire.employmentId);
    expect(movements.some((m) => m.id === changeEvent.id)).toBe(false);
  });

  it('(d) the plain hire-time accrual row alone keeps the field editable', async () => {
    const hire = await hireFresh();
    await owner.db.insert(schema.leaveLedger).values({
      tenantId: b.tenantId,
      employmentId: hire.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      entryType: 'accrual',
      days: '8.00',
      effectiveOn: '2026-01-01',
    });
    expect(await employmentCompanyEditable(adminCtx(b), hire.employmentId)).toBe(true);
  });
});

describe('gate blocks — one insert per operational module head', () => {
  // Shared FK parents for the heads that need them.
  let batchId: string;
  let componentId: string;
  let claimTypeId: string;
  let cycleId: string;
  let throwawayLeaveReqId: string;

  beforeAll(async () => {
    const one = async (text: ReturnType<typeof sql>) =>
      (await owner.db.execute(text)) as unknown as { id: string }[];
    const [pp] = await one(
      sql`INSERT INTO pay_period (tenant_id, company_id, period) VALUES (${b.tenantId}, ${b.companyId}, '2026-02') RETURNING id`,
    );
    const [batch] = await one(
      sql`INSERT INTO payroll_batch (tenant_id, company_id, pay_period, batch_date, pay_period_id) VALUES (${b.tenantId}, ${b.companyId}, '2026-02', '2026-02-28', ${pp.id}) RETURNING id`,
    );
    batchId = batch.id;
    const [comp] = await one(
      sql`INSERT INTO pay_component (tenant_id, code, name, kind) VALUES (${b.tenantId}, ${'ALLOW_' + randomUUID().slice(0, 4)}, 'Allowance', 'allowance') RETURNING id`,
    );
    componentId = comp.id;
    const [ct] = await one(
      sql`INSERT INTO claim_type (tenant_id, code, name) VALUES (${b.tenantId}, ${'CT_' + randomUUID().slice(0, 4)}, 'Travel') RETURNING id`,
    );
    claimTypeId = ct.id;
    const [rc] = await one(
      sql`INSERT INTO review_cycle (tenant_id, name, period_start, period_end, rating_scale) VALUES (${b.tenantId}, 'FY26', '2026-01-01', '2026-12-31', '[]'::jsonb) RETURNING id`,
    );
    cycleId = rc.id;
    // A leave_request owned by a throwaway employee — so a leave_cancellation_request can reference a real
    // parent without the SUBJECT itself having a leave_request (keeps that head isolated).
    const throwaway = await hireFresh();
    const [lr] = await one(
      sql`INSERT INTO leave_request (tenant_id, employment_id, leave_type_id, start_date, end_date, days) VALUES (${b.tenantId}, ${throwaway.employmentId}, ${b.annualLeaveTypeId}, '2026-02-01', '2026-02-01', 1) RETURNING id`,
    );
    throwawayLeaveReqId = lr.id;
  });

  // Each head inserts exactly ONE row for the subject employment and must flip editable→false + make the
  // writer throw CompanyLockedError with the company unchanged.
  const heads: { name: string; insert: (empId: string, personId: string) => Promise<void> }[] = [
    {
      name: 'payslip',
      insert: async (empId) => {
        await owner.db.execute(
          sql`INSERT INTO payslip (tenant_id, batch_id, employment_id, basic_salary, gross_pay, statutory, total_deductions, net_pay, employer_cost) VALUES (${b.tenantId}, ${batchId}, ${empId}, 0, 0, '{}'::jsonb, 0, 0, 0)`,
        );
      },
    },
    {
      name: 'payroll_input',
      insert: async (empId) => {
        await owner.db.execute(
          sql`INSERT INTO payroll_input (tenant_id, batch_id, employment_id) VALUES (${b.tenantId}, ${batchId}, ${empId})`,
        );
      },
    },
    {
      name: 'employee_cp38',
      insert: async (empId) => {
        await owner.db.execute(
          sql`INSERT INTO employee_cp38 (tenant_id, employment_id, cp38_ref, amount, valid_from) VALUES (${b.tenantId}, ${empId}, 'CP38-1', 100, '2026-02-01')`,
        );
      },
    },
    {
      name: 'employment_pay_component',
      insert: async (empId) => {
        await owner.db.execute(
          sql`INSERT INTO employment_pay_component (tenant_id, employment_id, component_id, valid_from) VALUES (${b.tenantId}, ${empId}, ${componentId}, '2026-02-01')`,
        );
      },
    },
    {
      name: 'ea_override',
      insert: async (empId) => {
        await owner.db.execute(
          sql`INSERT INTO ea_override (tenant_id, employment_id, year, field, amount, reason) VALUES (${b.tenantId}, ${empId}, '2026', 'grossPay', 100, 'test')`,
        );
      },
    },
    {
      name: 'attendance',
      insert: async (empId) => {
        await owner.db.execute(
          sql`INSERT INTO attendance (tenant_id, employment_id, attendance_date) VALUES (${b.tenantId}, ${empId}, '2026-02-01')`,
        );
      },
    },
    {
      name: 'leave_request',
      insert: async (empId) => {
        await owner.db.execute(
          sql`INSERT INTO leave_request (tenant_id, employment_id, leave_type_id, start_date, end_date, days) VALUES (${b.tenantId}, ${empId}, ${b.annualLeaveTypeId}, '2026-02-01', '2026-02-01', 1)`,
        );
      },
    },
    {
      name: 'leave_cancellation_request',
      insert: async (empId) => {
        await owner.db.execute(
          sql`INSERT INTO leave_cancellation_request (tenant_id, leave_request_id, employment_id, cancel_dates, requested_days) VALUES (${b.tenantId}, ${throwawayLeaveReqId}, ${empId}, '["2026-02-01"]'::jsonb, 1)`,
        );
      },
    },
    {
      name: 'leave_ledger (post-hire accrual)',
      insert: async (empId) => {
        await owner.db.execute(
          sql`INSERT INTO leave_ledger (tenant_id, employment_id, leave_type_id, entry_type, days, effective_on) VALUES (${b.tenantId}, ${empId}, ${b.annualLeaveTypeId}, 'accrual', 1, '2026-06-01')`,
        );
      },
    },
    {
      name: 'leave_ledger (non-accrual adjustment)',
      insert: async (empId) => {
        await owner.db.execute(
          sql`INSERT INTO leave_ledger (tenant_id, employment_id, leave_type_id, entry_type, days, effective_on) VALUES (${b.tenantId}, ${empId}, ${b.annualLeaveTypeId}, 'adjustment', 2, '2026-01-01')`,
        );
      },
    },
    {
      name: 'claim_request',
      insert: async (empId) => {
        await owner.db.execute(
          sql`INSERT INTO claim_request (tenant_id, employment_id, claim_type_id, amount, incurred_on) VALUES (${b.tenantId}, ${empId}, ${claimTypeId}, 50, '2026-02-01')`,
        );
      },
    },
    {
      name: 'toil_accrual',
      insert: async (empId) => {
        await owner.db.execute(
          sql`INSERT INTO toil_accrual (tenant_id, employment_id, worked_date, day_type, ot_minutes, days_credited, accrual_basis, expires_on) VALUES (${b.tenantId}, ${empId}, '2026-02-01', 'workday', 60, 1, 'hours_worked', '2026-12-31')`,
        );
      },
    },
    {
      name: 'employee_loan',
      insert: async (empId) => {
        await owner.db.execute(
          sql`INSERT INTO employee_loan (tenant_id, employment_id, loan_type, principal, duration_months, start_date, monthly_instalment, total_repayable, outstanding_balance) VALUES (${b.tenantId}, ${empId}, 'personal', 1200, 12, '2026-02-01', 100, 1200, 1200)`,
        );
      },
    },
    {
      name: 'travel_request',
      insert: async (empId) => {
        await owner.db.execute(
          sql`INSERT INTO travel_request (tenant_id, employment_id, travel_from, travel_to, remarks) VALUES (${b.tenantId}, ${empId}, '2026-02-01', '2026-02-02', 'trip')`,
        );
      },
    },
    {
      name: 'roster_assignment',
      insert: async (empId) => {
        // shift_xor_rest CHECK: a row is either a shift or a rest day — mark it a rest day (no shift needed).
        await owner.db.execute(
          sql`INSERT INTO roster_assignment (tenant_id, employment_id, shift_date, is_rest_day) VALUES (${b.tenantId}, ${empId}, '2026-02-01', true)`,
        );
      },
    },
    {
      name: 'performance_review',
      insert: async (empId) => {
        await owner.db.execute(
          sql`INSERT INTO performance_review (tenant_id, cycle_id, employment_id) VALUES (${b.tenantId}, ${cycleId}, ${empId})`,
        );
      },
    },
    {
      name: 'resignation_request',
      insert: async (empId, personId) => {
        await owner.db.execute(
          sql`INSERT INTO resignation_request (tenant_id, employment_id, person_id, last_working_day) VALUES (${b.tenantId}, ${empId}, ${personId}, '2026-03-01')`,
        );
      },
    },
    {
      name: 'employment_review',
      insert: async (empId, personId) => {
        await owner.db.execute(
          sql`INSERT INTO employment_review (tenant_id, employment_id, person_id, review_type, end_date, due_date) VALUES (${b.tenantId}, ${empId}, ${personId}, 'probation', '2026-04-01', '2026-04-01')`,
        );
      },
    },
  ];

  for (const head of heads) {
    it(`(b) ${head.name} locks the field and rejects the change`, async () => {
      const hire = await hireFresh();
      expect(await employmentCompanyEditable(adminCtx(b), hire.employmentId)).toBe(true);
      await head.insert(hire.employmentId, hire.personId);
      expect(await employmentCompanyEditable(adminCtx(b), hire.employmentId)).toBe(false);
      await expect(
        changeEmploymentCompany(adminCtx(b), {
          employmentId: hire.employmentId,
          newCompanyId,
          departmentId: newDeptId,
        }),
      ).rejects.toBeInstanceOf(CompanyLockedError);
      expect(await companyIdOf(hire.employmentId)).toBe(b.companyId);
    });
  }

  it('(c) a saved salary (compensation) alone locks the field', async () => {
    const hire = await hireFresh();
    await owner.db.execute(
      sql`INSERT INTO compensation (tenant_id, employment_id, basic_salary, valid_from) VALUES (${b.tenantId}, ${hire.employmentId}, 3000, '2026-01-01')`,
    );
    expect(await employmentCompanyEditable(adminCtx(b), hire.employmentId)).toBe(false);
    await expect(
      changeEmploymentCompany(adminCtx(b), {
        employmentId: hire.employmentId,
        newCompanyId,
        departmentId: newDeptId,
      }),
    ).rejects.toBeInstanceOf(CompanyLockedError);
  });
});

describe('authz — destination company must be administered', () => {
  const oldOnlyCtx = (): SessionContext => ({
    tenantId: b.tenantId,
    userId: b.adminUserId,
    grants: [{ role: 'hr_admin', companyId: b.companyId }],
  });
  const bothCtx = (): SessionContext => ({
    tenantId: b.tenantId,
    userId: b.adminUserId,
    grants: [
      { role: 'hr_admin', companyId: b.companyId },
      { role: 'hr_admin', companyId: newCompanyId },
    ],
  });

  it('(e) admin of only the current company is rejected; admin-of-both and group admin succeed', async () => {
    const rejected = await hireFresh();
    await expect(
      changeEmploymentCompany(oldOnlyCtx(), {
        employmentId: rejected.employmentId,
        newCompanyId,
        departmentId: newDeptId,
      }),
    ).rejects.toBeInstanceOf(DestinationCompanyNotAdministered);
    expect(await companyIdOf(rejected.employmentId)).toBe(b.companyId);

    const both = await hireFresh();
    await changeEmploymentCompany(bothCtx(), {
      employmentId: both.employmentId,
      newCompanyId,
      departmentId: newDeptId,
    });
    expect(await companyIdOf(both.employmentId)).toBe(newCompanyId);

    const group = await hireFresh();
    await changeEmploymentCompany(adminCtx(b), {
      employmentId: group.employmentId,
      newCompanyId,
      departmentId: newDeptId,
    });
    expect(await companyIdOf(group.employmentId)).toBe(newCompanyId);
  });
});

describe('destination validity — department scope + shared/global', () => {
  it('(f) a department not usable by the destination is rejected; a global department is accepted and listed', async () => {
    // A department that belongs to the ORIGINAL company is not usable by the destination → the delegated
    // setEmploymentAssignment guard rejects, and the whole transaction rolls back (company unchanged).
    const rej = await hireFresh();
    await expect(
      changeEmploymentCompany(adminCtx(b), {
        employmentId: rej.employmentId,
        newCompanyId,
        departmentId: b.deptA,
      }),
    ).rejects.toThrow();
    expect(await companyIdOf(rej.employmentId)).toBe(b.companyId);

    // A GLOBAL department is usable by any company whose shared-labels flag is on. Give a dedicated
    // destination that opts in, plus a global department, and confirm both the move and the list accept it.
    const [gco] = await owner.db
      .insert(schema.company)
      .values({ tenantId: b.tenantId, legalName: 'Gamma Sdn Bhd', sharedSystemLabels: true })
      .returning({ id: schema.company.id });
    // is_global is guarded by a BEFORE trigger (group-admin only). Set group-admin grants for this insert.
    const gdep = await owner.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${b.tenantId}, true)`);
      await tx.execute(
        sql`select set_config('app.grants', '[{"role":"super_admin","companyId":null}]', true)`,
      );
      const [row] = (await tx.execute(
        sql`INSERT INTO department (tenant_id, company_id, name, is_global) VALUES (${b.tenantId}, ${b.companyId}, 'Shared Services', true) RETURNING id`,
      )) as unknown as { id: string }[];
      return row;
    });

    const listed = await listDepartments(adminCtx(b), { companyIds: [gco.id] });
    expect(listed.some((d) => d.id === gdep.id)).toBe(true);

    const acc = await hireFresh();
    await changeEmploymentCompany(adminCtx(b), {
      employmentId: acc.employmentId,
      newCompanyId: gco.id,
      departmentId: gdep.id,
    });
    expect(await companyIdOf(acc.employmentId)).toBe(gco.id);
    const assign = await openAssignment(acc.employmentId);
    expect(assign.departmentId).toBe(gdep.id);
  });
});

describe('location — cross-company coherence', () => {
  it('(g) an old-company location is cleared; a destination location is carried', async () => {
    const [oldLoc] = await owner.db
      .insert(schema.location)
      .values({ tenantId: b.tenantId, companyId: b.companyId, code: `OL_${randomUUID().slice(0, 4)}`, name: 'Old HQ' })
      .returning({ id: schema.location.id });
    const [newLoc] = await owner.db
      .insert(schema.location)
      .values({ tenantId: b.tenantId, companyId: newCompanyId, code: `NL_${randomUUID().slice(0, 4)}`, name: 'New HQ' })
      .returning({ id: schema.location.id });

    // Cleared: the assignment holds an old-company location, HR supplies no new one → cleared on the move.
    const cleared = await hireFresh();
    const clearedAssign = await openAssignment(cleared.employmentId);
    await owner.db
      .update(schema.assignment)
      .set({ locationId: oldLoc.id })
      .where(eq(schema.assignment.id, clearedAssign.id));
    await changeEmploymentCompany(adminCtx(b), {
      employmentId: cleared.employmentId,
      newCompanyId,
      departmentId: newDeptId,
    });
    expect((await openAssignment(cleared.employmentId)).locationId).toBeNull();

    // Carried: HR supplies a destination-owned location → it lands on the new assignment.
    const carried = await hireFresh();
    await changeEmploymentCompany(adminCtx(b), {
      employmentId: carried.employmentId,
      newCompanyId,
      departmentId: newDeptId,
      locationId: newLoc.id,
    });
    expect((await openAssignment(carried.employmentId)).locationId).toBe(newLoc.id);

    // Rejected: HR explicitly supplies an old-company location → hard error, rolled back.
    const bad = await hireFresh();
    await expect(
      changeEmploymentCompany(adminCtx(b), {
        employmentId: bad.employmentId,
        newCompanyId,
        departmentId: newDeptId,
        locationId: oldLoc.id,
      }),
    ).rejects.toThrow();
    expect(await companyIdOf(bad.employmentId)).toBe(b.companyId);
  });
});

describe('race — the server-side gate is the source of truth', () => {
  it('(h) a transaction landing after the editable check still blocks the writer', async () => {
    const hire = await hireFresh();
    // Render-time: editable.
    expect(await employmentCompanyEditable(adminCtx(b), hire.employmentId)).toBe(true);
    // A transaction lands before submit.
    const [pp] = (await owner.db.execute(
      sql`INSERT INTO pay_period (tenant_id, company_id, period) VALUES (${b.tenantId}, ${b.companyId}, '2026-03') RETURNING id`,
    )) as unknown as { id: string }[];
    const [batch] = (await owner.db.execute(
      sql`INSERT INTO payroll_batch (tenant_id, company_id, pay_period, batch_date, pay_period_id) VALUES (${b.tenantId}, ${b.companyId}, '2026-03', '2026-03-28', ${pp.id}) RETURNING id`,
    )) as unknown as { id: string }[];
    await owner.db.execute(
      sql`INSERT INTO payslip (tenant_id, batch_id, employment_id, basic_salary, gross_pay, statutory, total_deductions, net_pay, employer_cost) VALUES (${b.tenantId}, ${batch.id}, ${hire.employmentId}, 0, 0, '{}'::jsonb, 0, 0, 0)`,
    );
    // Submit-time: the writer re-runs the gate and refuses.
    await expect(
      changeEmploymentCompany(adminCtx(b), {
        employmentId: hire.employmentId,
        newCompanyId,
        departmentId: newDeptId,
      }),
    ).rejects.toBeInstanceOf(CompanyLockedError);
    expect(await companyIdOf(hire.employmentId)).toBe(b.companyId);
  });
});

describe('i18n parity — new company-change keys present in all locales', () => {
  const KEYS = [
    'companyChangeableHint',
    'companyPendingBanner',
    'companyLockedNote',
    'companyLockedTooltip',
    'companyChangeSave',
    'destinationNotAdministered',
  ];
  const LOCALES = ['en', 'zh', 'ms', 'ta', 'th', 'vi'];
  for (const loc of LOCALES) {
    it(`(i) ${loc}.json carries every key under people.detail.employmentInfo`, () => {
      const data = JSON.parse(readFileSync(join(process.cwd(), 'messages', `${loc}.json`), 'utf8'));
      const ei = data.people.detail.employmentInfo;
      for (const k of KEYS) {
        expect(typeof ei[k]).toBe('string');
        expect(ei[k].length).toBeGreaterThan(0);
      }
    });
  }
});
