import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
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
  setCostAllocation,
  setReportingLine,
  terminateEmployment,
  transferEmployee,
} from '../core/org';
import { decideLeave, InsufficientLeaveBalanceError, requestLeave } from '../core/leave';
import { dashboardStats, groupBreakdown, listEmployees, reportingLinesFor } from '../core/read';
import { assignRole, createCompany, createDepartment, revokeRole, setCompanyParent } from '../core/admin';
import { getCompanyStatutoryMY, setCompanyStatutoryMY } from '../localization/my/company-statutory';
import { compensationHistory, currentCompensation, setCompensation } from '../core/comp';
import { getStatutoryProfileMY, InvalidICError, setStatutoryProfileMY } from '../localization/my/statutory';
import { annualEntitlement, entitlement } from '../localization/my/leave';
import { AlreadyCheckedInError, checkIn, checkOut } from '../core/attendance';
import {
  batchDetail,
  BatchNotDraftError,
  closeBatch,
  createBatch,
  generatePayslips,
  setPayrollInput,
} from '../core/payroll';
import { eis, epf, pcb, pcbAdditional, socso, statutory } from '../localization/my/payroll';
import { listReports, recentReports, recordReport, reportPreview } from '../core/reporting';

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

  it('applies the employee PCB tax profile (category + children) to generated payslips', async () => {
    const a = adminCtx(base);
    const e1 = await hire(a, base, 'TaxA');
    const e2 = await hire(a, base, 'TaxB');
    await setCompensation(a, { employmentId: e1.employmentId, basicSalary: 8000, effectiveFrom: '2026-01-01' });
    await setCompensation(a, { employmentId: e2.employmentId, basicSalary: 8000, effectiveFrom: '2026-01-01' });
    // e1: Category 1, no children (default). e2: Category 2 (spouse relief) + 3 children → more reliefs → less MTD.
    await setStatutoryProfileMY(a, { personId: e1.personId, icNumber: '900101010001', taxCategory: 1, numChildren: 0 });
    await setStatutoryProfileMY(a, { personId: e2.personId, icNumber: '900101010002', taxCategory: 2, numChildren: 3 });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-08' });
    await generatePayslips(a, { batchId });

    const detail = await batchDetail(a, batchId);
    const pcbByName = new Map(detail!.slips.map((s) => [s.name, (s.statutory as Record<string, number>).pcb]));
    const pcbA = pcbByName.get('TaxA')!;
    const pcbB = pcbByName.get('TaxB')!;
    expect(pcbA).toBeGreaterThan(0); // same gross, but the richer relief profile pays less PCB
    expect(pcbB).toBeLessThan(pcbA);
  });

  it('prorates a mid-period joiner by calendar days (EA-1955 incomplete month)', async () => {
    const a = adminCtx(base);
    const e = await hireEmployee(a, {
      person: { fullName: 'MidJoin', primaryEmail: 'midjoin@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-05-16', // employed 16 of May's 31 days
    });
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 3100, effectiveFrom: '2026-05-16' });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });
    const detail = await batchDetail(a, batchId);
    const slip = detail!.slips.find((s) => s.name === 'MidJoin')!;
    expect(Number(slip.basic)).toBeCloseTo(1600, 2); // 3100 * 16/31
    expect(Number(slip.daysWorked)).toBe(16); // proration basis surfaced on the payslip
  });

  it('includes a mid-period leaver (final prorated payslip) but excludes prior terminations', async () => {
    const a = adminCtx(base);
    const leaver = await hire(a, base, 'Leaver'); // hired 2026-01-01
    await setCompensation(a, { employmentId: leaver.employmentId, basicSalary: 3100, effectiveFrom: '2026-01-01' });
    await terminateEmployment(a, { employmentId: leaver.employmentId, terminationDate: '2026-05-15' });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });
    const may = await batchDetail(a, batchId);
    const slip = may!.slips.find((s) => s.name === 'Leaver')!;
    expect(Number(slip.basic)).toBeCloseTo(1500, 2); // 3100 * 15/31

    // A June batch must exclude someone terminated in May.
    const { batchId: junId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-06' });
    await generatePayslips(a, { batchId: junId });
    const jun = await batchDetail(a, junId);
    expect(jun!.slips.find((s) => s.name === 'Leaver')).toBeUndefined();
  });

  it('adds manual overtime and auto-derives unpaid-leave deductions (statutory on reduced base)', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'OtUnpaid'); // hired 2026-01-01, full May month
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 3100, effectiveFrom: '2026-01-01' });
    // An approved UNPAID-leave request: 2 days starting in the period.
    const [ult] = await owner.db
      .insert(schema.leaveType)
      .values({ tenantId: base.tenantId, code: 'UNPAID', name: 'Unpaid Leave', paid: false })
      .returning({ id: schema.leaveType.id });
    await owner.db.insert(schema.leaveRequest).values({
      tenantId: base.tenantId,
      employmentId: e.employmentId,
      leaveTypeId: ult.id,
      startDate: '2026-05-10',
      endDate: '2026-05-11',
      days: '2',
      status: 'approved',
    });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await setPayrollInput(a, { batchId, employmentId: e.employmentId, overtimeAmount: 500 });
    await generatePayslips(a, { batchId });

    const [ps] = await owner.db
      .select()
      .from(schema.payslip)
      .where(eq(schema.payslip.batchId, batchId));
    expect(Number(ps.grossPay)).toBeCloseTo(3600, 2); // basic 3100 + OT 500
    expect(Number(ps.overtimePay)).toBeCloseTo(500, 2);
    expect(Number(ps.otherDeductions)).toBeCloseTo(200, 2); // unpaid 3100/31 * 2
    // Statutory is on the reduced base (3600 − 200 = 3400): EPF = ceil(3400 × 0.11) = 374, not 396.
    expect((ps.statutory as Record<string, number>).epfEmployee).toBe(374);
    expect(Number(ps.netPay)).toBeCloseTo(3600 - 200 - (ps.statutory as Record<string, number>).epfEmployee
      - (ps.statutory as Record<string, number>).socsoEmployee
      - (ps.statutory as Record<string, number>).eisEmployee
      - (ps.statutory as Record<string, number>).pcb, 2);
  });

  it('rejects payroll input on a non-draft batch', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'Locked');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 3000, effectiveFrom: '2026-01-01' });
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-09' });
    await generatePayslips(a, { batchId }); // batch → processed
    await expect(
      setPayrollInput(a, { batchId, employmentId: e.employmentId, overtimeAmount: 100 }),
    ).rejects.toBeInstanceOf(BatchNotDraftError);
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

    // Company context = both companies (multi-select).
    const groupStats = await dashboardStats(a, [parent, child]);
    expect(groupStats.headcount).toBe(2);
    expect(groupStats.companies).toBe(2);

    // Company context = the child alone.
    const childStats = await dashboardStats(a, [child]);
    expect(childStats.headcount).toBe(1);
    expect(childStats.companies).toBe(1);

    // Per-company breakdown.
    const bd = await groupBreakdown(a);
    expect(bd.find((r) => r.id === parent)?.headcount).toBe(1);
    expect(bd.find((r) => r.id === child)?.headcount).toBe(1);
  });
});

describe('Slice D — concurrent employment + cost allocation', () => {
  it('lets one person hold employments at multiple companies, with a cost split', async () => {
    const a = adminCtx(base);
    const { id: coX } = await createCompany(a, { legalName: 'Co X Sdn Bhd' });
    const deptX = await createDepartment(a, { companyId: coX, name: 'X-Dept' });

    const e1 = await hireEmployee(a, {
      person: { fullName: 'Dual Worker', primaryEmail: 'dual@x.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    const e2 = await hireEmployee(a, {
      person: { id: e1.personId }, // same person, second concurrent employment
      companyId: coX,
      departmentId: deptX.id,
      employmentType: 'part_time',
      hiredOn: '2026-02-01',
    });
    expect(e2.personId).toBe(e1.personId);

    const emps = await withTenant(a, (tx) =>
      tx.select().from(schema.employment).where(eq(schema.employment.personId, e1.personId)),
    );
    expect(emps.length).toBe(2);

    await setCostAllocation(a, {
      employmentId: e2.employmentId,
      allocations: [{ companyId: base.companyId, percent: 60 }],
    });
    const [row] = await withTenant(a, (tx) =>
      tx
        .select({ ca: schema.employment.costAllocation })
        .from(schema.employment)
        .where(eq(schema.employment.id, e2.employmentId)),
    );
    expect(row.ca).toEqual([{ companyId: base.companyId, percent: 60 }]);
  });
});

describe('Slice B — company-scoped role assignment (#61)', () => {
  it('keeps hr_admin company scope but forces super_admin / other roles group-wide', async () => {
    const a = adminCtx(base);
    const { id: co } = await createCompany(a, { legalName: 'Scoped Co Sdn Bhd' });
    const [u] = await owner.db
      .insert(schema.appUser)
      .values({ tenantId: base.tenantId, workosUserId: `user_${randomUUID()}`, personId: null })
      .returning({ id: schema.appUser.id });

    await assignRole(a, { appUserId: u.id, role: 'hr_admin', companyId: co }); // scope honored
    await assignRole(a, { appUserId: u.id, role: 'super_admin', companyId: co }); // forced group-wide
    await assignRole(a, { appUserId: u.id, role: 'manager', companyId: co }); // scope not yet impl → null

    const rows = await owner.db
      .select({ role: schema.roleAssignment.role, companyId: schema.roleAssignment.companyId })
      .from(schema.roleAssignment)
      .where(eq(schema.roleAssignment.appUserId, u.id));
    const byRole = Object.fromEntries(rows.map((r) => [r.role, r.companyId]));
    expect(byRole['hr_admin']).toBe(co);
    expect(byRole['super_admin']).toBeNull();
    expect(byRole['manager']).toBeNull();
  });

  it('forbids an incoherent company-scoped super_admin row at the DB level', async () => {
    await expect(
      owner.db.insert(schema.roleAssignment).values({
        tenantId: base.tenantId,
        appUserId: base.adminUserId,
        role: 'super_admin',
        companyId: base.companyId,
      }),
    ).rejects.toThrow();
  });
});

describe('Sub-delegation — company admins assign within their subtree (#67)', () => {
  const coAdmin = (companyId: string): SessionContext => ({
    tenantId: base.tenantId,
    userId: base.adminUserId,
    roles: ['hr_admin'],
    grants: [{ role: 'hr_admin', companyId }],
  });

  it('lets a delegated admin appoint a scoped hr_admin in their subtree, blocking every escalation', async () => {
    const a = adminCtx(base);
    const { id: parent } = await createCompany(a, { legalName: 'Deleg Parent' });
    const { id: child } = await createCompany(a, { legalName: 'Deleg Child' });
    await setCompanyParent(a, { companyId: child, parentCompanyId: parent });
    const { id: other } = await createCompany(a, { legalName: 'Deleg Other' });
    const [u] = await owner.db
      .insert(schema.appUser)
      .values({ tenantId: base.tenantId, workosUserId: `user_${randomUUID()}`, personId: null })
      .returning({ id: schema.appUser.id });

    const pAdmin = coAdmin(parent);
    // ALLOWED: scoped hr_admin for own company and a descendant.
    await expect(assignRole(pAdmin, { appUserId: u.id, role: 'hr_admin', companyId: parent })).resolves.toBeTruthy();
    await expect(assignRole(pAdmin, { appUserId: u.id, role: 'hr_admin', companyId: child })).resolves.toBeTruthy();
    // BLOCKED: minting a super_admin.
    await expect(assignRole(pAdmin, { appUserId: u.id, role: 'super_admin', companyId: parent })).rejects.toThrow();
    // BLOCKED: a group-wide grant (companyId omitted → null).
    await expect(assignRole(pAdmin, { appUserId: u.id, role: 'hr_admin' })).rejects.toThrow();
    // BLOCKED: a company outside their subtree.
    await expect(assignRole(pAdmin, { appUserId: u.id, role: 'hr_admin', companyId: other })).rejects.toThrow();

    // A group admin remains unrestricted (regression).
    await expect(assignRole(a, { appUserId: u.id, role: 'super_admin' })).resolves.toBeTruthy();
  });

  it('blocks a delegated admin from revoking grants outside their authority (no false-success)', async () => {
    const a = adminCtx(base);
    const { id: parent } = await createCompany(a, { legalName: 'Rev Parent' });
    const { id: other } = await createCompany(a, { legalName: 'Rev Other' });
    const [u] = await owner.db
      .insert(schema.appUser)
      .values({ tenantId: base.tenantId, workosUserId: `user_${randomUUID()}`, personId: null })
      .returning({ id: schema.appUser.id });

    const groupWide = await assignRole(a, { appUserId: u.id, role: 'hr_admin' }); // company_id null
    const outOfTree = await assignRole(a, { appUserId: u.id, role: 'hr_admin', companyId: other });
    const inTree = await assignRole(a, { appUserId: u.id, role: 'hr_admin', companyId: parent });

    const pAdmin = coAdmin(parent);
    await expect(revokeRole(pAdmin, { roleAssignmentId: groupWide.id })).rejects.toThrow();
    await expect(revokeRole(pAdmin, { roleAssignmentId: outOfTree.id })).rejects.toThrow();
    await expect(revokeRole(pAdmin, { roleAssignmentId: inTree.id })).resolves.toBeUndefined();

    // The blocked grants must still exist (revoke was a real no-op, not a silent success).
    const remaining = await owner.db
      .select({ id: schema.roleAssignment.id })
      .from(schema.roleAssignment)
      .where(eq(schema.roleAssignment.appUserId, u.id));
    const ids = remaining.map((r) => r.id);
    expect(ids).toContain(groupWide.id);
    expect(ids).toContain(outOfTree.id);
    expect(ids).not.toContain(inTree.id);
  });
});

describe('Slice 5 — bonus / additional-remuneration MTD (#68)', () => {
  it('PCB on a bonus is the difference method; bonus hits EPF + PCB but not SOCSO/EIS', () => {
    const profile = { category: 1 as const, children: 0 };
    const base = statutory(5000, profile, 0); // RM5000/mo, no bonus
    const withBonus = statutory(5000, profile, 5000); // + RM5000 bonus

    // PCB = normal monthly PCB + bonus PCB (difference method), exposed as pcbBonus.
    const bonusPcb = pcbAdditional(5000, 5000, profile);
    expect(bonusPcb).toBeGreaterThan(0);
    expect(withBonus.pcbBonus).toBe(bonusPcb);
    expect(withBonus.pcb).toBe(Math.round((pcb(5000, profile) + bonusPcb) * 100) / 100);
    expect(pcbAdditional(5000, 0, profile)).toBe(0); // no bonus → no extra PCB

    // EPF: bonus IS subject. Employer rate stays 13% (normal wage ≤ RM5000) applied to wage+bonus.
    expect(epf(5000, 5000)).toEqual({ employee: 1100, employer: 1300 });
    expect(withBonus.epfEmployee).toBe(1100);
    expect(withBonus.epfEmployer).toBe(1300);
    expect(withBonus.epfEmployer).toBeGreaterThan(base.epfEmployer); // bonus added EPF

    // SOCSO + EIS: bonus EXCLUDED — identical with and without the bonus.
    expect(withBonus.socsoEmployee).toBe(base.socsoEmployee);
    expect(withBonus.socsoEmployer).toBe(base.socsoEmployer);
    expect(withBonus.eisEmployee).toBe(base.eisEmployee);
    expect(withBonus.eisEmployer).toBe(base.eisEmployer);
  });

  it('generated payslip taxes the bonus and records it', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'Bonus Earner');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 6000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101012222' });
    const batch = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-03' });
    await setPayrollInput(a, { batchId: batch.batchId, employmentId: e.employmentId, overtimeAmount: 0, bonusAmount: 6000 });
    await generatePayslips(a, { batchId: batch.batchId });

    const { slips } = (await batchDetail(a, batch.batchId))!;
    const slip = slips.find((s) => s.name === 'Bonus Earner')!;
    const st = slip.statutory as { pcb: number; pcbBonus: number };
    expect(Number(slip.bonus)).toBe(6000);
    expect(Number(slip.gross)).toBe(12000); // 6000 basic + 6000 bonus
    expect(st.pcbBonus).toBeGreaterThan(0);
    expect(st.pcb).toBeGreaterThan(pcb(6000, { category: 1, children: 0 })); // bonus pushed PCB up
  });
});

describe('Slice 6A — statutory reporting (#70)', () => {
  it('previews the monthly contribution report and records an audited artefact + event', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'Report Subject');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, {
      personId: e.personId,
      icNumber: '900101013333',
      epfNumber: 'EPF1',
      socsoNumber: 'SOC1',
      taxNumber: 'TAX1',
    });
    const batch = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-04' });
    await generatePayslips(a, { batchId: batch.batchId });

    const preview = await reportPreview(a, { companyId: base.companyId, reportId: 'my.contributions', periodKey: '2026-04' });
    expect(preview.meta.hasBatch).toBe(true);
    const row = preview.rows.find((r) => r.name === 'Report Subject')!;
    expect(row.ic).toBe('900101013333');
    expect(Number(row.epf)).toBeGreaterThan(0); // EPF EE+ER
    expect(preview.totals.epf).toBeGreaterThan(0);
    expect(preview.readiness).toEqual([]); // all identifiers present → ready to file

    const rec = await recordReport(a, { companyId: base.companyId, reportId: 'my.contributions', periodKey: '2026-04' });
    expect(rec.id).toBeTruthy();
    const recent = await recentReports(a, base.companyId);
    expect(recent[0]?.reportType).toBe('my.contributions');
    expect(recent[0]?.periodKey).toBe('2026-04');
    expect(await eventTypesFor(base.tenantId, rec.id)).toContain('statutory-report.generated');
  });

  it('flags employees missing statutory identifiers in the readiness check', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'No Profile');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 4000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    // intentionally no statutory profile → IC / tax / EPF / SOCSO blank
    const batch = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-04' });
    await generatePayslips(a, { batchId: batch.batchId });

    const preview = await reportPreview(a, { companyId: base.companyId, reportId: 'my.contributions', periodKey: '2026-04' });
    const flagged = preview.readiness.find((r) => r.name === 'No Profile')!;
    expect(flagged).toBeTruthy();
    expect(flagged.missing).toContain('IC');
    expect(flagged.missing).toContain('EPF no');
  });

  it('returns hasBatch=false when no payroll batch exists for the period', async () => {
    const a = adminCtx(base);
    const preview = await reportPreview(a, { companyId: base.companyId, reportId: 'my.contributions', periodKey: '2099-12' });
    expect(preview.meta.hasBatch).toBe(false);
    expect(preview.rows).toEqual([]);
  });
});

describe('Slice 6B — per-agency monthly reports (#71)', () => {
  it('lists the monthly reports and keeps figures consistent across them', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'Multi Report');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 6000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101014444', epfNumber: 'EPF9', socsoNumber: 'SOC9', taxNumber: 'TAX9' });
    const batch = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId: batch.batchId });

    const ids = (await listReports(a, base.companyId)).map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining(['my.contributions', 'my.cp39', 'my.epf', 'my.socso-eis']));

    const prev = (reportId: string) => reportPreview(a, { companyId: base.companyId, reportId, periodKey: '2026-05' });
    const [contrib, cp39, epfR, socso] = await Promise.all([
      prev('my.contributions'),
      prev('my.cp39'),
      prev('my.epf'),
      prev('my.socso-eis'),
    ]);
    // Figures reconcile across the overview and the per-agency reports.
    expect(cp39.totals.pcb).toBe(contrib.totals.pcb);
    expect(epfR.totals.employee + epfR.totals.employer).toBeCloseTo(contrib.totals.epf, 2);
    expect(socso.totals.socsoEmployee + socso.totals.socsoEmployer).toBeCloseTo(contrib.totals.socso, 2);
    expect(socso.totals.eisEmployee + socso.totals.eisEmployer).toBeCloseTo(contrib.totals.eis, 2);
  });

  it('each agency report flags its own missing identifier', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'Partial IDs');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101015555', taxNumber: 'TAXX' }); // no EPF/SOCSO no
    const batch = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId: batch.batchId });

    const epfR = await reportPreview(a, { companyId: base.companyId, reportId: 'my.epf', periodKey: '2026-05' });
    expect(epfR.readiness[0].missing).toContain('EPF no');
    const cp39 = await reportPreview(a, { companyId: base.companyId, reportId: 'my.cp39', periodKey: '2026-05' });
    expect(cp39.readiness).toEqual([]); // tax no present → CP39 ready
  });
});
