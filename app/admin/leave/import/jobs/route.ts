import {requireAdmin} from '@/lib/authz';
import {activeLeaveImportJob} from '@/core/leave-import-job';
export const runtime='nodejs';
/** The caller's running leave import, so the screen can rejoin it after a reload. */
export async function GET(){
 const session=await requireAdmin();
 return Response.json({job:await activeLeaveImportJob(session)},{headers:{'Cache-Control':'private, no-store'}});
}
