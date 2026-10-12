import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { type SessionContext, type Tx } from '../db/client';
import { withAttendanceTenant as withTenant } from './module-gate';
import { actorOf, appendEvent, type AppendEventArgs } from '../db/events';
import { attendanceWorkflowTemplate as template, attendanceWorkflowSetting as setting, attendanceWorkflowRequest as request, attendanceWorkflowDecision as decision, employment, person, department, businessUnit, jobGrade, profileOption } from '../db/schema';
import { approversOf } from '../lib/leave-approval-kinds';
import { todayInKualaLumpur } from '../lib/hr-date';
import { resolveOrgCriteriaTargets } from './org-criteria';
import { assertCanDecide } from './approvals';
import { scopeOf } from '../lib/delegation-scope';
import { labelUsableByCompany } from './system-labels';
import { AttendanceWorkflowError, attendanceScopesOverlap, validateAttendanceWorkflow, type AttendanceWorkflowInput, type AttendanceApplicationType, type AttendanceResolvedStage, type AttendanceResolvedApprover } from '../lib/attendance-workflow';
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
async function validateScope(tx: Tx, ctx: SessionContext, input: AttendanceWorkflowInput) {
    for (const [key, table] of [['departmentIds', department], ['businessUnitIds', businessUnit], ['gradeIds', jobGrade]] as const) {
        const ids = input.criteria[key] ?? [];
        if (ids.length) {
            const found = await tx.select({ id: table.id }).from(table).where(and(inArray(table.id, ids), isNull(table.archivedAt)));
            if (found.length !== ids.length)
                throw new AttendanceWorkflowError('invalid', 'An organisational assignment is missing, inactive or outside your access.');
            if (key !== 'gradeIds')
                for (const id of ids)
                    if (!(await labelUsableByCompany(tx, ctx.tenantId, key === 'departmentIds' ? 'department' : 'business_unit', id, input.companyId)))
                        throw new AttendanceWorkflowError('invalid', 'An organisational assignment is not available to this company.');
        }
    }
    if (input.criteria.orgDivision?.length) {
        const rows = await tx.select({ name: profileOption.value }).from(profileOption).where(and(eq(profileOption.category, 'division'), inArray(profileOption.value, input.criteria.orgDivision), eq(profileOption.isActive, true)));
        if (new Set(rows.map(r => r.name)).size !== input.criteria.orgDivision.length)
            throw new AttendanceWorkflowError('invalid', 'A division is missing or inactive.');
    }
}
async function resolveStages(tx: Tx, employmentId: string, stages: AttendanceWorkflowInput['stages']): Promise<AttendanceResolvedStage[]> {
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
async function validateActivation(tx: Tx, ctx: SessionContext, input: AttendanceWorkflowInput, lineageId?: string) {
    const others = await tx.select().from(template).where(and(eq(template.companyId, input.companyId), eq(template.applicationType, input.applicationType), eq(template.active, true), isNull(template.supersededAt)));
    if (others.some(t => t.lineageId !== lineageId && t.priority === input.priority && attendanceScopesOverlap(t.criteria, input.criteria)))
        throw new AttendanceWorkflowError('overlap', 'An active workflow at this priority overlaps this assignment. Use a different priority or disjoint scope. Lower priority numbers apply first.');
    const targets = await resolveOrgCriteriaTargets(tx, { criteria: { ...input.criteria, companyIds: [input.companyId] }, asOf: todayInKualaLumpur() });
    for (const id of targets)
        await resolveStages(tx, id, input.stages);
    // Zero targets is allowed as a future population. Submission re-resolves and refuses missing approvers.
}
export async function saveAttendanceWorkflow(ctx: SessionContext, raw: AttendanceWorkflowInput, lineageId?: string) {
    const input = validateAttendanceWorkflow(raw);
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
                const input = validateAttendanceWorkflow({ ...row, description: row.description ?? '', active: true });
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
        if ((await resolveOrgCriteriaTargets(tx, { criteria: { ...row.criteria, companyIds: [subject.companyId] }, asOf: todayInKualaLumpur(), employmentIds: [employmentId] })).includes(employmentId))
            matches.push(row);
    if (!matches.length)
        throw new AttendanceWorkflowError('noMatch', 'Attendance workflow routing is enabled, but no active template matches this employee and application type. Ask HR to configure the assignment.');
    if (matches.filter(row => row.priority === matches[0].priority).length !== 1)
        throw new AttendanceWorkflowError('tie', 'More than one attendance workflow matches at the highest priority. Ask HR to resolve the conflicting assignments.');
    const selected = matches[0], validated = validateAttendanceWorkflow({ ...selected, description: selected.description ?? '' }), stages = await resolveStages(tx, employmentId, validated.stages);
    const [snapshot] = await tx.insert(request).values({ tenantId: ctx.tenantId, correctionId, employmentId, companyId: subject.companyId, templateId: selected.id, templateCode: selected.code, templateName: selected.name, templateVersion: selected.version, applicationType, stages }).returning();
    await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'attendance-correction', aggregateId: correctionId, eventType: 'attendance-workflow.resolved', actor: actorOf(ctx), subjectEmploymentId: employmentId, payload: { workflowRequestId: snapshot.id, templateId: selected.id, templateVersion: selected.version, stages } });
    return snapshot;
}
export type AttendanceStageResult = {
    routed: boolean;
    final: boolean;
    currentStage?: number;
    delegatedFinalStageIndex?: number;
    /** Fixed audit data only. The final caller emits it after effect/payroll locks and identity restoration. */
    finalApprovalEvent?: AppendEventArgs;
};
/** Called by EVERY decide path before touching attendance. Request row is already locked by the caller. */
export async function decideAttendanceWorkflowStageTx(tx: Tx, ctx: SessionContext, p: {
    correctionId: string;
    employmentId: string;
    decision: 'approved' | 'rejected';
    remarks?: string;
    expectedStageIndex?: number;
}): Promise<AttendanceStageResult> {
    const [flow] = await tx.select().from(request).where(eq(request.correctionId, p.correctionId)).limit(1).for('update');
    if (!flow)
        return { routed: false, final: true };
    if (p.expectedStageIndex !== flow.currentStage)
        throw new AttendanceWorkflowError('stale', 'The pending approval stage changed. Reload the application before deciding it.');
    await assertCanDecide(tx, ctx, p.employmentId, 'attendance application', scopeOf('attendance.correction'));
    const stage = flow.stages[flow.currentStage];
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
    if (!assigned)
        throw new AttendanceWorkflowError('notApprover', 'Only the pending assigned approver, their valid delegate or an authorised HR administrator may decide this stage.');
    const final = p.decision === 'rejected' || flow.currentStage === flow.stages.length - 1;
    const [actual] = ctx.personId ? await tx.select({ id: employment.id }).from(employment).where(and(eq(employment.personId, ctx.personId), eq(employment.companyId, subject?.companyId ?? flow.companyId))).orderBy(asc(employment.id)).limit(1) : [];
    const [actualPerson] = ctx.personId ? await tx.select({ name: person.fullName }).from(person).where(eq(person.id, ctx.personId)).limit(1) : [];
    const [recorded] = await tx.insert(decision).values({ tenantId: ctx.tenantId, requestId: flow.id, employmentId: p.employmentId, stageIndex: flow.currentStage, decision: p.decision, assignedKind: assigned.kind, assignedEmploymentId: assigned.employmentId, actualUserId: actorOf(ctx).id ?? 'system', actualActorName: actualPerson?.name ?? actorOf(ctx).id ?? 'System', actualPersonId: ctx.personId ?? null, actualEmploymentId: actual?.id ?? null, actingMode: mode, remarks: p.remarks?.trim() || null, previousStatus: 'pending', resultingStatus: final ? p.decision : 'pending' }).returning({ decidedAt: decision.decidedAt });
    await tx.update(request).set({ currentStage: final ? flow.stages.length : flow.currentStage + 1 }).where(eq(request.id, flow.id));
    const stageEvent: AppendEventArgs = { tenantId: ctx.tenantId, aggregateType: 'attendance-correction', aggregateId: p.correctionId, eventType: 'attendance-workflow.stage.decided', actor: actorOf(ctx), subjectEmploymentId: p.employmentId, payload: { workflowRequestId: flow.id, stageIndex: flow.currentStage, stageName: stage.name, decision: p.decision, assignedApprover: assigned, actingMode: mode, actualPersonId: ctx.personId ?? null, actualEmploymentId: actual?.id ?? null, remarks: p.remarks?.trim() || null, previousStatus: 'pending', resultingStatus: final ? p.decision : 'pending', decidedAt: recorded.decidedAt.toISOString() } };
    // Final approval still needs payroll locks. Taking the tenant audit lock here would invert payroll
    // generation's batch -> audit order; carry immutable data to the fixed final-effect caller instead.
    if (!final || p.decision !== 'approved') await appendEvent(tx, stageEvent);
    return { routed: true, final, currentStage: flow.currentStage,
        ...(final && p.decision === 'approved' ? { finalApprovalEvent: stageEvent } : {}),
        ...(final && p.decision === 'approved' && mode === 'delegate' ? { delegatedFinalStageIndex: flow.currentStage } : {}) };
}
export async function attendanceWorkflowForTx(tx: Tx, correctionId: string) {
    const [flow] = await tx.select().from(request).where(eq(request.correctionId, correctionId));
    if (!flow)
        return null;
    const decisions = await tx.select().from(decision).where(eq(decision.requestId, flow.id)).orderBy(asc(decision.stageIndex), asc(decision.id));
    return { ...flow, decisions };
}
/** Read-only preview uses the SAME shared org resolver and selection priority as submission. */
export function previewAttendanceWorkflow(ctx: SessionContext, raw: AttendanceWorkflowInput, lineageId?: string) {
    const input = validateAttendanceWorkflow(raw);
    return withTenant(ctx, async (tx) => {
        await adminFor(tx, input.companyId);
        await validateScope(tx, ctx, input);
        const targets = await resolveOrgCriteriaTargets(tx, { criteria: { ...input.criteria, companyIds: [input.companyId] }, asOf: todayInKualaLumpur() });
        const other = await tx.select().from(template).where(and(eq(template.companyId, input.companyId), eq(template.applicationType, input.applicationType), eq(template.active, true), isNull(template.supersededAt))).orderBy(asc(template.priority), asc(template.code));
        const result: {
            employmentId: string;
            name: string;
            selectedCode: string;
            problem: string | null;
        }[] = [];
        for (const id of targets.slice(0, 100)) {
            const [who] = await tx.execute(sql `select p.full_name from employment e join person p on p.id=e.person_id where e.id=${id}::uuid`) as unknown as {
                full_name: string;
            }[];
            const matches = [{ code: input.code, priority: input.priority }, ...await (async () => {
                    const found: {
                        code: string;
                        priority: number;
                    }[] = [];
                    for (const t of other.filter(t => t.lineageId !== lineageId))
                        if ((await resolveOrgCriteriaTargets(tx, { criteria: { ...t.criteria, companyIds: [input.companyId] }, asOf: todayInKualaLumpur(), employmentIds: [id] })).includes(id))
                            found.push(t);
                    return found;
                })()];
            matches.sort((a, b) => a.priority - b.priority || a.code.localeCompare(b.code));
            let problem: string | null = matches.filter(m => m.priority === matches[0].priority).length > 1 ? 'Conflicting templates at the same priority.' : null;
            if (!problem && matches[0].code === input.code)
                try {
                    await resolveStages(tx, id, input.stages);
                }
                catch (e) {
                    problem = e instanceof AttendanceWorkflowError ? e.message : 'Unable to resolve the approval stages.';
                }
            result.push({ employmentId: id, name: who?.full_name ?? id, selectedCode: matches[0].code, problem });
        }
        return { total: targets.length, rows: result, truncated: targets.length > result.length };
    });
}
export async function attendanceWorkflowsForTx(tx: Tx, ids: string[]) {
    if (!ids.length)
        return new Map<string, Awaited<ReturnType<typeof attendanceWorkflowForTx>>>();
    const flows = await tx.select().from(request).where(inArray(request.correctionId, ids));
    const decisions = flows.length ? await tx.select().from(decision).where(inArray(decision.requestId, flows.map(f => f.id))).orderBy(asc(decision.stageIndex), asc(decision.id)) : [];
    return new Map(flows.map(f => [f.correctionId, { ...f, decisions: decisions.filter(d => d.requestId === f.id) }]));
}
