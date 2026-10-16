/** Attendance owns its templates. Shared approver vocabulary is reused; no Leave records are written. */
import { approversOf, sanitizeApprovalLevels, type ApprovalLevel } from './leave-approval-kinds';
export const ATTENDANCE_APPLICATION_TYPES = ['irregularity', 'self_overtime'] as const;
export type AttendanceApplicationType = typeof ATTENDANCE_APPLICATION_TYPES[number];
// These are the existing attendance decision authorities, including scoped delegation. A new authority
// must supply a safe final-effect contract before it is offered here; visibility is not authority.
export const ATTENDANCE_APPROVER_KINDS = ['direct_manager', 'hr_admin'] as const;
export type AttendanceRoutingVersion = 1 | 2;
export const ATTENDANCE_CRITERIA_KEYS = ['departmentIds', 'businessUnitIds', 'gradeIds', 'positionIds', 'employmentTypes', 'orgDivision', 'orgBranch', 'orgRegion', 'orgLine', 'orgSection', 'orgTeam', 'orgBase', 'employmentCategory', 'employeeIds'] as const;
export const ATTENDANCE_PROFILE_CRITERIA_KEYS = ['orgDivision', 'orgBranch', 'orgRegion', 'orgLine', 'orgSection', 'orgTeam', 'orgBase', 'employmentCategory'] as const;
export function attendanceLevelName(index: number): string { return `Level ${index + 1}`; }
export type AttendanceWorkflowStage = {
    name: string;
    level: ApprovalLevel;
};
export type AttendanceResolvedApprover = {
    kind: 'direct_manager' | 'hr_admin';
    employmentId: string | null;
    /** Version 2 freezes distinct employment/person/login identities at submission. */
    personId?: string;
    userId?: string;
    hierarchyDepth?: number;
    name: string;
};
export type AttendanceResolvedStage = {
    name: string;
    approvers: AttendanceResolvedApprover[];
};
export type AttendanceWorkflowCriteria = {
    departmentIds?: string[];
    businessUnitIds?: string[];
    gradeIds?: string[];
    positionIds?: string[];
    employmentTypes?: string[];
    employeeIds?: string[];
} & Partial<Record<typeof ATTENDANCE_PROFILE_CRITERIA_KEYS[number], string[]>>;
export type AttendanceWorkflowInput = {
    companyId: string;
    /** Omission preserves legacy configured routing; new UI explicitly chooses version 2. */
    routingVersion?: AttendanceRoutingVersion;
    code: string;
    name: string;
    description?: string;
    applicationType: AttendanceApplicationType;
    priority: number;
    criteria: AttendanceWorkflowCriteria;
    stages: AttendanceWorkflowStage[];
    active: boolean;
};
export class AttendanceWorkflowError extends Error {
    constructor(public readonly code: 'invalid' | 'scope' | 'overlap' | 'noMatch' | 'tie' | 'unresolved' | 'notApprover' | 'stale' | 'inUse', message: string) { super(message); this.name = 'AttendanceWorkflowError'; }
}
export function attendanceApplicationType(row: {
    requestKind?: string | null;
    proposedCheckIn?: string | null;
    proposedCheckOut?: string | null;
    clockChanges?: unknown;
    requestedOtMinutes?: number | null;
}): AttendanceApplicationType {
    // Persisted intent wins. Legacy NULL rows were plans only when they carried no proposed clock data.
    if (row.requestKind)
        return row.requestKind === 'self_overtime' ? 'self_overtime' : 'irregularity';
    return row.requestedOtMinutes != null && !row.proposedCheckIn && !row.proposedCheckOut && !row.clockChanges ? 'self_overtime' : 'irregularity';
}
export function validateAttendanceWorkflow(input: AttendanceWorkflowInput): AttendanceWorkflowInput {
    if (!input || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.companyId ?? '') || !/^[A-Za-z0-9_-]{1,40}$/.test(input.code ?? '') || !input.name?.trim() || input.name.trim().length > 120 || (input.description?.length ?? 0) > 1000 || !ATTENDANCE_APPLICATION_TYPES.includes(input.applicationType) || !Number.isInteger(input.priority) || input.priority < 0 || input.priority > 9999)
        throw new AttendanceWorkflowError('invalid', 'Enter a code, name, application type and priority from 0 to 9999.');
    const routingVersion = input.routingVersion ?? 1;
    if (routingVersion !== 1 && routingVersion !== 2) throw new AttendanceWorkflowError('invalid', 'Choose a supported routing version.');
    if (!Array.isArray(input.stages) || input.stages.length < 1 || input.stages.length > 10)
        throw new AttendanceWorkflowError('invalid', 'Configure between one and ten approval stages.');
    const stages = input.stages.map((s, index) => {
        if (!s || typeof s !== 'object') throw new AttendanceWorkflowError('invalid', 'Choose a supported approval level.');
        const parsed = sanitizeApprovalLevels([s.level]);
        if ((routingVersion === 1 && (!s.name?.trim() || s.name.trim().length > 100)) || parsed.length !== 1)
            throw new AttendanceWorkflowError('invalid', 'Every stage needs a name and a supported approver.');
        const level = parsed[0];
        const rawCount = 1 + (Array.isArray(s.level?.alternates) ? s.level.alternates.length : 0);
        if (approversOf(level).length !== rawCount || approversOf(level).some(a => !ATTENDANCE_APPROVER_KINDS.includes(a.kind as typeof ATTENDANCE_APPROVER_KINDS[number])))
            throw new AttendanceWorkflowError('invalid', 'Attendance supports the direct administrative manager and HR administrators; any one of the selected approvers can clear a stage.');
        return { name: routingVersion === 2 ? attendanceLevelName(index) : s.name.trim(), level };
    });
    const allowed: readonly string[] = ATTENDANCE_CRITERIA_KEYS;
    const criteria: AttendanceWorkflowCriteria = {};
    for (const [key, value] of Object.entries(input.criteria ?? {})) {
        if (!allowed.includes(key) || !Array.isArray(value) || value.length > 1000 || value.some(v => typeof v !== 'string' || !v.trim() || v.length > 200))
            throw new AttendanceWorkflowError('invalid', 'Unsupported organisational assignment.');
        if (['departmentIds', 'businessUnitIds', 'gradeIds', 'positionIds', 'employeeIds'].includes(key) && value.some(id => !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)))
            throw new AttendanceWorkflowError('invalid', 'Select valid organisational assignments from the available options.');
        if (key === 'employmentTypes' && value.some(v => !['full_time', 'part_time', 'contract', 'intern'].includes(v))) throw new AttendanceWorkflowError('invalid', 'Choose a supported employment type.');
        criteria[key as keyof AttendanceWorkflowCriteria] = [...new Set(value)];
    }
    return { companyId: input.companyId, routingVersion, code: input.code.trim(), name: input.name.trim(), description: input.description?.trim() || '', applicationType: input.applicationType, priority: input.priority, criteria, stages, active: input.active === true };
}
export function attendanceScopesOverlap(a: AttendanceWorkflowCriteria, b: AttendanceWorkflowCriteria): boolean {
    return ATTENDANCE_CRITERIA_KEYS.every(k => {
        const x = a[k as keyof AttendanceWorkflowCriteria] ?? [], y = b[k as keyof AttendanceWorkflowCriteria] ?? [];
        return !x.length || !y.length || x.some(id => y.includes(id));
    });
}

export type AttendanceWorkflowOptions = {
    companies: { id: string; name: string }[];
    departments: { id: string; name: string }[];
    businessUnits: { id: string; name: string }[];
    grades: { id: string; name: string }[];
    divisions: { id: string; name: string }[];
    positions?: { id: string; name: string }[];
    employees?: { id: string; name: string; employeeCode?: string | null }[];
    profileFields?: Partial<Record<keyof AttendanceWorkflowCriteria, { id: string; name: string }[]>>;
};
/** One presentation descriptor for form, company list and View/Edit; values remain Personnel-owned. */
export function attendanceWorkflowCriteriaFields(options: AttendanceWorkflowOptions, employmentTypeLabel: (key: string) => string) {
    const profileLabels: Record<typeof ATTENDANCE_PROFILE_CRITERIA_KEYS[number], string> = { orgDivision: 'division', orgBranch: 'branch', orgRegion: 'region', orgLine: 'line', orgSection: 'section', orgTeam: 'team', orgBase: 'base', employmentCategory: 'category' };
    const fields: { key: keyof AttendanceWorkflowCriteria; label: string; options: { id: string; name: string }[] }[] = [
        { key: 'departmentIds', label: 'department', options: options.departments },
        { key: 'businessUnitIds', label: 'businessUnit', options: options.businessUnits },
        { key: 'gradeIds', label: 'grade', options: options.grades },
        { key: 'positionIds', label: 'position', options: options.positions ?? [] },
        { key: 'employmentTypes', label: 'employmentType', options: ['full_time', 'part_time', 'contract', 'intern'].map(id => ({ id, name: employmentTypeLabel(id) })) },
        ...ATTENDANCE_PROFILE_CRITERIA_KEYS.map(key => ({ key, label: profileLabels[key], options: options.profileFields?.[key] ?? (key === 'orgDivision' ? options.divisions : []) })),
        { key: 'employeeIds', label: 'employees', options: (options.employees ?? []).map(e => ({ id: e.id, name: e.employeeCode ? `${e.employeeCode} · ${e.name}` : e.name })) },
    ];
    return fields;
}
