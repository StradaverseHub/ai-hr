import {requireAdmin} from '@/lib/authz';
import {listClockingImportJobs} from '@/packs/attendance/service';
import {attendanceJobHttpError,attendanceJobJson} from '@/lib/attendance-job-http';
export const runtime='nodejs';
/** The signed-in administrator's recent clocking imports (the screen rejoins a running one). */
export async function GET(){const ctx=await requireAdmin();try{return attendanceJobJson({jobs:await listClockingImportJobs(ctx)});}catch(error){return attendanceJobHttpError(error);}}
