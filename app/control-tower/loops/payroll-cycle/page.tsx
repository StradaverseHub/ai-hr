import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { payrollCycleOverview, type PayrollCycleCompany, type PayrollCycleOverview, type PreSalaryState, type SalaryState } from '@/core/loops/payroll-cycle-views';
import { PRE_SALARY_CHECKS, PRE_SALARY_CHECK_HREF, type PreSalaryCheckKey } from '@/core/loops/pre-salary-checks';
import { Card, PageHeader, SectionHeader, btnGhost, pageWideCls } from '@/components/ui';
import { cn } from '@/lib/utils';
import { OperationsTabs } from '../../operations-tabs';
import { PayrollCycleSubnav } from '@/components/ai-centre/centre-tabs';
import { AuditLoopCard, bankReconciliation } from './audit-loop-card';
// The group state rule (the worst company's state) and its tones are shared with the Operations › Loops list.
import { ATTENTION, DONE, payrollLoopStates, pill } from './loop-states';
import { LEARNING_STATUSES, learnedThisCycle, type LearnedThisCycle } from '@/core/payroll-learning/status';

/** AI v2 P2-2a — AI Centre › Operations › Loops › Payroll cycle (owner-approved mock-up PayrollLoops.dc.html).
 *
 * One group pipeline per month, filtered to the companies the viewer administers (owner decision 6): the three loops in
 * order (Pre-salary, Salary payroll, Audit), a status per company, the last three cycles compared and the people loops.
 * Every figure is the loops' own record, read under the viewer's row-level security (core/loops/payroll-cycle-views.ts);
 * nothing here computes pay. The Audit loop's column is its own component (./audit-loop-card.tsx): P2-2b's status for the
 * month, read with the overview, and the Salary payroll loop's bank check as its "Bank paid vs payroll" item; each company's
 * row shows its Audit status. Guarded by requireAdmin, as every Operations page is. AI Centre, never Noveri.
 * Payroll history learning (P2): "Learned this cycle", per company whose payroll the viewer administers, counts only: the
 * learning mode, how many people's usual pay for the month is settled, provisional, not yet learned, relearning after a
 * salary change or has moved, and when it last learned (core/payroll-learning/status.ts learnedThisCycle). */
const link = 'inline-flex min-h-9 items-center text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11';

export default async function PayrollCyclePage({ searchParams }: { searchParams: Promise<{ period?: string; company?: string }> }) {
  const s = await requireAdmin();
  const query = await searchParams;
  const [t, tl, ta, f, view] = await Promise.all([getTranslations('aiCentre.payrollCycle'), getTranslations('aiCentre.loops'), getTranslations('payrollAudit'),
    getFormatter(), payrollCycleOverview(s, { period: query.period, companyId: query.company })]);
  const day = (iso: string) => f.dateTime(new Date(`${iso}T00:00:00Z`), { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const month = (period: string) => f.dateTime(new Date(`${period}-01T00:00:00Z`), { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const href = (params: Record<string, string | null>) => {
    const q = new URLSearchParams(Object.entries(params).filter((entry): entry is [string, string] => !!entry[1]));
    return `/control-tower/loops/payroll-cycle${q.size ? `?${q}` : ''}`;
  };
  // A learning read that fails leaves the section out; it never stops the page.
  const [tn, learned] = await Promise.all([getTranslations('aiCentre.payrollLearning'),
    view.companies.length ? learnedThisCycle(s, { period: view.period, companyIds: view.companies.map(c => c.companyId) }).catch((): LearnedThisCycle | null => null) : null]);
  const one = view.companies.length === 1 ? view.companies[0] : null;
  const { pre, salary, daysToCutOff: days } = payrollLoopStates(view);
  const header = one
    ? t('headerOne', { cutOff: day(one.preSalary.cutOff), payDay: day(one.payDay ?? one.preSalary.cutOff), due: day(view.statutoryDue) })
    : t('headerGroup', { due: day(view.statutoryDue) });
  return (
    <div className={pageWideCls}>
      <OperationsTabs session={s} active="payrollCycle" />
      <PayrollCycleSubnav active="pre" />
      <PageHeader back={{ href: '/control-tower/loops', label: tl('back') }} title={t('title', { month: month(view.period) })}
        description={<>{t('description')} {header}</>}
        actions={view.allowed.length > 1 && (
          <form method="get" action="/control-tower/loops/payroll-cycle" className="flex flex-wrap items-center gap-2" data-company-filter>
            <input type="hidden" name="period" value={view.period} />
            <label htmlFor="payroll-cycle-company" className="text-sm text-muted-foreground">{t('company')}</label>
            <select id="payroll-cycle-company" name="company" defaultValue={view.filter ?? ''}
              className="h-9 rounded-md border border-input bg-card px-2 text-sm pointer-coarse:min-h-11">
              <option value="">{t('allCompanies', { count: view.allowed.length })}</option>
              {view.allowed.map(item => <option key={item.companyId} value={item.companyId}>{item.companyName}</option>)}
            </select>
            <button type="submit" className={cn(btnGhost, 'pointer-coarse:min-h-11')}>{t('show')}</button>
          </form>
        )} />

      {view.companies.length === 0 ? <Card className="p-4 text-sm text-muted-foreground">{t('noCompanies')}</Card> : <>
        <ol aria-label={t('loopsLabel')} data-payroll-loops className="grid list-none items-start gap-3 p-0 lg:grid-cols-3">
          <PreSalaryCard view={view} state={pre} days={days} t={t} />
          <SalaryCard view={view} state={salary} t={t} />
          <AuditLoopCard status={view.audit} bank={bankReconciliation(view.companies)} copy={{ title: t('audit.title'), done: t('audit.done'), note: t('audit.note') }} />
        </ol>

        <Card className="overflow-hidden">
          <SectionHeader title={t('byCompany.title')} />
          <div className="overflow-x-auto">
            <table data-payroll-companies className="w-full min-w-[720px] text-left text-sm">
              <caption className="sr-only">{t('byCompany.title')}</caption>
              <thead className="border-y border-border bg-muted/40"><tr>
                {(['company', 'preSalary', 'salary', 'audit'] as const).map(key => <th key={key} scope="col" className="px-4 py-3 font-medium">{t(`byCompany.columns.${key}`)}</th>)}
              </tr></thead>
              <tbody className="divide-y divide-border">
                {view.companies.map(c => (
                  <tr key={c.companyId} data-payroll-company={c.companyId} className="align-top">
                    <th scope="row" className="px-4 py-3 font-medium">
                      {view.filter ? c.companyName : <Link href={href({ period: view.period, company: c.companyId })} className={link}>{c.companyName}</Link>}
                    </th>
                    <td className="px-4 py-3"><CompanyPre c={c} t={t} /></td>
                    <td className="px-4 py-3"><CompanySalary c={c} t={t} /></td>
                    <td className="px-4 py-3"><CompanyAudit audit={view.audit?.companies.find(a => a.companyId === c.companyId) ?? null} t={t} ta={ta} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        {learned && learned.companies.length > 0 && <LearnedCard learned={learned} tn={tn} day={day} />}

        <Card className="overflow-hidden">
          <SectionHeader title={t('history.title')} />
          <div className="overflow-x-auto">
            <table data-payroll-history className="w-full min-w-[760px] text-left text-sm">
              <caption className="sr-only">{t('history.title')}</caption>
              <thead className="border-y border-border bg-muted/40"><tr>
                {(['month', 'inputsReady', 'issuesCaught', 'closed', 'corrections', 'filed'] as const).map(key => <th key={key} scope="col" className="px-4 py-3 font-medium">{t(`history.columns.${key}`)}</th>)}
              </tr></thead>
              <tbody className="divide-y divide-border">
                {view.history.map(row => (
                  <tr key={row.period} data-payroll-month={row.period}>
                    <th scope="row" className="px-4 py-3 font-medium"><Link href={href({ period: row.period, company: view.filter })} className={link}>{month(row.period)}</Link></th>
                    <td className="px-4 py-3">{row.inputsReady === null ? <span className="text-muted-foreground">{t('history.notMeasured')}</span>
                      : row.inputsReady === 'missed' ? t('history.missed') : row.inputsReady === 0 ? t('history.onCutOff') : row.inputsReady > 0
                        ? t('history.before', { count: row.inputsReady }) : t('history.after', { count: -row.inputsReady })}</td>
                    <td className="px-4 py-3 tabular-nums">{row.issuesCaught === null ? <span className="text-muted-foreground">{t('history.notMeasured')}</span> : row.issuesCaught}</td>
                    <td className="px-4 py-3 tabular-nums">{row.closedOn ? day(row.closedOn) : <span className="text-muted-foreground">{row.runs ? t('history.notClosed') : t('history.noRun')}</span>}</td>
                    <td className="px-4 py-3 tabular-nums">{row.correctionsAfter}</td>
                    <td className="px-4 py-3 text-muted-foreground">—</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <section aria-labelledby="payroll-people-loops" className="space-y-2">
          <h2 id="payroll-people-loops" className="text-sm font-semibold">{t('people.title')}</h2>
          <ul data-people-loops className="flex list-none flex-wrap gap-2 p-0">
            {view.people.map(item => (
              <li key={item.id}><Link href={`/control-tower/loops/${item.id}`} className={cn(btnGhost, 'pointer-coarse:min-h-11')}>
                {t('people.item', { name: tl(`names.${item.id}`), count: item.open })}</Link></li>
            ))}
          </ul>
        </section>
      </>}
    </div>
  );
}

type T = Awaited<ReturnType<typeof getTranslations<'aiCentre.payrollCycle'>>>;
type TN = Awaited<ReturnType<typeof getTranslations<'aiCentre.payrollLearning'>>>;

/** "Learned this cycle": counts only, one row per company whose payroll the viewer administers. */
function LearnedCard({ learned, tn, day }: { learned: LearnedThisCycle; tn: TN; day: (iso: string) => string }) {
  const allOff = learned.companies.every(c => c.mode === 'off');
  return (
    <Card className="overflow-hidden" data-learned-cycle>
      <SectionHeader title={tn('cycle.title')} subtitle={tn('cycle.help')} />
      {allOff ? <p data-learning-off className="px-4 py-4 text-sm text-muted-foreground">{tn('cycle.allOff')}</p> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[880px] text-left text-sm">
            <caption className="sr-only">{tn('cycle.caption')}</caption>
            <thead className="border-y border-border bg-muted/40"><tr>
              {(['company', 'mode', ...LEARNING_STATUSES, 'learnedOn'] as const).map(key => <th key={key} scope="col" className="px-4 py-3 font-medium">{tn(`cycle.columns.${key}`)}</th>)}
            </tr></thead>
            <tbody className="divide-y divide-border">
              {learned.companies.map(c => (
                <tr key={c.companyId} data-learned-company={c.companyId} className="align-top">
                  <th scope="row" className="px-4 py-3 font-medium">{c.companyName}</th>
                  <td className="px-4 py-3" data-learning-mode={c.mode}>{tn(`cycle.mode.${c.mode}`)}</td>
                  {LEARNING_STATUSES.map(status => <td key={status} className="px-4 py-3 tabular-nums" data-learned-status={status}>{c.mode === 'off' ? '—' : c.people[status]}</td>)}
                  <td className="px-4 py-3 text-muted-foreground">{c.learnedOn ? day(c.learnedOn) : tn('cycle.never')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function Row({ label, value, tone, href }: { label: string; value: string; tone?: string; href?: string }) {
  return (
    <li className="flex items-baseline justify-between gap-3">
      {href ? <Link href={href} className={cn(link, 'min-h-0')}>{label}</Link> : <span>{label}</span>}
      <span className={cn('text-right', tone ?? 'text-muted-foreground')}>{value}</span>
    </li>
  );
}

function PreSalaryCard({ view, state, days, t }: { view: PayrollCycleOverview; state: PreSalaryState | null; days: number; t: T }) {
  const value = (key: PreSalaryCheckKey) => {
    const checks = view.companies.flatMap(c => c.preSalary.checks.filter(check => check.key === key));
    if (!checks.length) return { text: t('pre.value.notChecked') };
    if (checks.every(check => check.status === 'off')) return { text: t('pre.value.off') };
    const open = checks.reduce((sum, check) => sum + check.open, 0), waiting = checks.reduce((sum, check) => sum + check.waiting, 0);
    const warnings = checks.reduce((sum, check) => sum + check.warnings, 0);
    if (open || waiting) return { text: [open ? t('pre.value.open', { count: open }) : null, waiting ? t('pre.value.waiting', { count: waiting }) : null].filter(Boolean).join(' · '), tone: ATTENTION };
    if (warnings) return { text: t('pre.value.review', { count: warnings }) };
    return { text: t('pre.value.done'), tone: DONE };
  };
  return (
    <li data-loop-card="pre-salary" className={cn('flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4', state === 'open' || state === 'missed' ? 'border-primary' : 'border-border')}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">{t('pre.title')}</h2>
        {state && <span data-loop-state={state} className={cn(pill, state === 'done' && DONE, (state === 'open' || state === 'missed') && ATTENTION)}>
          {state === 'open' ? (days >= 0 ? t('pre.state.open', { count: days }) : t('pre.state.openPast')) : t(`pre.state.${state}`)}</span>}
      </div>
      <p className="text-sm text-muted-foreground">{t('pre.done')}</p>
      <ul data-loop-checks className="flex list-none flex-col gap-1.5 p-0 text-sm">
        {PRE_SALARY_CHECKS.map(key => { const v = value(key); return <Row key={key} label={t(`checks.${key}`)} value={v.text} tone={v.tone} href={PRE_SALARY_CHECK_HREF[key]} />; })}
      </ul>
      <p className="border-t border-border pt-2 text-xs text-muted-foreground">{t('pre.note')}</p>
      <Link href="/control-tower/loops/loop_payroll_inputs" className={cn(link, 'font-semibold')}>{t('pre.open')}</Link>
    </li>
  );
}

function SalaryCard({ view, state, t }: { view: PayrollCycleOverview; state: SalaryState | null; t: T }) {
  const runs = view.companies.flatMap(c => c.salary.runs);
  const processed = runs.filter(run => run.status !== 'draft');
  const started = view.companies.filter(c => c.salary.runs.some(run => run.runType === 'regular')).length;
  const exceptions = processed.reduce((sum, run) => sum + run.exceptions, 0);
  const flagged = processed.filter(run => run.runType === 'regular' || !processed.some(other => other.companyId === run.companyId && other.payPeriod === run.payPeriod && other.runType === 'regular'))
    .reduce((sum, run) => sum + run.flagged, 0);
  const newer = processed.filter(run => run.rulesNewer.length > 0).length;
  const closed = runs.filter(run => run.status === 'closed').length;
  const mismatched = processed.filter(run => run.bank === 'total_mismatch' || run.bank === 'count_mismatch' || run.bank === 'blocked').length;
  const matched = processed.filter(run => run.bank === 'match').length;
  const detectors = processed[0]?.detectors || 11;
  const ruleVersion = processed.find(run => run.ruleVersion)?.ruleVersion ?? null;
  const qs = new URLSearchParams({ period: view.period, ...(view.filter ? { company: view.filter } : {}) });
  return (
    <li data-loop-card="salary" className={cn('flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4', state === 'attention' || state === 'ready_to_start' || state === 'in_progress' ? 'border-primary' : 'border-border')}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">{t('salary.title')}</h2>
        {state && <span data-loop-state={state} className={cn(pill, state === 'done' && DONE, state === 'attention' && ATTENTION)}>{t(`salary.state.${state}`)}</span>}
      </div>
      <p className="text-sm text-muted-foreground">{t('salary.done')}</p>
      <ul data-loop-checks className="flex list-none flex-col gap-1.5 p-0 text-sm">
        <Row label={t('salary.rows.run')} value={runs.length ? t('salary.value.started', { started, total: view.companies.length }) : t('salary.value.preparedForHr')} />
        <Row label={t('salary.rows.change')} value={processed.length ? (flagged ? t('salary.value.flagged', { count: flagged }) : t('salary.value.explained')) : t('salary.value.afterRun')}
          tone={flagged ? ATTENTION : undefined} />
        <Row label={t('salary.rows.anomalies', { count: detectors })} value={processed.length ? (exceptions ? t('salary.value.exceptions', { count: exceptions }) : t('salary.value.noExceptions')) : t('salary.value.toToday')}
          tone={exceptions ? ATTENTION : undefined} />
        <Row label={t('salary.rows.rules')} value={newer ? t('salary.value.newer', { count: newer }) : ruleVersion ? t('salary.value.ruleVersion', { version: ruleVersion }) : t('salary.value.versionShown')}
          tone={newer ? ATTENTION : undefined} />
        <Row label={t('salary.rows.close')} value={runs.length ? t('salary.value.closed', { closed, total: runs.length }) : t('salary.value.person')} />
        <Row label={t('salary.rows.bank')} value={mismatched ? t('salary.value.mismatch', { count: mismatched }) : matched ? t('salary.value.matches') : t('salary.value.beforeRelease')}
          tone={mismatched ? ATTENTION : matched ? DONE : undefined} />
      </ul>
      <p className="border-t border-border pt-2 text-xs text-muted-foreground">{t('salary.note')}</p>
      <Link href={`/control-tower/loops/payroll-cycle/salary?${qs}`} className={cn(link, 'font-semibold')}>{t('salary.open')}</Link>
    </li>
  );
}

function CompanyPre({ c, t }: { c: PayrollCycleCompany; t: T }) {
  const s = c.preSalary.state;
  const blocking = c.preSalary.checks.filter(check => check.status === 'open' || check.status === 'waiting');
  return <>
    <p className={cn(s === 'done' && DONE, (s === 'open' || s === 'missed') && ATTENTION)}>
      {s === 'open' ? (c.preSalary.daysToCutOff >= 0 ? t('pre.state.open', { count: c.preSalary.daysToCutOff }) : t('pre.state.openPast')) : t(`pre.state.${s}`)}</p>
    {blocking.length > 0 && <p className="mt-1 text-xs text-muted-foreground">{blocking.map(check => t(`checks.${check.key}`)).join(', ')}</p>}
    <p className="mt-1 text-xs text-muted-foreground">{t(`interval.${c.preSalary.interval}`)}</p>
  </>;
}

type TA = Awaited<ReturnType<typeof getTranslations<'payrollAudit'>>>;

/** One company's Audit loop status (P2-2b): done, in progress or paused, and its open findings. A dash where the Audit loop's
 * read has no row for the company (the viewer does not administer its payroll). */
function CompanyAudit({ audit, t, ta }: { audit: NonNullable<PayrollCycleOverview['audit']>['companies'][number] | null; t: T; ta: TA }) {
  if (!audit) return <span className="text-muted-foreground">—</span>;
  return <>
    <p className={cn(audit.done && DONE)}>{audit.paused ? t('salary.state.paused') : audit.done ? ta('state.done') : ta('state.open')}</p>
    {audit.findings.open > 0 && <p className={cn('mt-1 text-xs', ATTENTION)}>{ta('column.values.findings', { count: audit.findings.open })}</p>}
  </>;
}

function CompanySalary({ c, t }: { c: PayrollCycleCompany; t: T }) {
  const s = c.salary.state;
  return <>
    <p className={cn(s === 'done' && DONE, s === 'attention' && ATTENTION)}>{t(`salary.state.${s}`)}</p>
    {c.salary.runs.length > 0 && <p className="mt-1 text-xs text-muted-foreground">
      {c.salary.runs.map(run => t('salary.runLine', { type: t(`runType.${run.runType === 'bonus' || run.runType === 'off_cycle' ? run.runType : 'regular'}`), status: t(`runStatus.${run.status}`) })).join(' · ')}</p>}
  </>;
}
