/**
 * Demo seed for local dev (resets the dev DB to a known state).
 * Run: `pnpm db:seed`  — structural data via the owner role, employees via the real
 * hireEmployee service (so the seed also exercises the service path).
 */
import { sql } from 'drizzle-orm';
import { createDb, type SessionContext } from './client';
import * as schema from './schema';
import { hireEmployee, setReportingLine } from '../core/org';

const DEV_TENANT_ID = '11111111-1111-1111-1111-111111111111';
const DEV_ADMIN_USER_ID = '22222222-2222-2222-2222-222222222222';

const owner = createDb(process.env.MIGRATION_DATABASE_URL!);

const TABLES = [
  'tenant', 'company', 'person', 'position', 'department', 'cost_center', 'employment',
  'assignment', 'reporting_line', 'leave_type', 'leave_policy', 'leave_ledger',
  'leave_request', 'app_user', 'role_assignment', 'domain_event',
];

async function main() {
  console.log('Resetting dev database…');
  await owner.db.execute(sql.raw(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`));

  await owner.db.insert(schema.tenant).values({ id: DEV_TENANT_ID, workosOrgId: 'org_dev', name: 'Demo Group' });
  const [company] = await owner.db
    .insert(schema.company)
    .values({ tenantId: DEV_TENANT_ID, legalName: 'Demo Sdn Bhd', country: 'MY', currency: 'MYR' })
    .returning({ id: schema.company.id });
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
  const [annual] = await owner.db
    .insert(schema.leaveType)
    .values({ tenantId: DEV_TENANT_ID, code: 'ANNUAL', name: 'Annual Leave', paid: true })
    .returning({ id: schema.leaveType.id });
  await owner.db.insert(schema.leavePolicy).values({
    tenantId: DEV_TENANT_ID,
    leaveTypeId: annual.id,
    accrual: { annualDays: 16, method: 'grant_on_hire_prorated' },
    validFrom: '2020-01-01',
    validTo: null,
  });
  await owner.db
    .insert(schema.appUser)
    .values({ id: DEV_ADMIN_USER_ID, tenantId: DEV_TENANT_ID, workosUserId: 'user_dev_admin', personId: null });
  await owner.db
    .insert(schema.roleAssignment)
    .values({ tenantId: DEV_TENANT_ID, appUserId: DEV_ADMIN_USER_ID, role: 'hr_admin', companyId: null });

  const admin: SessionContext = { tenantId: DEV_TENANT_ID, userId: DEV_ADMIN_USER_ID, roles: ['hr_admin'] };
  const people = [
    { fullName: 'Aisyah Rahman', email: 'aisyah@demo.test', dept: finance.id },
    { fullName: 'Daniel Tan', email: 'daniel@demo.test', dept: eng.id },
    { fullName: 'Mei Ling', email: 'meiling@demo.test', dept: ops.id },
    { fullName: 'Arjun Kumar', email: 'arjun@demo.test', dept: eng.id },
  ];
  const hired: { employmentId: string }[] = [];
  for (const [i, p] of people.entries()) {
    const { employmentId, personId } = await hireEmployee(admin, {
      person: { fullName: p.fullName, primaryEmail: p.email },
      companyId: company.id,
      departmentId: p.dept,
      positionId: pos.id,
      employmentType: 'full_time',
      hiredOn: '2026-01-06',
      annualLeaveTypeId: annual.id,
    });
    hired.push({ employmentId });
    // Local user record + role (login identity itself is provisioned by WorkOS later).
    const [u] = await owner.db
      .insert(schema.appUser)
      .values({ tenantId: DEV_TENANT_ID, workosUserId: `seed:${p.email}`, personId })
      .returning({ id: schema.appUser.id });
    await owner.db
      .insert(schema.roleAssignment)
      .values({ tenantId: DEV_TENANT_ID, appUserId: u.id, role: i === 1 ? 'manager' : 'employee', companyId: null });
  }

  // Daniel (index 1) is the administrative manager of the rest — gives the org chart shape.
  for (const [i, h] of hired.entries()) {
    if (i === 1) continue;
    await setReportingLine(admin, {
      subordinateEmploymentId: h.employmentId,
      managerEmploymentId: hired[1].employmentId,
      lineType: 'administrative',
      validFrom: '2026-01-06',
    });
  }

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
