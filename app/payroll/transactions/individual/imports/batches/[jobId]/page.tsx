import {notFound} from 'next/navigation';
import Link from 'next/link';
import {getFormatter, getTranslations} from 'next-intl/server';
import {scopedAdmin} from '@/lib/scope';
import {readIndividualImport, readIndividualImportJob} from '@/packs/payroll/service';
import {PageHeader, pageWideCls} from '@/components/ui';
import {IndividualImportRows} from '../../[attemptId]/result-rows';
import {ImportBatchControls} from './batch-controls';

const log = '/payroll/transactions/individual/imports';

export default async function ImportBatchPage({params}: {params: Promise<{jobId: string}>}) {
  const {s, scopeIds} = await scopedAdmin();
  const {jobId} = await params;
  const job = await readIndividualImportJob(s, jobId, scopeIds).catch(() => undefined);
  if (!job) notFound();
  const t = await getTranslations('payroll.individualImport');
  const f = await getFormatter();
  const item = job.attempt_id ? await readIndividualImport(s, job.attempt_id, scopeIds) : null;
  const running = ['pending', 'validating', 'confirmed', 'importing'].includes(job.state);
  const total = item?.preview.total ?? 0;
  const finished = job.state === 'completed';
  const progress = finished ? 100 : total ? Math.min(99, Math.floor(job.processed * 100 / total)) : 0;
  const failedRows = item?.outcomes.filter(row => row.state !== 'imported').length ?? 0;
  const status = finished && failedRows ? t('completedWithErrors') : t(`batchState.${job.state}`);
  const timestamp = (value: Date | string) => f.dateTime(new Date(value), {dateStyle: 'medium', timeStyle: 'short'});
  const periods = [...new Set(item?.records.map(row => row.__pay_period).filter(Boolean))].join(', ');
  const cycles = [...new Set(item?.records.map(row => row.__configured_cycle).filter(Boolean))].join(', ');
  return <div className={pageWideCls}>
    <PageHeader title={job.source_name} back={{href: log, label: t('log')}}/>
    <section className="space-y-3 rounded-xl border border-border p-5">
      <p className="font-mono text-xs">{job.id}</p>
      <p role="status">{status}{running || finished ? ` · ${progress}%` : ''}</p>
      <p>{t('user')}: {job.created_by}</p>
      <p>{t('time')}: {timestamp(job.created_at)}</p>
      {job.started_at && <p>{t('startedAt')}: {timestamp(job.started_at)}</p>}
      {job.finished_at && <p>{t('finishedAt')}: {timestamp(job.finished_at)}</p>}
      {periods && <p>{t('month')}: {periods}</p>}
      {cycles && <p>{t('cycle')}: {cycles}</p>}
      {item && <p>{t('previewCounts', {total, valid: item.preview.valid, invalid: item.preview.invalid})}</p>}
      {finished && item && <p>{t('resultCounts', {written: item.written, failed: failedRows, invalid: 0})}</p>}
      {job.error && <p role="alert" className="text-destructive">{t.has(job.error) ? t(job.error as never) : t('importFailed')}</p>}
      <div className="flex flex-wrap gap-4">
        <a className="text-primary underline" href={`${log}/batches/${job.id}/workbook`}>{t('downloadWorkbook')}</a>
        {item && <Link className="text-primary underline" href={`${log}/${item.id}`}>{t('details')}</Link>}
        {item && (item.preview.invalid || failedRows) > 0 && <a className="text-primary underline" href={`${log}/${item.id}/errors`}>{t('downloadErrors')}</a>}
      </div>
    </section>
    {item && <IndividualImportRows item={item}/>}
    <ImportBatchControls id={job.id} running={running} canConfirm={job.state === 'ready' && s.userId === job.created_by}/>
  </div>;
}
