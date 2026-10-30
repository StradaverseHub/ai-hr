import { organisationChoiceLabels } from '../../../lib/organisation-choice-label';
import { onboardingConfigSchema, onboardingTaskSchema, onboardingCommandSchema, onboardingNoteSchema } from '../../../lib/onboarding-validation';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { withLifecycleTenant as withTenant } from '../../../core/module-gate';
import { type SessionContext, type Tx } from '../../../db/client';
import { appendEvent, actorOf } from '../../../db/events';
import { lcOnboardingCaseRevision as revisions, lcOnboardingPrivateRevision as privateRevisions, lcOnboardingCase as cases, lcOnboardingConfig as configs, lcOnboardingPrivate as secrets, lcOnboardingNote as notes, lcOnboardingSeen as seen, employeeDraft, department, company, position, businessUnit, jobGrade, costCenter, employment, person, assignment, employmentTypeEnum } from '../../../db/schema';
import { isModuleEnabled } from '../../../core/entitlements';
import { todayInKualaLumpur } from '../../../lib/hr-date';
import {assertAssignedWorkPrincipalTx} from '../../../core/approvals';
import type {AssignedPersonalTaskMetadata} from '../../../lib/assigned-work';
import { visibleLabelIdsCondition } from '../../../core/system-labels';
import type { EmployeeDraftData } from '../../../lib/employee-draft-schema';
import * as M from '../../../lib/onboarding-model';
export type { Config as OnboardingConfig, Case as OnboardingCase, Note as OnboardingNote, Facts as OnboardingFacts, Actor as OnboardingActor } from '../../../lib/onboarding-model';
export { effectiveFacts as onboardingFacts, matchChecklist as onboardingChecklist, matches as onboardingMatches, progress as onboardingProgress, currentReq as onboardingRequisition, requisitionStatus as onboardingRequisitionStatus, stepOpen as onboardingStepOpen, activeItem as onboardingActiveItem, inGroup as onboardingGroupMember } from '../../../lib/onboarding-model';
const uid = (ctx: SessionContext) => ctx.userId ?? M.fail('Sign in to continue.', 'forbidden');
const privateKeys = ['costCentre', 'ic', 'passport'] as const;
const jsonSize = (v: unknown) => {
    if (JSON.stringify(v).length > 10000000)
        M.fail('This update is too large.');
};
type Row = typeof cases.$inferSelect;
const rows = <T>(v: unknown) => v as T[];
async function configTx(tx: Tx, ctx: SessionContext): Promise<{
    config: M.Config;
    revision: number;
}> {
    const [row] = await tx.select().from(configs).where(eq(configs.tenantId, ctx.tenantId));
    return { config: row?.data ?? M.defaultConfig(''), revision: row?.revision ?? 0 };
}
async function actorTx(tx: Tx, ctx: SessionContext, config: M.Config, companyId?: string): Promise<M.Actor> {
    const [row] = rows<{
        master: boolean;
        hr: boolean;
        name: string;
    }>(await tx.execute(sql `select app.is_group_admin() as master, app.is_admin_for(${companyId ?? null}::uuid) as hr, coalesce(p.full_name,'User '||left(u.id::text,8)) as name from app_user u left join person p on p.id=u.person_id and p.tenant_id=u.tenant_id where u.id=app.current_user_id() and u.tenant_id=app.current_tenant_id() and not app.login_blocked(u.id)`));
    if (!row)
        M.fail('Your login is not available.', 'forbidden');
    return { id: uid(ctx), name: row.name, module: config.access.onboarding.includes(uid(ctx)), master: row.master, hr: row.hr };
}
const clock = () => ({ now: new Date().toISOString(), today: todayInKualaLumpur() });
async function directoryTx(tx: Tx) {
    return rows<{
        id: string;
        name: string;
    }>(await tx.execute(sql `select * from app.onboarding_directory()`));
}
async function environmentTx(tx: Tx, ctx: SessionContext, config: M.Config, all: M.Case[]): Promise<M.Environment> {
    const { now, today } = clock(), dates = new Set([today]);
    for (let n = 2; n <= 31; n++)
        dates.add(M.dayDate(today, n));
    for (const c of all) {
        for (const t of c.tasks)
            dates.add(t.dueOn);
        const f = M.effectiveFacts(c);
        if (M.validDate(f.joinDate))
            for (const cl of config.checklists)
                for (const t of cl.tasks)
                    dates.add(M.dayDate(f.joinDate, t.due));
    }
    const unavailable: {
        user_id: string;
        on_date: string;
    }[] = [];
    const dateList = [...dates];
    for (let offset = 0; offset < dateList.length; offset += 300)
        unavailable.push(...rows<{
            user_id: string;
            on_date: string;
        }>(await tx.execute(sql `select user_id,on_date::text from app.onboarding_unavailable(array[${sql.join(dateList.slice(offset, offset + 300).map(date => sql `${date}::date`), sql `, `)}])`)));
    const leave: Record<string, string[]> = {};
    for (const x of unavailable)
        (leave[x.user_id] ??= []).push(x.on_date);
    const directory = await directoryTx(tx);
    const env: M.Environment = { now, today, userNames: Object.fromEntries(directory.map(u => [u.id, u.name])), id: randomUUID, nextNumber: () => M.fail('A requisition number was not reserved.'), leave, taskLoads: {}, lastTaskAssignment: {}, pendingApprovals: {}, lifetimeApprovals: {}, users: directory.map(u => u.id) };
    const loads = rows<{
        user_id: string;
        task_load: string;
        last_auto: string | null;
        pending_approvals: string;
        lifetime_approvals: string;
    }>(await tx.execute(sql `select * from app.onboarding_assignment_loads()`));
    for (const load of loads) {
        env.taskLoads[load.user_id] = Number(load.task_load);
        if (load.last_auto)
            env.lastTaskAssignment[load.user_id] = load.last_auto;
        env.pendingApprovals[load.user_id] = Number(load.pending_approvals);
        env.lifetimeApprovals[load.user_id] = Number(load.lifetime_approvals);
    }
    return env;
}
async function auditTx(tx: Tx, ctx: SessionContext, c: M.Case, action: string) {
    await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'onboarding-case', aggregateId: c.id, eventType: 'onboarding.' + action, actor: actorOf(ctx), subjectEmploymentId: c.employmentId, payload: { caseId: c.id, companyId: M.effectiveFacts(c).company } });
}
function stripPrivate(c: M.Case) {
    const value = structuredClone(c), data: {
        source: Partial<M.Facts>;
        local: Partial<M.Facts>;
    } = { source: {}, local: {} };
    for (const k of privateKeys) {
        if (value.source[k] !== undefined)
            data.source[k] = value.source[k];
        if (value.local[k] !== undefined)
            data.local[k] = value.local[k];
        delete value.source[k];
        delete value.local[k];
    }
    return { value, data };
}
async function storeTx(tx: Tx, ctx: SessionContext, row: Row, c: M.Case, hr: boolean) {
    const { value, data } = stripPrivate(c);
    jsonSize(value);
    const [before] = await tx.select().from(cases).where(and(eq(cases.id, row.id), eq(cases.revision, row.revision))).limit(1);
    if (!before)
        M.fail('This case changed. Reload it before trying again.', 'conflict');
    await tx.insert(revisions).values({ caseId: before.id, revision: before.revision, tenantId: ctx.tenantId, companyId: before.companyId, data: before.data }).onConflictDoNothing();
    if (hr) {
        const [previousPrivate] = await tx.select().from(secrets).where(eq(secrets.caseId, row.id));
        if (previousPrivate)
            await tx.insert(privateRevisions).values({ caseId: before.id, revision: before.revision, tenantId: ctx.tenantId, companyId: previousPrivate.companyId, data: previousPrivate.data }).onConflictDoNothing();
    }
    const updated = await tx.update(cases).set({ data: value, companyId: row.companyId, employmentId: c.employmentId, revision: row.revision + 1, updatedAt: new Date() }).where(and(eq(cases.id, row.id), eq(cases.revision, row.revision))).returning({ id: cases.id });
    if (!updated.length)
        M.fail('This case changed. Reload it before trying again.', 'conflict');
    if (hr)
        await tx.insert(secrets).values({ caseId: c.id, tenantId: ctx.tenantId, companyId: row.companyId, data }).onConflictDoUpdate({ target: secrets.caseId, set: { data, companyId: row.companyId } });
}
export async function onboardingContext(ctx: SessionContext) {
    return withTenant(ctx, async (tx) => {
        const { config, revision } = await configTx(tx, ctx), actor = await actorTx(tx, ctx, config);
        const all = (await tx.select({ data: cases.data }).from(cases).orderBy(asc(cases.id))).map(r => r.data);
        const environment = await environmentTx(tx, ctx, config, all);
        const current = all.filter(c => c.state !== 'cancelled');
        return { config, revision, actor, directory: await directoryTx(tx), loads: environment.taskLoads, availability: environment.leave, totalJoiners: current.length, checklistCounts: Object.fromEntries(config.checklists.map(cl => [cl.id, current.filter(c => M.matchChecklist(config, c).checklist?.id === cl.id).length])), matchCounts: Object.fromEntries(config.catalogue.map(i => [i.id, current.filter(c => i.active && M.matches(i.rules, M.effectiveFacts(c))).length])) };
    });
}
export async function onboardingSetup(ctx: SessionContext) {
    return withTenant(ctx, async (tx) => {
        const { config, revision } = await configTx(tx, ctx), actor = await actorTx(tx, ctx, config);
        if (!actor.master)
            M.fail('Only the Master Admin can initialise onboarding.', 'forbidden');
        if (revision)
            return;
        const initial = M.defaultConfig(actor.id);
        await tx.insert(configs).values({ tenantId: ctx.tenantId, data: initial }).onConflictDoNothing();
        await tx.execute(sql `insert into lc_onboarding_config_history(tenant_id,revision,data,actor_user_id) values(${ctx.tenantId}::uuid,1,${JSON.stringify(initial)}::jsonb,${actor.id}::uuid) on conflict do nothing`);
        await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'onboarding-config', aggregateId: ctx.tenantId, eventType: 'onboarding.config.initialized', actor: actorOf(ctx), payload: {} });
        const drafts = await tx.select({ id: employeeDraft.id }).from(employeeDraft).orderBy(asc(employeeDraft.createdAt), asc(employeeDraft.id));
        for (const d of drafts)
            await onboardingSyncDraftTx(ctx, tx, d.id, 'save');
    });
}
export async function onboardingOptions(ctx: SessionContext) {
    return withTenant(ctx, async (tx) => {
        const { config } = await configTx(tx, ctx), actor = await actorTx(tx, ctx, config);
        if (!actor.module && !actor.master)
            M.fail('Onboarding access is required.', 'forbidden');
        const companies = await tx.select({ id: company.id, name: company.legalName }).from(company).orderBy(asc(company.legalName));
        const ids = companies.map(c => c.id);
        const [departments, units, titles, grades] = await Promise.all([
            tx.select({ id: department.id, name: department.name, code: department.name, label: department.label, description: department.description }).from(department).where(visibleLabelIdsCondition(department, 'department', ids)).orderBy(asc(department.name)),
            tx.select({ id: businessUnit.id, name: businessUnit.name, code: businessUnit.code, label: businessUnit.label }).from(businessUnit).where(visibleLabelIdsCondition(businessUnit, 'business_unit', ids)).orderBy(asc(businessUnit.name)),
            tx.select({ id: position.id, name: position.title, code: position.title, label: position.label, description: position.description }).from(position).where(visibleLabelIdsCondition(position, 'position', ids)).orderBy(asc(position.title)),
            tx.select({ id: jobGrade.id, name: jobGrade.name, label: jobGrade.name, code: jobGrade.code }).from(jobGrade).orderBy(asc(jobGrade.name)),
        ]);
        const supervisors = rows<{
            id: string;
            name: string;
        }>(await tx.execute(sql `select * from app.onboarding_supervisors()`));
        const choices = <T extends { id: string; name: string }>(rows: T[]) => organisationChoiceLabels(rows).map(row => ({ id: row.id, name: row.displayLabel }));
        return { supervisor: supervisors, company: companies, department: choices(departments), businessGroup: choices(units), title: choices(titles), grade: choices(grades), employmentType: employmentTypeEnum.enumValues.map(id => ({ id, name: id.replaceAll('_', ' ') })) };
    });
}
export async function onboardingList(ctx: SessionContext, companyIds?: string[]) {
    return withTenant(ctx, async (tx) => {
        const { config } = await configTx(tx, ctx), actor = await actorTx(tx, ctx, config);
        if (!actor.module)
            M.fail('Onboarding access is required.', 'forbidden');
        const list = await tx.select().from(cases).where(companyIds ? inArray(cases.companyId, companyIds) : undefined).orderBy(asc(cases.createdAt), asc(cases.id));
        const reads = await tx.select({ caseId: seen.caseId }).from(seen).where(eq(seen.userId, uid(ctx))), opened = new Set(reads.map(x => x.caseId));
        return list.map(r => ({ case: r.data, revision: r.revision, isNew: !opened.has(r.id), progress: M.progress(config, r.data) }));
    });
}
async function loadTx(tx: Tx, ctx: SessionContext, id: string, lock = false) {
    const q = tx.select().from(cases).where(eq(cases.id, id)).limit(1), [row] = lock ? await q.for('update') : await q;
    if (!row)
        M.fail('Onboarding case not found.', 'not_found');
    const { config } = await configTx(tx, ctx), actor = await actorTx(tx, ctx, config, row.companyId), c = structuredClone(row.data);
    if (actor.hr) {
        const [s] = await tx.select().from(secrets).where(eq(secrets.caseId, id));
        if (s) {
            Object.assign(c.source, s.data.source);
            Object.assign(c.local, s.data.local);
        }
    }
    return { row, config, actor, c };
}
function requisitionGroupAccess(config: M.Config, user: string): boolean {
    const groups = [config.techGroup, ...config.exceptions.groups, ...config.catalogue.map(i => i.team), ...config.workflows.flatMap(w => w.steps.filter(s => s.type === 'group').map(s => s.target)), ...config.routings.flatMap(r => r.rows.map(row => row.group))];
    return groups.some(group => M.inGroup(config, group, user));
}
function canReadRequisition(config: M.Config, r: M.Requisition | null, actor: M.Actor): boolean {
    return !!r && (actor.module || actor.hr || requisitionGroupAccess(config, actor.id) || r.items.some(i => M.inGroup(config, i.team, actor.id) || i.steps.some(s => s.user === actor.id || M.inGroup(config, s.group, actor.id))));
}
export async function onboardingDetail(ctx: SessionContext, id: string, mode: 'case' | 'requisition' | 'task' = 'case', generation?: string) {
    return withTenant(ctx, async (tx) => {
        const { row, config, actor, c } = await loadTx(tx, ctx, id);
        if (mode === 'case' && !actor.module)
            M.fail('Onboarding access is required.', 'forbidden');
        if (mode !== 'case' && !actor.module && !await participantTx(tx, id))
            M.fail('This work is not available to you.', 'forbidden');
        const selectedReq = generation ? c.requisitions.find(r => r.id === generation) ?? null : M.currentReq(c);
        if (mode === 'requisition' && !canReadRequisition(config, selectedReq, actor))
            M.fail('Requisition access is required.', 'forbidden');
        const thread = await tx.select().from(notes).where(eq(notes.caseId, id)).orderBy(asc(notes.createdAt), asc(notes.id));
        let visible = c;
        if (!actor.module && mode === 'task') {
            visible = structuredClone(c);
            visible.history = [];
            visible.taskHistory = [];
            visible.acknowledgementHistory = [];
            visible.acknowledgement = null;
            visible.requisitions = visible.requisitions.filter(r => !r.cancelledAt).map(r => ({ ...r, hrNote: (r.items.some(i => M.inGroup(config, i.team, actor.id)) || config.exceptions.groups.some(g => M.inGroup(config, g, actor.id))) ? r.hrNote : '', items: canReadRequisition(config, r, actor) ? r.items : r.items.filter(i => M.inGroup(config, i.team, actor.id) || i.steps.some(s => s.user === actor.id || M.inGroup(config, s.group, actor.id))) }));
            visible.local = {};
            visible.notes = '';
            visible.extras = [];
            visible.selected = [];
            const f = M.effectiveFacts(c);
            visible.source = { fullName: f.fullName, joinDate: f.joinDate, businessGroup: f.businessGroup, company: f.company, title: f.title };
            visible.tasks = visible.tasks.filter(t => t.assignee === actor.id || thread.some(n => n.data.context === t.id && n.data.mentions.includes(actor.id)));
        }
        if (mode === 'requisition' && !actor.module && selectedReq) {
            visible = structuredClone(c);
            visible.tasks = [];
            visible.taskHistory = [];
            visible.acknowledgement = null;
            visible.acknowledgementHistory = [];
            visible.requisitions = [selectedReq];
            visible.history = visible.history.filter(h => h.at >= selectedReq.createdAt && (!selectedReq.cancelledAt || h.at <= selectedReq.cancelledAt));
        }
        const [caseLabels] = rows<{
            labels: Partial<Record<keyof M.Facts, string>>;
        }>(await tx.execute(sql `select app.onboarding_case_labels(${id}::uuid) as labels`));
        const labels = caseLabels?.labels ?? {};
        const effective = M.effectiveFacts(c);
        if (actor.hr && /^[0-9a-f-]{36}$/i.test(effective.costCentre)) {
            const [cost] = await tx.select({ name: costCenter.name }).from(costCenter).where(eq(costCenter.id, effective.costCentre));
            if (cost)
                labels.costCentre = cost.name;
        }
        return { canOpenRequisition: canReadRequisition(config, M.currentReq(c), actor), labels, case: visible, revision: row.revision, config, actor, directory: await directoryTx(tx), notes: thread.map(n => n.data).filter(n => actor.module || n.by === actor.id || n.mentions.includes(actor.id) || c.tasks.some(t => t.id === n.context && t.assignee === actor.id) || n.context === 'requisition' && canReadRequisition(config, M.currentReq(c), actor)), availability: actor.module ? (await environmentTx(tx, ctx, config, [c])).leave : {} as M.Environment['leave'], today: todayInKualaLumpur() };
    });
}
const participantTx = async (tx: Tx, id: string) => rows<{
    ok: boolean;
}>(await tx.execute(sql `select app.onboarding_participant(${id}::uuid) as ok`))[0]?.ok === true;
export async function onboardingMarkSeen(ctx: SessionContext, id: string) {
    return withTenant(ctx, async (tx) => {
        const { actor } = await loadTx(tx, ctx, id);
        if (!actor.module)
            M.fail('Onboarding access is required.', 'forbidden');
        await tx.insert(seen).values({ tenantId: ctx.tenantId, userId: uid(ctx), caseId: id }).onConflictDoUpdate({ target: [seen.tenantId, seen.userId, seen.caseId], set: { seenAt: new Date() } });
    });
}
export type OnboardingCommand = {
    type: 'save';
    patch: M.CasePatch;
} | {
    type: 'submit';
} | {
    type: 'cancel';
    reason: string;
    note?: string;
} | {
    type: 'reopen';
} | {
    type: 'task';
    taskId: string;
    status: M.Task['status'];
} | {
    type: 'assignTask';
    taskId: string;
    user: string | null;
    roundRobin: boolean;
} | {
    type: 'approve';
    itemIds: string[];
    decision: 'approve' | 'reject';
} | {
    type: 'assignApproval';
    itemId: string;
    stepId: string;
    user: string | null;
} | {
    type: 'fulfil';
    itemId: string;
    status: 'todo' | 'progress' | 'done';
} | {
    type: 'addItem';
    catalogueId: string;
    reason: string;
    approval: boolean;
    confirmedBy: string | null;
} | {
    type: 'removeItem';
    itemId: string;
} | {
    type: 'handover';
} | {
    type: 'readNote';
} | {
    type: 'keepProviding';
    itemId: string;
} | {
    type: 'acknowledge';
    data: Record<string, string>;
} | {
    type: 'releaseClaim';
    itemId: string;
} | {
    type: 'itemTeam';
    itemId: string;
    group: string;
} | {
    type: 'taskGroup';
    taskId: string;
    group: string;
} | {
    type: 'retryApproval';
    itemId: string;
} | {
    type: 'saveSubmit';
    patch: M.CasePatch;
};
export async function onboardingCommand(ctx: SessionContext, id: string, revision: number, command: OnboardingCommand) {
    command = onboardingCommandSchema.parse(command);
    jsonSize(command);
    return withTenant(ctx, async (tx) => {
        // Serialise assignment/load decisions within the tenant, including simultaneous submissions.
        await lockOnboardingTx(tx, ctx.tenantId);
        const { row, config, actor, c } = await loadTx(tx, ctx, id, true);
        if (row.revision !== revision) {
            if (actor.module && command.type === 'submit' && c.state === 'submitted' && !c.reconcileNeeded)
                return { revision: row.revision };
            if (M.inGroup(config, config.techGroup, actor.id) && command.type === 'handover' && M.currentReq(c)?.handedAt)
                return { revision: row.revision };
            M.fail('This case changed. Reload it before trying again.', 'conflict');
        }
        const all = await tx.select({ data: cases.data }).from(cases).orderBy(asc(cases.id));
        const env = await environmentTx(tx, ctx, config, all.map(x => x.data));
        if ((command.type === 'submit' || command.type === 'saveSubmit') && c.state === 'pending') {
            const [seq] = rows<{
                n: number;
            }>(await tx.execute(sql `select app.lc_next_number('IT-REQ') as n`));
            env.nextNumber = () => 'IT-REQ-' + String(seq!.n).padStart(4, '0');
        }
        const r = M.currentReq(c);
        switch (command.type) {
            case 'saveSubmit':
                M.saveCase(config, c, command.patch, actor, env);
                M.submitCase(config, c, actor, env);
                break;
            case 'save':
                M.saveCase(config, c, command.patch, actor, env);
                break;
            case 'submit':
                M.submitCase(config, c, actor, env);
                break;
            case 'cancel':
                M.cancelCase(c, command.reason, actor, env, command.note);
                break;
            case 'retryApproval':
                M.retryApprovals(config, c, command.itemId, actor, env);
                break;
            case 'itemTeam': {
                if (!actor.module || c.state !== 'submitted' || !r || r.handedAt)
                    M.fail('Only onboarding editors can repair an open requisition team.', 'forbidden');
                const item = r.items.find(i => i.id === command.itemId && !i.removed);
                if (!item || item.team || !config.groups.some(g => g.id === command.group))
                    M.fail('Choose a team for an item without a group.');
                item.team = command.group;
                item.claim = null;
                M.log(c, actor, env, 'item.team_repaired', item.name);
                break;
            }
            case 'releaseClaim': {
                if (c.state !== 'submitted' || !r || r.handedAt)
                    M.fail('This requisition is closed.');
                const item = r?.items.find(i => i.id === command.itemId);
                if (!item || !item.claim || !(actor.master || actor.module && actor.hr))
                    M.fail('Only an authorised administrator can release another claim.', 'forbidden');
                item.claim = null;
                item.state = item.card && item.stage === 'tech' ? 'printed' : 'todo';
                M.log(c, actor, env, 'item.claim_released', item.name);
                break;
            }
            case 'taskGroup': {
                if (c.state !== 'submitted')
                    M.fail('Submit the case before assigning work.');
                if (!actor.module)
                    M.fail('Onboarding access is required.', 'forbidden');
                const task = c.tasks.find(t => t.id === command.taskId);
                if (!task || task.by !== 'group' || task.status === 'done' || !config.groups.some(g => g.id === command.group))
                    M.fail('Choose an assignment group.');
                task.group = command.group;
                task.method = 'manual';
                task.assignee = null;
                task.failure = null;
                M.log(c, actor, env, 'task.group_changed', task.name);
                break;
            }
            case 'reopen':
                M.reopenCase(c, actor, env);
                break;
            case 'task':
                M.setTask(config, c, command.taskId, command.status, actor, env);
                break;
            case 'assignTask':
                M.manualTask(config, c, command.taskId, command.user, actor, env, command.roundRobin);
                break;
            case 'approve':
                M.decide(config, c, command.itemIds, command.decision, actor, env);
                break;
            case 'assignApproval':
                M.assignApproval(config, c, command.itemId, command.stepId, command.user, actor, env);
                break;
            case 'fulfil':
                M.fulfil(config, c, command.itemId, command.status, actor, env);
                break;
            case 'removeItem': {
                const i = r?.items.find(i => i.id === command.itemId);
                if (!i)
                    M.fail('Item not found.');
                M.removeItem(config, c, i, actor, env);
                break;
            }
            case 'addItem': {
                if (!r || !config.exceptions.groups.some(g => M.inGroup(config, g, actor.id)))
                    M.fail('Your group cannot add items.', 'forbidden');
                const cat = config.catalogue.find(x => x.id === command.catalogueId);
                if (!cat)
                    M.fail('Item not found.');
                if (command.confirmedBy && !env.users.includes(command.confirmedBy))
                    M.fail('Choose a current confirming user.');
                M.addItem(config, c, r, cat, 'exception', false, command.reason, command.approval, command.confirmedBy, actor, env);
                break;
            }
            case 'handover':
                M.handover(config, c, actor, env);
                break;
            case 'readNote':
                if (!r || !(r.items.some(i => M.inGroup(config, i.team, actor.id)) || config.exceptions.groups.some(g => M.inGroup(config, g, actor.id))))
                    M.fail('Only the fulfilling teams or groups who can add systems acknowledge this note.', 'forbidden');
                else {
                    r.noteAcks[actor.id] = r.noteVersion;
                    M.log(c, actor, env, 'note.read');
                }
                break;
            case 'keepProviding': {
                const i = r?.items.find(i => i.id === command.itemId);
                if (!i || !M.inGroup(config, i.team, actor.id))
                    M.fail('Only the fulfilling team can keep providing.', 'forbidden');
                i.retiredFlag = false;
                M.log(c, actor, env, 'item.kept', i.name);
                break;
            }
            case 'acknowledge':
                if (!c.personId || c.personId !== ctx.personId || !r?.handedAt || c.state !== 'submitted' || c.acknowledgement)
                    M.fail('Acknowledgement is not available.', 'forbidden');
                if (command.data.acknowledged !== 'true' || !command.data.contactNumber?.trim() || !command.data.serialNumber?.trim())
                    M.fail('Confirm that you received the equipment.');
                c.acknowledgement = { at: env.now, by: actor.id, data: command.data };
                for (const t of c.tasks.filter(t => t.by === 'joiner' && t.gate)) {
                    t.status = 'done';
                    t.completedAt = env.now;
                    t.completedBy = actor.id;
                }
                M.log(c, actor, env, 'acknowledgement.submitted');
                break;
        }
        if (command.type === 'submit')
            await assignRoleTasksTx(tx, c);
        await storeTx(tx, ctx, row, c, actor.hr);
        await auditTx(tx, ctx, c, command.type);
        return { revision: revision + 1 };
    });
}
/** Called by Personnel while its original transaction is still open; optional module stays optional. */
/**
 * d839ff30 — THE ONE LOCK ORDER FOR ONBOARDING: the tenant's audit-chain lock, THEN the onboarding lock.
 *
 * Every domain_event insert takes the tenant's audit-chain advisory lock in its BEFORE INSERT trigger
 * (db/migrations/0534_persisted_audit_chain.sql) and holds it to commit. A Personnel save appends its event
 * and only then reaches onboardingSyncDraftTx (audit-chain, then onboarding), while the Personnel backfill
 * took the onboarding lock and then appended onboarding-case events (onboarding, then audit-chain). Run
 * together, that is a deadlock and Postgres rolls one of them back (40P01). Taking the audit-chain lock
 * first wherever the onboarding lock is taken puts every path in the same order, whatever it did before.
 * The audit-chain key must stay byte-identical to the trigger's; test/onboarding-v31-db.test.ts forces the
 * interleaving and fails if the two ever drift apart.
 */
async function lockOnboardingTx(tx: Tx, tenantId: string) {
    await tx.execute(sql `select pg_advisory_xact_lock(hashtext('audit-chain:' || ${tenantId}::uuid::text))`);
    await tx.execute(sql `select pg_advisory_xact_lock(hashtextextended(${tenantId + ':onboarding'},0))`);
}
export async function onboardingSyncDraftTx(ctx: SessionContext, tx: Tx, draftId: string, mode: 'save' | 'active' | 'discard', active?: {
    employmentId: string;
    personId: string;
}) {
    if (ctx.entitlementsExempt || ctx.entitlementsError || !isModuleEnabled(ctx, 'lifecycle'))
        return;
    // Personnel saves and the scheduled backfill must not both create the first case for one draft.
    await lockOnboardingTx(tx, ctx.tenantId);
    const { config, revision } = await configTx(tx, ctx);
    if (!revision)
        return;
    const [draft] = await tx.select().from(employeeDraft).where(eq(employeeDraft.id, draftId));
    const [row] = await tx.select().from(cases).where(eq(cases.sourceDraftId, draftId)).for('update');
    const { now, today } = clock(), env: M.Environment = { now, today, id: randomUUID, nextNumber: () => '', leave: {}, taskLoads: {}, lastTaskAssignment: {}, pendingApprovals: {}, lifetimeApprovals: {}, users: [] };
    if (mode === 'discard') {
        if (row) {
            const a = await actorTx(tx, ctx, config, row.companyId);
            M.cancelCase(row.data, 'Personnel draft discarded', { ...a, module: true }, env);
            await storeTx(tx, ctx, row, row.data, false);
            await auditTx(tx, ctx, row.data, 'source_discarded');
        }
        return;
    }
    if (!draft?.companyId)
        return;
    if (mode === 'save' && row?.data.sourceVersion === draft.updatedAt.toISOString())
        return;
    const data = draft.data as EmployeeDraftData, p = data.profile ?? {}, e = data.employment ?? {};
    const [dept] = e.departmentId ? await tx.select({ businessUnitId: department.businessUnitId }).from(department).where(eq(department.id, e.departmentId)) : [];
    const raw: Partial<M.Facts> = { fullName: p.fullName, employeeId: draft.reservedEmployeeCode ?? p.employeeCode, joinDate: e.hiredOn, title: e.positionId, department: e.departmentId, company: draft.companyId, businessGroup: dept?.businessUnitId ?? undefined, grade: e.gradeId, employmentType: e.employmentType, supervisor: e.reportingManagerEmploymentId, email: p.primaryEmail, costCentre: e.costCenterId, ic: p.icNumber, passport: p.passportNumber };
    const source = Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === 'string' && v.trim())) as Partial<M.Facts>;
    let number = row?.data.number;
    if (!number) {
        const [seq] = rows<{
            n: number;
        }>(await tx.execute(sql `select app.onboarding_next_case_number(${today.slice(0, 4)}) as n`));
        number = 'OB-' + today.slice(0, 4) + '-' + String(seq!.n).padStart(4, '0');
    }
    const c = row?.data ?? M.blankCase(randomUUID(), number, draftId, source, env);
    if (row) {
        const [privateRow] = await tx.select().from(secrets).where(eq(secrets.caseId, row.id));
        if (privateRow)
            Object.assign(c.local, privateRow.data.local);
    }
    const old = JSON.stringify(Object.entries(c.source).sort());
    c.source = source;
    c.syncedAt = now;
    c.sourceVersion = draft.updatedAt.toISOString();
    if (row && old !== JSON.stringify(Object.entries(stripPrivate(c).value.source).sort()) && c.state === 'submitted')
        c.reconcileNeeded = true;
    if (active) {
        c.employmentId = active.employmentId;
        c.personId = active.personId;
        c.personnelStatus = 'Active';
    }
    const a: M.Actor = ctx.userId ? await actorTx(tx, ctx, config, draft.companyId) : { id: 'system', name: 'Personnel Management', module: true, hr: true, master: true };
    M.log(c, a, env, active ? 'personnel.activated' : row ? 'personnel.updated' : 'personnel.synced');
    if (active)
        await assignRoleTasksTx(tx, c);
    if (row)
        await storeTx(tx, ctx, { ...row, companyId: draft.companyId }, c, a.hr);
    else {
        const { value, data: secretData } = stripPrivate(c);
        await tx.insert(cases).values({ id: c.id, tenantId: ctx.tenantId, companyId: draft.companyId, sourceDraftId: draftId, data: value, employmentId: c.employmentId });
        if (a.hr)
            await tx.insert(secrets).values({ caseId: c.id, tenantId: ctx.tenantId, companyId: draft.companyId, data: secretData });
    }
    await auditTx(tx, ctx, c, active ? 'personnel_activated' : 'personnel_synced');
}
export async function onboardingSaveConfig(ctx: SessionContext, revision: number, input: M.Config, replacements: Record<string, string> = {}, flagRetired = false) {
    return saveConfig(ctx, revision, input, replacements, flagRetired);
}
export async function onboardingSaveChecklistTasks(ctx: SessionContext, revision: number, checklistId: string, input: M.TaskDef[]) {
    const tasks = onboardingTaskSchema.array().max(100).parse(input);
    return saveConfig(ctx, revision, null, {}, false, { checklistId, tasks });
}
async function saveConfig(ctx: SessionContext, revision: number, input: M.Config | null, replacements: Record<string, string>, flagRetired: boolean, taskEdit?: {
    checklistId: string;
    tasks: M.TaskDef[];
}) {
    return withTenant(ctx, async (tx) => {
        await lockOnboardingTx(tx, ctx.tenantId);
        const { config: old, revision: current } = await configTx(tx, ctx), actor = await actorTx(tx, ctx, old);
        if (!actor.module && !actor.master)
            M.fail('Onboarding access is required.', 'forbidden');
        if (current !== revision)
            M.fail('Settings changed. Reload before saving.', 'conflict');
        const next = taskEdit ? structuredClone(old) : onboardingConfigSchema.parse(input) as M.Config;
        if (taskEdit) {
            if (!actor.module)
                M.fail('Onboarding access is required.', 'forbidden');
            const checklist = next.checklists.find(c => c.id === taskEdit.checklistId);
            if (!checklist)
                M.fail('Save the new checklist before editing its tasks.');
            checklist!.tasks = taskEdit.tasks;
        }
        jsonSize(next);
        if (JSON.stringify(old.access) !== JSON.stringify(next.access) && !actor.master)
            M.fail('Only the Master Admin changes module access.', 'forbidden');
        if (!actor.module && !actor.master)
            M.fail('You cannot edit onboarding settings.', 'forbidden');
        if (!actor.module && actor.master) {
            const a = { ...old, groups: next.groups, access: next.access }, b = { ...next };
            if (JSON.stringify(a) !== JSON.stringify(b))
                M.fail('Grant yourself Onboarding access before editing its settings.', 'forbidden');
        }
        const directory = await directoryTx(tx), users = new Set(directory.map(x => x.id));
        const referencedUsers = (value: M.Config) => [...value.access.onboarding, ...value.access.offboarding, ...value.groups.flatMap(g => g.members), ...value.checklists.map(c => c.owner), ...value.workflows.flatMap(w => w.steps.filter(s => s.type === 'person').map(s => s.target))];
        const retainedUsers = new Set(referencedUsers(old));
        for (const id of referencedUsers(next))
            if (!users.has(id) && !retainedUsers.has(id))
                M.fail('A selected user is unavailable.');
        const ruleSets = (value: M.Config): M.Rules[] => [...value.checklists.map(c => c.rules), ...value.catalogue.map(c => c.rules), ...value.routings.flatMap(r => r.rows.map(x => x.rules))];
        const retainedRules = new Set(ruleSets(old).flatMap(r => Object.entries(r).flatMap(([key, ids]) => (ids ?? []).map(id => key + ':' + id))));
        const masterIds = {
            company: new Set((await tx.select({ id: company.id }).from(company)).map(x => x.id)),
            businessGroup: new Set((await tx.select({ id: businessUnit.id }).from(businessUnit)).map(x => x.id)),
            department: new Set((await tx.select({ id: department.id }).from(department)).map(x => x.id)),
            title: new Set((await tx.select({ id: position.id }).from(position)).map(x => x.id)),
            grade: new Set((await tx.select({ id: jobGrade.id }).from(jobGrade)).map(x => x.id)),
            employmentType: new Set<string>(employmentTypeEnum.enumValues),
        };
        for (const rules of ruleSets(next))
            for (const [key, ids] of Object.entries(rules))
                for (const id of ids ?? []) {
                    if (!masterIds[key as keyof typeof masterIds].has(id) && !retainedRules.has(key + ':' + id))
                        M.fail('A selected matching value is unavailable. Choose an existing master record.');
                }
        for (const cl of old.checklists) {
            const changed = next.checklists.find(n => n.id === cl.id);
            if (!changed && cl.owner !== actor.id)
                M.fail('Only the checklist owner can delete it.', 'forbidden');
            if (changed && changed.owner !== cl.owner && cl.owner !== actor.id)
                M.fail('Only the current owner transfers a checklist.', 'forbidden');
            if (changed && changed.owner !== cl.owner && !next.access.onboarding.includes(changed.owner))
                M.fail('The new owner needs Onboarding access.');
            if (changed)
                changed.createdAt = cl.createdAt;
        }
        for (const cl of next.checklists)
            if (!old.checklists.some(x => x.id === cl.id)) {
                cl.owner = actor.id;
                cl.createdAt = new Date().toISOString();
            }
        for (const w of old.workflows)
            if (!next.workflows.some(n => n.id === w.id) && (next.catalogue.some(i => i.workflow === w.id) || next.exceptions.workflow === w.id))
                M.fail('This workflow is still used by the catalogue or exceptions.');
        const deleted = old.groups.filter(g => !next.groups.some(n => n.id === g.id));
        for (const g of deleted) {
            const replacement = replacements[g.id] ?? '';
            if (replacement && !next.groups.some(n => n.id === replacement))
                M.fail('Choose an existing replacement group.');
            for (const cl of next.checklists)
                for (const t of cl.tasks)
                    if (t.group === g.id) {
                        t.group = replacement;
                        t.method = 'manual';
                    }
            for (const w of next.workflows)
                for (const step of w.steps)
                    if (step.type === 'group' && step.target === g.id)
                        step.target = replacement;
            for (const routing of next.routings)
                for (const row of routing.rows)
                    if (row.group === g.id)
                        row.group = replacement;
            for (const cat of next.catalogue)
                if (cat.team === g.id)
                    cat.team = replacement;
            if (next.techGroup === g.id)
                next.techGroup = replacement;
            if (next.exceptions.confirmingGroup === g.id)
                next.exceptions.confirmingGroup = replacement;
            next.exceptions.groups = next.exceptions.groups.filter(x => x !== g.id);
        }
        M.validateConfig(next);
        const list = await tx.select().from(cases).orderBy(asc(cases.id)).for('update');
        const { now, today } = clock(), env: M.Environment = { now, today, id: randomUUID, nextNumber: () => '', leave: {}, taskLoads: {}, lastTaskAssignment: {}, pendingApprovals: {}, lifetimeApprovals: {}, users: [...users] };
        for (const row of list) {
            const c = structuredClone(row.data);
            let changed = false;
            for (const g of deleted) {
                for (const t of c.tasks)
                    if (t.group === g.id && t.status !== 'done') {
                        t.group = replacements[g.id] ?? '';
                        t.method = 'manual';
                        t.assignee = null;
                        t.failure = 'Choose an assignment group and owner.';
                        changed = true;
                    }
                for (const r of c.requisitions.filter(r => !r.cancelledAt && !r.handedAt))
                    for (const i of r.items) {
                        if (i.team === g.id) {
                            i.team = replacements[g.id] ?? '';
                            i.claim = null;
                            changed = true;
                        }
                        for (const s of i.steps)
                            if (s.group === g.id && s.status === 'pending') {
                                s.group = replacements[g.id] ?? null;
                                s.user = null;
                                s.manual = true;
                                s.status = s.group ? 'pending' : 'unresolved';
                                changed = true;
                            }
                    }
            }
            if (c.personnelStatus === 'Draft') {
                const before = M.matchChecklist(old, c).checklist, after = M.matchChecklist(next, c).checklist;
                if (JSON.stringify(before) !== JSON.stringify(after) && c.state === 'submitted') {
                    c.reconcileNeeded = true;
                    changed = true;
                }
            }
            if (flagRetired)
                for (const r of c.requisitions.filter(r => !r.cancelledAt && !r.handedAt))
                    for (const i of r.items) {
                        if (old.catalogue.find(x => x.id === i.catalogueId)?.active && !next.catalogue.find(x => x.id === i.catalogueId)?.active) {
                            i.retiredFlag = true;
                            changed = true;
                        }
                    }
            if (changed) {
                M.log(c, actor, env, 'configuration.changed');
                await storeTx(tx, ctx, row, c, false);
            }
        }
        if (!current)
            M.fail('Initialise onboarding first.');
        const saved = await tx.update(configs).set({ data: next, revision: current + 1, updatedAt: new Date() }).where(and(eq(configs.tenantId, ctx.tenantId), eq(configs.revision, current))).returning();
        if (!saved.length)
            M.fail('Settings changed. Reload before saving.', 'conflict');
        await tx.execute(sql `insert into lc_onboarding_config_history(tenant_id,revision,data,actor_user_id) values(${ctx.tenantId}::uuid,${current + 1},${JSON.stringify(next)}::jsonb,${actor.id}::uuid)`);
        await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'onboarding-config', aggregateId: ctx.tenantId, eventType: 'onboarding.config.updated', actor: actorOf(ctx), payload: { revision: current + 1 } });
        return { revision: current + 1 };
    });
}
export async function onboardingNote(ctx: SessionContext, caseId: string, input: {
    id?: string;
    context: string;
    body: string;
    mentions: string[];
    deleted?: boolean;
    resolve?: boolean;
}) {
    input = onboardingNoteSchema.parse(input);
    if (input.body.length > 10000 || input.mentions.length > 50)
        M.fail('This note is too long.');
    return withTenant(ctx, async (tx) => {
        const { row, config, actor, c } = await loadTx(tx, ctx, caseId, true);
        if (!await participantTx(tx, caseId))
            M.fail('This conversation is not available.', 'forbidden');
        const thread = (await tx.select().from(notes).where(eq(notes.caseId, caseId)).orderBy(asc(notes.createdAt), asc(notes.id))).map(n => n.data);
        if (input.context !== 'requisition' && !c.tasks.some(t => t.id === input.context) && !input.id)
            M.fail('Choose an existing task conversation.');
        const task = c.tasks.find(t => t.id === input.context), r = M.currentReq(c);
        const allowed = actor.module || task?.assignee === actor.id || input.context === 'requisition' && canReadRequisition(config, r, actor) || thread.some(n => n.context === input.context && n.mentions.includes(actor.id));
        if (!allowed)
            M.fail('This conversation is not available.', 'forbidden');
        if (c.state === 'cancelled')
            M.fail('This case is cancelled.');
        const directory = await directoryTx(tx);
        if (input.mentions.some(id => !directory.some(u => u.id === id)))
            M.fail('Choose active people from the directory.');
        if (input.id) {
            const existing = thread.find(n => n.id === input.id);
            if (!existing)
                M.fail('Note not found.');
            if (input.resolve) {
                if (!existing.mentions.includes(actor.id))
                    M.fail('This mention is not assigned to you.', 'forbidden');
                existing.resolved = [...new Set([...existing.resolved, actor.id])];
            }
            else {
                if (existing.by !== actor.id)
                    M.fail('Only the author can edit a note.', 'forbidden');
                existing.revisions = [...(existing.revisions ?? []), { body: existing.body, mentions: [...existing.mentions], deleted: existing.deleted, at: new Date().toISOString(), by: actor.id }];
                if (!input.deleted) {
                    if (!input.body.trim())
                        M.fail('Write a note before saving.');
                    existing.body = input.body.trim();
                    existing.mentions = input.mentions;
                }
                existing.resolved = [];
                existing.edited = true;
                existing.deleted = !!input.deleted;
            }
            await tx.update(notes).set({ data: existing }).where(eq(notes.id, existing.id));
        }
        else {
            if (!input.body.trim())
                M.fail('Write a note before sending.');
            const note: M.Note = { id: randomUUID(), context: input.context, body: input.body.trim(), by: actor.id, name: actor.name, at: new Date().toISOString(), edited: false, mentions: input.mentions, resolved: [], deleted: false };
            await tx.insert(notes).values({ id: note.id, tenantId: ctx.tenantId, caseId, data: note });
            // A reply resolves only mentions of its author in this conversation.
            for (const old of thread.filter(n => n.context === input.context && n.mentions.includes(actor.id) && !n.resolved.includes(actor.id) && (!c.submittedAt || n.at >= c.submittedAt))) {
                old.resolved.push(actor.id);
                await tx.update(notes).set({ data: old }).where(eq(notes.id, old.id));
            }
        }
        await auditTx(tx, ctx, c, 'note_changed');
        // Bump case version so clients know to refresh note/read-state projections.
        await tx.update(cases).set({ revision: row.revision + 1, updatedAt: new Date() }).where(eq(cases.id, caseId));
    });
}
export type OnboardingTask = {
    id: string;
    caseId: string;
    revision: number;
    kind: 'checklist' | 'approval' | 'manualApproval' | 'team' | 'handover' | 'mention' | 'hrNote' | 'case' | 'owner' | 'acknowledgement';
    title: string;
    joiner: string;
    businessGroup: string;
    joinDate: string;
    due: string;
    overdue: boolean;
    assigned: boolean;
    tagged: boolean;
    team: boolean;
    taskId?: string;
    itemIds?: string[];
    stepId?: string;
    noteId?: string;
    status?: string;
    locked?: boolean;
    claimedBy?: string | null;
    context?: string;
    lockReason?: string;
};
export async function onboardingTasks(ctx: SessionContext): Promise<OnboardingTask[]> {
    return withTenant(ctx, async (tx) => {
        const { config } = await configTx(tx, ctx), actor = await actorTx(tx, ctx, config), today = todayInKualaLumpur();
        // Only unresolved mentions can create a task. Keep case/note RLS and the submission boundary.
        const allNotes = await tx.select({caseId:notes.caseId,data:notes.data}).from(notes)
            .innerJoin(cases,eq(cases.id,notes.caseId))
            .where(and(eq(cases.tenantId,ctx.tenantId),sql`${cases.data}->>'state' = 'submitted'`,
                sql`coalesce((${notes.data}->>'deleted')::boolean,false) = false`,
                sql`(${notes.data}->'mentions') ? ${actor.id}`,
                sql`not ((${notes.data}->'resolved') ? ${actor.id})`,
                sql`(coalesce(${cases.data}->>'submittedAt','') = '' or ${notes.data}->>'at' >= ${cases.data}->>'submittedAt')`))
            .orderBy(asc(notes.createdAt),asc(notes.id));
        const notesByCase = new Map<string,M.Note[]>();
        for(const note of allNotes){const list=notesByCase.get(note.caseId)??[];list.push(note.data);notesByCase.set(note.caseId,list);}
        const list = await tx.select().from(cases).where(and(eq(cases.tenantId,ctx.tenantId),sql`(
            (${actor.module} and ${cases.data}->>'state' = 'pending') or
            (${cases.data}->>'state' = 'submitted' and (
                exists(select 1 from jsonb_array_elements(${cases.data}->'tasks') task where task->>'status' <> 'done') or
                exists(select 1 from jsonb_array_elements(${cases.data}->'requisitions') req where coalesce(req->>'cancelledAt','') = '' and coalesce(req->>'handedAt','') = '') or
                ${inArray(cases.id,[...notesByCase.keys()])}
            )))`)).orderBy(asc(cases.id)), out: OnboardingTask[] = [];
        const claimantIds=[...new Set(list.flatMap(row=>M.currentReq(row.data)?.items.flatMap(item=>item.claim?[item.claim]:[])??[]))];
        const names = claimantIds.length ? rows<{id:string;name:string}>(await tx.execute(sql`select * from app.onboarding_directory() where id = any(array[${sql.join(claimantIds.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[])`)) : [];
        const nameById=new Map(names.map(row=>[row.id,row.name]));
        for (const row of list) {
            const c = row.data, f = M.effectiveFacts(c), r = M.currentReq(c);
            if (c.state === 'cancelled')
                continue;
            const add = (partial: Pick<OnboardingTask, 'kind' | 'title'> & Partial<OnboardingTask>) => {
                const due = partial.due ?? f.joinDate;
                out.push({ id: c.id + ':' + partial.kind + ':' + (partial.taskId ?? partial.noteId ?? partial.itemIds?.join(',') ?? ''), caseId: c.id, revision: row.revision, joiner: f.fullName, businessGroup: f.businessGroup, joinDate: f.joinDate, due, overdue: !!due && due < today, assigned: false, tagged: false, team: false, ...partial });
            };
            if (c.state === 'pending' && actor.module)
                add({ kind: 'case', title: 'Submit onboarding case', due: M.validDate(f.joinDate) ? M.dayDate(f.joinDate, -7) : '', team: true });
            if (c.state !== 'submitted')
                continue;
            for (const t of c.tasks) {
                if (t.status === 'done')
                    continue;
                const locked = !!(t.opensOn && t.opensOn > today || t.gate && !r?.handedAt), lockReason = t.gate && !r?.handedAt ? 'After Day 1 handover' : t.opensOn && t.opensOn > today ? 'Opens ' + t.opensOn.split('-').reverse().join('/') : undefined;
                if (t.assignee === actor.id)
                    add({ kind: t.by === 'joiner' && t.gate ? 'acknowledgement' : 'checklist', title: t.name, taskId: t.id, due: t.dueOn, status: t.status, assigned: true, locked, lockReason });
                if (t.by !== 'group' && !t.assignee && t.failure && actor.module)
                    add({ kind: 'owner', title: 'Link the Personnel account: ' + t.name, taskId: t.id, due: t.dueOn, team: true });
                if (t.by === 'group' && !t.assignee && actor.module && (t.failure || t.dueOn <= M.dayDate(today, 8)))
                    add({ kind: 'owner', title: 'Assign an owner: ' + t.name, taskId: t.id, due: t.dueOn, team: true });
            }
            if (r && !r.cancelledAt && !r.handedAt) {
                if (actor.module && r.items.some(i => !i.removed && !i.team))
                    add({ kind: 'owner', title: 'Choose a fulfilling team', itemIds: r.items.filter(i => !i.removed && !i.team).map(i => i.id) });
                const actionable = r.items.filter(i => !i.removed && i.approval === 'pending' && i.steps.some(s => M.stepOpen(i, s) && s.status === 'pending' && (!s.manual || s.user) && (s.user === actor.id || M.inGroup(config, s.group, actor.id))));
                if (actionable.length)
                    add({ kind: 'approval', title: 'Approve ' + actionable.length + ' items', itemIds: actionable.map(i => i.id), assigned: actionable.some(i => i.steps.some(s => s.user === actor.id && M.stepOpen(i, s))), team: true });
                const manual = new Set<string>();
                for (const i of r.items.filter(i => !i.removed)) {
                    for (const s of i.steps)
                        if (M.stepOpen(i, s) && s.manual && !s.user && M.inGroup(config, s.group, actor.id) && !manual.has(s.id + ':' + s.group)) {
                            manual.add(s.id + ':' + s.group);
                            add({ kind: 'manualApproval', title: 'Choose an approver: ' + s.label, itemIds: [i.id], stepId: s.id, team: true });
                        }
                    if (M.activeItem(i) && i.state !== 'ready' && i.state !== 'handed' && M.inGroup(config, i.team, actor.id))
                        add({ kind: 'team', title: i.name, itemIds: [i.id], status: i.state === 'progress' ? 'progress' : 'todo', team: true, assigned: i.claim === actor.id, locked: !!i.claim && i.claim !== actor.id, claimedBy: i.claim ? nameById.get(i.claim) ?? 'A teammate' : null });
                }
                if (M.inGroup(config, config.techGroup, actor.id) && !r.items.some(i => !i.removed && i.approval === 'pending') && r.items.filter(M.activeItem).every(i => i.state === 'ready'))
                    add({ kind: 'handover', title: 'Record Day 1 handover', team: true, overdue: !!f.joinDate && f.joinDate <= today });
                if (r.hrNote && r.noteAcks[actor.id] !== r.noteVersion && (r.items.some(i => M.inGroup(config, i.team, actor.id)) || config.exceptions.groups.some(g => M.inGroup(config, g, actor.id))))
                    add({ kind: 'hrNote', title: 'Read People GBS note', team: true });
            }
            for (const n of notesByCase.get(c.id) ?? [])
                if (!n.deleted && (!c.submittedAt || n.at >= c.submittedAt) && n.mentions.includes(actor.id) && !n.resolved.includes(actor.id)) {
                    const within = !!f.joinDate && f.joinDate <= M.dayDate(today, config.exceptions.remindDays + 1);
                    add({ kind: 'mention', title: n.name + ' mentioned you', noteId: n.id, context: n.context, tagged: true, assigned: true, overdue: within });
                }
        }
        return out.sort((a, b) => Number(b.overdue) - Number(a.overdue) || (a.due || '9999').localeCompare(b.due || '9999') || a.id.localeCompare(b.id));
    });
}
/** Reuse the canonical case/workflow interpreter. Home receives only actual unlocked assignments,
 * with the case's recorded update timestamp; a case join date is never invented as a task deadline. */
export async function onboardingAssignedTaskMetadata(ctx:SessionContext):Promise<AssignedPersonalTaskMetadata[]>{
    const assigned=(await onboardingTasks(ctx)).filter(item=>item.assigned&&!item.locked);
    return withTenant(ctx,async tx=>{
        await assertAssignedWorkPrincipalTx(tx,ctx);
        const ids=[...new Set(assigned.map(item=>item.caseId))],updated=new Map<string,Date>();
        for(let start=0;start<ids.length;start+=1000){
            const rows=await tx.select({id:cases.id,updatedAt:cases.updatedAt}).from(cases)
                .where(and(eq(cases.tenantId,ctx.tenantId),inArray(cases.id,ids.slice(start,start+1000)))).orderBy(cases.id);
            for(const row of rows)updated.set(row.id,row.updatedAt);
        }
        return assigned.flatMap(item=>{
            const sourceUpdatedAt=updated.get(item.caseId);if(!sourceUpdatedAt)return [];
            const dueDate=(item.kind==='checklist'||item.kind==='acknowledgement')&&M.validDate(item.due)?item.due:undefined;
            return [{id:item.id,kind:'onboarding' as const,subjectName:item.title+' · '+item.joiner,sourceUpdatedAt,
                linkPath:'/tasks#'+encodeURIComponent('onboarding-'+item.id),...(dueDate?{dueDate}:{})}];
        });
    });
}

export type OnboardingNotice = {
    id: string;
    title: string;
    body: string;
    severity: 'info' | 'action' | 'warning';
    linkPath: string;
    createdAt: Date;
    readAt: Date | null;
};
export async function onboardingNotices(ctx: SessionContext, read = false): Promise<OnboardingNotice[]> {
    return withTenant(ctx, async (tx) => {
        const result = rows<{
            id: string;
            kind: string;
            created_at: Date;
            read_at: Date | null;
        }>(await tx.execute(sql `select id,kind,created_at,read_at from lc_onboarding_notice where tenant_id=app.current_tenant_id() and user_id=app.current_user_id() and kind<>'digest' and (read_at is not null)=${read} order by created_at desc,id desc limit 50`));
        const titles: Record<string, string> = { sync: 'New joiner synced', due: 'Onboarding task due soon', overdue: 'Onboarding work is overdue', owner: 'An onboarding task needs an owner', assignment_failed: 'A task could not be assigned', mention: 'You were mentioned in onboarding', digest: 'Your daily onboarding digest' };
        return result.map(n => ({ id: 'onb:' + n.id, title: titles[n.kind] ?? 'Onboarding update', body: 'Open My tasks to review the work you can access.', severity: n.kind === 'overdue' || n.kind === 'assignment_failed' ? 'warning' : 'info', linkPath: '/tasks', createdAt: n.created_at, readAt: n.read_at }));
    });
}
export async function onboardingReadNotice(ctx: SessionContext, id?: string) {
    return withTenant(ctx, async (tx) => {
        if (id && !/^[0-9a-f-]{36}$/i.test(id))
            M.fail('Invalid notification.');
        await tx.execute(id ? sql `update lc_onboarding_notice set read_at=now() where tenant_id=app.current_tenant_id() and user_id=app.current_user_id() and id=${id}::uuid` : sql `update lc_onboarding_notice set read_at=now() where tenant_id=app.current_tenant_id() and user_id=app.current_user_id() and read_at is null`);
    });
}
/** Minute sweep; recipients are login identities, including staff who have no employment. */
export async function sweepOnboarding(ctx: SessionContext) {
    return withTenant(ctx, async (tx) => {
        const [{ ok }] = rows<{
            ok: boolean;
        }>(await tx.execute(sql `select app.is_group_admin() as ok`));
        if (!ok)
            M.fail('Onboarding dispatcher required.', 'forbidden');
        const { config, revision } = await configTx(tx, ctx);
        if (!revision)
            return { created: 0 };
        await tx.execute(sql `select pg_advisory_xact_lock(hashtextextended(${ctx.tenantId + ':onboarding-notices'},0))`);
        const list = await tx.select().from(cases).orderBy(asc(cases.id)), thread = await tx.select().from(notes).orderBy(asc(notes.id)), today = todayInKualaLumpur(), hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kuala_Lumpur', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
        let created = 0;
        const notify = async (user: string, caseId: string, kind: string, occurrence: string): Promise<boolean> => {
            const result = await tx.execute(sql `insert into lc_onboarding_notice(tenant_id,user_id,case_id,kind,occurrence) select app.current_tenant_id(),u.id,${caseId}::uuid,${kind},${occurrence} from app_user u where u.id=${user}::uuid and u.tenant_id=app.current_tenant_id() and not app.login_blocked(u.id) on conflict do nothing`);
            const inserted = Number(result.count);
            created += inserted;
            return inserted > 0;
        };
        for (const row of list) {
            const c = row.data;
            const digestUsers = new Set<string>();
            if (c.state === 'cancelled')
                continue;
            const matchedChecklist = M.matchChecklist(config, c).checklist;
            const syncedUsers = new Set([...config.access.onboarding, ...(matchedChecklist?.tasks.flatMap(t => config.groups.find(g => g.id === t.group)?.members ?? []) ?? [])]);
            for (const user of syncedUsers)
                await notify(user, c.id, 'sync', c.id);
            if (c.state === 'pending')
                for (const user of config.access.onboarding)
                    digestUsers.add(user);
            for (const task of c.state === 'submitted' ? c.tasks : []) {
                if (task.status === 'done')
                    continue;
                if (task.assignee) {
                    digestUsers.add(task.assignee);
                    if (task.dueOn <= M.dayDate(today, 3))
                        await notify(task.assignee, c.id, task.dueOn < today ? 'overdue' : 'due', task.id + ':' + today);
                }
                else if (task.by === 'group' && (task.failure || task.dueOn <= M.dayDate(today, 8)))
                    for (const user of config.access.onboarding) {
                        digestUsers.add(user);
                        await notify(user, c.id, task.failure ? 'assignment_failed' : 'owner', task.id + ':' + today);
                    }
            }
            const r = M.currentReq(c);
            if (r && !r.cancelledAt && !r.handedAt) {
                for (const item of r.items.filter(i => M.activeItem(i) && i.state !== 'ready' && i.state !== 'handed'))
                    for (const user of config.groups.find(g => g.id === item.team)?.members ?? [])
                        digestUsers.add(user);
                if (!r.items.some(i => !i.removed && i.approval === 'pending') && r.items.filter(M.activeItem).every(i => i.state === 'ready'))
                    for (const user of config.groups.find(g => g.id === config.techGroup)?.members ?? [])
                        digestUsers.add(user);
            }
            if (r)
                for (const i of r.items.filter(i => !i.removed))
                    for (const step of i.steps.filter(s => M.stepOpen(i, s)))
                        for (const user of step.user ? [step.user] : config.groups.find(g => g.id === step.group)?.members ?? [])
                            digestUsers.add(user);
            for (const n of thread.filter(n => n.caseId === c.id && !n.data.deleted && (!c.submittedAt || n.data.at >= c.submittedAt)).map(n => n.data))
                for (const user of n.mentions.filter(u => !n.resolved.includes(u))) {
                    digestUsers.add(user);
                    await notify(user, c.id, 'mention', n.id);
                }
            if (hour >= 8)
                for (const user of digestUsers) {
                    // Exactly one digest per user/day; keep its reference generic and reauthorize the queue on open.
                    const key = 'digest:' + user + ':' + today;
                    if (await notify(user, c.id, 'digest', today)) {
                        await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'onboarding-digest', aggregateId: c.id, eventType: 'onboarding.digest', actor: actorOf(ctx), payload: { caseId: c.id, recipientUserId: user, day: today, key } });
                    }
                }
        }
        return { created };
    });
}
/** Refresh canonical Personnel changes without manufacturing employment or re-running approvals. */
export async function refreshOnboardingPersonnel(ctx: SessionContext, runTenant:typeof withTenant=withTenant) {
    return runTenant(ctx, async (tx) => {
        // A scheduled refresh has no login. Its restricted storage-owner connection is authority;
        // caller-supplied HR role text on the application connection is not a service identity.
        if(!ctx.userId){
            const [principal]=rows<{owner:boolean}>(await tx.execute(sql`select current_user='ai_hr_owner' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) as owner`));
            if(!principal?.owner)M.fail('Scheduled Personnel synchronisation requires the storage owner.', 'forbidden');
        }
        const [{ ok }] = rows<{
            ok: boolean;
        }>(await tx.execute(sql `select app.is_group_admin() as ok`));
        if (!ok)
            M.fail('Personnel synchronisation requires a group administrator.', 'forbidden');
        const { config, revision } = await configTx(tx, ctx), today = todayInKualaLumpur();
        if (!revision)
            return;
        const drafts = await tx.select({ id: employeeDraft.id }).from(employeeDraft).orderBy(asc(employeeDraft.id));
        for (const draft of drafts)
            await onboardingSyncDraftTx(ctx, tx, draft.id, 'save');
        const list = await tx.select().from(cases).orderBy(asc(cases.id)).for('update');
        for (const row of list) {
            const c = structuredClone(row.data);
            if (!c.employmentId) {
                await refreshRoleLinksTx(tx, ctx, row, c);
                continue;
            }
            const [snapshot] = rows<{
                person_id: string;
                company_id: string;
                source: Partial<M.Facts>;
            }>(await tx.execute(sql `
    select e.person_id,e.company_id,jsonb_strip_nulls(jsonb_build_object(
      'fullName',p.full_name,'employeeId',e.employee_code,'email',p.primary_email,
      'joinDate',coalesce(e.join_date,e.hired_on)::text,'company',e.company_id::text,
      'department',a.department_id::text,'title',a.position_id::text,'businessGroup',a.business_unit_id::text,
      'grade',e.grade_id::text,'employmentType',a.employment_type::text,'costCentre',a.cost_center_id::text,
      'supervisor',rl.manager_employment_id::text,'ic',stat.ic_number,'passport',stat.passport_number)) as source
    from employment e join person p on p.id=e.person_id and p.tenant_id=e.tenant_id
    left join lateral (select x.* from assignment x where x.employment_id=e.id and x.tenant_id=e.tenant_id and x.superseded_at is null
      and (x.valid_to is null or x.valid_to>${today}::date) order by (x.valid_from<=${today}::date) desc,case when x.valid_from<=${today}::date then x.valid_from end desc,x.valid_from asc,x.id limit 1) a on true
    left join lateral (select x.manager_employment_id from reporting_line x where x.subordinate_employment_id=e.id and x.tenant_id=e.tenant_id and x.line_type='administrative' and x.superseded_at is null
      and (x.valid_to is null or x.valid_to>${today}::date) order by (x.valid_from<=${today}::date) desc,x.valid_from desc,x.id limit 1) rl on true
    left join employee_statutory_my stat on stat.person_id=e.person_id and stat.tenant_id=e.tenant_id
    where e.id=${c.employmentId}::uuid and e.tenant_id=app.current_tenant_id()
   `));
            if (!snapshot)
                continue;
            const [{ data: privateData } = { data: { source: {}, local: {} } }] = await tx.select({ data: secrets.data }).from(secrets).where(eq(secrets.caseId, c.id));
            const before = { ...c.source, ...privateData.source };
            if (JSON.stringify(Object.entries(before).sort()) === JSON.stringify(Object.entries(snapshot.source).sort())) {
                await refreshRoleLinksTx(tx, ctx, row, c);
                continue;
            }
            c.source = snapshot.source;
            c.local = { ...c.local, ...privateData.local };
            c.personId = snapshot.person_id;
            c.personnelStatus = 'Active';
            c.syncedAt = new Date().toISOString();
            c.sourceVersion = c.syncedAt;
            if (c.state === 'submitted')
                c.reconcileNeeded = true;
            const a: M.Actor = { id: ctx.userId ?? 'system', name: 'Personnel Management', module: true, hr: true, master: true };
            M.log(c, a, { ...clock(), id: randomUUID, nextNumber: () => '', leave: {}, taskLoads: {}, lastTaskAssignment: {}, pendingApprovals: {}, lifetimeApprovals: {}, users: [] }, 'personnel.updated');
            await assignRoleTasksTx(tx, c);
            await storeTx(tx, ctx, { ...row, companyId: snapshot.company_id }, c, true);
            await tx.update(cases).set({ companyId: snapshot.company_id }).where(eq(cases.id, c.id));
            await auditTx(tx, ctx, c, 'personnel_updated');
        }
    });
}
export async function onboardingNavigation(ctx: SessionContext) {
    return withTenant(ctx, async (tx) => {
        const { config, revision } = await configTx(tx, ctx), actor = await actorTx(tx, ctx, config);
        const today=todayInKualaLumpur(),cutoff=M.dayDate(today,-config.recentActiveDays);
        const counts=actor.module?await tx.select({n:sql<number>`count(*)::int`}).from(cases).where(and(eq(cases.tenantId,ctx.tenantId),sql`(
            ${cases.data}->>'personnelStatus' = 'Draft' or
            (${cases.data}->>'state' <> 'cancelled' and (
                ${cases.data}->>'state' = 'pending' or
                exists(select 1 from jsonb_array_elements(${cases.data}->'tasks') task where task->>'status' <> 'done') or
                exists(select 1 from jsonb_array_elements(${cases.data}->'requisitions') req
                    where req = (select entry from jsonb_array_elements(${cases.data}->'requisitions') with ordinality as r(entry,ordinal)
                        where coalesce(entry->>'cancelledAt','') = '' order by ordinal limit 1)
                    and coalesce(req->>'handedAt','') = '')
            )) or coalesce(${cases.data}->'source'->>'joinDate',${cases.data}->'local'->>'joinDate','') >= ${cutoff}
        )`)):[{n:0}];
        return { module:actor.module, master:actor.master, requisitions:actor.module || actor.hr || requisitionGroupAccess(config,actor.id), joiners:Number(counts[0]?.n??0), checklists:actor.module&&revision?config.checklists.length:0 };
    });
}
async function assignRoleTasksTx(tx: Tx, c: M.Case): Promise<boolean> {
    const supervisor = M.effectiveFacts(c).supervisor, manager = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(supervisor) ? supervisor : null;
    const resolved = rows<{
        kind: string;
        user_id: string;
    }>(await tx.execute(sql `select * from app.onboarding_task_actors(${c.personId}::uuid,${manager}::uuid)`));
    let changed = false;
    for (const task of c.tasks.filter(t => t.by !== 'group' && t.status !== 'done')) {
        const user = resolved.find(r => r.kind === task.by)?.user_id ?? null;
        const failure = user ? null : 'The ' + (task.by === 'joiner' ? 'new joiner' : 'line manager') + ' needs a linked Personnel account.';
        if (task.assignee !== user || task.failure !== failure) {
            task.assignee = user;
            task.failure = failure;
            changed = true;
        }
    }
    return changed;
}
async function refreshRoleLinksTx(tx: Tx, ctx: SessionContext, row: Row, c: M.Case) {
    if (c.state !== 'submitted' || !await assignRoleTasksTx(tx, c))
        return;
    const actor: M.Actor = { id: ctx.userId ?? 'system', name: 'Personnel Management', module: true, hr: true, master: true };
    const env: M.Environment = { ...clock(), id: randomUUID, nextNumber: () => '', leave: {}, taskLoads: {}, lastTaskAssignment: {}, pendingApprovals: {}, lifetimeApprovals: {}, users: [] };
    M.log(c, actor, env, 'task.account_link_updated');
    await storeTx(tx, ctx, row, c, false);
    await auditTx(tx, ctx, c, 'task_account_link_updated');
}
export async function onboardingMyAcknowledgements(ctx: SessionContext) {
    return withTenant(ctx, async (tx) => {
        const list = await tx.select().from(cases).orderBy(asc(cases.createdAt), asc(cases.id));
        return list.filter(row => !!ctx.personId && row.data.personId === ctx.personId && row.data.state === 'submitted').map(row => {
            const c = row.data, r = M.currentReq(c), f = M.effectiveFacts(c);
            return { id: c.id, revision: row.revision, name: f.fullName, employeeId: f.employeeId, joinDate: f.joinDate, number: c.number, available: !!r?.handedAt, submittedAt: c.acknowledgement?.at ?? null };
        });
    });
}
export async function onboardingMyAcknowledgement(ctx: SessionContext, caseId?: string) {
    const views = await onboardingMyAcknowledgements(ctx);
    return caseId ? views.find(view => view.id === caseId) ?? null : views.length === 1 ? views[0]! : null;
}
/** Participant-scoped list includes all retained requisition generations. */
export async function onboardingRequisitions(ctx: SessionContext) {
    return withTenant(ctx, async (tx) => {
        const { config } = await configTx(tx, ctx), actor = await actorTx(tx, ctx, config);
        const list = await tx.select({ data: cases.data, id: cases.id, hr: sql<boolean> `app.is_admin_for(${cases.companyId})` }).from(cases).orderBy(asc(cases.createdAt), asc(cases.id));
        return list.flatMap(row => row.data.requisitions.filter(r => canReadRequisition(config, r, { ...actor, hr: row.hr })).map(r => ({
            id: r.id, caseId: row.id, caseNumber: row.data.number, number: r.number, joiner: M.effectiveFacts(row.data).fullName,
            joinDate: M.effectiveFacts(row.data).joinDate, createdAt: r.createdAt,
            status: M.requisitionStatus(r), ready: M.requisitionItemCounts(r).ready,
            active: r.items.filter(M.activeItem).length, total:M.requisitionItemCounts(r).total, pending: r.items.filter(i => !i.removed && i.approval === 'pending').length,
            unreadNote: !!r.hrNote && r.noteAcks[actor.id] !== r.noteVersion && (r.items.some(i => M.inGroup(config, i.team, actor.id)) || config.exceptions.groups.some(g => M.inGroup(config, g, actor.id))),
            current: M.currentReq(row.data)?.id === r.id,
        })));
    });
}
export async function onboardingUnreadNoticeCount(ctx: SessionContext): Promise<number> {
    return withTenant(ctx, async (tx) => Number(rows<{
        count: string;
    }>(await tx.execute(sql `select count(*)::text as count from lc_onboarding_notice where tenant_id=app.current_tenant_id() and user_id=app.current_user_id() and read_at is null and kind<>'digest'`))[0]?.count ?? 0));
}
