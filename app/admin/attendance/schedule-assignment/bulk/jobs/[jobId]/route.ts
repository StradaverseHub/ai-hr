import {requireAdmin} from '@/lib/authz';
import {readRosterBulkJob,RosterBulkJobError} from '@/core/roster-bulk-job';
import {SCHEDULE_GROUP_BULK_KIND} from '@/lib/roster-bulk-job';
export const runtime='nodejs';
type Params={params:Promise<{jobId:string}>};
const headers={'Cache-Control':'private, no-store'};
/** The creator's progress of one background Schedule Group bulk assignment. Read-only. */
export async function GET(_request:Request,{params}:Params){
 const ctx=await requireAdmin();
 try{return Response.json({job:await readRosterBulkJob(ctx,(await params).jobId,SCHEDULE_GROUP_BULK_KIND,{watch:true})},{headers});}
 catch(error){
  if(error instanceof RosterBulkJobError)return Response.json({error:error.message},{status:error.status,headers});
  return Response.json({error:'The job could not be read. Reload the page to see its progress.'},{status:500,headers});
 }
}
