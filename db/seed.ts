/**
 * Demo seed for local dev (resets the dev DB to a known state).
 * Run: `pnpm db:seed`  — structural data via the owner role, employees via the real
 * hireEmployee service (so the seed also exercises the service path).
 */
import { and, eq, sql } from 'drizzle-orm';
import { createDb, type SessionContext } from './client';
import * as schema from './schema';
import { hireEmployee, setCostAllocation, setReportingLine } from '../core/org';
import { setCompensation } from '../core/comp';
import { checkIn, checkOut, requestAttendanceCorrection } from '../core/attendance';
import { requestLeave, decideLeave, addLeaveAttachment, accrueEarnedLeave } from '../core/leave';
import { createLeavePolicy, createJobGrade } from '../core/admin';
import { createCycle, openCycle, submitManagerReview, submitSelfReview } from '../core/performance';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { myPack } from '../localization/my';
import { MY_STATE_HOLIDAYS_2026 } from '../localization/my/holidays';
import { seedGuides } from './seed-guides';

const DEV_TENANT_ID = '11111111-1111-1111-1111-111111111111';
const DEV_ADMIN_USER_ID = '22222222-2222-2222-2222-222222222222';

const owner = createDb(process.env.MIGRATION_DATABASE_URL!);

const TABLES = [
  'tenant', 'company', 'person', 'position', 'department', 'cost_center', 'employment',
  'assignment', 'reporting_line', 'job_grade', 'leave_type', 'leave_policy', 'leave_ledger',
  'leave_request', 'resignation_request', 'app_user', 'role_assignment', 'domain_event',
  'compensation', 'employee_statutory_my', 'tenant_counter',
  'attendance', 'attendance_policy', 'payroll_batch', 'payslip', 'company_statutory_my',
  'kb_document',
];

async function main() {
  console.log('Resetting dev database…');
  await owner.db.execute(sql.raw(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`));

  await owner.db.insert(schema.tenant).values({ id: DEV_TENANT_ID, workosOrgId: 'org_dev', name: 'Demo Group' });
  // Group structure (ADR-0009): a holding company over the operating entity.
  const [holding] = await owner.db
    .insert(schema.company)
    .values({ tenantId: DEV_TENANT_ID, legalName: 'Demo Group Holdings Bhd', country: 'MY', currency: 'MYR' })
    .returning({ id: schema.company.id });
  const [company] = await owner.db
    .insert(schema.company)
    .values({
      tenantId: DEV_TENANT_ID,
      legalName: 'Demo Sdn Bhd',
      country: 'MY',
      currency: 'MYR',
      parentCompanyId: holding.id,
      leaveMultiApproval: true, // 2B-1: demo the manager → HR chain
      defaultWorkState: 'Selangor', // 2C: HQ default; employees without an explicit work_state inherit it
    })
    .returning({ id: schema.company.id });
  // 2B-2 (ADR-0039): an explicit approval chain for the demo company (direct manager → HR), so the
  // editor shows a configured policy. company.leaveMultiApproval is already true (set above).
  await owner.db.insert(schema.leaveApprovalPolicy).values({
    tenantId: DEV_TENANT_ID,
    companyId: company.id,
    leaveTypeId: null,
    levels: ['direct_manager', 'hr_admin'],
  });
  await owner.db.insert(schema.companyStatutoryMy).values({
    tenantId: DEV_TENANT_ID,
    companyId: company.id,
    epfEmployerNo: 'A1234567890',
    socsoEmployerCode: 'B9876543',
    lhdnEmployerNo: 'E1234567890',
    myinvoisTin: 'C12345678901',
    ssmRegistrationNo: '202301012345',
  });
  const [finance] = await owner.db
    .insert(schema.department)
    .values({ tenantId: DEV_TENANT_ID, companyId: company.id, name: 'Finance' })
    .returning({ id: schema.department.id });
  const [ops] = await owner.db
    .insert(schema.department)
    .values({ tenantId: DEV_TENANT_ID, companyId: company.id, name: 'Operations' })
    .returning({ id: schema.department.id });
  const [eng] = await owner.db
    .insert(schema.department)
    .values({ tenantId: DEV_TENANT_ID, companyId: company.id, name: 'Engineering' })
    .returning({ id: schema.department.id });
  const [pos] = await owner.db
    .insert(schema.position)
    .values({ tenantId: DEV_TENANT_ID, companyId: company.id, title: 'Executive' })
    .returning({ id: schema.position.id });
  await owner.db
    .insert(schema.costCenter)
    .values({ tenantId: DEV_TENANT_ID, companyId: company.id, code: 'HQ', name: 'Headquarters' });
  // Leave types + public holidays from the Malaysia pack (ADR-0008).
  const leaveTypeIds: Record<string, string> = {};
  for (const lt of myPack.leave.types) {
    const [row] = await owner.db
      .insert(schema.leaveType)
      .values({ tenantId: DEV_TENANT_ID, code: lt.code, name: lt.name, paid: lt.paid, counting: lt.counting, eligibility: lt.eligibility ?? null, requiresDocument: lt.requiresDocument ?? false, sendToPayroll: lt.sendToPayroll ?? !lt.paid, i18n: lt.i18n ?? null })
      .returning({ id: schema.leaveType.id });
    leaveTypeIds[lt.code] = row.id;
  }
  const annual = { id: leaveTypeIds.ANNUAL };
  // Standing entitlements granted on every hire (EA s.60E / s.60F via the MY pack).
  const standingGrants = [
    { id: leaveTypeIds.ANNUAL, code: 'ANNUAL' },
    { id: leaveTypeIds.SICK, code: 'SICK' },
    { id: leaveTypeIds.HOSPITALIZATION, code: 'HOSPITALIZATION' },
  ];
  for (const h of myPack.holidays) {
    await owner.db
      .insert(schema.holiday)
      .values({ tenantId: DEV_TENANT_ID, country: 'MY', state: null, holidayDate: h.date, name: h.name });
  }
  // 2C (ADR-0038): state-specific holidays (sourced fixed-date subset) — only apply in their state.
  for (const h of MY_STATE_HOLIDAYS_2026) {
    await owner.db
      .insert(schema.holiday)
      .values({ tenantId: DEV_TENANT_ID, country: 'MY', state: h.state ?? null, holidayDate: h.date, name: h.name });
  }
  // Holiday grouping: one illustrative multi-state group (no holiday re-tagging). Assigned to a demo
  // employee below so the group path resolving e.g. Sarawak Day / Pesta Kaamatan is demonstrable.
  const [eastMalaysiaGroup] = await owner.db
    .insert(schema.holidayGroup)
    .values({ tenantId: DEV_TENANT_ID, name: 'East Malaysia', states: ['Sabah', 'Sarawak', 'Labuan'] })
    .returning({ id: schema.holidayGroup.id });
  // The dev admin is a real principal in the audit trail: link it to a person so its actions
  // resolve to a name ("HR Admin") instead of the bare actor type. No employment, so it never
  // appears in People / org / headcount — it's a back-office identity, not an employee.
  const [adminPerson] = await owner.db
    .insert(schema.person)
    .values({ tenantId: DEV_TENANT_ID, fullName: 'HR Admin', primaryEmail: 'admin@demo.test' })
    .returning({ id: schema.person.id });
  await owner.db
    .insert(schema.appUser)
    .values({ id: DEV_ADMIN_USER_ID, tenantId: DEV_TENANT_ID, workosUserId: 'user_dev_admin', personId: adminPerson.id });
  await owner.db
    .insert(schema.roleAssignment)
    .values({ tenantId: DEV_TENANT_ID, appUserId: DEV_ADMIN_USER_ID, role: 'hr_admin', companyId: null });

  const admin: SessionContext = { tenantId: DEV_TENANT_ID, userId: DEV_ADMIN_USER_ID, roles: ['hr_admin'] };
  // ADR-0040 (2D): demo ANNUAL *accrues monthly* (earned), not as a lump on hire — so balances grow
  // through the year. Entitlement is max(EA floor 8, policy 12) = 12 → 1 day/month; the hire grant skips
  // earned types and accrueEarnedLeave (run after hiring, below) tops each employee up to today's share.
  await createLeavePolicy(admin, {
    leaveTypeId: annual.id,
    annualDays: 12,
    method: 'earned_monthly',
    validFrom: '2026-01-01',
  });
  // ADR-0041 (2E): grade catalog + a grade-scoped ANNUAL policy. Executives earn 18 annual days (vs the
  // 12-day default), so a graded employee (Daniel, below) accrues more — grade-based entitlement, visible.
  const execGrade = await createJobGrade(admin, { code: 'EXEC', name: 'Executive', rank: 1 });
  await createJobGrade(admin, { code: 'NONEXEC', name: 'Non-Executive', rank: 2 });
  await createLeavePolicy(admin, {
    leaveTypeId: annual.id,
    annualDays: 18,
    method: 'earned_monthly',
    gradeId: execGrade.id,
    validFrom: '2026-01-01',
  });
  const people: {
    fullName: string;
    email: string;
    dept: string;
    salary: number;
    ic: string;
    bank: string;
    gender: string;
    marital: string;
    workState?: string;
  }[] = [
    { fullName: 'Aisyah Rahman', email: 'aisyah@demo.test', dept: finance.id, salary: 6500, ic: '900101011234', bank: 'Maybank', gender: 'female', marital: 'married' },
    { fullName: 'Daniel Tan', email: 'daniel@demo.test', dept: eng.id, salary: 11000, ic: '850202022345', bank: 'CIMB', gender: 'male', marital: 'married' },
    { fullName: 'Mei Ling', email: 'meiling@demo.test', dept: ops.id, salary: 5800, ic: '920303033456', bank: 'Public Bank', gender: 'female', marital: 'single', workState: 'Sarawak' },
    { fullName: 'Arjun Kumar', email: 'arjun@demo.test', dept: eng.id, salary: 7200, ic: '880404044567', bank: 'RHB', gender: 'male', marital: 'married' },
  ];
  const hired: { employmentId: string; personId: string; session: SessionContext }[] = [];
  let danielPersonId = '';
  for (const [i, p] of people.entries()) {
    const { employmentId, personId } = await hireEmployee(admin, {
      person: { fullName: p.fullName, primaryEmail: p.email },
      companyId: company.id,
      departmentId: p.dept,
      positionId: pos.id,
      employmentType: 'full_time',
      hiredOn: '2026-01-06',
      grantLeaveTypes: standingGrants,
    });
    if (i === 1) danielPersonId = personId;
    // ADR-0038 2A-1: self-declared gender + marital so maternity/paternity eligibility is demonstrable.
    await owner.db.update(schema.person).set({ gender: p.gender, maritalStatus: p.marital }).where(eq(schema.person.id, personId));
    // ADR-0038 2C: work state (Mei Ling in Sarawak) so state-holiday differences are demonstrable.
    if (p.workState) {
      await owner.db.update(schema.employment).set({ workState: p.workState }).where(eq(schema.employment.id, employmentId));
    }
    // ADR-0041 2E: Daniel (the manager) is an Executive, so his ANNUAL accrues on the 18-day grade policy
    // (9 days by late June) vs the 12-day default (6 days) — grade-based accrual, visible in the demo.
    if (i === 1) {
      await owner.db.update(schema.employment).set({ gradeId: execGrade.id }).where(eq(schema.employment.id, employmentId));
    }
    // Local user record + role (login identity itself is provisioned by WorkOS later).
    const role = i === 1 ? 'manager' : 'employee';
    const [u] = await owner.db
      .insert(schema.appUser)
      .values({ tenantId: DEV_TENANT_ID, workosUserId: `seed:${p.email}`, personId })
      .returning({ id: schema.appUser.id });
    await owner.db
      .insert(schema.roleAssignment)
      .values({ tenantId: DEV_TENANT_ID, appUserId: u.id, role, companyId: null });
    // Their own session — used below so leave requests are authored by the employee (and
    // approvals by their manager), giving the audit trail real, differentiated actors.
    const session: SessionContext = { tenantId: DEV_TENANT_ID, userId: u.id, roles: [role], personId };
    hired.push({ employmentId, personId, session });

    await setCompensation(admin, { employmentId, basicSalary: p.salary, monthlyAllowance: 500, effectiveFrom: '2026-01-06' });
    await setStatutoryProfileMY(admin, {
      personId,
      icNumber: p.ic,
      epfNumber: `EPF${p.ic.slice(0, 7)}`,
      socsoNumber: `SOC${p.ic.slice(0, 7)}`,
      taxNumber: `SG${p.ic.slice(0, 8)}`,
      eisEligible: true,
      bankName: p.bank,
      bankAccountNo: `8800${p.ic.slice(0, 8)}`,
    });
  }

  // Holiday grouping: assign Arjun (no bare work_state) to the East-Malaysia group so the group
  // resolution path is demonstrable alongside Mei Ling's single-state (Sarawak) path. XOR-safe: he has
  // no work_state, so only holiday_group_id is set.
  await owner.db
    .update(schema.employment)
    .set({ holidayGroupId: eastMalaysiaGroup.id })
    .where(eq(schema.employment.id, hired[3].employmentId));

  // Administrative backbone (multi-level) + cross-cutting lines so the org chart can render
  // typed connectors: functional, project, and dotted-line reporting.
  const reportsTo = (
    sub: string,
    mgr: string,
    lineType: 'administrative' | 'functional' | 'project' | 'dotted',
    validFrom = '2026-01-06',
  ) => setReportingLine(admin, { subordinateEmploymentId: sub, managerEmploymentId: mgr, lineType, validFrom });
  await reportsTo(hired[0].employmentId, hired[1].employmentId, 'administrative'); // Aisyah -> Daniel
  await reportsTo(hired[3].employmentId, hired[1].employmentId, 'administrative'); // Arjun -> Daniel
  await reportsTo(hired[2].employmentId, hired[0].employmentId, 'administrative'); // Mei Ling -> Aisyah
  await reportsTo(hired[2].employmentId, hired[3].employmentId, 'functional'); // Mei Ling ~ Arjun (functional)
  await reportsTo(hired[3].employmentId, hired[0].employmentId, 'dotted'); // Arjun ~ Aisyah (dotted-line)

  // Concurrent multi-company (ADR-0009): Daniel is also Group CFO at the holding company — a
  // shared-services role whose cost is recharged 50% to the operating company.
  const [groupDept] = await owner.db
    .insert(schema.department)
    .values({ tenantId: DEV_TENANT_ID, companyId: holding.id, name: 'Group Office' })
    .returning({ id: schema.department.id });
  const [groupPos] = await owner.db
    .insert(schema.position)
    .values({ tenantId: DEV_TENANT_ID, companyId: holding.id, title: 'Group CFO' })
    .returning({ id: schema.position.id });
  const daniel2 = await hireEmployee(admin, {
    person: { id: danielPersonId },
    companyId: holding.id,
    departmentId: groupDept.id,
    positionId: groupPos.id,
    employmentType: 'part_time',
    hiredOn: '2026-02-01',
  });
  await setCompensation(admin, {
    employmentId: daniel2.employmentId,
    basicSalary: 4000,
    monthlyAllowance: 0,
    effectiveFrom: '2026-02-01',
  });
  await setCostAllocation(admin, {
    employmentId: daniel2.employmentId,
    allocations: [{ companyId: company.id, percent: 50 }],
  });

  // A couple of recent hires — shape for the Onboarding card and depth for the org chart.
  const nurul = await hireEmployee(admin, {
    person: { fullName: 'Nurul Huda', primaryEmail: 'nurul@demo.test' },
    companyId: company.id,
    departmentId: ops.id,
    positionId: pos.id,
    employmentType: 'full_time',
    hiredOn: '2026-06-04',
    grantLeaveTypes: standingGrants,
  });
  const weijie = await hireEmployee(admin, {
    person: { fullName: 'Wei Jie Lim', primaryEmail: 'weijie@demo.test' },
    companyId: company.id,
    departmentId: eng.id,
    positionId: pos.id,
    employmentType: 'full_time',
    hiredOn: '2026-05-22',
    grantLeaveTypes: standingGrants,
  });
  await reportsTo(nurul.employmentId, hired[3].employmentId, 'administrative', '2026-06-04'); // Nurul -> Arjun
  await reportsTo(weijie.employmentId, hired[0].employmentId, 'administrative', '2026-05-22'); // Wei Jie -> Aisyah
  await reportsTo(weijie.employmentId, hired[2].employmentId, 'project', '2026-05-22'); // Wei Jie ~ Mei Ling (project)
  // Comps under the RM4,000 First Schedule ceiling — they are the OT-eligible demo cases.
  await setCompensation(admin, { employmentId: nurul.employmentId, basicSalary: 3200, effectiveFrom: '2026-06-04' });
  await setCompensation(admin, { employmentId: weijie.employmentId, basicSalary: 3800, effectiveFrom: '2026-05-22' });

  // Attendance policy + live demo punches around the real "today" (ADR-0011: hours/OT derive
  // from the schedule; Aisyah stays rowless today so the approved-leave context pill shows).
  await owner.db.insert(schema.attendancePolicy).values({ tenantId: DEV_TENANT_ID, companyId: company.id });
  const seedToday = new Date().toISOString().slice(0, 10);
  const seedYesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  // Yesterday: two completed days — Arjun with 90m OT, Wei Jie a clean standard day.
  await checkIn(admin, { employmentId: hired[3].employmentId, date: seedYesterday, time: '09:00' });
  await checkOut(admin, { employmentId: hired[3].employmentId, date: seedYesterday, time: '19:30' });
  await checkIn(admin, { employmentId: weijie.employmentId, date: seedYesterday, time: '09:05' });
  await checkOut(admin, { employmentId: weijie.employmentId, date: seedYesterday, time: '19:05' }); // 60m OT (eligible)
  // Today: Daniel late, Wei Jie present (both still in the office).
  await checkIn(admin, { employmentId: hired[1].employmentId, date: seedToday, time: '09:30' });
  await checkIn(admin, { employmentId: weijie.employmentId, date: seedToday, time: '09:00' });
  // A pending correction so the manager inbox has something to act on (Mei Ling forgot to punch).
  await requestAttendanceCorrection(admin, {
    employmentId: hired[2].employmentId,
    date: seedYesterday,
    checkIn: '09:00',
    checkOut: '18:00',
    reason: 'Forgot to clock in',
  });

  // Planned absences around 'today' (2026-06) so the dashboard timeline has shape.
  const manager = hired[1]; // Daniel — administrative manager of Aisyah and Arjun
  // A tiny stand-in for an uploaded medical certificate, so document-gated demo leave is valid.
  const demoMc = () => Buffer.from('%PDF-1.4\n% Demo medical certificate (seed data)\n');
  const seedLeave = async (
    idx: number,
    leaveTypeId: string,
    startDate: string,
    endDate: string,
    approve: boolean,
    withDoc = false,
  ) => {
    const { employmentId, session } = hired[idx];
    // Authored by the employee (the real-world actor), so the event carries their identity.
    const { leaveRequestId } = await requestLeave(session, { employmentId, leaveTypeId, startDate, endDate, hasDocument: withDoc });
    if (withDoc) {
      await addLeaveAttachment(session, {
        leaveRequestId,
        fileName: 'medical-certificate.pdf',
        mimeType: 'application/pdf',
        content: demoMc(),
      });
    }
    if (approve) {
      try {
        await decideLeave(manager.session, {
          leaveRequestId,
          decision: 'approved',
          deciderEmploymentId: manager.employmentId,
        });
        // 2B-1: a multi-step company needs a second (HR) approval to finalize. Harmless on single-step
        // (the request is already approved, so this branch is skipped).
        const [after] = await owner.db
          .select({ status: schema.leaveRequest.status })
          .from(schema.leaveRequest)
          .where(eq(schema.leaveRequest.id, leaveRequestId));
        if (after?.status === 'pending') {
          await decideLeave(admin, { leaveRequestId, decision: 'approved' });
        }
      } catch (e) {
        console.warn(`  (leave ${startDate} left pending: ${(e as Error).message})`);
      }
    }
  };
  // ADR-0040 (2D): grant everyone their earned-to-date ANNUAL share before any leave is taken below
  // (~6 days by late June for a Jan joiner on a 12-day, earn-monthly policy). Idempotent.
  await accrueEarnedLeave(admin, { asOf: '2026-06-23' });
  await seedLeave(0, annual.id, '2026-06-10', '2026-06-12', true); // Aisyah · annual · approved by Daniel
  await seedLeave(3, annual.id, '2026-06-16', '2026-06-18', true); // Arjun · annual · approved by Daniel
  await seedLeave(2, leaveTypeIds.SICK, '2026-06-09', '2026-06-10', false, true); // Mei Ling · sick · pending · with MC
  await seedLeave(1, annual.id, '2026-06-11', '2026-06-11', false); // Daniel · annual · pending
  // One rejected request so the Leave page's status chips have every state.
  const rejected = await requestLeave(hired[3].session, {
    employmentId: hired[3].employmentId,
    leaveTypeId: leaveTypeIds.SICK,
    startDate: '2026-06-19',
    endDate: '2026-06-19',
    hasDocument: true,
  });
  await addLeaveAttachment(hired[3].session, {
    leaveRequestId: rejected.leaveRequestId,
    fileName: 'medical-certificate.pdf',
    mimeType: 'application/pdf',
    content: demoMc(),
  });
  await decideLeave(manager.session, {
    leaveRequestId: rejected.leaveRequestId,
    decision: 'rejected',
    deciderEmploymentId: manager.employmentId,
  });

  // Performance (ADR-0013): a live annual cycle so the module has shape — most reviews sit at
  // self-review; Aisyah's is finalized with a 5% merit recommendation awaiting enactment.
  const { cycleId: perfCycle } = await createCycle(admin, {
    name: '2026 Annual',
    periodStart: '2026-01-01',
    periodEnd: '2026-12-31',
    meritBudget: { kind: 'percent', value: 4 },
  });
  await openCycle(admin, { cycleId: perfCycle });
  const [aisyahReview] = await owner.db
    .select({ id: schema.performanceReview.id })
    .from(schema.performanceReview)
    .where(
      and(
        eq(schema.performanceReview.cycleId, perfCycle),
        eq(schema.performanceReview.employmentId, hired[0].employmentId),
      ),
    );
  if (aisyahReview) {
    await submitSelfReview(admin, {
      reviewId: aisyahReview.id,
      selfRating: 4,
      selfComments: 'Strong delivery on the migration; want more cross-team scope next year.',
    });
    await submitManagerReview(admin, {
      reviewId: aisyahReview.id,
      managerRating: 4,
      overallRating: 4,
      managerComments: 'Reliable and high-quality. Ready for more responsibility.',
      recommendedMeritPct: 5,
    });
  }

  const guideCount = await seedGuides(owner.db, DEV_TENANT_ID);

  console.log(`✓ Seeded demo tenant with ${people.length} employees.`);
  console.log(`  ${guideCount} Knowledge Base guides seeded.`);
  console.log(`  DEV_TENANT_ID=${DEV_TENANT_ID}`);
  console.log(`  DEV_USER_ID=${DEV_ADMIN_USER_ID}`);

  await owner.client.end({ timeout: 5 });
  const { client } = await import('./client');
  await client.end({ timeout: 5 });
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
