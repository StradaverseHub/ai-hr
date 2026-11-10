import {requireAdmin} from '@/lib/authz';
import {listRecomputeJobs} from '@/core/attendance-recompute-job';
import {attendanceJobHttpError,attendanceJobJson} from '@/lib/attendance-job-http';
export const runtime='nodejs';
/** The signed-in administrator's recent recompute previews and applies (the screen rejoins a running one). */
export async function GET(){const ctx=await requireAdmin();try{return attendanceJobJson({jobs:await listRecomputeJobs(ctx)});}catch(error){return attendanceJobHttpError(error);}}
