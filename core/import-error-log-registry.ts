/**
 * Board d3ba1e9f — which Import History entries can be downloaded as the standard Error Log (.xlsx), and where each
 * kind's lines come from. The download route (app/admin/personnel/import/history/[attemptId]/error-log) resolves the
 * entry's kind, calls the kind's source and writes the workbook with the shared writer; the Import History list and
 * the entry pages show the "Download Error Log" link for every kind registered here.
 *
 * A source reads the entry the way its own Import History page does (same visibility and company scoping, bounded
 * reads, never the exclusive Access lock) and turns what the entry already recorded into ImportProblemLine rows with
 * the kind's adapter — the same adapter its screen uses. It returns null when the viewer may not see the entry (or it
 * is of another kind), which the route answers with 404.
 */
import {eq} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {importAttempt} from '../db/schema';
import type {ImportProblemLine} from '../lib/import-problem-lines';
import {isImportKind,isImportRunKind,type ImportHistoryKind} from '../lib/import-history';
import {isImportErrorLogKind,type ImportErrorLogKind} from '../lib/import-error-log-kinds';
export {hasImportErrorLog} from '../lib/import-error-log-kinds';
import {employeeHistoryProblemLines} from '../lib/employee-import-problems';
import {sectionRunProblemLines} from '../lib/section-import-problems';
import {getImportAttempt,getImportRun} from './import-history';
import {employeeImportErrorReportFor} from './employee-import-history';
import {bankStatutoryErrorLogFor} from './bank-statutory-error-log';
import {costAllocationErrorLogFor} from './cost-allocation-error-log';
import {informationCorrectionErrorLogFor} from './information-correction-error-log';
import {movementErrorLogFor} from './movement-error-log';

/** `problems`: the ROOT translator in the request locale (full keys); `shared`: the importProblems translator. */
export type ImportErrorLogTranslate={problems:(key:string,values?:Record<string,unknown>)=>string;shared:(key:string)=>string};
/** One kind's Error Log lines for one Import History entry, or null when the viewer may not see it. `total` is the
 *  number of problems the entry recorded; `truncated` says the entry kept only the first of them. */
/** `bankJobId`: the entry keeps only its first lines because the COMPLETE log is streamed from storage (Bank and
 *  Statutory). The download route then serves that streamed log itself, not a shortened file. (No redirect: the
 *  download hook refuses redirects by design.) */
export type ImportErrorLogSource=(ctx:SessionContext,attemptId:string,t:ImportErrorLogTranslate)=>Promise<{lines:ImportProblemLine[];total:number;truncated:boolean;bankJobId?:string}|null>;

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "Everything — new employees": the attempt's validated plan rows and its save report, scoped to the viewer's
 *  companies exactly as the attempt page (a viewer who does not cover every company sees only their companies' rows
 *  and none of the whole-file sentences, which may quote other companies' rows). */
export const employeeFullErrorLog:ImportErrorLogSource=async(ctx,attemptId,t)=>{
 const item=await getImportAttempt(ctx,attemptId);
 if(!item||item.kind!=='employee_full')return null;
 const lines=employeeFullErrorLogLines(item,await employeeImportErrorReportFor(ctx,item),t);
 return{lines,total:lines.length,truncated:false};
};
/** The attempt page renders these same lines (it already holds the attempt and its scoped report). */
export function employeeFullErrorLogLines(item:{plan:{issues?:{rowNum:number;reason:string}[]};events:readonly {kind:string;detail:Record<string,unknown>}[]},scoped:Awaited<ReturnType<typeof employeeImportErrorReportFor>>,t:ImportErrorLogTranslate){
 const failed=[...item.events].reverse().find(e=>e.kind==='failed');
 return employeeHistoryProblemLines({report:scoped.report,fileIssues:scoped.scopeIssues(item.plan.issues??[]),failure:scoped.full&&typeof failed?.detail.message==='string'?failed.detail.message:null},t);
}

/** Profile, Family, Qualifications and Emergency Contacts runs: the rows the run kept (at most 200, as before). */
export const sectionRunErrorLog:ImportErrorLogSource=async(ctx,runId,t)=>{
 const run=await getImportRun(ctx,runId);
 // A run recorded before its type was (migration 5123) is still a section run; its columns read as the employee sheet.
 if(!run)return null;
 const lines=sectionRunProblemLines({kind:run.kind,errors:run.errors},t);
 return{lines,total:Math.max(run.failedRows,run.errors.length),truncated:run.errorsTruncated};
};

/** Bank and Statutory: the first page for the entry pages; the complete log is the job's streamed Error Log. */
export const bankStatutoryErrorLog:ImportErrorLogSource=async(ctx,attemptId,t)=>{
 const log=await bankStatutoryErrorLogFor(ctx,attemptId,t);
 if(!log)return null;
 const {jobId,...rest}=log;
 return{...rest,bankJobId:jobId};
};

/** Import kind -> Error Log source. */
export const IMPORT_ERROR_LOG_SOURCES:Record<ImportErrorLogKind,ImportErrorLogSource>={
 employee_full:employeeFullErrorLog,
 profile:sectionRunErrorLog,
 family:sectionRunErrorLog,
 qualification:sectionRunErrorLog,
 emergency:sectionRunErrorLog,
 bank_statutory:bankStatutoryErrorLog,
 cost_allocations:costAllocationErrorLogFor,
 information_correction:informationCorrectionErrorLogFor,
 movement:movementErrorLogFor,
};

/** The source for an entry: its kind's, or (a run recorded before its type was) the section run source. */
export const importErrorLogSourceFor=(entry:{kind:ImportHistoryKind|null;source:'attempt'|'run'}):ImportErrorLogSource|undefined=>entry.kind?(isImportErrorLogKind(entry.kind)?IMPORT_ERROR_LOG_SOURCES[entry.kind]:undefined):entry.source==='run'?sectionRunErrorLog:undefined;

/** The entry's kind and file name, read as its own page reads it: an attempt the viewer can see (RLS) or a run the
 *  viewer's company access shows. One small read; no rows, items or file content. */
export async function importErrorLogEntry(ctx:SessionContext,id:string):Promise<{kind:ImportHistoryKind|null;source:'attempt'|'run';sourceName:string}|null>{
 if(!uuid.test(id))return null;
 const [row]=await withTenant(ctx,tx=>tx.select({kind:importAttempt.kind,sourceName:importAttempt.sourceName}).from(importAttempt).where(eq(importAttempt.id,id)));
 if(row)return isImportKind(row.kind)?{kind:row.kind,source:'attempt',sourceName:row.sourceName}:null;
 const run=await getImportRun(ctx,id);
 return run?{kind:isImportRunKind(run.kind)?run.kind:null,source:'run',sourceName:run.fileName}:null;
}
