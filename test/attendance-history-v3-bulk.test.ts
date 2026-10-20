import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { hireEmployee } from '../core/org';
import { checkIn, checkOut, requestAttendanceCorrection } from '../core/attendance';
import { saveAttendanceWorkflow, setAttendanceWorkflowEnabled } from '../core/attendance-workflow';
import { attendanceApplicationDetail, listAttendanceApplicationHistory } from '../core/attendance-application-history';
import { decideAttendanceHistorySelection } from '../packs/attendance/history-decisions';
import type { SessionContext } from '../db/client';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, createAppUser, closeAll, migrateTestDb, resetDb, seedBase, type Base } from './harness';

let b: Base;
beforeAll(migrateTestDb); afterAll(closeAll);
beforeEach(async () => { await resetDb(); b = await seedBase(); });
it('carries the observed v3 participant through HR bulk review and refuses an omitted or changed slot', async () => {
  const root = adminCtx(b), date = todayInKualaLumpur();
  async function actor(name: string, role: 'employee' | 'hr_admin') {
    const employee = await hireEmployee(root, { person: { fullName: name, primaryEmail: `${randomUUID()}@bulk-v3.test` }, companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: '2020-01-01' });
    const userId = await createAppUser(b.tenantId, employee.personId, role);
    const ctx: SessionContext = { ...root, userId, personId: employee.personId, roles: [role], grants: [{ role, companyId: null }] };
    return { ...employee, ctx };
  }
  const applicant = await actor('Fictional bulk applicant', 'employee'), first = await actor('Fictional HR participant', 'hr_admin'), second = await actor('Fictional later participant', 'employee');
  await checkIn(root, { employmentId: applicant.employmentId, date, time: '08:00', manual: true });
  await checkOut(root, { employmentId: applicant.employmentId, date, time: '17:00', manual: true });
  await saveAttendanceWorkflow(root, { companyId: b.companyId, routingVersion: 3, code: 'BULK_V3', name: 'Fictional bulk route', applicationType: 'irregularity', priority: 100, criteria: { employeeIds: [applicant.employmentId] }, active: true,
    stages: [{ name: 'Sequential review', mode: 'sequential', source: { kind: 'specific_employee', employmentIds: [first.employmentId, second.employmentId] }, hrAlternative: false }] });
  await setAttendanceWorkflowEnabled(root, b.companyId, 'irregularity', true);
  const { correctionId: id } = await requestAttendanceCorrection(applicant.ctx, { employmentId: applicant.employmentId, date, checkIn: '09:00', checkOut: '18:00', reason: 'Fictional bulk correction' });
  const listing = await listAttendanceApplicationHistory(first.ctx, [b.companyId], { status: 'pending' });
  expect(listing.rows.find(row => row.id === id)).toMatchObject({ selectable: true, currentParticipantSlot: '0:0' });
  // HR authority alone does not replace this route's individually assigned participant.
  expect((await listAttendanceApplicationHistory(root, [b.companyId], { status: 'pending' })).rows.find(row => row.id === id)).toMatchObject({ selectable: false, currentParticipantSlot: null });
  for (const participantSlot of [undefined, '0:1']) {
    expect(await decideAttendanceHistorySelection(first.ctx, [b.companyId], { items: [{ id, stage: 0, participantSlot }], decision: 'approved', reason: 'Fictional review' })).toMatchObject([{ id, status: 'failed' }]);
  }
  expect((await attendanceApplicationDetail(root, [b.companyId], id))?.workflow?.participantDecisions).toHaveLength(0);
  expect(await decideAttendanceHistorySelection(first.ctx, [b.companyId], { items: [{ id, stage: 0, participantSlot: '0:0' }], decision: 'approved', reason: 'Fictional review' })).toMatchObject([{ id, status: 'pending' }]);
  const after = await attendanceApplicationDetail(root, [b.companyId], id);
  expect(after?.application.status).toBe('pending'); expect(after?.workflow?.currentStage).toBe(0); expect(after?.workflow?.participantDecisions).toHaveLength(1);
  expect(await decideAttendanceHistorySelection(first.ctx, [b.companyId], { items: [{ id, stage: 0, participantSlot: '0:0' }], decision: 'approved', reason: 'Fictional duplicate' })).toMatchObject([{ id, status: 'failed' }]);
  expect((await attendanceApplicationDetail(root, [b.companyId], id))?.workflow?.participantDecisions).toHaveLength(1);
});
