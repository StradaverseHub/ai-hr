import {Readable} from 'node:stream';
import {getTranslations} from 'next-intl/server';
import {requireAdmin} from '@/lib/authz';
import {bankErrorLogColumns,bankErrorLogJob,bankErrorLogPages} from '@/core/bank-statutory-error-log';
import {bankImportHttpError} from '@/lib/bank-import-http';
import {bankJobProblemLine} from '@/lib/bank-import-problems';
import {importProblemText} from '@/lib/import-problem-rules';
import {importProblemWorkbookStream} from '@/lib/import-problem-workbook-stream';
export const runtime='nodejs';
/**
 * d3ba1e9f — the Bank and Statutory Error Log (.xlsx), streamed from storage: up to 250,000 rows are read in pages of
 * 1,000 (plain reads, never the Access lock) and written as they are read, so the log is never built in memory.
 * Same visibility as the progress screen (the job's creator, while they can view every company of the job).
 */
export async function GET(_request:Request,{params}:{params:Promise<{jobId:string}>}){
 const ctx=await requireAdmin(),{jobId}=await params;
 let job:Awaited<ReturnType<typeof bankErrorLogJob>>;try{job=await bankErrorLogJob(ctx,jobId);}catch(error){return bankImportHttpError(error);}
 const root=await getTranslations(),shared=await getTranslations('importProblems'),text=importProblemText(root);
 const fileLine=bankJobProblemLine(job.error,text),columns=bankErrorLogColumns(fileLine);
 const problems=job.invalid+job.failed+(fileLine?1:0);
 const pages=(async function*(){
  try{yield* bankErrorLogPages(ctx,job.id,fileLine,text);}
  catch(error){console.error('[bank import error log]',error);throw new Error('The import Error Log is unavailable.');}
 })();
 const stream=importProblemWorkbookStream({pages,columns,t:shared,summary:[[shared('summary.batch'),job.attempt_id??job.id],[shared('summary.file'),job.source_name],[shared('summary.status'),root(`people.import.background.${job.state}`)],[shared('summary.problems'),problems]]});
 return new Response(Readable.toWeb(stream as Readable) as ReadableStream<Uint8Array>,{headers:{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':`attachment; filename="bank-statutory-error-log-${job.id.slice(0,8)}.xlsx"`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
}
