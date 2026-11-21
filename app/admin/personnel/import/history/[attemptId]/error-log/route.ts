import {getLocale,getTranslations} from 'next-intl/server';
import {requireAdmin} from '@/lib/authz';
import {importErrorLogEntry,importErrorLogSourceFor} from '@/core/import-error-log-registry';
import {importProblemWorkbook} from '@/lib/import-problem-workbook';
import {formatImportBatch} from '@/lib/import-reference';
import {GET as bankErrorLog} from '../../../bank-statutory/jobs/[jobId]/error-log/route';
export const runtime='nodejs';
/**
 * Board d3ba1e9f — the standard Error Log (.xlsx) of any Import History entry (an import attempt or a section run)
 * whose kind has a registered source (core/import-error-log-registry.ts), in the viewer's language. Same visibility
 * as the entry's own page: the source reads it through the page's reader and its company scoping, so a viewer who
 * cannot see a company sees none of its lines. One bounded read per entry; reads never take the exclusive Access
 * lock. The Summary sheet says when the entry kept only the first problems.
 */
export async function GET(request:Request,{params}:{params:Promise<{attemptId:string}>}){
 const ctx=await requireAdmin(),{attemptId}=await params;
 const entry=await importErrorLogEntry(ctx,attemptId);
 const source=entry?importErrorLogSourceFor(entry):undefined;
 if(!entry||!source)return new Response(null,{status:404});
 const locale=await getLocale();
 const [root,shared,labels,kinds]=await Promise.all([getTranslations({locale}),getTranslations({locale,namespace:'importProblems'}),getTranslations({locale,namespace:'importLog'}),getTranslations({locale,namespace:'people.importHistory'})]);
 const t={problems:(key:string,values?:Record<string,unknown>)=>root(key as never,values as never),shared:(key:string)=>shared(key as never)};
 const log=await source(ctx,attemptId,t);
 if(!log)return new Response(null,{status:404});
 // Bank and Statutory keeps only its first lines here; serve the job's complete streamed log (same visibility checks).
 if(log.bankJobId)return bankErrorLog(request,{params:Promise.resolve({jobId:log.bankJobId})});
 const summary:[string,string|number][]=[
  [t.shared('summary.batch'),formatImportBatch(labels,attemptId)],
  [t.shared('summary.file'),entry.sourceName||kinds('pasted')],
  [kinds('type'),entry.kind?kinds(`kinds.${entry.kind}`):kinds('kinds.notRecorded')],
  [t.shared('summary.problems'),log.total],
  ...(log.truncated?[[t.shared('summary.truncated'),log.lines.length] as [string,number]]:[]),
 ];
 const bytes=importProblemWorkbook({lines:log.lines,t:t.shared,summary});
 return new Response(new Uint8Array(bytes),{headers:{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'Content-Disposition':`attachment; filename="import-error-log-${attemptId.slice(0,8)}.xlsx"`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
}
