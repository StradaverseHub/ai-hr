/**
 * Item 1859cce0 — the "Everything — new employees" error report on an Import History attempt: one line for every
 * problem (the row, the employee, the column to correct and what is wrong), whether it was found by the file check or
 * while saving, and what happened to every other row. Data arrives already scoped to the viewer's companies.
 */
import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {ExportDownloadLink} from '@/components/export-download-link';
import type {EmployeeImportReport} from '@/lib/employee-import-report';
import {IMPORT_HISTORY_PATH} from './import-history-views';
import {employeeImportColumnText,employeeImportProblemText} from './employee-import-report-text';

/** Lines rendered on the page at most (the download is not bounded by it). */
export const ERROR_REPORT_PAGE_LINES=500;
export async function EmployeeImportErrorReport({attemptId,report,showAll,full}:{attemptId:string;report:EmployeeImportReport;showAll:boolean;full:boolean}){
 const t=await getTranslations('people.importHistory'),root=await getTranslations();
 const resolve=(key:string,fallback:string)=>root.has(key)?root(key):fallback;
 const problems=report.lines.filter(l=>l.outcome==='refused'||l.outcome==='stopped');
 // A large file renders a bounded page; the CSV download always carries every line the viewer may see.
 const shown=showAll?report.lines:problems,lines=shown.slice(0,ERROR_REPORT_PAGE_LINES);
 const allRows=new Set(report.lines.map(l=>l.rowNum)).size;
 const chip=(selected:boolean)=>`inline-flex min-h-9 items-center rounded-full border px-3 text-sm ${selected?'border-primary bg-primary/10 font-medium text-primary':'text-muted-foreground'}`;
 const base=`${IMPORT_HISTORY_PATH}/${attemptId}`;
 return <section aria-labelledby="error-report-title" className="space-y-4 rounded-xl border p-5">
  <div className="grid gap-3 sm:grid-cols-3">
   <div className="rounded-lg border p-4"><p className="text-2xl font-semibold">{report.counts.saved}</p><p className="text-sm text-muted-foreground">{t('errorReport.saved')}</p></div>
   <div className="rounded-lg border p-4"><p className="text-2xl font-semibold text-destructive">{report.counts.toFix}</p><p className="text-sm text-muted-foreground">{t('errorReport.toFix')}</p></div>
   <div className="rounded-lg border p-4"><p className="text-2xl font-semibold">{report.counts.cancelled}</p><p className="text-sm text-muted-foreground">{t('errorReport.cancelled')}</p></div>
  </div>
  {report.cancelledWhileSaving&&<div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
   <p className="font-semibold">{t('errorReport.cancelledTitle')}</p>
   <p>{report.stoppedBy.length?t('errorReport.cancelledBody',{rows:report.stoppedBy.join(', ')}):t('errorReport.stoppedBody')}</p>
  </div>}
  <div className="flex flex-wrap items-start justify-between gap-3">
   <div><h2 id="error-report-title" className="font-semibold">{t('errorReport.title')}</h2><p className="text-sm text-muted-foreground">{t('errorReport.hint')}</p></div>
   <ExportDownloadLink className="inline-flex rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground" href={`${base}/error-report`}>{t('errorReport.download')}</ExportDownloadLink>
  </div>
  {!full&&<p className="text-xs text-muted-foreground">{t('errorReport.restricted')}</p>}
  <nav aria-label={t('errorReport.filterLabel')} className="flex flex-wrap gap-2">
   <Link className={chip(!showAll)} href={base} aria-current={!showAll?'page':undefined}>{t('errorReport.problemRows',{count:new Set(problems.map(l=>l.rowNum)).size})}</Link>
   <Link className={chip(showAll)} href={`${base}?rows=all`} aria-current={showAll?'page':undefined}>{t('errorReport.allRows',{count:allRows})}</Link>
  </nav>
  {lines.length===0?<p className="text-sm">{showAll?t('errorReport.noRows'):t('errorReport.noProblems')}</p>:
  <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="bg-muted/50"><tr>{['colRow','colCode','colName','colColumn','colProblem','colResult'].map(k=><th key={k} scope="col" className="p-3">{t(`errorReport.${k}`)}</th>)}</tr></thead>
   <tbody>{lines.map((line,i)=><tr key={`${line.rowNum}-${i}`} className="border-t align-top">
    <td className="p-3">{line.rowNum}</td>
    <td className="p-3 font-mono text-xs">{line.employeeCode||'—'}</td>
    <td className="p-3">{line.fullName||'—'}</td>
    <td className="p-3">{employeeImportColumnText(line,resolve)||'—'}</td>
    <td className="p-3"><p className={line.outcome==='refused'||line.outcome==='stopped'?'text-destructive':''}>{employeeImportProblemText(line,t)}</p>
     {line.stage&&<p className="text-xs text-muted-foreground">{t(`errorReport.stage.${line.stage}`)}</p>}</td>
    <td className="p-3"><span className={`inline-flex rounded-full px-2 py-0.5 text-xs ${line.outcome==='stopped'?'bg-destructive/10 text-destructive':'bg-muted'}`}>{t(`errorReport.outcome.${line.outcome}`)}</span></td>
   </tr>)}</tbody></table></div>}
  {shown.length>lines.length&&<p className="text-sm text-muted-foreground">{t('errorReport.truncated',{shown:lines.length,total:shown.length})}</p>}
  <p className="text-xs text-muted-foreground">{t('errorReport.rowsHint')}</p>
 </section>;
}
