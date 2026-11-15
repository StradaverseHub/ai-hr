/** Fictional, production-shaped population of a database at the PRODUCTION BASELINE schema.
 *
 * Copied into a detached checkout of the populator source (the release whose journal is exactly the production
 * ledger prefix) and run THERE, so every import below resolves to the baseline's own services and harness. Nothing
 * from the candidate release writes these rows. Run only by test/production-upgrade-rehearsal.test.ts, against a
 * disposable database whose name it checks; refuses anything else.
 *
 * Every name, email, IC number and amount is invented. No production data is read or copied. */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { closeBatch, createBatch, generatePayslips } from '../core/payroll';
import { createClaimType, decideClaim, submitClaim } from '../core/claims';
import { provisionTenant } from '../db/provision';
import { closeAll, createAppUser, entitledCtx, owner, seedBase, setModule } from '../test/harness';

type Sizes = {
  companies: number; payrollCompanies: number; payrollEmploymentsPerCompany: number; otherEmploymentsPerCompany: number;
  payrollMonths: string[]; openPayrollMonth: string;
  claims: number; users: number; secondTenantEmployments: number;
};
const target = new URL(process.env.TEST_MIGRATION_DATABASE_URL!);
if (!['127.0.0.1', 'localhost'].includes(target.hostname) || !/^\/ai_hr_prod_rehearsal_base_[a-f0-9]{32}$/.test(target.pathname))
  throw Error('Refusing: populate only an owned disposable rehearsal baseline database');
const sizes = JSON.parse(process.env.REHEARSAL_SIZES!) as Sizes;
const output = process.env.REHEARSAL_POPULATION_OUTPUT!;
const timings: Record<string, number> = {};
const phase = async <T,>(name: string, run: () => Promise<T>) => {
  const started = Date.now();
  try { return await run(); } finally { timings[name] = Date.now() - started; console.log(`populate ${name}: ${timings[name]} ms`); }
};
const pad = (value: number, width: number) => String(value).padStart(width, '0');
const SURNAMES = ['Tan', 'Lim', 'Wong', 'Lee', 'Ng', 'Abdullah', 'Rahman', 'Ismail', 'Kumar', 'Raj', 'Chong', 'Yap', 'Ong', 'Teoh', 'Hassan'];
const GIVEN = ['Aina', 'Boon', 'Chandra', 'Dahlia', 'Eng', 'Farid', 'Grace', 'Hafiz', 'Indra', 'Jun', 'Kavitha', 'Lina', 'Mei', 'Nurul', 'Omar'];

async function main() {
  const base = await phase('tenant', async () => {
    const b = await seedBase();
    await owner.db.execute(sql`update tenant set name='Meranti Rehearsal Group (fictional)' where id=${b.tenantId}::uuid`);
    await owner.db.execute(sql`update company set legal_name='Meranti Rehearsal Holdings Bhd (fictional)', country='MY', currency='MYR' where id=${b.companyId}::uuid`);
    for (const code of ['payroll', 'claims', 'attendance', 'performance', 'lifecycle']) await setModule(b.tenantId, code, 'active');
    return b;
  });
  const ctx = await entitledCtx(base);

  // A group: one holding company and its operating subsidiaries, each with its own departments.
  const companies = await phase('companies', async () => {
    const rows: { companyId: string; departments: string[] }[] = [{ companyId: base.companyId, departments: [base.deptA, base.deptB] }];
    for (let index = 1; index < sizes.companies; index++) {
      const [company] = await owner.db.insert(schema.company).values({
        tenantId: base.tenantId, legalName: `Meranti Subsidiary ${pad(index, 3)} Sdn Bhd (fictional)`, country: 'MY', currency: 'MYR',
        parentCompanyId: base.companyId,
      }).returning({ id: schema.company.id });
      const departments: string[] = [];
      for (const name of ['Finance', 'Operations', 'Sales']) {
        const [department] = await owner.db.insert(schema.department).values({ tenantId: base.tenantId, companyId: company.id, name }).returning({ id: schema.department.id });
        departments.push(department.id);
      }
      rows.push({ companyId: company.id, departments });
    }
    return rows;
  });

  // Employments through the baseline's real hire service: person, employment, assignment and their audit events.
  // Employments through the baseline's real hire service: person, employment, assignment, statutory defaults and their
  // chained audit events. The test multiplies the non-payroll ones set-wise afterwards (service hires cost ~250 ms each).
  const hired = await phase('employments', async () => {
    const rows: { companyIndex: number; employmentId: string; personId: string; serial: number }[] = [];
    let serial = 0;
    for (const [companyIndex, company] of companies.entries()) {
      const count = companyIndex < sizes.payrollCompanies ? sizes.payrollEmploymentsPerCompany : sizes.otherEmploymentsPerCompany;
      for (let within = 0; within < count; within++, serial++) {
        const name = `${GIVEN[serial % GIVEN.length]} ${SURNAMES[Math.floor(serial / GIVEN.length) % SURNAMES.length]} ${pad(serial, 5)}`;
        const hire = await hireEmployee(ctx, {
          person: { fullName: name, primaryEmail: `employee.${pad(serial, 5)}@meranti-rehearsal.example.test` },
          companyId: company.companyId, departmentId: company.departments[within % company.departments.length],
          employmentType: 'full_time', hiredOn: `202${4 + (serial % 2)}-0${1 + (serial % 9)}-01`, employeeCode: `MR${pad(serial, 5)}`,
        });
        rows.push({ companyIndex, employmentId: hire.employmentId, personId: hire.personId, serial });
      }
    }
    return rows;
  });

  await phase('leave-ledger', async () => {
    for (let start = 0; start < hired.length; start += 500) {
      await owner.db.insert(schema.leaveLedger).values(hired.slice(start, start + 500).map((row) => ({
        tenantId: base.tenantId, employmentId: row.employmentId, leaveTypeId: base.annualLeaveTypeId,
        entryType: 'accrual' as const, days: String(8 + (row.serial % 9)), effectiveOn: '2026-01-01',
      })));
    }
  });

  // Payroll companies: every employee there needs pay and a statutory profile, or generatePayslips refuses the run.
  const payrollRows = hired.filter((row) => row.companyIndex < sizes.payrollCompanies);
  await phase('payroll-setup', async () => {
    for (const row of payrollRows) {
      await setCompensation(ctx, { employmentId: row.employmentId, basicSalary: 2800 + (row.serial % 37) * 175, effectiveFrom: '2025-01-01' });
      await setStatutoryProfileMY(ctx, { personId: row.personId, icNumber: `90${pad(1 + (row.serial % 12), 2)}${pad(1 + (row.serial % 28), 2)}14${pad(row.serial % 10000, 4)}`, taxCategory: 1, numChildren: row.serial % 4 });
    }
  });
  const batches = await phase('payroll-closed', async () => {
    let closed = 0, payslips = 0;
    for (const month of sizes.payrollMonths) {
      for (let companyIndex = 0; companyIndex < sizes.payrollCompanies; companyIndex++) {
        const batch = await createBatch(ctx, { companyId: companies[companyIndex].companyId, payPeriod: month });
        await generatePayslips(ctx, { batchId: batch.batchId });
        await closeBatch(ctx, { batchId: batch.batchId });
        closed++; payslips += payrollRows.filter((row) => row.companyIndex === companyIndex).length;
      }
    }
    // One run still open at upgrade time, as a live installation usually has.
    const open = await createBatch(ctx, { companyId: companies[0].companyId, payPeriod: sizes.openPayrollMonth });
    await generatePayslips(ctx, { batchId: open.batchId });
    return { closed, open: 1, expectedClosedPayslips: payslips };
  });

  const claims = await phase('claims', async () => {
    const medical = await createClaimType(ctx, { code: 'MEDICAL', name: 'Medical', defaultTaxable: false, requiresReceipt: false, maxReceiptAgeDays: 36500 });
    const travel = await createClaimType(ctx, { code: 'TRAVEL', name: 'Travel', defaultTaxable: false, requiresReceipt: false, maxReceiptAgeDays: 36500 });
    const counts = { approved: 0, rejected: 0, pending: 0 };
    for (let index = 0; index < Math.min(sizes.claims, hired.length); index++) {
      const row = hired[(index * 7) % hired.length];
      const { id } = await submitClaim(ctx, { employmentId: row.employmentId, claimTypeId: index % 2 ? travel.id : medical.id,
        amount: 40 + (index % 23) * 11, incurredOn: `2026-${pad(7 + (index % 3), 2)}-${pad(1 + (index % 27), 2)}`, description: `Fictional claim ${index}` });
      if (index % 10 < 7) { await decideClaim(ctx, { claimRequestId: id, decision: 'approve' }); counts.approved++; }
      else if (index % 10 === 7) { await decideClaim(ctx, { claimRequestId: id, decision: 'reject', rejectReason: 'Fictional rehearsal rejection' }); counts.rejected++; }
      else counts.pending++;
    }
    return counts;
  });

  const users = await phase('users', async () => {
    let created = 0;
    for (let index = 0; index < Math.min(sizes.users, hired.length); index++) {
      await createAppUser(base.tenantId, hired[index * 3 % hired.length].personId, index % 10 === 0 ? 'manager' : 'employee'); created++;
    }
    return created;
  });

  // A second, small customer through the real provisioning path.
  const second = await phase('second-tenant', async () => {
    const provisioned = await owner.db.transaction((tx) => provisionTenant(tx, {
      name: 'Kenanga Rehearsal Customer (fictional)', adminEmail: 'admin@kenanga-rehearsal.example.test', baseUrl: 'https://rehearsal.invalid', modules: ['payroll', 'claims'],
    }));
    const [department] = await owner.db.insert(schema.department).values({ tenantId: provisioned.tenantId, companyId: provisioned.companyId, name: 'Operations' }).returning({ id: schema.department.id });
    await owner.db.insert(schema.roleAssignment).values({ tenantId: provisioned.tenantId, appUserId: provisioned.appUserId, companyId: null, role: 'hr_admin' }).onConflictDoNothing();
    const secondCtx = await entitledCtx({ ...base, tenantId: provisioned.tenantId, companyId: provisioned.companyId, adminUserId: provisioned.appUserId });
    let foreignEmploymentId = '';
    for (let serial = 0; serial < sizes.secondTenantEmployments; serial++) {
      const hire = await hireEmployee(secondCtx, { person: { fullName: `Kenanga Employee ${pad(serial, 4)}`, primaryEmail: `k${pad(serial, 4)}@kenanga-rehearsal.example.test` },
        companyId: provisioned.companyId, departmentId: department.id, employmentType: 'full_time', hiredOn: '2025-06-01', employeeCode: `KN${pad(serial, 4)}` });
      foreignEmploymentId ||= hire.employmentId;
    }
    return { tenantId: provisioned.tenantId, companyId: provisioned.companyId, employments: sizes.secondTenantEmployments, foreignEmploymentId };
  });

  const [counts] = await owner.client<Record<string, string>[]>`select
    (select count(*) from tenant)::text as tenants, (select count(*) from company)::text as companies,
    (select count(*) from employment)::text as employments, (select count(*) from person)::text as people,
    (select count(*) from payroll_batch)::text as payroll_batches, (select count(*) from payroll_batch where status='closed')::text as closed_batches,
    (select count(*) from payslip)::text as payslips, (select count(*) from claim_request)::text as claims,
    (select count(*) from domain_event)::text as domain_events, (select count(*) from app_user)::text as app_users`;
  writeFileSync(output, JSON.stringify({
    kind: 'FICTIONAL_PRODUCTION_SHAPED_BASELINE_POPULATION', populatorSource: process.env.REHEARSAL_POPULATOR_SOURCE, sizes, timings,
    tenantId: base.tenantId, companyId: base.companyId, departmentId: base.deptA, adminUserId: base.adminUserId,
    foreignTenantId: second.tenantId, foreignCompanyId: second.companyId, foreignEmploymentId: second.foreignEmploymentId,
    ownEmploymentId: hired[0].employmentId,
    templateEmploymentIds: hired.filter((row) => row.companyIndex >= sizes.payrollCompanies).map((row) => row.employmentId), batches, claims, users, counts, marker: randomUUID(),
  }, null, 2));
}

main().then(() => closeAll()).then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
