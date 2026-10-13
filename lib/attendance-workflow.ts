/** Attendance owns its templates. Shared approver vocabulary is reused; no Leave records are written. */
import { approversOf, sanitizeApprovalLevels, type ApprovalLevel } from './leave-approval-kinds';
export const ATTENDANCE_APPLICATION_TYPES = ['irregularity', 'self_overtime'] as const;
export type AttendanceApplicationType = typeof ATTENDANCE_APPLICATION_TYPES[number];
// These are the existing attendance decision authorities, including scoped delegation. A new authority
// must supply a safe final-effect contract before it is offered here; visibility is not authority.
export const ATTENDANCE_APPROVER_KINDS = ['direct_manager', 'hr_admin'] as const;
export type AttendanceWorkflowStage = {
    name: string;
    level: ApprovalLevel;
};
export type AttendanceResolvedApprover = {
    kind: 'direct_manager' | 'hr_admin';
    employmentId: string | null;
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
    orgDivision?: string[];
};
export type AttendanceWorkflowInput = {
    companyId: string;
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
    if (!Array.isArray(input.stages) || input.stages.length < 1 || input.stages.length > 10)
        throw new AttendanceWorkflowError('invalid', 'Configure between one and ten approval stages.');
    const stages = input.stages.map(s => {
        const parsed = sanitizeApprovalLevels([s.level]);
        if (!s.name?.trim() || s.name.trim().length > 100 || parsed.length !== 1)
            throw new AttendanceWorkflowError('invalid', 'Every stage needs a name and a supported approver.');
        const level = parsed[0];
        const rawCount = 1 + (Array.isArray(s.level?.alternates) ? s.level.alternates.length : 0);
        if (approversOf(level).length !== rawCount || approversOf(level).some(a => !ATTENDANCE_APPROVER_KINDS.includes(a.kind as typeof ATTENDANCE_APPROVER_KINDS[number])))
            throw new AttendanceWorkflowError('invalid', 'Attendance supports the direct administrative manager and HR administrators; any one of the selected approvers can clear a stage.');
        return { name: s.name.trim(), level };
    });
    const allowed = ['departmentIds', 'businessUnitIds', 'gradeIds', 'orgDivision'];
    const criteria: AttendanceWorkflowCriteria = {};
    for (const [key, value] of Object.entries(input.criteria ?? {})) {
        if (!allowed.includes(key) || !Array.isArray(value) || value.some(v => typeof v !== 'string' || !v.trim()))
            throw new AttendanceWorkflowError('invalid', 'Unsupported organisational assignment.');
        if (key !== 'orgDivision' && value.some(id => !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)))
            throw new AttendanceWorkflowError('invalid', 'Select valid organisational assignments from the available options.');
        criteria[key as keyof AttendanceWorkflowCriteria] = [...new Set(value)];
    }
    return { companyId: input.companyId, code: input.code.trim(), name: input.name.trim(), description: input.description?.trim() || '', applicationType: input.applicationType, priority: input.priority, criteria, stages, active: input.active === true };
}
export function attendanceScopesOverlap(a: AttendanceWorkflowCriteria, b: AttendanceWorkflowCriteria): boolean {
    return ['departmentIds', 'businessUnitIds', 'gradeIds', 'orgDivision'].every(k => {
        const x = a[k as keyof AttendanceWorkflowCriteria] ?? [], y = b[k as keyof AttendanceWorkflowCriteria] ?? [];
        return !x.length || !y.length || x.some(id => y.includes(id));
    });
}
