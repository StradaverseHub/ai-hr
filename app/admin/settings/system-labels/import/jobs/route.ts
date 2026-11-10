import {scopedAdmin} from '@/lib/scope';
import {listSystemLabelImportJobs} from '@/core/system-label-import-job';
export const runtime='nodejs';
/** The signed-in administrator's recent System Labels imports (the page rejoins a running one). */
export async function GET(){
  const {s}=await scopedAdmin();
  try{return Response.json({jobs:await listSystemLabelImportJobs(s)},{headers:{'Cache-Control':'private, no-store'}});}
  catch{return Response.json({error:'Import unavailable.'},{status:404,headers:{'Cache-Control':'private, no-store'}});}
}
