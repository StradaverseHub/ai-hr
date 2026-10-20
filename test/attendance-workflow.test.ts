import {listPendingTasks} from '../core/approvals-inbox';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, asc, eq, sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { hireEmployee, setReportingLine } from '../core/org';
import { checkIn, checkOut, requestAttendanceCorrection, decideAttendanceCorrection, cancelAttendanceApplication, cancelOwnAttendanceCorrection, cancelPlannedOvertime, listAttendanceCorrections, allowanceScheduleFactsTx } from '../core/attendance';
import { createMovementEvent } from '../core/movement';
import { createShift, assignDefaultShift } from '../core/roster';
import { createAttendanceRule } from '../packs/attendance/service';
import { getScheduleRotation, saveScheduleRotation } from '../core/attendance-rotation';
import { todayInKualaLumpur } from '../lib/hr-date';
import { attendanceClockData } from '../core/attendance-clock-data';
import { AttendancePayrollClosedError } from '../core/attendance-punch-change';
import { saveAttendanceWorkflow, setAttendanceWorkflowEnabled, listAttendanceWorkflows, previewAttendanceWorkflow } from '../core/attendance-workflow';
import { listAttendanceApplicationHistory, attendanceApplicationDetail, attendanceApplicationFilterOptions } from '../core/attendance-application-history';
import { createBatch, generatePayslips } from '../packs/payroll/service';
import { setCompensation } from '../core/comp';
import type { AttendanceWorkflowInput } from '../lib/attendance-workflow';
import { adminCtx, createAppUser, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
let b: Base;
const date = '2026-07-15';
beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async () => { await resetDb(); b = await seedBase(); });
async function hire(name: string, departmentId = b.deptA) {
    return hireEmployee(adminCtx(b), { person: { fullName: name, primaryEmail: `${randomUUID()}@workflow.test` }, companyId: b.companyId, departmentId, employmentType: 'full_time', hiredOn: '2020-01-01' });
}
async function login(personId: string, role: 'manager' | 'employee'): Promise<SessionContext> {
    const userId = await createAppUser(b.tenantId, personId, role);
    return { ...adminCtx(b), userId, personId, roles: [role], grants: [{ role, companyId: b.companyId }] };
}
async function fixture() {
    const a = adminCtx(b), worker = await hire('Workflow worker'), manager = await hire('Frozen manager', b.deptB);
    await setReportingLine(a, { subordinateEmploymentId: worker.employmentId, managerEmploymentId: manager.employmentId, lineType: 'administrative', validFrom: '2020-01-01' });
    const mgr = await login(manager.personId, 'manager'), self = await login(worker.personId, 'employee');
    await checkIn(a, { employmentId: worker.employmentId, date, time: '08:00', manual: true });
    await checkOut(a, { employmentId: worker.employmentId, date, time: '17:00', manual: true });
    return { a, worker, manager, mgr, self };
}
function input(stages: ('direct_manager' | 'hr_admin')[] = ['direct_manager', 'hr_admin'], overrides: Partial<AttendanceWorkflowInput> = {}): AttendanceWorkflowInput {
    return { companyId: b.companyId, code: 'CLOCK', name: 'Clock review', description: 'Verified routing', applicationType: 'irregularity', priority: 100, criteria: { departmentIds: [b.deptA] }, stages: stages.map((kind, i) => ({ name: `Review ${i + 1}`, level: { kind, employmentId: null, alternates: [] } })), active: true, ...overrides };
}
async function enable(a: SessionContext, value = input()) {
    const template = await saveAttendanceWorkflow(a, value);
    await setAttendanceWorkflowEnabled(a, b.companyId, value.applicationType, true);
    return template;
}
async function submit(a: SessionContext, employmentId: string) {
    return (await requestAttendanceCorrection(a, { employmentId, date, checkIn: '09:00', checkOut: '18:00', reason: 'Verified clock correction' })).correctionId;
}
const day = async (employmentId: string) => (await owner.db.select().from(schema.attendance).where(and(eq(schema.attendance.employmentId, employmentId), eq(schema.attendance.attendanceDate, date))))[0];
const correction = async (id: string) => (await owner.db.select().from(schema.attendanceCorrection).where(eq(schema.attendanceCorrection.id, id)))[0];
const decisions = async () => owner.db.select().from(schema.attendanceWorkflowDecision).orderBy(asc(schema.attendanceWorkflowDecision.stageIndex));
const events = async (id: string, type: string) => owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId, id), eq(schema.domainEvent.eventType, type))).orderBy(asc(schema.domainEvent.sequence));
describe('Attendance approval routing and exactly-once effects', () => {
    it('persists multi-valued assignments, matches alternatives within each field and requires every filled field', async () => {
        const { a, worker, manager } = await fixture();
        const units = await owner.db.insert(schema.businessUnit).values(['A', 'B'].map(code => ({ tenantId: b.tenantId, companyId: b.companyId, code: `WF_${code}`, name: `Workflow unit ${code}` }))).returning();
        const grades = await owner.db.insert(schema.jobGrade).values(['A', 'B'].map(code => ({ tenantId: b.tenantId, code: `WF_${code}`, name: `Workflow grade ${code}` }))).returning();
        await owner.db.insert(schema.profileOption).values(['North', 'South'].map(value => ({ tenantId: b.tenantId, category: 'division', value, label: value })));
        const unit = (code: string) => units.find(row => row.code === `WF_${code}`)!;
        const grade = (code: string) => grades.find(row => row.code === `WF_${code}`)!;
        for (const [employee, code, division] of [[worker, 'A', 'North'], [manager, 'B', 'South']] as const) {
            await owner.db.update(schema.assignment).set({ businessUnitId: unit(code).id }).where(eq(schema.assignment.employmentId, employee.employmentId));
            await owner.db.update(schema.employment).set({ gradeId: grade(code).id, orgDivision: division }).where(eq(schema.employment.id, employee.employmentId));
        }
        const criteria = { departmentIds: [b.deptA, b.deptB], businessUnitIds: [unit('A').id, unit('B').id], gradeIds: [grade('A').id, grade('B').id], orgDivision: ['North', 'South'] };
        const value = input(['hr_admin'], { criteria });
        const saved = await saveAttendanceWorkflow(a, value);
        const reopened = (await listAttendanceWorkflows(a, [b.companyId])).find(row => row.lineageId === saved.lineageId)!;
        expect(reopened.criteria).toEqual(criteria);
        const matching = await previewAttendanceWorkflow(a, value, saved.lineageId);
        expect(new Set(matching.rows.map(row => row.employmentId))).toEqual(new Set([worker.employmentId, manager.employmentId]));
        for (const restriction of [{ departmentIds: [b.deptA] }, { businessUnitIds: [unit('A').id] }, { gradeIds: [grade('A').id] }, { orgDivision: ['North'] }]) {
            const preview = await previewAttendanceWorkflow(a, { ...value, criteria: { ...criteria, ...restriction } }, saved.lineageId);
            expect(preview.rows.map(row => row.employmentId)).toEqual([worker.employmentId]);
        }
        await expect(saveAttendanceWorkflow(a, { ...value, criteria: { departmentIds: [randomUUID()] } }, saved.lineageId)).rejects.toMatchObject({ code: 'invalid' });
        expect((await listAttendanceWorkflows(a, [b.companyId])).find(row => row.lineageId === saved.lineageId)?.version).toBe(1);
    });
    it('does not let an any-one alternative skip a later level or approve the current level twice', async () => {
        const { a, worker, mgr } = await fixture();
        const value = input(); value.stages[0].level.alternates = [{ kind: 'hr_admin', employmentId: null }];
        await enable(a, value);
        const id = await submit(a, worker.employmentId);
        await expect(decideAttendanceCorrection(a, { correctionId: id, decision: 'approved', expectedStageIndex: 1 })).rejects.toThrow();
        await decideAttendanceCorrection(a, { correctionId: id, decision: 'approved', expectedStageIndex: 0 });
        expect((await correction(id)).status).toBe('pending');
        await expect(decideAttendanceCorrection(mgr, { correctionId: id, decision: 'approved', expectedStageIndex: 0 })).rejects.toThrow();
        expect(await decisions()).toHaveLength(1);
        await decideAttendanceCorrection(a, { correctionId: id, decision: 'approved', expectedStageIndex: 1 });
        expect((await correction(id)).status).toBe('approved');
    });
    it('keeps routing off by default and preserves a pre-enablement pending request', async () => {
        const { a, worker } = await fixture();
        const id = await submit(a, worker.employmentId);
        await enable(a);
        await decideAttendanceCorrection(a, { correctionId: id, decision: 'approved' });
        expect((await correction(id)).status).toBe('approved');
        expect(await owner.db.select().from(schema.attendanceWorkflowRequest)).toHaveLength(0);
        expect((await day(worker.employmentId)).checkInAt).toBe('09:00:00');
    });
    it('freezes stages/version, advances without an effect, and applies only the final stage', async () => {
        const { a, worker, mgr } = await fixture();
        const template = await enable(a), id = await submit(a, worker.employmentId);
        expect((await previewAttendanceWorkflow(a, input(), template.lineageId)).rows.map(r => r.employmentId)).toEqual([worker.employmentId]);
        await saveAttendanceWorkflow(a, input(['hr_admin'], { name: 'Changed after submission' }), template.lineageId);
        const first = await decideAttendanceCorrection(mgr, { correctionId: id, decision: 'approved', expectedStageIndex: 0, remarks: 'Manager checked source' });
        expect(first.status).toBe('pending');
        expect((await day(worker.employmentId)).checkInAt).toBe('08:00:00');
        expect(await events(id, 'attendance-correction.effect.recorded')).toHaveLength(0);
        const frozen = await attendanceApplicationDetail(a, [b.companyId], id);
        expect(frozen?.workflow?.templateVersion).toBe(1);
        expect(frozen?.workflow?.stages.map(s => s.name)).toEqual(['Review 1', 'Review 2']);
        expect(frozen?.workflow?.decisions[0]).toMatchObject({ actualPersonId: mgr.personId, actualUserId: mgr.userId, actingMode: 'assigned', resultingStatus: 'pending', remarks: 'Manager checked source' });
        await expect(decideAttendanceCorrection(mgr, { correctionId: id, decision: 'approved', expectedStageIndex: 1 })).rejects.toThrow(/assigned approver/);
        await decideAttendanceCorrection(a, { correctionId: id, decision: 'approved', expectedStageIndex: 1 });
        expect((await day(worker.employmentId)).checkInAt).toBe('09:00:00');
        expect(await decisions()).toHaveLength(2);
        expect(await events(id, 'attendance-correction.effect.recorded')).toHaveLength(1);
        expect((await listAttendanceWorkflows(a, [b.companyId]))[0].version).toBe(2);
    });
    it('fails closed when enabled scope has no match and does not leave an orphan request', async () => {
        const { a, worker } = await fixture();
        await enable(a, input(['hr_admin'], { criteria: { departmentIds: [b.deptB] } }));
        await expect(submit(a, worker.employmentId)).rejects.toMatchObject({ code: 'noMatch' });
        expect(await owner.db.select().from(schema.attendanceCorrection)).toHaveLength(0);
    });
    it('refuses overlapping same-priority activation and also rejects a database-injected tie at submission', async () => {
        const { a, worker } = await fixture();
        await enable(a, input(['hr_admin']));
        await expect(saveAttendanceWorkflow(a, input(['hr_admin'], { code: 'TIE' }))).rejects.toMatchObject({ code: 'overlap' });
        await owner.db.insert(schema.attendanceWorkflowTemplate).values({ tenantId: b.tenantId, ...input(['hr_admin'], { code: 'INJECTED' }), lineageId: randomUUID(), version: 1 });
        await expect(submit(a, worker.employmentId)).rejects.toMatchObject({ code: 'tie' });
        expect(await owner.db.select().from(schema.attendanceCorrection)).toHaveLength(0);
    });
    it('refuses missing, inactive and cyclic managers rather than dropping a stage', async () => {
        const { a, worker, manager } = await fixture();
        await owner.db.update(schema.employment).set({ terminatedOn: '2021-01-01' }).where(eq(schema.employment.id, manager.employmentId));
        await expect(saveAttendanceWorkflow(a, input())).rejects.toMatchObject({ code: 'unresolved' });
        await owner.db.update(schema.employment).set({ terminatedOn: null }).where(eq(schema.employment.id, manager.employmentId));
        // Inject a graph cycle as owner: the ordinary org writer correctly refuses cycles itself.
        await owner.db.insert(schema.reportingLine).values({ tenantId: b.tenantId, subordinateEmploymentId: manager.employmentId, managerEmploymentId: worker.employmentId, lineType: 'administrative', validFrom: '2020-01-01' });
        await expect(saveAttendanceWorkflow(a, input())).rejects.toMatchObject({ code: 'unresolved' });
    });
    it('permits any one alternative, records HR acting on behalf, and bans self approval', async () => {
        const { a, worker, self } = await fixture();
        const value = input(['direct_manager']);
        value.stages[0].level.alternates = [{ kind: 'hr_admin', employmentId: null }];
        await enable(a, value);
        const id = await submit(self, worker.employmentId);
        await expect(decideAttendanceCorrection(self, { correctionId: id, decision: 'approved', expectedStageIndex: 0 })).rejects.toThrow(/own/);
        await decideAttendanceCorrection(a, { correctionId: id, decision: 'approved', expectedStageIndex: 0 });
        expect((await decisions())[0]).toMatchObject({ assignedKind: 'hr_admin', actingMode: 'assigned', actualUserId: a.userId });
    });
    it('serializes concurrent clicks against the stage shown to the user', async () => {
        const { a, worker } = await fixture();
        await enable(a, input(['hr_admin', 'hr_admin']));
        const id = await submit(a, worker.employmentId);
        const result = await Promise.allSettled([0, 1].map(() => decideAttendanceCorrection(a, { correctionId: id, decision: 'approved', expectedStageIndex: 0 })));
        expect(result.filter(r => r.status === 'fulfilled')).toHaveLength(1);
        expect(await decisions()).toHaveLength(1);
        expect((await correction(id)).status).toBe('pending');
        expect(await events(id, 'attendance-correction.effect.recorded')).toHaveLength(0);
        await decideAttendanceCorrection(a, { correctionId: id, decision: 'approved', expectedStageIndex: 1 });
        await expect(decideAttendanceCorrection(a, { correctionId: id, decision: 'approved', expectedStageIndex: 1 })).rejects.toThrow(/already approved/);
        expect(await events(id, 'attendance-correction.effect.recorded')).toHaveLength(1);
    });
    it('keeps a frozen manager after an org move and allows scoped HR handoff', async () => {
        const { a, worker, mgr } = await fixture();
        await enable(a, input(['direct_manager']));
        const id = await submit(a, worker.employmentId), next = await hire('New manager', b.deptB), nextCtx = await login(next.personId, 'manager');
        await setReportingLine(a, { subordinateEmploymentId: worker.employmentId, managerEmploymentId: next.employmentId, lineType: 'administrative', validFrom: '2020-01-01' });
        await expect(decideAttendanceCorrection(nextCtx, { correctionId: id, decision: 'approved', expectedStageIndex: 0 })).rejects.toThrow(/assigned approver/);
        await expect(decideAttendanceCorrection(mgr, { correctionId: id, decision: 'approved', expectedStageIndex: 0 })).rejects.toThrow();
        await decideAttendanceCorrection(a, { correctionId: id, decision: 'approved', expectedStageIndex: 0 });
        expect((await decisions())[0]).toMatchObject({ actingMode: 'administrator' });
    });
    it('separates company/type enablement and preserves an immutable rejected trail', async () => {
        const { a, worker } = await fixture();
        await enable(a, input(['hr_admin']));
        const id = await submit(a, worker.employmentId);
        await decideAttendanceCorrection(a, { correctionId: id, decision: 'rejected', rejectReason: 'Clock evidence is incomplete', expectedStageIndex: 0 });
        expect((await correction(id)).rejectReason).toBe('Clock evidence is incomplete');
        expect((await day(worker.employmentId)).checkInAt).toBe('08:00:00');
        await expect(cancelAttendanceApplication(a, { correctionId: id, kind: 'cancelled', reason: 'No longer needed' })).rejects.toThrow(/pending or approved/);
        const ot = await requestAttendanceCorrection(a, { employmentId: worker.employmentId, date, requestedOtMinutes: 60, requestKind: 'self_overtime', reason: 'Separate application type' });
        expect((await attendanceApplicationDetail(a, [b.companyId], ot.correctionId))?.workflow).toBeNull();
        const [decision] = await decisions();
        await expect(owner.db.update(schema.attendanceWorkflowDecision).set({ remarks: 'Tampered' }).where(eq(schema.attendanceWorkflowDecision.id, decision.id))).rejects.toThrow();
        expect((await decisions())[0].remarks).toBe(decision.remarks);
    });
});
async function delegationWorld(scope = 'attendance.correction', expired = false, departmentId?: string) {
    const f = await fixture(), stand = await hire('Acting delegate', b.deptB), standSub = await hire('Delegate own report', b.deptB);
    await setReportingLine(f.a, { subordinateEmploymentId: standSub.employmentId, managerEmploymentId: stand.employmentId, lineType: 'administrative', validFrom: '2020-01-01' });
    const delegate = await login(stand.personId, 'manager');
    await setReportingLine(f.a, { subordinateEmploymentId: f.manager.employmentId, managerEmploymentId: stand.employmentId, lineType: 'delegate', validFrom: '2020-01-01', validTo: expired ? '2021-01-01' : null, reason: 'Temporary cover', scopes: [{ module: 'attendance', taskType: scope }], orgScope: departmentId ? { companyId: b.companyId, departmentId, businessUnitId: null } : undefined });
    return { ...f, delegate };
}
describe('request-bound delegated final effects', () => {
    it('finalizes exactly once without granting the delegate personnel/pay visibility', async () => {
        const { a, worker, manager, delegate } = await delegationWorld();
        await enable(a, input(['direct_manager']));
        const id = await submit(a, worker.employmentId);
        const read = () => withTenant(delegate, tx => tx.select().from(schema.employment).where(eq(schema.employment.id, worker.employmentId)));
        expect((await listAttendanceCorrections(delegate, { status: 'pending' })).map(row => row.id)).toContain(id);
        await expect(withTenant(delegate, tx => tx.update(schema.attendanceCorrection).set({ reason: 'Forged delegate edit' }).where(eq(schema.attendanceCorrection.id, id)))).rejects.toThrow();
        expect((await correction(id)).reason).toBe('Verified clock correction');
        expect(await read()).toHaveLength(0); // Non-vacuity: the actor really has delegation-only access.
        await decideAttendanceCorrection(delegate, { correctionId: id, decision: 'approved', expectedStageIndex: 0 });
        expect(await read()).toHaveLength(0);
        expect(await withTenant(delegate, tx => tx.select().from(schema.payslip).where(eq(schema.payslip.employmentId, worker.employmentId)))).toHaveLength(0);
        expect((await day(worker.employmentId)).checkInAt).toBe('09:00:00');
        expect((await decisions())[0]).toMatchObject({ assignedEmploymentId: manager.employmentId, actualPersonId: delegate.personId, actualUserId: delegate.userId, actingMode: 'delegate' });
        expect((await events(id, 'attendance-correction.effect.recorded'))[0].actorId).toBe(delegate.userId);
        expect((await events(id, 'attendance-correction.approved'))[0].payload).toMatchObject({ effectAuthorityRestored: true, actualUserId: delegate.userId });
        await expect(decideAttendanceCorrection(delegate, { correctionId: id, decision: 'approved', expectedStageIndex: 0 })).rejects.toThrow(/already/);
        expect(await events(id, 'attendance-correction.effect.recorded')).toHaveLength(1);
        const identity = await withTenant(delegate, tx => tx.execute(sql `select app.current_user_id() as id`));
        expect(identity[0].id).toBe(delegate.userId);
        expect(await withTenant(delegate, tx => tx.execute(sql `select * from app.attendance_workflow_effect_identity(${randomUUID()}::uuid,0)`))).toHaveLength(0);
    });
    it.each([['leave.request', false], ['attendance.correction', true]] as const)('refuses wrong task or expired delegation (%s / %s)', async (task, expired) => {
        const { a, worker, delegate } = await delegationWorld(task, expired);
        await enable(a, input(['direct_manager']));
        const id = await submit(a, worker.employmentId);
        await expect(decideAttendanceCorrection(delegate, { correctionId: id, decision: 'approved', expectedStageIndex: 0 })).rejects.toThrow();
        expect(await decisions()).toHaveLength(0);
        expect((await day(worker.employmentId)).checkInAt).toBe('08:00:00');
    });
    it('rolls back a failed final effect and restores the actor context', async () => {
        const { a, worker, delegate } = await delegationWorld();
        await enable(a, input(['direct_manager']));
        const raw = await attendanceClockData(a, worker.employmentId, date);
        const { correctionId: id } = await requestAttendanceCorrection(a, { employmentId: worker.employmentId, date, reason: 'Stale after new clocking', clockChanges: { version: 1, baseline: raw.baseline, entries: [] } });
        await checkIn(a, { employmentId: worker.employmentId, date, time: '18:30', manual: true });
        await expect(decideAttendanceCorrection(delegate, { correctionId: id, decision: 'approved', expectedStageIndex: 0 })).rejects.toThrow(/Clock data changed/);
        expect(await decisions()).toHaveLength(0);
        expect((await correction(id)).status).toBe('pending');
        expect(await withTenant(delegate, tx => tx.select().from(schema.employment).where(eq(schema.employment.id, worker.employmentId)))).toHaveLength(0);
        expect((await withTenant(delegate, tx => tx.execute(sql `select app.current_user_id() as id`)))[0].id).toBe(delegate.userId);
    });
});
describe('scoped application history and reversible cancellation', () => {
    it('filters the canonical applications, paginates deterministically and refuses cross-tenant/admin access', async () => {
        const { a, worker, self } = await fixture();
        const id = await submit(a, worker.employmentId);
        const history = await listAttendanceApplicationHistory(a, [b.companyId], { departmentId: b.deptA, applicationType: 'irregularity', query: id.slice(0, 8), pageSize: 10 });
        expect(history.total).toBe(1);
        expect(history.rows.map(r => r.id)).toEqual([id]);
        expect((await listAttendanceApplicationHistory(a, [b.companyId], { departmentId: b.deptB })).total).toBe(0);
        expect((await listAttendanceApplicationHistory(a, [b.companyId], { page: 2, pageSize: 10 })).rows).toEqual([]);
        await expect(listAttendanceApplicationHistory(self, [b.companyId])).rejects.toThrow(/administrator/);
        const other = adminCtx(await seedBase());
        expect(await attendanceApplicationDetail(other, [b.companyId], id)).toBeNull();
        expect(await withTenant(other, tx => tx.select().from(schema.attendanceWorkflowRequest))).toHaveLength(0);
        await expect(listAttendanceApplicationHistory(a, [b.companyId], { submittedFrom: '2026-02-31' })).rejects.toThrow(/valid submission date/);
    });
    it('restores only the recorded effect, preserves decisions, and distinguishes cancelled from withdrawn', async () => {
        const { a, worker } = await fixture();
        await enable(a, input(['hr_admin']));
        const before = await day(worker.employmentId), id = await submit(a, worker.employmentId);
        await decideAttendanceCorrection(a, { correctionId: id, decision: 'approved', expectedStageIndex: 0 });
        const trail = await decisions();
        expect(await cancelAttendanceApplication(a, { correctionId: id, kind: 'cancelled', reason: 'Approved in error' })).toEqual({ status: 'cancelled', reversed: true });
        const after = await day(worker.employmentId);
        expect([after.checkInAt, after.checkOutAt, after.workedMinutes, after.otMinutes]).toEqual([before.checkInAt, before.checkOutAt, before.workedMinutes, before.otMinutes]);
        expect(await decisions()).toEqual(trail);
        expect((await correction(id))).toMatchObject({ status: 'cancelled', cancellationKind: 'cancelled', cancellationReason: 'Approved in error' });
        expect((await listAttendanceApplicationHistory(a, [b.companyId], { status: 'cancelled' })).rows.map(r => r.id)).toEqual([id]);
        expect((await listAttendanceApplicationHistory(a, [b.companyId], { status: 'withdrawn' })).total).toBe(0);
        expect((await attendanceClockData(a, worker.employmentId, date)).rows.filter(p => !p.voidedAt).map(p => p.punchAt)).toEqual(['08:00:00', '17:00:00']);
    });
    it('never reverses later attendance edits or erases historical decisions', async () => {
        const { a, worker } = await fixture();
        await enable(a, input(['hr_admin']));
        const first = await submit(a, worker.employmentId);
        await decideAttendanceCorrection(a, { correctionId: first, decision: 'approved', expectedStageIndex: 0 });
        const second = await requestAttendanceCorrection(a, { employmentId: worker.employmentId, date, checkIn: '10:00', checkOut: '19:00', reason: 'Later verified update' });
        await decideAttendanceCorrection(a, { correctionId: second.correctionId, decision: 'approved', expectedStageIndex: 0 });
        await expect(cancelAttendanceApplication(a, { correctionId: first, kind: 'withdrawn', reason: 'Would destroy later evidence' })).rejects.toThrow(/later approval|changed since/);
        expect((await day(worker.employmentId)).checkInAt).toBe('10:00:00');
        expect(await decisions()).toHaveLength(2);
    });
    it('refuses an approved reversal in closed payroll but permits withdrawing a pending request', async () => {
        const { a, worker } = await fixture();
        await enable(a, input(['hr_admin']));
        const id = await submit(a, worker.employmentId);
        await decideAttendanceCorrection(a, { correctionId: id, decision: 'approved', expectedStageIndex: 0 });
        await setCompensation(a, { employmentId: worker.employmentId, basicSalary: 4000, monthlyAllowance: 0, effectiveFrom: '2020-01-01' });
        const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-07', scope: {employmentIds: [worker.employmentId]} });
        await generatePayslips(a, { batchId });
        expect(await owner.db.select({id: schema.payslip.id}).from(schema.payslip).where(and(eq(schema.payslip.batchId, batchId), eq(schema.payslip.employmentId, worker.employmentId)))).toHaveLength(1);
        await owner.db.update(schema.payrollBatch).set({ status: 'closed' }).where(eq(schema.payrollBatch.id, batchId));
        await expect(cancelAttendanceApplication(a, { correctionId: id, kind: 'cancelled', reason: 'Closed payroll reversal' })).rejects.toBeInstanceOf(AttendancePayrollClosedError);
        const pending = await submit(a, worker.employmentId);
        expect(await cancelAttendanceApplication(a, { correctionId: pending, kind: 'withdrawn', reason: 'Pending request not needed' })).toMatchObject({ reversed: false });
        expect((await correction(id)).status).toBe('approved');
    });
});
describe('live non-self approver validation', () => {
    it('refuses a manager without a live login or role grant at activation and submission', async () => {
        const { a, worker, mgr } = await fixture();
        await owner.db.update(schema.appUser).set({ archivedAt: new Date() }).where(eq(schema.appUser.id, mgr.userId!));
        await expect(saveAttendanceWorkflow(a, input())).rejects.toMatchObject({ code: 'unresolved' });
        await owner.db.update(schema.appUser).set({ archivedAt: null }).where(eq(schema.appUser.id, mgr.userId!));
        await enable(a, input(['direct_manager']));
        await owner.db.delete(schema.roleAssignment).where(eq(schema.roleAssignment.appUserId, mgr.userId!));
        await expect(submit(a, worker.employmentId)).rejects.toMatchObject({ code: 'unresolved' });
        expect(await owner.db.select().from(schema.attendanceCorrection)).toHaveLength(0);
    });
    it('refuses same-person routing across employments and a missing manager', async () => {
        const { a, worker } = await fixture();
        const rehire = await hireEmployee(a, { person: { id: worker.personId }, companyId: b.companyId, departmentId: b.deptB, employmentType: 'full_time', hiredOn: '2020-01-01' });
        await owner.db.update(schema.reportingLine).set({ managerEmploymentId: rehire.employmentId }).where(eq(schema.reportingLine.subordinateEmploymentId, worker.employmentId));
        await expect(saveAttendanceWorkflow(a, input())).rejects.toMatchObject({ code: 'unresolved' });
        await owner.db.update(schema.reportingLine).set({ supersededAt: new Date() }).where(eq(schema.reportingLine.subordinateEmploymentId, worker.employmentId));
        await expect(saveAttendanceWorkflow(a, input())).rejects.toMatchObject({ code: 'unresolved' });
    });
    it('blocks sole-HR self dead ends on activation and rechecks on submission', async () => {
        const { a, worker, mgr } = await fixture();
        const ownHrUser = await createAppUser(b.tenantId, worker.personId, 'hr_admin');
        const ownHr: SessionContext = { ...a, userId: ownHrUser, personId: worker.personId, grants: [{ role: 'hr_admin', companyId: b.companyId }] };
        const template = await enable(a, input(['hr_admin']));
        await owner.db.update(schema.appUser).set({ archivedAt: new Date() }).where(eq(schema.appUser.id, b.adminUserId));
        await expect(submit(ownHr, worker.employmentId)).rejects.toMatchObject({ code: 'unresolved' });
        await expect(saveAttendanceWorkflow(ownHr, input(['hr_admin']), template.lineageId)).rejects.toMatchObject({ code: 'unresolved' });
        const alternative = input(['direct_manager']);
        alternative.stages[0].level.alternates = [{ kind: 'hr_admin', employmentId: null }];
        await saveAttendanceWorkflow(ownHr, alternative, template.lineageId);
        const id = await submit(ownHr, worker.employmentId);
        await expect(decideAttendanceCorrection(ownHr, { correctionId: id, decision: 'approved', expectedStageIndex: 0 })).rejects.toThrow(/own/);
        await decideAttendanceCorrection(mgr, { correctionId: id, decision: 'approved', expectedStageIndex: 0 });
        expect((await correction(id)).status).toBe('approved');
    });
    it('requires valid active templates before enabling, selects priority and keeps disabled pending routes frozen', async () => {
        const { a, worker, mgr } = await fixture();
        await expect(setAttendanceWorkflowEnabled(a, b.companyId, 'irregularity', true)).rejects.toThrow(/activate valid/);
        await enable(a);
        await saveAttendanceWorkflow(a, input(['hr_admin'], { code: 'FIRST', priority: 90 }));
        const id = await submit(a, worker.employmentId);
        expect((await attendanceApplicationDetail(a, [b.companyId], id))?.workflow?.templateCode).toBe('FIRST');
        await setAttendanceWorkflowEnabled(a, b.companyId, 'irregularity', false);
        const legacy = (await requestAttendanceCorrection(a, {employmentId: worker.employmentId, date: '2026-07-14', checkIn: '09:00', checkOut: '18:00', reason: 'Distinct legacy day after routing was disabled'})).correctionId;
        expect((await attendanceApplicationDetail(a, [b.companyId], legacy))?.workflow).toBeNull();
        await expect(decideAttendanceCorrection(mgr, { correctionId: id, decision: 'approved', expectedStageIndex: 0 })).rejects.toThrow(/assigned approver/);
        await decideAttendanceCorrection(a, { correctionId: id, decision: 'approved', expectedStageIndex: 0 });
    });
});
describe('delegation scope, database guards and failed effects', () => {
    it('refuses delegation outside the employee organisation and omits it from the inbox', async () => {
        const { a, worker, delegate } = await delegationWorld('attendance.correction', false, b.deptB);
        await enable(a, input(['direct_manager']));
        const id = await submit(a, worker.employmentId);
        expect((await listAttendanceCorrections(delegate, { status: 'pending' })).map(row => row.id)).not.toContain(id);
        await expect(decideAttendanceCorrection(delegate, { correctionId: id, decision: 'approved', expectedStageIndex: 0 })).rejects.toThrow();
        expect(await decisions()).toHaveLength(0);
    });
    it('cannot mutate application payload or advance a stage directly under delegation-only RLS', async () => {
        const { a, worker, delegate } = await delegationWorld();
        await enable(a, input(['direct_manager', 'hr_admin']));
        const id = await submit(a, worker.employmentId);
        const [flow] = await owner.db.select().from(schema.attendanceWorkflowRequest).where(eq(schema.attendanceWorkflowRequest.correctionId, id));
        await expect(withTenant(delegate, tx => tx.update(schema.attendanceCorrection).set({ proposedCheckIn: '01:00', status: 'approved' }).where(eq(schema.attendanceCorrection.id, id)))).rejects.toThrow();
        await expect(withTenant(delegate, tx => tx.update(schema.attendanceWorkflowRequest).set({ currentStage: 1 }).where(eq(schema.attendanceWorkflowRequest.id, flow.id)))).rejects.toThrow();
        expect((await correction(id))).toMatchObject({ proposedCheckIn: '09:00:00', status: 'pending' });
        expect(await decisions()).toHaveLength(0);
        await decideAttendanceCorrection(delegate, { correctionId: id, decision: 'approved', expectedStageIndex: 0 });
        await expect(withTenant(delegate, tx => tx.update(schema.attendanceCorrection).set({ status: 'approved', decidedAt: new Date() }).where(eq(schema.attendanceCorrection.id, id)))).rejects.toThrow();
        expect((await correction(id)).status).toBe('pending');
    });
    it('restores identity and rolls back the stage when PostgreSQL aborts the delegated effect subtransaction', async () => {
        const { a, worker, delegate } = await delegationWorld();
        await enable(a, input(['direct_manager']));
        const id = await submit(a, worker.employmentId);
        // Generated fixture UUID is the only interpolated value in this owner-only fault injector.
        await owner.db.execute(sql.raw(`CREATE FUNCTION public.test_attendance_workflow_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.employment_id='${worker.employmentId}'::uuid THEN RAISE EXCEPTION 'Injected attendance SQL failure'; END IF; RETURN NEW; END $$`));
        await owner.db.execute(sql `CREATE TRIGGER test_attendance_workflow_failure BEFORE UPDATE ON attendance FOR EACH ROW EXECUTE FUNCTION public.test_attendance_workflow_failure()`);
        try {
            await expect(decideAttendanceCorrection(delegate, { correctionId: id, decision: 'approved', expectedStageIndex: 0 })).rejects.toThrow();
            expect(await decisions()).toHaveLength(0);
            expect(await events(id, 'attendance-correction.effect.recorded')).toHaveLength(0);
            expect((await correction(id)).status).toBe('pending');
            expect((await day(worker.employmentId)).checkInAt).toBe('08:00:00');
            expect((await withTenant(delegate, tx => tx.execute(sql `select app.current_user_id() as id`)))[0].id).toBe(delegate.userId);
            expect(await withTenant(delegate, tx => tx.select().from(schema.employment).where(eq(schema.employment.id, worker.employmentId)))).toHaveLength(0);
        }
        finally {
            await owner.db.execute(sql `DROP TRIGGER test_attendance_workflow_failure ON attendance`);
            await owner.db.execute(sql `DROP FUNCTION public.test_attendance_workflow_failure()`);
        }
        await decideAttendanceCorrection(delegate, { correctionId: id, decision: 'approved', expectedStageIndex: 0 });
        expect(await events(id, 'attendance-correction.effect.recorded')).toHaveLength(1);
    });
});
describe('all history filters and protected cancellation', () => {
    it('applies company, business unit, grade, division, submission dates and status server-side', async () => {
        const { a, worker } = await fixture();
        const [unit] = await owner.db.insert(schema.businessUnit).values({ tenantId: b.tenantId, companyId: b.companyId, code: 'FILTER', name: 'History unit' }).returning();
        const [grade] = await owner.db.insert(schema.jobGrade).values({ tenantId: b.tenantId, code: 'FILTER', name: 'History grade' }).returning();
        await owner.db.update(schema.assignment).set({ businessUnitId: unit.id }).where(eq(schema.assignment.employmentId, worker.employmentId));
        await owner.db.update(schema.employment).set({ gradeId: grade.id, orgDivision: 'History division' }).where(eq(schema.employment.id, worker.employmentId));
        const id = await submit(a, worker.employmentId);
        await owner.db.update(schema.attendanceCorrection).set({ createdAt: new Date('2026-07-16T16:15:00Z') }).where(eq(schema.attendanceCorrection.id, id));
        const filters = { companyId: b.companyId, businessUnitId: unit.id, gradeId: grade.id, division: 'History division', submittedFrom: '2026-07-17', submittedTo: '2026-07-17', status: 'pending' as const };
        expect((await listAttendanceApplicationHistory(a, [b.companyId], filters)).rows.map(row => row.id)).toEqual([id]);
        for (const other of [{ businessUnitId: randomUUID() }, { gradeId: randomUUID() }, { division: 'Other division' }, { submittedFrom: '2026-07-18' }, { submittedTo: '2026-07-16' }, { status: 'approved' as const }, { companyId: randomUUID() }]) {
            expect((await listAttendanceApplicationHistory(a, [b.companyId], other)).total).toBe(0);
        }
        const options = await attendanceApplicationFilterOptions(a, [b.companyId]);
        expect(options.businessUnits.map(row => row.id)).toContain(unit.id);
        expect(options.grades.map(row => row.id)).toContain(grade.id);
    });
    it('does not grant same-tenant sibling-company history from a forged company list', async () => {
        const { a, worker } = await fixture();
        const [company] = await owner.db.insert(schema.company).values({ tenantId: b.tenantId, legalName: 'Private sibling' }).returning();
        const [department] = await owner.db.insert(schema.department).values({ tenantId: b.tenantId, companyId: company.id, name: 'Private team' }).returning();
        const foreign = await hireEmployee(a, { person: { fullName: 'Other company worker', primaryEmail: `${randomUUID()}@workflow.test` }, companyId: company.id, departmentId: department.id, employmentType: 'full_time', hiredOn: '2020-01-01' });
        const ownId = await submit(a, worker.employmentId);
        const foreignId = await submit(a, foreign.employmentId);
        const scoped: SessionContext = { ...a, roles: undefined, grants: [{ role: 'hr_admin', companyId: b.companyId }] };
        expect((await listAttendanceApplicationHistory(scoped, [b.companyId, company.id])).rows.map(row => row.id)).toEqual([ownId]);
        expect(await attendanceApplicationDetail(scoped, [b.companyId, company.id], foreignId)).toBeNull();
        await expect(saveAttendanceWorkflow(scoped, input(['hr_admin'], { companyId: company.id, criteria: { departmentIds: [department.id] } }))).rejects.toMatchObject({ code: 'scope' });
    });
    it('preserves a partial approval when the employee withdraws the pending application', async () => {
        const { a, worker, mgr, self } = await fixture();
        await enable(a);
        const id = await submit(self, worker.employmentId);
        await decideAttendanceCorrection(mgr, { correctionId: id, decision: 'approved', expectedStageIndex: 0 });
        const trail = await decisions();
        await cancelOwnAttendanceCorrection(self, { correctionId: id });
        expect(await decisions()).toEqual(trail);
        expect((await correction(id))).toMatchObject({ status: 'cancelled', cancellationKind: 'withdrawn' });
        await expect(decideAttendanceCorrection(a, { correctionId: id, decision: 'approved', expectedStageIndex: 1 })).rejects.toThrow();
        expect((await day(worker.employmentId)).checkInAt).toBe('08:00:00');
    });
    it('protects dependent Leave Credits without erasing the attendance approval', async () => {
        const { a, worker } = await fixture();
        await enable(a, input(['hr_admin']));
        const id = await submit(a, worker.employmentId);
        await decideAttendanceCorrection(a, { correctionId: id, decision: 'approved', expectedStageIndex: 0 });
        const [credit] = await owner.db.insert(schema.toilAccrual).values({ tenantId: b.tenantId, employmentId: worker.employmentId, workedDate: date, dayType: 'workday', otMinutes: 60, daysCredited: '1.00', accrualBasis: 'hours_worked', expiresOn: '2027-07-15', source: 'hr_manual_grant' }).returning();
        await expect(cancelAttendanceApplication(a, { correctionId: id, kind: 'cancelled', reason: 'Would orphan a credit' })).rejects.toThrow(/dependent Leave Credit/);
        expect((await correction(id)).status).toBe('approved');
        expect((await day(worker.employmentId)).checkInAt).toBe('09:00:00');
        expect((await owner.db.select().from(schema.toilAccrual).where(eq(schema.toilAccrual.id, credit.id)))[0].status).toBe('active');
        expect(await decisions()).toHaveLength(1);
    });
    it('rolls back final workflow approval and effects when payroll is closed', async () => {
        const { a, worker, mgr } = await fixture();
        await enable(a);
        const id = await submit(a, worker.employmentId);
        await decideAttendanceCorrection(mgr, { correctionId: id, decision: 'approved', expectedStageIndex: 0 });
        await setCompensation(a, { employmentId: worker.employmentId, basicSalary: 4000, monthlyAllowance: 0, effectiveFrom: '2020-01-01' });
        const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-07', scope: {employmentIds: [worker.employmentId]} });
        await generatePayslips(a, { batchId });
        expect(await owner.db.select({id: schema.payslip.id}).from(schema.payslip).where(and(eq(schema.payslip.batchId, batchId), eq(schema.payslip.employmentId, worker.employmentId)))).toHaveLength(1);
        await owner.db.update(schema.payrollBatch).set({ status: 'closed' }).where(eq(schema.payrollBatch.id, batchId));
        await expect(decideAttendanceCorrection(a, { correctionId: id, decision: 'approved', expectedStageIndex: 1 })).rejects.toBeInstanceOf(AttendancePayrollClosedError);
        expect(await decisions()).toHaveLength(1);
        expect((await correction(id)).status).toBe('pending');
        expect((await day(worker.employmentId)).checkInAt).toBe('08:00:00');
        expect(await events(id, 'attendance-correction.effect.recorded')).toHaveLength(0);
        expect((await attendanceApplicationDetail(a, [b.companyId], id))?.workflow?.currentStage).toBe(1);
    });
});
describe('usable any-one alternatives', () => {
    it('keeps a usable HR alternative when the manager is unavailable, but never drops the stage', async () => {
        const { a, worker, manager } = await fixture();
        await owner.db.update(schema.employment).set({ terminatedOn: '2021-01-01' }).where(eq(schema.employment.id, manager.employmentId));
        const any = input(['direct_manager']);
        any.stages[0].level.alternates = [{ kind: 'hr_admin', employmentId: null }];
        await enable(a, any);
        const id = await submit(a, worker.employmentId);
        const detail = await attendanceApplicationDetail(a, [b.companyId], id);
        expect(detail?.workflow?.stages).toHaveLength(1);
        expect(detail?.workflow?.stages[0].approvers).toEqual([{ kind: 'hr_admin', employmentId: null, name: 'HR administrators' }]);
        await decideAttendanceCorrection(a, { correctionId: id, decision: 'approved', expectedStageIndex: 0 });
        expect((await day(worker.employmentId)).checkInAt).toBe('09:00:00');
        expect(await decisions()).toHaveLength(1);
    });
});
describe('current authority over a frozen company snapshot', () => {
    it('lets destination-company HR finish after an entity move without rewriting the original workflow company', async () => {
        const { a, worker } = await fixture();
        await enable(a, input(['direct_manager']));
        const id = await submit(a, worker.employmentId);
        const [destination] = await owner.db.insert(schema.company).values({ tenantId: b.tenantId, legalName: 'Destination entity' }).returning();
        const [department] = await owner.db.insert(schema.department).values({ tenantId: b.tenantId, companyId: destination.id, name: 'Destination team' }).returning();
        const destinationManager = await hireEmployee(a, {person: {fullName: 'Destination manager', primaryEmail: `${randomUUID()}@workflow.test`}, companyId: destination.id, departmentId: department.id, employmentType: 'full_time', hiredOn: '2020-01-01'});
        await createMovementEvent(a, {employmentId: worker.employmentId, kind: 'entityTransfer', effectiveDate: todayInKualaLumpur(), companyId: destination.id, departmentId: department.id, managerEmploymentId: destinationManager.employmentId});
        const hrUser = await createAppUser(b.tenantId, (await hire('Destination HR', b.deptB)).personId, 'hr_admin');
        await owner.db.update(schema.roleAssignment).set({ companyId: destination.id }).where(eq(schema.roleAssignment.appUserId, hrUser));
        const destinationHr: SessionContext = { ...a, userId: hrUser, personId: null, roles: undefined, grants: [{ role: 'hr_admin', companyId: destination.id }] };
        // Resolve the actual HR person rather than trusting a caller-provided decider employment.
        const [actor] = await owner.db.select().from(schema.appUser).where(eq(schema.appUser.id, hrUser));
        destinationHr.personId = actor.personId;
        await decideAttendanceCorrection(destinationHr, { correctionId: id, decision: 'approved', expectedStageIndex: 0 });
        const detail = await attendanceApplicationDetail(destinationHr, [destination.id], id);
        expect(detail?.companyId).toBe(destination.id);
        expect(detail?.workflow?.companyId).toBe(b.companyId);
        expect(detail?.workflow?.decisions[0]).toMatchObject({ actualUserId: hrUser, actingMode: 'administrator' });
        expect((await day(worker.employmentId)).checkInAt).toBe('09:00:00');
    });
});

async function armAttendanceAudit(a: SessionContext, employmentId: string, correctionId: string) {
    // Arm via withTenant, which records the one-way process hint. An owner SQL insert alone would not
    // arm the later app transaction and would make the audit-order oracle vacuous when env defaults off.
    const priorAudit = process.env.AUDIT_HASH_CHAIN_ENABLED;
    try {
        process.env.AUDIT_HASH_CHAIN_ENABLED = 'true';
        await withTenant(a, tx => appendEvent(tx, { tenantId: a.tenantId, aggregateType: 'attendance-correction', aggregateId: correctionId,
            eventType: 'test.attendance.chain.armed', actor: actorOf(a), subjectEmploymentId: employmentId, payload: {} }));
    } finally {
        if (priorAudit === undefined) delete process.env.AUDIT_HASH_CHAIN_ENABLED;
        else process.env.AUDIT_HASH_CHAIN_ENABLED = priorAudit;
    }
    expect((await events(correctionId, 'test.attendance.chain.armed'))[0].chainSeq).not.toBeNull();
}

/** Hold the canonical subject lock on a separate connection. The command must wait here before taking
 * its correction row or tenant audit lock. NOWAIT makes row-order regressions fail without a deadlock. */
async function commandBehindSubjectLock(a: SessionContext, employmentId: string, correctionId: string,
    command: () => Promise<unknown>, beforeRelease?: (tx: Tx) => Promise<void>) {
    await armAttendanceAudit(a, employmentId, correctionId);
    let outcome: Promise<{ value?: unknown; error?: unknown }> | undefined;
    try {
        await owner.db.transaction(async tx => {
            await tx.execute(sql`set local lock_timeout='2s'`);
            const [connection] = await tx.execute(sql`select pg_backend_pid() as pid`) as unknown as { pid: number }[];
            await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${a.tenantId + ':' + employmentId},0))`);
            outcome = command().then(value => ({ value }), error => ({ error }));
            await expect.poll(async () => {
                const [wait] = await owner.db.execute(sql`select exists(select 1 from pg_stat_activity activity
                    where ${connection.pid} = any(pg_blocking_pids(activity.pid))
                      and activity.wait_event_type='Lock' and activity.wait_event='advisory') as blocked`) as unknown as { blocked: boolean }[];
                return wait.blocked;
            }, { timeout: 5000, interval: 10 }).toBe(true);
            const rows = await tx.execute(sql`select id from attendance_correction where id=${correctionId}::uuid for update nowait`);
            expect(rows).toHaveLength(1);
            await tx.execute(sql`select set_config('app.audit_hash_chain','on',true)`);
            await appendEvent(tx, { tenantId: a.tenantId, aggregateType: 'attendance-correction', aggregateId: correctionId,
                eventType: 'test.attendance.lock-order', actor: actorOf(a), subjectEmploymentId: employmentId, payload: {} });
            if (beforeRelease) await beforeRelease(tx);
        });
        return await outcome!;
    } finally {
        // A failed NOWAIT/poll assertion releases the blocker; always drain the started command.
        if (outcome) await outcome;
    }
}

describe('attendance command lock order and historical OT evidence', () => {
    it('waits for a payroll batch before taking tenant audit authority for final approval', async () => {
        const { a, worker } = await fixture();
        await enable(a, input(['hr_admin']));
        const id = await submit(a, worker.employmentId);
        await setCompensation(a, { employmentId: worker.employmentId, basicSalary: 4000, monthlyAllowance: 0, effectiveFrom: '2020-01-01' });
        const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-07', scope: {employmentIds: [worker.employmentId]} });
        await generatePayslips(a, { batchId });
        expect(await owner.db.select({id: schema.payslip.id}).from(schema.payslip).where(and(eq(schema.payslip.batchId, batchId), eq(schema.payslip.employmentId, worker.employmentId)))).toHaveLength(1);
        expect(await owner.db.select().from(schema.payslip).where(and(eq(schema.payslip.batchId, batchId),
            eq(schema.payslip.employmentId, worker.employmentId)))).toHaveLength(1);
        await armAttendanceAudit(a, worker.employmentId, id);
        let approval: Promise<{ error?: unknown }> | undefined;
        try {
            await owner.db.transaction(async tx => {
                await tx.execute(sql`set local lock_timeout='2s'`);
                const [connection] = await tx.execute(sql`select pg_backend_pid() as pid`) as unknown as { pid: number }[];
                await tx.execute(sql`select id from payroll_batch where id=${batchId}::uuid for update`);
                approval = decideAttendanceCorrection(a, { correctionId: id, decision: 'approved', expectedStageIndex: 0 })
                    .then(() => ({}), error => ({ error }));
                await expect.poll(async () => {
                    const [wait] = await owner.db.execute(sql`select exists(select 1 from pg_stat_activity activity
                        where ${connection.pid}=any(pg_blocking_pids(activity.pid)) and activity.wait_event_type='Lock'
                          and activity.query like '%attendance_payroll_protection%') as blocked`) as unknown as { blocked: boolean }[];
                    return wait.blocked;
                }, { timeout: 5000, interval: 10 }).toBe(true);
                // Exact audit trigger key, on a real second session. The old stage event already owned
                // this lock while waiting for our batch: try-lock returned false and closing would deadlock.
                const [audit] = await tx.execute(sql`select pg_try_advisory_xact_lock(hashtext(${'audit-chain:' + a.tenantId})) as acquired`) as unknown as { acquired: boolean }[];
                expect(audit.acquired).toBe(true);
                await tx.execute(sql`select set_config('app.audit_hash_chain','on',true)`);
                await appendEvent(tx, { tenantId: a.tenantId, aggregateType: 'payroll-batch', aggregateId: batchId,
                    eventType: 'test.payroll.batch-audit', actor: actorOf(a), subjectEmploymentId: worker.employmentId, payload: {} });
            });
            expect((await approval!).error).toBeUndefined();
        } finally {
            if (approval) await approval;
        }
        const [stage] = await events(id, 'attendance-workflow.stage.decided');
        const [effect] = await events(id, 'attendance-correction.effect.recorded');
        const [recalc] = await events(batchId, 'payroll-batch.recalc-required');
        expect(await events(id, 'attendance-workflow.stage.decided')).toHaveLength(1);
        expect(stage.actorId).toBe(a.userId);
        expect(stage.chainSeq).not.toBeNull();
        expect(stage.payload).toMatchObject({ decidedAt: (await decisions())[0].decidedAt.toISOString(), actingMode: 'assigned' });
        expect(stage.sequence).toBeGreaterThan(effect.sequence);
        expect(stage.sequence).toBeGreaterThan(recalc.sequence);
        expect((await correction(id)).status).toBe('approved');
        expect((await day(worker.employmentId)).checkInAt).toBe('09:00:00');
    });

    it.each(['decide', 'admin cancel', 'own correction withdraw', 'own OT withdraw'] as const)
        ('takes the subject lock before the correction and audit locks: %s', async action => {
            const { a, worker, self } = await fixture();
            let id: string;
            let command: () => Promise<unknown>;
            if (action === 'own OT withdraw') {
                id = (await requestAttendanceCorrection(self, { employmentId: worker.employmentId, date: '2099-07-15',
                    requestedOtMinutes: 60, requestKind: 'self_overtime', reason: 'Future deferred plan' })).correctionId;
                await decideAttendanceCorrection(a, { correctionId: id, decision: 'approved' });
                command = () => cancelPlannedOvertime(self, { correctionId: id });
            } else {
                await enable(a, input(['hr_admin']));
                id = await submit(self, worker.employmentId);
                command = action === 'decide'
                    ? () => decideAttendanceCorrection(a, { correctionId: id, decision: 'approved', expectedStageIndex: 0 })
                    : action === 'admin cancel'
                        ? () => cancelAttendanceApplication(a, { correctionId: id, kind: 'cancelled', reason: 'No longer needed' })
                        : () => cancelOwnAttendanceCorrection(self, { correctionId: id });
            }
            const result = await commandBehindSubjectLock(a, worker.employmentId, id, command);
            expect(result.error).toBeUndefined();
            expect((await correction(id)).status).toBe(action === 'decide' ? 'approved' : 'cancelled');
            expect(await events(id, 'test.attendance.lock-order')).toHaveLength(1);
            expect(await events(id, 'attendance-correction.effect.recorded')).toHaveLength(action === 'decide' ? 1 : 0);
        });

    it('rechecks landed OT after withdrawal waits behind the landing subject lock', async () => {
        const { a, worker, self } = await fixture();
        const id = (await requestAttendanceCorrection(self, { employmentId: worker.employmentId, date: '2099-07-15',
            requestedOtMinutes: 60, requestKind: 'self_overtime', reason: 'Future deferred plan' })).correctionId;
        await decideAttendanceCorrection(a, { correctionId: id, decision: 'approved' });
        expect((await correction(id)).appliedAt).toBeNull();
        const result = await commandBehindSubjectLock(a, worker.employmentId, id,
            () => cancelPlannedOvertime(self, { correctionId: id }),
            async tx => {
                // The landing winner publishes its stamp while owning the same canonical subject lock.
                await tx.update(schema.attendanceCorrection).set({ appliedAt: new Date(), approvedOtMinutes: 60 })
                    .where(eq(schema.attendanceCorrection.id, id));
            });
        expect(result.error).toBeInstanceOf(Error);
        expect((result.error as Error).message).toMatch(/already been counted/);
        expect((await correction(id))).toMatchObject({ status: 'approved', approvedOtMinutes: 60 });
        expect((await correction(id)).appliedAt).not.toBeNull();
        expect(await events(id, 'attendance-correction.cancelled')).toHaveLength(0);
    });

    it('does not land an approved OT snapshot cancelled by a concurrent legacy writer before its claim', async () => {
        const { a, worker } = await fixture();
        const future = '2099-07-15';
        await checkIn(a, { employmentId: worker.employmentId, date: future, time: '08:00', manual: true });
        const id = (await requestAttendanceCorrection(a, { employmentId: worker.employmentId, date: future,
            requestedOtMinutes: 180, requestKind: 'self_overtime', reason: 'Concurrent cancellation' })).correctionId;
        await decideAttendanceCorrection(a, { correctionId: id, decision: 'approved' });
        await owner.db.update(schema.attendanceCorrection).set({ otApprovalMethod: 'requested' })
            .where(eq(schema.attendanceCorrection.id, id));
        let clockOut: Promise<{ error?: unknown }> | undefined;
        try {
            await owner.db.transaction(async tx => {
                const [connection] = await tx.execute(sql`select pg_backend_pid() as pid`) as unknown as { pid: number }[];
                await tx.execute(sql`select id from attendance_correction where id=${id}::uuid for update`);
                clockOut = checkOut(a, { employmentId: worker.employmentId, date: future, time: '17:00', manual: true })
                    .then(() => ({}), error => ({ error }));
                await expect.poll(async () => {
                    const [wait] = await owner.db.execute(sql`select exists(select 1 from pg_stat_activity activity
                        where ${connection.pid}=any(pg_blocking_pids(activity.pid)) and activity.wait_event_type='Lock'
                          and activity.query like '%attendance_correction%') as blocked`) as unknown as { blocked: boolean }[];
                    return wait.blocked;
                }, { timeout: 5000, interval: 10 }).toBe(true);
                // Owner bypass models a historical writer without the new advisory-lock convention.
                await tx.update(schema.attendanceCorrection).set({ status: 'cancelled' }).where(eq(schema.attendanceCorrection.id, id));
            });
            expect((await clockOut!).error).toBeUndefined();
        } finally {
            if (clockOut) await clockOut;
        }
        expect((await correction(id))).toMatchObject({ status: 'cancelled', appliedAt: null });
        const [worked] = await owner.db.select().from(schema.attendance).where(and(
            eq(schema.attendance.employmentId, worker.employmentId), eq(schema.attendance.attendanceDate, future)));
        expect(worked.checkOutAt).toBe('17:00:00');
        expect(worked.otMinutes).not.toBe(180);
        const landings = await owner.db.select().from(schema.domainEvent).where(and(
            eq(schema.domainEvent.eventType, 'attendance.amended'), sql`${schema.domainEvent.payload}->>'correctionId'=${id}`,
            sql`${schema.domainEvent.payload}->>'otPlanApplied'='true'`));
        expect(landings).toHaveLength(0);
    });

    it('refuses ambiguous legacy approved OT even when appliedAt is null, preserving counted attendance', async () => {
        const { a, worker, self } = await fixture();
        await owner.db.update(schema.attendance).set({ otMinutes: 60 }).where(eq(schema.attendance.employmentId, worker.employmentId));
        const [legacy] = await owner.db.insert(schema.attendanceCorrection).values({ tenantId: b.tenantId,
            employmentId: worker.employmentId, attendanceDate: date, requestedOtMinutes: 60, approvedOtMinutes: 60,
            reason: 'Historical immediate approval', status: 'approved', decidedAt: new Date(), appliedAt: null }).returning();
        const before = await day(worker.employmentId);
        expect(before.otMinutes).toBe(60);
        expect(await events(legacy.id, 'attendance-correction.effect.recorded')).toHaveLength(0);
        await expect(cancelAttendanceApplication(a, { correctionId: legacy.id, kind: 'cancelled', reason: 'Ambiguous historic OT' }))
            .rejects.toThrow(/no reversible effect record/);
        await expect(cancelPlannedOvertime(self, { correctionId: legacy.id, today: date }))
            .rejects.toThrow(/no proof.*uncounted/);
        expect(await day(worker.employmentId)).toEqual(before);
        expect((await correction(legacy.id)).status).toBe('approved');
        expect(await events(legacy.id, 'attendance-correction.cancelled')).toHaveLength(0);
    });

    it('allows admin cancellation of positively proven unlanded deferred OT without creating attendance', async () => {
        const { a, worker } = await fixture();
        const future = '2099-07-15';
        const id = (await requestAttendanceCorrection(a, { employmentId: worker.employmentId, date: future,
            requestedOtMinutes: 60, requestKind: 'self_overtime', reason: 'No longer scheduled' })).correctionId;
        await decideAttendanceCorrection(a, { correctionId: id, decision: 'approved' });
        expect((await correction(id)).appliedAt).toBeNull();
        expect((await events(id, 'attendance-correction.approved'))[0].payload).toMatchObject({ deferred: true });
        expect(await cancelAttendanceApplication(a, { correctionId: id, kind: 'cancelled', reason: 'Plan withdrawn before work' }))
            .toEqual({ status: 'cancelled', reversed: false });
        expect(await owner.db.select().from(schema.attendance).where(and(eq(schema.attendance.employmentId, worker.employmentId),
            eq(schema.attendance.attendanceDate, future)))).toHaveLength(0);
        expect(await events(id, 'attendance-correction.effect.recorded')).toHaveLength(0);
    });

    it('marks processed payroll for recalculation when an approved application is reversed', async () => {
        const { a, worker } = await fixture();
        await enable(a, input(['hr_admin']));
        const before = await day(worker.employmentId), id = await submit(a, worker.employmentId);
        await decideAttendanceCorrection(a, { correctionId: id, decision: 'approved', expectedStageIndex: 0 });
        await setCompensation(a, { employmentId: worker.employmentId, basicSalary: 4000, monthlyAllowance: 0, effectiveFrom: '2020-01-01' });
        const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-07', scope: {employmentIds: [worker.employmentId]} });
        await generatePayslips(a, { batchId });
        expect(await owner.db.select({id: schema.payslip.id}).from(schema.payslip).where(and(eq(schema.payslip.batchId, batchId), eq(schema.payslip.employmentId, worker.employmentId)))).toHaveLength(1);
        const [initial] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
        expect(initial.status).toBe('processed');
        expect(initial.needsRecalcAt).toBeNull();
        expect(await owner.db.select().from(schema.payslip).where(and(eq(schema.payslip.batchId, batchId),
            eq(schema.payslip.employmentId, worker.employmentId)))).toHaveLength(1);
        await cancelAttendanceApplication(a, { correctionId: id, kind: 'cancelled', reason: 'Reverse verified attendance effect' });
        const [batch] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
        expect(batch.needsRecalcAt).not.toBeNull();
        expect(batch.recalcEmploymentIds).toContain(worker.employmentId);
        expect((await day(worker.employmentId)).checkInAt).toBe(before.checkInAt);
        expect(await events(batchId, 'payroll-batch.recalc-required')).toHaveLength(1);
        expect(await decisions()).toHaveLength(1);
    });
});

describe('dated half-night rotation through staged approval and cancellation', () => {
    it('uses the rotated midnight boundary only at final approval and restores its effect while marking processed payroll stale', async () => {
        const { a, worker, mgr, self } = await fixture();
        const addDays = (value: string, days: number) => new Date(Date.parse(`${value}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
        const anchor = addDays(todayInKualaLumpur(), 8), nightDate = addDays(anchor, 1);
        // Use the actual administrator owner: rule creation also snapshots its immutable legacy OT
        // definition. Keep the old fixture's zero/false defaults and its declared working week.
        const rule = await createAttendanceRule(a, { name: 'Staged rotating crew', weeklyPattern: [1, 2, 3, 4, 5],
            lateGracePeriodMinutes: 0, lateAfterMinutes: 0, lateDeductMinutes: 0, includeGraceInLateness: false,
            earlyGracePeriodMinutes: 0, earlyAfterMinutes: 0, earlyDeductMinutes: 0, includeGraceInEarlyOut: false,
            applyToEarlyOt: false, otRows: [] });
        const morning = await createShift(a, { name: 'Profile morning', code: 'ST-AM', startTime: '08:00', endTime: '17:00',
            breakMinutes: 60, weeklyPattern: [1, 2, 3, 4, 5], ruleId: rule.id });
        const night = await createShift(a, { name: 'Rotated half night', code: 'ST-PM', startTime: '20:00', endTime: '05:00',
            breakMinutes: 60, weeklyPattern: [1, 2, 3, 4, 5], ruleId: rule.id });
        await assignDefaultShift(a, { employmentId: worker.employmentId, shiftId: morning.id });
        await owner.db.update(schema.employment).set({ attendanceRuleId: rule.id }).where(eq(schema.employment.id, worker.employmentId));
        const revision = (await getScheduleRotation(a, rule.id)).revision;
        const version = await saveScheduleRotation(a, { ruleId: rule.id, expectedRevision: revision,
            allowedShiftIds: [morning.id, night.id], cycle: { unit: 'day', length: 2, effectiveFrom: anchor, anchorDate: anchor,
                days: [{ kind: 'full', shiftId: morning.id }, { kind: 'half', shiftId: night.id }] } });
        // Save a genuinely future version, then advance only the business clock beyond that night.
        vi.useFakeTimers({toFake: ['Date']});
        vi.setSystemTime(new Date(`${addDays(nightDate, 1)}T12:00:00+08:00`));
        try {
        const readDay = async () => (await owner.db.select().from(schema.attendance).where(and(
            eq(schema.attendance.employmentId, worker.employmentId), eq(schema.attendance.attendanceDate, nightDate))))[0];
        // Non-vacuity: the profile stays morning, while the dated cycle chooses the half-night source.
        expect((await owner.db.select().from(schema.employment).where(eq(schema.employment.id, worker.employmentId)))[0].defaultShiftId).toBe(morning.id);
        expect(await withTenant(a, tx => allowanceScheduleFactsTx(tx, worker.employmentId, nightDate)))
            .toEqual({ shiftId: night.id, kind: 'half', scheduledMinutes: 240 });
        await checkIn(a, { employmentId: worker.employmentId, date: nightDate, time: '20:00', manual: true });
        await checkOut(a, { employmentId: worker.employmentId, date: nightDate, time: '00:30', manual: true });
        const before = await readDay(), originalPunches = (await attendanceClockData(a, worker.employmentId, nightDate)).rows
            .filter(punch => !punch.voidedAt).map(punch => punch.id).sort();
        expect(originalPunches).toHaveLength(2);
        expect(before).toMatchObject({ checkInAt: '20:00:00', checkOutAt: '00:30:00', dayType: 'workday', otMinutes: 0,
            lateMinutes: 0, earlyOutMinutes: 0 });
        expect(before.calcTrace).toMatchObject({ schedule: { scheduledMinutes: 240, endAbs: 1470, crossesMidnight: true } });
        await enable(a);
        const clockData = await attendanceClockData(a, worker.employmentId, nightDate);
        const id = (await requestAttendanceCorrection(a, { employmentId: worker.employmentId, date: nightDate,
            clockChanges: {version: 1, baseline: clockData.baseline, entries: clockData.rows.filter(row => !row.voidedAt).map(row => ({id: row.id, direction: row.direction, punchAt: row.direction === 'out' ? '01:30' : row.punchAt}))},
            reason: 'One verified hour after the rotated half-night boundary' })).correctionId;
        await decideAttendanceCorrection(mgr, { correctionId: id, decision: 'approved', expectedStageIndex: 0 });
        expect(await readDay()).toEqual(before);
        expect(await events(id, 'attendance-correction.effect.recorded')).toHaveLength(0);
        await decideAttendanceCorrection(a, { correctionId: id, decision: 'approved', expectedStageIndex: 1 });
        const approved = await readDay(), trail = await decisions();
        expect(approved).toMatchObject({ checkInAt: '20:00:00', checkOutAt: '01:30:00', dayType: 'workday', otMinutes: 60,
            lateMinutes: 0, earlyOutMinutes: 0 });
        expect(approved.calcTrace).toMatchObject({ schedule: { scheduledMinutes: 240, endAbs: 1470, crossesMidnight: true },
            overtime: { basis: 'window', normalMinutes: 240, rawMinutes: 60 } });
        expect(trail).toHaveLength(2);
        expect(trail.map(row => row.actualUserId)).toEqual([mgr.userId, a.userId]);
        expect(await events(id, 'attendance-correction.effect.recorded')).toHaveLength(1);
        await setCompensation(a, { employmentId: worker.employmentId, basicSalary: 4000, monthlyAllowance: 0, effectiveFrom: '2020-01-01' });
        const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: nightDate.slice(0, 7), scope: {employmentIds: [worker.employmentId]} });
        await generatePayslips(a, { batchId });
        expect(await owner.db.select({id: schema.payslip.id}).from(schema.payslip).where(and(eq(schema.payslip.batchId, batchId), eq(schema.payslip.employmentId, worker.employmentId)))).toHaveLength(1);
        const [paid] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
        expect(paid).toMatchObject({ status: 'processed', needsRecalcAt: null });
        expect(await owner.db.select().from(schema.payslip).where(and(eq(schema.payslip.batchId, batchId),
            eq(schema.payslip.employmentId, worker.employmentId)))).toHaveLength(1);
        expect(await cancelAttendanceApplication(a, { correctionId: id, kind: 'cancelled', reason: 'Reverse reviewed half-night correction' }))
            .toEqual({ status: 'cancelled', reversed: true });
        const restored = await readDay();
        expect(restored).toMatchObject({ checkInAt: before.checkInAt, checkOutAt: before.checkOutAt, workedMinutes: before.workedMinutes,
            otMinutes: before.otMinutes, lateMinutes: before.lateMinutes, earlyOutMinutes: before.earlyOutMinutes, calcTrace: before.calcTrace });
        expect((await attendanceClockData(a, worker.employmentId, nightDate)).rows.filter(punch => !punch.voidedAt)
            .map(punch => punch.id).sort()).toEqual(originalPunches);
        const [stale] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
        expect(stale.needsRecalcAt).not.toBeNull();
        expect(stale.recalcEmploymentIds).toContain(worker.employmentId);
        expect(await events(batchId, 'payroll-batch.recalc-required')).toHaveLength(1);
        expect(await decisions()).toEqual(trail);
        expect((await correction(id))).toMatchObject({ status: 'cancelled', cancellationKind: 'cancelled' });
        const versions = (await getScheduleRotation(a, rule.id)).versions;
        expect(versions.map(row => row.id)).toEqual([version.id]);
        expect(versions[0].effectiveFrom).toBe(anchor);
        expect(await withTenant(a, tx => allowanceScheduleFactsTx(tx, worker.employmentId, nightDate)))
            .toEqual({ shiftId: night.id, kind: 'half', scheduledMinutes: 240 });
        } finally { vi.useRealTimers(); }
    });
});


describe('Application History status counts and Overview migration parity', () => {
  it('keeps intermediate approval Pending and updates all counts only at terminal completion', async () => {
    const {a,worker,mgr}=await fixture(); await enable(a); const id=await submit(a,worker.employmentId);
    const filter={query:id,status:'pending' as const};
    let history=await listAttendanceApplicationHistory(a,[b.companyId],filter);
    expect(history.counts).toMatchObject({pending:1,approved:0,all:1}); expect(history.total).toBe(1);
    await decideAttendanceCorrection(mgr,{correctionId:id,decision:'approved',expectedStageIndex:0});
    history=await listAttendanceApplicationHistory(a,[b.companyId],filter);
    expect(history.rows.map(row=>row.id)).toEqual([id]); expect(history.counts).toMatchObject({pending:1,approved:0});
    await decideAttendanceCorrection(a,{correctionId:id,decision:'approved',expectedStageIndex:1});
    history=await listAttendanceApplicationHistory(a,[b.companyId],filter);
    expect(history.rows).toEqual([]); expect(history.total).toBe(0); expect(history.counts).toMatchObject({pending:0,approved:1,all:1});
    const approved=await listAttendanceApplicationHistory(a,[b.companyId],{query:id,status:'approved'});
    expect(approved.rows.map(row=>row.id)).toEqual([id]);
    expect((await listAttendanceApplicationHistory(a,[b.companyId],{query:'no matching request'})).counts.all).toBe(0);
  });
  it('every legacy Overview correction and permitted action survives through HR History or the manager inbox', async () => {
    const {a,worker,mgr}=await fixture(); const id=await submit(a,worker.employmentId);
    expect((await attendanceApplicationDetail(a,[b.companyId],id))?.workflow).toBeNull();
    for(const ctx of [a,mgr]){
      const overview=await listAttendanceCorrections(ctx,{companyIds:[b.companyId],status:'pending'});
      const inbox=await listPendingTasks(ctx,[b.companyId],{attendance:true,claims:false});
      expect(inbox.filter(row=>row.kind==='attendance').map(row=>row.id).sort()).toEqual(overview.map(row=>row.id).sort());
    }
    const overview=await listAttendanceCorrections(a,{companyIds:[b.companyId],status:'pending'});
    const history=await listAttendanceApplicationHistory(a,[b.companyId],{status:'pending'});
    expect(history.rows.map(row=>row.id).sort()).toEqual(overview.map(row=>row.id).sort());
    const detail=await attendanceApplicationDetail(a,[b.companyId],id);
    expect(detail?.canDecide).toBe(true);
    await decideAttendanceCorrection(mgr,{correctionId:id,decision:'approved'});
    expect((await listAttendanceApplicationHistory(a,[b.companyId],{status:'approved'})).rows.map(row=>row.id)).toEqual([id]);
  });
});
