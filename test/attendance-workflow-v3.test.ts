import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, asc, eq, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee, setReportingLine } from '../core/org';
import { checkIn, checkOut, requestAttendanceCorrection, decideAttendanceCorrection, listAttendanceCorrections } from '../core/attendance';
import { saveAttendanceWorkflow, setAttendanceWorkflowEnabled, previewAttendanceWorkflow, reassignAttendanceWorkflowStageToHr, hasPendingAttendanceParticipantAssignment } from '../core/attendance-workflow';
import { attendanceApplicationDetail } from '../core/attendance-application-history';
import { listPendingTasks } from '../core/approvals-inbox';
import { todayInKualaLumpur } from '../lib/hr-date';
import type { AttendanceV3WorkflowInput } from '../lib/attendance-workflow-v3';
import { adminCtx, createAppUser, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
let b: Base;
beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async () => { await resetDb(); b = await seedBase(); });
async function actor(name: string, role: 'employee' | 'hr_admin' = 'employee', departmentId = b.deptB) {
    const hired = await hireEmployee(adminCtx(b), { person: { fullName: name, primaryEmail: `${randomUUID()}@attendance-v3.test` }, companyId: b.companyId, departmentId, employmentType: 'full_time', hiredOn: '2020-01-01' });
    const userId = await createAppUser(b.tenantId, hired.personId, role);
    const ctx: SessionContext = { ...adminCtx(b), userId, personId: hired.personId, roles: [role], grants: [{ role, companyId: b.companyId }] };
    return { ...hired, ctx };
}
async function fixture(mode: 'sequential' | 'any_one' = 'sequential') {
    const root = adminCtx(b), worker = await actor('Fictional applicant', 'employee', b.deptA), first = await actor('Fictional first participant'), second = await actor('Fictional second participant'), hr = await actor('Fictional final HR', 'hr_admin');
    const on = todayInKualaLumpur();
    await checkIn(root, { employmentId: worker.employmentId, date: on, time: '08:00', manual: true });
    await checkOut(root, { employmentId: worker.employmentId, date: on, time: '17:00', manual: true });
    const input: AttendanceV3WorkflowInput = { companyId: b.companyId, routingVersion: 3, code: 'PARTICIPANTS', name: 'Accountable participant route', applicationType: 'irregularity', priority: 100, criteria: { departmentIds: [b.deptA] }, active: true,
        stages: [{ name: 'Level 1', mode, source: { kind: 'specific_employee', employmentIds: [first.employmentId, second.employmentId] }, hrAlternative: false },
            { name: 'Level 2', mode: 'sequential', source: { kind: 'specific_employee', employmentIds: [hr.employmentId] }, hrAlternative: false }] };
    const template = await saveAttendanceWorkflow(root, input);
    await setAttendanceWorkflowEnabled(root, b.companyId, 'irregularity', true);
    const id = (await requestAttendanceCorrection(worker.ctx, { employmentId: worker.employmentId, date: on, checkIn: '09:00', checkOut: '18:00', reason: 'Fictional v3 correction' })).correctionId;
    return { root, worker, first, second, hr, input, template, id, on };
}
const evidence = (id: string) => owner.db.select().from(schema.attendanceWorkflowParticipantDecision).where(eq(schema.attendanceWorkflowParticipantDecision.requestId, id)).orderBy(asc(schema.attendanceWorkflowParticipantDecision.stageIndex), asc(schema.attendanceWorkflowParticipantDecision.decidedAt), asc(schema.attendanceWorkflowParticipantDecision.id));
const state = async (f: Awaited<ReturnType<typeof fixture>>) => (await attendanceApplicationDetail(f.root, [b.companyId], f.id))!;
const day = async (f: Awaited<ReturnType<typeof fixture>>) => (await owner.db.select().from(schema.attendance).where(and(eq(schema.attendance.employmentId, f.worker.employmentId), eq(schema.attendance.attendanceDate, f.on))))[0];
describe('Attendance v3 participant owner and exact request capability', () => {
    it('allows exact ordinary employees to decide in order without granting general Personnel rights', async () => {
        const f = await fixture();
        const before = await state(f);
        const visible = await listAttendanceCorrections(f.first.ctx, { companyIds: [b.companyId], status: 'pending' });
        expect(visible.find(row => row.id === f.id)).toMatchObject({ canDecide: true, workflow: { currentParticipantSlot: '0:0' } });
        expect(await hasPendingAttendanceParticipantAssignment(f.first.ctx)).toBe(true);
        expect(await listPendingTasks(f.first.ctx, [b.companyId], { attendance: true, claims: true })).toMatchObject([{ id: f.id, kind: 'attendance' }]);
        const [scope] = await withTenant(f.first.ctx, tx => tx.execute(sql`select app.can_see_employment(${f.worker.employmentId}::uuid) as personnel`)) as unknown as { personnel: boolean }[];
        expect(scope.personnel).toBe(false);
        await expect(decideAttendanceCorrection(f.second.ctx, { correctionId: f.id, decision: 'approved', expectedStageIndex: 0, expectedParticipantSlot: '0:1' })).rejects.toThrow();
        await decideAttendanceCorrection(f.first.ctx, { correctionId: f.id, decision: 'approved', expectedStageIndex: 0, expectedParticipantSlot: '0:0', remarks: 'First real person checked' });
        let detail = await state(f);
        expect(detail.workflow?.currentStage).toBe(0);
        expect(detail.workflow?.decisions).toHaveLength(0);
        expect(await evidence(before.workflow!.id)).toHaveLength(1);
        expect((await day(f)).checkInAt).toBe('08:00:00');
        await expect(decideAttendanceCorrection(f.first.ctx, { correctionId: f.id, decision: 'approved', expectedStageIndex: 0, expectedParticipantSlot: '0:1' })).rejects.toThrow();
        await decideAttendanceCorrection(f.second.ctx, { correctionId: f.id, decision: 'approved', expectedStageIndex: 0, expectedParticipantSlot: '0:1' });
        detail = await state(f);
        expect(detail.workflow?.currentStage).toBe(1);
        expect(detail.workflow?.decisions).toHaveLength(1);
        expect((await day(f)).checkInAt).toBe('08:00:00');
        await decideAttendanceCorrection(f.hr.ctx, { correctionId: f.id, decision: 'approved', expectedStageIndex: 1, expectedParticipantSlot: '1:0' });
        detail = await state(f);
        expect(detail.application.status).toBe('approved');
        expect(detail.workflow?.participantDecisions).toHaveLength(3);
        expect(detail.workflow?.decisions).toHaveLength(2);
        expect((await day(f)).checkInAt).toBe('09:00:00');
    });
    it('serializes competing any-one actors into one participant and one stage completion', async () => {
        const f = await fixture('any_one');
        const results = await Promise.allSettled([f.first, f.second].map((actor, index) => decideAttendanceCorrection(actor.ctx, { correctionId: f.id, decision: 'approved', expectedStageIndex: 0, expectedParticipantSlot: `0:${index}` })));
        expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
        const detail = await state(f);
        expect(detail.application.status).toBe('pending');
        expect(detail.workflow?.currentStage).toBe(1);
        expect(detail.workflow?.participantDecisions).toHaveLength(1);
        expect(detail.workflow?.decisions).toHaveLength(1);
        expect((await day(f)).checkInAt).toBe('08:00:00');
    });
    it('keeps completed participant history when reasoned HR reassignment replaces one outstanding slot', async () => {
        const f = await fixture(), replacement = await actor('Fictional replacement HR', 'hr_admin');
        await decideAttendanceCorrection(f.first.ctx, { correctionId: f.id, decision: 'approved', expectedStageIndex: 0, expectedParticipantSlot: '0:0' });
        const before = await state(f), recorded = before.workflow!.participantDecisions[0];
        await expect(reassignAttendanceWorkflowStageToHr(f.hr.ctx, { correctionId: f.id, expectedStageIndex: 0, expectedParticipantSlot: '0:0', reason: 'Cannot replace completed work' })).rejects.toThrow();
        await reassignAttendanceWorkflowStageToHr(f.hr.ctx, { correctionId: f.id, expectedStageIndex: 0, expectedParticipantSlot: '0:1', reason: 'Second participant unavailable; substitute only this outstanding slot' });
        let detail = await state(f);
        expect(detail.workflow?.participantDecisions).toEqual([recorded]);
        expect(detail.workflow?.stages).toEqual(before.workflow!.stages);
        expect(detail.workflow?.participantReassignments).toHaveLength(1);
        await decideAttendanceCorrection(replacement.ctx, { correctionId: f.id, decision: 'approved', expectedStageIndex: 0, expectedParticipantSlot: '0:1' });
        await decideAttendanceCorrection(f.hr.ctx, { correctionId: f.id, decision: 'approved', expectedStageIndex: 1, expectedParticipantSlot: '1:0' });
        detail = await state(f);
        expect(detail.application.status).toBe('approved');
        expect(detail.workflow?.participantDecisions[0]).toEqual(recorded);
        expect(detail.workflow?.participantDecisions[1]).toMatchObject({ assigned: { kind: 'hr_admin', slot: '0:1' }, actualUserId: replacement.ctx.userId });
    });
    it('keeps the original frozen route after template/hierarchy changes and rejects an unrelated employee', async () => {
        const f = await fixture(), other = await actor('Fictional unassigned employee');
        const before = await state(f);
        await setReportingLine(f.root, { subordinateEmploymentId: f.worker.employmentId, managerEmploymentId: other.employmentId, lineType: 'administrative', validFrom: f.on });
        await saveAttendanceWorkflow(f.root, { ...f.input, stages: [{ ...f.input.stages[0], source: { kind: 'specific_employee', employmentIds: [other.employmentId] } }] }, f.template.lineageId);
        expect((await state(f)).workflow?.stages).toEqual(before.workflow!.stages);
        await expect(decideAttendanceCorrection(other.ctx, { correctionId: f.id, decision: 'approved', expectedStageIndex: 0, expectedParticipantSlot: '0:0' })).rejects.toThrow();
        expect(await hasPendingAttendanceParticipantAssignment(other.ctx)).toBe(false);
        const preview = await previewAttendanceWorkflow(f.root, f.input, f.template.lineageId);
        expect(preview.rows.find(row => row.employmentId === f.worker.employmentId)?.resolvedStages[0].approvers.map(actor => actor.name)).toEqual(['Fictional first participant', 'Fictional second participant']);
    });
    it('rejects the application on the first participant rejection without applying attendance effects', async () => {
        const f = await fixture();
        await decideAttendanceCorrection(f.first.ctx, { correctionId: f.id, decision: 'rejected', rejectReason: 'Source evidence does not support this request', expectedStageIndex: 0, expectedParticipantSlot: '0:0' });
        const detail = await state(f);
        expect(detail.application.status).toBe('rejected');
        expect(detail.workflow?.participantDecisions).toHaveLength(1);
        expect(detail.workflow?.decisions).toHaveLength(1);
        expect((await day(f)).checkInAt).toBe('08:00:00');
    });
});
