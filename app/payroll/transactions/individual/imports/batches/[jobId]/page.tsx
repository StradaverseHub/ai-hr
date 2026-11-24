import {notFound} from 'next/navigation';
import Link from 'next/link';
import {getFormatter, getTranslations} from 'next-intl/server';
import {scopedAdmin} from '@/lib/scope';
import {readIndividualImportJob, readIndividualImportSummary} from '@/packs/payroll/service';
import {PageHeader, pageWideCls} from '@/components/ui';
import {Badge} from '@/components/ui/badge';
import {StatCells} from '@/components/ui/stat-cells';
import {individualImportPercent} from '@/lib/individual-import-job';
import {IndividualImportRows} from '../../[attemptId]/result-rows';
import {IndividualImportRevert} from '../../[attemptId]/revert-control';
import {ImportBatchControls} from './batch-controls';
import {formatImportActor, formatImportBatch} from '@/lib/import-reference';

const log = '/payroll/transactions/individual/imports';
const tone = {completed: 'success', reverted: 'default', failed: 'danger', stopped: 'warning', ready: 'warning'} as const;

/** 0ec0ee00 — one batch of the Import Log: progress of a running import or revert, its counts, and one page of rows. */
export default async function ImportBatchPage({params, searchParams}: {params: Promise<{jobId: string}>; searchParams?: Promise<{page?: string}>}) {
  const {s, scopeIds} = await scopedAdmin();
  const {jobId} = await params;
  const page = Math.max(0, Number((await searchParams)?.page ?? 0) || 0);
  const job = await readIndividualImportJob(s, jobId, scopeIds).catch(() => undefined);
  if (!job) notFound();
  const t = await getTranslations('payroll.individualImport');
  const f = await getFormatter();
  const labels = await getTranslations('importLog');
  const item = job.attempt_id ? await readIndividualImportSummary(s, job.attempt_id, scopeIds) : null;
  const running = ['pending', 'validating', 'confirmed', 'importing', 'reverting'].includes(job.state);
  const reverting = job.state === 'reverting';
  const total = item?.total ?? job.total;
  const written = item?.written ?? job.written;
  const failed = item?.failed ?? job.failed_rows;
  const processed = Math.max(job.processed, item?.processed ?? 0);
  const imported = ['confirmed', 'importing', 'completed', 'stopped', 'reverting', 'reverted'].includes(job.state);
  const status = job.state === 'completed' && failed ? t('completedWithErrors') : t(`batchState.${job.state}`);
  const timestamp = (value: Date | string) => f.dateTime(new Date(value), {dateStyle: 'medium', timeStyle: 'short'});
  const number = (value: number) => f.number(value);
  const revertedCount = item?.revertedCount ?? job.reverted_rows;
  const done = reverting ? revertedCount : processed;
  const of = reverting ? written : total;
  const percent = individualImportPercent(done, of, !reverting && job.state === 'completed');
  const canRevert = item && (item.state === 'completed' || item.state === 'stopped') && written - revertedCount > 0;
  return <div className={pageWideCls}>
    <PageHeader title={job.source_name} back={{href: log, label: t('log')}}/>
    {job.source_worksheet&&<p className="break-all text-sm text-muted-foreground">{job.source_worksheet}</p>}
    <section className="space-y-4 rounded-xl border border-border p-5">
      <p className="font-medium">{formatImportBatch(labels, job.id)}</p>
      <p role="status"><Badge variant={tone[job.state as keyof typeof tone] ?? 'info'}>{status}</Badge></p>
      {imported && of > 0 && (running || job.state === 'completed') && <div className="space-y-1">
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
          <div className="h-full rounded-full bg-primary" style={{width: `${percent}%`}}/>
        </div>
        <p className="text-sm text-muted-foreground">{t(reverting ? 'rowsReverted' : 'rowsDone', {percent, done: number(done), total: number(of)})}</p>
      </div>}
      {imported && total > 0 && <StatCells cells={[
        {label: t('totalRows'), value: number(total)},
        {label: t('importedRows'), value: number(written)},
        {label: t('failedRows'), value: number(failed), warn: failed > 0},
        {label: t('remainingRows'), value: number(Math.max(0, total - processed))},
      ]}/>}
      <p>{t('user')}: {formatImportActor(labels, job.created_by_actor)}</p>
      <p>{t('time')}: {timestamp(job.created_at)}</p>
      {job.started_at && <p>{t('startedAt')}: {timestamp(job.started_at)}</p>}
      {job.finished_at && <p>{t('finishedAt')}: {timestamp(job.finished_at)}</p>}
      {item && item.periods.length > 0 && <p>{t('month')}: {item.periods.join(', ')}</p>}
      {item && item.cycles.length > 0 && <p>{t('cycle')}: {item.cycles.join(', ')}</p>}
      {item && !imported && <p>{t('previewCounts', {total, valid: item.valid, invalid: item.invalid})}</p>}
      {job.state === 'stopped' && <p role="alert" className="text-amber-700 dark:text-amber-400">{t('stoppedNotice', {written: number(written - revertedCount)})}</p>}
      {revertedCount > 0 && job.state !== 'reverted' && !reverting && <p>{t('revertPartial', {reverted: number(revertedCount), written: number(written)})}</p>}
      {job.error && job.state !== 'stopped' && <p role="alert" className="text-destructive">{t.has(job.error) ? t(job.error as never) : t('importFailed')}</p>}
      {job.error && job.state === 'stopped' && job.error !== 'importStopped' && <p className="text-sm text-muted-foreground">{t.has(job.error) ? t(job.error as never) : t('importFailed')}</p>}
      {running && <p className="text-sm text-muted-foreground">{t(reverting ? 'leavePageRevert' : 'leavePage')}</p>}
      <div className="flex flex-wrap gap-4">
        <a className="text-primary underline" href={`${log}/batches/${job.id}/workbook`}>{t('downloadWorkbook')}</a>
        {item && <Link className="text-primary underline" href={`${log}/${item.id}`}>{t('details')}</Link>}
        {item?.hasErrors && <a className="text-primary underline" href={`${log}/${item.id}/errors`}>{t('downloadErrors')}</a>}
      </div>
    </section>
    {item && <IndividualImportRows attemptId={item.id} page={page} pageHref={n => `${log}/batches/${job.id}?page=${n}`}/>}
    <ImportBatchControls id={job.id} running={running} canConfirm={job.state === 'ready' && s.userId === job.created_by}/>
    {canRevert && <IndividualImportRevert id={item.id} batch={formatImportBatch(labels, job.id)} file={job.source_name} count={written - revertedCount}/>}
  </div>;
}
