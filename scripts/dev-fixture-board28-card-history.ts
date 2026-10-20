/** Fictional Board 28 journeys. Refuses every database except its named disposable local one. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
const destination = '/private/tmp/aihr-board28/fixture.json';
for (const raw of [process.env.DATABASE_URL, process.env.MIGRATION_DATABASE_URL]) {
  const url = new URL(raw || '');
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.port !== '5433' || url.pathname !== '/ai_hr_board28_browser' || url.search || url.hash)
    throw new Error('Only the named disposable local Board 28 database is allowed.');
}
if (process.env.NODE_ENV === 'production') throw new Error('Development fixture only.');
process.env.TEST_DATABASE_URL = process.env.DATABASE_URL;
process.env.TEST_MIGRATION_DATABASE_URL = process.env.MIGRATION_DATABASE_URL;
async function main() {
  const { eq, and } = await import('drizzle-orm');
  const s = await import('../db/schema');
  const { owner, seedBase, createAppUser, adminCtx, closeAll } = await import('../test/harness');
  const { hireEmployee } = await import('../core/org');
  const { setEmploymentTestRecord } = await import('../core/employment-test-record');
  const { createCompany, createDepartment } = await import('../core/admin');
  const { checkIn, checkOut, requestAttendanceCorrection, decideAttendanceCorrection, cancelAttendanceApplication, saveAttendanceWorkflow, setAttendanceWorkflowEnabled, setEmploymentCardId } = await import('../packs/attendance/service');
  const { createShift, assignDefaultShift } = await import('../core/roster');
  const { resolveEntitlementsTx } = await import('../core/entitlements');
  const { todayInKualaLumpur } = await import('../lib/hr-date');
  type Context = import('../db/client').SessionContext;
  try {
    const prior = await readFile(destination, 'utf8').then(JSON.parse, () => null);
    if (prior) {
      const [base] = await owner.db.select({ id: s.tenant.id }).from(s.tenant).where(eq(s.tenant.id, prior.tenantId));
      if (!base) throw new Error('Existing fixture output is stale; recreate the named database and remove its fixture output together.');
      console.log('Existing fictional Board 28 fixture preserved.'); return;
    }
    const b = await seedBase(), root = adminCtx(b), date = todayInKualaLumpur();
    await owner.db.update(s.company).set({ legalName: 'Fictional Board 28 Operations', companyLabel: 'BOARD28' }).where(eq(s.company.id, b.companyId));
    await owner.db.update(s.department).set({ name: 'Fictional Board 28 Applicants' }).where(eq(s.department.id, b.deptA));
    const foreignCompany = await createCompany(root, { legalName: 'Fictional Board 28 Restricted Company', companyLabel: 'BOARD28-FOREIGN', country: 'MY', currency: 'MYR' });
    const foreignDepartment = await createDepartment(root, { companyId: foreignCompany.id, name: 'Fictional restricted team' });
    const people: Record<string, { employmentId: string; personId: string; userId: string; employeeCode: string }> = {};
    const contexts: Record<string, Context> = {};
    for (const [key, role, code] of [
      ['Employee', 'employee', '00002801'], ['SecondEmployee', 'employee', '00002802'], ['First', 'employee', '00002803'],
      ['Second', 'employee', '00002804'], ['HR', 'hr_admin', '00002805'], ['Foreign', 'employee', '00002806'],
    ] as const) {
      const companyId = key === 'Foreign' ? foreignCompany.id : b.companyId;
      const hired = await hireEmployee(root, { person: { fullName: `Fictional Board 28 ${key}`, primaryEmail: `board28-${key.toLowerCase()}@example.test` }, companyId,
        departmentId: key === 'Foreign' ? foreignDepartment.id : b.deptA, employeeCode: code, employmentType: 'full_time', hiredOn: '2020-01-01' });
      await setEmploymentTestRecord(root, { employmentId: hired.employmentId, isTestRecord: true });
      const userId = await createAppUser(b.tenantId, hired.personId, role);
      await owner.db.update(s.appUser).set({ onboardedAt: new Date() }).where(eq(s.appUser.id, userId));
      await owner.db.update(s.roleAssignment).set({ companyId }).where(eq(s.roleAssignment.appUserId, userId));
      const entitlements = await owner.db.transaction(tx => resolveEntitlementsTx(tx, b.tenantId));
      contexts[key] = { tenantId: b.tenantId, userId, personId: hired.personId, roles: [role], grants: [{ role, companyId }], entitlements };
      people[key] = { ...hired, userId, employeeCode: code };
    }
    await setEmploymentCardId(root, { employmentId: people.SecondEmployee.employmentId, cardId: '00004560' });
    await setEmploymentCardId(root, { employmentId: people.Foreign.employmentId, cardId: '00009999' });
    const shift = await createShift(root, { companyId: b.companyId, code: 'BOARD28_DAY', name: 'Fictional Board 28 day shift', startTime: '08:00', endTime: '17:00', breakMinutes: 60, weeklyPattern: [0, 1, 2, 3, 4, 5, 6] });
    for (const key of ['Employee', 'SecondEmployee']) await assignDefaultShift(root, { employmentId: people[key].employmentId, shiftId: shift.id });
    const requests: Record<string, string> = {};
    // Preserve a pre-workflow request, then freeze two different modes for the newer journeys.
    for (const [key, offset, mode] of [['legacy', -3, null], ['sequential', -2, 'sequential'], ['anyOne', -1, 'any_one']] as const) {
      const on = new Date(Date.parse(`${date}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
      if (mode) {
        await saveAttendanceWorkflow(root, { companyId: b.companyId, routingVersion: 3, code: `BOARD28_${key}`, name: `Fictional Board 28 ${key}`, applicationType: 'irregularity', active: true,
          priority: key === 'anyOne' ? 200 : 100, criteria: { employeeIds: [people.Employee.employmentId] },
          stages: [{ name: 'Recorded first review', mode, source: { kind: 'specific_employee', employmentIds: [people.First.employmentId, people.Second.employmentId] }, hrAlternative: false },
            { name: 'Recorded HR review', mode: 'sequential', source: { kind: 'specific_employee', employmentIds: [people.HR.employmentId] }, hrAlternative: false }] });
        await setAttendanceWorkflowEnabled(root, b.companyId, 'irregularity', true);
      }
      await checkIn(root, { employmentId: people.Employee.employmentId, date: on, time: '08:00', manual: true });
      await checkOut(root, { employmentId: people.Employee.employmentId, date: on, time: '16:00', manual: true });
      requests[key] = (await requestAttendanceCorrection(contexts.Employee, { employmentId: people.Employee.employmentId, date: on, checkIn: '09:00', checkOut: '18:00', requestKind: 'short_hours', reason: `Fictional Board 28 ${key} correction` })).correctionId;
    }
    for (const [index, key] of ['approved', 'rejected', 'cancelled', 'withdrawn', 'absent', 'incomplete_entry', 'self_overtime'].entries()) {
      const on = new Date(Date.parse(`${date}T00:00:00Z`) - (index + 4) * 86_400_000).toISOString().slice(0, 10);
      if (key !== 'absent') await checkIn(root, { employmentId: people.SecondEmployee.employmentId, date: on, time: '08:00', manual: true });
      if (!['absent', 'incomplete_entry'].includes(key)) await checkOut(root, { employmentId: people.SecondEmployee.employmentId, date: on, time: '17:00', manual: true });
      const proposed = key === 'self_overtime' ? { requestedOtMinutes: 60, requestKind: 'self_overtime' as const } : { checkIn: '08:00', checkOut: '17:00', requestKind: key === 'absent' ? 'absent' as const : key === 'incomplete_entry' ? 'incomplete_entry' as const : 'other' as const };
      requests[key] = (await requestAttendanceCorrection(contexts.SecondEmployee, { employmentId: people.SecondEmployee.employmentId, date: on, ...proposed, reason: `Fictional Board 28 ${key} example` })).correctionId;
      if (['approved', 'cancelled'].includes(key)) await decideAttendanceCorrection(contexts.HR, { correctionId: requests[key], decision: 'approved', remarks: 'Fictional verified outcome' });
      if (key === 'rejected') await decideAttendanceCorrection(contexts.HR, { correctionId: requests[key], decision: 'rejected', rejectReason: 'Fictional rejected example' });
      if (key === 'cancelled' || key === 'withdrawn') await cancelAttendanceApplication(contexts.HR, { correctionId: requests[key], kind: key, reason: 'Fictional cancellation history' });
    }
    const [admin] = await owner.db.select().from(s.appUser).where(and(eq(s.appUser.id, b.adminUserId), eq(s.appUser.tenantId, b.tenantId)));
    await owner.db.update(s.appUser).set({ onboardedAt: new Date() }).where(eq(s.appUser.id, admin.id));
    await mkdir('/private/tmp/aihr-board28', { recursive: true, mode: 0o700 });
    await writeFile(destination, JSON.stringify({ notice: 'Fictional disposable local records only.', tenantId: b.tenantId, companyId: b.companyId, foreignCompanyId: foreignCompany.id, adminUserId: admin.id, date, people, requests }, null, 2), { mode: 0o600, flag: 'wx' });
    console.log('Created fictional Board 28 fixture; local identifiers saved privately.');
  } finally { await closeAll(); }
}
main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
