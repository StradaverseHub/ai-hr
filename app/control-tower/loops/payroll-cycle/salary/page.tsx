import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { salaryLoopPage, type SalaryRunView, type SwingFlagView } from '@/core/loops/payroll-cycle-views';
import { acknowledgedBlocks, swingFlagGroups } from '@/core/loops/grouped-dispositions';
import { Card, ErrorBanner, PageHeader, SectionHeader, btnGhost, btnPrimary, inputCls, pageWideCls } from '@/components/ui';
import { cn } from '@/lib/utils';
import { OperationsTabs } from '../../../operations-tabs';
import { PayrollCycleSubnav } from '@/components/ai-centre/centre-tabs';
import { acknowledgeCheckAction, disposeSwingGroupAction, recordSwingDispositionAction } from '../actions';

/** AI v2 P2-2a — the Salary payroll loop's page: each company's runs for the month (regular, bonus and off-cycle) with
 * their checks as the loop's last run recorded them, and the net-swing flags for payroll HR's disposition. Payroll
 * administrators only (core/loops/payroll-cycle-views.ts salaryLoopPage reads only companies the viewer may run payroll
 * for). The loop stays at Prepare: this page starts, approves or closes nothing; each run opens on the payroll workbench,
 * where a person does that. A disposition changes no pay. No mock-up covers this page: it follows the loop pages' own
 * tables and buttons (core vocabulary, no new colour).
 * Phase 2 hardening: the open flags are also shown grouped by what moved the pay (company, month and pattern), each group
 * with its evidence and one tap for all of it (core/loops/grouped-dispositions.ts); a flag can be acknowledged as
 * standing "expected" for its person (core/loops/acknowledgements.ts); and a blocking exception a standing acknowledgement
 * covers is listed with its one-tap resolve pre-filled (a person still presses it). */
const ERRORS = ['invalid', 'refused', 'changed', 'already', 'failed', 'own'] as const;
const SAVED = ['disposition', 'grouped', 'acknowledged', 'resolved'] as const;
const DONE = 'text-emerald-700 dark:text-emerald-300';
const ATTENTION = 'text-amber-700 dark:text-amber-300';
const link = 'inline-flex min-h-9 items-center text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11';

export default async function SalaryLoopPage({ searchParams }: { searchParams: Promise<{ period?: string; company?: string; error?: string; saved?: string }> }) {
  const s = await requireAdmin();
  const query = await searchParams;
  const [t, f, view] = await Promise.all([getTranslations('aiCentre.payrollCycle'), getFormatter(), salaryLoopPage(s, { period: query.period, companyId: query.company })]);
  const error = ERRORS.find(code => code === query.error), saved = SAVED.find(code => code === query.saved);
  const groups = swingFlagGroups(view.flags);
  const blocks = await acknowledgedBlocks(s, { companyIds: view.companies.map(c => c.companyId), payPeriod: view.period });
  const stay = (<><input type="hidden" name="back" value="salary" /><input type="hidden" name="period" value={view.period} />
    {view.filter && <input type="hidden" name="company" value={view.filter} />}</>);
  const month = (period: string) => f.dateTime(new Date(`${period}-01T00:00:00Z`), { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const day = (iso: string) => f.dateTime(new Date(`${iso}T00:00:00Z`), { dateStyle: 'medium', timeZone: 'UTC' });
  const percent = (bp: number) => f.number(bp / 10_000, { style: 'percent', maximumFractionDigits: 1 });
  // A pay item pattern is keyed on its component's id; its current name is shown (the catalogue's, read with the page).
  const pattern = (value: string) => value.startsWith('cause:') ? t(`causes.${value.slice(6)}`)
    : view.patternNames[value] ? t('patternItem', { item: view.patternNames[value] }) : t('patternUnknown');
  const back = `/control-tower/loops/payroll-cycle?${new URLSearchParams({ period: view.period, ...(view.filter ? { company: view.filter } : {}) })}`;
  const bankText = (run: SalaryRunView) => t(`bank.${run.bank}`);
  return (
    <div className={pageWideCls}>
      <OperationsTabs session={s} active="payrollCycle" />
      <PayrollCycleSubnav active="salary" />
      <PageHeader back={{ href: back, label: t('backToCycle') }} title={t('salaryPage.title', { month: month(view.period) })} description={t('salaryPage.description')}
        actions={<span className="rounded-full border border-border px-2.5 py-1 text-xs font-medium">{t('salaryPage.level')}</span>} />
      {error && <ErrorBanner message={t(`errors.${error}`)} />}
      {saved && <p role="status" className="rounded-lg border border-border bg-muted/50 p-3 text-sm">{t(`saved.${saved}`)}</p>}
      {!view.loop.on && <p className="rounded-lg border border-border bg-muted/50 p-3 text-sm">{t('salaryPage.off')}</p>}
      {view.companies.length === 0 && <Card className="p-4 text-sm text-muted-foreground">{t('salaryPage.noCompanies')}</Card>}

      {view.companies.map(c => (
        <Card key={c.companyId} className="overflow-hidden" data-salary-company={c.companyId}>
          <SectionHeader title={c.companyName} subtitle={t('salaryPage.companyLine', { cutOff: day(c.cutOff), threshold: percent(c.thresholdBp) })} />
          {c.startOpen && <p data-salary-start className="mx-4 mb-3 rounded-lg border border-border bg-muted/40 p-3 text-sm">
            {t('salaryPage.readyToStart', { month: month(view.period) })} <Link href="/payroll" className={cn(link, 'min-h-0')}>{t('salaryPage.openPayroll')}</Link></p>}
          {c.runs.length === 0 ? <p className="px-4 pb-4 text-sm text-muted-foreground">{t('salaryPage.noRuns')}</p> : (
            <div className="overflow-x-auto">
              <table data-salary-runs className="w-full min-w-[960px] text-left text-sm">
                <caption className="sr-only">{t('salaryPage.runsCaption', { company: c.companyName })}</caption>
                <thead className="border-y border-border bg-muted/40"><tr>
                  {(['run', 'status', 'anomalies', 'change', 'rules', 'close', 'bank'] as const).map(key => <th key={key} scope="col" className="px-4 py-3 font-medium">{t(`salaryPage.columns.${key}`)}</th>)}
                </tr></thead>
                <tbody className="divide-y divide-border">
                  {c.runs.map(run => (
                    <tr key={run.caseId} data-salary-run={run.batchId} className="align-top">
                      <th scope="row" className="px-4 py-3 font-medium">
                        <Link href={`/payroll/${run.batchId}`} className={link}>{t('salaryPage.runName', { type: t(`runType.${run.runType === 'bonus' || run.runType === 'off_cycle' ? run.runType : 'regular'}`), seq: run.runSeq })}</Link>
                      </th>
                      <td className="px-4 py-3">{t(`runStatus.${run.status}`)}{run.stale && <span className={cn('block text-xs', ATTENTION)}>{t('salaryPage.stale')}</span>}
                        <span className="block text-xs text-muted-foreground">{t('salaryPage.employees', { count: run.employees })}</span></td>
                      <td className="px-4 py-3">{run.status === 'draft' ? <span className="text-muted-foreground">{t('salaryPage.afterProcessing')}</span>
                        : !run.evaluated ? <span className="text-muted-foreground">{t('salaryPage.notEvaluated', { count: run.detectors })}</span>
                          : <Link href={run.exceptions ? '/control-tower/exceptions' : `/payroll/${run.batchId}/anomalies`} className={cn(link, run.exceptions ? ATTENTION : DONE)}>
                            {run.exceptions ? t('salary.value.exceptions', { count: run.exceptions }) : t('salary.value.noExceptions')}</Link>}</td>
                      <td className="px-4 py-3">{run.status === 'draft' ? <span className="text-muted-foreground">{t('salaryPage.afterProcessing')}</span> : <>
                        <span>{t('salaryPage.changed', { count: run.changed })}</span>
                        {run.flagged > 0 && <span className={cn('block', ATTENTION)}>{t('salary.value.flagged', { count: run.flagged })}</span>}
                        {run.causes.length > 0 && <span className="block text-xs text-muted-foreground">{run.causes.map(cause => t('salaryPage.cause', { cause: t(`causes.${cause.kind}`), count: cause.count })).join(', ')}</span>}
                      </>}</td>
                      <td className="px-4 py-3">{run.ruleVersion ? t('salary.value.ruleVersion', { version: run.ruleVersion }) : <span className="text-muted-foreground">—</span>}
                        {run.rulesNewer.length > 0 && <span className={cn('block text-xs', ATTENTION)}>{t('salaryPage.newerRules', { bodies: run.rulesNewer.map(body => t(`bodies.${body}`)).join(', ') })}</span>}</td>
                      <td className="px-4 py-3">{run.status === 'closed' ? <span className={DONE}>{run.closedBy ? t('salaryPage.closedBy', { name: run.closedBy }) : t('salaryPage.closed')}</span>
                        : <span className="text-muted-foreground">{t('salaryPage.notClosed')}</span>}
                        {run.reopened > 0 && <span className="block text-xs text-muted-foreground">{t('salaryPage.reopened', { count: run.reopened })}</span>}</td>
                      <td className="px-4 py-3"><span className={cn(run.bank === 'match' && DONE, (run.bank === 'total_mismatch' || run.bank === 'count_mismatch' || run.bank === 'blocked') && ATTENTION,
                        (run.bank === 'not_available' || run.bank === 'not_ready') && 'text-muted-foreground')} data-bank-check={run.bank}>{bankText(run)}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ))}

      {groups.length > 0 && <Card className="overflow-hidden" data-swing-groups>
        <SectionHeader title={t('groups.title')} subtitle={t('groups.help')} />
        <ul className="m-0 flex list-none flex-col divide-y divide-border border-t border-border p-0">
          {groups.map(group => (
            <li key={`${group.companyId}:${group.payPeriod}:${group.pattern}`} data-swing-group={group.pattern} className="flex flex-col gap-2 px-4 py-3 text-sm">
              <p className="m-0 font-medium">{t('groups.heading', { pattern: pattern(group.pattern), count: group.members.length })}
                {group.companyName && <span className="ml-2 text-xs font-normal text-muted-foreground">{group.companyName}</span>}</p>
              <ul className="m-0 flex list-none flex-col gap-1 p-0 text-xs text-muted-foreground" data-group-evidence>
                {group.members.map(member => (
                  <li key={member.caseId}>{t('groups.member', { name: member.personName ?? t('flags.unnamed'),
                    change: t(member.direction === 'down' ? 'flags.down' : 'flags.up', { swing: percent(member.swingBp) }),
                    causes: member.causes.length ? member.causes.map(kind => t(`causes.${kind}`)).join(', ') : '—' })}</li>
                ))}
              </ul>
              <div className="flex flex-wrap gap-2">
                {(['expected', 'problem'] as const).map(value => (
                  <form key={value} action={disposeSwingGroupAction}>
                    {stay}<input type="hidden" name="target" value={group.companyId} /><input type="hidden" name="pattern" value={group.pattern} />
                    <input type="hidden" name="disposition" value={value} />
                    <button type="submit" className={cn(value === 'expected' ? btnPrimary : btnGhost, 'pointer-coarse:min-h-11')}
                      aria-label={`${t(`groups.mark.${value}`, { count: group.members.length })} · ${pattern(group.pattern)}`}>{t(`groups.mark.${value}`, { count: group.members.length })}</button>
                  </form>
                ))}
              </div>
            </li>
          ))}
        </ul>
        <p className="px-4 pb-4 pt-2 text-xs text-muted-foreground">{t('groups.note')}</p>
      </Card>}

      {/* Owner decision 28: payroll exceptions are resolved on Exceptions only. This page counts the acknowledged blocking
          exceptions of its month and links there, where each waits with its pre-filled resolve. */}
      {blocks.length > 0 && <Card className="flex flex-wrap items-center justify-between gap-3 p-4" data-acknowledged-blocks={blocks.length}>
        <p className="m-0 text-sm">{t('acknowledgedBlocks.count', { count: blocks.length })}</p>
        <Link href="/control-tower/exceptions#acknowledged-blocks" className={link}>{t('acknowledgedBlocks.open')}</Link>
      </Card>}

      <Card className="overflow-hidden">
        <SectionHeader title={t('flags.title')} subtitle={t('flags.help')} />
        {view.flags.length === 0 ? <p className="px-4 pb-4 text-sm text-muted-foreground">{t('flags.none')}</p> : (
          <div className="overflow-x-auto">
            <table data-swing-flags className="w-full min-w-[880px] text-left text-sm">
              <caption className="sr-only">{t('flags.title')}</caption>
              <thead className="border-y border-border bg-muted/40"><tr>
                {(['person', 'change', 'pattern', 'disposition'] as const).map(key => <th key={key} scope="col" className="px-4 py-3 font-medium">{t(`flags.columns.${key}`)}</th>)}
              </tr></thead>
              <tbody className="divide-y divide-border">
                {view.flags.map(flag => <FlagRow key={flag.caseId} flag={flag} period={view.period} filter={view.filter} t={t} percent={percent} pattern={pattern} />)}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <p className="max-w-4xl text-xs text-muted-foreground">{t('salaryPage.note')}{' '}
        <Link href="/control-tower/loops/payroll-cycle/settings" className={cn(link, 'min-h-0')}>{t('salaryPage.settingsLink')}</Link></p>
    </div>
  );
}

type T = Awaited<ReturnType<typeof getTranslations<'aiCentre.payrollCycle'>>>;

function FlagRow({ flag, period, filter, t, percent, pattern }: { flag: SwingFlagView; period: string; filter: string | null; t: T; percent: (bp: number) => string; pattern: (value: string) => string }) {
  const who = flag.personName ?? t('flags.unnamed');
  return (
    <tr data-swing-flag={flag.caseId} className="align-top">
      <td className="px-4 py-3">{who}{flag.companyName && <span className="block text-xs text-muted-foreground">{flag.companyName}</span>}</td>
      <td className="px-4 py-3 tabular-nums">{t(flag.direction === 'down' ? 'flags.down' : 'flags.up', { swing: percent(flag.swingBp) })}
        <span className="block text-xs text-muted-foreground">{t('flags.threshold', { threshold: percent(flag.thresholdBp) })}</span></td>
      <td className="px-4 py-3">{pattern(flag.pattern)}
        {flag.causes.length > 0 && <span className="block text-xs text-muted-foreground">{flag.causes.map(kind => t(`causes.${kind}`)).join(', ')}</span>}</td>
      <td className="px-4 py-3">{flag.disposition
        ? <span data-disposition={flag.disposition.value}>{t(`flags.disposition.${flag.disposition.value}`)}{flag.disposition.by && <span className="block text-xs text-muted-foreground">{t('flags.by', { name: flag.disposition.by })}</span>}</span>
        : <div className="flex flex-wrap gap-2">
          {(['expected', 'problem'] as const).map(value => (
            <form key={value} action={recordSwingDispositionAction}>
              <input type="hidden" name="case" value={flag.caseId} /><input type="hidden" name="disposition" value={value} />
              <input type="hidden" name="period" value={period} />{filter && <input type="hidden" name="company" value={filter} />}
              <button type="submit" className={cn(btnGhost, 'pointer-coarse:min-h-11')} aria-label={`${t(`flags.mark.${value}`)} · ${who}`}>{t(`flags.mark.${value}`)}</button>
            </form>
          ))}
          {flag.employmentId && <form action={acknowledgeCheckAction} className="flex w-full flex-wrap items-end gap-2" data-acknowledge-flag>
            <input type="hidden" name="back" value="salary" /><input type="hidden" name="period" value={period} />{filter && <input type="hidden" name="company" value={filter} />}
            <input type="hidden" name="target" value={flag.companyId} /><input type="hidden" name="check" value="swing:net_swing" />
            <input type="hidden" name="scope" value="person" /><input type="hidden" name="employment" value={flag.employmentId} />
            <label className="flex min-w-40 flex-1 flex-col gap-1 text-xs"><span className="text-muted-foreground">{t('acknowledge.reason')}</span>
              <input name="reason" required maxLength={500} className={cn(inputCls, 'pointer-coarse:min-h-11')} /></label>
            <label className="flex flex-col gap-1 text-xs"><span className="text-muted-foreground">{t('acknowledge.reviewOn')}</span>
              <input type="date" name="reviewOn" className={cn(inputCls, 'pointer-coarse:min-h-11')} /></label>
            <button type="submit" className={cn(btnGhost, 'pointer-coarse:min-h-11')} aria-label={`${t('acknowledge.person')} · ${who}`}>{t('acknowledge.person')}</button>
          </form>}
        </div>}</td>
    </tr>
  );
}
