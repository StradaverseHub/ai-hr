/**
 * Attendance v3 contract. The v1/v2 validator and Leave vocabulary retain their legacy semantics.
 *
 * This leaf cannot authorize a request, write a decision, or grant an Attendance effect capability.
 * The server owner resolves through the root-authorized Personnel identity reader. Persistence, RLS,
 * live decision authority and ADR-0121 final-write proof are integrated in migration0570.
 * Leave's ApprovalLevel/alternates vocabulary is not reinterpreted here.
 */
import { attendanceLevelName, validateAttendanceWorkflow, type AttendanceWorkflowInput } from './attendance-workflow';

export const ATTENDANCE_V3_LIMITS = { levels: 10, participantsPerLevel: 20, participantsPerWorkflow: 100, superiorDepth: 5 } as const;
export const ATTENDANCE_LEVEL_MODES = ['sequential', 'any_one'] as const;
export type AttendanceLevelMode = typeof ATTENDANCE_LEVEL_MODES[number];
export type AttendanceV3Source =
    | { kind: 'direct_manager'; depth: number }
    | { kind: 'specific_employee'; employmentIds: string[] };
export type AttendanceV3Level = {
    name: string;
    mode: AttendanceLevelMode;
    source: AttendanceV3Source;
    /** Explicit fallback for an unresolved superior, never a silently substituted named participant. */
    hrAlternative: boolean;
};
export type AttendanceV3Route = { routingVersion: 3; stages: AttendanceV3Level[] };
export const ATTENDANCE_LEVEL_PROBLEMS = [
    'invalid_route', 'level_count', 'invalid_level', 'invalid_mode', 'invalid_source', 'invalid_depth',
    'selection_required', 'invalid_employee', 'too_many_participants', 'duplicate_employment',
    'duplicate_person', 'duplicate_login', 'missing_superior', 'ambiguous_superior', 'cycle',
    'inactive_superior', 'outside_company_scope', 'missing_or_ambiguous_login', 'missing_person',
    'employee_unavailable', 'self_approval', 'hr_unavailable', 'invalid_identity', 'invalid_evidence',
    'already_complete', 'not_next_participant', 'hr_handoff_required',
] as const;
export type AttendanceLevelProblemCode = typeof ATTENDANCE_LEVEL_PROBLEMS[number];
export type AttendanceLevelProblem = {
    code: AttendanceLevelProblemCode;
    /** Zero-based; null means the route rather than a particular level is invalid. */
    levelIndex: number | null;
    participantIndex?: number;
};
export class AttendanceLevelError extends Error {
    constructor(public readonly problem: AttendanceLevelProblem) {
        // Never include SQL, raw submitted values, names or arbitrary resolver/driver messages.
        super(problem.code);
        this.name = 'AttendanceLevelError';
    }
}
function fail(code: AttendanceLevelProblemCode, levelIndex: number | null, participantIndex?: number): never {
    throw new AttendanceLevelError({ code, levelIndex, ...(participantIndex == null ? {} : { participantIndex }) });
}
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const object = (value: unknown): value is Record<string, unknown> => value != null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
const identityKey = (value: string) => value.toLowerCase();

/** Exact posted route parsing: no dropping unknown actors, deduping, coercion or truncation. */
export function parseAttendanceV3Route(raw: unknown): AttendanceV3Route {
    if (!object(raw) || !exactKeys(raw, ['routingVersion', 'stages']) || raw.routingVersion !== 3 || !Array.isArray(raw.stages)) fail('invalid_route', null);
    if (raw.stages.length < 1 || raw.stages.length > ATTENDANCE_V3_LIMITS.levels) fail('level_count', null);
    const configuredEmployments = new Set<string>();
    let total = 0;
    const stages = raw.stages.map((value: unknown, levelIndex: number): AttendanceV3Level => {
        if (!object(value) || !exactKeys(value, ['name', 'mode', 'source', 'hrAlternative']) || typeof value.name !== 'string' || value.name.length > 100 || typeof value.hrAlternative !== 'boolean') fail('invalid_level', levelIndex);
        if (value.mode !== 'sequential' && value.mode !== 'any_one') fail('invalid_mode', levelIndex);
        if (!object(value.source)) fail('invalid_source', levelIndex);
        let source: AttendanceV3Source;
        if (value.source.kind === 'direct_manager') {
            if (!exactKeys(value.source, ['kind', 'depth'])) fail('invalid_source', levelIndex);
            if (typeof value.source.depth !== 'number' || !Number.isInteger(value.source.depth) || value.source.depth < 1 || value.source.depth > ATTENDANCE_V3_LIMITS.superiorDepth) fail('invalid_depth', levelIndex);
            source = { kind: 'direct_manager', depth: value.source.depth };
            total++;
        } else if (value.source.kind === 'specific_employee') {
            if (!exactKeys(value.source, ['kind', 'employmentIds'])) fail('invalid_source', levelIndex);
            // A selected employee is required, unlike a dynamic superior with an explicit HR fallback.
            if (value.hrAlternative) fail('invalid_source', levelIndex);
            if (!Array.isArray(value.source.employmentIds) || !value.source.employmentIds.length) fail('selection_required', levelIndex);
            if (value.source.employmentIds.length > ATTENDANCE_V3_LIMITS.participantsPerLevel) fail('too_many_participants', levelIndex);
            const employmentIds = value.source.employmentIds.map((id: unknown, participantIndex: number) => {
                if (!uuid(id)) fail('invalid_employee', levelIndex, participantIndex);
                const key = identityKey(id);
                if (configuredEmployments.has(key)) fail('duplicate_employment', levelIndex, participantIndex);
                configuredEmployments.add(key);
                return key;
            });
            source = { kind: 'specific_employee', employmentIds };
            total += employmentIds.length;
        } else fail('invalid_source', levelIndex);
        if (total > ATTENDANCE_V3_LIMITS.participantsPerWorkflow) fail('too_many_participants', levelIndex);
        return { name: attendanceLevelName(levelIndex), mode: value.mode, source, hrAlternative: value.hrAlternative };
    });
    return { routingVersion: 3, stages };
}

/** Canonical Personnel identities; the port owns live lifecycle, tenant, scope and login checks. */
export type AttendanceV3Identity = { employmentId: string; personId: string; userId: string; name: string };
export type AttendanceIdentityResult = { ok: true; identity: AttendanceV3Identity } | { ok: false; code: AttendanceLevelProblemCode };
export type AttendanceV3Resolver = {
    /** Always measured from the applicant, never the previous approval level or participant. */
    superior: (depth: number) => Promise<AttendanceIdentityResult>;
    selectedEmployee: (employmentId: string) => Promise<AttendanceIdentityResult>;
    /** Same scoped, non-self HR eligibility owner as legacy Attendance; no synthetic employee. */
    hasHrAlternative: () => Promise<boolean>;
};
export type AttendanceV3Participant = AttendanceV3Identity & {
    slot: string;
    kind: 'direct_manager' | 'specific_employee';
    hierarchyDepth?: number;
};
export type AttendanceV3FrozenLevel = {
    name: string;
    mode: AttendanceLevelMode;
    source: AttendanceV3Source;
    approvers: AttendanceV3Participant[];
    /** A role alternative remains explicit. It does not become a named participant or a new role. */
    hrAlternative: boolean;
};
export type AttendanceV3FrozenRoute = { routingVersion: 3; stages: AttendanceV3FrozenLevel[] };

/**
 * Shared resolution algorithm for activation/preview/submission contract comparisons.
 * It consumes authorized identity facts, not a client-provided principal map. No ambient I/O is used.
 */
export async function resolveAttendanceV3Route(raw: unknown, applicant: AttendanceV3Identity, resolver: AttendanceV3Resolver): Promise<AttendanceV3FrozenRoute> {
    const route = parseAttendanceV3Route(raw);
    const seenEmployments = new Set([identityKey(applicant.employmentId)]);
    const seenPeople = new Set([identityKey(applicant.personId)]);
    const seenUsers = new Set([identityKey(applicant.userId)]);
    if (![applicant.employmentId, applicant.personId, applicant.userId].every(uuid)) fail('invalid_identity', null);
    let hrAvailable: boolean | undefined;
    const readIdentity = async (read: () => Promise<AttendanceIdentityResult>, levelIndex: number, participantIndex: number): Promise<AttendanceIdentityResult> => {
        try {
            const result = await read();
            if (result.ok) return result;
            if (!(ATTENDANCE_LEVEL_PROBLEMS as readonly string[]).includes(result.code)) fail('employee_unavailable', levelIndex, participantIndex);
            return result;
        } catch { fail('employee_unavailable', levelIndex, participantIndex); }
    };
    const readHr = async (levelIndex: number) => {
        try { return await resolver.hasHrAlternative() === true; }
        catch { fail('hr_unavailable', levelIndex); }
    };
    const stages: AttendanceV3FrozenLevel[] = [];
    for (const [levelIndex, level] of route.stages.entries()) {
        const approvers: AttendanceV3Participant[] = [];
        const source = level.source;
        let hrAlternative = false;
        const resolve = async (participantIndex: number, result: AttendanceIdentityResult, expectedEmploymentId?: string) => {
            if (!result.ok) {
                // Only a configured superior fallback can recover a failed dynamic resolution.
                if (source.kind === 'direct_manager' && level.hrAlternative) {
                    hrAvailable ??= await readHr(levelIndex);
                    if (hrAvailable) { hrAlternative = true; return; }
                }
                fail(result.code, levelIndex, participantIndex);
            }
            const actor = result.identity;
            if (![actor.employmentId, actor.personId, actor.userId].every(uuid) || typeof actor.name !== 'string' || !actor.name.trim() || (expectedEmploymentId && identityKey(actor.employmentId) !== expectedEmploymentId)) fail('invalid_identity', levelIndex, participantIndex);
            const employmentId = identityKey(actor.employmentId), personId = identityKey(actor.personId), userId = identityKey(actor.userId);
            if (employmentId === identityKey(applicant.employmentId) || personId === identityKey(applicant.personId) || userId === identityKey(applicant.userId)) fail('self_approval', levelIndex, participantIndex);
            if (seenEmployments.has(employmentId)) fail('duplicate_employment', levelIndex, participantIndex);
            if (seenPeople.has(personId)) fail('duplicate_person', levelIndex, participantIndex);
            if (seenUsers.has(userId)) fail('duplicate_login', levelIndex, participantIndex);
            seenEmployments.add(employmentId); seenPeople.add(personId); seenUsers.add(userId);
            approvers.push({ employmentId, personId, userId, name: actor.name, slot: `${levelIndex}:${participantIndex}`, kind: source.kind, ...(source.kind === 'direct_manager' ? { hierarchyDepth: source.depth } : {}) });
        };
        if (source.kind === 'direct_manager') {
            await resolve(0, await readIdentity(() => resolver.superior(source.depth), levelIndex, 0));
            if (level.hrAlternative && !hrAlternative) {
                hrAvailable ??= await readHr(levelIndex);
                hrAlternative = hrAvailable;
            }
        } else {
            for (const [participantIndex, employmentId] of source.employmentIds.entries()) await resolve(participantIndex, await readIdentity(() => resolver.selectedEmployee(employmentId), levelIndex, participantIndex), employmentId);
        }
        stages.push({ name: level.name, mode: level.mode, source, approvers, hrAlternative });
    }
    return { routingVersion: 3, stages };
}

export type AttendanceV3ParticipantDecision = {
    slot: string;
    decision: 'approved' | 'rejected';
    actualPersonId: string;
    actualUserId: string;
};
export type AttendanceV3LevelProgress = { complete: boolean; rejected: boolean; pendingSlots: string[] };
/**
 * Projection only: the transaction owner must lock the request, check the actor against the
 * frozen slot plus live authority, insert immutable evidence, and create exactly one stage-completion
 * decision when complete. This function is NOT a database capability or a final-effect authorization.
 */
export function attendanceV3LevelProgress(level: AttendanceV3FrozenLevel, evidence: readonly AttendanceV3ParticipantDecision[], levelIndex: number): AttendanceV3LevelProgress {
    const slots = level.approvers.map(participant => participant.slot);
    const alternativeSlot = `${levelIndex}:hr`;
    const eligibleSlots = level.hrAlternative ? [...slots, alternativeSlot] : slots;
    if (!slots.length && !level.hrAlternative) fail('invalid_evidence', levelIndex);
    const seenSlots = new Set<string>(), seenPeople = new Set<string>(), seenUsers = new Set<string>();
    let rejected = false;
    for (const [index, record] of evidence.entries()) {
        if (!eligibleSlots.includes(record.slot) || seenSlots.has(record.slot) || !uuid(record.actualPersonId) || !uuid(record.actualUserId) || (record.decision !== 'approved' && record.decision !== 'rejected') || rejected || (level.mode === 'any_one' && index > 0)) fail('invalid_evidence', levelIndex);
        if (level.mode === 'sequential' && record.slot !== alternativeSlot && record.slot !== slots[index]) fail('invalid_evidence', levelIndex);
        const personId = identityKey(record.actualPersonId), userId = identityKey(record.actualUserId);
        if (seenPeople.has(personId) || seenUsers.has(userId)) fail('invalid_evidence', levelIndex);
        seenSlots.add(record.slot); seenPeople.add(personId); seenUsers.add(userId);
        if (record.slot === alternativeSlot && (evidence.length !== 1 || slots.length > 1)) fail('invalid_evidence', levelIndex);
        rejected = record.decision === 'rejected';
    }
    const alternativeCompleted = level.hrAlternative && evidence.some(record => record.slot === alternativeSlot);
    const complete = rejected || alternativeCompleted || (level.mode === 'any_one' ? evidence.length > 0 : slots.length > 0 && evidence.length === slots.length);
    const outstanding = complete ? [] : slots.filter(slot => !seenSlots.has(slot));
    const pendingSlots = level.mode === 'sequential' ? outstanding.slice(0, 1) : outstanding;
    return { complete, rejected, pendingSlots: !complete && level.hrAlternative ? [...pendingSlots, alternativeSlot] : pendingSlots };
}

/** A recorded override refers to one frozen slot, never a replacement of the whole original route. */
export type AttendanceV3SlotReassignment = {
    slot: string;
    previous: AttendanceV3Participant;
    replacement: AttendanceV3Participant;
    reason: string;
};
/**
 * Projection contract for the reasoned reassignment owner. It deliberately cannot assign HR
 * as a generic substitute for a selected group: the owner must resolve one authorized replacement
 * identity for this outstanding slot, retain this transition, and retain the original frozen route.
 * Authorization and concurrent outstanding-slot checks belong in that owner's locked transaction.
 */
export function projectAttendanceV3SlotReassignment(
    route: AttendanceV3FrozenRoute,
    levelIndex: number,
    evidence: readonly AttendanceV3ParticipantDecision[],
    slot: string,
    replacement: AttendanceV3Identity,
    applicant: AttendanceV3Identity,
    reason: string,
): { stages: AttendanceV3FrozenLevel[]; reassignment: AttendanceV3SlotReassignment } {
    const level = route.stages[levelIndex];
    if (!level || !reason.trim() || reason.trim().length > 500) fail('invalid_level', levelIndex);
    const progress = attendanceV3LevelProgress(level, evidence, levelIndex);
    if (progress.complete) fail('already_complete', levelIndex);
    const previous = level.approvers.find(participant => participant.slot === slot);
    // Sequential future slots may be reassigned too, but any completed slot is immutable.
    if (!previous || evidence.some(record => record.slot === slot)) fail('not_next_participant', levelIndex);
    if (![replacement.employmentId, replacement.personId, replacement.userId].every(uuid) || !replacement.name?.trim()) fail('invalid_identity', levelIndex);
    const next = { ...replacement, employmentId: identityKey(replacement.employmentId), personId: identityKey(replacement.personId), userId: identityKey(replacement.userId), slot, kind: 'specific_employee' as const };
    if (next.employmentId === identityKey(applicant.employmentId) || next.personId === identityKey(applicant.personId) || next.userId === identityKey(applicant.userId)) fail('self_approval', levelIndex);
    for (const participant of route.stages.flatMap(stage => stage.approvers).filter(participant => participant.slot !== slot)) {
        if (participant.employmentId === next.employmentId) fail('duplicate_employment', levelIndex);
        if (participant.personId === next.personId) fail('duplicate_person', levelIndex);
        if (participant.userId === next.userId) fail('duplicate_login', levelIndex);
    }
    // Completed decisions may be by a delegate/admin rather than the frozen assigned identity.
    if (evidence.some(record => identityKey(record.actualPersonId) === next.personId || identityKey(record.actualUserId) === next.userId)) fail('invalid_evidence', levelIndex);
    const stages = route.stages.map((stage, index) => index === levelIndex ? { ...stage, approvers: stage.approvers.map(participant => participant.slot === slot ? next : { ...participant }) } : stage);
    return { stages, reassignment: { slot, previous: { ...previous }, replacement: { ...next }, reason: reason.trim() } };
}

/** Explicit v3 input; legacy callers retain their original v1/v2 stage type. */
export type AttendanceV3WorkflowInput = Omit<AttendanceWorkflowInput, 'routingVersion' | 'stages'> & AttendanceV3Route;
export type AnyAttendanceWorkflowInput = AttendanceWorkflowInput | AttendanceV3WorkflowInput;
export function validateAnyAttendanceWorkflow(raw: unknown): AnyAttendanceWorkflowInput {
    if (!object(raw) || raw.routingVersion !== 3) return validateAttendanceWorkflow(raw as AttendanceWorkflowInput);
    // The existing owner validates common assignment and metadata rules; no v3 participant is passed
    // through Leave sanitization or silently converted into an alternate.
    const common = validateAttendanceWorkflow({ ...raw, routingVersion: 2, stages: [{ name: 'Level 1', level: { kind: 'direct_manager', employmentId: null, alternates: [] } }] } as AttendanceWorkflowInput);
    return { ...common, ...parseAttendanceV3Route({ routingVersion: 3, stages: raw.stages }) };
}

/** Finite, translated business guidance; never render raw driver/SQL errors or problem codes. */
export function attendanceLevelProblemMessageKey(problem: AttendanceLevelProblem): 'selectionRequired' | 'participantLimit' | 'depthRequired' | 'differentPeople' | 'superiorUnavailable' | 'correctLevel' | 'calculationHandoff' {
    if (problem.code === 'hr_handoff_required') return 'calculationHandoff';
    if (problem.code === 'selection_required') return 'selectionRequired';
    if (problem.code === 'too_many_participants') return 'participantLimit';
    if (problem.code === 'invalid_depth') return 'depthRequired';
    if (['duplicate_employment', 'duplicate_person', 'duplicate_login', 'self_approval'].includes(problem.code)) return 'differentPeople';
    if (['missing_superior', 'ambiguous_superior', 'cycle', 'inactive_superior'].includes(problem.code)) return 'superiorUnavailable';
    return 'correctLevel';
}

/** Finite transport for submission screens that otherwise accept only fixed error-message keys. */
export function attendanceLevelProblemToken(problem: AttendanceLevelProblem): string {
    return `${problem.code}:${problem.levelIndex ?? 'route'}:${problem.participantIndex ?? 'level'}`;
}
export function parseAttendanceLevelProblemToken(raw: unknown): AttendanceLevelProblem | null {
    if (typeof raw !== 'string' || raw.length > 100) return null;
    const [code, level, participant, extra] = raw.split(':');
    if (extra !== undefined || !(ATTENDANCE_LEVEL_PROBLEMS as readonly string[]).includes(code) || !(level === 'route' || /^[0-9]$/.test(level ?? '')) || !(participant === 'level' || /^(?:[0-9]|1[0-9])$/.test(participant ?? ''))) return null;
    return { code: code as AttendanceLevelProblemCode, levelIndex: level === 'route' ? null : Number(level), ...(participant === 'level' ? {} : { participantIndex: Number(participant) }) };
}
