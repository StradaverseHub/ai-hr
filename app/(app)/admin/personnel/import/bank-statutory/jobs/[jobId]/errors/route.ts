import {sql} from 'drizzle-orm';
import {requireAdmin} from '@/lib/authz';
import {withTenant} from '@/db/client';
import {bankJobTx} from '@/core/bank-import-job';
import {bankImportHttpError} from '@/lib/bank-import-http';
import {toCsv} from '@/lib/csv';
import type {SectionRowResult} from '@/lib/import-sections';
export const runtime='nodejs';
/** Error export is paged and streamed; 100k invalid rows never become one browser preview. */
export async function GET(_request:Request,{params}:{params:Promise<{jobId:string}>}){
 const ctx=await requireAdmin(),{jobId}=await params;
 try{await withTenant(ctx,tx=>bankJobTx(tx,jobId));}catch(error){return bankImportHttpError(error);}
 let after=0,header=false,ended=false;const encoder=new TextEncoder();
 const body=new ReadableStream<Uint8Array>({
  async pull(controller){
   try{
    if(!header){controller.enqueue(encoder.encode(toCsv([['Row','Employee ID','Employee','Errors']])));header=true;return;}
    if(ended){controller.close();return;}
    const rows=await withTenant(ctx,async tx=>{
     await bankJobTx(tx,jobId);
     return tx.execute<{ordinal:number;preview:SectionRowResult|null;error:string|null}>(sql`select ordinal,preview,error from bank_import_row where job_id=${jobId}::uuid and ordinal>${after} and state in ('invalid','failed') order by ordinal limit 1000`);
    });
    if(!rows.length){controller.close();return;}
    after=rows[rows.length-1].ordinal;ended=rows.length<1000;
    controller.enqueue(encoder.encode(toCsv(rows.map(row=>[row.ordinal,row.preview?.employeeCode??'',row.preview?.employeeName??'',row.error??row.preview?.errors.join('; ')??'']))));
   }catch{controller.error(new Error('The import error report is unavailable.'));}
  },
 });
 return new Response(body,{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="bank-statutory-errors.csv"','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
}
