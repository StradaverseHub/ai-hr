import {requireAdmin} from '@/lib/authz';
import {getClockingImportJob} from '@/packs/attendance/service';
import {attendanceJobHttpError,attendanceJobJson} from '@/lib/attendance-job-http';
export const runtime='nodejs';
type Params={params:Promise<{jobId:string}>};
/** One clocking import's progress, for its creator only (row security on bulk_job). */
export async function GET(_request:Request,{params}:Params){const ctx=await requireAdmin();try{return attendanceJobJson({job:await getClockingImportJob(ctx,(await params).jobId)});}catch(error){return attendanceJobHttpError(error);}}
