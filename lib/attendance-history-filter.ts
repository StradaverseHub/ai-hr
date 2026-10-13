import type { AttendanceApplicationType } from './attendance-workflow';
export type AttendanceHistoryFilter = {
    companyId?: string;
    departmentId?: string;
    businessUnitId?: string;
    gradeId?: string;
    division?: string;
    applicationType?: AttendanceApplicationType;
    status?: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'withdrawn';
    submittedFrom?: string;
    submittedTo?: string;
    query?: string;
    page?: number;
    pageSize?: number;
};
export const attendanceHistoryId = (value: string): boolean => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
export function checkedAttendanceHistoryFilter(filter: AttendanceHistoryFilter) {
    if (filter.applicationType && !['irregularity', 'self_overtime'].includes(filter.applicationType))
        throw new Error('Invalid application type.');
    if (filter.status && !['pending', 'approved', 'rejected', 'cancelled', 'withdrawn'].includes(filter.status))
        throw new Error('Invalid application status.');
    for (const value of [filter.companyId, filter.departmentId, filter.businessUnitId, filter.gradeId]) {
        if (value && !attendanceHistoryId(value))
            throw new Error('Choose a valid company, department, business unit or grade filter. Clear an old filter and try again.');
    }
    for (const value of [filter.submittedFrom, filter.submittedTo]) {
        // Validate a date input, not a local date derived from an instant.
        if (value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value + 'T00:00:00Z')) || new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value))
            throw new Error('Enter a valid submission date.');
    }
    if (filter.submittedFrom && filter.submittedTo && filter.submittedFrom > filter.submittedTo)
        throw new Error('The submission date range starts after it ends.');
    const bounded = (value: number | undefined, fallback: number, min: number, max: number) => Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value!))) : fallback;
    return { ...filter, query: filter.query?.trim().slice(0, 200), page: bounded(filter.page, 1, 1, 1000000), pageSize: bounded(filter.pageSize, 25, 10, 100) };
}
