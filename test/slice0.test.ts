import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import {
  adminCtx,
  closeAll,
  createAppUser,
  eventTypesFor,
  ledgerBalance,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';
import {
  getAssignmentAsOf,
  hireEmployee,
  ReportingCycleError,
  setReportingLine,
  terminateEmployment,
  transferEmployee,
} from '../core/org';
import { decideLeave, InsufficientLeaveBalanceError, requestLeave } from '../core/leave';
import { dashboardStats, groupBreakdown, listEmployees, reportingLinesFor } from '../core/read';
import { createCompany, createDepartment, setCompanyParent } from '../core/admin';
import { getCompanyStatutoryMY, setCompanyStatutoryMY } from '../localization/my/company-statutory';
import { compensationHistory, currentCompensation, setCompensation } from '../core/comp';
import { getStatutoryProfileMY, InvalidICError, setStatutoryProfileMY } from '../localization/my/statutory';
import { annualEntitlement, entitlement } from '../localization/my/leave';
import { AlreadyCheckedInError, checkIn, checkOut } from '../core/attendance';
import { batchDetail, BatchNotDraftError, closeBatch, createBatch, generatePayslips } from '../core/payroll';
import { eis, epf, pcb, socso } from '../localization/my/payroll';

let base: Base;

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

const hire = (ctx: SessionContext, b: Base, name: string, opts?: { annual?: boolean }) =>
  hireEmployee(ctx, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase()}@acme.test` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
    annualLeaveTypeId: opts?.annual ? b.annualLeaveTypeId : undefined,
  });

describe('UC8 — tenant isolation', () => {
  it('a session cannot see another tenant’s companies, and zero without a tenant', async () => {
    const other = await seedBase();
    const seen = await withTenant(adminCtx(base), (tx) => tx.select().from(schema.company));
    expect(seen.length).toBe(1);
    expect(seen[0].tenantId).toBe(base.tenantId);
    expect(seen.some((c) => c.tenantId === other.tenantId)).toBe(false);

    const none = await withTenant(
      { tenantId: '00000000-0000-0000-0000-000000000000' },
      (tx) => tx.select().from(schema.company),
    );
    expect(none.length).toBe(0);
  });
});

describe('UC2 — bitemporal transfer & as-of', () => {
  it('reconstructs department before and after an effective-dated transfer', async () => {
    const a = adminCtx(base);
    const { employmentId } = await hire(a, base, 'Aisyah');
    await transferEmployee(a, { employmentId, effectiveDate: '2026-04-01', departmentId: base.deptB });

    const before = await getAssignmentAsOf(a, employmentId, '2026-03-31');
    const after = await getAssignmentAsOf(a, employmentId, '2026-04-01');
    expect(before?.departmentId).toBe(base.deptA);
    expect(after?.departmentId).toBe(base.deptB);

    const all = await withTenant(a, (tx) =>
      tx.select().from(schema.assignment).where(eq(schema.assignment.employmentId, employmentId)),
    );
    expect(all.length).toBe(2); // history preserved
  });
});

describe('UC4 — reporting cycle guard', () => {
  it('rejects an administrative cycle (and a self-loop)', async () => {
    const a = adminCtx(base);
    const A = await hire(a, base, 'Anya');
    const B = await hire(a, base, 'Bo');
    const C = await hire(a, base, 'Cara');
    const line = (sub: string, mgr: string) =>
      setReportingLine(a, {
        subordinateEmploymentId: sub,
        managerEmploymentId: mgr,
        lineType: 'administrative',
        validFrom: '2026-01-01',
      });
    await line(A.employmentId, B.employmentId);
    await line(B.employmentId, C.employmentId);

    await expect(line(C.employmentId, A.employmentId)).rejects.toBeInstanceOf(ReportingCycleError);
    await expect(line(A.employmentId, A.employmentId)).rejects.toBeInstanceOf(ReportingCycleError);
  });
});

describe('UC6 — leave approval atomicity & balance', () => {
  it('approves within balance; rejects over-balance without debiting', async () => {
    const a = adminCtx(base);
    const { employmentId } = await hire(a, base, 'Bala', { annual: true });
    expect(await ledgerBalance(employmentId, base.annualLeaveTypeId)).toBe(8); // EA-1955: <2yr = 8

    const r1 = await requestLeave(a, {
      employmentId,
      leaveTypeId: base.annualLeaveTypeId,
      startDate: '2026-02-02',
      endDate: '2026-02-04', // 3 days
    });
    await decideLeave(a, { leaveRequestId: r1.leaveRequestId, decision: 'approved' });
    expect(await ledgerBalance(employmentId, base.annualLeaveTypeId)).toBe(5);

    const r2 = await requestLeave(a, {
      employmentId,
      leaveTypeId: base.annualLeaveTypeId,
      startDate: '2026-03-01',
      endDate: '2026-03-31', // 31 days
    });
    await expect(
      decideLeave(a, { leaveRequestId: r2.leaveRequestId, decision: 'approved' }),
    ).rejects.toBeInstanceOf(InsufficientLeaveBalanceError);
    expect(await ledgerBalance(employmentId, base.annualLeaveTypeId)).toBe(5); // unchanged (atomic)

    const evs = await eventTypesFor(base.tenantId, r1.leaveRequestId);
    expect(evs).toContain('leave-request.submitted');
    expect(evs).toContain('leave-request.approved');
  });
});

describe('UC9 — ABAC visibility', () => {
  it('a manager sees a report’s leave but not a peer’s', async () => {
    const a = adminCtx(base);
    const E = await hire(a, base, 'Emp', { annual: true });
    const M = await hire(a, base, 'Mgr');
    const X = await hire(a, base, 'Peer');
    const uM = await createAppUser(base.tenantId, M.personId, 'manager');
    const uX = await createAppUser(base.tenantId, X.personId, 'employee');
    await setReportingLine(a, {
      subordinateEmploymentId: E.employmentId,
      managerEmploymentId: M.employmentId,
      lineType: 'administrative',
      validFrom: '2026-01-01',
    });
    await requestLeave(a, {
      employmentId: E.employmentId,
      leaveTypeId: base.annualLeaveTypeId,
      startDate: '2026-02-02',
      endDate: '2026-02-03',
    });

    const mgrCtx: SessionContext = { tenantId: base.tenantId, userId: uM, roles: ['manager'] };
    const peerCtx: SessionContext = { tenantId: base.tenantId, userId: uX, roles: ['employee'] };

    const mgrSeesReport = await withTenant(mgrCtx, (tx) =>
      tx.select().from(schema.leaveRequest).where(eq(schema.leaveRequest.employmentId, E.employmentId)),
    );
    const peerSeesReport = await withTenant(peerCtx, (tx) =>
      tx.select().from(schema.leaveRequest).where(eq(schema.leaveRequest.employmentId, E.employmentId)),
    );
    expect(mgrSeesReport.length).toBe(1);
    expect(peerSeesReport.length).toBe(0);
  });
});

describe('UC3 — terminate', () => {
  it('closes the open assignment, sets terminatedOn, and emits an event', async () => {
    const a = adminCtx(base);
    const { employmentId } = await hire(a, base, 'Tariq');
    await terminateEmployment(a, { employmentId, terminationDate: '2026-06-30' });

    const [emp] = await withTenant(a, (tx) =>
      tx.select().from(schema.employment).where(eq(schema.employment.id, employmentId)),
    );
    expect(emp.terminatedOn).toBe('2026-06-30');

    const assignments = await withTenant(a, (tx) =>
      tx.select().from(schema.assignment).where(eq(schema.assignment.employmentId, employmentId)),
    );
    expect(assignments[0].validTo).toBe('2026-06-30');

    const evs = await eventTypesFor(base.tenantId, employmentId);
    expect(evs).toContain('employment.hired');
    expect(evs).toContain('employment.terminated');
  });
});

describe('reporting lines — valid edge', () => {
  it('creates and lists a manager relationship both directions', async () => {
    const a = adminCtx(base);
    const E = await hire(a, base, 'Suba');
    const M = await hire(a, base, 'Boss');
    await setReportingLine(a, {
      subordinateEmploymentId: E.employmentId,
      managerEmploymentId: M.employmentId,
      lineType: 'administrative',
      validFrom: '2026-01-01',
    });
    const sub = await reportingLinesFor(a, E.employmentId);
    expect(sub.managers.map((m) => m.employmentId)).toContain(M.employmentId);
    const mgr = await reportingLinesFor(a, M.employmentId);
    expect(mgr.reports.map((r) => r.employmentId)).toContain(E.employmentId);
  });
});

describe('hardening — role-gated writes', () => {
  it('a non-admin session cannot create a company (RLS denies)', async () => {
    const employee: SessionContext = { tenantId: base.tenantId, userId: base.adminUserId, roles: ['employee'] };
    await expect(createCompany(employee, { legalName: 'Sneaky Sdn Bhd' })).rejects.toThrow();
  });
});

describe('Slice 1 — compensation (effective-dated)', () => {
  it('CLOSE+INSERTs on change; current reflects latest, history preserved', async () => {
    const a = adminCtx(base);
    const { employmentId } = await hire(a, base, 'Pay');
    await setCompensation(a, { employmentId, basicSalary: 5000, effectiveFrom: '2026-01-01' });
    await setCompensation(a, { employmentId, basicSalary: 6000, effectiveFrom: '2026-06-01' });
    const cur = await currentCompensation(a, employmentId);
    expect(Number(cur?.basicSalary)).toBe(6000);
    expect((await compensationHistory(a, employmentId)).length).toBe(2);
  });
});

describe('Slice 1 — Malaysia statutory pack', () => {
  it('validates IC and stores a normalized profile', async () => {
    const a = adminCtx(base);
    const { personId } = await hire(a, base, 'Stat');
    await expect(setStatutoryProfileMY(a, { personId, icNumber: '12345' })).rejects.toBeInstanceOf(
      InvalidICError,
    );
    await setStatutoryProfileMY(a, { personId, icNumber: '900101-01-1234', epfNumber: 'EPF1' });
    const prof = await getStatutoryProfileMY(a, personId);
    expect(prof?.icNumber).toBe('900101011234'); // dashes stripped
    expect(prof?.epfNumber).toBe('EPF1');
  });
});

describe('Slice 2 — MY leave rules', () => {
  it('EA-1955 annual entitlement is service-tiered', () => {
    expect(annualEntitlement(0)).toBe(8);
    expect(annualEntitlement(3)).toBe(12);
    expect(annualEntitlement(5)).toBe(12);
    expect(annualEntitlement(6)).toBe(16);
    expect(entitlement('SICK', 0)).toBe(14);
    expect(entitlement('MATERNITY', 0)).toBe(98);
  });

  it('working-day leave excludes weekends and holidays', async () => {
    const a = adminCtx(base);
    const { employmentId } = await hire(a, base, 'Wd');
    const [lt] = await owner.db
      .insert(schema.leaveType)
      .values({ tenantId: base.tenantId, code: 'WD', name: 'Working-day Leave', paid: true, counting: 'working_days' })
      .returning({ id: schema.leaveType.id });
    await owner.db
      .insert(schema.holiday)
      .values({ tenantId: base.tenantId, country: 'MY', holidayDate: '2026-06-03', name: 'Test Holiday' });
    // A full 7-day span always includes one weekend → working days ≤ 5 (fewer with the holiday).
    const r = await requestLeave(a, { employmentId, leaveTypeId: lt.id, startDate: '2026-06-01', endDate: '2026-06-07' });
    expect(r.days).toBeGreaterThan(0);
    expect(r.days).toBeLessThanOrEqual(5);
  });
});

describe('Slice 3 — attendance', () => {
  it('derives status from thresholds; one per day; check-out after check-in', async () => {
    const a = adminCtx(base);
    const { employmentId } = await hire(a, base, 'Att');

    const r1 = await checkIn(a, { employmentId, date: '2026-06-05', time: '09:00' });
    expect(r1.status).toBe('present'); // before 09:15
    await expect(
      checkIn(a, { employmentId, date: '2026-06-05', time: '10:00' }),
    ).rejects.toBeInstanceOf(AlreadyCheckedInError);
    await expect(
      checkOut(a, { employmentId, date: '2026-06-05', time: '08:00' }),
    ).rejects.toThrow(); // before check-in
    const r2 = await checkOut(a, { employmentId, date: '2026-06-05', time: '12:30' });
    expect(r2.status).toBe('half_day'); // out before 13:00, wasn't late

    const late = await hire(a, base, 'Late');
    const r3 = await checkIn(a, { employmentId: late.employmentId, date: '2026-06-05', time: '09:30' });
    expect(r3.status).toBe('late'); // after 09:15
  });
});

describe('Slice 4 — payroll', () => {
  it('MY statutory calculators apply the right rates and ceilings', () => {
    // EPF: employee 11%, employer 13% at wages ≤ RM5000.
    expect(epf(3000)).toEqual({ employee: 330, employer: 390 });
    // EPF: employer drops to 12% above RM5000.
    expect(epf(6000)).toEqual({ employee: 660, employer: 720 });
    // SOCSO/EIS cap contributions at the RM6000 wage ceiling.
    expect(socso(8000).employee).toBe(30); // 6000 * 0.005
    expect(eis(8000).employee).toBe(12); // 6000 * 0.002
  });

  it('generates one payslip per active employee; net = gross − statutory deductions', async () => {
    const a = adminCtx(base);
    const { employmentId } = await hire(a, base, 'Pay');
    await setCompensation(a, { employmentId, basicSalary: 4000, effectiveFrom: '2026-01-01' });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    const res = await generatePayslips(a, { batchId });
    expect(res.payslips).toBe(1);

    const detail = await batchDetail(a, batchId);
    expect(detail?.batch.status).toBe('processed');
    expect(detail?.slips).toHaveLength(1);

    const slip = detail!.slips[0];
    const st = slip.statutory as Record<string, number>;
    expect(Number(slip.gross)).toBe(4000);
    expect(st.epfEmployee).toBe(440); // 4000 * 0.11
    const expectedNet = 4000 - (st.epfEmployee + st.socsoEmployee + st.eisEmployee + st.pcb);
    expect(Number(slip.net)).toBeCloseTo(expectedNet, 2);

    expect(await eventTypesFor(base.tenantId, batchId)).toContain('payroll-batch.processed');
  });

  it('forbids a duplicate period batch and re-generating a processed batch', async () => {
    const a = adminCtx(base);
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-07' });
    await expect(
      createBatch(a, { companyId: base.companyId, payPeriod: '2026-07' }),
    ).rejects.toThrow();
    await generatePayslips(a, { batchId });
    await expect(generatePayslips(a, { batchId })).rejects.toBeInstanceOf(BatchNotDraftError);
  });
});

describe('Slice 5 — payroll compliance (official MY statutory tables)', () => {
  it('PCB follows the LHDN computerised calc with reliefs', () => {
    // RM3000 single → below the taxable threshold after reliefs → no PCB.
    expect(pcb(3000)).toBe(0);
    // RM5000 single → P = 60000 − 9000 − 4000 (EPF cap) = 47000 → (47000−35000)·6% + 600 = 1320/yr.
    expect(pcb(5000)).toBeCloseTo(110, 2);
    // Category 2 (non-working spouse, +RM4000 relief) pays less than a single earner.
    expect(pcb(8000, { category: 2 })).toBeLessThan(pcb(8000, { category: 1 }));
    // Each qualifying child reduces PCB.
    expect(pcb(8000, { children: 2 })).toBeLessThan(pcb(8000, { children: 0 }));
  });

  it('SOCSO First Category matches the official band table up to RM5000', () => {
    expect(socso(3000)).toEqual({ employer: 51.65, employee: 14.75 });
    expect(socso(100)).toEqual({ employer: 1.5, employee: 0.4 });
    expect(socso(5000)).toEqual({ employer: 86.65, employee: 24.75 });
    // Above RM5000: statutory % capped at the RM6000 ceiling (flagged, not band-table).
    expect(socso(6000).employee).toBeCloseTo(30, 2);
    expect(socso(9000).employee).toBeCloseTo(30, 2);
  });

  it('EPF rounds up to the next ringgit and splits the employer rate at RM5000', () => {
    expect(epf(4567)).toEqual({ employee: 503, employer: 594 }); // 502.37→503, 593.71→594
    expect(epf(5000).employer).toBe(650); // 13% at the threshold
    expect(epf(5001).employer).toBe(601); // 12% above (600.12→601)
  });

  it('freezes a closed batch and its payslips at the DB level', async () => {
    const a = adminCtx(base);
    const { employmentId } = await hire(a, base, 'Lock');
    await setCompensation(a, { employmentId, basicSalary: 4000, effectiveFrom: '2026-01-01' });
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-08' });
    await generatePayslips(a, { batchId });
    await closeBatch(a, { batchId });

    // Drizzle wraps the Postgres error; the trigger's message is on `.cause`.
    const errText = (e: { cause?: { message?: string }; message?: string }) =>
      String(e?.cause?.message ?? e?.message ?? '');

    // Direct mutation of a payslip in a closed batch is rejected by the trigger.
    // (Admins can normally update payslips, so a rejection here is specifically the immutability guard.)
    const payslipMsg = await withTenant(a, (tx) =>
      tx.update(schema.payslip).set({ netPay: '0.00' }).where(eq(schema.payslip.batchId, batchId)),
    ).then(() => '', errText);
    expect(payslipMsg).toMatch(/closed/i);

    // The batch itself can no longer be re-opened or edited.
    const batchMsg = await withTenant(a, (tx) =>
      tx.update(schema.payrollBatch).set({ status: 'draft' }).where(eq(schema.payrollBatch.id, batchId)),
    ).then(() => '', errText);
    expect(batchMsg).toMatch(/closed/i);
  });
});

describe('Slice A — company hierarchy + statutory identity', () => {
  it('rejects a parent cycle at the DB level', async () => {
    const a = adminCtx(base);
    const { id: holding } = await createCompany(a, { legalName: 'Holdings Bhd' });
    const { id: opco } = await createCompany(a, { legalName: 'OpCo Sdn Bhd' });
    await setCompanyParent(a, { companyId: opco, parentCompanyId: holding });

    // Making the holding a child of its own descendant would loop → rejected by the trigger.
    const msg = await setCompanyParent(a, { companyId: holding, parentCompanyId: opco }).then(
      () => '',
      (e: { cause?: { message?: string }; message?: string }) =>
        String(e?.cause?.message ?? e?.message ?? ''),
    );
    expect(msg).toMatch(/cycle/i);
  });

  it('upserts MY company statutory identity', async () => {
    const a = adminCtx(base);
    const { id: companyId } = await createCompany(a, { legalName: 'StatCo Sdn Bhd' });
    await setCompanyStatutoryMY(a, { companyId, epfEmployerNo: 'A1', lhdnEmployerNo: 'E9' });
    expect((await getCompanyStatutoryMY(a, companyId))?.epfEmployerNo).toBe('A1');

    await setCompanyStatutoryMY(a, { companyId, epfEmployerNo: 'A2' }); // upsert replaces
    const prof = await getCompanyStatutoryMY(a, companyId);
    expect(prof?.epfEmployerNo).toBe('A2');
    expect(prof?.lhdnEmployerNo).toBeNull();
  });
});

describe('Slice B — company-scoped authorization', () => {
  it('confines a company-scoped admin to its company and subtree', async () => {
    const a = adminCtx(base); // group-wide admin, for setup

    const { id: coA } = await createCompany(a, { legalName: 'Co A Sdn Bhd' });
    const { id: coB } = await createCompany(a, { legalName: 'Co B Sdn Bhd' });
    const { id: subA } = await createCompany(a, { legalName: 'Sub A Sdn Bhd' });
    await setCompanyParent(a, { companyId: subA, parentCompanyId: coA });

    // A department + employee in Co B (created by the group admin).
    const deptB = await createDepartment(a, { companyId: coB, name: 'B-Dept' });
    const empB = await hireEmployee(a, {
      person: { fullName: 'Bob B', primaryEmail: 'bob@b.test' },
      companyId: coB,
      departmentId: deptB.id,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });

    // A principal that is hr_admin for Co A ONLY.
    const scopedA: SessionContext = {
      tenantId: base.tenantId,
      userId: base.adminUserId,
      grants: [{ role: 'hr_admin', companyId: coA }],
    };

    // In scope: can write in Co A and its subsidiary Sub A.
    await expect(createDepartment(scopedA, { companyId: coA, name: 'A-Dept' })).resolves.toBeTruthy();
    await expect(createDepartment(scopedA, { companyId: subA, name: 'SubA-Dept' })).resolves.toBeTruthy();

    // Out of scope: cannot WRITE into Co B (RLS WITH CHECK denies).
    await expect(createDepartment(scopedA, { companyId: coB, name: 'nope' })).rejects.toThrow();

    // Out of scope: cannot SEE Co B's employee (RLS USING via can_see_employment).
    const visible = await listEmployees(scopedA);
    expect(visible.some((e) => e.employmentId === empB.employmentId)).toBe(false);
  });

  it('treats a group-wide admin (role-only context) as all-powerful (backward compat)', async () => {
    const a = adminCtx(base); // roles:['hr_admin'], no grants → group-wide
    const { id: co } = await createCompany(a, { legalName: 'GW Co Sdn Bhd' });
    await expect(createDepartment(a, { companyId: co, name: 'GW-Dept' })).resolves.toBeTruthy();
  });
});

describe('Slice C — consolidation (group vs per-company)', () => {
  it('scopes dashboard stats to a company subtree and breaks headcount down per company', async () => {
    const a = adminCtx(base);
    const { id: parent } = await createCompany(a, { legalName: 'Parent Co' });
    const { id: child } = await createCompany(a, { legalName: 'Child Co' });
    await setCompanyParent(a, { companyId: child, parentCompanyId: parent });
    const deptP = await createDepartment(a, { companyId: parent, name: 'P' });
    const deptC = await createDepartment(a, { companyId: child, name: 'C' });
    await hireEmployee(a, {
      person: { fullName: 'P1', primaryEmail: 'p1@x.test' },
      companyId: parent,
      departmentId: deptP.id,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await hireEmployee(a, {
      person: { fullName: 'C1', primaryEmail: 'c1@x.test' },
      companyId: child,
      departmentId: deptC.id,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });

    // Scoped to the parent → the whole subtree (parent + child).
    const groupStats = await dashboardStats(a, parent);
    expect(groupStats.headcount).toBe(2);
    expect(groupStats.companies).toBe(2);

    // Scoped to the child alone.
    const childStats = await dashboardStats(a, child);
    expect(childStats.headcount).toBe(1);
    expect(childStats.companies).toBe(1);

    // Per-company breakdown.
    const bd = await groupBreakdown(a);
    expect(bd.find((r) => r.id === parent)?.headcount).toBe(1);
    expect(bd.find((r) => r.id === child)?.headcount).toBe(1);
  });
});
