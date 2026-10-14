import type { AttendanceApplicationType } from './attendance-workflow';
export type AttendanceHistoryFilter = {
    employmentId?: string;
    requestKind?: 'absent'|'short_hours'|'incomplete_entry'|'self_overtime'|'other'|'unknown';
    attendanceFrom?: string;
    attendanceTo?: string;
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
    if(filter.requestKind&&!['absent','short_hours','incomplete_entry','self_overtime','other','unknown'].includes(filter.requestKind))throw new Error('Invalid application subtype.');
    if (filter.applicationType && !['irregularity', 'self_overtime'].includes(filter.applicationType))
        throw new Error('Invalid application type.');
    if (filter.status && !['pending', 'approved', 'rejected', 'cancelled', 'withdrawn'].includes(filter.status))
        throw new Error('Invalid application status.');
    for (const value of [filter.employmentId, filter.companyId, filter.departmentId, filter.businessUnitId, filter.gradeId]) {
        if (value && !attendanceHistoryId(value))
            throw new Error('Choose a valid company, department, business unit or grade filter. Clear an old filter and try again.');
    }
    for (const value of [filter.submittedFrom, filter.submittedTo, filter.attendanceFrom, filter.attendanceTo]) {
        // Validate a date input, not a local date derived from an instant.
        if (value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value + 'T00:00:00Z')) || new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value))
            throw new Error('Enter a valid submission date.');
    }
    if (filter.submittedFrom && filter.submittedTo && filter.submittedFrom > filter.submittedTo)
        throw new Error('The submission date range starts after it ends.');
    if(filter.attendanceFrom&&filter.attendanceTo&&filter.attendanceFrom>filter.attendanceTo)throw new Error('The attendance date range starts after it ends.');
    const bounded = (value: number | undefined, fallback: number, min: number, max: number) => Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value!))) : fallback;
    return { ...filter, query: filter.query?.trim().slice(0, 200), page: bounded(filter.page, 1, 1, 1000000), pageSize: bounded(filter.pageSize, 25, 10, 100) };
}

/** Only a query for this list can travel through a detail action; never an arbitrary redirect. */
export function attendanceHistoryReturn(raw: string | undefined | null): string {
  const base='/attendance/application-history';
  if(!raw||!raw.startsWith(base+'?')||raw.length>3000)return base;
  const allowed=new Set(['employmentId','requestKind','attendanceFrom','attendanceTo','companyId','departmentId','businessUnitId','gradeId','division','applicationType','status','submittedFrom','submittedTo','query','page','pageSize']);
  const query=new URLSearchParams(raw.slice(base.length+1)), safe=new URLSearchParams();
  for(const [key,value] of query)if(allowed.has(key))safe.set(key,value);
  return base+'?'+safe.toString();
}
export function attendanceHistoryDate(date:string):string{
  const [year,month,day]=date.split('-');
  const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return /^\d{4}-\d{2}-\d{2}$/.test(date)&&months[Number(month)-1]?`${day}-${months[Number(month)-1]}-${year}`:date;
}
