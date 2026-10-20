import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, asc, eq, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee, setReportingLine } from '../core/org';
import { checkIn, checkOut, requestAttendanceCorrection, decideAttendanceCorrection, listAttendanceCorrections } from '../core/attendance';
import { saveAttendanceWorkflow, setAttendanceWorkflowEnabled, previewAttendanceWorkflow, reassignAttendanceWorkflowStageToHr, hasPendingAttendanceParticipantAssignment, decideAttendanceWorkflowStageTx } from '../core/attendance-workflow';
import { attendanceApplicationDetail, attendanceApplicationFilterOptions } from '../core/attendance-application-history';
import { listPendingTasks } from '../core/approvals-inbox';
import { createBatch } from '../packs/payroll/service';
import { todayInKualaLumpur } from '../lib/hr-date';
import type { AttendanceV3WorkflowInput } from '../lib/attendance-workflow-v3';
import { adminCtx, createAppUser, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
let b: Base;
beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async () => { await resetDb(); b = await seedBase(); });
async function actor(name: string, role: 'employee' | 'hr_admin' = 'employee', departmentId = b.deptB, base = b) {
    const hired = await hireEmployee(adminCtx(base), { person: { fullName: name, primaryEmail: `${randomUUID()}@attendance-v3.test` }, companyId: base.companyId, departmentId, employmentType: 'full_time', hiredOn: '2020-01-01' });
    const userId = await createAppUser(base.tenantId, hired.personId, role);
    const ctx: SessionContext = { ...adminCtx(base), userId, personId: hired.personId, roles: [role], grants: [{ role, companyId: base.companyId }] };
    return { ...hired, ctx };
}
async function fixture(mode: 'sequential' | 'any_one' = 'sequential', onlyHr = false, ot = false, employeeFinal = false, currentOtDay = false, irregularityWithOt = false) {
    const root = adminCtx(b), worker = await actor('Fictional applicant', 'employee', b.deptA), first = await actor('Fictional first participant'), second = await actor('Fictional second participant'), hr = await actor('Fictional final HR', 'hr_admin');
    const today = todayInKualaLumpur();
    const nextDay = new Date(`${today}T12:00:00Z`); nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    const on = ot && !currentOtDay ? nextDay.toISOString().slice(0, 10) : today;
    if (!ot || currentOtDay) await checkIn(root, { employmentId: worker.employmentId, date: on, time: '08:00', manual: true });
    if (!ot || currentOtDay) await checkOut(root, { employmentId: worker.employmentId, date: on, time: '17:00', manual: true });
    const input: AttendanceV3WorkflowInput = { companyId: b.companyId, routingVersion: 3, code: 'PARTICIPANTS', name: 'Accountable participant route', applicationType: ot ? 'self_overtime' : 'irregularity', priority: 100, criteria: { departmentIds: [b.deptA] }, active: true,
        stages: [{ name: 'Level 1', mode, source: { kind: 'specific_employee', employmentIds: [first.employmentId, second.employmentId] }, hrAlternative: false },
            { name: 'Level 2', mode: 'sequential', source: { kind: 'specific_employee', employmentIds: [hr.employmentId] }, hrAlternative: false }] };
    if (onlyHr) input.stages = [{ name: 'Level 1', mode: 'sequential', source: { kind: 'specific_employee', employmentIds: [employeeFinal ? first.employmentId : hr.employmentId] }, hrAlternative: false }];
    const template = await saveAttendanceWorkflow(root, input);
    await setAttendanceWorkflowEnabled(root, b.companyId, input.applicationType, true);
    const id = (await requestAttendanceCorrection(worker.ctx, { employmentId: worker.employmentId, date: on, ...(ot ? { requestedOtMinutes: 60, requestKind: 'self_overtime' as const } : { checkIn: '09:00', checkOut: '18:00', ...(irregularityWithOt ? { requestedOtMinutes: 60 } : {}) }), reason: 'Fictional v3 correction' })).correctionId;
    return { root, worker, first, second, hr, input, template, id, on };
}
const evidence = (id: string) => owner.db.select().from(schema.attendanceWorkflowParticipantDecision).where(eq(schema.attendanceWorkflowParticipantDecision.requestId, id)).orderBy(asc(schema.attendanceWorkflowParticipantDecision.stageIndex), asc(schema.attendanceWorkflowParticipantDecision.decidedAt), asc(schema.attendanceWorkflowParticipantDecision.id));
const state = async (f: Awaited<ReturnType<typeof fixture>>) => (await attendanceApplicationDetail(f.root, [b.companyId], f.id))!;
const day = async (f: Awaited<ReturnType<typeof fixture>>) => (await owner.db.select().from(schema.attendance).where(and(eq(schema.attendance.employmentId, f.worker.employmentId), eq(schema.attendance.attendanceDate, f.on))))[0];
describe('Attendance v3 participant owner and exact request capability', () => {
    it('loads approver choices for empty, single and multiple authorized company selections', async () => {
        const first = await actor('Fictional first company choice');
        const [company] = await owner.db.insert(schema.company).values({ tenantId: b.tenantId, legalName: 'Fictional second choices company' }).returning();
        const [department] = await owner.db.insert(schema.department).values({ tenantId: b.tenantId, companyId: company.id, name: 'Fictional second choices department' }).returning();
        const second = await actor('Fictional second company choice', 'employee', department.id, { ...b, companyId: company.id, deptB: department.id });
        const empty = await attendanceApplicationFilterOptions(adminCtx(b), []);
        expect(empty.companies).toEqual([]);
        const single = await attendanceApplicationFilterOptions(adminCtx(b), [b.companyId]);
        expect(single.approverEmployees?.map(row => row.id)).toContain(first.employmentId);
        expect(single.approverEmployees?.map(row => row.id)).not.toContain(second.employmentId);
        const both = await attendanceApplicationFilterOptions(adminCtx(b), [b.companyId, company.id]);
        expect(both.companies.map(row => row.id).sort()).toEqual([b.companyId, company.id].sort());
        expect(both.approverEmployees?.map(row => row.id)).toEqual(expect.arrayContaining([first.employmentId, second.employmentId]));
    });

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

describe('v3 database authority refuses bypasses and committed/released proof', () => {
    it('does not let a fresh partial participant decision manufacture a completed sequential level', async () => {
        const f = await fixture(), before = await state(f);
        await expect(withTenant(f.first.ctx, async tx => {
            await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${b.tenantId + ':' + f.worker.employmentId},0))`);
            await tx.execute(sql`select id from attendance_correction where id=${f.id}::uuid for update`);
            await decideAttendanceWorkflowStageTx(tx, f.first.ctx, { correctionId: f.id, employmentId: f.worker.employmentId, decision: 'approved', expectedStageIndex: 0, expectedParticipantSlot: '0:0' });
            const [fulfilled] = await tx.execute(sql`select app.attendance_workflow_v3_completed(${before.workflow!.id}::uuid,0) as result`) as unknown as { result: string | null }[];
            expect(fulfilled.result).toBeNull();
            await tx.insert(schema.attendanceWorkflowDecision).values({ tenantId: b.tenantId, requestId: before.workflow!.id, employmentId: f.worker.employmentId, stageIndex: 0,
                decision: 'approved', assignedKind: 'specific_employee', assignedEmploymentId: f.first.employmentId,
                actualUserId: f.first.ctx.userId!, actualPersonId: f.first.personId, actualEmploymentId: f.first.employmentId,
                actualActorName: 'Untrusted supplied name', actingMode: 'assigned', previousStatus: 'pending', resultingStatus: 'pending' });
        })).rejects.toThrow();
        expect((await state(f)).workflow?.participantDecisions).toHaveLength(0);
        expect((await state(f)).workflow?.decisions).toHaveLength(0);
    });
    it('requires an active writing savepoint for both final participant and level-completion evidence', async () => {
        const f = await fixture('sequential', true);
        let observedReleasedRefusal = false;
        await expect(withTenant(f.hr.ctx, async tx => {
            await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${b.tenantId + ':' + f.worker.employmentId},0))`);
            await tx.execute(sql`select id from attendance_correction where id=${f.id}::uuid for update`);
            await tx.execute(sql`SAVEPOINT v3_participant_write`);
            const decision = await decideAttendanceWorkflowStageTx(tx, f.hr.ctx, { correctionId: f.id, employmentId: f.worker.employmentId, decision: 'approved', expectedStageIndex: 0, expectedParticipantSlot: '0:0' });
            expect(decision).toMatchObject({ final: true, versionedFinalEffect: true });
            await tx.execute(sql`select app.attendance_workflow_begin_effect(${f.id}::uuid)`);
            const [active] = await tx.execute(sql`select app.attendance_workflow_effect_scope(${f.worker.employmentId}::uuid,${f.on}::date) as ok`) as unknown as { ok: boolean }[];
            expect(active.ok).toBe(true);
            await tx.execute(sql`RELEASE SAVEPOINT v3_participant_write`);
            const [released] = await tx.execute(sql`select app.attendance_workflow_effect_scope(${f.worker.employmentId}::uuid,${f.on}::date) as ok`) as unknown as { ok: boolean }[];
            expect(released.ok).toBe(false);
            observedReleasedRefusal = true;
            throw new Error('Intentional fixture rollback after released-write refusal');
        })).rejects.toThrow('Intentional fixture rollback after released-write refusal');
        expect(observedReleasedRefusal).toBe(true);
        expect((await state(f)).workflow?.participantDecisions).toHaveLength(0);
    });
    it('refuses replay of committed final evidence and exposes no request to an unrelated employee', async () => {
        const f = await fixture('sequential', true), unrelated = await actor('Fictional unrelated reader');
        await decideAttendanceCorrection(f.hr.ctx, { correctionId: f.id, decision: 'approved', expectedStageIndex: 0, expectedParticipantSlot: '0:0' });
        const [replay] = await withTenant(f.hr.ctx, async tx => {
            await tx.execute(sql`select set_config('app.attendance_workflow_effect',${f.id},true)`);
            return tx.execute(sql`select app.attendance_workflow_effect_scope(${f.worker.employmentId}::uuid,${f.on}::date) as ok`);
        }) as unknown as { ok: boolean }[];
        expect(replay.ok).toBe(false);
        const workflowId = (await state(f)).workflow!.id;
        const [foreign] = await withTenant(unrelated.ctx, tx => tx.execute(sql`select app.attendance_workflow_v3_read(${f.id}::uuid) as readable,app.attendance_workflow_v3_decision_slot(${f.id}::uuid) as slot,app.attendance_workflow_v3_completed(${workflowId}::uuid,0) as completed`)) as unknown as { readable: boolean; slot: unknown; completed: unknown }[];
        expect(foreign).toEqual({ readable: false, slot: null, completed: null });
        expect(await withTenant(unrelated.ctx, tx => tx.select().from(schema.attendanceWorkflowParticipantDecision).where(eq(schema.attendanceWorkflowParticipantDecision.requestId, workflowId)))).toEqual([]);
    });
    it('keeps a genuine future Self Overtime deferral on the canonical final-effect path', async () => {
        const f = await fixture('sequential', true, true);
        const outcome = await decideAttendanceCorrection(f.hr.ctx, { correctionId: f.id, decision: 'approved', expectedStageIndex: 0, expectedParticipantSlot: '0:0' });
        expect(outcome).toMatchObject({ status: 'approved', deferred: true });
        const detail = await state(f);
        expect(detail.application.requestKind).toBe('self_overtime');
        expect(detail.workflow?.participantDecisions).toHaveLength(1);
        expect(detail.workflow?.decisions).toHaveLength(1);
        expect(await day(f)).toBeUndefined();
    });
    it('keeps an exact assigned request visible when the active company filter excludes its subject', async () => {
        const f = await fixture(), unrelated = await actor('Fictional non-assignee');
        const otherCompanyContext = [randomUUID()];
        expect((await listAttendanceCorrections(f.first.ctx, { companyIds: otherCompanyContext, status: 'pending' })).map(row => row.id)).toContain(f.id);
        expect((await listAttendanceCorrections(unrelated.ctx, { companyIds: otherCompanyContext, status: 'pending' })).map(row => row.id)).not.toContain(f.id);
        expect((await listPendingTasks(f.first.ctx, otherCompanyContext, { attendance: true, claims: true })).map(row => row.id)).toEqual([f.id]);
    });
});

describe('independent Personnel depth and final HR handoff', () => {
    it('uses the applicant fifth superior after a selected first level in preview and the frozen submission', async () => {
        const f = await fixture(), fourth = await actor('Fictional fourth superior'), fifth = await actor('Fictional fifth superior');
        for (const [subordinate, superior] of [[f.worker, f.first], [f.first, f.second], [f.second, f.hr], [f.hr, fourth], [fourth, fifth]]) {
            await setReportingLine(f.root, { subordinateEmploymentId: subordinate.employmentId, managerEmploymentId: superior.employmentId, lineType: 'administrative', validFrom: '2020-01-01' });
        }
        const value: AttendanceV3WorkflowInput = { ...f.input, stages: [
            { ...f.input.stages[0], mode: 'any_one' },
            { name: 'Level 2', mode: 'sequential', source: { kind: 'direct_manager', depth: 5 }, hrAlternative: false },
        ] };
        const saved = await saveAttendanceWorkflow(f.root, value, f.template.lineageId);
        const preview = await previewAttendanceWorkflow(f.root, value, saved.lineageId);
        const projected = preview.rows.find(row => row.employmentId === f.worker.employmentId)!;
        expect(projected.levelProblem).toBeNull();
        expect(projected.resolvedStages[0]).toMatchObject({ mode: 'any_one', source: { kind: 'specific_employee' } });
        expect(projected.resolvedStages[1]).toMatchObject({ mode: 'sequential', source: { depth: 5 }, approvers: [{ employmentId: fifth.employmentId, hierarchyDepth: 5 }] });
        const previousDay = new Date(`${f.on}T12:00:00Z`); previousDay.setUTCDate(previousDay.getUTCDate() - 1);
        const on = previousDay.toISOString().slice(0, 10);
        await checkIn(f.root, { employmentId: f.worker.employmentId, date: on, time: '08:00', manual: true });
        await checkOut(f.root, { employmentId: f.worker.employmentId, date: on, time: '17:00', manual: true });
        const id = (await requestAttendanceCorrection(f.worker.ctx, { employmentId: f.worker.employmentId, date: on, checkIn: '09:00', checkOut: '18:00', reason: 'Fifth Personnel superior is independent of second approval ordinal' })).correctionId;
        expect((await attendanceApplicationDetail(f.root, [b.companyId], id))?.workflow?.stages).toEqual(projected.resolvedStages);
    });
    it('rolls back a final ordinary participant and provides a finite explicit HR handoff', async () => {
        const f = await fixture('sequential', true, false, true);
        const original = await state(f);
        await expect(decideAttendanceCorrection(f.first.ctx, { correctionId: f.id, decision: 'approved', expectedStageIndex: 0, expectedParticipantSlot: '0:0' })).rejects.toMatchObject({ problem: { code: 'hr_handoff_required', levelIndex: 0 } });
        let detail = await state(f);
        expect(detail.application.status).toBe('pending');
        expect(detail.workflow?.currentStage).toBe(0);
        expect(detail.workflow?.participantDecisions).toHaveLength(0);
        expect(detail.workflow?.decisions).toHaveLength(0);
        expect((await day(f)).checkInAt).toBe('08:00:00');
        await reassignAttendanceWorkflowStageToHr(f.hr.ctx, { correctionId: f.id, expectedStageIndex: 0, expectedParticipantSlot: '0:0', reason: 'Scoped HR performs the final canonical calculation' });
        await decideAttendanceCorrection(f.hr.ctx, { correctionId: f.id, decision: 'approved', expectedStageIndex: 0, expectedParticipantSlot: '0:0' });
        detail = await state(f);
        expect(detail.workflow?.stages).toEqual(original.workflow!.stages);
        expect(detail.workflow?.participantDecisions).toHaveLength(1);
        expect(detail.workflow?.participantReassignments).toHaveLength(1);
        expect(detail.application.status).toBe('approved');
    });
});


/** App-role witnesses are positive before the refusal: an empty RLS result alone is insufficient. */
describe('v3 exact tenant/company, live identity and immutable history boundary', () => {
    async function slot(ctx: SessionContext, correctionId: string) {
        const [row] = await withTenant(ctx, tx => tx.execute(sql`select app.attendance_workflow_v3_decision_slot(${correctionId}::uuid) as actor`)) as unknown as { actor: { slot: string } | null }[];
        return row.actor;
    }
    async function resolve(ctx: SessionContext, subjectId: string, stages: AttendanceV3WorkflowInput['stages']) {
        const [row] = await withTenant(ctx, tx => tx.execute(sql`select app.attendance_workflow_resolve_v3(${subjectId}::uuid,${JSON.stringify(stages)}::jsonb) as route`)) as unknown as { route: { ok: boolean; problem?: { code: string; levelIndex: number | null } } }[];
        return row.route;
    }
    it('refuses real foreign-tenant and sibling-company employees without hiding a valid assignment', async () => {
        const f = await fixture(), original = await state(f);
        expect(await slot(f.first.ctx, f.id)).toMatchObject({ slot: '0:0' });
        expect((await resolve(f.root, f.worker.employmentId, f.input.stages)).ok).toBe(true);
        const [company] = await owner.db.insert(schema.company).values({ tenantId: b.tenantId, legalName: 'Fictional isolated sibling company' }).returning();
        const [department] = await owner.db.insert(schema.department).values({ tenantId: b.tenantId, companyId: company.id, name: 'Fictional sibling department' }).returning();
        const siblingBase = { ...b, companyId: company.id, deptB: department.id };
        const sibling = await actor('Fictional sibling company employee', 'employee', department.id, siblingBase);
        const otherBase = await seedBase();
        const foreign = await actor('Fictional separate tenant employee', 'employee', otherBase.deptB, otherBase);
        for (const outsider of [sibling, foreign]) {
            const [own] = await withTenant(outsider.ctx, tx => tx.select({ id: schema.employment.id }).from(schema.employment).where(eq(schema.employment.id, outsider.employmentId)));
            expect(own?.id).toBe(outsider.employmentId); // Live authenticated app-role context, not a broken fixture.
            expect(await slot(outsider.ctx, f.id)).toBeNull();
            expect(await withTenant(outsider.ctx, tx => tx.select().from(schema.attendanceWorkflowRequest).where(eq(schema.attendanceWorkflowRequest.id, original.workflow!.id)))).toEqual([]);
            await expect(decideAttendanceCorrection(outsider.ctx, { correctionId: f.id, decision: 'approved', expectedStageIndex: 0, expectedParticipantSlot: '0:0' })).rejects.toThrow();
            const stages: AttendanceV3WorkflowInput['stages'] = [{ name: 'Level 1', mode: 'sequential', source: { kind: 'specific_employee', employmentIds: [outsider.employmentId] }, hrAlternative: false }];
            expect(await resolve(f.root, f.worker.employmentId, stages)).toMatchObject({ ok: false, problem: { code: 'employee_unavailable', levelIndex: 0 } });
        }
        expect((await state(f)).workflow?.participantDecisions).toHaveLength(0);
        await decideAttendanceCorrection(f.first.ctx, { correctionId: f.id, decision: 'approved', expectedStageIndex: 0, expectedParticipantSlot: '0:0' });
        expect((await state(f)).workflow?.participantDecisions).toHaveLength(1);
    });
    it('refuses inactive or unlinked frozen identities and restores only the original live assignment', async () => {
        const f = await fixture();
        expect(await slot(f.first.ctx, f.id)).toMatchObject({ slot: '0:0' });
        const mutations = [
            { apply: () => owner.db.update(schema.employment).set({ terminatedOn: todayInKualaLumpur() }).where(eq(schema.employment.id, f.first.employmentId)), restore: () => owner.db.update(schema.employment).set({ terminatedOn: null }).where(eq(schema.employment.id, f.first.employmentId)), code: 'employee_unavailable' },
            { apply: () => owner.db.update(schema.appUser).set({ archivedAt: new Date() }).where(eq(schema.appUser.id, f.first.ctx.userId!)), restore: () => owner.db.update(schema.appUser).set({ archivedAt: null }).where(eq(schema.appUser.id, f.first.ctx.userId!)), code: 'missing_or_ambiguous_login' },
            { apply: () => owner.db.update(schema.appUser).set({ personId: null }).where(eq(schema.appUser.id, f.first.ctx.userId!)), restore: () => owner.db.update(schema.appUser).set({ personId: f.first.personId }).where(eq(schema.appUser.id, f.first.ctx.userId!)), code: 'missing_or_ambiguous_login' },
        ];
        for (const mutation of mutations) {
            await mutation.apply();
            expect(await slot(f.first.ctx, f.id)).toBeNull();
            expect(await resolve(f.root, f.worker.employmentId, f.input.stages)).toMatchObject({ ok: false, problem: { code: mutation.code, levelIndex: 0 } });
            await expect(decideAttendanceCorrection(f.first.ctx, { correctionId: f.id, decision: 'approved', expectedStageIndex: 0, expectedParticipantSlot: '0:0' })).rejects.toThrow();
            expect((await state(f)).workflow?.participantDecisions).toHaveLength(0);
            await mutation.restore();
            expect(await slot(f.first.ctx, f.id)).toMatchObject({ slot: '0:0' });
        }
        await decideAttendanceCorrection(f.first.ctx, { correctionId: f.id, decision: 'approved', expectedStageIndex: 0, expectedParticipantSlot: '0:0' });
        expect((await state(f)).workflow?.participantDecisions).toHaveLength(1);
    });
    it('denies direct app-role UPDATE and DELETE for visible participant and reassignment evidence', async () => {
        const f = await fixture();
        await decideAttendanceCorrection(f.first.ctx, { correctionId: f.id, decision: 'approved', expectedStageIndex: 0, expectedParticipantSlot: '0:0', remarks: 'Original participant evidence' });
        await reassignAttendanceWorkflowStageToHr(f.hr.ctx, { correctionId: f.id, expectedStageIndex: 0, expectedParticipantSlot: '0:1', reason: 'Original reasoned outstanding-slot handoff' });
        const before = await state(f), participant = before.workflow!.participantDecisions[0], reassignment = before.workflow!.participantReassignments[0];
        const [identity] = await withTenant(f.hr.ctx, tx => tx.execute(sql`select current_user as role`)) as unknown as { role: string }[];
        expect(identity.role).toBe('ai_hr_app');
        expect(await withTenant(f.hr.ctx, tx => tx.select().from(schema.attendanceWorkflowParticipantDecision).where(eq(schema.attendanceWorkflowParticipantDecision.id, participant.id)))).toHaveLength(1);
        expect(await withTenant(f.hr.ctx, tx => tx.select().from(schema.attendanceWorkflowParticipantReassignment).where(eq(schema.attendanceWorkflowParticipantReassignment.id, reassignment.id)))).toHaveLength(1);
        for (const target of [
            { table: 'attendance_workflow_participant_decision', field: 'remarks', id: participant.id },
            { table: 'attendance_workflow_participant_reassignment', field: 'reason', id: reassignment.id },
        ]) {
            // Constant table/column names only; values remain bound. Each refusal has its own transaction.
            await expect(withTenant(f.hr.ctx, tx => tx.execute(sql`UPDATE public.${sql.identifier(target.table)} SET ${sql.identifier(target.field)}='Forged history' WHERE id=${target.id}::uuid`))).rejects.toMatchObject({ cause: expect.objectContaining({ code: '42501' }) });
            await expect(withTenant(f.hr.ctx, tx => tx.execute(sql`DELETE FROM public.${sql.identifier(target.table)} WHERE id=${target.id}::uuid`))).rejects.toMatchObject({ cause: expect.objectContaining({ code: '42501' }) });
        }
        const after = await state(f);
        expect(after.workflow?.participantDecisions).toEqual(before.workflow!.participantDecisions);
        expect(after.workflow?.participantReassignments).toEqual(before.workflow!.participantReassignments);
        expect(after.workflow?.stages).toEqual(before.workflow!.stages);
    });
    it('binds a genuine active final proof to its exact request, subject, day and real actor', async () => {
        const f = await fixture('sequential', true), other = await actor('Fictional other effect subject');
        const previousDay = new Date(`${f.on}T12:00:00Z`); previousDay.setUTCDate(previousDay.getUTCDate() - 1);
        const wrongDate = previousDay.toISOString().slice(0, 10);
        const rollback = new Error('Intentional rollback of v3 exact final-proof diagnostic');
        let observed = false;
        await expect(withTenant(f.hr.ctx, async tx => {
            await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${b.tenantId + ':' + f.worker.employmentId},0))`);
            await tx.execute(sql`select id from attendance_correction where id=${f.id}::uuid for update`);
            await tx.execute(sql`SAVEPOINT v3_exact_effect`);
            expect(await decideAttendanceWorkflowStageTx(tx, f.hr.ctx, { correctionId: f.id, employmentId: f.worker.employmentId, decision: 'approved', expectedStageIndex: 0, expectedParticipantSlot: '0:0' })).toMatchObject({ final: true, versionedFinalEffect: true });
            await tx.execute(sql`select app.attendance_workflow_begin_effect(${f.id}::uuid)`);
            const [scope] = await tx.execute(sql`select app.attendance_workflow_effect_scope(${f.worker.employmentId}::uuid,${f.on}::date) as exact,app.attendance_workflow_effect_scope(${f.worker.employmentId}::uuid,${wrongDate}::date) as wrong_day,app.attendance_workflow_effect_scope(${other.employmentId}::uuid,${f.on}::date) as wrong_subject`) as unknown as { exact: boolean; wrong_day: boolean; wrong_subject: boolean }[];
            expect(scope).toEqual({ exact: true, wrong_day: false, wrong_subject: false });
            await tx.execute(sql`select set_config('app.attendance_workflow_effect',${randomUUID()},true)`);
            const [wrongRequest] = await tx.execute(sql`select app.attendance_workflow_effect_scope(${f.worker.employmentId}::uuid,${f.on}::date) as ok`) as unknown as { ok: boolean }[];
            expect(wrongRequest.ok).toBe(false);
            await tx.execute(sql`select set_config('app.attendance_workflow_effect',${f.id},true),set_config('app.user_id',${f.first.ctx.userId!},true)`);
            const [wrongActor] = await tx.execute(sql`select app.attendance_workflow_effect_scope(${f.worker.employmentId}::uuid,${f.on}::date) as ok`) as unknown as { ok: boolean }[];
            expect(wrongActor.ok).toBe(false);
            await tx.execute(sql`select set_config('app.user_id',${f.hr.ctx.userId!},true)`);
            const [restored] = await tx.execute(sql`select app.attendance_workflow_effect_scope(${f.worker.employmentId}::uuid,${f.on}::date) as ok`) as unknown as { ok: boolean }[];
            expect(restored.ok).toBe(true);
            observed = true;
            throw rollback;
        })).rejects.toBe(rollback);
        expect(observed).toBe(true);
        expect((await state(f)).workflow?.participantDecisions).toHaveLength(0);
        expect((await state(f)).workflow?.decisions).toHaveLength(0);
        expect((await day(f)).checkInAt).toBe('08:00:00');
    });
});


describe('ordinary v3 OT level completion is history, not a cash-source mutation', () => {
    async function recordedSource(f: Awaited<ReturnType<typeof fixture>>) {
        const rows = await owner.db.select().from(schema.attendanceOvertimeSource).where(and(eq(schema.attendanceOvertimeSource.employmentId, f.worker.employmentId), eq(schema.attendanceOvertimeSource.attendanceDate, f.on)));
        expect(rows).toHaveLength(1); // The old guard's no-source shortcut must NOT hide this regression.
        return rows[0];
    }
    it('records an ordinary non-final OT level against a real source without changing inputs or Payroll', async () => {
        const f = await fixture('sequential', false, true, false, true);
        const source = await recordedSource(f), beforeDay = await day(f);
        const { batchId } = await createBatch(f.root, { companyId: b.companyId, payPeriod: f.on.slice(0, 7), scope: { employmentIds: [f.worker.employmentId] } });
        const [batch] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
        const settlements = await owner.db.select().from(schema.overtimeSourceSettlement).where(eq(schema.overtimeSourceSettlement.sourceId, source.id));
        const [authority] = await withTenant(f.second.ctx, tx => tx.execute(sql`select current_user as role,app.can_see_employment(${f.worker.employmentId}::uuid) as personnel,app.can_admin_payroll_employment(${f.worker.employmentId}::uuid) as payroll`)) as unknown as { role: string; personnel: boolean; payroll: boolean }[];
        expect(authority).toEqual({ role: 'ai_hr_app', personnel: false, payroll: false });
        await decideAttendanceCorrection(f.first.ctx, { correctionId: f.id, decision: 'approved', expectedStageIndex: 0, expectedParticipantSlot: '0:0' });
        expect((await state(f)).workflow?.decisions).toHaveLength(0);
        const result = await decideAttendanceCorrection(f.second.ctx, { correctionId: f.id, decision: 'approved', expectedStageIndex: 0, expectedParticipantSlot: '0:1' });
        expect(result).toMatchObject({ status: 'pending' });
        const detail = await state(f);
        expect(detail.workflow?.currentStage).toBe(1);
        expect(detail.workflow?.participantDecisions).toHaveLength(2);
        expect(detail.workflow?.decisions).toMatchObject([{ decision: 'approved', resultingStatus: 'pending', actualUserId: f.second.ctx.userId }]);
        expect(detail.application.status).toBe('pending');
        expect(await day(f)).toEqual(beforeDay);
        expect(await recordedSource(f)).toEqual(source);
        expect(await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId))).toEqual([batch]);
        expect(await owner.db.select().from(schema.overtimeSourceSettlement).where(eq(schema.overtimeSourceSettlement.sourceId, source.id))).toEqual(settlements);
        expect(await owner.db.select({ id: schema.domainEvent.id }).from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId, source.id), eq(schema.domainEvent.eventType, 'overtime.cash-source.invalidated')))).toEqual([]);
    });
    it('does not exempt a forged, committed-participant or foreign-tenant completion', async () => {
        const f = await fixture('sequential', false, true, false, true), before = await state(f);
        await recordedSource(f);
        const forged = (ctx: SessionContext, who = f.first) => withTenant(ctx, tx => tx.insert(schema.attendanceWorkflowDecision).values({ tenantId: b.tenantId, requestId: before.workflow!.id, employmentId: f.worker.employmentId, stageIndex: 0,
            decision: 'approved', assignedKind: 'specific_employee', assignedEmploymentId: who.employmentId, actualUserId: ctx.userId!, actualPersonId: ctx.personId!, actualEmploymentId: who.employmentId,
            actualActorName: 'Untrusted input', actingMode: 'assigned', previousStatus: 'pending', resultingStatus: 'pending' }));
        await expect(forged(f.first.ctx)).rejects.toMatchObject({ cause: expect.objectContaining({ message: expect.stringContaining('fulfilled participant level') }) });
        await decideAttendanceCorrection(f.first.ctx, { correctionId: f.id, decision: 'approved', expectedStageIndex: 0, expectedParticipantSlot: '0:0' });
        await expect(forged(f.first.ctx)).rejects.toMatchObject({ cause: expect.objectContaining({ message: expect.stringContaining('fulfilled participant level') }) });
        const otherBase = await seedBase(), foreign = await actor('Fictional foreign completion actor', 'employee', otherBase.deptB, otherBase);
        expect(await withTenant(foreign.ctx, tx => tx.select({ id: schema.employment.id }).from(schema.employment).where(eq(schema.employment.id, foreign.employmentId)))).toEqual([{ id: foreign.employmentId }]);
        await expect(forged(foreign.ctx, foreign)).rejects.toThrow();
        const detail = await state(f);
        expect(detail.workflow?.participantDecisions).toHaveLength(1);
        expect(detail.workflow?.decisions).toHaveLength(0);
        expect(detail.application.status).toBe('pending');
    });
    it('retains final ordinary OT handoff even with a real source, then allows the scoped HR owner', async () => {
        const f = await fixture('sequential', true, true, true, true), source = await recordedSource(f), beforeDay = await day(f);
        await expect(decideAttendanceCorrection(f.first.ctx, { correctionId: f.id, decision: 'approved', expectedStageIndex: 0, expectedParticipantSlot: '0:0' })).rejects.toMatchObject({ problem: { code: 'hr_handoff_required', levelIndex: 0 } });
        expect((await state(f)).workflow?.participantDecisions).toHaveLength(0);
        expect((await state(f)).workflow?.decisions).toHaveLength(0);
        expect(await recordedSource(f)).toEqual(source);
        expect(await day(f)).toEqual(beforeDay);
        await reassignAttendanceWorkflowStageToHr(f.hr.ctx, { correctionId: f.id, expectedStageIndex: 0, expectedParticipantSlot: '0:0', reason: 'Final calculation remains with scoped HR' });
        await expect(decideAttendanceCorrection(f.hr.ctx, { correctionId: f.id, decision: 'approved', expectedStageIndex: 0, expectedParticipantSlot: '0:0' })).resolves.toMatchObject({ status: 'approved' });
        expect((await state(f)).workflow?.participantDecisions).toHaveLength(1);
        expect((await state(f)).workflow?.participantReassignments).toHaveLength(1);
    });
});


describe('terminal OT rejection retains the canonical calculation boundary', () => {
    it.each(['self_overtime', 'irregularity_with_ot'] as const)('hands off an ordinary %s rejection without losing prior participant work', async kind => {
        const f = kind === 'self_overtime'
            ? await fixture('sequential', false, true, false, true)
            : await fixture('sequential', false, false, false, false, true);
        const [source] = await owner.db.select().from(schema.attendanceOvertimeSource).where(and(eq(schema.attendanceOvertimeSource.employmentId, f.worker.employmentId), eq(schema.attendanceOvertimeSource.attendanceDate, f.on)));
        expect(source?.id).toBeTruthy(); // Positively covers the old cash-source guard, not its absence shortcut.
        const [subjectAuthority] = await withTenant(f.second.ctx, tx => tx.execute(sql`select current_user as role,app.can_see_employment(${f.worker.employmentId}::uuid) as personnel`)) as unknown as { role: string; personnel: boolean }[];
        expect(subjectAuthority).toEqual({ role: 'ai_hr_app', personnel: false });
        await decideAttendanceCorrection(f.first.ctx, { correctionId: f.id, decision: 'approved', expectedStageIndex: 0, expectedParticipantSlot: '0:0', remarks: 'Earlier work is retained' });
        const before = await state(f), beforeDay = await day(f);
        expect(before.workflow?.participantDecisions).toHaveLength(1);
        await expect(decideAttendanceCorrection(f.second.ctx, { correctionId: f.id, decision: 'rejected', rejectReason: 'Ordinary participant requests a rejection', expectedStageIndex: 0, expectedParticipantSlot: '0:1' })).rejects.toMatchObject({ problem: { code: 'hr_handoff_required', levelIndex: 0 } });
        const pending = await state(f);
        expect(pending.application.status).toBe('pending');
        expect(pending.workflow?.currentStage).toBe(0);
        expect(pending.workflow?.participantDecisions).toEqual(before.workflow!.participantDecisions);
        expect(pending.workflow?.decisions).toHaveLength(0);
        expect(await day(f)).toEqual(beforeDay);
        expect(await owner.db.select().from(schema.attendanceOvertimeSource).where(eq(schema.attendanceOvertimeSource.id, source.id))).toEqual([source]);
        await reassignAttendanceWorkflowStageToHr(f.hr.ctx, { correctionId: f.id, expectedStageIndex: 0, expectedParticipantSlot: '0:1', reason: 'Scoped HR owns the terminal OT input decision' });
        await decideAttendanceCorrection(f.hr.ctx, { correctionId: f.id, decision: 'rejected', rejectReason: 'Scoped HR checked and rejected the evidence', expectedStageIndex: 0, expectedParticipantSlot: '0:1' });
        const rejected = await state(f);
        expect(rejected.application.status).toBe('rejected');
        expect(rejected.workflow?.currentStage).toBe(rejected.workflow!.stages.length);
        expect(rejected.workflow?.stages).toEqual(before.workflow!.stages);
        expect(rejected.workflow?.participantDecisions).toHaveLength(2);
        expect(rejected.workflow?.participantDecisions[0]).toEqual(before.workflow!.participantDecisions[0]);
        expect(rejected.workflow?.participantDecisions[1]).toMatchObject({ decision: 'rejected', actualUserId: f.hr.ctx.userId, remarks: 'Scoped HR checked and rejected the evidence' });
        expect(rejected.workflow?.decisions).toMatchObject([{ decision: 'rejected', resultingStatus: 'rejected', actualUserId: f.hr.ctx.userId }]);
        expect(rejected.workflow?.participantReassignments).toHaveLength(1);
        expect(await day(f)).toEqual(beforeDay); // No attendance/payable effect is applied on rejection.
    });
});
