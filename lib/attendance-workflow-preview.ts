/** Stored Preview Assignment snapshot vocabulary. A preview is presentation evidence only; it never routes. */
import type { AttendanceLevelProblem } from './attendance-workflow-v3';

export const ATTENDANCE_PREVIEW_ROW_LIMIT = 5000;
export const ATTENDANCE_PREVIEW_HISTORY_LIMIT = 20;

/** Read-only Direct Superior diagnosis codes (app.attendance_workflow_superior_diagnostic). */
export const ATTENDANCE_SUPERIOR_PROBLEMS = ['no_superior', 'superior_inactive', 'no_login', 'multiple_logins', 'login_wrong_company', 'outside_company_scope', 'ambiguous_superior', 'cycle', 'duplicate_person', 'duplicate_login', 'missing_person'] as const;
export type AttendanceSuperiorProblem = typeof ATTENDANCE_SUPERIOR_PROBLEMS[number];

export type AttendancePreviewApproverSource =
    | { kind: 'direct_manager'; depth: number }
    | { kind: 'specific_employee' }
    | { kind: 'hr_admin' }
    | { kind: 'cc' };

export type AttendancePreviewApprover = { name: string; employeeCode: string | null; kind: 'direct_manager' | 'specific_employee' | 'hr_admin' };
export type AttendanceWorkflowPreviewLevel = { level: number; state: 'resolved' | 'skipped'; approvers: AttendancePreviewApprover[] };
export type AttendanceWorkflowPreviewEmployee = {
    employmentId: string; employeeCode: string | null; name: string; companyId: string;
    /** Code of the workflow that would actually route this employee (priority winner). */
    selectedCode: string;
    outcome: 'routed' | 'warning' | 'otherWorkflow' | 'tie';
    levels: AttendanceWorkflowPreviewLevel[];
};
export type AttendanceWorkflowPreviewWarning = {
    employmentId: string; employeeCode: string | null; name: string; companyId: string;
    /** Configured level index (0-based); null for a route-wide or CC problem. */
    levelIndex: number | null;
    source: AttendancePreviewApproverSource | null;
    approverName: string | null; approverCode: string | null;
    problem: AttendanceLevelProblem | null;
    superiorProblem: AttendanceSuperiorProblem | null;
    /** Depth at which the reporting chain stopped, when it differs from the configured depth. */
    superiorDepth: number | null;
    conflict: 'tie' | null;
};

/** Finite translated wording for one stored warning (attendanceWorkflow.previewHistory.problems.*). */
export function attendancePreviewWarningKey(warning: Pick<AttendanceWorkflowPreviewWarning, 'problem' | 'superiorProblem' | 'source' | 'conflict'>): string {
    if (warning.conflict === 'tie') return 'tie';
    if (warning.superiorProblem) return warning.superiorProblem;
    if (warning.source?.kind === 'cc') return 'cc_unavailable';
    const code = warning.problem?.code;
    if (!code) return 'unresolved';
    if (code === 'hr_unavailable') return 'hr_unavailable';
    if (warning.source?.kind === 'specific_employee' && ['employee_unavailable', 'missing_or_ambiguous_login', 'missing_person', 'invalid_identity'].includes(code)) return 'selected_unavailable';
    if (['duplicate_employment', 'duplicate_person', 'duplicate_login', 'self_approval'].includes(code)) return 'duplicate_person';
    if (code === 'missing_superior') return 'no_superior';
    if (code === 'inactive_superior') return 'superior_inactive';
    if (code === 'ambiguous_superior' || code === 'cycle' || code === 'outside_company_scope' || code === 'missing_person') return code;
    if (code === 'missing_or_ambiguous_login') return 'login_unusable';
    return 'unresolved';
}
export const ATTENDANCE_PREVIEW_WARNING_KEYS = ['tie', ...ATTENDANCE_SUPERIOR_PROBLEMS, 'cc_unavailable', 'unresolved', 'hr_unavailable', 'selected_unavailable', 'login_unusable'] as const;
