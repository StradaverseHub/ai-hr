/**
 * ADR-0077 slice 3 — WHY THE PAYROLL-KERNEL TESTS IN THIS FILE USE `entitledCtx`, NOT `adminCtx`.
 *
 * This file writes no feature-gate env vars and never did; it exercises the LEGACY payroll kernel,
 * which is what `test/env.ts` gives it by deleting TYPED_PAY_COMPONENTS_ENABLED and
 * MULTI_CYCLE_PAYROLL_ENABLED (and by no tracked file setting TOIL_ENABLED). Slice 3 stopped those
 * three from being env reads — `core/payroll.ts` now asks `isModuleEnabled(ctx, …)` — and `adminCtx`
 * is `entitlementsExempt: 'harness'`, which answers TRUE for every catalogued module. So the flip
 * would have switched typed pay components ON for every `generatePayslips` call here.
 *
 * That is not a cosmetic difference: with typed components on, `earningsOf` reads the component
 * tables INSTEAD of compensation + payroll_input, and this file seeds no components — allowance,
 * overtime and bonus would all silently resolve to 0 while `basic` kept coming from Personnel. Some
 * assertions would have failed loudly (OT RM500, bonus RM6,000, the EA statement's RM1,000
 * allowances); the basic-only ones would have gone on passing while testing a kernel path the file
 * was never written for.
 *
 * `entitledCtx` resolves a REAL snapshot from this tenant's rows, and `seedBase` seeds exactly
 * `legacyEnabledModulesIn(process.env)` — payroll / attendance / claims / performance active, and NO
 * row for typed_pay_components, multi_cycle_payroll or toil (a missing row is disabled, C7). It is
 * therefore byte-for-byte the gate state this file ran under before slice 3, and the same state a
 * real customer on the legacy kernel has. Every test that calls `generatePayslips` (or
 * `prefillOvertimeFromAttendance`) drives it through that context; the non-payroll tests keep the
 * exempt `adminCtx`, which is what the marker is for.
 *
 * ONE NON-PAYROLL PATH IS AFFECTED TOO: `decideAttendanceCorrection` now reaches
 * `maybeAutoAccrueOnApprovalTx`, whose first line asks `isModuleEnabled(ctx, 'toil')`. A hand-built
 * `SessionContext` literal carries neither a snapshot nor an exemption marker, so that question throws
 * `EntitlementsUnresolvedError` rather than answering — the approving contexts in that describe block
 * therefore resolve real snapshots as well. See the comment at the manager-approval test.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import {
  adminCtx,
  closeAll,
  createAppUser,
  entitledCtx,
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
import { decideLeave, InsufficientLeaveBalanceError, openLeaveYear, requestLeave } from '../core/leave';
import { dashboardStats, groupBreakdown, listEmployees, listEmployeesPage, reportingLinesFor } from '../core/read';
import {
  archiveDepartment,
  assignRole,
  createCompany,
  createCostCenter,
  createDepartment,
  createLeavePolicy,
  createLeaveType,
  deleteLeavePolicy,
  revokeRole,
  setCompanyParent,
  updateLeavePolicy,
} from '../core/admin';
import { getCompanyStatutoryMY, setCompanyStatutoryMY } from '../localization/my/company-statutory';
import { compensationHistory, currentCompensation, setCompensation } from '../core/comp';
import {
  acknowledgeReview,
  closeCycle,
  createCycle,
  cycleDetail,
  declineCompAction,
  enactCompAction,
  managerPendingReviews,
  moveCycleToCalibration,
  openCycle,
  PerfError,
  reassignReviewer,
  releaseCycle,
  reviewForViewer,
  submitManagerReview,
  submitSelfReview,
} from '../core/performance';
import { getStatutoryProfileMY, InvalidICError, setStatutoryProfileMY } from '../localization/my/statutory';
import { validateEmployeeImport, commitEmployeeImport } from '../core/import';
import { parseCsvRecords } from '../lib/csv';
import { annualEntitlement, entitlement } from '../localization/my/leave';
import {
  checkIn,
  checkOut,
  decideAttendanceCorrection,
  requestAttendanceCorrection,
} from '../core/attendance';
import { decideProfileChange, requestProfileChange, updateOwnContact } from '../core/profile';
import {
  batchDetail,
  BatchNotDraftError,
  batchInputRows,
  closeBatch,
  createBatch,
  generatePayslips,
  paymentSummaryForBatch,
  PaymentSummaryNotReadyError,
  payslipDetail,
  prefillOvertimeFromAttendance,
  setPayrollInput,
} from '../core/payroll';
import { applyZakatOffset, eis, epf, overtimePay, pcbMonth, socso, statutory } from '../localization/my/payroll';
import {
  buildCp39File,
  cp39FileForBatch,
  Cp39NotReadyError,
  normalizeEmployerNo,
} from '../localization/my/cp39-file';
import {
  complianceWorklist,
  employeeEaStatement,
  listReports,
  recentReports,
  recordReport,
  reportPreview,
} from '../core/reporting';

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
    grantLeaveTypes: opts?.annual ? [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }] : undefined,
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

  it('adding a second active line of the same type supersedes the first (no duplicate parent)', async () => {
    const a = adminCtx(base);
    const E = await hire(a, base, 'Subo');
    const M1 = await hire(a, base, 'BossOne');
    const M2 = await hire(a, base, 'BossTwo');

    const first = await setReportingLine(a, {
      subordinateEmploymentId: E.employmentId,
      managerEmploymentId: M1.employmentId,
      lineType: 'administrative',
      validFrom: '2026-06-05',
    });
    // Second admin manager on a later date → replaces the first; only one active admin line remains.
    await setReportingLine(a, {
      subordinateEmploymentId: E.employmentId,
      managerEmploymentId: M2.employmentId,
      lineType: 'administrative',
      validFrom: '2026-06-20',
    });

    const lines = await reportingLinesFor(a, E.employmentId);
    const admins = lines.managers.filter((m) => m.lineType === 'administrative');
    expect(admins).toHaveLength(1);
    expect(admins[0].employmentId).toBe(M2.employmentId);

    // The prior line was closed (valid_to set) and a supersede event recorded.
    const [old] = await withTenant(a, (tx) =>
      tx.select().from(schema.reportingLine).where(eq(schema.reportingLine.id, first.reportingLineId)),
    );
    expect(old.validTo).toBe('2026-06-20');
    const evs = await eventTypesFor(base.tenantId, first.reportingLineId);
    expect(evs).toContain('reporting-line.set');
    expect(evs).toContain('reporting-line.superseded');

    // A different line type coexists with the active administrative one.
    await setReportingLine(a, {
      subordinateEmploymentId: E.employmentId,
      managerEmploymentId: M1.employmentId,
      lineType: 'functional',
      validFrom: '2026-06-20',
    });
    const after = await reportingLinesFor(a, E.employmentId);
    expect(after.managers.map((m) => m.lineType).sort()).toEqual(['administrative', 'functional']);
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
      .values({ allowNegativeBalance: true, tenantId: base.tenantId, code: 'WD', name: 'Working-day Leave', paid: true, counting: 'working_days' })
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
  it('derives status from thresholds; one aggregate per day; check-out after check-in', async () => {
    const a = adminCtx(base);
    const { employmentId } = await hire(a, base, 'Att');

    const r1 = await checkIn(a, { employmentId, date: '2026-06-05', time: '09:00' });
    expect(r1.status).toBe('present'); // before 09:15
    // R45 Multiple Clocking: a checkout before the recorded check-in is still rejected.
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
    // SOCSO/EIS: wages above RM6,000 contribute at the schedules' top band (row 65), not a %.
    // SOCSO now carries the employee-paid SKBBK leg (Lindung 24 Jam, eff 1 Jun 2026).
    expect(socso(8000)).toEqual({ employer: 104.15, employee: 29.75, skbbk: 44.65 });
    expect(eis(8000)).toEqual({ employer: 11.9, employee: 11.9 });
  });

  it('generates one payslip per active employee; net = gross − statutory deductions', async () => {
    const a = await entitledCtx(base);
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
    const expectedNet = 4000 - (st.epfEmployee + st.socsoEmployee + st.socsoSkbbk + st.eisEmployee + st.pcb);
    expect(Number(slip.net)).toBeCloseTo(expectedNet, 2);

    expect(await eventTypesFor(base.tenantId, batchId)).toContain('payroll-batch.processed');
  });

  it('forbids a duplicate period batch and re-generating a processed batch', async () => {
    const a = await entitledCtx(base);
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-07' });
    await expect(
      createBatch(a, { companyId: base.companyId, payPeriod: '2026-07' }),
    ).rejects.toThrow();
    await generatePayslips(a, { batchId });
    await expect(generatePayslips(a, { batchId })).rejects.toBeInstanceOf(BatchNotDraftError);
  });

  it('applies the employee PCB tax profile (category + children) to generated payslips', async () => {
    const a = await entitledCtx(base);
    const e1 = await hire(a, base, 'TaxA');
    const e2 = await hire(a, base, 'TaxB');
    await setCompensation(a, { employmentId: e1.employmentId, basicSalary: 8000, effectiveFrom: '2026-01-01' });
    await setCompensation(a, { employmentId: e2.employmentId, basicSalary: 8000, effectiveFrom: '2026-01-01' });
    // e1: Category 1, no children (default). e2: Category 2 (spouse relief) + 3 children → more reliefs → less MTD.
    await setStatutoryProfileMY(a, { personId: e1.personId, icNumber: '900101010001', taxCategory: 1, numChildren: 0 });
    await setStatutoryProfileMY(a, { personId: e2.personId, icNumber: '900101010002', taxCategory: 2, numChildren: 3 });

    // January: with accumulators, a first-ever batch in month m projects income only from m to
    // December (an August start on RM8,000 → chargeable 27,000 → rebate wipes the MTD — correctly).
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-01' });
    await generatePayslips(a, { batchId });

    const detail = await batchDetail(a, batchId);
    const pcbByName = new Map(detail!.slips.map((s) => [s.name, (s.statutory as Record<string, number>).pcb]));
    const pcbA = pcbByName.get('TaxA')!;
    const pcbB = pcbByName.get('TaxB')!;
    expect(pcbA).toBeGreaterThan(0); // same gross, but the richer relief profile pays less PCB
    expect(pcbB).toBeLessThan(pcbA);
  });

  it('prorates a mid-period joiner by calendar days (EA-1955 incomplete month)', async () => {
    const a = await entitledCtx(base);
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
    const a = await entitledCtx(base);
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
    const a = await entitledCtx(base);
    const e = await hire(a, base, 'OtUnpaid'); // hired 2026-01-01, full May month
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 3100, effectiveFrom: '2026-01-01' });
    // An approved UNPAID-leave request: 2 days starting in the period.
    const [ult] = await owner.db
      .insert(schema.leaveType)
      .values({ allowNegativeBalance: true, tenantId: base.tenantId, code: 'UNPAID', name: 'Unpaid Leave', paid: false })
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
    // Agency bases split (STATUTORY-SOURCES §6): EPF EXCLUDES overtime — its base is
    // wages ex-OT minus unpaid (3100 − 200 = 2900) → ceil(2900 × 0.11) = 319.
    // SOCSO/EIS/PCB stay on wages incl. OT (3400).
    expect((ps.statutory as Record<string, number>).epfEmployee).toBe(319);
    expect(Number(ps.netPay)).toBeCloseTo(3600 - 200 - (ps.statutory as Record<string, number>).epfEmployee
      - (ps.statutory as Record<string, number>).socsoEmployee
      - (ps.statutory as Record<string, number>).socsoSkbbk
      - (ps.statutory as Record<string, number>).eisEmployee
      - (ps.statutory as Record<string, number>).pcb, 2);
  });

  it('rejects payroll input on a non-draft batch', async () => {
    const a = await entitledCtx(base);
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
    const jan = (wage: number, profile?: { category?: 1 | 2 | 3; children?: number }) =>
      pcbMonth({ monthlyWage: wage, epfMonthly: Math.ceil(wage * 0.11), month: 1, profile }).normal;
    // RM3000 single → below the taxable threshold after reliefs → no PCB.
    expect(jan(3000)).toBe(0);
    // RM5000 single, January: P = 47,000.07 → (12,000.07·6% + 600)/12 → RM110.00.
    expect(jan(5000)).toBe(110);
    // Category 2 (non-working spouse, +RM4000 relief) pays less than a single earner.
    expect(jan(8000, { category: 2 })).toBeLessThan(jan(8000, { category: 1 }));
    // Each qualifying child reduces PCB.
    expect(jan(8000, { children: 2 })).toBeLessThan(jan(8000, { children: 0 }));
  });

  it('SOCSO First Category matches the official Act 4 schedule to the RM6,000 ceiling', () => {
    // employer/employee = Nov-2024 Act 4 schedule (unchanged); skbbk = the Lindung-24-Jam leg (1 Jun 2026).
    expect(socso(3000)).toEqual({ employer: 51.65, employee: 14.75, skbbk: 22.15 });
    expect(socso(100)).toEqual({ employer: 1.5, employee: 0.4, skbbk: 0.65 });
    expect(socso(5000)).toEqual({ employer: 86.65, employee: 24.75, skbbk: 37.15 });
    // The RM5,000–6,000 bands (rows 55–64 of the Nov-2024 PERKESO PDF) — previously rate-based.
    expect(socso(5050)).toEqual({ employer: 88.35, employee: 25.25, skbbk: 37.85 });
    expect(socso(5800)).toEqual({ employer: 100.65, employee: 28.75, skbbk: 43.15 });
    expect(socso(6000)).toEqual({ employer: 104.15, employee: 29.75, skbbk: 44.65 });
    // Row 65: wages exceeding RM6,000 stay at the top band.
    expect(socso(9000)).toEqual({ employer: 104.15, employee: 29.75, skbbk: 44.65 });
  });

  it('EIS matches the official Act 800 Second Schedule (fixed band amounts, not 0.2%)', () => {
    expect(eis(30)).toEqual({ employer: 0.05, employee: 0.05 });
    // Band amounts differ from a straight 0.2% of wage — the old approximation.
    expect(eis(120)).toEqual({ employer: 0.25, employee: 0.25 }); // 0.2% would give 0.24
    expect(eis(5780)).toEqual({ employer: 11.5, employee: 11.5 }); // 0.2% would give 11.56
    expect(eis(5000)).toEqual({ employer: 9.9, employee: 9.9 });
    expect(eis(6000)).toEqual({ employer: 11.9, employee: 11.9 });
    // Row 65: wages exceeding RM6,000 stay at the top band (was 12.00 under the rate calc).
    expect(eis(9000)).toEqual({ employer: 11.9, employee: 11.9 });
  });

  it('EPF follows the Third Schedule Part A band table, not a rate on the exact wage (#95)', () => {
    // Wage 4567 sits in band 4560.01–4580: ceil(0.11*4580)=504, ceil(0.13*4580)=596.
    // (The prior rate-on-exact-wage approximation gave 503/594 — the bug this gate fixes.)
    expect(epf(4567)).toEqual({ employee: 504, employer: 596 });
    expect(epf(5000).employer).toBe(650); // last 13% band: ceil(0.13*5000)
    expect(epf(5001).employer).toBe(612); // first 12% band (5000.01–5100): ceil(0.12*5100) — the real step
    expect(epf(10).employee).toBe(0); // statutory NIL first band (RM0.01–10)
  });

  it('freezes a closed batch and its payslips at the DB level', async () => {
    const a = await entitledCtx(base);
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

    // PCB = normal monthly PCB + bonus PCB (spec §D.2 Steps 1–5), exposed as pcbBonus.
    const m = pcbMonth({
      monthlyWage: 5000,
      epfMonthly: 550,
      month: 1,
      profile,
      additional: 5000,
      epfOnAdditional: 550,
    });
    expect(m.additional).toBeGreaterThan(0);
    expect(withBonus.pcbBonus).toBe(m.additional);
    expect(withBonus.pcb).toBe(m.total);
    expect(statutory(5000, profile, 0).pcbBonus).toBe(0); // no bonus → no extra PCB

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
    const a = await entitledCtx(base);
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
    // Bonus pushed total PCB above the normal-only March MTD (fresh year, no priors).
    const normalOnly = pcbMonth({ monthlyWage: 6000, epfMonthly: 660, month: 3 }).normal;
    expect(st.pcb).toBeGreaterThan(normalOnly);
  });
});

describe('Slice 6A — statutory reporting (#70)', () => {
  it('previews the monthly contribution report and records an audited artefact + event', async () => {
    const a = await entitledCtx(base);
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
    const a = await entitledCtx(base);
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
    const a = await entitledCtx(base);
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
    const a = await entitledCtx(base);
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

describe('Slice 6C — annual Form E / CP8D (#72)', () => {
  it('aggregates the tax year across batches and computes Form E Part A counts', async () => {
    const a = await entitledCtx(base);
    const e = await hire(a, base, 'Annual Worker'); // hired 2026-01-01
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101016666', epfNumber: 'EPFY', socsoNumber: 'SOCY', taxNumber: 'TAXY' });
    for (const m of ['2026-01', '2026-02', '2026-03']) {
      const b = await createBatch(a, { companyId: base.companyId, payPeriod: m });
      await generatePayslips(a, { batchId: b.batchId });
    }

    const month = await reportPreview(a, { companyId: base.companyId, reportId: 'my.contributions', periodKey: '2026-01' });
    const m1 = month.rows.find((r) => r.name === 'Annual Worker')!;
    const cp8d = await reportPreview(a, { companyId: base.companyId, reportId: 'my.cp8d', periodKey: '2026' });
    const yr = cp8d.rows.find((r) => r.name === 'Annual Worker')!;

    // Annual figures = 3 months aggregated.
    expect(Number(yr.gross)).toBeCloseTo(Number(m1.gross) * 3, 2);
    expect(Number(yr.pcb)).toBeCloseTo(Number(m1.pcb) * 3, 2);
    expect(yr.taxNo).toBe('TAXY');

    // Form E Part A counts present + sensible.
    const active = cp8d.meta.summary!.find((x) => x.label.startsWith('Active at 31 Dec'))!;
    expect(Number(active.value)).toBeGreaterThanOrEqual(1);
    expect(cp8d.meta.summary!.find((x) => x.label === 'Subject to MTD')!.value).toBeGreaterThanOrEqual(1);
  });

  it('builds a per-employee EA statement aggregating the tax year (incl. bonus)', async () => {
    const a = await entitledCtx(base);
    const e = await hire(a, base, 'EA Person');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, monthlyAllowance: 500, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101017777', epfNumber: 'EPFEA', socsoNumber: 'SOCEA', taxNumber: 'TAXEA' });
    for (const m of ['2026-01', '2026-02']) {
      const b = await createBatch(a, { companyId: base.companyId, payPeriod: m });
      await setPayrollInput(a, { batchId: b.batchId, employmentId: e.employmentId, overtimeAmount: 0, bonusAmount: m === '2026-02' ? 3000 : 0 });
      await generatePayslips(a, { batchId: b.batchId });
    }

    const ea = (await employeeEaStatement(a, { employmentId: e.employmentId, year: '2026' }))!;
    expect(ea.employee.taxNo).toBe('TAXEA');
    expect(ea.employee.epfNo).toBe('EPFEA');
    expect(ea.partB.grossSalary).toBeCloseTo(10000, 2); // 5000 × 2 months
    expect(ea.partB.allowances).toBeCloseTo(1000, 2); // 500 × 2
    expect(ea.partB.bonus).toBeCloseTo(3000, 2); // Feb only
    expect(ea.partB.gross).toBeCloseTo(14000, 2);
    expect(ea.partD.mtd).toBeGreaterThan(0);
    expect(ea.partE.epf).toBeGreaterThan(0);
  });
});

describe('Slice 6E — CP22 / CP22A compliance worklist (#74)', () => {
  it('surfaces CP22 for a recent hire and CP22A for a cessation, with deadlines + status', async () => {
    const a = adminCtx(base);
    const today = '2026-06-08';
    await hireEmployee(a, {
      person: { fullName: 'Fresh Hire', primaryEmail: 'fresh@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-06-01',
    });
    const leaver = await hireEmployee(a, {
      person: { fullName: 'Leaver', primaryEmail: 'leaver@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2025-01-01',
    });
    await terminateEmployment(a, { employmentId: leaver.employmentId, terminationDate: '2026-06-30' });

    const wl = await complianceWorklist(a, { companyId: base.companyId, today });

    const cp22 = wl.find((w) => w.form === 'CP22' && w.name === 'Fresh Hire')!;
    expect(cp22.dueBy).toBe('2026-07-01'); // hiredOn + 30 days
    expect(cp22.status).toBe('upcoming'); // today 06-08, due 07-01

    const cp22a = wl.find((w) => w.form === 'CP22A' && w.name === 'Leaver')!;
    expect(cp22a.dueBy).toBe('2026-05-31'); // cessation (06-30) − 30 days
    expect(cp22a.status).toBe('overdue'); // today 06-08 is past 05-31

    // The long-ago hire is outside the CP22 window — only its cessation surfaces.
    expect(wl.some((w) => w.form === 'CP22' && w.name === 'Leaver')).toBe(false);
  });
});

describe('Overtime monetization — EA 1955 (ORP/26, 1.5×/2×/3×, RM4,000 gate)', () => {
  // RM2,600 wages → ORP 100.00/day, hourly 12.50 — clean hand-checkable figures.
  it('workday OT pays 1.5× hourly', () => {
    const r = overtimePay({ monthlyWages: 2600, days: [{ dayType: 'workday', minutes: 90 }] });
    expect(r.orp).toBe(100);
    expect(r.hourly).toBe(12.5);
    expect(r.workday).toBe(28.13); // 1.5h × 1.5 × 12.50
    expect(r.total).toBe(28.13);
  });

  it('rest day: ½ day ≤ half normal hours, 1 day above, 2× beyond normal hours', () => {
    const half = overtimePay({ monthlyWages: 2600, days: [{ dayType: 'rest_day', minutes: 180 }] });
    expect(half.restDay).toBe(50); // 3h ≤ 4h → ½ × ORP
    const full = overtimePay({ monthlyWages: 2600, days: [{ dayType: 'rest_day', minutes: 300 }] });
    expect(full.restDay).toBe(100); // 5h > 4h → 1 × ORP
    const beyond = overtimePay({ monthlyWages: 2600, days: [{ dayType: 'rest_day', minutes: 600 }] });
    expect(beyond.restDay).toBe(150); // 8h → ORP, +2h × 2 × 12.50
  });

  it('holiday: 2 extra days ORP plus 3× beyond normal hours', () => {
    const r = overtimePay({ monthlyWages: 2600, days: [{ dayType: 'holiday', minutes: 540 }] });
    expect(r.holiday).toBe(237.5); // 2 × 100 + 1h × 3 × 12.50
  });

  it('wages above RM4,000 are not statutorily entitled (First Schedule)', () => {
    const r = overtimePay({ monthlyWages: 4500, days: [{ dayType: 'workday', minutes: 600 }] });
    expect(r.eligible).toBe(false);
    expect(r.total).toBe(0);
  });

  it('statutory bases split: EPF excludes OT; SOCSO/EIS include it', () => {
    const st = statutory(3000, undefined, 0, 500);
    expect(st.epfEmployee).toBe(epf(3000).employee); // EPF on wages ex-OT
    expect(st.eisEmployee).toBe(eis(3500).employee); // EIS on wages incl. OT
    expect(st.socsoEmployee).toBe(socso(3500).employee); // SOCSO on wages incl. OT
  });

  it('prefills draft-batch OT inputs from classified attendance', async () => {
    const b = await seedBase();
    const a = await entitledCtx(b);
    const { employmentId } = await hire(a, b, 'Otman'); // hired 2026-01-01
    await setCompensation(a, { employmentId, basicSalary: 2600, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    const rich = await hire(a, b, 'Richman');
    await setCompensation(a, {
      employmentId: rich.employmentId,
      basicSalary: 4500,
      monthlyAllowance: 0,
      effectiveFrom: '2026-01-01',
    });
    // Wednesday 2026-06-03: 09:00→19:30 = 10.5h span − 1h break = 9.5h → 90m workday OT.
    for (const emp of [employmentId, rich.employmentId]) {
      await checkIn(a, { employmentId: emp, date: '2026-06-03', time: '09:00' });
      await checkOut(a, { employmentId: emp, date: '2026-06-03', time: '19:30' });
    }
    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-06' });
    const res = await prefillOvertimeFromAttendance(a, { batchId });
    expect(res.applied).toBe(1);
    expect(res.ineligible).toBe(1); // Richman: > RM4,000 — left manual
    const rows = await batchInputRows(a, batchId);
    expect(Number(rows.find((r) => r.employmentId === employmentId)?.overtimeAmount)).toBe(28.13);
    expect(Number(rows.find((r) => r.employmentId === rich.employmentId)?.overtimeAmount ?? 0)).toBe(0);
  });
});

describe('Leave policy resolution — grant = max(statutory floor, company policy)', () => {
  it('a more generous company policy raises the grant above the EA floor', async () => {
    const b = await seedBase(); // fresh tenant so the shared base keeps its floor-only grants
    const a = adminCtx(b);
    await createLeavePolicy(a, { leaveTypeId: b.annualLeaveTypeId, annualDays: 20, validFrom: '2026-01-01' });
    const { employmentId } = await hire(a, b, 'Generous', { annual: true });
    expect(await ledgerBalance(employmentId, b.annualLeaveTypeId)).toBe(20); // policy 20 > floor 8
  });

  it('a below-minimum policy is clamped to the statutory floor', async () => {
    const b = await seedBase();
    const a = adminCtx(b);
    await createLeavePolicy(a, { leaveTypeId: b.annualLeaveTypeId, annualDays: 3, validFrom: '2026-01-01' });
    const { employmentId } = await hire(a, b, 'Clamped', { annual: true });
    expect(await ledgerBalance(employmentId, b.annualLeaveTypeId)).toBe(8); // EA floor 8 wins over 3
  });

  it('editing a policy changes later grants AND recalculates already-granted employees (feedback 49809272)', async () => {
    const b = await seedBase();
    const a = adminCtx(b);
    const { id: policyId } = await createLeavePolicy(a, {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 20,
      validFrom: '2026-01-01',
    });
    const pre = await hire(a, b, 'PreEdit', { annual: true });
    expect(await ledgerBalance(pre.employmentId, b.annualLeaveTypeId)).toBe(20);

    // Correct in place → a *later* hire grants on the new value, AND the earlier grant is re-projected:
    // a compensating adjustment moves the already-granted employee to the corrected number (feedback
    // 49809272 — this replaces the old "the earlier grant is history" behaviour).
    await updateLeavePolicy(a, { id: policyId, annualDays: 10, validFrom: '2026-01-01', asOf: '2026-06-30' });
    const mid = await hire(a, b, 'PostEdit', { annual: true });
    expect(await ledgerBalance(mid.employmentId, b.annualLeaveTypeId)).toBe(10); // max(floor 8, policy 10)
    expect(await ledgerBalance(pre.employmentId, b.annualLeaveTypeId)).toBe(10); // recalculated 20 → 10

    // Remove → the floor applies again (no recalc on delete: past grants stay untouched).
    await deleteLeavePolicy(a, { id: policyId });
    const post = await hire(a, b, 'PostDelete', { annual: true });
    expect(await ledgerBalance(post.employmentId, b.annualLeaveTypeId)).toBe(8); // floor only
    expect(await ledgerBalance(pre.employmentId, b.annualLeaveTypeId)).toBe(10); // delete leaves history alone
  });
});

describe('Leave year boundary — openLeaveYear', () => {
  it('grants at the CURRENT service band and forfeits unused annual by default', async () => {
    const b = await seedBase();
    const a = adminCtx(b);
    // Hired Jun 2023 → 2 completed years at 2026-01-01 → annual band steps 8 → 12.
    const { employmentId } = await hireEmployee(a, {
      person: { fullName: 'Bander', primaryEmail: 'bander@acme.test' },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2023-06-01',
      grantLeaveTypes: [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }],
    });
    expect(await ledgerBalance(employmentId, b.annualLeaveTypeId)).toBe(4.67); // 8 × 7/12 hire-year proration
    const res = await openLeaveYear(a, { year: 2026 });
    expect(res.granted).toBe(1);
    expect(res.forfeits).toBe(1);
    // Default carry 0 (s.60E): 4.67 forfeited; new grant 12 at the 2–5y band.
    expect(await ledgerBalance(employmentId, b.annualLeaveTypeId)).toBe(12);
  });

  it('carries unused annual up to the policy cap, on top of the new grant', async () => {
    const b = await seedBase();
    const a = adminCtx(b);
    await createLeavePolicy(a, {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 12,
      carryForwardMax: 5,
      validFrom: '2025-12-01',
    });
    const { employmentId } = await hireEmployee(a, {
      person: { fullName: 'Carrie', primaryEmail: 'carrie@acme.test' },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2025-01-01',
      grantLeaveTypes: [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }],
    });
    expect(await ledgerBalance(employmentId, b.annualLeaveTypeId)).toBe(8); // policy not yet active at hire
    const res = await openLeaveYear(a, { year: 2026 });
    expect(res.forfeits).toBe(1); // 8 unused → carry 5, forfeit 3
    // carry 5 + new grant max(floor 8 @1y, policy 12) = 17.
    expect(await ledgerBalance(employmentId, b.annualLeaveTypeId)).toBe(17);
  });

  it('is idempotent, and leaves in-year hires to their hire grant', async () => {
    const b = await seedBase();
    const a = adminCtx(b);
    const vet = await hireEmployee(a, {
      person: { fullName: 'Vetera', primaryEmail: 'vetera@acme.test' },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2025-03-01',
      grantLeaveTypes: [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }],
    });
    const jan = await hireEmployee(a, {
      person: { fullName: 'Janone', primaryEmail: 'janone@acme.test' },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
      grantLeaveTypes: [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }],
    });
    const first = await openLeaveYear(a, { year: 2026 });
    expect(first.granted).toBe(1); // only the 2025 hire; the Jan-1 hire is in-year
    const vetBalance = await ledgerBalance(vet.employmentId, b.annualLeaveTypeId);
    const second = await openLeaveYear(a, { year: 2026 });
    expect(second.granted).toBe(0);
    expect(second.skipped).toBe(1);
    expect(await ledgerBalance(vet.employmentId, b.annualLeaveTypeId)).toBe(vetBalance);
    expect(await ledgerBalance(jan.employmentId, b.annualLeaveTypeId)).toBe(8); // untouched hire grant
  });
});

describe('Attendance corrections — request → decide (ADR-0011 Phase B)', () => {
  const attRow = (employmentId: string, date: string) =>
    owner.db
      .select()
      .from(schema.attendance)
      .where(
        and(eq(schema.attendance.employmentId, employmentId), eq(schema.attendance.attendanceDate, date)),
      );

  it('approving a correction inserts the day and re-derives it through the time engine', async () => {
    const a = await entitledCtx(base);
    const { employmentId } = await hire(a, base, 'Misspunch');
    // No row exists for Wed 2026-06-03 (a workday). Propose a full 09:00→19:30 day.
    const { correctionId } = await requestAttendanceCorrection(a, {
      employmentId,
      date: '2026-06-03',
      checkIn: '09:00',
      checkOut: '19:30',
      reason: 'Forgot to clock in',
    });
    await decideAttendanceCorrection(a, { correctionId, decision: 'approved' });

    const [row] = await attRow(employmentId, '2026-06-03');
    expect(row.checkInAt).toBe('09:00:00');
    expect(row.checkOutAt).toBe('19:30:00');
    expect(row.dayType).toBe('workday');
    expect(row.status).toBe('present');
    expect(row.workedMinutes).toBe(570); // 10.5h span − 1h break
    expect(row.otMinutes).toBe(90); // beyond the 8h net day
    expect(row.remarks).toBe('Corrected');

    const evs = await eventTypesFor(base.tenantId, correctionId);
    expect(evs).toContain('attendance-correction.requested');
    expect(evs).toContain('attendance-correction.approved');
  });

  it('approving over an existing row amends it (re-derived OT), not duplicates', async () => {
    const a = await entitledCtx(base);
    const { employmentId } = await hire(a, base, 'Wrongout');
    // A genuine but wrong punch: left at 17:00, recorded as 7h, no OT.
    await checkIn(a, { employmentId, date: '2026-06-04', time: '09:00' });
    await checkOut(a, { employmentId, date: '2026-06-04', time: '17:00' });
    const [before] = await attRow(employmentId, '2026-06-04');
    expect(before.otMinutes).toBe(0);

    const { correctionId } = await requestAttendanceCorrection(a, {
      employmentId,
      date: '2026-06-04',
      checkIn: '09:00',
      checkOut: '19:00', // really stayed to 19:00
      reason: 'Correction',
    });
    await decideAttendanceCorrection(a, { correctionId, decision: 'approved' });

    const rows = await attRow(employmentId, '2026-06-04');
    expect(rows.length).toBe(1); // upsert, not a second row
    expect(rows[0].checkOutAt).toBe('19:00:00');
    expect(rows[0].workedMinutes).toBe(540); // 10h span − 1h break
    expect(rows[0].otMinutes).toBe(60); // 9h worked − 8h net day
  });

  it('the administrative manager may approve a report’s correction', async () => {
    const a = adminCtx(base);
    const E = await hire(a, base, 'Reportee');
    const M = await hire(a, base, 'Linemgr');
    const uM = await createAppUser(base.tenantId, M.personId, 'manager');
    await setReportingLine(a, {
      subordinateEmploymentId: E.employmentId,
      managerEmploymentId: M.employmentId,
      lineType: 'administrative',
      validFrom: '2026-01-01',
    });
    const { correctionId } = await requestAttendanceCorrection(a, {
      employmentId: E.employmentId,
      date: '2026-06-03',
      checkIn: '09:00',
      checkOut: '18:00',
      reason: 'Correction',
    });
    // ADR-0077 slice 3: a REAL manager session, so it must carry a REAL entitlement snapshot. The bare
    // literal was fine while every gate was an env read, but `decideAttendanceCorrection` now reaches
    // `maybeAutoAccrueOnApprovalTx`, whose first line asks `isModuleEnabled(ctx, 'toil')` — and a context
    // with neither a snapshot nor an exemption marker throws EntitlementsUnresolvedError there, before the
    // approval this test is asserting ever lands.
    //
    // `entitledCtx` resolves from THIS tenant's rows, so TOIL is off by ABSENCE (seedBase seeds only the
    // parity set and `toil` is not in it) — exactly the state the old `TOIL_ENABLED` read gave this file,
    // which never set that flag. Deliberately NOT `entitlementsExempt: 'harness'`: an exempt context answers
    // true for every catalogued module, which would switch TOIL auto-accrual on for this approval.
    const mgrCtx: SessionContext = {
      ...(await entitledCtx(base, ['manager'])),
      userId: uM,
      personId: M.personId,
    };
    await decideAttendanceCorrection(mgrCtx, { correctionId, decision: 'approved' });
    const [row] = await attRow(E.employmentId, '2026-06-03');
    expect(row.status).toBe('present');
  });

  it('an employee cannot approve their own correction', async () => {
    const a = adminCtx(base);
    const { employmentId, personId } = await hire(a, base, 'Selfapp');
    const uid = await createAppUser(base.tenantId, personId, 'employee');
    const { correctionId } = await requestAttendanceCorrection(a, {
      employmentId,
      date: '2026-06-03',
      checkIn: '09:00',
      checkOut: '18:00',
      reason: 'Correction',
    });
    // Entitled (not a bare literal) for the same reason as the manager-approval test above: this session
    // reaches `decideAttendanceCorrection`, which now asks an entitlement question on the approve path.
    // `assertCanDecide` refuses first, so the question is never reached here — but the assertion below is
    // an exact message match, so an EntitlementsUnresolvedError would surface as a failure rather than a
    // false pass either way. Resolving it keeps the refusal being proven the AUTHZ one.
    const selfCtx: SessionContext = {
      ...(await entitledCtx(base, ['employee'])),
      userId: uid,
      personId,
    };
    await expect(
      decideAttendanceCorrection(selfCtx, { correctionId, decision: 'approved' }),
    ).rejects.toThrow(/cannot decide your own/i);
  });

  it('rejecting leaves attendance untouched', async () => {
    const a = await entitledCtx(base);
    const { employmentId } = await hire(a, base, 'Rejectee');
    const { correctionId } = await requestAttendanceCorrection(a, {
      employmentId,
      date: '2026-06-03',
      checkIn: '09:00',
      checkOut: '18:00',
      reason: 'Correction',
    });
    await decideAttendanceCorrection(a, { correctionId, decision: 'rejected' });
    const rows = await attRow(employmentId, '2026-06-03');
    expect(rows.length).toBe(0); // no attendance row materialized — that is the proof reject is a no-op
    const evs = await eventTypesFor(base.tenantId, correctionId);
    expect(evs).toContain('attendance-correction.rejected');
  });
});

describe('ESS — profile self-service (ADR-0012)', () => {
  const empCtxFor = async (personId: string): Promise<SessionContext> => {
    const uid = await createAppUser(base.tenantId, personId, 'employee');
    return { tenantId: base.tenantId, userId: uid, personId, roles: ['employee'] };
  };

  it('an employee edits their own low-risk contact fields directly (RLS allows the self-write)', async () => {
    const a = adminCtx(base);
    const E = await hire(a, base, 'Contacter');
    const emp = await empCtxFor(E.personId);
    await updateOwnContact(emp, {
      phone: '0123456789',
      addressLine1: '12 Jalan Test',
      emergencyContactName: 'Next of Kin',
    });
    const [p] = await owner.db.select().from(schema.person).where(eq(schema.person.id, E.personId));
    expect(p.phone).toBe('0123456789');
    expect(p.addressLine1).toBe('12 Jalan Test');
    expect(p.emergencyContactName).toBe('Next of Kin');
  });

  it('#24: a date-of-birth / marital-status change applies to the person only after approval', async () => {
    const a = adminCtx(base);
    const E = await hire(a, base, 'Identity');
    const emp = await empCtxFor(E.personId);
    const { requestId } = await requestProfileChange(emp, {
      employmentId: E.employmentId,
      proposed: { dateOfBirth: '1985-05-20', maritalStatus: 'married', gender: 'female' },
    });
    // Pending — the compliance-sensitive identity fields are NOT applied until an admin approves.
    const [before] = await owner.db.select().from(schema.person).where(eq(schema.person.id, E.personId));
    expect(before.dateOfBirth).toBeNull();
    expect(before.maritalStatus).toBeNull();

    await decideProfileChange(a, { requestId, decision: 'approved' });
    const [after] = await owner.db.select().from(schema.person).where(eq(schema.person.id, E.personId));
    expect(after.dateOfBirth).toBe('1985-05-20');
    expect(after.maritalStatus).toBe('married');
    expect(after.gender).toBe('female');
  });

  it('a bank change applies to the statutory profile only after approval', async () => {
    const a = adminCtx(base);
    const E = await hire(a, base, 'Banker');
    await setStatutoryProfileMY(a, {
      personId: E.personId,
      icNumber: '900101010001',
      bankName: 'OldBank',
      bankAccountNo: '111122223333',
    });
    const emp = await empCtxFor(E.personId);
    const { requestId } = await requestProfileChange(emp, {
      employmentId: E.employmentId,
      proposed: { bankName: 'Maybank', bankAccountNo: '5566778899' },
    });
    // Pending — nothing changes until an admin approves.
    expect((await getStatutoryProfileMY(a, E.personId))?.bankAccountNo).toBe('111122223333');

    await decideProfileChange(a, { requestId, decision: 'approved' });
    const stat = await getStatutoryProfileMY(a, E.personId);
    expect(stat?.bankName).toBe('Maybank');
    expect(stat?.bankAccountNo).toBe('5566778899');

    // S1 (security): the append-only event log must NOT hold the cleartext account number —
    // it records changed-field NAMES only (PDPA / no-erasure on an immutable log).
    const events = await owner.db
      .select({ payload: schema.domainEvent.payload })
      .from(schema.domainEvent)
      .where(eq(schema.domainEvent.aggregateId, requestId));
    const dump = JSON.stringify(events);
    expect(dump).not.toContain('5566778899');
    expect(dump).toContain('bankAccountNo'); // the field name is audited
  });

  it('a bank change must carry both fields — partial updates are rejected at request time', async () => {
    const a = adminCtx(base);
    const E = await hire(a, base, 'Halfbank');
    const emp = await empCtxFor(E.personId);
    await expect(
      requestProfileChange(emp, { employmentId: E.employmentId, proposed: { bankAccountNo: '999' } }),
    ).rejects.toThrow(/both the bank name and the account number/i);
    await expect(
      requestProfileChange(emp, { employmentId: E.employmentId, proposed: { bankName: 'OnlyName' } }),
    ).rejects.toThrow(/both the bank name and the account number/i);
  });

  it('rejecting a change leaves the statutory profile untouched', async () => {
    const a = adminCtx(base);
    const E = await hire(a, base, 'Keeper');
    await setStatutoryProfileMY(a, {
      personId: E.personId,
      icNumber: '900101010002',
      bankAccountNo: '111122223333',
    });
    const emp = await empCtxFor(E.personId);
    const { requestId } = await requestProfileChange(emp, {
      employmentId: E.employmentId,
      proposed: { bankName: 'NoBank', bankAccountNo: '0000' },
    });
    await decideProfileChange(a, { requestId, decision: 'rejected' });
    expect((await getStatutoryProfileMY(a, E.personId))?.bankAccountNo).toBe('111122223333');
  });

  it('a manager may NOT approve a profile change — bank/tax is admin-only', async () => {
    const a = adminCtx(base);
    const E = await hire(a, base, 'Subord');
    await setStatutoryProfileMY(a, { personId: E.personId, icNumber: '900101010003' });
    const M = await hire(a, base, 'Boss');
    const uM = await createAppUser(base.tenantId, M.personId, 'manager');
    await setReportingLine(a, {
      subordinateEmploymentId: E.employmentId,
      managerEmploymentId: M.employmentId,
      lineType: 'administrative',
      validFrom: '2026-01-01',
    });
    const emp = await empCtxFor(E.personId);
    const { requestId } = await requestProfileChange(emp, {
      employmentId: E.employmentId,
      proposed: { numChildren: 2 },
    });
    const mgrCtx: SessionContext = {
      tenantId: base.tenantId,
      userId: uM,
      personId: M.personId,
      roles: ['manager'],
    };
    await expect(
      decideProfileChange(mgrCtx, { requestId, decision: 'approved' }),
    ).rejects.toThrow(/only an admin/i);
  });

  it('the requesting employee cannot approve their own change', async () => {
    const a = adminCtx(base);
    const E = await hire(a, base, 'Selfprofile');
    await setStatutoryProfileMY(a, { personId: E.personId, icNumber: '900101010004' });
    const emp = await empCtxFor(E.personId);
    const { requestId } = await requestProfileChange(emp, {
      employmentId: E.employmentId,
      proposed: { bankName: 'SelfBank', bankAccountNo: '1234' },
    });
    await expect(
      decideProfileChange(emp, { requestId, decision: 'approved' }),
    ).rejects.toThrow(/cannot decide your own/i);
  });
});

describe('ESS — payslip detail (ADR-0012 Phase 2)', () => {
  it('an employee reads their own payslip detail; a peer is RLS-denied', async () => {
    const b = await seedBase();
    const a = await entitledCtx(b);
    const E = await hire(a, b, 'Payee');
    await setCompensation(a, {
      employmentId: E.employmentId,
      basicSalary: 5000,
      monthlyAllowance: 0,
      effectiveFrom: '2026-01-01',
    });
    await setStatutoryProfileMY(a, { personId: E.personId, icNumber: '900101010010' });
    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });
    // f3148da1: ESS payslip reads are release-gated — a processed-but-never-released batch is invisible
    // to the employee. Close the batch (NULL release config ⇒ releasedAt = closedAt) before reading.
    await closeBatch(a, { batchId });
    const [slip] = await owner.db
      .select({ id: schema.payslip.id })
      .from(schema.payslip)
      .where(eq(schema.payslip.employmentId, E.employmentId));

    const uE = await createAppUser(b.tenantId, E.personId, 'employee');
    const empCtx: SessionContext = { tenantId: b.tenantId, userId: uE, personId: E.personId, roles: ['employee'] };
    const own = await payslipDetail(empCtx, slip.id);
    expect(own?.payPeriod).toBe('2026-05');
    expect(Number(own?.gross)).toBe(5000);
    expect(Number(own?.net)).toBeLessThan(5000); // statutory deducted

    // A peer with no visibility gets nothing back (RLS USING can_see_employment).
    const X = await hire(a, b, 'Nosey');
    const uX = await createAppUser(b.tenantId, X.personId, 'employee');
    const peerCtx: SessionContext = { tenantId: b.tenantId, userId: uX, personId: X.personId, roles: ['employee'] };
    expect(await payslipDetail(peerCtx, slip.id)).toBeNull();
  });
});

describe('Org catalog integrity — uniqueness + normalization (0030)', () => {
  it('normalizes whitespace and rejects duplicate department names, case-insensitively', async () => {
    const a = adminCtx(base);
    await createDepartment(a, { companyId: base.companyId, name: '  Quality   Assurance ' });
    const [d] = await owner.db
      .select()
      .from(schema.department)
      .where(eq(schema.department.name, 'Quality Assurance'));
    expect(d).toBeTruthy(); // collapsed + trimmed on write
    await expect(
      createDepartment(a, { companyId: base.companyId, name: 'quality assurance' }),
    ).rejects.toThrow(/already exists/i);
  });

  it('an archived department does not reserve its name; unarchiving into a clash errors', async () => {
    const a = adminCtx(base);
    const { id } = await createDepartment(a, { companyId: base.companyId, name: 'Lab' });
    await archiveDepartment(a, { id, archived: true });
    await createDepartment(a, { companyId: base.companyId, name: 'Lab' }); // name freed
    await expect(archiveDepartment(a, { id, archived: false })).rejects.toThrow(/already exists/i);
  });

  it('rejects duplicate cost-center codes per company', async () => {
    const a = adminCtx(base);
    await createCostCenter(a, { companyId: base.companyId, code: 'OPS', name: 'Operations' });
    await expect(
      createCostCenter(a, { companyId: base.companyId, code: ' ops ', name: 'Other' }),
    ).rejects.toThrow(/already exists/i);
  });

  it('uppercases company country/currency (holiday matching is raw equality) and rejects junk', async () => {
    const a = adminCtx(base);
    const { id } = await createCompany(a, { legalName: 'Iso Sdn Bhd', country: 'my', currency: ' myr ' });
    const [c] = await owner.db.select().from(schema.company).where(eq(schema.company.id, id));
    expect(c.country).toBe('MY');
    expect(c.currency).toBe('MYR');
    await expect(createCompany(a, { legalName: 'Bad Sdn Bhd', country: 'Malaysia' })).rejects.toThrow(/2 letters/);
  });
});

describe('Leave-type code integrity (0031)', () => {
  it('uppercases codes so the statutory floor applies; rejects duplicates and junk', async () => {
    const b = await seedBase(); // fresh tenant — only its own ANNUAL exists
    const a = adminCtx(b);
    const lt = await createLeaveType(a, { code: ' sick ', name: '  Sick   Leave ' });
    const [row] = await owner.db.select().from(schema.leaveType).where(eq(schema.leaveType.id, lt.id));
    expect(row.code).toBe('SICK');
    expect(row.name).toBe('Sick Leave');
    // The whole point: entitlement() matches exact uppercase codes, so the EA s.60F floor
    // (14 days, <2y service) now actually lands on hire instead of silently granting 0.
    const { employmentId } = await hireEmployee(a, {
      person: { fullName: 'Floor Check', primaryEmail: 'floor@acme.test' },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
      grantLeaveTypes: [{ id: lt.id, code: row.code }],
    });
    expect(await ledgerBalance(employmentId, lt.id)).toBe(14);
    await expect(createLeaveType(a, { code: 'sick', name: 'Dupe' })).rejects.toThrow(/already exists/i);
    await expect(createLeaveType(a, { code: 'sick!', name: 'Bad' })).rejects.toThrow(/letters/i);
  });
});

describe('PCB — LHDN 2026 computerised method, spec Exhibit 5 golden sequence', () => {
  // The spec's own worked example: married, spouse working, 3 children (Category 3),
  // RM5,500/month, EPF RM605/month; TP1 deductions in Mar/Apr; RM8,250 bonus in April.
  const profile = { category: 3 as const, children: 3 };

  it('January (no priors): P = 47,000.07 → MTD RM110.00', () => {
    const r = pcbMonth({ monthlyWage: 5500, epfMonthly: 605, month: 1, profile });
    expect(r.snapshot.P1).toBe(47000.07);
    expect(r.normal).toBe(110);
  });

  it('February (accumulators from January): P = 47,000.00 → MTD RM110.00', () => {
    const r = pcbMonth({
      monthlyWage: 5500,
      epfMonthly: 605,
      month: 2,
      profile,
      acc: { netRemuneration: 4895, epfClaimed: 605, pcbPaid: 110 },
    });
    expect(r.snapshot.P1).toBe(47000);
    expect(r.normal).toBe(110);
  });

  it('March (TP1 deductions RM300): P = 46,700.07 → MTD RM108.20', () => {
    const r = pcbMonth({
      monthlyWage: 5500,
      epfMonthly: 605,
      month: 3,
      profile,
      acc: { netRemuneration: 9790, epfClaimed: 1210, pcbPaid: 220 },
      lpCurrent: 300,
    });
    expect(r.snapshot.P1).toBe(46700.07);
    expect(r.normal).toBe(108.2);
  });

  it('April (bonus RM8,250): normal 106.20 + additional 727.50 = RM833.70', () => {
    const r = pcbMonth({
      monthlyWage: 5500,
      epfMonthly: 605,
      month: 4,
      profile,
      acc: { netRemuneration: 14685, epfClaimed: 1815, pcbPaid: 328.2, lpAccumulated: 300 },
      additional: 8250,
      epfOnAdditional: 908,
      lpCurrent: 300,
    });
    expect(r.snapshot.P1).toBe(46400);
    expect(r.snapshot.P2).toBe(54650);
    expect(r.normal).toBe(106.2);
    expect(r.additional).toBe(727.5);
    expect(r.total).toBe(833.7);
  });

  it('rounding rules: 5-sen round-up and the RM10 floor', () => {
    // A wage whose raw MTD lands between 5-sen steps must round UP (spec §E.2)…
    const r = pcbMonth({ monthlyWage: 5013, epfMonthly: Math.ceil(5013 * 0.11), month: 1 });
    expect(Math.round(r.normal * 100) % 5).toBe(0);
    // …and an MTD below RM10 is not deducted at all (spec §E.3).
    const tiny = pcbMonth({ monthlyWage: 3200, epfMonthly: Math.ceil(3200 * 0.11), month: 1 });
    expect(tiny.normal).toBe(0);
  });
});

describe('PCB accumulators through the payroll engine (ADR-0014)', () => {
  it('replays prior payslips: Jan and Feb batches both deduct the Exhibit-5 RM110.00', async () => {
    const b = await seedBase();
    const a = await entitledCtx(b);
    const e = await hire(a, b, 'Lhdn Example');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5500, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101015555', taxCategory: 3, numChildren: 3 });

    const jan = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-01' });
    await generatePayslips(a, { batchId: jan.batchId });
    const janSlip = (await batchDetail(a, jan.batchId))!.slips.find((s) => s.name === 'Lhdn Example')!;
    const janSt = janSlip.statutory as { pcb: number; pcbMeta: { ytdNet: number; pcbPaid: number } };
    expect(janSt.pcb).toBe(110);
    expect(janSt.pcbMeta.ytdNet).toBe(0);

    const feb = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-02' });
    await generatePayslips(a, { batchId: feb.batchId });
    const febSlip = (await batchDetail(a, feb.batchId))!.slips.find((s) => s.name === 'Lhdn Example')!;
    const febSt = febSlip.statutory as { pcb: number; pcbMeta: { ytdNet: number; epfClaimed: number; pcbPaid: number } };
    // The engine derived February's accumulators from January's payslip: ∑(Y−K)=4,895, K=605, X=110.
    expect(febSt.pcbMeta).toMatchObject({ ytdNet: 4895, epfClaimed: 605, pcbPaid: 110 });
    expect(febSt.pcb).toBe(110);
  });

  it('TP3 opening balances seed the accumulators for a mid-year first run', async () => {
    const b = await seedBase();
    const a = await entitledCtx(b);
    const e = await hire(a, b, 'Tp3 Joiner');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5500, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, {
      personId: e.personId,
      icNumber: '900101016666',
      taxCategory: 3,
      numChildren: 3,
      tp3Year: 2026,
      tp3NetRemuneration: 4895,
      tp3EpfClaimed: 605,
      tp3PcbPaid: 110,
    });
    // First batch we ever run is February — January lives only in the TP3 figures.
    const feb = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-02' });
    await generatePayslips(a, { batchId: feb.batchId });
    const slip = (await batchDetail(a, feb.batchId))!.slips.find((s) => s.name === 'Tp3 Joiner')!;
    const st = slip.statutory as { pcb: number; pcbMeta: { ytdNet: number } };
    expect(st.pcbMeta.ytdNet).toBe(4895);
    expect(st.pcb).toBe(110); // identical to the Exhibit-5 February figure
  });

  it('a TP3 record for a DIFFERENT year is ignored', async () => {
    const b = await seedBase();
    const a = await entitledCtx(b);
    const e = await hire(a, b, 'Stale Tp3');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5500, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, {
      personId: e.personId,
      icNumber: '900101017777',
      taxCategory: 3,
      numChildren: 3,
      tp3Year: 2025, // last year's openings must not leak into 2026
      tp3NetRemuneration: 50000,
      tp3EpfClaimed: 4000,
      tp3PcbPaid: 5000,
    });
    const jan = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-01' });
    await generatePayslips(a, { batchId: jan.batchId });
    const slip = (await batchDetail(a, jan.batchId))!.slips.find((s) => s.name === 'Stale Tp3')!;
    const st = slip.statutory as { pcb: number; pcbMeta: { ytdNet: number } };
    expect(st.pcbMeta.ytdNet).toBe(0);
    expect(st.pcb).toBe(110);
  });
});

describe('Payroll compliance round — zakat §E.5, Category 2, EIS rules, non-resident', () => {
  it('zakat offset reproduces the spec §E.5 tables verbatim', () => {
    // Table (i) — normal remuneration only (MTD, zakat → net):
    expect(applyZakatOffset(8, 0, 5).normal).toBe(0); // 8 < RM10 floor → 0, zakat carries
    expect(applyZakatOffset(15, 0, 20).normal).toBe(0); // 15 − 20 → 0
    expect(applyZakatOffset(15, 0, 8).normal).toBe(7); // 15 − 8
    expect(applyZakatOffset(120, 0, 100).normal).toBe(20);
    // Table (ii) — with additional remuneration (rows a–e, column f = c + e):
    expect(applyZakatOffset(8, 9, 5)).toEqual({ normal: 0, additional: 0 }); // both < RM10
    expect(applyZakatOffset(8, 25, 5)).toEqual({ normal: 0, additional: 20 }); // leftover 5 offsets bonus
    expect(applyZakatOffset(15, 32.55, 20)).toEqual({ normal: 0, additional: 27.55 });
    expect(applyZakatOffset(15, 127.3, 8)).toEqual({ normal: 7, additional: 127.3 });
    expect(applyZakatOffset(120, 392.25, 100)).toEqual({ normal: 20, additional: 392.25 });
  });

  it('SOCSO Second Category (60+) pays employer-only schedule amounts', () => {
    // Cat 2 = employer Injury-only + the SAME employee SKBBK leg as Cat 1 (60+/foreign pay SKBBK too).
    expect(socso(3000, 2)).toEqual({ employer: 36.9, employee: 0, skbbk: 22.15 }); // row 34 of the Act 4 PDF
    expect(socso(6000, 2)).toEqual({ employer: 74.4, employee: 0, skbbk: 44.65 }); // top band
    expect(socso(9000, 2)).toEqual({ employer: 74.4, employee: 0, skbbk: 44.65 }); // above ceiling → top band
    expect(socso(3000, 1).employee).toBeGreaterThan(0); // Category 1 unchanged
  });

  it('non-resident MTD is flat 30% (spec §D.a example: RM3,000 → RM900)', () => {
    const st = statutory(3000, { category: 1 }, 0, 0, undefined, { resident: false });
    expect(st.pcb).toBe(900);
    expect(statutory(3000, { category: 1 }).pcb).toBe(0); // resident at RM3,000: below threshold
  });

  it('engine: age 60+ flips SOCSO to Category 2 and stops EIS; eisEligible=false stops EIS', async () => {
    const b = await seedBase();
    const a = await entitledCtx(b);
    // Senior: DOB 1960 → 66 in 2026.
    const senior = await hire(a, b, 'Senior Sixty');
    await setCompensation(a, { employmentId: senior.employmentId, basicSalary: 3000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: senior.personId, icNumber: '600101015551' });
    await withTenant(a, (tx) =>
      tx.update(schema.person).set({ dateOfBirth: '1960-01-01' }).where(eq(schema.person.id, senior.personId)),
    );
    // Opted-out: eisEligible unticked (e.g. 57+, never contributed — Act 800 exemption).
    const opted = await hire(a, b, 'Opted Out');
    await setCompensation(a, { employmentId: opted.employmentId, basicSalary: 3000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: opted.personId, icNumber: '700101015552', eisEligible: false });

    const jan = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-01' });
    await generatePayslips(a, { batchId: jan.batchId });
    const slips = (await batchDetail(a, jan.batchId))!.slips;
    const seniorSt = slips.find((s) => s.name === 'Senior Sixty')!.statutory as Record<string, number>;
    expect(seniorSt.socsoEmployee).toBe(0); // Category 2: employer-only
    expect(seniorSt.socsoEmployer).toBe(36.9);
    expect(seniorSt.eisEmployee).toBe(0); // EIS coverage ends at 60
    expect(seniorSt.eisEmployer).toBe(0);
    const optedSt = slips.find((s) => s.name === 'Opted Out')!.statutory as Record<string, number>;
    expect(optedSt.eisEmployee).toBe(0);
    expect(optedSt.socsoEmployee).toBeGreaterThan(0); // SOCSO unaffected by the EIS flag
  });

  it('engine: TP1 deduction and zakat flow into PCB and accumulate for later months', async () => {
    const b = await seedBase();
    const a = await entitledCtx(b);
    const e = await hire(a, b, 'Tp1 Zakat');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5500, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101015553', taxCategory: 3, numChildren: 3 });

    // January with zakat RM30: Exhibit-5 January MTD is 110.00 → net deduction 80.00.
    const jan = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-01' });
    await setPayrollInput(a, { batchId: jan.batchId, employmentId: e.employmentId, overtimeAmount: 0, bonusAmount: 0, zakat: 30 });
    await generatePayslips(a, { batchId: jan.batchId });
    const janSt = (await batchDetail(a, jan.batchId))!.slips[0].statutory as Record<string, unknown>;
    expect(janSt.pcb).toBe(80); // 110 − 30 (§E.5)
    expect(janSt.zakat).toBe(30); // stamped for the replay

    // February: Z=30 and X=80 must reach the formula via the replay.
    const feb = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-02' });
    await generatePayslips(a, { batchId: feb.batchId });
    const febSt = (await batchDetail(a, feb.batchId))!.slips[0].statutory as {
      pcb: number;
      pcbMeta: { pcbPaid: number };
    };
    expect(febSt.pcbMeta.pcbPaid).toBe(80); // X = what was actually deducted
    // MTD Feb = [tax(P) − (Z + X)]/(n+1) = [1,320.0042 − (30 + 80)]/11 = 110.00 — self-consistent.
    expect(febSt.pcb).toBe(110);
  });
});

describe('CP39 text file — LHDN Exhibit 4 byte layout (Layer-B DRAFT)', () => {
  it('reproduces the Exhibit-5 sample detail line byte-for-byte', () => {
    const f = buildCp39File({
      employerNo: '0291212306',
      year: 2002,
      month: 5,
      rows: [
        {
          tin: '531367080',
          name: 'ABDUL HANIFAH MOHD ARIF',
          oldIc: 'A4457334',
          newIc: '530706015461',
          mtd: 900,
          employeeNo: 'AB012283',
        },
      ],
    });
    const lines = f.content.split('\r\n');
    const detail = lines[1];
    const expected =
      'D' +
      '00531367080' +
      'ABDUL HANIFAH MOHD ARIF'.padEnd(60, ' ') +
      'A4457334'.padEnd(12, ' ') +
      '530706015461' +
      ' '.repeat(12) + // passport
      '  ' + // country
      '00090000' + // RM900.00 in cents
      '00000000' +
      'AB012283'.padEnd(10, ' ');
    expect(detail.length).toBe(136);
    expect(detail).toBe(expected);
    // Position spot-checks straight from the Exhibit-4 table (1-indexed → slice).
    expect(detail.slice(1, 12)).toBe('00531367080'); // TIN 2–12
    expect(detail.slice(110, 118)).toBe('00090000'); // MTD 111–118
  });

  it('builds the 57-char header with totals in cents and the spec filename', () => {
    const f = buildCp39File({
      employerNo: '0291212306',
      year: 2002,
      month: 5,
      rows: [
        { tin: '1', name: 'A', mtd: 5000, cp38: 1000.5 },
        { tin: '2', name: 'B', mtd: 3350, cp38: 500 },
        { tin: '3', name: 'C', mtd: 0 },
      ],
    });
    const header = f.content.split('\r\n')[0];
    expect(header.length).toBe(57);
    expect(header).toBe('H' + '0291212306' + '0291212306' + '2002' + '05' + '0000835000' + '00002' + '0000150050' + '00002');
    expect(f.filename).toBe('029121230605_2002.txt');
    // zero-MTD rows are listed but not counted as MTD records (header field 7 tallies payers).
    expect(f.totals.mtdRecords).toBe(2);
  });

  it('normalizes employer E-numbers per the Exhibit-5 examples', () => {
    expect(normalizeEmployerNo('E 908915-10')).toBe('0090891510');
    expect(normalizeEmployerNo('E 90002135-00')).toBe('9000213500');
  });

  it('refuses to emit without a mandatory TIN', () => {
    expect(() =>
      buildCp39File({ employerNo: '1', year: 2026, month: 1, rows: [{ tin: '', name: 'No Tin', mtd: 10 }] }),
    ).toThrow(/TIN is mandatory/i);
  });

  it('builds from a generated batch and gates on readiness (TIN, E-number)', async () => {
    const b = await seedBase();
    const a = await entitledCtx(b);
    const e = await hire(a, b, 'Cp39 Earner');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5500, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101018888', taxCategory: 3, numChildren: 3 });
    const jan = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-01' });
    await generatePayslips(a, { batchId: jan.batchId });

    // No company E-number yet → readiness gate refuses.
    await expect(cp39FileForBatch(a, { companyId: b.companyId, periodKey: '2026-01' })).rejects.toThrow(
      Cp39NotReadyError,
    );
    await setCompanyStatutoryMY(a, { companyId: b.companyId, lhdnEmployerNo: 'E 908915-10' });

    // Employee has no TIN yet → named in the refusal.
    await expect(cp39FileForBatch(a, { companyId: b.companyId, periodKey: '2026-01' })).rejects.toThrow(
      /Cp39 Earner/,
    );
    await setStatutoryProfileMY(a, {
      personId: e.personId,
      icNumber: '900101018888',
      taxCategory: 3,
      numChildren: 3,
      taxNumber: 'IG 531367080',
    });

    const f = await cp39FileForBatch(a, { companyId: b.companyId, periodKey: '2026-01' });
    const [header, detail] = f.content.split('\r\n');
    expect(header.slice(0, 11)).toBe('H0090891510');
    expect(header.slice(27, 37)).toBe('0000011000'); // total MTD = RM110.00 (Exhibit-5 wage)
    expect(detail.slice(1, 12)).toBe('00531367080');
    expect(detail.slice(110, 118)).toBe('00011000'); // RM110.00
    expect(f.filename).toBe('009089151001_2026.txt');
  });
});

describe('UC — CSV employee import', () => {
  const csvFor = (rows: string) =>
    parseCsvRecords(
      'full_name,email,department,hired_on,ic_number,basic_salary,monthly_allowance,bank_name,bank_account_no,tax_category\n' +
        rows,
    ).records;

  it('validates rows against the catalog and flags every kind of bad row', async () => {
    const a = adminCtx(base);
    const records = csvFor(
      [
        'Aisyah Rahman,aisyah@acme.test,Finance,2026-06-01,900101011234,5200,400,Maybank,5566778899,2',
        'Bad Email,not-an-email,Finance,2026-06-01,910101012345,5000,0,,,1',
        'Bad IC,badic@acme.test,Finance,2026-06-01,12345,5000,0,,,1',
        'Unknown Dept,dept@acme.test,Marketing,2026-06-01,920101013456,5000,0,,,1',
        'No Salary,nosalary@acme.test,Finance,2026-06-01,930101014567,,0,,,1',
        'Dup IC,dupic@acme.test,Finance,2026-06-01,900101011234,5000,0,,,1',
        'Half Bank,halfbank@acme.test,Finance,2026-06-01,940101015678,5000,0,Maybank,,1',
      ].join('\n'),
    );
    const preview = await validateEmployeeImport(a, { companyId: base.companyId, records });
    expect(preview.total).toBe(7);
    expect(preview.validCount).toBe(1);
    expect(preview.rows[0].ok).toBe(true);
    expect(preview.rows[1].errors.join()).toMatch(/email/i);
    expect(preview.rows[2].errors.join()).toMatch(/IC/i);
    expect(preview.rows[3].errors.join()).toMatch(/department/i);
    expect(preview.rows[4].errors.join()).toMatch(/salary/i);
    expect(preview.rows[5].errors.join()).toMatch(/duplicate ic/i);
    expect(preview.rows[6].errors.join()).toMatch(/bank/i);
  });

  it('commits valid rows (hire + statutory + comp), skips invalid, and logs a batch event', async () => {
    const a = adminCtx(base);
    const before = (await listEmployees(a)).length;
    const records = csvFor(
      [
        'Nadia Yusof,nadia@acme.test,Finance,2026-06-01,910505051234,5200,400,Maybank,5566778899,2',
        'Ravi Chandran,ravi@acme.test,Operations,2026-06-01,880808082345,9800,600,CIMB,1122334455,3',
        'Broken,not-an-email,Finance,2026-06-01,950909093456,4100,0,,,1',
      ].join('\n'),
    );
    const result = await commitEmployeeImport(a, { companyId: base.companyId, records });
    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.failed).toHaveLength(0);

    const after = await listEmployees(a);
    expect(after.length).toBe(before + 2);
    const nadia = after.find((e) => e.email === 'nadia@acme.test');
    expect(nadia).toBeTruthy();

    // An imported employee is indistinguishable from a hand hire: statutory profile + compensation.
    const [pRow] = await owner.db
      .select({ id: schema.person.id })
      .from(schema.person)
      .where(eq(schema.person.primaryEmail, 'nadia@acme.test'));
    const stat = await getStatutoryProfileMY(a, pRow.id);
    expect(stat?.icNumber).toBe('910505051234');
    const comp = await currentCompensation(a, nadia!.employmentId);
    expect(Number(comp?.basicSalary)).toBe(5200);

    // Per-employee events exist, plus the batch event on the company aggregate.
    const empEvents = await eventTypesFor(base.tenantId, nadia!.employmentId);
    expect(empEvents).toContain('employment.hired');
    const companyEvents = await eventTypesFor(base.tenantId, base.companyId);
    expect(companyEvents).toContain('employee-import.completed');
  });

  it('rejects an IC that already exists in the tenant', async () => {
    const a = adminCtx(base);
    const first = csvFor('First In,first@acme.test,Finance,2026-06-01,960606061234,5000,0,,,1');
    await commitEmployeeImport(a, { companyId: base.companyId, records: first });
    const dup = csvFor('Second Same IC,second@acme.test,Finance,2026-06-01,960606061234,5000,0,,,1');
    const preview = await validateEmployeeImport(a, { companyId: base.companyId, records: dup });
    expect(preview.validCount).toBe(0);
    expect(preview.rows[0].errors.join()).toMatch(/already exists/i);
  });
});

describe('UC — payment summary export', () => {
  it('exports a processed batch as CSV with bank + net pay, and logs the export', async () => {
    const a = await entitledCtx(base);
    const { employmentId, personId } = await hire(a, base, 'Payee');
    await setCompensation(a, { employmentId, basicSalary: 4000, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, {
      personId,
      icNumber: '900101011234',
      bankName: 'Maybank',
      bankAccountNo: '5566778899',
    });
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });

    const file = await paymentSummaryForBatch(a, batchId);
    expect(file.payeeCount).toBe(1);
    expect(file.missingBank).toBe(0);
    expect(file.filename).toMatch(/payment-summary_.*_2026-05\.csv/);
    const lines = file.content.trim().split('\r\n');
    // Item ef720d3a added Payment Holder Name / Payment Holder ID columns (custom-holder payee resolution).
    // R46 79eb7151 appended Payment Method strictly LAST, so every pre-existing column — including Net Pay —
    // keeps its index and any positional parser of this file is unaffected. This employee has no method set,
    // so the cell is empty, exactly as the file behaved before the column existed.
    expect(lines[0]).toBe(
      'No,Employee,Employee Code,IC,Payment Holder Name,Payment Holder ID,Bank,Account No,Net Pay (RM),Payment Method',
    );
    expect(lines[1]).toContain('Payee');
    expect(lines[1]).toContain('Maybank');
    expect(lines[1]).toContain('5566778899');
    // The row's net equals the recorded batch total to the cent. Read Net Pay by its HEADER index, not by
    // "the last cell": R46 79eb7151 appended Payment Method after it, so last-position is no longer net pay.
    const netIdx = lines[0].split(',').indexOf('Net Pay (RM)');
    const net = Number(lines[1].split(',')[netIdx]);
    expect(Math.round(net * 100)).toBe(file.netTotalCents);

    expect(await eventTypesFor(base.tenantId, batchId)).toContain('payroll-batch.payment-summary.exported');
  });

  it('refuses to export a draft batch (no payslips yet)', async () => {
    const a = adminCtx(base);
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-06' });
    await expect(paymentSummaryForBatch(a, batchId)).rejects.toBeInstanceOf(PaymentSummaryNotReadyError);
  });

  it('still exports an employee with no bank details, flagging the gap', async () => {
    const a = await entitledCtx(base);
    const { employmentId } = await hire(a, base, 'NoBank');
    await setCompensation(a, { employmentId, basicSalary: 3500, effectiveFrom: '2026-01-01' });
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-08' });
    await generatePayslips(a, { batchId });
    const file = await paymentSummaryForBatch(a, batchId);
    expect(file.payeeCount).toBe(1);
    expect(file.missingBank).toBe(1);
  });
});

describe('UC — employee list pagination + search', () => {
  it('paginates by name and searches name/email', async () => {
    const a = adminCtx(base);
    for (const n of ['Alice', 'Bob', 'Carol', 'Dave', 'Eve']) await hire(a, base, n);

    const p1 = await listEmployeesPage(a, { limit: 2, offset: 0 });
    expect(p1.total).toBe(5);
    expect(p1.rows.map((r) => r.name)).toEqual(['Alice', 'Bob']); // ordered by name

    const last = await listEmployeesPage(a, { limit: 2, offset: 4 });
    expect(last.rows.map((r) => r.name)).toEqual(['Eve']);

    const byName = await listEmployeesPage(a, { q: 'carol', limit: 25, offset: 0 });
    expect(byName.total).toBe(1);
    expect(byName.rows[0].name).toBe('Carol');

    const byEmail = await listEmployeesPage(a, { q: 'dave@', limit: 25, offset: 0 });
    expect(byEmail.total).toBe(1);
    expect(byEmail.rows[0].name).toBe('Dave');
  });
});

describe('UC — performance: state machine, authz, pay seam', () => {
  // Employee E reports to manager M; returns sessions + the spawned review id for E.
  //
  // `entitledCtx`, not `adminCtx`: one test in this block ('enact is ATOMIC') drives `generatePayslips`
  // through this session to make a batch non-draft, and an exempt context would run that through the
  // TYPED-component kernel (see the file header). Nothing else here is gated — performance and payroll
  // are both in seedBase's parity set — so this is otherwise the same admin session as before.
  async function setupCycle(opts?: { merit?: boolean }) {
    const a = await entitledCtx(base);
    const E = await hire(a, base, 'PerfEmp');
    const M = await hire(a, base, 'PerfMgr');
    await setCompensation(a, { employmentId: E.employmentId, basicSalary: 5000, effectiveFrom: '2026-01-01' });
    const uE = await createAppUser(base.tenantId, E.personId, 'employee');
    const uM = await createAppUser(base.tenantId, M.personId, 'manager');
    await setReportingLine(a, {
      subordinateEmploymentId: E.employmentId,
      managerEmploymentId: M.employmentId,
      lineType: 'administrative',
      validFrom: '2026-01-01',
    });
    const eCtx: SessionContext = { tenantId: base.tenantId, userId: uE, roles: ['employee'], personId: E.personId };
    const mCtx: SessionContext = { tenantId: base.tenantId, userId: uM, roles: ['manager'], personId: M.personId };
    const { cycleId } = await createCycle(a, { name: '2026 Annual', periodStart: '2026-01-01', periodEnd: '2026-12-31' });
    await openCycle(a, { cycleId });
    const [review] = await owner.db
      .select()
      .from(schema.performanceReview)
      .where(eq(schema.performanceReview.employmentId, E.employmentId));
    return { a, E, M, eCtx, mCtx, cycleId, reviewId: review.id };
  }

  it('walks self → manager → release → acknowledge, with an event per transition', async () => {
    const { a, eCtx, mCtx, cycleId, reviewId, E } = await setupCycle();
    // reviewer was resolved to the administrative manager at open
    const [spawned] = await owner.db
      .select()
      .from(schema.performanceReview)
      .where(eq(schema.performanceReview.id, reviewId));
    expect(spawned.status).toBe('self_review');
    expect(spawned.reviewerEmploymentId).not.toBeNull();

    await submitSelfReview(eCtx, { reviewId, selfRating: 3, selfComments: 'solid year' });
    await submitManagerReview(mCtx, { reviewId, managerRating: 4, overallRating: 4, managerComments: 'strong' });
    let [r] = await owner.db.select().from(schema.performanceReview).where(eq(schema.performanceReview.id, reviewId));
    expect(r.status).toBe('submitted');
    expect(r.overallRating).toBe(4);

    // employee cannot acknowledge before the cycle is released
    await expect(acknowledgeReview(eCtx, { reviewId })).rejects.toBeInstanceOf(PerfError);
    await releaseCycle(a, { cycleId });
    await acknowledgeReview(eCtx, { reviewId });
    [r] = await owner.db.select().from(schema.performanceReview).where(eq(schema.performanceReview.id, reviewId));
    expect(r.status).toBe('acknowledged');

    const evs = await eventTypesFor(base.tenantId, reviewId);
    expect(evs).toEqual(
      expect.arrayContaining([
        'performance-review.self-submitted',
        'performance-review.manager-submitted',
        'performance-review.acknowledged',
      ]),
    );
    const cycleEvs = await eventTypesFor(base.tenantId, cycleId);
    expect(cycleEvs).toEqual(expect.arrayContaining(['review-cycle.opened', 'review-cycle.released']));
    expect(E).toBeTruthy();
  });

  it('enacts a merit recommendation as an effective-dated raise (never writes pay itself)', async () => {
    const { a, E, eCtx, mCtx, reviewId } = await setupCycle();
    await submitSelfReview(eCtx, { reviewId, selfRating: 4 });
    await submitManagerReview(mCtx, {
      reviewId,
      managerRating: 5,
      overallRating: 5,
      recommendedMeritPct: 10,
    });
    let [r] = await owner.db.select().from(schema.performanceReview).where(eq(schema.performanceReview.id, reviewId));
    expect(r.compActionStatus).toBe('recommended');

    await enactCompAction(a, { reviewId, meritEffectiveFrom: '2027-01-01' });
    const comp = await currentCompensation(a, E.employmentId);
    expect(Number(comp?.basicSalary)).toBe(5500); // 5000 + 10%
    [r] = await owner.db.select().from(schema.performanceReview).where(eq(schema.performanceReview.id, reviewId));
    expect(r.compActionStatus).toBe('enacted');
    expect(r.enactedCompensationId).not.toBeNull();
    expect(await eventTypesFor(base.tenantId, reviewId)).toContain('performance-review.comp-enacted');
  });

  it('enacts a bonus into a draft batch, preserving overtime already keyed', async () => {
    const { a, E, eCtx, mCtx, reviewId } = await setupCycle();
    await submitSelfReview(eCtx, { reviewId, selfRating: 3 });
    await submitManagerReview(mCtx, { reviewId, managerRating: 4, overallRating: 4, recommendedBonus: 2000 });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-12' });
    await setPayrollInput(a, { batchId, employmentId: E.employmentId, overtimeAmount: 150 }); // pre-existing OT
    await enactCompAction(a, { reviewId, bonusBatchId: batchId });

    const [pi] = await owner.db
      .select()
      .from(schema.payrollInput)
      .where(
        and(
          eq(schema.payrollInput.batchId, batchId),
          eq(schema.payrollInput.employmentId, E.employmentId),
        ),
      );
    expect(Number(pi.bonusAmount)).toBe(2000);
    expect(Number(pi.overtimeAmount)).toBe(150); // overtime preserved, not clobbered
    const [r] = await owner.db.select().from(schema.performanceReview).where(eq(schema.performanceReview.id, reviewId));
    expect(r.enactedBatchId).toBe(batchId);
  });

  it('enforces authz: employee cannot manager-review; manager cannot self-review the report', async () => {
    const { eCtx, mCtx, reviewId } = await setupCycle();
    // employee tries to act as manager → assertCanDecide rejects (not the manager / admin)
    await expect(
      submitManagerReview(eCtx, { reviewId, managerRating: 5, overallRating: 5 }),
    ).rejects.toThrow();
    // manager tries to submit the employee's self-review → only the subject (or admin) may
    await expect(submitSelfReview(mCtx, { reviewId, selfRating: 5 })).rejects.toBeInstanceOf(PerfError);
  });

  it('rejects a rating outside the cycle scale and guards transition order', async () => {
    const { a, eCtx, mCtx, cycleId, reviewId } = await setupCycle();
    await expect(submitSelfReview(eCtx, { reviewId, selfRating: 9 })).rejects.toBeInstanceOf(PerfError);
    await submitSelfReview(eCtx, { reviewId, selfRating: 3 });
    // self-review cannot be submitted twice (status moved on)
    await expect(submitSelfReview(eCtx, { reviewId, selfRating: 2 })).rejects.toBeInstanceOf(PerfError);
    // a draft-less cycle cannot be re-opened
    await expect(openCycle(a, { cycleId })).rejects.toBeInstanceOf(PerfError);
  });

  it('cannot enact before finalize, and a declined recommendation does not touch pay', async () => {
    const { a, eCtx, mCtx, reviewId } = await setupCycle();
    // nothing recommended / not finalized → enact rejected
    await expect(enactCompAction(a, { reviewId })).rejects.toBeInstanceOf(PerfError);
    await submitSelfReview(eCtx, { reviewId, selfRating: 3 });
    await submitManagerReview(mCtx, { reviewId, managerRating: 3, overallRating: 3, recommendedBonus: 1000 });
    await declineCompAction(a, { reviewId });
    const [r] = await owner.db.select().from(schema.performanceReview).where(eq(schema.performanceReview.id, reviewId));
    expect(r.compActionStatus).toBe('declined');
    await expect(enactCompAction(a, { reviewId })).rejects.toBeInstanceOf(PerfError);
  });

  it('release gate: employee sees the manager rating only after release, never the recommendation', async () => {
    const { a, eCtx, mCtx, cycleId, reviewId } = await setupCycle();
    await submitSelfReview(eCtx, { reviewId, selfRating: 3 });
    await submitManagerReview(mCtx, { reviewId, managerRating: 4, overallRating: 4, recommendedMeritPct: 5 });

    // Before release: the employee's view withholds the manager rating and the comp recommendation.
    const before = await reviewForViewer(eCtx, reviewId);
    expect(before?.overallRating).toBeNull();
    expect(before?.managerRating).toBeNull();
    expect(before?.recommendedMeritPct).toBeNull();
    expect(before?.canManage).toBe(false);
    // The manager's view sees everything.
    const mgrView = await reviewForViewer(mCtx, reviewId);
    expect(mgrView?.overallRating).toBe(4);
    expect(mgrView?.recommendedMeritPct).toBe(5);

    await releaseCycle(a, { cycleId });
    // After release: the employee sees the overall rating, but the comp recommendation stays hidden.
    const after = await reviewForViewer(eCtx, reviewId);
    expect(after?.overallRating).toBe(4);
    expect(after?.recommendedMeritPct).toBeNull();
    expect(after?.canAcknowledge).toBe(true);
  });

  it('membership snapshot excludes late hires past the cutoff', async () => {
    const a = adminCtx(base);
    const early = await hire(a, base, 'Early'); // hired 2026-01-01 (hire helper default)
    const late = await hireEmployee(a, {
      person: { fullName: 'Late Joiner', primaryEmail: 'late@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-09-01',
    });
    const { cycleId } = await createCycle(a, {
      name: '2026 Mid',
      periodStart: '2026-01-01',
      periodEnd: '2026-12-31',
      eligibilityRules: { hiredBefore: '2026-06-30' },
    });
    await openCycle(a, { cycleId });
    const reviews = await owner.db
      .select({ employmentId: schema.performanceReview.employmentId })
      .from(schema.performanceReview)
      .where(eq(schema.performanceReview.cycleId, cycleId));
    const ids = reviews.map((r) => r.employmentId);
    expect(ids).toContain(early.employmentId);
    expect(ids).not.toContain(late.employmentId);
  });

  // ── Hardening: fixes for the multi-agent adversarial findings ──

  it('enact is ATOMIC: a failing bonus leg rolls back the merit raise (no orphaned pay)', async () => {
    const { a, E, eCtx, mCtx, reviewId } = await setupCycle(); // E has comp 5000
    await submitSelfReview(eCtx, { reviewId, selfRating: 3 });
    await submitManagerReview(mCtx, {
      reviewId,
      managerRating: 4,
      overallRating: 4,
      recommendedMeritPct: 10,
      recommendedBonus: 2000,
    });
    // Make the bonus leg fail: target a PROCESSED (non-draft) batch. Scoped to E because the manager
    // has no compensation row and f1564110 Phase 1 now hard-blocks generation on that (previously the
    // comp-less manager was just silently dropped from the run).
    const { batchId } = await createBatch(a, {
      companyId: base.companyId,
      payPeriod: '2026-11',
      scope: { employmentIds: [E.employmentId] },
    });
    await generatePayslips(a, { batchId }); // → processed
    await expect(
      enactCompAction(a, { reviewId, meritEffectiveFrom: '2027-01-01', bonusBatchId: batchId }),
    ).rejects.toThrow();
    // The merit must NOT have been applied, and the review must still read 'recommended'.
    const comp = await currentCompensation(a, E.employmentId);
    expect(Number(comp?.basicSalary)).toBe(5000);
    const [r] = await owner.db.select().from(schema.performanceReview).where(eq(schema.performanceReview.id, reviewId));
    expect(r.compActionStatus).toBe('recommended');
    expect(r.enactedCompensationId).toBeNull();
  });

  it('refuses to enact pay for a terminated employee', async () => {
    const { a, E, eCtx, mCtx, reviewId } = await setupCycle();
    await submitSelfReview(eCtx, { reviewId, selfRating: 3 });
    await submitManagerReview(mCtx, { reviewId, managerRating: 4, overallRating: 4, recommendedMeritPct: 5 });
    await owner.db
      .update(schema.employment)
      .set({ terminatedOn: '2026-06-01' })
      .where(eq(schema.employment.id, E.employmentId));
    await expect(enactCompAction(a, { reviewId, meritEffectiveFrom: '2027-01-01' })).rejects.toBeInstanceOf(PerfError);
  });

  it('rejects a backdated merit effective date that would invert the pay range', async () => {
    const { a, eCtx, mCtx, reviewId } = await setupCycle(); // comp starts 2026-01-01
    await submitSelfReview(eCtx, { reviewId, selfRating: 3 });
    await submitManagerReview(mCtx, { reviewId, managerRating: 4, overallRating: 4, recommendedMeritPct: 5 });
    await expect(enactCompAction(a, { reviewId, meritEffectiveFrom: '2025-01-01' })).rejects.toBeInstanceOf(PerfError);
  });

  it('reassignReviewer rejects the subject themselves and a terminated reviewer', async () => {
    const { a, E, M, reviewId } = await setupCycle();
    // pointing the reviewer at the subject is the self-review ban via the side door
    await expect(reassignReviewer(a, { reviewId, reviewerEmploymentId: E.employmentId })).rejects.toBeInstanceOf(PerfError);
    await owner.db.update(schema.employment).set({ terminatedOn: '2026-06-01' }).where(eq(schema.employment.id, M.employmentId));
    await expect(reassignReviewer(a, { reviewId, reviewerEmploymentId: M.employmentId })).rejects.toBeInstanceOf(PerfError);
  });

  it('a closed/calibration cycle freezes self & manager submissions', async () => {
    const { a, eCtx, mCtx, cycleId, reviewId } = await setupCycle();
    await moveCycleToCalibration(a, { cycleId });
    await expect(submitSelfReview(eCtx, { reviewId, selfRating: 3 })).rejects.toBeInstanceOf(PerfError);
    await expect(
      submitManagerReview(mCtx, { reviewId, managerRating: 4, overallRating: 4 }),
    ).rejects.toBeInstanceOf(PerfError);
    await closeCycle(a, { cycleId });
    await expect(submitSelfReview(eCtx, { reviewId, selfRating: 3 })).rejects.toBeInstanceOf(PerfError);
  });

  it('does not leak ratings or comp amounts into the tenant-wide event log', async () => {
    const { eCtx, mCtx, reviewId } = await setupCycle();
    await submitSelfReview(eCtx, { reviewId, selfRating: 3 });
    await submitManagerReview(mCtx, { reviewId, managerRating: 4, overallRating: 4, recommendedMeritPct: 7, recommendedBonus: 1500 });
    const events = await owner.db
      .select({ payload: schema.domainEvent.payload })
      .from(schema.domainEvent)
      .where(eq(schema.domainEvent.aggregateId, reviewId));
    const blob = JSON.stringify(events.map((e) => e.payload));
    // no rating value (3/4), no merit %, no bonus amount in any payload
    expect(blob).not.toMatch(/"(selfRating|managerRating|overallRating|meritPct|bonus)"/);
    expect(blob).not.toContain('1500');
    expect(blob).not.toContain('"7"');
  });

  it('budget "consumed" reflects the true raise, not the post-enact (inflated) salary', async () => {
    const { a, eCtx, mCtx, cycleId, reviewId } = await setupCycle(); // E basic 5000
    await submitSelfReview(eCtx, { reviewId, selfRating: 3 });
    await submitManagerReview(mCtx, { reviewId, managerRating: 4, overallRating: 4, recommendedMeritPct: 10 });
    const beforeEnact = await cycleDetail(a, cycleId);
    await enactCompAction(a, { reviewId, meritEffectiveFrom: '2027-01-01' }); // 5000 → 5500
    const afterEnact = await cycleDetail(a, cycleId);
    // 10% of 5000 = 500/month, both before and after enactment (no drift onto the raised 5500).
    expect(beforeEnact?.budget.consumed).toBe(500);
    expect(afterEnact?.budget.consumed).toBe(500);
  });

  it('a manager can find reviews still in self_review (no-stall path is discoverable)', async () => {
    const { mCtx, E } = await setupCycle(); // E reports to M; E's review is at self_review
    const pending = await managerPendingReviews(mCtx);
    expect(pending.some((r) => r.status === 'self_review')).toBe(true);
    expect(E).toBeTruthy();
  });
});

describe('UC — domain_event subject-scoped privacy (ADR-0015)', () => {
  const eventsFor = (ctx: SessionContext, employmentId: string) =>
    withTenant(ctx, (tx) =>
      tx.select().from(schema.domainEvent).where(eq(schema.domainEvent.subjectEmploymentId, employmentId)),
    );

  it('an employee cannot read a peer’s events, sees their own, and admins see all', async () => {
    const a = adminCtx(base);
    const A = await hire(a, base, 'Alpha');
    const B = await hire(a, base, 'Bravo'); // an unrelated peer (no reporting line)
    await setCompensation(a, { employmentId: B.employmentId, basicSalary: 7000, effectiveFrom: '2026-01-01' });
    const uA = await createAppUser(base.tenantId, A.personId, 'employee');
    const aCtx: SessionContext = { tenantId: base.tenantId, userId: uA, roles: ['employee'], personId: A.personId };

    // Peer isolation: Alpha cannot see any of Bravo's events (hire, compensation).
    expect(await eventsFor(aCtx, B.employmentId)).toHaveLength(0);
    // Own visibility: Alpha sees their own events.
    expect((await eventsFor(aCtx, A.employmentId)).length).toBeGreaterThan(0);
    // Admin sees Bravo's events (the audit ledger is unchanged for admins).
    expect((await eventsFor(a, B.employmentId)).length).toBeGreaterThan(0);
  });

  it('a manager sees a report’s events; config events with no subject are admin-only', async () => {
    const a = adminCtx(base);
    const E = await hire(a, base, 'Report');
    const M = await hire(a, base, 'Boss');
    const uM = await createAppUser(base.tenantId, M.personId, 'manager');
    await setReportingLine(a, {
      subordinateEmploymentId: E.employmentId,
      managerEmploymentId: M.employmentId,
      lineType: 'administrative',
      validFrom: '2026-01-01',
    });
    await createLeavePolicy(a, { leaveTypeId: base.annualLeaveTypeId, annualDays: 14, validFrom: '2026-01-01' });
    const mCtx: SessionContext = { tenantId: base.tenantId, userId: uM, roles: ['manager'], personId: M.personId };

    // The manager sees their report's events…
    expect((await eventsFor(mCtx, E.employmentId)).length).toBeGreaterThan(0);
    // …but not the tenant-wide leave-policy event (no subject → admin-only, fail-closed).
    const mgrSeesPolicy = await withTenant(mCtx, (tx) =>
      tx.select().from(schema.domainEvent).where(eq(schema.domainEvent.aggregateType, 'leave-policy')),
    );
    expect(mgrSeesPolicy).toHaveLength(0);
    // Admin does see it.
    const adminSeesPolicy = await withTenant(a, (tx) =>
      tx.select().from(schema.domainEvent).where(eq(schema.domainEvent.aggregateType, 'leave-policy')),
    );
    expect(adminSeesPolicy.length).toBeGreaterThan(0);
  });

  it('tenant isolation holds: another tenant’s admin sees none of this tenant’s events', async () => {
    const a = adminCtx(base);
    const A = await hire(a, base, 'Solo');
    const other = await seedBase(); // a separate tenant
    const otherAdmin = adminCtx(other);
    const crossTenant = await withTenant(otherAdmin, (tx) =>
      tx.select().from(schema.domainEvent).where(eq(schema.domainEvent.subjectEmploymentId, A.employmentId)),
    );
    expect(crossTenant).toHaveLength(0);
  });
});
