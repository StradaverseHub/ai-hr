import {notFound} from 'next/navigation';
import {getTranslations,getFormatter} from 'next-intl/server';
import {requireAdmin} from '@/lib/authz';
import {getImportRun} from '@/core/import-history';
import {PageHeader,pageWideCls} from '@/components/ui';
import {ImportStatusText,IMPORT_HISTORY_PATH} from '../../import-history-views';
import {formatImportActor,formatImportBatch} from '@/lib/import-reference';
import {ExportDownloadLink} from '@/components/export-download-link';
import {ImportProblemTable} from '@/components/import-problem-table';
import {sectionRunProblemLines} from '@/lib/section-import-problems';
const dateTime={dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kuala_Lumpur'} as const;
/**
 * ccd3a65c — the Import Log of a section import (Profile, Family, Qualifications, Emergency Contacts). These
 * imports keep a run summary and the rows that were not saved (identity and reason, never the file), so this
 * shows exactly that. Visible by the viewer's company access (core/import-history getImportRun).
 */
export default async function ImportRunPage({params}:{params:Promise<{runId:string}>}){
 const ctx=await requireAdmin(),t=await getTranslations('people.importHistory'),format=await getFormatter(),labels=await getTranslations('importLog');
 const{runId}=await params,run=await getImportRun(ctx,runId);if(!run)notFound();
 // Board d3ba1e9f — the rows the run kept, as the same Error Log lines the download carries (route error-log).
 const root=await getTranslations(),shared=await getTranslations('importProblems');
 const lines=sectionRunProblemLines({kind:run.kind,errors:run.errors},{problems:(key,values)=>root(key as never,values as never),shared:key=>shared(key as never)});
 return <div className={pageWideCls}><PageHeader title={run.fileName||t('pasted')} description={formatImportBatch(labels,run.id)} back={{href:run.kind?`${IMPORT_HISTORY_PATH}?kind=${run.kind}`:IMPORT_HISTORY_PATH,label:t('title')}}/>
  <section className="space-y-4 rounded-xl border bg-card p-5"><dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
   <div><dt className="text-muted-foreground">{t('type')}</dt><dd>{run.kind?t(`kinds.${run.kind}`):t('kinds.notRecorded')}</dd></div>
   <div><dt className="text-muted-foreground">{t('status')}</dt><dd><ImportStatusText status={run.status}/></dd></div>
   <div><dt className="text-muted-foreground">{t('time')}</dt><dd>{format.dateTime(run.createdAt,dateTime)}</dd></div>
   <div><dt className="text-muted-foreground">{t('user')}</dt><dd>{formatImportActor(labels,run.createdByActor)}</dd></div>
   <div><dt className="text-muted-foreground">{t('companies')}</dt><dd>{run.companies.join(', ')||'—'}</dd></div>
   <div><dt className="text-muted-foreground">{t('totalRows')}</dt><dd className="tabular-nums">{run.totalRows}</dd></div>
   <div><dt className="text-muted-foreground">{t('successful')}</dt><dd className="tabular-nums">{run.importedRows}</dd></div>
   <div><dt className="text-muted-foreground">{t('failed')}</dt><dd className="tabular-nums">{run.failedRows}</dd></div>
  </dl><p className="text-xs text-muted-foreground">{t('run.noFile')}</p></section>
  <section className="space-y-3 rounded-xl border bg-card p-5">
   <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-semibold">{t('run.failedTitle')}</h2>
    <p className="text-sm text-muted-foreground">{run.errorsTruncated?t('run.truncated',{shown:run.errors.length,total:run.failedRows}):t('run.hint')}</p></div>
    <ExportDownloadLink className="inline-flex min-h-9 items-center rounded-lg border border-border px-3 text-sm font-medium" href={`${IMPORT_HISTORY_PATH}/${run.id}/error-log`}>{shared('downloadLog')}</ExportDownloadLink></div>
   {lines.length===0?<p className="text-sm">{run.failedRows>0?t('run.noDetail'):t('run.none')}</p>:<ImportProblemTable lines={lines} caption={t('run.failedTitle')}/>}
  </section>
 </div>;
}
