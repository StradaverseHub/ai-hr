import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { checkIn, checkOut, requestAttendanceCorrection, addAttendanceCorrectionAttachment, decideAttendanceCorrection, listAttendanceCorrections } from '../core/attendance';
import { saveAttendanceWorkflow, setAttendanceWorkflowEnabled } from '../core/attendance-workflow';
import { attendanceApplicationDetail, listAttendanceApplicationHistory } from '../core/attendance-application-history';
import { decideAttendanceHistorySelection } from '../packs/attendance/history-decisions';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, createAppUser, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
beforeAll(migrateTestDb); afterAll(closeAll);
beforeEach(async () => { await resetDb(); b = await seedBase(); });
async function actor(name: string) {
  const hired = await hireEmployee(adminCtx(b), { person: { fullName: name, primaryEmail: `${randomUUID()}@history-review.test` }, companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: '2020-01-01' });
  const userId = await createAppUser(b.tenantId, hired.personId, 'employee');
  const ctx: SessionContext = { ...adminCtx(b), userId, personId: hired.personId, roles: ['employee'], grants: [{ role: 'employee', companyId: b.companyId }] };
  return { ...hired, userId, ctx };
}
async function fixture(mode: 'sequential' | 'any_one' = 'sequential', withOt = false) {
  const root = adminCtx(b), worker = await actor('Fictional request employee'), first = await actor('Fictional first reviewer'), second = await actor('Fictional second reviewer');
  const date = todayInKualaLumpur();
  await checkIn(root, { employmentId: worker.employmentId, date, time: '08:00', manual: true });
  await checkOut(root, { employmentId: worker.employmentId, date, time: '17:00', manual: true });
  await saveAttendanceWorkflow(root, { companyId: b.companyId, routingVersion: 3, code: 'HISTORY_REVIEW', name: 'Saved history review route', applicationType: 'irregularity', priority: 100, criteria: { employeeIds: [worker.employmentId] }, active: true,
    stages: [{ name: 'Review', mode, source: { kind: 'specific_employee', employmentIds: [first.employmentId, second.employmentId] }, hrAlternative: false }] });
  await setAttendanceWorkflowEnabled(root, b.companyId, 'irregularity', true);
  const { correctionId: id } = await requestAttendanceCorrection(worker.ctx, { employmentId: worker.employmentId, date, checkIn: '09:00', checkOut: '18:00', ...(withOt ? { requestedOtMinutes: 60 } : {}), reason: 'Fictional recorded evidence' });
  return { root, worker, first, second, id };
}
const projection = (ctx: SessionContext, id: string) => withTenant(ctx, tx => tx.execute(sql`select * from app.attendance_workflow_review_participants(${id}::uuid)`));
describe('Request-bound history review and original Overview visibility', () => {
  it('keeps future participants readable but read-only and never grants general HR history', async () => {
    const f = await fixture('sequential', true), unrelated = await actor('Fictional unrelated employee');
    await addAttendanceCorrectionAttachment(f.worker.ctx, { correctionId: f.id, fileName: 'fictional-history-review.png', mimeType: 'image/png', content: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aTUkAAAAASUVORK5CYII=', 'base64') });
    const current = await listAttendanceCorrections(f.first.ctx, { companyIds: [b.companyId], status: 'pending' });
    const future = await listAttendanceCorrections(f.second.ctx, { companyIds: [b.companyId], status: 'pending' });
    expect(current.find(row => row.id === f.id)).toMatchObject({ canDecide: true, hasAttachment: true });
    expect(future.find(row => row.id === f.id)).toMatchObject({ canDecide: false, hasAttachment: true, requestedOtMinutes: 60, systemOtMinutes: null, canReadRawComparison: false });
    expect((await listAttendanceCorrections(unrelated.ctx, { companyIds: [b.companyId], status: 'pending' })).map(row => row.id)).not.toContain(f.id);
    await expect(listAttendanceApplicationHistory(f.second.ctx, [b.companyId], { status: 'pending' })).rejects.toThrow();
    expect(await projection(f.second.ctx, f.id)).toHaveLength(0);
    await expect(decideAttendanceCorrection(f.second.ctx, { correctionId: f.id, decision: 'approved', expectedStageIndex: 0, expectedParticipantSlot: '0:1' })).rejects.toThrow();
    await decideAttendanceCorrection(f.first.ctx, { correctionId: f.id, decision: 'approved', expectedStageIndex: 0, expectedParticipantSlot: '0:0' });
    expect((await listAttendanceCorrections(f.second.ctx, { companyIds: [b.companyId], status: 'pending' })).find(row => row.id === f.id)).toMatchObject({ canDecide: true });
    const detail = await attendanceApplicationDetail(f.root, [b.companyId], f.id);
    expect(detail?.application.status).toBe('pending');
    expect(detail?.progress).toMatchObject({ state: 'pending', level: 1, next: [{ name: 'Fictional second reviewer', eligible: true }] });
  });
  it('reports every eligible any-one actor without confusing an additional login with a revoked saved login', async () => {
    const f = await fixture('any_one');
    await createAppUser(b.tenantId, f.first.personId, 'employee');
    let detail = await attendanceApplicationDetail(f.root, [b.companyId], f.id);
    expect(detail?.progress?.next.filter(actor => actor.eligible).map(actor => actor.name)).toEqual(['Fictional first reviewer', 'Fictional second reviewer']);
    await owner.db.update(schema.appUser).set({ archivedAt: new Date() }).where(eq(schema.appUser.id, f.first.userId));
    detail = await attendanceApplicationDetail(f.root, [b.companyId], f.id);
    expect(detail?.progress?.next.find(actor => actor.name === 'Fictional first reviewer')?.eligible).toBe(false);
    expect(detail?.progress?.next.find(actor => actor.name === 'Fictional second reviewer')?.eligible).toBe(true);
    expect((await listAttendanceCorrections(f.first.ctx, { companyIds: [b.companyId], status: 'pending' })).map(row => row.id)).not.toContain(f.id);
    await expect(decideAttendanceCorrection(f.first.ctx, { correctionId: f.id, decision: 'approved', expectedStageIndex: 0, expectedParticipantSlot: '0:0' })).rejects.toThrow();
  });
  it('keeps scoped HR request IDs identical to the old reader and refuses foreign tenant/request probes', async () => {
    const f = await fixture();
    const old = await listAttendanceCorrections(f.root, { companyIds: [b.companyId], status: 'pending' });
    const history = await listAttendanceApplicationHistory(f.root, [b.companyId], { status: 'pending', pageSize: 100 });
    expect(history.rows.map(row => row.id).sort()).toEqual(old.map(row => row.id).sort());
    expect(await projection(f.root, randomUUID())).toHaveLength(0);
    const [otherCompany] = await owner.db.insert(schema.company).values({ tenantId: b.tenantId, legalName: 'Fictional other company scope' }).returning();
    const otherHr = await actor('Fictional other company HR');
    await owner.db.update(schema.roleAssignment).set({ role: 'hr_admin', companyId: otherCompany.id }).where(eq(schema.roleAssignment.appUserId, otherHr.userId));
    const otherScope: SessionContext = { ...otherHr.ctx, roles: ['hr_admin'], grants: [{ role: 'hr_admin', companyId: otherCompany.id }] };
    expect(await projection(otherScope, f.id)).toHaveLength(0);
    expect(await attendanceApplicationDetail(otherScope, [b.companyId], f.id)).toBeNull();
    const foreign = await seedBase();
    expect(await projection(adminCtx(foreign), f.id)).toHaveLength(0);
    expect(await attendanceApplicationDetail(adminCtx(foreign), [b.companyId], f.id)).toBeNull();
  });
  it('does not advertise a revoked assignment as the next sequential actor or skip it', async () => {
    const f = await fixture();
    await owner.db.delete(schema.roleAssignment).where(eq(schema.roleAssignment.appUserId, f.first.userId));
    const detail = await attendanceApplicationDetail(f.root, [b.companyId], f.id);
    expect(detail?.progress).toMatchObject({ state: 'unresolved', next: [{ name: 'Fictional first reviewer', eligible: false }] });
    expect(detail?.progress?.next.some(actor => actor.name === 'Fictional second reviewer')).toBe(false);
    expect((await listAttendanceCorrections(f.first.ctx, { companyIds: [b.companyId], status: 'pending' })).map(row => row.id)).not.toContain(f.id);
  });
  it('binds HR bulk decisions to the reviewed v3 participant as well as the level', async () => {
    const f = await fixture();
    await owner.db.update(schema.roleAssignment).set({ role: 'hr_admin', companyId: b.companyId }).where(eq(schema.roleAssignment.appUserId, f.first.userId));
    const hr: SessionContext = { ...f.first.ctx, roles: ['hr_admin'], grants: [{ role: 'hr_admin', companyId: b.companyId }] };
    const listing = await listAttendanceApplicationHistory(hr, [b.companyId], { status: 'pending' });
    expect(listing.rows.find(row => row.id === f.id)).toMatchObject({ selectable: true, currentParticipantSlot: '0:0' });
    for (const participantSlot of [undefined, '0:1']) {
      expect(await decideAttendanceHistorySelection(hr, [b.companyId], { items: [{ id: f.id, stage: 0, participantSlot }], decision: 'approved', reason: 'Fictional reviewed selection' }))
        .toMatchObject([{ id: f.id, status: 'failed' }]);
    }
    expect((await attendanceApplicationDetail(f.root, [b.companyId], f.id))?.workflow?.participantDecisions).toHaveLength(0);
    expect(await decideAttendanceHistorySelection(hr, [b.companyId], { items: [{ id: f.id, stage: 0, participantSlot: '0:0' }], decision: 'approved', reason: 'Fictional reviewed selection' }))
      .toMatchObject([{ id: f.id, status: 'pending' }]);
    expect((await attendanceApplicationDetail(f.root, [b.companyId], f.id))?.workflow?.participantDecisions).toHaveLength(1);
  });
  it('retains a hybrid HR and employee participant request outside that person’s HR company scope', async () => {
    const f = await fixture();
    const [hrCompany] = await owner.db.insert(schema.company).values({ tenantId: b.tenantId, legalName: 'Fictional separate HR company' }).returning();
    await owner.db.update(schema.roleAssignment).set({ companyId: b.companyId }).where(eq(schema.roleAssignment.appUserId, f.first.userId));
    await owner.db.insert(schema.roleAssignment).values({ tenantId: b.tenantId, appUserId: f.first.userId, role: 'hr_admin', companyId: hrCompany.id });
    const hybrid: SessionContext = { ...f.first.ctx, roles: ['employee', 'hr_admin'], grants: [{ role: 'employee', companyId: b.companyId }, { role: 'hr_admin', companyId: hrCompany.id }] };
    const pending = await listAttendanceCorrections(hybrid, { companyIds: [hrCompany.id], status: 'pending' });
    expect(pending.find(row => row.id === f.id)).toMatchObject({ canDecide: true });
    expect((await listAttendanceApplicationHistory(hybrid, [hrCompany.id], { status: 'pending' })).rows).toHaveLength(0);
    expect(await projection(hybrid, f.id)).toHaveLength(0);
    await expect(decideAttendanceCorrection(hybrid, { correctionId: f.id, decision: 'approved', expectedStageIndex: 0, expectedParticipantSlot: '0:0' })).resolves.toMatchObject({ status: 'pending' });
  });
});
