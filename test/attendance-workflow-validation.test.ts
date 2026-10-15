import { describe, expect, it } from 'vitest';
import { attendanceApplicationType, attendanceScopesOverlap, validateAttendanceWorkflow, type AttendanceWorkflowInput } from '../lib/attendance-workflow';
import { parseBulkItems } from '../lib/approvals-bulk';
import { checkedAttendanceHistoryFilter } from '../lib/attendance-history-filter';
const valid = (): AttendanceWorkflowInput => ({ companyId: '00000000-0000-0000-0000-000000000001', code: 'CLOCK_1', name: 'Clock review', applicationType: 'irregularity', priority: 100, criteria: {}, stages: [{ name: 'Manager', level: { kind: 'direct_manager', employmentId: null, alternates: [{ kind: 'hr_admin', employmentId: null }] } }], active: true });
describe('Attendance workflow boundary validation', () => {
    it('uses persisted intent before applying the conservative legacy fallback', () => {
        expect(attendanceApplicationType({ requestKind: 'short_hours', requestedOtMinutes: 60 })).toBe('irregularity');
        expect(attendanceApplicationType({ requestKind: 'self_overtime', requestedOtMinutes: 60 })).toBe('self_overtime');
        expect(attendanceApplicationType({ requestKind: null, requestedOtMinutes: 60 })).toBe('self_overtime');
        expect(attendanceApplicationType({ requestedOtMinutes: 60, proposedCheckIn: '09:00' })).toBe('irregularity');
        expect(attendanceApplicationType({ requestedOtMinutes: 60, clockChanges: { entries: [] } })).toBe('irregularity');
        expect(attendanceApplicationType({ proposedCheckOut: '17:00' })).toBe('irregularity');
    });
    it('accepts ordered supported alternatives and canonicalizes scope', () => {
        const value = valid();
        value.criteria.departmentIds = [valid().companyId, valid().companyId];
        expect(validateAttendanceWorkflow(value).criteria.departmentIds).toEqual([valid().companyId]);
        expect(validateAttendanceWorkflow(value).stages[0].level.alternates).toEqual([{ kind: 'hr_admin', employmentId: null }]);
    });
    it.each(['payroll', 'specific_employee', 'invented'])('refuses unsupported approver %s without silently dropping it', kind => {
        const value = valid();
        value.stages[0].level.kind = kind as typeof value.stages[0]['level']['kind'];
        expect(() => validateAttendanceWorkflow(value)).toThrow();
    });
    it('rejects duplicates, empty chains, unbounded priorities and unknown criteria', () => {
        const duplicate = valid();
        duplicate.stages[0].level.alternates = [{ kind: 'direct_manager', employmentId: null }];
        expect(() => validateAttendanceWorkflow(duplicate)).toThrow();
        expect(() => validateAttendanceWorkflow({ ...valid(), stages: [] })).toThrow();
        expect(() => validateAttendanceWorkflow({ ...valid(), priority: -1 })).toThrow();
        expect(() => validateAttendanceWorkflow({ ...valid(), priority: 1.5 })).toThrow();
        expect(() => validateAttendanceWorkflow({ ...valid(), criteria: { invented: ['one'] } as never })).toThrow();
    });
    it('does not reuse a persisted version id or caller tenant when building a new version', () => {
        const supplied = { ...valid(), id: 'old-version-id', tenantId: 'caller-supplied-tenant', version: 99, lineageId: 'caller-lineage' };
        const validated = validateAttendanceWorkflow(supplied);
        expect(validated).not.toHaveProperty('id');
        expect(validated).not.toHaveProperty('tenantId');
        expect(validated).not.toHaveProperty('version');
        expect(validated).not.toHaveProperty('lineageId');
    });
    it('treats scope axes as conjunctions and blank axes as wildcards', () => {
        expect(attendanceScopesOverlap({}, { departmentIds: ['A'] })).toBe(true);
        expect(attendanceScopesOverlap({ departmentIds: ['A'] }, { departmentIds: ['B'] })).toBe(false);
        expect(attendanceScopesOverlap({ departmentIds: ['A'], gradeIds: ['G'] }, { departmentIds: ['A'], gradeIds: ['H'] })).toBe(false);
        expect(attendanceScopesOverlap({ businessUnitIds: ['X'], orgDivision: ['D'] }, { businessUnitIds: ['X'] })).toBe(true);
    });
    it('preserves a rendered stage token through bulk parsing and rejects malformed tokens', () => {
        expect(parseBulkItems(JSON.stringify([{ type: 'attendance', id: 'one', expectedStageIndex: 2 }]))).toEqual([{ type: 'attendance', id: 'one', expectedStageIndex: 2 }]);
        expect(parseBulkItems(JSON.stringify([{ type: 'attendance', id: 'one', expectedStageIndex: -1 }]))).toEqual([]);
        expect(parseBulkItems(JSON.stringify([{ type: 'attendance', id: 'one', expectedStageIndex: '2' }]))).toEqual([]);
        expect(parseBulkItems(JSON.stringify([{ type: 'claim', id: 'one' }]))).toEqual([{ type: 'claim', id: 'one' }]);
    });
});
describe('Attendance history input boundary', () => {
    it('normalizes non-finite and excessive pagination before producing SQL', () => {
        expect(checkedAttendanceHistoryFilter({ page: Infinity, pageSize: Infinity })).toMatchObject({ page: 1, pageSize: 25 });
        expect(checkedAttendanceHistoryFilter({ page: NaN, pageSize: NaN })).toMatchObject({ page: 1, pageSize: 25 });
        expect(checkedAttendanceHistoryFilter({ page: -2, pageSize: 1 })).toMatchObject({ page: 1, pageSize: 10 });
        expect(checkedAttendanceHistoryFilter({ page: 2.9, pageSize: 1000 })).toMatchObject({ page: 2, pageSize: 100 });
        expect(checkedAttendanceHistoryFilter({ page: Number.MAX_VALUE })).toMatchObject({ page: 1000000 });
    });
    it('returns domain guidance for malformed organisational filters and dates', () => {
        for (const key of ['companyId', 'departmentId', 'businessUnitId', 'gradeId'])
            expect(() => checkedAttendanceHistoryFilter({ [key]: 'not-a-uuid' })).toThrow(/valid company/);
        expect(() => checkedAttendanceHistoryFilter({ submittedFrom: '2026-02-31' })).toThrow(/valid submission date/);
        expect(() => checkedAttendanceHistoryFilter({ submittedFrom: '2026-08-02', submittedTo: '2026-08-01' })).toThrow(/starts after/);
    });
});

describe('797ba70b: explicit routing version and complete Personnel assignment vocabulary', () => {
  it('preserves omitted/legacy routing and canonicalizes new level labels by order', () => {
    expect(validateAttendanceWorkflow(valid()).routingVersion).toBe(1);
    expect(validateAttendanceWorkflow(valid()).stages[0].name).toBe('Manager');
    const next = valid(); next.routingVersion = 2; next.stages = Array.from({ length: 3 }, () => ({ name: 'untrusted custom label', level: { kind: 'direct_manager' as const, employmentId: null, alternates: [] } }));
    expect(validateAttendanceWorkflow(next).stages.map(s => s.name)).toEqual(['Level 1', 'Level 2', 'Level 3']);
    expect(() => validateAttendanceWorkflow({ ...next, routingVersion: 3 as never })).toThrow();
  });
  it('validates and retains every requested axis, with any within a field and all between fields', () => {
    const value = valid(); value.criteria = { departmentIds: [value.companyId], businessUnitIds: [value.companyId], gradeIds: [value.companyId], positionIds: [value.companyId], employeeIds: [value.companyId], employmentTypes: ['full_time', 'part_time'], orgDivision: ['D'], orgBranch: ['B'], orgRegion: ['R'], orgLine: ['L'], orgSection: ['S'], orgTeam: ['T'], orgBase: ['HQ'], employmentCategory: ['Executive'] };
    expect(validateAttendanceWorkflow(value).criteria).toEqual(value.criteria);
    expect(attendanceScopesOverlap({ employeeIds: ['A'] }, { employeeIds: ['B'] })).toBe(false);
    expect(attendanceScopesOverlap({ orgBranch: ['A', 'B'], employmentTypes: ['full_time'] }, { orgBranch: ['B'], employmentTypes: ['full_time'] })).toBe(true);
    expect(attendanceScopesOverlap({ orgBranch: ['A', 'B'], employmentTypes: ['full_time'] }, { orgBranch: ['B'], employmentTypes: ['intern'] })).toBe(false);
    expect(() => validateAttendanceWorkflow({ ...value, criteria: { employeeIds: ['person-name'] } })).toThrow();
    expect(() => validateAttendanceWorkflow({ ...value, criteria: { employmentTypes: ['invented'] } })).toThrow();
  });
});
