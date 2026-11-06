import Link from 'next/link';
import {getFormatter, getTranslations} from 'next-intl/server';
import {scopedAdmin} from '@/lib/scope';
import {listIndividualImportJobs, listIndividualImports} from '@/packs/payroll/service';
import {PageHeader, pageWideCls} from '@/components/ui';

const log = '/payroll/transactions/individual/imports';

export default async function IndividualImportLogPage({searchParams}: {
  searchParams: Promise<{before?: string; beforeId?: string}>;
}) {
  const {s, scopeIds} = await scopedAdmin();
  const t = await getTranslations('payroll.individualImport');
  const f = await getFormatter();
  const params = await searchParams;
  const before = params.before && params.beforeId ? {at: params.before, id: params.beforeId} : undefined;
  const [jobs, legacy] = await Promise.all([
    listIndividualImportJobs(s, scopeIds, before),
    scopeIds.length ? listIndividualImports(s, scopeIds, before, true) : [],
  ]);
  const rows = [
    ...jobs.map(job => ({
      id: job.id, source: job.source_name, method: job.method, at: new Date(job.created_at).toISOString(),
      by: job.created_by, written: job.written, failed: job.failed_rows, total: job.total,
      status: job.state === 'completed' && job.failed_rows ? t('completedWithErrors') : t(`batchState.${job.state}`),
      progress: job.state === 'completed' ? 100 : job.total ? Math.min(99, Math.floor(job.processed * 100 / job.total)) : 0,
      href: `${log}/batches/${job.id}`,
    })),
    ...legacy.map(item => ({
      id: item.id, source: item.sourceName, method: item.method, at: item.createdAt, by: item.createdBy,
      written: item.written, failed: item.state === 'validated' ? item.preview.invalid : item.outcomes.filter(row => row.state !== 'imported').length,
      total: item.preview.total, status: t(item.state), progress: item.state === 'validated' ? null : 100,
      href: `${log}/${item.id}`,
    })),
  ].sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
  const items = rows.slice(0, 100);
  const last = items.at(-1);
  return <div className={pageWideCls}>
    <PageHeader title={t('log')} description={t('logHint')} back={{href: '/payroll/transactions/individual', label: t('back')}}/>
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full text-left text-sm">
        <thead className="bg-muted/50"><tr>{(['reference', 'file', 'method', 'time', 'user', 'outcome', 'progress', 'details'] as const).map(key => <th key={key} className="p-3">{t(key)}</th>)}</tr></thead>
        <tbody>{items.map(item => <tr key={item.id} className="border-t border-border">
          <td className="p-3 font-mono text-xs">{item.id}</td>
          <td className="p-3">{item.source}</td>
          <td className="p-3">{t(item.method)}</td>
          <td className="p-3">{f.dateTime(new Date(item.at), {dateStyle: 'medium', timeStyle: 'short'})}</td>
          <td className="p-3 font-mono text-xs">{item.by}</td>
          <td className="p-3"><p>{item.status}</p><p className="text-xs text-muted-foreground">{t('batchCounts', item)}</p></td>
          <td className="p-3">{item.progress === null ? '—' : `${item.progress}%`}</td>
          <td className="p-3"><Link className="text-primary underline" href={item.href}>{t('details')}</Link></td>
        </tr>)}</tbody>
      </table>
      {!items.length && <p className="p-6 text-muted-foreground">{t('empty')}</p>}
    </div>
    {rows.length > 100 && last && <Link className="mt-4 inline-flex rounded-lg border border-border px-4 py-2" href={`?before=${encodeURIComponent(last.at)}&beforeId=${last.id}`}>{t('older')}</Link>}
  </div>;
}
