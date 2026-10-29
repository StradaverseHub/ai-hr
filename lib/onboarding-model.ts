import type { JoinerSectionSetting, JoinerSections } from './onboarding-page-access';
import { resolveV9CaseFields, missingV9CaseFields, validateV9CaseValue, type CaseField } from './lifecycle-v9-case-form';
import { v9EmploymentRule } from './lifecycle-v9-employment';
import type { EmploymentConfirmationDates } from './employment-confirmation';
/**
 * V3.1 onboarding domain. Separate from the legacy lc_case/ITR process.
 * These aggregate values are persisted under row locks; definition IDs never depend on array indexes.
 */
export type Id = string;
export type Rules = Partial<Record<'businessGroup' | 'company' | 'department' | 'title' | 'grade' | 'employmentType', string[]>>;
export type Facts = {
    fullName: string;
    employeeId: string;
    joinDate: string;
    title: string;
    department: string;
    company: string;
    businessGroup: string;
    grade: string;
    employmentType: string;
    supervisor: string;
    gbsTa: string;
    email: string;
    costCentre: string;
    ic: string;
    passport: string;
} & Partial<Record<keyof EmploymentConfirmationDates, string>>;
export type Group = {
    id: Id;
    name: string;
    members: Id[];
    limit: number;
};
export type StepDef = {
    id: Id;
    label: string;
    type: 'group' | 'routing' | 'person';
    target: Id;
    method: 'manual' | 'rr';
};
export type Workflow = {
    id: Id;
    name: string;
    mode: 'seq' | 'par';
    steps: StepDef[];
};
export type Routing = {
    id: Id;
    name: string;
    rows: {
        id: Id;
        rules: Rules;
        group: Id;
    }[];
};
export type TaskDef = {
    id: Id;
    name: string;
    by: 'group' | 'joiner' | 'manager';
    group: Id;
    method: 'manual' | 'rr';
    opens: number | null;
    due: number;
    gate: boolean;
    required?: boolean;
    documentTemplate?: Id | null;
    documentAction?: 'completed' | 'signed' | 'sent';
};
export type Checklist = {
    id: Id;
    name: string;
    owner: Id;
    createdAt: string;
    rules: Rules;
    tasks: TaskDef[];
};
export type Catalogue = {
    id: Id;
    name: string;
    type: 'system' | 'device';
    active: boolean;
    rules: Rules;
    workflow: Id | null;
    team: Id;
    card: boolean;
};
export type Config = {
    version: 1;
    groups: Group[];
    workflows: Workflow[];
    routings: Routing[];
    checklists: Checklist[];
    catalogue: Catalogue[];
    access: {
        onboarding: Id[];
        offboarding: Id[];
        joinerViewGroups?: Id[];
        joinerSections?: Record<Id,JoinerSectionSetting>;
        recordGroups?: Id[];
        recordHR?: boolean;
    };
    countEquipment: boolean;
    techGroup: string;
    exceptions: {
        groups: Id[];
        workflow: Id | null;
        always: boolean;
        remindDays: number;
        confirmingGroup: string;
    };
    recentActiveDays: number;
    v9ChecklistRevision?: number;
    v9CaseFields?: CaseField[];
};
export type Actor = {
    id: Id;
    name: string;
    module: boolean;
    page?: boolean;
    sections?: JoinerSections | null;
    caseActions?: boolean;
    records?: boolean;
    hr: boolean;
    master: boolean;
};
export type History = {
    id: Id;
    at: string;
    by: Id;
    name: string;
    action: string;
    detail: string;
};
export type Task = TaskDef & {
    checklistId: Id;
    checklistName: string;
    status: 'todo' | 'progress' | 'done';
    assignee: Id | null;
    failure: string | null;
    assignedAt: string | null;
    autoAssignments?: {
        user: Id;
        at: string;
    }[];
    opensOn: string | null;
    dueOn: string;
    completedAt: string | null;
    completedBy: Id | null;
};
export type Approval = StepDef & {
    group: Id | null;
    user: Id | null;
    status: 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'unresolved';
    manual: boolean;
    fallback: boolean;
    viaDefault: string | null;
    unavailable: boolean;
    by: Id | null;
    byName?: string;
    when: string | null;
    assignments: {
        user: Id;
        at: string;
    }[];
};
export type Item = {
    id: Id;
    catalogueId: Id;
    name: string;
    type: 'system' | 'device';
    team: Id;
    card: boolean;
    source: 'matched' | 'exception';
    fromCase: boolean;
    addedBy: Id;
    addedByName?: string;
    requesterName?: string;
    confirmedByName?: string | null;
    workflowName?: string | null;
    requester: Id;
    confirmedBy: Id | null;
    reason: string;
    workflowId: Id | null;
    mode: 'seq' | 'par';
    steps: Approval[];
    approval: 'none' | 'pending' | 'approved' | 'rejected' | 'withdrawn';
    state: 'todo' | 'progress' | 'printed' | 'ready' | 'handed';
    stage: 'facility' | 'tech';
    claim: Id | null;
    removed: boolean;
    retiredFlag: boolean;
    revokeNeeded: boolean;
    fulfilmentMethod?: 'rr' | 'manual';
    dueDay?: number;
    assignmentFailure?: string | null;
    employeeReceipt?: { status: 'received' | 'problem'; at: string; by: Id; note: string };
    recovery?: { offboardingCaseId: string; outcome: 'returned' | 'revoked'; at: string; by: string; reason: string };
};
export type Requisition = {
    id: Id;
    number: string;
    createdAt: string;
    cancelledAt: string | null;
    handedAt: string | null;
    items: Item[];
    hrNote: string;
    noteVersion: number;
    noteAcks: Record<Id, number>;
};
export type Extra = {
    catalogueId: Id;
    reason: string;
    approval: boolean;
};
export type Case = {
    version: 1;
    id: Id;
    number: string;
    sourceDraftId: Id | null;
    employmentId: Id | null;
    personId: Id | null;
    personnelStatus: 'Draft' | 'Active';
    v9DefinitionRevision?: number;
    syncedAt: string;
    source: Partial<Facts>;
    sourceVersion: string;
    local: Partial<Facts>;
    state: 'pending' | 'submitted' | 'cancelled';
    submittedAt: string | null;
    submittedBy: Id | null;
    cancelReason: string | null;
    cancelNote?: string;
    hiring: 'new_hire' | 'replacement' | '';
    replacedEmployee: string;
    deviceType: string;
    floor: string;
    notes: string;
    /** Ephemeral HR-private values; the storage service strips these from public case rows. */
    caseValues?: Record<string,string>;
    caseContactEmail?: string;
    equipmentOverrides?: Record<string, { group?: string; method?: 'rr' | 'manual'; due?: number }>;
    selected: Id[];
    extras: Extra[];
    checklistOverride: Id | 'none' | null;
    confirmedChecklist: Checklist | null;
    reconcileNeeded: boolean;
    tasks: Task[];
    taskHistory: Task[][];
    requisitions: Requisition[];
    history: History[];
    acknowledgementHistory: {
        at: string;
        by: Id;
        data: Record<string, string>;
    }[];
    acknowledgement: {
        at: string;
        by: Id;
        data: Record<string, string>;
    } | null;
};
export type Note = {
    id: Id;
    context: 'requisition' | Id;
    body: string;
    by: Id;
    name: string;
    at: string;
    edited: boolean;
    revisions?: {
        body: string;
        mentions: Id[];
        deleted: boolean;
        at: string;
        by: Id;
    }[];
    mentions: Id[];
    resolved: Id[];
    deleted: boolean;
};
export type Environment = {
    now: string;
    today: string;
    id: () => Id;
    nextNumber: () => string;
    leave: Record<Id, string[]>;
    taskLoads: Record<Id, number>;
    lastTaskAssignment: Record<Id, string>;
    pendingApprovals: Record<Id, number>;
    lifetimeApprovals: Record<Id, number>;
    users: Id[];
    userNames?: Record<Id, string>;
};
export class OnboardingError extends Error {
    constructor(message: string, readonly code = 'invalid', readonly fields: string[] = []) { super(message); }
}
export function fail(message: string, code = 'invalid', fields: string[] = []): never { throw new OnboardingError(message, code, fields); }
export const facts = (c: Case): Partial<Facts> => ({ ...c.local, ...c.source });
export const effectiveFacts = (c: Case): Required<Facts> => ({
    finalConfirmationDate: '', confirmationDate: '', probationEndDate: '', provisionalEndOn: '',
    fullName: '', employeeId: '', joinDate: '', title: '', department: '', company: '', businessGroup: '', grade: '',
    employmentType: '', supervisor: '', gbsTa: '', email: '', costCentre: '', ic: '', passport: '', ...facts(c),
});
export const matches = (rules: Rules, f: Facts) => Object.entries(rules).every(([key, values]) => !values?.length || (key === 'employmentType' ? values.some(value => ['permanent','contract','probation'].includes(value.toLowerCase()) ? v9EmploymentRule(value, f) === true : value === f.employmentType) : values.includes(f[key as keyof Facts] as string)));
export const canonicalRules = (rules: Rules) => JSON.stringify(Object.entries(rules).filter(([, v]) => v?.length).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, [...v!].sort()]));
export const specificity = (rules: Rules) => Object.values(rules).filter(v => v?.length).length;
export function matchChecklist(config: Config, c: Case): {
    checklist: Checklist | null;
    tie: boolean;
    manual: boolean;
} {
    if (c.personnelStatus === 'Active' && c.confirmedChecklist && (c.checklistOverride === null || c.checklistOverride === c.confirmedChecklist.id))
        return { checklist: c.confirmedChecklist, tie: false, manual: c.checklistOverride !== null };
    if (c.checklistOverride !== null)
        return { checklist: config.checklists.find(x => x.id === c.checklistOverride) ?? null, tie: false, manual: true };
    if (c.personnelStatus === 'Active' && c.state === 'submitted')
        return { checklist: null, tie: false, manual: false };
    const list = config.checklists.filter(x => matches(x.rules, effectiveFacts(c))).sort((a, b) => specificity(b.rules) - specificity(a.rules) || a.createdAt.localeCompare(b.createdAt) || config.checklists.indexOf(a) - config.checklists.indexOf(b));
    return { checklist: list[0] ?? null, tie: list.length > 1 && specificity(list[0]!.rules) === specificity(list[1]!.rules), manual: false };
}
export function validDate(value: string): boolean { return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value; }
export function dayDate(join: string, day: number): string {
    if (!validDate(join) || !Number.isInteger(day) || day === 0)
        fail('Choose a valid join date and Day value. Day 1 is the join date; Day 0 is not used.');
    const date = new Date(join + 'T00:00:00Z');
    date.setUTCDate(date.getUTCDate() + (day > 0 ? day - 1 : day));
    return date.toISOString().slice(0, 10);
}
export const currentReq = (c: Case) => c.requisitions.find(r => !r.cancelledAt) ?? null;
export const activeItem = (i: Item) => !i.removed && !['pending', 'rejected', 'withdrawn'].includes(i.approval);
/** The requested-item denominator includes work awaiting approval, as the requisition shows it. */
export function requisitionItemCounts(r: Requisition) {
    const items=r.items.filter(i=>!i.removed&&!['rejected','withdrawn'].includes(i.approval));
    return {total:items.length,ready:items.filter(activeItem).filter(i=>['ready','handed'].includes(i.state)).length};
}
export function requisitionStatus(r: Requisition): 'cancelled' | 'completed' | 'awaiting_approval' | 'ready' | 'in_progress' | 'submitted' {
    if (r.cancelledAt)
        return 'cancelled';
    const active = r.items.filter(activeItem), pending = r.items.some(i => !i.removed && i.approval === 'pending');
    // Empty orders require an explicit handover; never complete through vacuous every().
    if (r.handedAt && !pending && active.every(i => i.state === 'handed'))
        return 'completed';
    if (pending)
        return 'awaiting_approval';
    if (active.length && active.every(i => i.state === 'ready' || i.state === 'handed'))
        return 'ready';
    if (active.some(i => i.state !== 'todo' || i.claim))
        return 'in_progress';
    return 'submitted';
}
export function progress(config: Config, c: Case) {
    const done = c.tasks.filter(t => t.status === 'done').length, total = c.tasks.length, r = currentReq(c);
    const active = r?.items.filter(activeItem) ?? [], ready = active.filter(i => i.state === 'ready' || i.state === 'handed').length;
    const credit = r?.handedAt ? 1 : ready / (active.length + 1);
    const count = config.countEquipment && !!r;
    const denominator = total + (count ? 1 : 0);
    return { done, total, ready, active: active.length, handed: !!r?.handedAt, percent: denominator ? Math.round(100 * (done + (count ? credit : 0)) / denominator) : 0 };
}
/** Display window only. Access is still enforced by the tenant/company and module guards. */
export function visibleRecentJoiner(config: Config, c: Case, today: string) {
    return c.personnelStatus === 'Draft' || c.state !== 'cancelled' && (c.state === 'pending' || c.tasks.some(t => t.status !== 'done') || !!currentReq(c) && !currentReq(c)?.handedAt) || effectiveFacts(c).joinDate >= dayDate(today, -config.recentActiveDays);
}
export function log(c: Case, a: Actor, env: Environment, action: string, detail = '') {
    c.history.push({ id: env.id(), at: env.now, by: a.id, name: a.name, action, detail });
}
const member = (config: Config, group: Id | null, user: Id) => !!group && !!config.groups.find(g => g.id === group)?.members.includes(user);
export const inGroup = member;
const moduleActor = (a: Actor) => a.module || fail('Onboarding access is required.', 'forbidden');
const userAllowed = (env: Environment, id: Id) => env.users.includes(id) || fail('Choose an active user in this organisation.');
export const available = (env: Environment, id: Id, date: string) => !(env.leave[id] ?? []).includes(date);
function taskAssignee(config: Config, t: Task, env: Environment, exclude?: Id): Id | null {
    const group = config.groups.find(g => g.id === t.group);
    if (!group)
        return null;
    return group.members.filter(id => id !== exclude && env.users.includes(id) && available(env, id, t.dueOn) && (group.limit === 0 || (env.taskLoads[id] ?? 0) < group.limit))
        .sort((a, b) => (env.taskLoads[a] ?? 0) - (env.taskLoads[b] ?? 0) || (env.lastTaskAssignment[a] ?? '').localeCompare(env.lastTaskAssignment[b] ?? '') || group.members.indexOf(a) - group.members.indexOf(b))[0] ?? null;
}
export function assignTask(config: Config, c: Case, t: Task, a: Actor, env: Environment, rerun = false) {
    const id = taskAssignee(config, t, env, rerun ? t.assignee ?? undefined : undefined);
    t.assignee = id;
    t.failure = id ? null : 'Everyone in ' + (config.groups.find(g => g.id === t.group)?.name ?? 'the group') + ' is unavailable on ' + t.dueOn + ' or at their open-task limit.';
    t.assignedAt = id ? env.now : null;
    if (id) {
        t.autoAssignments = [...(t.autoAssignments ?? []), { user: id, at: env.now }];
        env.taskLoads[id] = (env.taskLoads[id] ?? 0) + 1;
        env.lastTaskAssignment[id] = env.now;
    }
    log(c, a, env, id ? 'task.assigned' : 'task.assignment_failed', t.name);
}
function chooseApprover(config: Config, group: Id, requester: Id, env: Environment, exclude?: Id): Id | null {
    const g = config.groups.find(x => x.id === group);
    if (!g)
        return null;
    let candidates = g.members.filter(id => id !== exclude && env.users.includes(id) && available(env, id, env.today));
    if (candidates.some(id => id !== requester))
        candidates = candidates.filter(id => id !== requester);
    return candidates.sort((a, b) => (env.pendingApprovals[a] ?? 0) - (env.pendingApprovals[b] ?? 0) || (env.lifetimeApprovals[a] ?? 0) - (env.lifetimeApprovals[b] ?? 0) || g.members.indexOf(a) - g.members.indexOf(b))[0] ?? null;
}
function resolveGroup(config: Config, def: StepDef, c: Case, env: Environment): {
    group: Id | null;
    viaDefault: string | null;
    unavailable: boolean;
} {
    if (def.type === 'person')
        return { group: null, viaDefault: null, unavailable: false };
    if (def.type === 'group')
        return { group: config.groups.find(g => g.id === def.target)?.id ?? null, viaDefault: null, unavailable: false };
    const routing = config.routings.find(x => x.id === def.target);
    const rows = (routing?.rows ?? []).filter(row => matches(row.rules, effectiveFacts(c))).sort((a, b) => specificity(b.rules) - specificity(a.rules) || (routing?.rows.indexOf(a) ?? 0) - (routing?.rows.indexOf(b) ?? 0));
    const row = rows[0];
    if (!row)
        return { group: null, viaDefault: null, unavailable: true };
    const g = config.groups.find(x => x.id === row.group);
    if (g?.members.some(id => env.users.includes(id) && available(env, id, env.today)))
        return { group: g.id, viaDefault: null, unavailable: false };
    const fallback = routing?.rows.find(x => specificity(x.rules) === 0);
    const fg = config.groups.find(x => x.id === fallback?.group);
    if (fg?.members.some(id => env.users.includes(id) && available(env, id, env.today)))
        return { group: fg.id, viaDefault: g?.name ?? 'Unavailable group', unavailable: false };
    return { group: g?.id ?? null, viaDefault: null, unavailable: true };
}
export function approvalPolicy(config: Config, cat: Catalogue, source: 'matched' | 'exception', send: boolean): Id | null {
    return cat.workflow ?? (source === 'exception' && (send || config.exceptions.always) ? config.exceptions.workflow : null);
}
function refreshApproval(item: Item) {
    if (!item.steps.length) {
        item.approval = 'none';
        return;
    }
    if (item.steps.some(s => s.status === 'rejected'))
        item.approval = 'rejected';
    else if (item.steps.every(s => s.status === 'approved'))
        item.approval = 'approved';
    else
        item.approval = 'pending';
}
function autoApprove(item: Item, c: Case, a: Actor, env: Environment) {
    for (const s of item.steps) {
        if (s.status !== 'pending')
            continue;
        if (item.mode === 'seq' && item.steps.some(x => item.steps.indexOf(x) < item.steps.indexOf(s) && x.status !== 'approved'))
            break;
        if (s.user === item.requester) {
            s.status = 'approved';
            s.by = s.user;
            s.byName = item.requesterName ?? env.userNames?.[s.user] ?? (a.id === s.user ? a.name : undefined);
            s.when = env.now;
            log(c, { ...a, id: s.user, name: s.byName ?? 'Requester' }, env, 'approval.auto_approved', item.name + ' · ' + s.label);
        }
    }
    refreshApproval(item);
}
export function equipmentDate(c: Case, item: Pick<Item, 'dueDay'>): string {
    const join = effectiveFacts(c).joinDate, day = item.dueDay ?? 1;
    if (day === 0) { if (!validDate(join)) fail('Choose a valid join date.'); return join; }
    const due = dayDate(join, day); if (!validDate(due)) fail('The equipment due date is outside the supported calendar.'); return due;
}
function validateEquipmentOverrides(config: Config, c: Case) {
    for (const [id, override] of Object.entries(c.equipmentOverrides ?? {})) {
        if (!config.catalogue.some(item => item.id === id) || override.group !== undefined && !config.groups.some(group => group.id === override.group) || override.method !== undefined && !['rr','manual'].includes(override.method) || override.due !== undefined && (!Number.isInteger(override.due) || override.due < -999 || override.due > 9999)) fail('Review the equipment assignment overrides.');
    }
}
export type EquipmentBulk = { ids: string[]; group?: string; method?: 'rr' | 'manual'; due?: number };
export function assignEquipment(config: Config, c: Case, item: Item, a: Actor, env: Environment) {
    const group = config.groups.find(group => group.id === item.team), due = equipmentDate(c, item);
    const candidates = (group?.members ?? []).filter(id => env.users.includes(id) && available(env, id, due) && (!group!.limit || (env.taskLoads[id] ?? 0) < group!.limit));
    candidates.sort((a, b) => (env.taskLoads[a] ?? 0) - (env.taskLoads[b] ?? 0) || group!.members.indexOf(a) - group!.members.indexOf(b));
    item.claim = candidates[0] ?? null;
    item.assignmentFailure = item.claim ? null : 'No eligible member is available on ' + due + ' within this team’s open-task limit.';
    if (item.claim) env.taskLoads[item.claim] = (env.taskLoads[item.claim] ?? 0) + 1;
    log(c, a, env, item.claim ? 'item.assigned' : 'item.assignment_failed', item.name);
}
export function manualEquipment(config: Config, c: Case, id: string, user: string | null, a: Actor, env: Environment, rr = false) {
    const request = currentReq(c), item = request?.items.find(item => item.id === id);
    if (c.state !== 'submitted' || !request || request.cancelledAt || request.handedAt || !item || !activeItem(item) || ['ready','handed'].includes(item.state)) fail('Choose an open approved equipment item.');
    if (!a.module && !inGroup(config, item.team, a.id)) fail('Only the fulfilling team or onboarding editors can assign this item.', 'forbidden');
    if (user && (!env.users.includes(user) || !inGroup(config, item.team, user))) fail('Choose an eligible member of the fulfilling team.');
    if (item.claim) env.taskLoads[item.claim] = Math.max(0, (env.taskLoads[item.claim] ?? 0) - 1);
    item.claim = null; item.assignmentFailure = null;
    if (rr) assignEquipment(config, c, item, a, env);
    else { item.claim = user; if (user) env.taskLoads[user] = (env.taskLoads[user] ?? 0) + 1; log(c, a, env, 'item.assigned', item.name + (user ? ' · ' + (env.userNames?.[user] ?? 'Team member') : ' · unassigned')); }
}
export function bulkEquipment(config: Config, c: Case, change: EquipmentBulk, a: Actor, env: Environment) {
    moduleActor(a);
    if (!change.ids.length || new Set(change.ids).size !== change.ids.length || change.group === undefined && change.method === undefined && change.due === undefined) fail('Choose items and at least one equipment change.');
    if (change.group !== undefined && !config.groups.some(group => group.id === change.group)) fail('Choose an existing assignment group.');
    if (change.method !== undefined && !['rr','manual'].includes(change.method)) fail('Choose Round robin or Manual.');
    if (change.due !== undefined && (!Number.isInteger(change.due) || change.due < -999 || change.due > 9999)) fail('Choose an equipment due day from -999 to 9999.');
    let changed = change.ids.length;
    if (c.state === 'pending') {
        if (change.ids.some(id => ![...c.selected, ...c.extras.map(item => item.catalogueId)].includes(id) || !config.catalogue.some(item => item.id === id))) fail('Choose only items selected on this case.');
        c.equipmentOverrides ??= {};
        for (const id of change.ids) c.equipmentOverrides[id] = { ...c.equipmentOverrides[id], ...(change.group !== undefined ? { group: change.group } : {}), ...(change.method !== undefined ? { method: change.method } : {}), ...(change.due !== undefined ? { due: change.due } : {}) };
    } else {
        const request = currentReq(c);
        if (c.state !== 'submitted' || !request || request.cancelledAt || request.handedAt) fail('This requisition is closed.');
        if (change.ids.some(id => !request.items.some(item => item.id === id))) fail('An equipment item is no longer available.');
        const targets = request.items.filter(item => change.ids.includes(item.id) && !item.removed && !['rejected','withdrawn'].includes(item.approval) && !['ready','handed'].includes(item.state));
        changed = targets.length; if (!changed) fail('No open equipment items match this change.');
        for (const item of targets) {
            if (change.due !== undefined) { item.dueDay = change.due; }
            if (change.method !== undefined) item.fulfilmentMethod = change.method;
            if (change.group !== undefined && change.group !== item.team) { if (item.claim) env.taskLoads[item.claim] = Math.max(0, (env.taskLoads[item.claim] ?? 0) - 1); item.team = change.group; item.claim = null; item.assignmentFailure = null; }
            if ((item.fulfilmentMethod ?? (config.v9ChecklistRevision ? 'rr' : 'manual')) === 'rr' && !item.claim && activeItem(item)) assignEquipment(config, c, item, a, env);
        }
    }
    log(c, a, env, 'equipment.bulk_updated', changed + ' items · ' + [change.group ? 'team ' + config.groups.find(group => group.id === change.group)!.name : '', change.method ?? '', change.due !== undefined ? 'due Day ' + change.due : ''].filter(Boolean).join(' · '));
}
export function addItem(config: Config, c: Case, r: Requisition, cat: Catalogue, source: 'matched' | 'exception', fromCase: boolean, reason: string, send: boolean, confirmedBy: Id | null, a: Actor, env: Environment): Item {
    if (!cat.active)
        fail('This catalogue item is retired.');
    if (r.handedAt || r.cancelledAt)
        fail('This requisition is closed.');
    if (r.items.some(i => !i.removed && i.catalogueId === cat.id))
        fail('This item is already requested.');
    if (source === 'exception' && !reason.trim())
        fail('A reason is required for every additional request.');
    const workflowId = approvalPolicy(config, cat, source, send), workflow = config.workflows.find(w => w.id === workflowId);
    if (workflowId && !workflow)
        fail('The approval workflow is unavailable. Update settings before requesting this item.');
    const item: Item = { id: env.id(), catalogueId: cat.id, name: cat.name, type: cat.type, team: cat.team, card: cat.card, source, fromCase, addedBy: a.id, addedByName: a.name, requesterName: a.name, confirmedByName: confirmedBy ? env.userNames?.[confirmedBy] ?? null : null, workflowName: workflow?.name ?? null, requester: a.id, confirmedBy, reason, workflowId, mode: workflow?.mode ?? 'seq', steps: [], approval: 'none', state: 'todo', stage: cat.card ? 'facility' : 'tech', claim: null, removed: false, retiredFlag: false, revokeNeeded: false };
    for (const def of workflow?.steps ?? []) {
        const resolved = resolveGroup(config, def, c, env), manual = def.type !== 'person' && def.method === 'manual';
        const shared = [...item.steps, ...r.items.flatMap(i => i.steps)].filter(s => s.group && s.group === resolved.group && s.user && env.users.includes(s.user) && !['withdrawn', 'unresolved'].includes(s.status));
        const existing = shared.find(s => s.status === 'pending') ?? shared[0];
        const id = def.type === 'person' ? (env.users.includes(def.target) ? def.target : null) : manual ? null : existing?.user ?? (resolved.group ? chooseApprover(config, resolved.group, a.id, env) : null);
        const status = def.type === 'person' && !id || def.type !== 'person' && !resolved.group ? 'unresolved' : 'pending';
        item.steps.push({ ...def, group: resolved.group, user: id, status, manual, fallback: !manual && !!resolved.group && !id, viaDefault: resolved.viaDefault, unavailable: resolved.unavailable, by: null, when: null, assignments: id ? [{ user: id, at: env.now }] : [] });
        if (id) {
            env.pendingApprovals[id] = (env.pendingApprovals[id] ?? 0) + 1;
            env.lifetimeApprovals[id] = (env.lifetimeApprovals[id] ?? 0) + 1;
        }
    }
    if (config.v9ChecklistRevision) {
        const override = c.equipmentOverrides?.[cat.id];
        item.team = override?.group ?? item.team; item.fulfilmentMethod = override?.method ?? 'rr'; item.dueDay = override?.due ?? -1;
    }
    r.items.push(item);
    autoApprove(item, c, a, env);
    if (item.fulfilmentMethod === 'rr' && activeItem(item)) assignEquipment(config, c, item, a, env);
    log(c, a, env, 'item.added', cat.name);
    return item;
}
const REQUIRED_FIELD_LABELS: Record<string, string> = { fullName: 'Full name', joinDate: 'Join date', title: 'Job title', department: 'Department', company: 'Company', supervisor: 'Supervisor', hiring: 'New hire or replacement', replacedEmployee: 'Employee being replaced' };
/** Shared required-field projection for validation and the onboarding preparation UI. */
export function nativeCaseFormValues(c: Case): Record<string,string> {
    const f = effectiveFacts(c);
    return { ...c.caseValues, name: f.fullName, empNo: f.employeeId, joinInput: f.joinDate, position: f.title, dept: f.department, company: f.company, group: f.businessGroup, supervisor: f.supervisor, ta: f.gbsTa, hireType: c.hiring, replacing: c.replacedEmployee, email: c.caseContactEmail ?? f.email, floor: c.floor, costCentre: f.costCentre, icNo: f.ic, passportNo: f.passport, notes: c.notes };
}
export function missingCaseFields(c: Case, config?: Config, hr = true): string[] {
    if (config?.v9CaseFields) return missingV9CaseFields(resolveV9CaseFields('onb', config.v9CaseFields), effectiveFacts(c), nativeCaseFormValues(c), hr).map(field => field.key);
    const f = effectiveFacts(c), missing = ['fullName', 'joinDate', 'title', 'department', 'company', 'supervisor'].filter(k => !f[k as keyof Facts]?.trim());
    if (!c.hiring)
        missing.push('hiring');
    if (c.hiring === 'replacement' && !c.replacedEmployee.trim())
        missing.push('replacedEmployee');
    return missing;
}
export function validateCase(config: Config, c: Case, hr = true) {
    if (c.checklistOverride && c.checklistOverride !== 'none' && !config.checklists.some(cl => cl.id === c.checklistOverride) && !(c.personnelStatus === 'Active' && c.confirmedChecklist?.id === c.checklistOverride))
        fail('The selected checklist is unavailable. Choose another checklist or No checklist.', 'invalid', ['checklistOverride']);
    const f = effectiveFacts(c), missing = missingCaseFields(c, config, hr);
    validateEquipmentOverrides(config, c);
    if (missing.length)
        fail('Complete: ' + missing.map(key => config.v9CaseFields?.find(field => field.key === key)?.label || REQUIRED_FIELD_LABELS[key] || key).join(', '), 'required', missing);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.joinDate) || Number.isNaN(Date.parse(f.joinDate)) || new Date(f.joinDate).toISOString().slice(0, 10) !== f.joinDate)
        fail('Enter a valid join date.', 'invalid', ['joinDate']);
    if (f.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email))
        fail('Enter a valid email address.', 'invalid', ['email']);
    const retained = (id: Id) => c.state === 'submitted' && !!currentReq(c)?.items.some(i => i.fromCase && !i.removed && i.catalogueId === id);
    for (const id of c.selected) {
        const cat = config.catalogue.find(x => x.id === id);
        if (!cat || !cat.active && !retained(id) || !matches(cat.rules, f))
            fail('A selected item no longer matches. Untick it before submitting.', 'invalid', ['selected']);
    }
    for (const extra of c.extras) {
        const cat = config.catalogue.find(x => x.id === extra.catalogueId);
        if (!cat || !cat.active && !retained(extra.catalogueId))
            fail('An additional item is unavailable. Remove it before submitting.', 'invalid', ['extras']);
    }
    if (c.extras.some(x => !x.reason.trim()))
        fail('A reason is required for every additional request.');
    if (new Set([...c.selected, ...c.extras.map(x => x.catalogueId)]).size !== c.selected.length + c.extras.length)
        fail('An item may only be requested once.');
}
export function submitCase(config: Config, c: Case, a: Actor, env: Environment) {
    moduleActor(a);
    if (c.state === 'cancelled')
        fail('Reopen the case before submitting.');
    if (c.state === 'submitted' && !c.reconcileNeeded)
        return;
    validateCase(config, c, a.hr);
    const chosen = matchChecklist(config, c).checklist;
    if (c.state === 'pending' && !chosen)
        fail('Choose an onboarding checklist before submitting.', 'required', ['checklistOverride']);
    if (c.state === 'submitted') {
        reconcileItems(config, c, a, env);
        if (c.reconcileNeeded) {
            const old = new Map(c.tasks.map(t => [t.id, t]));
            c.taskHistory.push(structuredClone(c.tasks));
            for (const task of c.tasks)
                if (task.by === 'group' && task.assignee && task.status !== 'done')
                    env.taskLoads[task.assignee] = Math.max(0, (env.taskLoads[task.assignee] ?? 0) - 1);
            c.tasks = (chosen?.tasks ?? []).map(t => {
                const previous = old.get(t.id), fresh = instantiate(t, chosen!, c);
                if (!previous)
                    return fresh;
                const retained = { ...fresh, status: previous.status, completedAt: previous.completedAt, completedBy: previous.completedBy, assignee: previous.group === t.group || previous.status === 'done' ? previous.assignee : null, assignedAt: previous.assignedAt, failure: previous.failure, autoAssignments: previous.autoAssignments ?? [] };
                if (retained.assignee && retained.status !== 'done')
                    env.taskLoads[retained.assignee] = (env.taskLoads[retained.assignee] ?? 0) + 1;
                return retained;
            });
            for (const task of c.tasks)
                if (task.by === 'group' && task.method === 'rr' && !task.assignee && task.status !== 'done')
                    assignTask(config, c, task, a, env);
            c.confirmedChecklist = chosen ? structuredClone(chosen) : null;
            if (config.v9ChecklistRevision) c.v9DefinitionRevision = config.v9ChecklistRevision;
            c.reconcileNeeded = false;
            log(c, a, env, 'case.reconfirmed');
        }
        return;
    }
    const r: Requisition = { id: env.id(), number: env.nextNumber(), createdAt: env.now, cancelledAt: null, handedAt: null, items: [], hrNote: c.notes, noteVersion: 1, noteAcks: {} };
    c.requisitions.push(r);
    c.tasks = (chosen?.tasks ?? []).map(t => instantiate(t, chosen!, c));
    c.confirmedChecklist = chosen ? structuredClone(chosen) : null;
    c.state = 'submitted';
    if (config.v9ChecklistRevision) c.v9DefinitionRevision = config.v9ChecklistRevision;
    c.submittedAt = env.now;
    c.submittedBy = a.id;
    c.reconcileNeeded = false;
    for (const t of c.tasks)
        if (t.by === 'group' && t.method === 'rr' && !t.assignee)
            assignTask(config, c, t, a, env);
    reconcileItems(config, c, a, env);
    log(c, a, env, 'case.submitted', r.number);
}
function instantiate(t: TaskDef, cl: Checklist, c: Case): Task {
    const join = effectiveFacts(c).joinDate;
    return { ...structuredClone(t), checklistId: cl.id, checklistName: cl.name, status: 'todo', assignee: null, failure: null, assignedAt: null, opensOn: t.opens === null ? null : dayDate(join, t.opens), dueOn: dayDate(join, t.due), completedAt: null, completedBy: null };
}
export function removeItem(config: Config, c: Case, item: Item, a: Actor, env: Environment, viaCase = false) {
    const r = currentReq(c);
    if (!r || r.handedAt || r.cancelledAt)
        fail('Items cannot be removed after handover.');
    if (viaCase) {
        moduleActor(a);
        if (!item.fromCase)
            fail('Case edits cannot remove items added by Group Tech.');
    }
    else {
        if (item.source === 'matched')
            fail('Rule-matched selections are managed on the case.');
        if (!(a.id === item.addedBy || config.exceptions.groups.some(g => member(config, g, a.id)) || a.hr && item.fromCase))
            fail('You cannot remove this item.', 'forbidden');
    }
    item.removed = true;
    item.revokeNeeded = ['ready', 'printed', 'handed'].includes(item.state);
    item.claim = null;
    for (const s of item.steps)
        if (['pending', 'unresolved'].includes(s.status))
            s.status = 'withdrawn';
    if (item.approval === 'pending')
        item.approval = 'withdrawn';
    if (item.fromCase) {
        c.selected = c.selected.filter(x => x !== item.catalogueId);
        c.extras = c.extras.filter(x => x.catalogueId !== item.catalogueId);
    }
    log(c, a, env, item.revokeNeeded ? 'item.removed_revoke_needed' : 'item.removed', item.name);
}
export function reconcileItems(config: Config, c: Case, a: Actor, env: Environment) {
    const r = currentReq(c);
    if (!r)
        return;
    const wanted = new Set([...c.selected, ...c.extras.map(x => x.catalogueId)]);
    for (const i of r.items.filter(i => i.fromCase && !i.removed && !wanted.has(i.catalogueId)))
        removeItem(config, c, i, a, env, true);
    for (const id of wanted)
        if (!r.items.some(i => !i.removed && i.catalogueId === id)) {
            const cat = config.catalogue.find(x => x.id === id);
            if (!cat)
                fail('A requested catalogue item is missing.');
            const extra = c.extras.find(x => x.catalogueId === id);
            addItem(config, c, r, cat, extra ? 'exception' : 'matched', true, extra?.reason ?? '', extra?.approval ?? false, null, a, env);
        }
    for (const item of r.items.filter(i => i.fromCase && !i.removed && i.source === 'exception')) {
        const extra = c.extras.find(x => x.catalogueId === item.catalogueId);
        if (extra && item.reason !== extra.reason) {
            item.reason = extra.reason;
            log(c, a, env, 'item.reason_updated', item.name);
        }
    }
    if (r.hrNote !== c.notes) {
        r.hrNote = c.notes;
        r.noteVersion++;
    }
}
export type CasePatch = Partial<Pick<Case, 'hiring' | 'replacedEmployee' | 'deviceType' | 'floor' | 'notes' | 'selected' | 'extras' | 'checklistOverride' | 'equipmentOverrides' | 'caseValues' | 'caseContactEmail'>> & {
    local?: Partial<Facts>;
};
export function saveCase(config: Config, c: Case, patch: CasePatch, a: Actor, env: Environment) {
    moduleActor(a);
    if (c.state === 'cancelled')
        fail('Reopen the case to edit it.');
    if (patch.caseValues !== undefined || patch.caseContactEmail !== undefined) {
        if (!config.v9CaseFields) fail('Configure the V9 case form before editing its values.');
        const fields = resolveV9CaseFields('onb', config.v9CaseFields);
        for (const [key,value] of Object.entries(patch.caseValues ?? {})) {
            const field = fields.find(field => field.key === key && field.custom);
            if (!field) fail('Choose an existing custom case field.');
            if (field.hrOnly && !a.hr) fail('Company HR access is required for this case field.', 'forbidden');
            try { validateV9CaseValue(field, value); } catch (error) { fail(error instanceof Error ? error.message : 'Review the case field.'); }
        }
        if (patch.caseContactEmail !== undefined && fields.find(field=>field.key==='email')?.hrOnly && !a.hr) fail('Company HR access is required for this case field.', 'forbidden');
        if (patch.caseContactEmail !== undefined && patch.caseContactEmail && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(patch.caseContactEmail)) fail('Enter a valid new hire email.');
        if (patch.caseValues !== undefined) c.caseValues = { ...c.caseValues, ...structuredClone(patch.caseValues) };
        if (patch.caseContactEmail !== undefined) c.caseContactEmail = patch.caseContactEmail;
    }
    const priorChecklist = JSON.stringify(matchChecklist(config, c).checklist);
    for (const [key, value] of Object.entries(patch.local ?? {})) {
        if (config.v9CaseFields && value !== effectiveFacts(c)[key as keyof Facts]) fail('This field comes from Personnel Management. Edit it there.');
        if (c.source[key as keyof Facts] !== undefined && value !== c.source[key as keyof Facts])
            fail('This field comes from Personnel Management. Edit it there.');
        if (['costCentre', 'ic', 'passport'].includes(key) && !a.hr)
            fail('HR access is required.', 'forbidden');
        c.local[key as keyof Facts] = value;
    }
    for (const key of ['hiring', 'replacedEmployee', 'deviceType', 'floor', 'notes', 'selected', 'extras', 'checklistOverride', 'equipmentOverrides'] as const)
        if (patch[key] !== undefined)
            (c as unknown as Record<string, unknown>)[key] = structuredClone(patch[key]);
    validateEquipmentOverrides(config, c);
    if (c.state === 'submitted') {
        if (priorChecklist !== JSON.stringify(matchChecklist(config, c).checklist))
            c.reconcileNeeded = true;
        validateCase(config, c, a.hr);
        reconcileItems(config, c, a, env);
    }
    log(c, a, env, 'case.saved');
}
export function cancelCase(c: Case, reason: string, a: Actor, env: Environment, note = '') {
    moduleActor(a);
    if (!reason.trim())
        fail('A cancellation reason is required.');
    if (c.state === 'cancelled')
        return;
    c.state = 'cancelled';
    c.cancelReason = reason;
    c.cancelNote = note;
    const r = currentReq(c);
    if (r) {
        r.cancelledAt = env.now;
        for (const i of r.items) {
            i.claim = null;
            for (const s of i.steps)
                if (['pending', 'unresolved'].includes(s.status))
                    s.status = 'withdrawn';
        }
    }
    log(c, a, env, 'case.cancelled', reason + (note ? ' · ' + note : ''));
}
export function reopenCase(c: Case, a: Actor, env: Environment) {
    moduleActor(a);
    if (c.state !== 'cancelled')
        fail('Only cancelled cases can be reopened.');
    c.state = 'pending';
    c.cancelReason = null;
    c.cancelNote = '';
    c.submittedAt = null;
    c.submittedBy = null;
    c.taskHistory.push(structuredClone(c.tasks));
    c.tasks = [];
    if (c.acknowledgement) {
        c.acknowledgementHistory.push(structuredClone(c.acknowledgement));
        c.acknowledgement = null;
    }
    log(c, a, env, 'case.reopened');
}
export function setTask(config: Config, c: Case, taskId: Id, status: Task['status'], a: Actor, env: Environment) {
    if (c.state !== 'submitted')
        fail('This case has no actionable tasks.');
    const t = c.tasks.find(t => t.id === taskId);
    if (!t)
        fail('Task not found.');
    if (t.assignee !== a.id)
        fail('Only the assigned person can update this task.', 'forbidden');
    if (t.documentTemplate && status === 'done')
        fail('Complete the linked document to finish this task.');
    if (t.by === 'joiner' && t.gate && status === 'done')
        fail('Complete the device acknowledgement form to finish this task.');
    if (t.opensOn && t.opensOn > env.today)
        fail('This task has not opened yet.');
    if (t.gate && !currentReq(c)?.handedAt)
        fail('Record the Day 1 handover first.');
    t.status = status;
    t.completedAt = status === 'done' ? env.now : null;
    t.completedBy = status === 'done' ? a.id : null;
    log(c, a, env, 'task.status', t.name + ' · ' + status);
}
export function manualTask(config: Config, c: Case, id: Id, user: Id | null, a: Actor, env: Environment, rr = false) {
    moduleActor(a);
    if (c.state !== 'submitted')
        fail('Submit this case first.');
    const t = c.tasks.find(t => t.id === id);
    if (!t || t.by !== 'group')
        fail('Choose a group task.');
    if (rr)
        assignTask(config, c, t, a, env, true);
    else {
        if (user)
            userAllowed(env, user);
        t.assignee = user;
        t.assignedAt = user ? env.now : null;
        t.failure = null;
        log(c, a, env, 'task.assigned', t.name);
    }
}
export const stepOpen = (i: Item, s: Approval) => i.approval === 'pending' && ['pending', 'unresolved'].includes(s.status) && (i.mode === 'par' || i.steps.slice(0, i.steps.indexOf(s)).every(x => x.status === 'approved'));
export function decide(config: Config, c: Case, itemIds: Id[], decision: 'approve' | 'reject', a: Actor, env: Environment) {
    const r = currentReq(c);
    if (c.state !== 'submitted' || !r || r.cancelledAt || r.handedAt)
        fail('This requisition is closed.');
    if (new Set(itemIds).size !== itemIds.length)
        fail('Choose each approval item only once.');
    const decisions: {
        item: Item;
        step: Approval;
    }[] = [];
    for (const id of itemIds) {
        const item = r.items.find(i => i.id === id && !i.removed);
        if (!item)
            fail('Requested item not found.');
        const s = item.steps.find(s => stepOpen(item, s) && (s.user === a.id || s.group && member(config, s.group, a.id)));
        if (!s || s.manual && !s.user || s.status === 'unresolved')
            fail('This approval is not assigned or actionable for you.', 'forbidden');
        decisions.push({ item, step: s });
    }
    if (!decisions.length)
        fail('Choose at least one approval.');
    for (const { item, step: s } of decisions) {
        s.status = decision === 'approve' ? 'approved' : 'rejected';
        s.by = a.id;
        s.byName = a.name;
        s.when = env.now;
        log(c, a, env, s.user && s.user !== a.id ? 'approval.on_behalf' : 'approval.decided', item.name + ' · ' + decision);
        refreshApproval(item);
        if (decision === 'approve')
            autoApprove(item, c, a, env);
        if (item.fulfilmentMethod === 'rr' && !item.claim && activeItem(item)) assignEquipment(config, c, item, a, env);
    }
}
export function assignApproval(config: Config, c: Case, itemId: Id, stepId: Id, user: Id | null, a: Actor, env: Environment) {
    const r = currentReq(c), item = r?.items.find(i => i.id === itemId), step = item?.steps.find(s => s.id === stepId);
    if (c.state !== 'submitted' || !r || r.handedAt || !item || !step || !stepOpen(item, step) || !step.group || !member(config, step.group, a.id))
        fail('This approval cannot be reassigned by you.', 'forbidden');
    const id = user ?? chooseApprover(config, step.group, item.requester, env, step.user ?? undefined);
    if (user && !member(config, step.group, user))
        fail('Choose a member of this approval group.');
    if (id)
        userAllowed(env, id);
    for (const i of r.items)
        for (const s of i.steps)
            if (!i.removed && s.group === step.group && s.status === 'pending') {
                s.user = id;
                if (id)
                    s.assignments.push({ user: id, at: env.now });
                s.manual = !id && s.method === 'manual';
                s.fallback = !id && s.method === 'rr';
                s.unavailable = !id;
                autoApprove(i, c, a, env);
                if (i.fulfilmentMethod === 'rr' && !i.claim && activeItem(i)) assignEquipment(config, c, i, a, env);
            }
    log(c, a, env, 'approval.assigned', item.name);
}
export function fulfil(config: Config, c: Case, itemId: Id, status: 'todo' | 'progress' | 'done', a: Actor, env: Environment) {
    const r = currentReq(c), i = r?.items.find(i => i.id === itemId);
    if (c.state !== 'submitted' || !r || r.handedAt || !i || !activeItem(i))
        fail('This item is not available for fulfilment.');
    if (!member(config, i.team, a.id))
        fail('Only the fulfilling team can work this item.', 'forbidden');
    if (i.fulfilmentMethod && ['ready','handed'].includes(i.state)) { if (status === 'done') return; fail('Completed equipment stays on its requisition.', 'conflict'); }
    if (i.claim && i.claim !== a.id)
        fail('A teammate has claimed this item.', 'conflict');
    if (i.claim && !['ready','handed'].includes(i.state)) env.taskLoads[i.claim] = Math.max(0, (env.taskLoads[i.claim] ?? 0) - 1);
    if (status === 'todo') {
        i.state = i.card && i.stage === 'tech' ? 'printed' : 'todo';
        i.claim = null;
    }
    else if (status === 'progress') {
        i.state = 'progress';
        i.claim = a.id;
        env.taskLoads[a.id] = (env.taskLoads[a.id] ?? 0) + 1;
    }
    else {
        i.claim = null;
        if (i.card && i.stage === 'facility') {
            i.state = 'printed';
            i.stage = 'tech';
            const tech = config.groups.find(g => g.id === config.techGroup);
            if (!tech)
                fail('Configure the Group Tech fulfilling group before printing access cards.');
            i.team = tech.id;
            if (i.fulfilmentMethod === 'rr') assignEquipment(config, c, i, a, env);
        }
        else {
            i.state = 'ready';
            if (i.fulfilmentMethod) i.claim = a.id;
        }
    }
    log(c, a, env, 'item.status', i.name + ' · ' + i.state);
}
export function handover(config: Config, c: Case, a: Actor, env: Environment) {
    const r = currentReq(c);
    if (!r || c.state !== 'submitted')
        fail('No active requisition.');
    if (!member(config, config.techGroup, a.id))
        fail('Group Tech records the handover.', 'forbidden');
    if (r.handedAt)
        return;
    if (r.items.some(i => !i.removed && i.approval === 'pending'))
        fail('Resolve pending approvals before handover.');
    if (r.items.filter(activeItem).some(i => i.state !== 'ready'))
        fail('Prepare every active item before handover.');
    r.handedAt = env.now;
    for (const i of r.items.filter(activeItem))
        i.state = 'handed';
    log(c, a, env, 'requisition.handed', r.number);
}
export function blankCase(id: Id, number: string, draftId: Id, source: Partial<Facts>, env: Environment): Case {
    return { version: 1, id, number, sourceDraftId: draftId, employmentId: null, personId: null, personnelStatus: 'Draft', syncedAt: env.now, source, sourceVersion: env.now, local: {}, state: 'pending', submittedAt: null, submittedBy: null, cancelReason: null, hiring: '', replacedEmployee: '', deviceType: '', floor: '', notes: '', selected: [], extras: [], checklistOverride: null, confirmedChecklist: null, reconcileNeeded: false, tasks: [], taskHistory: [], requisitions: [], history: [], acknowledgementHistory: [], acknowledgement: null };
}
export function defaultConfig(owner: Id): Config {
    return { version: 1, groups: [{ id: 'people-gbs', name: 'People GBS', members: owner ? [owner] : [], limit: 8 }, { id: 'group-tech', name: 'Group Tech', members: [], limit: 8 }, { id: 'facility', name: 'Facility', members: [], limit: 4 }, { id: 'tech-bp', name: 'Tech BP', members: [], limit: 8 }],
        workflows: [{ id: 'standard', name: 'Standard approval', mode: 'seq', steps: [{ id: 'tech-approval', label: 'Tech BP', type: 'group', target: 'tech-bp', method: 'rr' }] }],
        routings: [], checklists: [{ id: 'fallback', name: 'General onboarding', owner, createdAt: '1970-01-01T00:00:00.000Z', rules: {}, tasks: [] }], catalogue: [], access: { onboarding: owner ? [owner] : [], offboarding: [] }, countEquipment: true, techGroup: 'group-tech', exceptions: { groups: ['group-tech'], workflow: 'standard', always: false, remindDays: 3, confirmingGroup: 'tech-bp' }, recentActiveDays: 30 };
}
export function validateConfig(config: Config) {
    if (config.version !== 1)
        fail('Unsupported configuration version.');
    if (!config.workflows.length || !config.checklists.length || !config.checklists.some(c => !specificity(c.rules)))
        fail('Keep at least one workflow, checklist and fallback checklist.');
    for (const list of [config.groups, config.workflows, config.routings, config.checklists, config.catalogue])
        if (new Set(list.map(x => x.id)).size !== list.length)
            fail('Definition identifiers must be unique.');
    const groups = new Set(config.groups.map(g => g.id)), flows = new Set(config.workflows.map(w => w.id)), routes = new Set(config.routings.map(r => r.id));
    if ([...(config.access.joinerViewGroups??[]),...(config.access.recordGroups??[]),...Object.keys(config.access.joinerSections??{})].some(id=>!groups.has(id)))fail('Choose existing groups for page and request-record access.');
    const allowedRules = (rules: Rules, allowed: string[], single = false) => {
        for (const [key, values] of Object.entries(rules))
            if (values?.length && (!allowed.includes(key) || single && values.length > 1))
                fail('A matching rule uses an unsupported field or multiple routing values.');
    };
    for (const item of config.catalogue)
        allowedRules(item.rules, ['businessGroup', 'company', 'department', 'title']);
    for (const list of config.checklists)
        allowedRules(list.rules, ['businessGroup', 'company', 'department', 'grade', 'employmentType']);
    for (const route of config.routings)
        for (const row of route.rows)
            allowedRules(row.rules, ['businessGroup', 'company', 'department', 'title'], true);
    for (const g of config.groups)
        if (!g.name.trim() || !Number.isInteger(g.limit) || g.limit < 0 || new Set(g.members).size !== g.members.length)
            fail('Choose a group name, nonnegative task limit (zero means unlimited) and distinct members.');
    for (const list of [...config.checklists.map(c => c.tasks), ...config.workflows.map(w => w.steps), ...config.routings.map(r => r.rows)])
        if (new Set(list.map(x => x.id)).size !== list.length)
            fail('Task, step and routing-row identifiers must be unique within each definition.');
    for (const w of config.workflows) {
        if (!w.name.trim() || !w.steps.length)
            fail('Workflows need a name and at least one step.');
        for (const s of w.steps)
            if (!s.label.trim() || s.type === 'group' && !!s.target && !groups.has(s.target) || s.type === 'routing' && !routes.has(s.target))
                fail('An approval step has a missing group or routing.');
    }
    for (const r of config.routings)
        for (const row of r.rows)
            if (row.group && !groups.has(row.group))
                fail('A routing group is missing.');
    for (const cat of config.catalogue)
        if (!cat.name.trim() || !!cat.team && !groups.has(cat.team) || cat.workflow && !flows.has(cat.workflow))
            fail('A catalogue item has a missing name, team or approval workflow.');
    for (const id of [config.techGroup, config.exceptions.confirmingGroup, ...config.exceptions.groups])
        if (id && !groups.has(id))
            fail('An onboarding setting refers to a missing group.');
    if (config.exceptions.workflow && !flows.has(config.exceptions.workflow))
        fail('The exception workflow is missing.');
    if (config.exceptions.remindDays < 0 || !Number.isInteger(config.exceptions.remindDays) || config.recentActiveDays < 1)
        fail('Choose a valid reminder and recent-joiner window.');
    for (const c of config.checklists)
        for (const t of c.tasks) {
            if (!t.name.trim() || t.by === 'group' && t.group && !groups.has(t.group))
                fail('A task needs a name and a valid assignment group.');
            if (!Number.isInteger(t.due) || t.due === 0 || t.opens !== null && (!Number.isInteger(t.opens) || t.opens === 0))
                fail('Task Day values must be whole numbers; Day 0 is not used.');
            if (t.opens !== null && t.opens > t.due)
                fail('A task must open on or before its due day.');
        }
}
export function retryApprovals(config: Config, c: Case, itemId: Id, a: Actor, env: Environment) {
    moduleActor(a);
    const r = currentReq(c), item = r?.items.find(i => i.id === itemId);
    if (c.state !== 'submitted' || !r || r.handedAt || !item || item.removed || item.approval === 'rejected')
        fail('This approval cannot be rerouted.');
    const workflow = config.workflows.find(w => w.id === item.workflowId);
    if (!workflow)
        fail('Configure the missing workflow before retrying.');
    for (const step of item.steps.filter(s => s.status === 'pending' || s.status === 'unresolved')) {
        const def = workflow.steps.find(s => s.id === step.id);
        if (!def)
            continue;
        const resolved = resolveGroup(config, def, c, env), manual = def.type !== 'person' && def.method === 'manual';
        const shared = r.items.flatMap(i => i.steps).filter(s => s !== step && s.group === resolved.group && s.user && env.users.includes(s.user) && s.status !== 'withdrawn');
        const existing = shared.find(s => s.status === 'pending') ?? shared[0];
        const user = def.type === 'person' ? (env.users.includes(def.target) ? def.target : null) : manual ? null : existing?.user ?? (resolved.group ? chooseApprover(config, resolved.group, item.requester, env) : null);
        Object.assign(step, def, resolved, { user, manual, fallback: !manual && !!resolved.group && !user, status: def.type === 'person' && !user || def.type !== 'person' && !resolved.group ? 'unresolved' : 'pending' });
        if (user)
            step.assignments.push({ user, at: env.now });
    }
    autoApprove(item, c, a, env);
    log(c, a, env, 'approval.routing_retried', item.name);
}
