import {requireAdmin} from '@/lib/authz';
import {createBankImportJob,listBankImportJobs} from '@/core/bank-import-job';
import {assertBankImportOrigin,bankImportBody,bankImportHttpError} from '@/lib/bank-import-http';
export const runtime='nodejs';
export async function GET(){const ctx=await requireAdmin();return Response.json({jobs:await listBankImportJobs(ctx)},{headers:{'Cache-Control':'private, no-store'}});}
export async function POST(request:Request){
 const ctx=await requireAdmin();
 try{assertBankImportOrigin(request);const raw=JSON.parse((await bankImportBody(request,4096)).toString('utf8'));const result=await createBankImportJob(ctx,{name:raw.name,hash:raw.hash,bytes:raw.bytes});return Response.json(result,{status:result.existing?200:201,headers:{'Cache-Control':'private, no-store'}});}
 catch(error){return bankImportHttpError(error);}
}
