import {requireAdmin} from '@/lib/authz';
import {bankImportProblems} from '@/core/bank-statutory-error-log';
import {bankImportHttpError} from '@/lib/bank-import-http';
export const runtime='nodejs';
/** d3ba1e9f — the first 200 problem rows for the progress screen's problem table (one bounded read; sensitive cells
 *  redacted before they leave the server). The Error Log download has every row. */
export async function GET(_request:Request,{params}:{params:Promise<{jobId:string}>}){
 const ctx=await requireAdmin();
 try{return Response.json(await bankImportProblems(ctx,(await params).jobId),{headers:{'Cache-Control':'private, no-store'}});}
 catch(error){return bankImportHttpError(error);}
}
