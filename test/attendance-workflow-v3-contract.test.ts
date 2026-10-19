import { describe, expect, it, vi } from 'vitest';
import { validateAttendanceWorkflow } from '../lib/attendance-workflow';
import {
    AttendanceLevelError, attendanceV3LevelProgress, parseAttendanceV3Route, resolveAttendanceV3Route, projectAttendanceV3SlotReassignment, attendanceLevelProblemToken, parseAttendanceLevelProblemToken, validateAnyAttendanceWorkflow,
    type AttendanceV3Identity, type AttendanceV3Level, type AttendanceV3ParticipantDecision, type AttendanceV3Resolver,
} from '../lib/attendance-workflow-v3';
const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const identity = (n: number): AttendanceV3Identity => ({ employmentId: id(n), personId: id(n + 1000), userId: id(n + 2000), name: `Fictional ${n}` });
const level = (ids = [id(1), id(2), id(3)], mode: 'sequential' | 'any_one' = 'sequential'): AttendanceV3Level => ({ name: 'Untrusted label', mode, source: { kind: 'specific_employee', employmentIds: ids }, hrAlternative: false });
const superior = (depth: number, hrAlternative = false): AttendanceV3Level => ({ name: '', mode: 'sequential', source: { kind: 'direct_manager', depth }, hrAlternative });
const route = (stages = [level()]) => ({ routingVersion: 3, stages });
const resolver = (): AttendanceV3Resolver => ({
    superior: vi.fn(async (depth: number) => ({ ok: true as const, identity: identity(20 + depth) })),
    selectedEmployee: vi.fn(async (employmentId: string) => ({ ok: true as const, identity: identity(Number(employmentId.slice(-12))) })),
    hasHrAlternative: vi.fn(async () => true),
});
function problem(work: () => unknown, code: string, levelIndex: number | null) {
    try { work(); throw new Error('Expected refusal'); }
    catch (error) {
        expect(error).toBeInstanceOf(AttendanceLevelError);
        expect((error as AttendanceLevelError).problem).toMatchObject({ code, levelIndex });
    }
}
describe('Attendance v3 exact posted-route boundary', () => {
    it('keeps independent modes, caller order and explicit depth rather than stage ordinal', () => {
        const input = route([level([id(3), id(1)], 'any_one'), superior(5), level([id(2)])]);
        expect(parseAttendanceV3Route(input)).toEqual({ routingVersion: 3, stages: [
            { ...input.stages[0], name: 'Level 1' }, { ...input.stages[1], name: 'Level 2' }, { ...input.stages[2], name: 'Level 3' },
        ] });
        expect(input.stages[0].name).toBe('Untrusted label');
    });
    it('retains the legacy-only validator while v3 uses its explicit new boundary', () => {
        expect(() => validateAttendanceWorkflow({ companyId: id(90), routingVersion: 3 as never, code: 'V3', name: 'Pending source', applicationType: 'irregularity', priority: 100, criteria: {}, stages: [{ name: 'Level 1', level: { kind: 'direct_manager', employmentId: null, alternates: [] } }], active: false })).toThrow();
    });
    it.each([null, {}, { routingVersion: 2, stages: [level()] }, { ...route(), tenantId: id(90) }, { ...route(), stages: '[]' }])('refuses malformed route shape without coercion', raw => problem(() => parseAttendanceV3Route(raw), 'invalid_route', null));
    it('refuses zero or eleven levels and accepts exactly ten', () => {
        problem(() => parseAttendanceV3Route(route([])), 'level_count', null);
        problem(() => parseAttendanceV3Route(route(Array.from({ length: 11 }, () => superior(1)))), 'level_count', null);
        expect(parseAttendanceV3Route(route(Array.from({ length: 10 }, () => superior(1)))).stages).toHaveLength(10);
    });
    it.each([0, 6, 1.5, '2', null])('refuses noncanonical depth %s', depth => problem(() => parseAttendanceV3Route(route([superior(depth as number)])), 'invalid_depth', 0));
    it.each(['invented', 'Sequential', null])('refuses unsupported mode', mode => problem(() => parseAttendanceV3Route(route([{ ...level(), mode: mode as never }])), 'invalid_mode', 0));
    it('never sanitizes away unknown participants, source properties or missing choices', () => {
        problem(() => parseAttendanceV3Route(route([level([])])), 'selection_required', 0);
        problem(() => parseAttendanceV3Route(route([level(['not-an-id'])])), 'invalid_employee', 0);
        problem(() => parseAttendanceV3Route(route([{ ...level(), source: { kind: 'specific_employee', employmentIds: [id(1)], alternates: [] } as never }])), 'invalid_source', 0);
        problem(() => parseAttendanceV3Route(route([{ ...superior(1), source: { kind: 'direct_manager', depth: 1, employmentId: id(1) } as never }])), 'invalid_source', 0);
    });
    it('accepts twenty per level and one hundred total; refuses instead of truncating twenty-one/one hundred one', () => {
        const group = (offset: number, count = 20) => level(Array.from({ length: count }, (_, n) => id(offset + n)));
        expect(parseAttendanceV3Route(route([group(1), group(21), group(41), group(61), group(81)])).stages.flatMap(l => l.source.kind === 'specific_employee' ? l.source.employmentIds : []).length).toBe(100);
        problem(() => parseAttendanceV3Route(route([group(1, 21)])), 'too_many_participants', 0);
        problem(() => parseAttendanceV3Route(route([group(1), group(21), group(41), group(61), group(81), superior(1)])), 'too_many_participants', 5);
    });
    it('refuses duplicate employment within or across groups rather than deduplicating', () => {
        problem(() => parseAttendanceV3Route(route([level([id(1), id(1)])])), 'duplicate_employment', 0);
        problem(() => parseAttendanceV3Route(route([level([id(1)]), level([id(1)])])), 'duplicate_employment', 1);
    });
    it('does not permit HR to silently replace a required selected group', () => {
        problem(() => parseAttendanceV3Route(route([{ ...level(), hrAlternative: true }])), 'invalid_source', 0);
        expect(parseAttendanceV3Route(route([superior(1, true)])).stages[0].hrAlternative).toBe(true);
    });
});
describe('v3 authorized-identity resolution algorithm', () => {
    it('asks Personnel for depth five even when preceded by a selected group', async () => {
        const port = resolver();
        const result = await resolveAttendanceV3Route(route([level([id(3), id(1)], 'any_one'), superior(5)]), identity(0), port);
        expect(port.superior).toHaveBeenCalledExactlyOnceWith(5);
        expect(result.stages[0].approvers.map(p => p.employmentId)).toEqual([id(3), id(1)]);
        expect(result.stages[1].approvers[0]).toMatchObject({ hierarchyDepth: 5, slot: '1:0' });
    });
    it('freezes identity values and copies selected IDs without sharing mutable port objects', async () => {
        const actor = identity(1), configured = route([level([id(1)])]);
        const port = resolver(); port.selectedEmployee = async () => ({ ok: true, identity: actor });
        const frozen = await resolveAttendanceV3Route(configured, identity(0), port);
        actor.name = 'Changed later';
        if (configured.stages[0].source.kind === 'specific_employee') configured.stages[0].source.employmentIds[0] = id(9);
        expect(frozen.stages[0].approvers[0].name).toBe('Fictional 1');
        expect(frozen.stages[0].source).toEqual({ kind: 'specific_employee', employmentIds: [id(1)] });
    });
    it.each(['missing_superior', 'ambiguous_superior', 'cycle', 'inactive_superior', 'outside_company_scope', 'missing_or_ambiguous_login'] as const)('returns finite level failure %s without raw values', async code => {
        const port = resolver(); port.superior = async () => ({ ok: false, code });
        await expect(resolveAttendanceV3Route(route([superior(2)]), identity(0), port)).rejects.toMatchObject({ message: code, problem: { code, levelIndex: 0, participantIndex: 0 } });
    });
    it('uses only an explicitly configured and available HR alternative', async () => {
        const port = resolver(); port.superior = async () => ({ ok: false, code: 'missing_superior' });
        await expect(resolveAttendanceV3Route(route([superior(1)]), identity(0), port)).rejects.toMatchObject({ problem: { code: 'missing_superior' } });
        expect(port.hasHrAlternative).not.toHaveBeenCalled();
        expect((await resolveAttendanceV3Route(route([superior(1, true)]), identity(0), port)).stages[0]).toMatchObject({ approvers: [], hrAlternative: true });
        port.hasHrAlternative = async () => false;
        await expect(resolveAttendanceV3Route(route([superior(1, true)]), identity(0), port)).rejects.toMatchObject({ problem: { code: 'missing_superior' } });
    });
    it('refuses self approval through employment, person or login', async () => {
        for (const key of ['employmentId', 'personId', 'userId'] as const) {
            const applicant = identity(0), actor = { ...identity(1), [key]: applicant[key] };
            const port = resolver(); port.superior = async () => ({ ok: true, identity: actor });
            await expect(resolveAttendanceV3Route(route([superior(1)]), applicant, port)).rejects.toMatchObject({ problem: { code: 'self_approval', levelIndex: 0 } });
        }
    });
    it.each([['employmentId', 'duplicate_employment'], ['personId', 'duplicate_person'], ['userId', 'duplicate_login']] as const)('refuses repeated %s across required levels', async (key, code) => {
        const first = identity(1), second = { ...identity(2), [key]: first[key] }, port = resolver();
        port.superior = async depth => ({ ok: true, identity: depth === 1 ? first : second });
        await expect(resolveAttendanceV3Route(route([superior(1), superior(2)]), identity(0), port)).rejects.toMatchObject({ problem: { code, levelIndex: 1 } });
    });
    it('refuses a named-employee reader returning another principal', async () => {
        const port = resolver(); port.selectedEmployee = async () => ({ ok: true, identity: identity(9) });
        await expect(resolveAttendanceV3Route(route([level([id(1)])]), identity(0), port)).rejects.toMatchObject({ problem: { code: 'invalid_identity', participantIndex: 0 } });
    });
});
describe('participant-grain completion projection (never an authorization capability)', () => {
    const decision = (slot: string, n: number, decision: 'approved' | 'rejected' = 'approved'): AttendanceV3ParticipantDecision => ({ slot, decision, actualPersonId: identity(n).personId, actualUserId: identity(n).userId });
    async function frozen(mode: 'sequential' | 'any_one' = 'sequential') { return (await resolveAttendanceV3Route(route([level(undefined, mode)]), identity(0), resolver())).stages[0]; }
    it('requires A then B then C and completes only after all required people', async () => {
        const value = await frozen();
        expect(attendanceV3LevelProgress(value, [], 0)).toEqual({ complete: false, rejected: false, pendingSlots: ['0:0'] });
        expect(attendanceV3LevelProgress(value, [decision('0:0', 1)], 0)).toEqual({ complete: false, rejected: false, pendingSlots: ['0:1'] });
        expect(attendanceV3LevelProgress(value, [decision('0:0', 1), decision('0:1', 2)], 0).pendingSlots).toEqual(['0:2']);
        expect(attendanceV3LevelProgress(value, [decision('0:0', 1), decision('0:1', 2), decision('0:2', 3)], 0)).toEqual({ complete: true, rejected: false, pendingSlots: [] });
        problem(() => attendanceV3LevelProgress(value, [decision('0:1', 2)], 0), 'invalid_evidence', 0);
    });
    it('any-one completes after the first authorized actor, not multiple competing records', async () => {
        const value = await frozen('any_one');
        expect(attendanceV3LevelProgress(value, [], 0).pendingSlots).toEqual(['0:0', '0:1', '0:2']);
        expect(attendanceV3LevelProgress(value, [decision('0:2', 3)], 0).complete).toBe(true);
        problem(() => attendanceV3LevelProgress(value, [decision('0:2', 3), decision('0:0', 1)], 0), 'invalid_evidence', 0);
    });
    it('retains earlier approvals when the next participant rejects, and refuses later evidence', async () => {
        const value = await frozen();
        expect(attendanceV3LevelProgress(value, [decision('0:0', 1), decision('0:1', 2, 'rejected')], 0)).toEqual({ complete: true, rejected: true, pendingSlots: [] });
        problem(() => attendanceV3LevelProgress(value, [decision('0:0', 1, 'rejected'), decision('0:1', 2)], 0), 'invalid_evidence', 0);
    });
    it('refuses duplicate clicks, unknown slots and the same real person deciding different slots', async () => {
        const value = await frozen();
        for (const records of [[decision('0:0', 1), decision('0:0', 1)], [decision('9:9', 9)], [decision('0:0', 1), decision('0:1', 1)]]) problem(() => attendanceV3LevelProgress(value, records, 0), 'invalid_evidence', 0);
    });
    it('treats the explicit single-superior HR alternative as one alternative completion', async () => {
        const value = (await resolveAttendanceV3Route(route([superior(1, true)]), identity(0), resolver())).stages[0];
        expect(attendanceV3LevelProgress(value, [], 0).pendingSlots).toEqual(['0:0', '0:hr']);
        expect(attendanceV3LevelProgress(value, [decision('0:hr', 9)], 0)).toEqual({ complete: true, rejected: false, pendingSlots: [] });
        problem(() => attendanceV3LevelProgress(value, [decision('0:0', 1), decision('0:hr', 9)], 0), 'invalid_evidence', 0);
    });
});

describe('untrusted resolver failure containment', () => {
    it('never returns a raw driver error or an arbitrary port code', async () => {
        const port = resolver();
        port.selectedEmployee = async () => { throw new Error('SELECT private_value FROM secret_table'); };
        await expect(resolveAttendanceV3Route(route(), identity(0), port)).rejects.toMatchObject({ message: 'employee_unavailable', problem: { code: 'employee_unavailable', levelIndex: 0, participantIndex: 0 } });
        port.selectedEmployee = async () => ({ ok: false, code: 'arbitrary secret' as never });
        await expect(resolveAttendanceV3Route(route(), identity(0), port)).rejects.toMatchObject({ message: 'employee_unavailable' });
        port.superior = async () => ({ ok: false, code: 'missing_superior' });
        port.hasHrAlternative = async () => { throw new Error('private bound values'); };
        await expect(resolveAttendanceV3Route(route([superior(1, true)]), identity(0), port)).rejects.toMatchObject({ message: 'hr_unavailable', problem: { code: 'hr_unavailable', levelIndex: 0 } });
    });
});

describe('reasoned outstanding participant-slot reassignment projection', () => {
    const recorded = (n: number): AttendanceV3ParticipantDecision => ({ slot: '0:0', decision: 'approved', actualPersonId: identity(n).personId, actualUserId: identity(n).userId });
    it('preserves completed evidence and original route while replacing only the requested outstanding slot', async () => {
        const original = await resolveAttendanceV3Route(route(), identity(0), resolver());
        const evidence = [recorded(1)];
        const result = projectAttendanceV3SlotReassignment(original, 0, evidence, '0:1', identity(9), identity(0), '  Assigned replacement after departure  ');
        expect(original.stages[0].approvers.map(p => p.employmentId)).toEqual([id(1), id(2), id(3)]);
        expect(result.stages[0].approvers.map(p => p.employmentId)).toEqual([id(1), id(9), id(3)]);
        expect(result.reassignment).toMatchObject({ slot: '0:1', previous: { employmentId: id(2) }, replacement: { employmentId: id(9) }, reason: 'Assigned replacement after departure' });
        expect(attendanceV3LevelProgress(result.stages[0], evidence, 0).pendingSlots).toEqual(['0:1']);
        expect(evidence).toEqual([recorded(1)]);
    });
    it('refuses completed slots, blank reasons, self assignment and reused actors', async () => {
        const original = await resolveAttendanceV3Route(route(), identity(0), resolver());
        problem(() => projectAttendanceV3SlotReassignment(original, 0, [recorded(1)], '0:0', identity(9), identity(0), 'Reason'), 'not_next_participant', 0);
        problem(() => projectAttendanceV3SlotReassignment(original, 0, [], '0:1', identity(9), identity(0), ' '), 'invalid_level', 0);
        problem(() => projectAttendanceV3SlotReassignment(original, 0, [], '0:1', identity(0), identity(0), 'Reason'), 'self_approval', 0);
        problem(() => projectAttendanceV3SlotReassignment(original, 0, [], '0:1', identity(3), identity(0), 'Reason'), 'duplicate_employment', 0);
        problem(() => projectAttendanceV3SlotReassignment(original, 0, [recorded(9)], '0:1', identity(9), identity(0), 'Reason'), 'invalid_evidence', 0);
    });
});

describe('finite submission transport and version boundary', () => {
    it('round-trips only finite public level/problem facts', () => {
        const value = { code: 'missing_superior' as const, levelIndex: 4, participantIndex: 0 };
        expect(parseAttendanceLevelProblemToken(attendanceLevelProblemToken(value))).toEqual(value);
        expect(parseAttendanceLevelProblemToken('invalid_route:route:level')).toEqual({ code: 'invalid_route', levelIndex: null });
        for (const token of [null, '<script>:0:level', 'missing_superior:10:level', 'missing_superior:0:20', 'missing_superior:0:level:extra', 'SELECT private_value']) expect(parseAttendanceLevelProblemToken(token)).toBeNull();
    });
    it('validates common metadata through its owner and preserves v3 ordered participants independently', () => {
        const input = { companyId: id(90), code: 'V3', name: 'Per-person approvals', applicationType: 'irregularity' as const, priority: 100, criteria: {}, active: false, ...route([level([id(3), id(1)], 'any_one'), superior(5)]) };
        expect(validateAnyAttendanceWorkflow(input)).toMatchObject({ routingVersion: 3, stages: [{ name: 'Level 1', mode: 'any_one', source: { employmentIds: [id(3), id(1)] } }, { name: 'Level 2', source: { depth: 5 } }] });
        expect(() => validateAnyAttendanceWorkflow({ ...input, criteria: { unsupported: ['secret'] } })).toThrow();
        expect(() => validateAnyAttendanceWorkflow({ ...input, priority: -1 })).toThrow();
    });
});
