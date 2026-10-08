import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { Button, PageHeader, inputCls } from '@/components/ui';
import { getClockingImportRun, listClockingImportRuns } from '@/packs/attendance/service';
import { formatDmy, formatDmyTime } from '@/lib/date-display';
import { lineMessage, ResultPill } from '../../line-view';
import { RunStatusPill } from '../run-status';
import { RunsTable } from '../runs-table';

const PAGE_SIZE = 200;

/**
 * r424 (50ed39e1) — one import's log: who, when, which file and mapping, the reporter's counts (Failed =
 * duplicates + unmatched card ids + invalid date/time + other errors), and every line not imported with
 * its line number, card id, employee where known and the reason. Kept permanently; the file is not.
 */
export default async function ClockingImportLogPage({
  params,
  searchParams,
}: {
  params: Promise<{ runId: string }>;
  searchParams: Promise<{ tab?: string; reason?: string; page?: string }>;
}) {
  const s = await requireAdmin();
  const { runId } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(runId)) notFound();
  const [data, recent] = await Promise.all([getClockingImportRun(s, runId), listClockingImportRuns(s, { limit: 10 })]);
  if (!data) notFound();
  const t = await getTranslations('clockingFile');
  const { run, lines } = data;

  const tab = sp.tab === 'imported' ? 'imported' : 'errors';
  const notImported = lines.filter((l) => l.result !== 'imported');
  const imported = lines.filter((l) => l.result === 'imported');
  const reasons = [...new Set(notImported.map((l) => l.result))];
  const reason = tab === 'errors' && sp.reason && reasons.includes(sp.reason as never) ? sp.reason : '';
  const pool = tab === 'imported' ? imported : notImported.filter((l) => !reason || l.result === reason);
  const pages = Math.max(1, Math.ceil(pool.length / PAGE_SIZE));
  const page = Math.min(pages, Math.max(1, Math.floor(Number(sp.page) || 1)));
  const shown = pool.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const href = (p: Record<string, string | number | undefined>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries({ tab, reason: reason || undefined, ...p })) if (v !== undefined && v !== '') u.set(k, String(v));
    return `/attendance/import/logs/${run.id}?${u.toString()}`;
  };

  const meta = 'text-xs text-muted-foreground';
  const tile = (value: number, label: string, warn = false) => (
    <div className="border-b border-r border-border p-4">
      <div className={`text-2xl font-semibold tabular-nums ${warn && value > 0 ? 'text-destructive' : ''}`}>{value.toLocaleString('en')}</div>
      <div className="mt-1 text-[11px] uppercase tracking-widest text-muted-foreground">{label}</div>
    </div>
  );

  return (
    <div className="mx-auto max-w-[90rem] space-y-6">
      <PageHeader
        back={{ href: '/attendance/import/logs', label: t('log.back') }}
        title={run.fileName || '—'}
        description={t('log.intro')}
        actions={<RunStatusPill status={run.status} label={t(`runStatus.${run.status}`)} />}
      />

      <dl className="grid gap-4 border-y border-border py-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <dt className={meta}>{t('log.at')}</dt>
          <dd className="font-medium tabular-nums">{formatDmyTime(run.createdAt)}</dd>
        </div>
        <div className="min-w-0">
          <dt className={meta}>{t('log.fileName')}</dt>
          <dd className="break-all font-medium">{run.fileName || '—'}</dd>
        </div>
        <div>
          <dt className={meta}>{t('log.mappingName')}</dt>
          <dd className="font-medium">{run.mappingName || '—'}</dd>
        </div>
        <div>
          <dt className={meta}>{t('log.user')}</dt>
          <dd className="font-medium">{run.userName ?? t('logs.unknownUser')}</dd>
        </div>
      </dl>

      {run.failureReason && (
        <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {t('log.failedReason', { reason: run.failureReason })}
        </div>
      )}

      <div className="grid grid-cols-2 border-l border-t border-border lg:grid-cols-4">
        {tile(run.totalLines, t('log.total'))}
        {tile(run.validLines, t('log.valid'))}
        {tile(run.importedLines, t('log.imported'))}
        {tile(run.failedLines, t('log.failed'), true)}
        {tile(run.duplicateLines, t('log.duplicates'), true)}
        {tile(run.unmatchedCardLines, t('log.unmatched'), true)}
        {tile(run.invalidDatetimeLines, t('log.invalidDateTime'), true)}
        {tile(run.otherErrorLines, t('log.otherErrors'), true)}
      </div>
      <p className="text-sm text-muted-foreground">{t('log.formula', { days: run.daysUpdated, employees: run.employeesUpdated })}</p>

      <div className="flex flex-wrap items-end justify-between gap-3 border-t border-border pt-4">
        <div className="flex gap-4 text-sm">
          <Link
            href={href({ tab: 'errors', reason: undefined })}
            className={`border-b-2 pb-1 ${tab === 'errors' ? 'border-foreground font-medium' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
          >
            {t('log.tabNotImported', { count: notImported.length.toLocaleString('en') })}
          </Link>
          <Link
            href={href({ tab: 'imported', reason: undefined })}
            className={`border-b-2 pb-1 ${tab === 'imported' ? 'border-foreground font-medium' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
          >
            {t('log.tabImported', { count: imported.length.toLocaleString('en') })}
          </Link>
        </div>
        {tab === 'errors' && reasons.length > 0 && (
          <form method="get" className="flex items-center gap-2">
            <input type="hidden" name="tab" value="errors" />
            <select name="reason" defaultValue={reason} className={`${inputCls} w-64`} aria-label={t('log.allReasons')}>
              <option value="">{t('log.allReasons')}</option>
              {reasons.map((r) => (
                <option key={r} value={r}>
                  {t(`resultShort.${r}`)}
                </option>
              ))}
            </select>
            <Button type="submit" variant="outline">
              {t('log.filter')}
            </Button>
          </form>
        )}
      </div>

      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">{t('log.colLine')}</th>
              <th className="px-3 py-2 font-medium">{t('log.colCardId')}</th>
              <th className="px-3 py-2 font-medium">{t('log.colEmployee')}</th>
              <th className="px-3 py-2 font-medium">{t('log.colDate')}</th>
              <th className="px-3 py-2 font-medium">{t('log.colTime')}</th>
              <th className="px-3 py-2 font-medium">{tab === 'errors' ? t('log.colError') : t('log.colInOut')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {shown.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                  {t('log.noLines')}
                </td>
              </tr>
            )}
            {shown.map((l) => (
              <tr key={l.lineNo}>
                <td className="px-3 py-2 tabular-nums text-muted-foreground">{l.lineNo.toLocaleString('en')}</td>
                <td className="px-3 py-2 font-mono text-xs">{l.cardRef || '—'}</td>
                <td className="px-3 py-2">{l.employeeName ?? '—'}</td>
                <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                  {l.punchDate ? formatDmy(l.punchDate) : l.result === 'invalid_date' ? l.message || '—' : '—'}
                </td>
                <td className="px-3 py-2 tabular-nums">
                  {l.punchTime ? l.punchTime.slice(0, 5) : l.result === 'invalid_time' ? l.message || '—' : '—'}
                </td>
                <td className="px-3 py-2">
                  {tab === 'errors' ? (
                    <span className="inline-flex flex-wrap items-center gap-2">
                      <ResultPill result={l.result} label={t(`resultShort.${l.result}`)} />
                      <span>{lineMessage(t, { result: l.result, detail: l.result === 'duplicate' || l.result === 'unknown_in_out_code' ? l.message : '' })}</span>
                    </span>
                  ) : l.direction ? (
                    t(`dirShort.${l.direction}`)
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
        <span>{t('log.showing', { shown: shown.length.toLocaleString('en'), total: pool.length.toLocaleString('en') })}</span>
        {pages > 1 && (
          <span className="flex gap-3">
            {page > 1 && <Link className="text-primary" href={href({ page: page - 1 })}>{t('log.prev')}</Link>}
            <span>
              {page} / {pages}
            </span>
            {page < pages && <Link className="text-primary" href={href({ page: page + 1 })}>{t('log.next')}</Link>}
          </span>
        )}
        {tab === 'errors' && notImported.length > 0 && <span>{t('log.fixHint')}</span>}
      </div>

      <section className="space-y-3 border-t border-border pt-4">
        <h2 className="text-xs font-medium uppercase tracking-widest text-muted-foreground">{t('logs.recent')}</h2>
        <RunsTable runs={recent} currentId={run.id} />
      </section>
    </div>
  );
}
