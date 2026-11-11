import {notFound} from 'next/navigation';
import {getTranslations,getFormatter} from 'next-intl/server';
import {requireAdmin} from '@/lib/authz';
import {getImportRun} from '@/core/import-history';
import {PageHeader,pageWideCls} from '@/components/ui';
import {ImportStatusText,historyCellCls,historyHeadCls,historyTableCls,IMPORT_HISTORY_PATH} from '../../import-history-views';
import {RunErrorsDownload,RunErrorReasons} from './run-errors-download';
import {personnelColumnLabel} from '@/lib/personnel-import-contract';
const dateTime={dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kuala_Lumpur'} as const;
/**
 * ccd3a65c — the Import Log of a section import (Profile, Family, Qualifications, Emergency Contacts). These
 * imports keep a run summary and the rows that were not saved (identity and reason, never the file), so this
 * shows exactly that. Visible by the viewer's company access (core/import-history getImportRun).
 */
export default async function ImportRunPage({params}:{params:Promise<{runId:string}>}){
 const ctx=await requireAdmin(),t=await getTranslations('people.importHistory'),format=await getFormatter();
 const{runId}=await params,run=await getImportRun(ctx,runId);if(!run)notFound();
 // 1859cce0 — the column of each problem (template caption) where the run recorded it, aligned with `errors`.
 const root=await getTranslations(),resolve=(key:string,fallback:string)=>root.has(key)?root(key):fallback;
 const columns=run.errors.map(error=>error.errors.map((_,i)=>{const column=Array.isArray(error.issues)?error.issues[i]?.column:undefined;return column?personnelColumnLabel(column,'employee',resolve):'';}));
 return <div className={pageWideCls}><PageHeader title={run.fileName||t('pasted')} description={t('referenceLabel',{reference:run.id})} back={{href:run.kind?`${IMPORT_HISTORY_PATH}?kind=${run.kind}`:IMPORT_HISTORY_PATH,label:t('title')}}/>
  <section className="space-y-4 rounded-xl border bg-card p-5"><dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
   <div><dt className="text-muted-foreground">{t('type')}</dt><dd>{run.kind?t(`kinds.${run.kind}`):t('kinds.notRecorded')}</dd></div>
   <div><dt className="text-muted-foreground">{t('status')}</dt><dd><ImportStatusText status={run.status}/></dd></div>
   <div><dt className="text-muted-foreground">{t('time')}</dt><dd>{format.dateTime(run.createdAt,dateTime)}</dd></div>
   <div><dt className="text-muted-foreground">{t('user')}</dt><dd title={run.createdBy??undefined}>{run.createdByName??t('unknownUser')}</dd></div>
   <div><dt className="text-muted-foreground">{t('companies')}</dt><dd>{run.companies.join(', ')||'—'}</dd></div>
   <div><dt className="text-muted-foreground">{t('totalRows')}</dt><dd className="tabular-nums">{run.totalRows}</dd></div>
   <div><dt className="text-muted-foreground">{t('successful')}</dt><dd className="tabular-nums">{run.importedRows}</dd></div>
   <div><dt className="text-muted-foreground">{t('failed')}</dt><dd className="tabular-nums">{run.failedRows}</dd></div>
  </dl><p className="text-xs text-muted-foreground">{t('run.noFile')}</p></section>
  <section className="space-y-3 rounded-xl border bg-card p-5">
   <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-semibold">{t('run.failedTitle')}</h2>
    <p className="text-sm text-muted-foreground">{run.errorsTruncated?t('run.truncated',{shown:run.errors.length,total:run.failedRows}):t('run.hint')}</p></div>
    {run.errors.length>0&&<RunErrorsDownload errors={run.errors} columns={columns}/>}</div>
   {run.errors.length===0?<p className="text-sm">{run.failedRows>0?t('run.noDetail'):t('run.none')}</p>:<div className="overflow-x-auto"><table className={historyTableCls}><thead className={historyHeadCls}><tr><th scope="col" className={historyCellCls}>{t('log.row')}</th><th scope="col" className={historyCellCls}>{t('log.employee')}</th><th scope="col" className={historyCellCls}>{t('log.result')}</th><th scope="col" className={historyCellCls}>{t('run.reasonColumn')}</th></tr></thead>
    <tbody>{run.errors.map((error,index)=><tr key={error.rowNum} className="border-t align-top"><td className={historyCellCls+' tabular-nums'}>{error.rowNum}</td><td className={historyCellCls}>{[error.employeeCode,error.fullName,error.email].filter(Boolean).join(' · ')||'—'}</td><td className={historyCellCls}>{error.outcome==='cancelled'?<span className="font-medium">{t('errorReport.outcome.cancelled')}</span>:<span className="font-medium text-destructive">{t('log.notSaved')}</span>}</td><td className={historyCellCls}><RunErrorReasons errors={error.errors} columns={columns[index]} cancelled={error.outcome==='cancelled'}/></td></tr>)}</tbody></table></div>}
  </section>
 </div>;
}
