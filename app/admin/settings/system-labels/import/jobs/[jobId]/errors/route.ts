import {getTranslations} from 'next-intl/server';
import {scopedAdmin} from '@/lib/scope';
import {readSystemLabelImportProblems,SystemLabelImportJobError,type SystemLabelImportProblemSource} from '@/core/system-label-import-job';
import {IMPORT_PROBLEM_SCREEN_LIMIT,sortProblemLines} from '@/lib/import-problem-lines';
import {importProblemWorkbook} from '@/lib/import-problem-workbook';
import {labelJobProblemLines,labelProblemTranslator,type LabelProblemTranslator} from '@/lib/system-label-import-problems';
export const runtime='nodejs';
type Params={params:Promise<{jobId:string}>};
const noStore={'Cache-Control':'private, no-store'};

/**
 * Board c074c6b8: the rows a finished System Labels import did not import (or that stopped it), from what the worker
 * stored for that job: the first IMPORT_PROBLEM_SCREEN_LIMIT lines as JSON, or every line as the Error Log with
 * ?format=xlsx. Same scope as the progress route: the creator's own job while their access lasts (bulk_job row
 * security), one bounded read of that row and no per-row queries.
 */
export async function GET(request:Request,{params}:Params){
 const {s}=await scopedAdmin();
 let source:SystemLabelImportProblemSource;
 try{source=await readSystemLabelImportProblems(s,(await params).jobId);}
 catch(error){const status=error instanceof SystemLabelImportJobError?error.status:404;return Response.json({error:'Import unavailable.'},{status:status===400?404:status,headers:noStore});}
 const t=await getTranslations() as unknown as LabelProblemTranslator;
 const lines=sortProblemLines(labelJobProblemLines(source,t));
 if(new URL(request.url).searchParams.get('format')==='xlsx'){
  if(source.legacy)return Response.json({error:'legacy'},{status:409,headers:noStore});
  return new Response(new Uint8Array(importProblemWorkbook({lines,t:labelProblemTranslator(t)})),{headers:{...noStore,
   'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
   'Content-Disposition':'attachment; filename="system-labels-errors.xlsx"','X-Content-Type-Options':'nosniff'}});
 }
 return Response.json({lines:lines.slice(0,IMPORT_PROBLEM_SCREEN_LIMIT),total:lines.length,legacy:source.legacy},{headers:noStore});
}
