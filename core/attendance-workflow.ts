import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { type SessionContext, type Tx } from '../db/client';
import { withAttendanceTenant as withTenant } from './module-gate';
import { actorOf, appendEvent, type AppendEventArgs } from '../db/events';
import { attendanceWorkflowTemplate as template, attendanceWorkflowSetting as setting, attendanceWorkflowRequest as request, attendanceWorkflowDecision as decision, attendanceWorkflowReassignment as reassignment, attendanceWorkflowParticipantDecision as participantDecision, attendanceWorkflowParticipantReassignment as participantReassignment, employment, person, department, businessUnit, jobGrade, profileOption, position } from '../db/schema';
import { approversOf } from '../lib/leave-approval-kinds';
import { todayInKualaLumpur } from '../lib/hr-date';
import { resolveOrgCriteriaTargets } from './org-criteria';
import { assertCanDecide } from './approvals';
import { scopeOf } from '../lib/delegation-scope';
import { CATEGORY_EMPLOYMENT_COLUMN, EMPLOYMENT_PROFILE_CATEGORIES } from './profile-options';
import { labelUsableByCompany } from './system-labels';
import { AttendanceWorkflowError, attendanceScopesOverlap, validateAttendanceWorkflow, type AttendanceWorkflowInput, type AttendanceApplicationType, type AttendanceResolvedStage, type AttendanceResolvedApprover } from '../lib/attendance-workflow';
import { AttendanceLevelError, validateAnyAttendanceWorkflow, type AnyAttendanceWorkflowInput, type AttendanceLevelProblem, type AttendanceV3FrozenLevel } from '../lib/attendance-workflow-v3';
export type { AnyAttendanceWorkflowInput } from '../lib/attendance-workflow-v3';
export { AttendanceWorkflowError } from '../lib/attendance-workflow';
export type { AttendanceWorkflowInput, AttendanceApplicationType } from '../lib/attendance-workflow';
async function adminFor(tx: Tx, companyId: string) {
    const rows = await tx.execute(sql `select app.is_admin_for(c.id) as ok from company c where c.id=${companyId}::uuid and c.tenant_id=app.current_tenant_id()`);
    if (!(rows as unknown as {
        ok: boolean;
    }[])[0]?.ok)
        throw new AttendanceWorkflowError('scope', 'Only an administrator for this company may configure attendance workflows.');
}
const companyLock = (tx: Tx, tenantId: string, companyId: string, type: string) => tx.execute(sql `select pg_advisory_xact_lock(hashtextextended(${tenantId + ':attendance-workflow:' + companyId + ':' + type},0))`);
async function validateScope(tx: Tx, ctx: SessionContext, input: AnyAttendanceWorkflowInput) {
    if (input.routingVersion === 3) {
        const eligible = await tx.execute(sql`select id from app.attendance_workflow_v3_approver_options(${[input.companyId]}::uuid[])`) as unknown as { id: string }[];
        const allowed = new Set(eligible.map(row => row.id));
        for (const [levelIndex, stage] of input.stages.entries()) {
            if (stage.source.kind !== 'specific_employee') continue;
            for (const [participantIndex, employmentId] of stage.source.employmentIds.entries()) if (!allowed.has(employmentId)) throw new AttendanceLevelError({ code: 'employee_unavailable', levelIndex, participantIndex });
        }
    }

    for (const [key, table] of [['departmentIds', department], ['businessUnitIds', businessUnit], ['gradeIds', jobGrade], ['positionIds', position]] as const) {
        const ids = input.criteria[key] ?? [];
        if (ids.length) {
            const found = await tx.select({ id: table.id }).from(table).where(and(inArray(table.id, ids), isNull(table.archivedAt)));
            if (found.length !== ids.length)
                throw new AttendanceWorkflowError('invalid', 'An organisational assignment is missing, inactive or outside your access.');
            if (key !== 'gradeIds')
                for (const id of ids)
                    if (!(await labelUsableByCompany(tx, ctx.tenantId, key === 'departmentIds' ? 'department' : key === 'positionIds' ? 'position' : 'business_unit', id, input.companyId)))
                        throw new AttendanceWorkflowError('invalid', 'An organisational assignment is not available to this company.');
        }
    }
    for (const category of EMPLOYMENT_PROFILE_CATEGORIES) {
        const key = CATEGORY_EMPLOYMENT_COLUMN[category]?.[0] as keyof AttendanceWorkflowInput['criteria'];
        const selected = input.criteria[key] ?? [];
        if (!selected.length) continue;
        const rows = await tx.select({ value: profileOption.value }).from(profileOption).where(and(eq(profileOption.category, category), inArray(profileOption.value, selected), eq(profileOption.isActive, true)));
        if (new Set(rows.map(r => r.value)).size !== selected.length) throw new AttendanceWorkflowError('invalid', `An assignment in ${category} is missing or inactive.`);
    }
    const selectedEmployees = input.criteria.employeeIds ?? [];
    if (selectedEmployees.length) {
        const rows = await resolveOrgCriteriaTargets(tx, { criteria: { companyIds: [input.companyId] }, asOf: todayInKualaLumpur(), employmentIds: selectedEmployees });
        if (rows.length !== selectedEmployees.length) throw new AttendanceWorkflowError('invalid', 'An employee is missing, inactive or outside the selected company.');
    }

}
/** Employee IDs are an additional intersected restriction, not a new org-criteria interpretation. */
async function workflowTargets(tx: Tx, criteria: AnyAttendanceWorkflowInput['criteria'], companyId: string, employmentIds?: string[]) {
    const { employeeIds = [], ...orgCriteria } = criteria;
    const restricted = employeeIds.length ? employmentIds?.length ? employmentIds.filter(id => employeeIds.includes(id)) : employeeIds : employmentIds;
    if (employmentIds?.length && employeeIds.length && !restricted?.length) return [];
    return resolveOrgCriteriaTargets(tx, { criteria: { ...orgCriteria, companyIds: [companyId] }, asOf: todayInKualaLumpur(), employmentIds: restricted });
}
async function resolveStages(tx: Tx, employmentId: string, configured: AnyAttendanceWorkflowInput['stages'], routingVersion: 1 | 2 | 3 = 1): Promise<AttendanceResolvedStage[]> {
    if (routingVersion === 3) {
        try {
            const [result] = await tx.execute(sql`select app.attendance_workflow_resolve_v3(${employmentId}::uuid,${JSON.stringify(configured)}::jsonb) as result`) as unknown as { result: { ok: true; stages: AttendanceV3FrozenLevel[] } | { ok: false; problem: AttendanceLevelProblem } }[];
            if (!result?.result) throw new AttendanceLevelError({ code: 'employee_unavailable', levelIndex: null });
            if (!result.result.ok) throw new AttendanceLevelError(result.result.problem);
            return result.result.stages;
        } catch (error) {
            if (error instanceof AttendanceLevelError) throw error;
            throw new AttendanceLevelError({ code: 'employee_unavailable', levelIndex: null });
        }
    }
    // V3 has its own exact parser; legacy stages retain the unchanged Leave-compatible vocabulary.
    const stages = configured as AttendanceWorkflowInput['stages'];
    if (routingVersion === 2) {
        try {
            const [row] = await tx.execute(sql`select app.attendance_workflow_resolve_v2(${employmentId}::uuid,${JSON.stringify(stages)}::jsonb) as stages`) as unknown as { stages: AttendanceResolvedStage[] }[];
            if (!row?.stages?.length) throw new AttendanceWorkflowError('unresolved', 'No valid hierarchy approvers could be resolved. Contact HR to correct the reporting relationship.');
            return row.stages;
        } catch (error) {
            if (error instanceof AttendanceWorkflowError) throw error;
            throw new AttendanceWorkflowError('unresolved', 'A required Direct Superior is missing, inactive, repeated or outside the permitted hierarchy. Contact HR to correct the relationship or explicitly configure an HR alternative.');
        }
    }
    const needsManager = stages.some(stage => approversOf(stage.level).some(actor => actor.kind === 'direct_manager'));
    const managers = needsManager
        ? await tx.execute(sql `select * from app.attendance_workflow_manager(${employmentId}::uuid)`) as unknown as {
            employment_id: string;
            full_name: string;
        }[]
        : [];
    const needsHr = stages.some(stage => approversOf(stage.level).some(actor => actor.kind === 'hr_admin'));
    const hr = needsHr
        ? await tx.execute(sql `select app.attendance_workflow_has_hr(${employmentId}::uuid) as ok`) as unknown as {
            ok: boolean;
        }[]
        : [];
    for (const stage of stages) {
        const usable = approversOf(stage.level).some(actor => actor.kind === 'direct_manager' ? managers.length === 1 : hr[0]?.ok === true);
        if (!usable) {
            throw new AttendanceWorkflowError('unresolved', 'This approval stage has no active non-self approver with authority for the employee. Assign another authorised HR administrator or change the stage before activating or submitting.');
        }
    }
    return stages.map(stage => ({
        name: stage.name,
        approvers: approversOf(stage.level).flatMap<AttendanceResolvedApprover>(actor => actor.kind === 'direct_manager'
            ? managers.length === 1 ? [{ kind: 'direct_manager' as const, employmentId: managers[0].employment_id, name: managers[0].full_name }] : []
            : hr[0]?.ok === true ? [{ kind: 'hr_admin' as const, employmentId: null, name: 'HR administrators' }] : []),
    }));
}
async function validateActivation(tx: Tx, ctx: SessionContext, input: AnyAttendanceWorkflowInput, lineageId?: string) {
    const others = await tx.select().from(template).where(and(eq(template.companyId, input.companyId), eq(template.applicationType, input.applicationType), eq(template.active, true), isNull(template.supersededAt)));
    if (others.some(t => t.lineageId !== lineageId && t.priority === input.priority && attendanceScopesOverlap(t.criteria, input.criteria)))
        throw new AttendanceWorkflowError('overlap', 'An active workflow at this priority overlaps this assignment. Use a different priority or disjoint scope. Lower priority numbers apply first.');
    const targets = await workflowTargets(tx, input.criteria, input.companyId);
    for (const id of targets)
        await resolveStages(tx, id, input.stages, input.routingVersion);
    // Zero targets is allowed as a future population. Submission re-resolves and refuses missing approvers.
}
export async function saveAttendanceWorkflow(ctx: SessionContext, raw: unknown, lineageId?: string) {
    const input = validateAnyAttendanceWorkflow(raw);
    return withTenant(ctx, async (tx) => {
        await adminFor(tx, input.companyId);
        await companyLock(tx, ctx.tenantId, input.companyId, input.applicationType);
        const [old] = lineageId ? await tx.select().from(template).where(and(eq(template.lineageId, lineageId), isNull(template.supersededAt))).for('update') : [];
        if (lineageId && (!old || old.companyId !== input.companyId || old.applicationType !== input.applicationType))
            throw new AttendanceWorkflowError('scope', 'The workflow was changed or is outside this company.');
        await validateScope(tx, ctx, input);
        if (input.active)
            await validateActivation(tx, ctx, input, lineageId);
        if (old)
            await tx.update(template).set({ supersededAt: new Date() }).where(eq(template.id, old.id));
        const lineage = lineageId ?? randomUUID();
        const [row] = await tx.insert(template).values({ tenantId: ctx.tenantId, ...input, lineageId: lineage, version: (old?.version ?? 0) + 1 }).returning();
        await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'attendance-workflow-template', aggregateId: lineage, eventType: old ? 'attendance-workflow-template.versioned' : 'attendance-workflow-template.created', actor: actorOf(ctx), payload: { companyId: input.companyId, templateId: row.id, version: row.version, before: old ?? null, after: input } });
        return row;
    });
}
export function listAttendanceWorkflows(ctx: SessionContext, companyIds: string[]) {
    return withTenant(ctx, tx => companyIds.length ? tx.select().from(template).where(and(inArray(template.companyId, companyIds), isNull(template.supersededAt))).orderBy(asc(template.companyId), asc(template.applicationType), asc(template.priority), asc(template.code)) : Promise.resolve([]));
}
export function getAttendanceWorkflow(ctx: SessionContext, lineageId: string, companyIds: string[]) {
    return withTenant(ctx, async (tx) => companyIds.length ? (await tx.select().from(template).where(and(eq(template.lineageId, lineageId), inArray(template.companyId, companyIds), isNull(template.supersededAt))).limit(1))[0] ?? null : null);
}
export function listAttendanceWorkflowSettings(ctx: SessionContext, companyIds: string[]) {
    return withTenant(ctx, tx => companyIds.length ? tx.select().from(setting).where(inArray(setting.companyId, companyIds)).orderBy(asc(setting.companyId), asc(setting.applicationType)) : Promise.resolve([]));
}
export async function setAttendanceWorkflowEnabled(ctx: SessionContext, companyId: string, applicationType: AttendanceApplicationType, enabled: boolean) {
    if (!['irregularity', 'self_overtime'].includes(applicationType))
        throw new AttendanceWorkflowError('invalid', 'Choose a supported attendance application type.');
    return withTenant(ctx, async (tx) => {
        await adminFor(tx, companyId);
        await companyLock(tx, ctx.tenantId, companyId, applicationType);
        if (enabled) {
            const active = await tx.select().from(template).where(and(eq(template.companyId, companyId), eq(template.applicationType, applicationType), eq(template.active, true), isNull(template.supersededAt)));
            if (!active.length)
                throw new AttendanceWorkflowError('invalid', 'Create and activate valid templates before enabling routing.');
            for (const row of active) {
                const input = validateAnyAttendanceWorkflow({ ...row, description: row.description ?? '', active: true });
                await validateScope(tx, ctx, input);
                await validateActivation(tx, ctx, input, row.lineageId);
            }
        }
        const [previous] = await tx.select().from(setting).where(and(eq(setting.companyId, companyId), eq(setting.applicationType, applicationType)));
        await tx.insert(setting).values({ tenantId: ctx.tenantId, companyId, applicationType, enabled }).onConflictDoUpdate({ target: [setting.tenantId, setting.companyId, setting.applicationType], set: { enabled, updatedAt: new Date() } });
        await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'attendance-workflow-setting', aggregateId: companyId, eventType: 'attendance-workflow.routing.changed', actor: actorOf(ctx), payload: { companyId, applicationType, before: previous?.enabled ?? false, after: enabled } });
    });
}
/** In the correction submission transaction. Old rows have no snapshot and always keep legacy routing. */
export async function snapshotAttendanceWorkflowTx(tx: Tx, ctx: SessionContext, correctionId: string, employmentId: string, applicationType: AttendanceApplicationType) {
    const [subject] = await tx.select({ companyId: employment.companyId }).from(employment).where(eq(employment.id, employmentId)).limit(1);
    if (!subject)
        throw new AttendanceWorkflowError('scope', 'The employee is not visible.');
    await companyLock(tx, ctx.tenantId, subject.companyId, applicationType);
    const [config] = await tx.select().from(setting).where(and(eq(setting.companyId, subject.companyId), eq(setting.applicationType, applicationType)));
    if (!config?.enabled)
        return null;
    const candidates = await tx.select().from(template).where(and(eq(template.companyId, subject.companyId), eq(template.applicationType, applicationType), eq(template.active, true), isNull(template.supersededAt))).orderBy(asc(template.priority), asc(template.id));
    const matches: typeof candidates = [];
    for (const row of candidates)
        if ((await workflowTargets(tx, row.criteria, subject.companyId, [employmentId])).includes(employmentId))
            matches.push(row);
    if (!matches.length)
        throw new AttendanceWorkflowError('noMatch', 'Attendance workflow routing is enabled, but no active template matches this employee and application type. Ask HR to configure the assignment.');
    if (matches.filter(row => row.priority === matches[0].priority).length !== 1)
        throw new AttendanceWorkflowError('tie', 'More than one attendance workflow matches at the highest priority. Ask HR to resolve the conflicting assignments.');
    const selected = matches[0], validated = validateAnyAttendanceWorkflow({ ...selected, description: selected.description ?? '' }), stages = await resolveStages(tx, employmentId, validated.stages, validated.routingVersion);
    const [snapshot] = await tx.insert(request).values({ tenantId: ctx.tenantId, correctionId, employmentId, companyId: subject.companyId, templateId: selected.id, templateCode: selected.code, templateName: selected.name, templateVersion: selected.version, applicationType, routingVersion: validated.routingVersion, stages }).returning();
    await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'attendance-correction', aggregateId: correctionId, eventType: 'attendance-workflow.resolved', actor: actorOf(ctx), subjectEmploymentId: employmentId, payload: { workflowRequestId: snapshot.id, templateId: selected.id, templateVersion: selected.version, stages } });
    return snapshot;
}
/** A workflow assignment grants authority only for its request, never generic Personnel correction access. */
export async function assertCanDecideAttendanceApplicationTx(tx: Tx, ctx: SessionContext, correctionId: string, employmentId: string) {
    const [flow] = await tx.select({ routingVersion: request.routingVersion, employmentId: request.employmentId }).from(request).where(eq(request.correctionId, correctionId)).limit(1);
    if (flow?.routingVersion === 3) {
        if (flow.employmentId !== employmentId) throw new AttendanceWorkflowError('scope', 'The application subject does not match its frozen workflow.');
        const [allowed] = await tx.execute(sql`select app.attendance_workflow_v3_decision_slot(${correctionId}::uuid) as slot`) as unknown as { slot: unknown }[];
        if (!allowed?.slot) throw new AttendanceWorkflowError('notApprover', 'Only the next distinct authorized participant may decide this frozen attendance request.');
        return;
    }
    if (flow?.routingVersion === 2) {
        if (flow.employmentId !== employmentId) throw new AttendanceWorkflowError('scope', 'The application subject does not match its frozen workflow.');
        const [allowed] = await tx.execute(sql`select app.attendance_workflow_v2_decide(${correctionId}::uuid) as ok`) as unknown as { ok: boolean }[];
        if (!allowed?.ok) throw new AttendanceWorkflowError('notApprover', 'Only the current frozen approver, their valid delegate or scoped HR may decide this level. Each level requires a different authorized person.');
        return;
    }
    await assertCanDecide(tx, ctx, employmentId, 'attendance application', scopeOf('attendance.correction'));
}
async function effectiveStageTx(tx: Tx, flow: typeof request.$inferSelect, index: number) {
    const stage = flow.stages[index];
    if (!stage) return stage;
    if (flow.routingVersion === 3) {
        const changes = await tx.select().from(participantReassignment).where(and(eq(participantReassignment.requestId, flow.id), eq(participantReassignment.stageIndex, index))).orderBy(asc(participantReassignment.occurredAt), asc(participantReassignment.id));
        return { ...stage, approvers: stage.approvers.map(actor => changes.filter(change => change.participantSlot === actor.slot).at(-1)?.assigned ?? actor) };
    }
    if (flow.routingVersion !== 2) return stage;
    const [latest] = await tx.select().from(reassignment).where(and(eq(reassignment.requestId, flow.id), eq(reassignment.stageIndex, index))).orderBy(sql`${reassignment.occurredAt} desc`, sql`${reassignment.id} desc`).limit(1);
    return latest ? { ...stage, approvers: latest.approvers } : stage;
}
export type AttendanceStageResult = {
    routed: boolean;
    final: boolean;
    currentStage?: number;
    delegatedFinalStageIndex?: number;
    /** V2/v3 final effects retain the real actor and install only a verified request-ID capability. */
    versionedFinalEffect?: boolean;
    actualDeciderEmploymentId?: string | null;
    /** Fixed audit data only. The final caller emits it after effect/payroll locks and identity restoration. */
    finalApprovalEvent?: AppendEventArgs;
};
/** V3 records each required person before considering the existing stage-completion grain. */
async function decideAttendanceParticipantTx(tx: Tx, ctx: SessionContext, flow: typeof request.$inferSelect, p: {
    correctionId: string; employmentId: string; decision: 'approved' | 'rejected'; remarks?: string; expectedParticipantSlot?: string;
}): Promise<AttendanceStageResult> {
    const [authority] = await tx.execute(sql`select app.attendance_workflow_v3_decision_slot(${p.correctionId}::uuid) as actor`) as unknown as { actor: { slot: string; assigned: AttendanceResolvedApprover; actingMode: 'assigned' | 'delegate' } | null }[];
    if (!authority?.actor || authority.actor.slot !== p.expectedParticipantSlot) throw new AttendanceWorkflowError('stale', 'The pending participant changed. Reload before deciding this application.');
    if (!ctx.userId || !ctx.personId) throw new AttendanceWorkflowError('notApprover', 'A linked live participant identity is required.');
    const assigned = authority.actor.assigned;
    const actualEmploymentId = authority.actor.actingMode === 'assigned' ? assigned.employmentId : null;
    const [recorded] = await tx.insert(participantDecision).values({ tenantId: ctx.tenantId, requestId: flow.id, employmentId: flow.employmentId, stageIndex: flow.currentStage,
        participantSlot: authority.actor.slot, decision: p.decision, assigned, actualUserId: ctx.userId, actualPersonId: ctx.personId,
        actualEmploymentId, actualActorName: '', actingMode: authority.actor.actingMode, remarks: p.remarks?.trim() || null }).returning();
    const [fulfillment] = await tx.execute(sql`select app.attendance_workflow_v3_completed(${flow.id}::uuid,${flow.currentStage}) as decision`) as unknown as { decision: 'approved' | 'rejected' | null }[];
    const participantPayload = { workflowRequestId: flow.id, participantDecisionId: recorded.id, stageIndex: flow.currentStage, participantSlot: recorded.participantSlot,
        decision: recorded.decision, assignedApprover: recorded.assigned, actualPersonId: recorded.actualPersonId, actualEmploymentId, actingMode: recorded.actingMode,
        remarks: recorded.remarks, decidedAt: recorded.decidedAt.toISOString() };
    if (!fulfillment?.decision) {
        await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'attendance-correction', aggregateId: p.correctionId, eventType: 'attendance-workflow.participant.decided', actor: actorOf(ctx), subjectEmploymentId: flow.employmentId, payload: participantPayload });
        return { routed: true, final: false, currentStage: flow.currentStage, actualDeciderEmploymentId: actualEmploymentId };
    }
    const final = fulfillment.decision === 'rejected' || flow.currentStage === flow.stages.length - 1;
    if (final && fulfillment.decision === 'approved') {
        const [visibility] = await tx.execute(sql`select app.can_see_employment(${flow.employmentId}::uuid) as ok`) as unknown as { ok: boolean }[];
        if (!visibility?.ok) throw new AttendanceLevelError({ code: 'hr_handoff_required', levelIndex: flow.currentStage });
    }

    await tx.insert(decision).values({ tenantId: ctx.tenantId, requestId: flow.id, employmentId: flow.employmentId, stageIndex: flow.currentStage,
        decision: fulfillment.decision, assignedKind: assigned.kind, assignedEmploymentId: assigned.employmentId,
        actualUserId: ctx.userId, actualPersonId: ctx.personId, actualEmploymentId, actualActorName: recorded.actualActorName,
        actingMode: recorded.actingMode, remarks: recorded.remarks, previousStatus: 'pending', resultingStatus: final ? fulfillment.decision : 'pending' });
    await tx.update(request).set({ currentStage: final ? flow.stages.length : flow.currentStage + 1 }).where(eq(request.id, flow.id));
    const stageEvent: AppendEventArgs = { tenantId: ctx.tenantId, aggregateType: 'attendance-correction', aggregateId: p.correctionId,
        eventType: 'attendance-workflow.stage.decided', actor: actorOf(ctx), subjectEmploymentId: flow.employmentId,
        payload: { ...participantPayload, stageName: flow.stages[flow.currentStage].name, previousStatus: 'pending', resultingStatus: final ? fulfillment.decision : 'pending' } };
    // The final caller emits this only after canonical effect/payroll locks; do not invert the audit lock.
    if (!final || fulfillment.decision !== 'approved') await appendEvent(tx, stageEvent);
    return { routed: true, final, currentStage: final ? flow.stages.length : flow.currentStage + 1, actualDeciderEmploymentId: actualEmploymentId,
        ...(final && fulfillment.decision === 'approved' ? { versionedFinalEffect: true, finalApprovalEvent: stageEvent } : {}) };
}
/** Called by EVERY decide path before touching attendance. Request row is already locked by the caller. */
export async function decideAttendanceWorkflowStageTx(tx: Tx, ctx: SessionContext, p: {
    correctionId: string;
    employmentId: string;
    decision: 'approved' | 'rejected';
    remarks?: string;
    expectedStageIndex?: number;
    expectedParticipantSlot?: string;
}): Promise<AttendanceStageResult> {
    const [flow] = await tx.select().from(request).where(eq(request.correctionId, p.correctionId)).limit(1).for('update');
    if (!flow)
        return { routed: false, final: true };
    if (p.expectedStageIndex !== flow.currentStage)
        throw new AttendanceWorkflowError('stale', 'The pending approval stage changed. Reload the application before deciding it.');
    await assertCanDecideAttendanceApplicationTx(tx, ctx, p.correctionId, p.employmentId);
    if (flow.routingVersion === 3) return decideAttendanceParticipantTx(tx, ctx, flow, p);
    const stage = await effectiveStageTx(tx, flow, flow.currentStage);
    if (!stage)
        throw new AttendanceWorkflowError('stale', 'This workflow has already completed.');
    const [subject] = await tx.select({ personId: employment.personId, companyId: employment.companyId }).from(employment).where(eq(employment.id, p.employmentId));
    if (ctx.personId && subject?.personId === ctx.personId)
        throw new AttendanceWorkflowError('notApprover', 'You cannot decide your own attendance application.');
    const adminRows = await tx.execute(sql `select app.can_admin_employment(${p.employmentId}::uuid) as ok`);
    const isAdmin = (adminRows as unknown as {
        ok: boolean;
    }[])[0]?.ok === true;
    let assigned: AttendanceResolvedApprover | undefined, mode: 'assigned' | 'delegate' | 'administrator' = 'assigned';
    if (flow.routingVersion === 2) {
        const previous = await tx.select({ userId: decision.actualUserId, personId: decision.actualPersonId }).from(decision).where(eq(decision.requestId, flow.id));
        if (previous.some(d => d.userId === ctx.userId || (ctx.personId != null && d.personId === ctx.personId))) throw new AttendanceWorkflowError('notApprover', 'A different authorized person must complete each approval level. Ask HR to arrange another approver.');
        for (const candidate of stage.approvers) {
            const [authority] = await tx.execute(sql`select app.attendance_workflow_v2_assigned_allowed(${p.correctionId}::uuid,${flow.currentStage},${candidate.kind},${candidate.employmentId}::uuid,'assigned') as assigned, app.attendance_workflow_v2_assigned_allowed(${p.correctionId}::uuid,${flow.currentStage},${candidate.kind},${candidate.employmentId}::uuid,'delegate') as delegated`) as unknown as { assigned: boolean; delegated: boolean }[];
            if (authority?.assigned || authority?.delegated) { assigned = candidate; mode = authority.assigned ? 'assigned' : 'delegate'; break; }
        }
        if (!assigned && stage.approvers[0]) {
            const candidate = stage.approvers[0];
            const [authority] = await tx.execute(sql`select app.attendance_workflow_v2_assigned_allowed(${p.correctionId}::uuid,${flow.currentStage},${candidate.kind},${candidate.employmentId}::uuid,'administrator') as ok`) as unknown as { ok: boolean }[];
            if (authority?.ok) {
                if (!p.remarks?.trim()) throw new AttendanceWorkflowError('invalid', 'A reason is required when HR completes a level on behalf of its assigned approver.');
                assigned = candidate; mode = 'administrator';
            }
        }
    } else {
    for (const a of stage.approvers) {
        if (a.kind === 'hr_admin' && isAdmin) {
            assigned = a;
            break;
        }
        if (a.employmentId && ctx.personId) {
            const [owner] = await tx.select({ personId: employment.personId, terminatedOn: employment.terminatedOn }).from(employment).where(eq(employment.id, a.employmentId));
            if (owner?.personId === ctx.personId && (!owner.terminatedOn || owner.terminatedOn > todayInKualaLumpur())) {
                assigned = a;
                break;
            }
            const rows = await tx.execute(sql `select app.can_decide_via_delegation_from(${a.employmentId}::uuid,${p.employmentId}::uuid,'attendance','attendance.correction') as ok`);
            if ((rows as unknown as {
                ok: boolean;
            }[])[0]?.ok) {
                assigned = a;
                mode = 'delegate';
                break;
            }
        }
    }
    if (!assigned && isAdmin) {
        assigned = stage.approvers[0];
        mode = 'administrator';
    }
    }
    if (!assigned)
        throw new AttendanceWorkflowError('notApprover', 'Only the pending assigned approver, their valid delegate or an authorised HR administrator may decide this stage.');
    const final = p.decision === 'rejected' || flow.currentStage === flow.stages.length - 1;
    const [actual] = flow.routingVersion === 2 && mode === 'assigned' && assigned.employmentId ? [{ id: assigned.employmentId }] : flow.routingVersion === 2 ? [] : ctx.personId ? await tx.select({ id: employment.id }).from(employment).where(and(eq(employment.personId, ctx.personId), eq(employment.companyId, subject?.companyId ?? flow.companyId))).orderBy(asc(employment.id)).limit(1) : [];
    const [actualPerson] = ctx.personId ? await tx.select({ name: person.fullName }).from(person).where(eq(person.id, ctx.personId)).limit(1) : [];
    const [recorded] = await tx.insert(decision).values({ tenantId: ctx.tenantId, requestId: flow.id, employmentId: p.employmentId, stageIndex: flow.currentStage, decision: p.decision, assignedKind: assigned.kind, assignedEmploymentId: assigned.employmentId, actualUserId: actorOf(ctx).id ?? 'system', actualActorName: actualPerson?.name ?? actorOf(ctx).id ?? 'System', actualPersonId: ctx.personId ?? null, actualEmploymentId: actual?.id ?? null, actingMode: mode, remarks: p.remarks?.trim() || null, previousStatus: 'pending', resultingStatus: final ? p.decision : 'pending' }).returning({ decidedAt: decision.decidedAt });
    await tx.update(request).set({ currentStage: final ? flow.stages.length : flow.currentStage + 1 }).where(eq(request.id, flow.id));
    const stageEvent: AppendEventArgs = { tenantId: ctx.tenantId, aggregateType: 'attendance-correction', aggregateId: p.correctionId, eventType: 'attendance-workflow.stage.decided', actor: actorOf(ctx), subjectEmploymentId: p.employmentId, payload: { workflowRequestId: flow.id, stageIndex: flow.currentStage, stageName: stage.name, decision: p.decision, assignedApprover: assigned, actingMode: mode, actualPersonId: ctx.personId ?? null, actualEmploymentId: actual?.id ?? null, remarks: p.remarks?.trim() || null, previousStatus: 'pending', resultingStatus: final ? p.decision : 'pending', decidedAt: recorded.decidedAt.toISOString() } };
    // Final approval still needs payroll locks. Taking the tenant audit lock here would invert payroll
    // generation's batch -> audit order; carry immutable data to the fixed final-effect caller instead.
    if (!final || p.decision !== 'approved') await appendEvent(tx, stageEvent);
    return { routed: true, final, currentStage: flow.currentStage,
        ...(flow.routingVersion === 2 ? { actualDeciderEmploymentId: actual?.id ?? null } : {}),
        ...(final && p.decision === 'approved' ? { finalApprovalEvent: stageEvent } : {}),
        ...(final && p.decision === 'approved' && flow.routingVersion === 2 ? { versionedFinalEffect: true } : {}),
        ...(final && p.decision === 'approved' && flow.routingVersion !== 2 && mode === 'delegate' ? { delegatedFinalStageIndex: flow.currentStage } : {}) };
}
export async function reassignAttendanceWorkflowStageToHr(ctx: SessionContext, p: { correctionId: string; expectedStageIndex: number; expectedParticipantSlot?: string; reason: string }) {
    if (!ctx.userId) throw new AttendanceWorkflowError('scope', 'A live authenticated HR administrator is required.');
    if (!p.reason?.trim() || p.reason.trim().length > 500) throw new AttendanceWorkflowError('invalid', 'Enter a reassignment reason of 1–500 characters.');
    return withTenant(ctx, async tx => {
        const [flow] = await tx.select().from(request).where(eq(request.correctionId, p.correctionId)).limit(1);
        if (!flow || (flow.routingVersion !== 2 && flow.routingVersion !== 3)) throw new AttendanceWorkflowError('scope', 'Only a versioned pending application can be reassigned.');
        await adminFor(tx, flow.companyId);
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.tenantId + ':' + flow.employmentId},0))`);
        const correction = await tx.execute(sql`select c.status from public.attendance_correction c where c.id=${p.correctionId}::uuid and c.tenant_id=${ctx.tenantId}::uuid for update`) as unknown as { status: string }[];
        const [locked] = await tx.select().from(request).where(eq(request.id, flow.id)).for('update');
        if (correction[0]?.status !== 'pending' || !locked || locked.currentStage !== p.expectedStageIndex || locked.currentStage >= locked.stages.length) throw new AttendanceWorkflowError('stale', 'The pending level changed. Reload before reassigning.');
        const current = await effectiveStageTx(tx, locked, locked.currentStage);
        if (!current) throw new AttendanceWorkflowError('stale', 'The pending level changed. Reload before reassigning.');
        if (locked.routingVersion === 3) {
            if (!ctx.personId || !p.expectedParticipantSlot) throw new AttendanceWorkflowError('invalid', 'Select the outstanding participant to reassign.');
            const previous = current.approvers.find(actor => actor.slot === p.expectedParticipantSlot);
            if (!previous) throw new AttendanceWorkflowError('stale', 'The outstanding participant changed. Reload before reassigning.');
            const assigned: AttendanceResolvedApprover = { kind: 'hr_admin', employmentId: null, name: 'HR administrators', slot: p.expectedParticipantSlot };
            const [recorded] = await tx.insert(participantReassignment).values({ tenantId: ctx.tenantId, requestId: locked.id, stageIndex: locked.currentStage, participantSlot: p.expectedParticipantSlot,
                previousAssigned: previous, assigned, reason: p.reason.trim(), actualUserId: ctx.userId!, actualPersonId: ctx.personId, actualActorName: '' }).returning();
            await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'attendance-correction', aggregateId: p.correctionId, eventType: 'attendance-workflow.participant.reassigned', actor: actorOf(ctx), subjectEmploymentId: locked.employmentId,
                payload: { workflowRequestId: locked.id, reassignmentId: recorded.id, stageIndex: locked.currentStage, participantSlot: recorded.participantSlot, before: recorded.previousAssigned, after: recorded.assigned, reason: recorded.reason, actualPersonId: recorded.actualPersonId, occurredAt: recorded.occurredAt.toISOString() } });
            return recorded;
        }
        const approvers: AttendanceResolvedApprover[] = [{ kind: 'hr_admin', employmentId: null, name: 'HR administrators' }];
        const [recorded] = await tx.insert(reassignment).values({ tenantId: ctx.tenantId, requestId: locked.id, stageIndex: locked.currentStage, previousApprovers: current.approvers, approvers, reason: p.reason.trim(), actualUserId: ctx.userId!, actualPersonId: ctx.personId ?? null }).returning();
        await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'attendance-correction', aggregateId: p.correctionId, eventType: 'attendance-workflow.stage.reassigned', actor: actorOf(ctx), subjectEmploymentId: locked.employmentId, payload: { workflowRequestId: locked.id, reassignmentId: recorded.id, stageIndex: locked.currentStage, before: current.approvers, after: approvers, reason: recorded.reason, actualPersonId: recorded.actualPersonId, occurredAt: recorded.occurredAt.toISOString() } });
        return recorded;
    });
}
export async function attendanceWorkflowForTx(tx: Tx, correctionId: string) {
    const [flow] = await tx.select().from(request).where(eq(request.correctionId, correctionId));
    if (!flow)
        return null;
    const decisions = await tx.select().from(decision).where(eq(decision.requestId, flow.id)).orderBy(asc(decision.stageIndex), asc(decision.id));
    const reassignments = await tx.select().from(reassignment).where(eq(reassignment.requestId, flow.id)).orderBy(asc(reassignment.occurredAt), asc(reassignment.id));
    const effectiveStages = flow.stages.map((stage, index) => { const latest = reassignments.filter(r => r.stageIndex === index).at(-1); return latest ? { ...stage, approvers: latest.approvers } : stage; });
    const participantDecisions = flow.routingVersion === 3 ? await tx.select().from(participantDecision).where(eq(participantDecision.requestId, flow.id)).orderBy(asc(participantDecision.stageIndex), asc(participantDecision.decidedAt), asc(participantDecision.id)) : [];
    const participantReassignments = flow.routingVersion === 3 ? await tx.select().from(participantReassignment).where(eq(participantReassignment.requestId, flow.id)).orderBy(asc(participantReassignment.occurredAt), asc(participantReassignment.id)) : [];
    const currentParticipantSlot = flow.routingVersion === 3 ? (await tx.execute(sql`select app.attendance_workflow_v3_decision_slot(${correctionId}::uuid)->>'slot' as slot`) as unknown as { slot: string | null }[])[0]?.slot ?? null : null;
    const projected = flow.routingVersion === 3 ? flow.stages.map((stage, index) => ({ ...stage, approvers: stage.approvers.map(actor => participantReassignments.filter(change => change.stageIndex === index && change.participantSlot === actor.slot).at(-1)?.assigned ?? actor) })) : effectiveStages;
    return { ...flow, decisions, effectiveStages: projected, reassignments, participantDecisions, participantReassignments, currentParticipantSlot };
}
/** Read-only preview uses the SAME shared org resolver and selection priority as submission. */
export function previewAttendanceWorkflow(ctx: SessionContext, raw: unknown, lineageId?: string) {
    const input = validateAnyAttendanceWorkflow(raw);
    return withTenant(ctx, async (tx) => {
        await adminFor(tx, input.companyId);
        await validateScope(tx, ctx, input);
        const targets = await workflowTargets(tx, input.criteria, input.companyId);
        const other = await tx.select().from(template).where(and(eq(template.companyId, input.companyId), eq(template.applicationType, input.applicationType), eq(template.active, true), isNull(template.supersededAt))).orderBy(asc(template.priority), asc(template.code));
        const result: {
            employmentId: string;
            name: string;
            selectedCode: string;
            problem: string | null;
            routingVersion: 1 | 2 | 3;
            resolvedStages: AttendanceResolvedStage[];
            levelProblem: AttendanceLevelProblem | null;
        }[] = [];
        for (const id of targets.slice(0, 100)) {
            const [who] = await tx.execute(sql `select p.full_name from employment e join person p on p.id=e.person_id where e.id=${id}::uuid`) as unknown as {
                full_name: string;
            }[];
            const matches = [{ code: input.code, priority: input.priority, stages: input.stages, routingVersion: input.routingVersion ?? 1 }, ...await (async () => {
                    const found: {
                        code: string;
                        priority: number;
                        stages: AnyAttendanceWorkflowInput['stages'];
                        routingVersion: 1 | 2 | 3;
                    }[] = [];
                    for (const t of other.filter(t => t.lineageId !== lineageId))
                        if ((await workflowTargets(tx, t.criteria, input.companyId, [id])).includes(id))
                            found.push(t);
                    return found;
                })()];
            matches.sort((a, b) => a.priority - b.priority || a.code.localeCompare(b.code));
            let problem: string | null = matches.filter(m => m.priority === matches[0].priority).length > 1 ? 'Conflicting templates at the same priority.' : null;
            let resolvedStages: AttendanceResolvedStage[] = [];
            let levelProblem: AttendanceLevelProblem | null = null;
            // Preview the actual priority winner through the same resolver used by submission.
            if (!problem)
                try {
                    resolvedStages = await resolveStages(tx, id, matches[0].stages, matches[0].routingVersion);
                }
                catch (e) {
                    if (e instanceof AttendanceLevelError) levelProblem = e.problem;
                    else problem = e instanceof AttendanceWorkflowError ? e.message : 'Unable to resolve the approval stages.';
                }
            result.push({ employmentId: id, name: who?.full_name ?? id, selectedCode: matches[0].code, problem, routingVersion: matches[0].routingVersion, resolvedStages, levelProblem });
        }
        return { total: targets.length, rows: result, truncated: targets.length > result.length };
    });
}
export async function attendanceWorkflowsForTx(tx: Tx, ids: string[]) {
    if (!ids.length)
        return new Map<string, Awaited<ReturnType<typeof attendanceWorkflowForTx>>>();
    const flows = await tx.select().from(request).where(inArray(request.correctionId, ids));
    const decisions = flows.length ? await tx.select().from(decision).where(inArray(decision.requestId, flows.map(f => f.id))).orderBy(asc(decision.stageIndex), asc(decision.id)) : [];
    const reassignments = flows.length ? await tx.select().from(reassignment).where(inArray(reassignment.requestId, flows.map(f => f.id))).orderBy(asc(reassignment.occurredAt), asc(reassignment.id)) : [];
    const v3 = flows.filter(flow => flow.routingVersion === 3);
    const participantDecisions = v3.length ? await tx.select().from(participantDecision).where(inArray(participantDecision.requestId, v3.map(flow => flow.id))).orderBy(asc(participantDecision.stageIndex), asc(participantDecision.decidedAt), asc(participantDecision.id)) : [];
    const participantReassignments = v3.length ? await tx.select().from(participantReassignment).where(inArray(participantReassignment.requestId, v3.map(flow => flow.id))).orderBy(asc(participantReassignment.occurredAt), asc(participantReassignment.id)) : [];
    const actorSlots = v3.length ? await tx.execute(sql`select w.id,app.attendance_workflow_v3_decision_slot(w.correction_id)->>'slot' as slot from public.attendance_workflow_request w where w.id in (${sql.join(v3.map(flow => sql`${flow.id}::uuid`), sql`,`)})`) as unknown as { id: string; slot: string | null }[] : [];
    return new Map(flows.map(f => {
        const overrides = reassignments.filter(r => r.requestId === f.id);
        const effectiveStages = f.stages.map((stage, index) => { const latest = overrides.filter(r => r.stageIndex === index).at(-1); return latest ? { ...stage, approvers: latest.approvers } : stage; });
        const participantChanges = participantReassignments.filter(change => change.requestId === f.id);
        const projected = f.routingVersion === 3 ? f.stages.map((stage, index) => ({ ...stage, approvers: stage.approvers.map(actor => participantChanges.filter(change => change.stageIndex === index && change.participantSlot === actor.slot).at(-1)?.assigned ?? actor) })) : effectiveStages;
        return [f.correctionId, { ...f, decisions: decisions.filter(d => d.requestId === f.id), effectiveStages: projected, reassignments: overrides,
            participantDecisions: participantDecisions.filter(d => d.requestId === f.id), participantReassignments: participantChanges, currentParticipantSlot: actorSlots.find(actor => actor.id === f.id)?.slot ?? null }];
    }));
}

/** Navigation uses an existing frozen request capability; this never grants a Manager role. */
export function hasPendingAttendanceParticipantAssignment(ctx: SessionContext) {
    return withTenant(ctx, async tx => {
        const [row] = await tx.execute(sql`select exists(select 1 from public.attendance_workflow_request w join public.attendance_correction c on c.id=w.correction_id and c.tenant_id=w.tenant_id where w.tenant_id=app.current_tenant_id() and w.routing_version=3 and c.status='pending' and app.attendance_workflow_v3_decision_slot(c.id) is not null) as ok`) as unknown as { ok: boolean }[];
        return row?.ok === true;
    });
}
