import {attendanceEmploymentRangePage,type AttendancePunchRow} from '@/packs/attendance/service';
import type {SessionContext} from '@/db/client';
import {pageState,type PageQuery} from '@/lib/pagination';
import type {ResolvedRange} from '../my-records/range';

/** The page supplies its server-authorized selection and canonical range. Punch details are
 * read only for displayed days; all day figures still come from the unchanged Attendance owner. */
export async function readIndividualAttendance(ctx:SessionContext,employmentId:string|undefined,range:ResolvedRange,page:PageQuery){
 if(!employmentId||range.refusal)return {dayPage:[],pgState:pageState(page,0,0),total:0,punchesByAttendance:new Map<string,AttendancePunchRow[]>()};
 return attendanceEmploymentRangePage(ctx,employmentId,range.from,range.to,page);
}
