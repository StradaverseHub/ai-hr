import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { Button, PageHeader, inputCls } from '@/components/ui';
import { getClockingImportRun, listClockingImportRuns } from '@/packs/attendance/service';
import { formatDmy, formatDmyTime } from '@/lib/date-display';
import { LabelValue, LabelValueList, SectionCard, SubHeading, typeHelpCls } from '@/components/ui/section-card';
import { StackedBody, StackedHead, StackedRow, StackedTable, StackedTd, StackedTh } from '@/components/ui/stacked-table';
import { StatCells } from '@/components/ui/stat-cells';
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

  // r427 (50ed39e1 contest) — LOOK ONLY: four separate sections (details, counts, lines, recent imports), never
  // one inside another. Same figures, tabs, reason filter and 200-line pages as r424.
  const tabCls = (on: boolean) =>
    `border-b-2 pb-1 ${on ? 'border-foreground font-medium monolith:border-ink' : 'border-transparent text-muted-foreground hover:text-foreground monolith:text-mid'}`;
  const part = (value: number) => (
    <span className={`tabular-nums monolith:font-mono ${value > 0 ? 'text-destructive monolith:text-signal-text' : ''}`}>{value.toLocaleString('en')}</span>
  );

  return (
    <div className="mx-auto max-w-[90rem] space-y-6">
      <PageHeader
        back={{ href: '/attendance/import/logs', label: t('log.back') }}
        title={run.fileName || '—'}
        description={t('log.intro')}
        actions={<RunStatusPill status={run.status} label={t(`runStatus.${run.status}`)} />}
      />

      <SectionCard index={1} title={t('sec.importDetails')}>
        <LabelValueList columns={2}>
          <LabelValue label={t('log.at')} value={<span className="tabular-nums">{formatDmyTime(run.createdAt)}</span>} />
          <LabelValue label={t('log.fileName')} value={<span className="break-all">{run.fileName || '—'}</span>} />
          <LabelValue label={t('log.mappingName')} value={run.mappingName || '—'} />
          <LabelValue label={t('log.user')} value={run.userName ?? t('logs.unknownUser')} />
        </LabelValueList>
      </SectionCard>

      {run.failureReason && (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive monolith:rounded-none monolith:border-0 monolith:border-l-2 monolith:border-signal monolith:bg-transparent monolith:text-signal-text"
        >
          {t('log.failedReason', { reason: run.failureReason })}
        </div>
      )}

      <SectionCard index={2} title={t('sec.lineCounts')}>
        <StatCells
          cells={[
            { label: t('log.total'), value: run.totalLines.toLocaleString('en') },
            { label: t('log.valid'), value: run.validLines.toLocaleString('en') },
            { label: t('log.imported'), value: run.importedLines.toLocaleString('en') },
            { label: t('log.failed'), value: run.failedLines.toLocaleString('en'), warn: run.failedLines > 0 },
          ]}
        />
        <SubHeading>{t('sec.failedMadeUp')}</SubHeading>
        <LabelValueList columns={2}>
          <LabelValue label={t('log.duplicates')} value={part(run.duplicateLines)} />
          <LabelValue label={t('log.unmatched')} value={part(run.unmatchedCardLines)} />
          <LabelValue label={t('log.invalidDateTime')} value={part(run.invalidDatetimeLines)} />
          <LabelValue label={t('log.otherErrors')} value={part(run.otherErrorLines)} />
        </LabelValueList>
        <p className={`mt-3 ${typeHelpCls}`}>{t('log.formula', { days: run.daysUpdated, employees: run.employeesUpdated })}</p>
      </SectionCard>

      <SectionCard index={3} title={t('sec.lines')}>
        <div className="space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
              <Link href={href({ tab: 'errors', reason: undefined })} className={tabCls(tab === 'errors')}>
                {t('log.tabNotImported', { count: notImported.length.toLocaleString('en') })}
              </Link>
              <Link href={href({ tab: 'imported', reason: undefined })} className={tabCls(tab === 'imported')}>
                {t('log.tabImported', { count: imported.length.toLocaleString('en') })}
              </Link>
            </div>
            {tab === 'errors' && reasons.length > 0 && (
              <form method="get" className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                <input type="hidden" name="tab" value="errors" />
                <select name="reason" defaultValue={reason} className={`${inputCls} min-w-0 flex-1 sm:w-64 sm:flex-none`} aria-label={t('log.allReasons')}>
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

          <StackedTable label={t('sec.lines')}>
            <StackedHead>
              <StackedTh>{t('log.colLine')}</StackedTh>
              <StackedTh>{t('log.colCardId')}</StackedTh>
              <StackedTh>{t('log.colEmployee')}</StackedTh>
              <StackedTh>{t('log.colDate')}</StackedTh>
              <StackedTh>{t('log.colTime')}</StackedTh>
              <StackedTh>{tab === 'errors' ? t('log.colError') : t('log.colInOut')}</StackedTh>
            </StackedHead>
            <StackedBody>
              {shown.length === 0 && (
                <StackedRow>
                  <StackedTd label={t('log.colLine')} role="full" hideLabel colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                    {t('log.noLines')}
                  </StackedTd>
                </StackedRow>
              )}
              {shown.map((l) => (
                <StackedRow key={l.lineNo}>
                  <StackedTd label={t('log.colLine')} role="title-inline" className="tabular-nums text-muted-foreground monolith:text-mid">
                    {l.lineNo.toLocaleString('en')}
                  </StackedTd>
                  <StackedTd label={t('log.colCardId')} className="font-mono text-xs">
                    {l.cardRef || '—'}
                  </StackedTd>
                  <StackedTd label={t('log.colEmployee')}>{l.employeeName ?? '—'}</StackedTd>
                  <StackedTd label={t('log.colDate')} className="whitespace-nowrap tabular-nums">
                    {l.punchDate ? formatDmy(l.punchDate) : l.result === 'invalid_date' ? l.message || '—' : '—'}
                  </StackedTd>
                  <StackedTd label={t('log.colTime')} className="tabular-nums">
                    {l.punchTime ? l.punchTime.slice(0, 5) : l.result === 'invalid_time' ? l.message || '—' : '—'}
                  </StackedTd>
                  {tab === 'errors' ? (
                    <StackedTd label={t('log.colError')} role="full">
                      <ResultPill result={l.result} label={t(`resultShort.${l.result}`)} />
                      <div className={`mt-0.5 ${typeHelpCls}`}>
                        {lineMessage(t, { result: l.result, detail: l.result === 'duplicate' || l.result === 'unknown_in_out_code' ? l.message : '' })}
                      </div>
                    </StackedTd>
                  ) : (
                    <StackedTd label={t('log.colInOut')}>{l.direction ? t(`dirShort.${l.direction}`) : '—'}</StackedTd>
                  )}
                </StackedRow>
              ))}
            </StackedBody>
          </StackedTable>
          <div className={`flex flex-wrap items-center justify-between gap-2 ${typeHelpCls}`}>
            <span>{t('log.showing', { shown: shown.length.toLocaleString('en'), total: pool.length.toLocaleString('en') })}</span>
            {pages > 1 && (
              <span className="flex gap-3">
                {page > 1 && (
                  <Link className="text-primary monolith:text-ink monolith:underline" href={href({ page: page - 1 })}>
                    {t('log.prev')}
                  </Link>
                )}
                <span>
                  {page} / {pages}
                </span>
                {page < pages && (
                  <Link className="text-primary monolith:text-ink monolith:underline" href={href({ page: page + 1 })}>
                    {t('log.next')}
                  </Link>
                )}
              </span>
            )}
            {tab === 'errors' && notImported.length > 0 && <span>{t('log.fixHint')}</span>}
          </div>
        </div>
      </SectionCard>

      <SectionCard index={4} title={t('sec.recentImports')}>
        <RunsTable runs={recent} currentId={run.id} />
      </SectionCard>
    </div>
  );
}
