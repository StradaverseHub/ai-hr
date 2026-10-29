import {requireAdmin} from '@/lib/authz';
import {bankImportCommand,getBankImportJob,uploadBankImportChunk,BankImportJobError} from '@/core/bank-import-job';
import {BANK_IMPORT_CHUNK_BYTES} from '@/lib/bank-import-job';
import {assertBankImportOrigin,bankImportBody,bankImportHttpError} from '@/lib/bank-import-http';
export const runtime='nodejs';
type Params={params:Promise<{jobId:string}>};
export async function GET(request:Request,{params}:Params){const ctx=await requireAdmin();try{return Response.json(await getBankImportJob(ctx,(await params).jobId,Number(new URL(request.url).searchParams.get('page')??0)),{headers:{'Cache-Control':'private, no-store'}});}catch(error){return bankImportHttpError(error);}}
export async function PUT(request:Request,{params}:Params){
 const ctx=await requireAdmin();
 try{assertBankImportOrigin(request);await uploadBankImportChunk(ctx,(await params).jobId,Number(new URL(request.url).searchParams.get('part')),await bankImportBody(request,BANK_IMPORT_CHUNK_BYTES));return Response.json({ok:true},{headers:{'Cache-Control':'private, no-store'}});}
 catch(error){return bankImportHttpError(error);}
}
export async function POST(request:Request,{params}:Params){
 const ctx=await requireAdmin();
 try{assertBankImportOrigin(request);const {command}=JSON.parse((await bankImportBody(request,1024)).toString('utf8'));
 if(!['validate','confirm','cancel'].includes(command))throw new BankImportJobError('Unknown import command.');
 return Response.json({job:await bankImportCommand(ctx,(await params).jobId,command)},{headers:{'Cache-Control':'private, no-store'}});}
 catch(error){return bankImportHttpError(error);}
}
