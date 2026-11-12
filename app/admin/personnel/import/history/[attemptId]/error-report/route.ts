import {getTranslations} from 'next-intl/server';
import {requireAdmin} from '@/lib/authz';
import {getImportAttempt} from '@/core/import-history';
import {employeeImportErrorReportFor} from '@/core/employee-import-history';
import {importAttemptStatus} from '@/lib/import-history';
import {toCsv} from '@/lib/csv';
import {employeeImportColumnText,employeeImportProblemText} from '../../employee-import-report-text';
export const runtime='nodejs';
/**
 * Item 1859cce0 — the "Everything — new employees" error report as CSV: batch reference, file name and final status,
 * then one line per problem (and one per row with no problem). Same visibility as the attempt page: an attempt the
 * viewer can see, with rows of the companies the viewer can view (every row for a viewer covering the attempt).
 * Every cell goes through toCsv's csvSafeCell guard, because names and codes come from the uploaded file.
 */
export async function GET(_request:Request,{params}:{params:Promise<{attemptId:string}>}){
 const ctx=await requireAdmin(),{attemptId}=await params;
 const item=await getImportAttempt(ctx,attemptId);
 if(!item||item.kind!=='employee_full')return new Response(null,{status:404});
 const {report}=await employeeImportErrorReportFor(ctx,item);
 const t=await getTranslations('people.importHistory'),root=await getTranslations();
 const resolve=(key:string,fallback:string)=>root.has(key)?root(key):fallback;
 const csv=toCsv([
  [t('errorReport.csvBatch'),item.id],
  [t('errorReport.csvFile'),item.sourceName],
  [t('errorReport.csvStatus'),t(`states.${importAttemptStatus(item.plan,item.events)}`)],
  [],
  [t('errorReport.colRow'),t('errorReport.colCode'),t('errorReport.colName'),t('errorReport.colColumn'),t('errorReport.colProblem'),t('errorReport.csvStage'),t('errorReport.colResult')],
  ...report.lines.map(line=>[line.rowNum,line.employeeCode,line.fullName,employeeImportColumnText(line,resolve),employeeImportProblemText(line,t),line.stage?t(`errorReport.stage.${line.stage}`):'',t(`errorReport.outcome.${line.outcome}`)]),
 ]);
 return new Response('﻿'+csv,{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="import-error-report-${item.id.slice(0,8)}.csv"`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
}
