import {attendanceForEmploymentRange,attendancePunchesForRange} from '@/core/attendance';
import type {SessionContext} from '@/db/client';
import {paginateRows,type PageQuery} from '@/lib/pagination';
import type {ResolvedRange} from '../my-records/range';

/** The page supplies its server-authorized selection and canonical range. Punch details are
 * read only for displayed days; all day figures still come from the unchanged Attendance owner. */
export async function readIndividualAttendance(ctx:SessionContext,employmentId:string|undefined,range:ResolvedRange,page:PageQuery){
 const rows=employmentId&&!range.refusal?await attendanceForEmploymentRange(ctx,employmentId,range.from,range.to):[];
 const {rows:dayPage,state:pgState}=paginateRows(rows,page);
 const punchesByAttendance=employmentId&&dayPage.length
  ?await attendancePunchesForRange(ctx,employmentId,dayPage[0].date,dayPage[dayPage.length-1].date):new Map();
 return {dayPage,pgState,total:rows.length,punchesByAttendance};
}
