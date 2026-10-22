/** Fictional local paid results for the remaining Board 1 app journeys. Never targets a shared DB. */
import { readFile, mkdir, writeFile } from 'node:fs/promises';

const destination = '/private/tmp/aihr-board1-remaining4-20261021/payroll-fixture.json';
for (const raw of [process.env.DATABASE_URL, process.env.MIGRATION_DATABASE_URL]) {
  const url = new URL(raw || '');
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost'].includes(url.hostname)
    || url.port !== '5433' || url.pathname !== '/ai_hr_board1_acceptance' || url.search || url.hash)
    throw new Error('Only the named disposable local Board 1 database is allowed.');
}
if (process.env.NODE_ENV === 'production') throw new Error('Development fixture only.');
process.env.TEST_DATABASE_URL = process.env.DATABASE_URL;
process.env.TEST_MIGRATION_DATABASE_URL = process.env.MIGRATION_DATABASE_URL;

async function main() {
  const { eq } = await import('drizzle-orm');
  const s = await import('../db/schema');
  const { owner, seedBase, entitledCtx, createAppUser, setModule, closeAll } = await import('../test/harness');
  const { hireEmployee } = await import('../core/org');
  const { setCompensation } = await import('../core/comp');
  const { createMovementEvent } = await import('../core/movement');
  const { setEmploymentTestRecord } = await import('../core/employment-test-record');
  const { createBatch, generatePayslips, closeBatch } = await import('../packs/payroll/service');
  const { requirePackFor } = await import('../localization/registry');
  const { todayInKualaLumpur } = await import('../lib/hr-date');
  const { previousPayrollComparisonPeriod } = await import('../lib/payroll-period-comparison');
  const { payrollComparisonSpec } = await import('../core/report-payroll-comparison');
  const { saveCustomReport, runPayrollComparisonReport } = await import('../core/custom-reports');
  try {
    const prior = await readFile(destination, 'utf8').then(JSON.parse, () => null);
    if (prior) {
      const [tenant] = await owner.db.select({ id: s.tenant.id }).from(s.tenant).where(eq(s.tenant.id, prior.tenantId));
      if (!tenant) throw new Error('Stale fixture output: recreate the named DB and output together.');
      const result = await runPayrollComparisonReport({ ...await entitledCtx(prior), grants: [{ role: 'hr_admin', companyId: null }] }, [prior.companyId],
        { id: prior.reportId, filters: { currentPeriod: prior.currentPeriod, previousPeriod: prior.previousPeriod } });
      if (!result.result.available || result.result.rows.length !== 2) throw new Error('Existing fixture no longer matches its paid-result contract.');
      console.log('Existing fictional Board 1 payroll fixture validated without re-seeding.');
      return;
    }
    const b = await seedBase();
    await setModule(b.tenantId, 'payroll', 'active');
    await setModule(b.tenantId, 'typed_pay_components', 'disabled');
    const ctx = { ...await entitledCtx(b), grants: [{ role: 'hr_admin', companyId: null }] };
    const date = todayInKualaLumpur(), currentPeriod = previousPayrollComparisonPeriod(date.slice(0, 7));
    const previousPeriod = previousPayrollComparisonPeriod(currentPeriod);
    await owner.db.update(s.tenant).set({ name: 'Fictional Board 1 Acceptance' }).where(eq(s.tenant.id, b.tenantId));
    await owner.db.update(s.company).set({ legalName: 'Fictional Board 1 Operations', companyLabel: 'BOARD1' }).where(eq(s.company.id, b.companyId));
    await owner.db.update(s.appUser).set({ onboardedAt: new Date() }).where(eq(s.appUser.id, b.adminUserId));
    const people: Record<string, { employmentId: string; personId: string; userId: string }> = {};
    for (const [key, name, code, icNumber] of [
      ['increase', 'Fictional Amina 李', '00001001', '900101011231'],
      ['unchanged', '=Fictional Beatrice', '00001002', '900101011232'],
      ['newHire', 'Fictional Chandra', '00001003', '900101011233'],
    ] as const) {
      const hiredOn = (key === 'newHire' ? currentPeriod : previousPeriod) + '-01';
      const person = await hireEmployee(ctx, { person: { fullName: name, primaryEmail: `board1-${key}@example.test` },
        companyId: b.companyId, departmentId: key === 'unchanged' ? b.deptB : b.deptA,
        employmentType: 'full_time', employeeCode: code, hiredOn });
      await setEmploymentTestRecord(ctx, { employmentId: person.employmentId, isTestRecord: true });
      await setCompensation(ctx, { employmentId: person.employmentId, basicSalary: 3000, effectiveFrom: hiredOn });
      await requirePackFor('MY').statutory.set(ctx, { personId: person.personId, icNumber });
      const userId = await createAppUser(b.tenantId, person.personId, 'employee');
      await owner.db.update(s.appUser).set({ onboardedAt: new Date() }).where(eq(s.appUser.id, userId));
      people[key] = { ...person, userId };
    }
    const previous = await createBatch(ctx, { companyId: b.companyId, payPeriod: previousPeriod });
    await generatePayslips(ctx, { batchId: previous.batchId });
    await closeBatch(ctx, { batchId: previous.batchId });
    await createMovementEvent(ctx, { employmentId: people.increase.employmentId, kind: 'increment', effectiveDate: currentPeriod + '-01', basicSalary: 3200,
      remarks: 'Fictional recorded increase for app acceptance' });
    const current = await createBatch(ctx, { companyId: b.companyId, payPeriod: currentPeriod });
    await generatePayslips(ctx, { batchId: current.batchId });
    const report = await saveCustomReport(ctx, { name: 'Fictional Board 1 Paid Basic comparison', datasetId: 'payroll_period_comparison',
      spec: payrollComparisonSpec(), companyIds: [b.companyId] });
    const result = await runPayrollComparisonReport(ctx, [b.companyId], { id: report.id, filters: { currentPeriod, previousPeriod } });
    if (!result.result.available || result.result.rows.length !== 2) throw new Error('Fixture paid-result contract failed.');
    await mkdir('/private/tmp/aihr-board1-remaining4-20261021', { recursive: true, mode: 0o700 });
    await writeFile(destination, JSON.stringify({ ...b, date, currentPeriod, previousPeriod, reportId: report.id, people, previous, current,
      notice: 'Fictional disposable local records only; Payroll generated through its public service.' }, null, 2), { mode: 0o600, flag: 'wx' });
    console.log('Created fictional Board 1 paid results; local identifiers saved privately.');
  } finally { await closeAll(); }
}
main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
