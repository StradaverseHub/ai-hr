import {requireAdmin} from '@/lib/authz';
import {getEmployeeImportJob} from '@/core/employee-import-job';
import {bankImportHttpError} from '@/lib/bank-import-http';
export const runtime='nodejs';
type Params={params:Promise<{jobId:string}>};
export async function GET(_request:Request,{params}:Params){const ctx=await requireAdmin();try{return Response.json({job:await getEmployeeImportJob(ctx,(await params).jobId)},{headers:{'Cache-Control':'private, no-store'}});}catch(error){return bankImportHttpError(error);}}
