import {notFound} from 'next/navigation';
import {getTranslations} from 'next-intl/server';
import {requireAdmin} from '@/lib/authz';
import {getImportAttempt} from '@/core/import-history';
import {importKindRevertible} from '@/core/import-history-handlers';
import {activeEmployeeImportRevertJob} from '@/core/employee-import-revert-job';
import {activeMovementImportRevertJob} from '@/core/movement-import-revert-job';
import {informationImportLog} from '@/core/information-correction-import';
import {importAttemptStatus} from '@/lib/import-history';
import {PageHeader,pageWideCls} from '@/components/ui';
import {ImportAttemptEvents,ImportAttemptItems,ImportAttemptSummary,InformationImportLog,IMPORT_HISTORY_PATH} from '../import-history-views';
import {ImportRevertControl} from '../import-revert-control';
import {EmployeeImportErrorReport} from '../employee-import-error-report';
import {employeeImportErrorReportFor} from '@/core/employee-import-history';
import {formatImportBatch} from '@/lib/import-reference';
import {employeeFullErrorLogLines} from '@/core/import-error-log-registry';
import {hasImportErrorLog} from '@/lib/import-error-log-kinds';
import {ExportDownloadLink} from '@/components/export-download-link';
/** One import attempt (its Import Log): file, outcome, per-row results, audit trail and (when allowed) Revert. */
export default async function ImportAttemptPage({params,searchParams}:{params:Promise<{attemptId:string}>;searchParams?:Promise<{rows?:string}>}){
 const ctx=await requireAdmin(),t=await getTranslations('people.importHistory'),labels=await getTranslations('importLog');
 const root=await getTranslations(),shared=await getTranslations('importProblems');
 const problemT={problems:(key:string,values?:Record<string,unknown>)=>root(key as never,values as never),shared:(key:string)=>shared(key as never)};
 const{attemptId}=await params,item=await getImportAttempt(ctx,attemptId);if(!item)notFound();
 const status=importAttemptStatus(item.plan,item.events);
 const revertible=(status==='succeeded'||status==='partial')&&importKindRevertible(item.kind);
 // Item 1859cce0 — the employee import's error report, scoped to the viewer's companies (as is the plan's issue list).
 const errorReport=item.kind==='employee_full'?await employeeImportErrorReportFor(ctx,item):null;
 const showAll=(await searchParams)?.rows==='all';
 const summaryItem=errorReport&&!errorReport.full?{...item,plan:{...item.plan,issues:errorReport.scopeIssues(item.plan.issues??[])}}:item;
 // A background revert of this attempt (an employee import or a movement import) that the signed-in user started and
 // that is still running.
 const activeRevert=!revertible?null:item.kind==='employee_full'?await activeEmployeeImportRevertJob(ctx,item.id):item.kind==='movement'?await activeMovementImportRevertJob(ctx,item.id):null;
 return <div className={pageWideCls}><PageHeader title={item.sourceName} description={formatImportBatch(labels,item.id)} back={{href:`${IMPORT_HISTORY_PATH}?kind=${item.kind}`,label:t('title')}}/>
  <ImportAttemptSummary item={summaryItem}/>
  {/* 1859cce0 — the employee import's error report (every row and problem, with the column to correct). */}
  {errorReport&&<EmployeeImportErrorReport attemptId={item.id} report={errorReport.report} problems={employeeFullErrorLogLines(item,errorReport,problemT)} showAll={showAll} full={errorReport.full}/>}
  {/* Board d3ba1e9f — every other kind with a registered Error Log source offers the same download. */}
  {item.kind!=='employee_full'&&hasImportErrorLog(item.kind)&&<p><ExportDownloadLink className="inline-flex rounded-lg border px-4 py-2 text-sm font-medium" href={`${IMPORT_HISTORY_PATH}/${item.id}/error-log`}>{shared('downloadLog')}</ExportDownloadLink></p>}
  {/* ccd3a65c — an Information-Only Correction file lists every row, including rows refused at the check. */}
  {item.kind==='information_correction'?<InformationImportLog rows={await informationImportLog(ctx,item)}/>:<ImportAttemptItems item={item}/>}
  <ImportAttemptEvents item={item}/>
  {revertible&&(item.canRevert?<ImportRevertControl attemptId={item.id} activeJobId={activeRevert?.id??null}/>:<p className="rounded-xl border p-5 text-sm text-muted-foreground">{t('revert.noPermission')}</p>)}
 </div>;
}
