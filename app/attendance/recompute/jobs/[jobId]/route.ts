import {requireAdmin} from '@/lib/authz';
import {getRecomputeJob} from '@/core/attendance-recompute-job';
import {attendanceJobHttpError,attendanceJobJson} from '@/lib/attendance-job-http';
export const runtime='nodejs';
type Params={params:Promise<{jobId:string}>};
/** One recompute preview or apply, for its creator only (row security on bulk_job). */
export async function GET(_request:Request,{params}:Params){const ctx=await requireAdmin();try{return attendanceJobJson({job:await getRecomputeJob(ctx,(await params).jobId)});}catch(error){return attendanceJobHttpError(error);}}
