/**
 * Demo seed for local dev (resets the dev DB to a known state).
 * Run: `pnpm db:seed`  — structural data via the owner role, employees via the real
 * hireEmployee service (so the seed also exercises the service path).
 */
import { sql } from 'drizzle-orm';
import { createDb, type SessionContext } from './client';
import * as schema from './schema';
import { hireEmployee, setCostAllocation, setReportingLine } from '../core/org';
import { setCompensation } from '../core/comp';
import { checkIn, checkOut, requestAttendanceCorrection } from '../core/attendance';
import { requestLeave, decideLeave } from '../core/leave';
import { createLeavePolicy } from '../core/admin';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { myPack } from '../localization/my';

const DEV_TENANT_ID = '11111111-1111-1111-1111-111111111111';
const DEV_ADMIN_USER_ID = '22222222-2222-2222-2222-222222222222';

const owner = createDb(process.env.MIGRATION_DATABASE_URL!);

const TABLES = [
  'tenant', 'company', 'person', 'position', 'department', 'cost_center', 'employment',
  'assignment', 'reporting_line', 'leave_type', 'leave_policy', 'leave_ledger',
  'leave_request', 'app_user', 'role_assignment', 'domain_event',
  'compensation', 'employee_statutory_my', 'tenant_counter',
  'attendance', 'attendance_policy', 'payroll_batch', 'payslip', 'company_statutory_my',
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
    })
    .returning({ id: schema.company.id });
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
      .values({ tenantId: DEV_TENANT_ID, code: lt.code, name: lt.name, paid: lt.paid, counting: lt.counting })
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
      .values({ tenantId: DEV_TENANT_ID, country: 'MY', holidayDate: h.date, name: h.name });
  }
  await owner.db
    .insert(schema.appUser)
    .values({ id: DEV_ADMIN_USER_ID, tenantId: DEV_TENANT_ID, workosUserId: 'user_dev_admin', personId: null });
  await owner.db
    .insert(schema.roleAssignment)
    .values({ tenantId: DEV_TENANT_ID, appUserId: DEV_ADMIN_USER_ID, role: 'hr_admin', companyId: null });

  const admin: SessionContext = { tenantId: DEV_TENANT_ID, userId: DEV_ADMIN_USER_ID, roles: ['hr_admin'] };
  // Company policy more generous than the EA floor (12 vs 8 annual days): grants apply
  // max(floor, policy), so this is what every demo hire actually receives.
  await createLeavePolicy(admin, { leaveTypeId: annual.id, annualDays: 12, validFrom: '2026-01-01' });
  const people = [
    { fullName: 'Aisyah Rahman', email: 'aisyah@demo.test', dept: finance.id, salary: 6500, ic: '900101011234', bank: 'Maybank' },
    { fullName: 'Daniel Tan', email: 'daniel@demo.test', dept: eng.id, salary: 11000, ic: '850202022345', bank: 'CIMB' },
    { fullName: 'Mei Ling', email: 'meiling@demo.test', dept: ops.id, salary: 5800, ic: '920303033456', bank: 'Public Bank' },
    { fullName: 'Arjun Kumar', email: 'arjun@demo.test', dept: eng.id, salary: 7200, ic: '880404044567', bank: 'RHB' },
  ];
  const hired: { employmentId: string }[] = [];
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
    hired.push({ employmentId });
    if (i === 1) danielPersonId = personId;
    // Local user record + role (login identity itself is provisioned by WorkOS later).
    const [u] = await owner.db
      .insert(schema.appUser)
      .values({ tenantId: DEV_TENANT_ID, workosUserId: `seed:${p.email}`, personId })
      .returning({ id: schema.appUser.id });
    await owner.db
      .insert(schema.roleAssignment)
      .values({ tenantId: DEV_TENANT_ID, appUserId: u.id, role: i === 1 ? 'manager' : 'employee', companyId: null });

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
  const seedLeave = async (
    employmentId: string,
    leaveTypeId: string,
    startDate: string,
    endDate: string,
    approve: boolean,
  ) => {
    const { leaveRequestId } = await requestLeave(admin, { employmentId, leaveTypeId, startDate, endDate });
    if (approve) {
      try {
        await decideLeave(admin, {
          leaveRequestId,
          decision: 'approved',
          deciderEmploymentId: hired[1].employmentId,
        });
      } catch (e) {
        console.warn(`  (leave ${startDate} left pending: ${(e as Error).message})`);
      }
    }
  };
  await seedLeave(hired[0].employmentId, annual.id, '2026-06-10', '2026-06-12', true); // Aisyah · annual · approved
  await seedLeave(hired[3].employmentId, annual.id, '2026-06-16', '2026-06-18', true); // Arjun · annual · approved
  await seedLeave(hired[2].employmentId, leaveTypeIds.SICK, '2026-06-09', '2026-06-10', false); // Mei Ling · sick · pending
  await seedLeave(hired[1].employmentId, annual.id, '2026-06-11', '2026-06-11', false); // Daniel · annual · pending
  // One rejected request so the Leave page's status chips have every state.
  const rejected = await requestLeave(admin, {
    employmentId: hired[3].employmentId,
    leaveTypeId: leaveTypeIds.SICK,
    startDate: '2026-06-19',
    endDate: '2026-06-19',
  });
  await decideLeave(admin, {
    leaveRequestId: rejected.leaveRequestId,
    decision: 'rejected',
    deciderEmploymentId: hired[1].employmentId,
  });

  console.log(`✓ Seeded demo tenant with ${people.length} employees.`);
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
