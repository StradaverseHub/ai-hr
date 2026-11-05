import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import type { SessionContext } from '@/db/client';
import { Card, ErrorBanner, Input, btnGhost, btnPrimary, inputCls } from '@/components/ui';
import { StatCells } from '@/components/ui/stat-cells';
import { BarChart } from '@/components/charts/BarChart';
import { capacityLedger } from '@/core/capacity/ledger';
import { baselineSetup, type BaselineSetup } from '@/core/capacity/baseline';
import { REVIEW_CAP_MINUTES, WORKING_DAY_HOURS, addDays, hoursOf } from '@/core/capacity/ledger-math';
import { MAX_ITEM_MINUTES, MAX_MINUTES_PER_STAFF_ACTION, measurable } from '@/core/capacity/baseline-rules';
import { BASELINE_DAYS, CAPACITY_ITEMS, CAPACITY_PERIODS, MEASURED_BY, type CapacityItem, type CapacityPeriod } from '@/core/capacity/types';
import { setCapacityBaselineAction } from '@/app/assistant/capacity-actions';
import { cn } from '@/lib/utils';
import { CapacityProcesses, readCapacityProcesses } from './capacity-processes';

/** AI v2 Phase 2, P2-4 — AI Centre › Insights › HR capacity (approved mock-up Ledger.dc.html, revised).
 *
 * Four figures (HR time freed, payroll errors caught before the run, loop actions completed, employee questions
 * answered), HR time freed by month drawn to scale with the shared chart, where the time came from, and the method.
 * Every figure is the company's own: work done against its own baseline, never an industry average. Hours are shown,
 * never a ratio of HR staff to employees (owner rule). Rendered only for an administrator (the Insights view checks
 * isAdmin, and core/capacity/ledger.ts checks it again); each figure is read under their row-level security.
 *
 * AI Centre restructure (owner decision 29, 4 November 2026): the measured part of the former Opportunities page is its
 * last part, "Where the work is" (./capacity-processes.tsx), with the stored baseline as its only minutes input; the
 * section is the target of /control-tower/opportunities (#hr-capacity). */
export type CapacityQuery = { period?: string; company?: string; setup?: string; days?: string; saved?: string; error?: string; pdays?: string };
const ERRORS = ['invalid', 'empty', 'not_administrator', 'conflict', 'failed'] as const;
const target = 'pointer-coarse:min-h-11';

function href(query: Readonly<Record<string, string | null | undefined>>) {
  const params = new URLSearchParams({ view: 'insights' });
  for (const [key, value] of Object.entries(query)) if (value) params.set(key, value);
  return `/assistant?${params}`;
}

export async function CapacityLedgerSection({ session, query }: { session: SessionContext; query: CapacityQuery }) {
  const [t, tl, f] = await Promise.all([getTranslations('aiCentre.capacity'), getTranslations('aiCentre.loops'), getFormatter()]);
  // The processes' two readers start with the ledger's read; each checks the administrator again.
  const processes = readCapacityProcesses(session, { pdays: query.pdays });
  const view = await capacityLedger(session, { period: query.period, companyId: query.company });
  const setupCompany = view.companies.find(row => row.id === query.setup);
  const setup = setupCompany ? await baselineSetup(session, { companyId: setupCompany.id, days: query.days }) : null;
  const { ledger } = view;
  const company = view.companyId;
  const nameOf = (id: string) => view.companies.find(row => row.id === id)?.name ?? '';
  const itemName = (item: CapacityItem) => (item.startsWith('loop_') ? tl(`names.${item}`) : t(`items.${item}`));
  const one = (n: number) => f.number(n, { maximumFractionDigits: 1 });
  const hours = (minutes: number) => t('hours', { hours: one(hoursOf(minutes)) });
  const each = (minutes: number) => (minutes >= 60 ? t('hours', { hours: one(Math.round(minutes / 6) / 10) }) : t('minutes', { minutes: one(Math.round(minutes * 10) / 10) }));
  const day = (date: string) => f.dateTime(new Date(`${date}T00:00:00+08:00`), { dateStyle: 'medium', timeZone: 'Asia/Kuala_Lumpur' });
  const monthLabel = (month: string, style: 'short' | 'long') => f.dateTime(new Date(`${month}-01T00:00:00+08:00`), { month: style, timeZone: 'Asia/Kuala_Lumpur' });
  const error = ERRORS.find(code => code === query.error);
  const scopeName = company ? nameOf(company) : null;

  const monthHours = ledger.months.map(row => hoursOf(row.freedMinutes));
  const markerIndex = view.autopilotStart ? ledger.months.findIndex(row => row.month === view.autopilotStart!.slice(0, 7)) : -1;
  const chartLabel = t('chart.label', { values: ledger.months.map((row, i) => t('chart.value', { month: monthLabel(row.month, 'long'), hours: one(monthHours[i]) })).join('; ') })
    + (markerIndex >= 0 ? ' ' + t('chart.markerSentence', { month: monthLabel(ledger.months[markerIndex].month, 'long') }) : '');
  const freedHours = ledger.freedMinutes === null ? null : hoursOf(ledger.freedMinutes);
  const changedRate = ledger.loopActions.done ? ledger.loopActions.changed / ledger.loopActions.done : null;

  return (
    <section id="hr-capacity" data-capacity-ledger aria-labelledby="capacity-title" className="scroll-mt-4 space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 id="capacity-title" className="text-xl font-semibold tracking-tight">{t('title')}</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">{scopeName ? t('descriptionCompany', { company: scopeName }) : t('descriptionAll')}</p>
        </div>
        <nav aria-label={t('periodLabel')} data-capacity-period className="flex flex-wrap gap-1.5">
          {CAPACITY_PERIODS.map((period: CapacityPeriod) => (
            <Link key={period} href={href({ period, company })} aria-current={period === view.period ? 'true' : undefined}
              className={cn(btnGhost, target, period === view.period && 'border-primary bg-primary/10 text-foreground')}>{t(`periods.${period}`)}</Link>
          ))}
        </nav>
      </div>

      {view.companies.length > 1 && (
        <form method="get" action="/assistant" className="flex flex-wrap items-end gap-2" data-capacity-company-filter>
          <input type="hidden" name="view" value="insights" />
          <input type="hidden" name="period" value={view.period} />
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">{t('companyLabel')}</span>
            <select name="company" defaultValue={company ?? ''} className={cn(inputCls, 'min-w-56', target)}>
              <option value="">{t('allCompanies', { count: view.companies.length })}</option>
              {view.companies.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
            </select>
          </label>
          <button type="submit" className={cn(btnGhost, target)}>{t('show')}</button>
        </form>
      )}

      {query.saved && /^\d+$/.test(query.saved) && <p role="status" className="rounded-lg border border-border bg-muted/50 p-3 text-sm">{t('baseline.saved', { version: query.saved })}</p>}
      {error && <ErrorBanner message={t(`baseline.errors.${error}`, { max: MAX_ITEM_MINUTES })} />}

      {view.companies.length === 0 ? <p className="text-sm text-muted-foreground">{t('noCompanies')}</p> : <>
        {ledger.freedMinutes === null ? (
          <Card className="space-y-3 p-4" data-baseline-missing>
            <h3 className="font-semibold">{t('baseline.notSet')}</h3>
            <p className="text-sm text-muted-foreground">{t('baseline.notSetBody')}</p>
            <ul className="flex flex-wrap gap-2">
              {ledger.companiesWithoutBaseline.map(id => (
                <li key={id}><Link href={href({ period: view.period, company, setup: id })} className={cn(btnPrimary, target)}>{t('baseline.setFor', { company: nameOf(id) })}</Link></li>
              ))}
            </ul>
          </Card>
        ) : ledger.companiesWithoutBaseline.length > 0 && (
          <div className="rounded-lg border border-border bg-muted/50 p-3 text-sm" data-baseline-partial>
            <p>{t('baseline.missingSome', { count: ledger.companiesWithoutBaseline.length })}</p>
            <ul className="mt-2 flex flex-wrap gap-2">
              {ledger.companiesWithoutBaseline.map(id => (
                <li key={id}><Link href={href({ period: view.period, company, setup: id })} className={cn('inline-flex min-h-9 items-center text-primary hover:underline', target)}>{t('baseline.setFor', { company: nameOf(id) })}</Link></li>
              ))}
            </ul>
          </div>
        )}

        {setup && <BaselineSetupForm setup={setup} period={view.period} company={company} t={t} itemName={itemName} day={day} one={one} />}

        <StatCells cells={[
          { label: t('tiles.freed'), value: freedHours === null
            ? <>{t('baseline.notSet')}<span className="mt-1 block text-xs font-normal text-muted-foreground">{t('tiles.freedNone')}</span></>
            : <>{t('hours', { hours: one(freedHours) })}<span className="mt-1 block text-xs font-normal text-muted-foreground">{t('tiles.freedDays', { days: one(Math.round(freedHours / WORKING_DAY_HOURS * 10) / 10) })}</span></> },
          { label: t('tiles.errors'), value: ledger.payrollErrors === null
            ? <>{t('tiles.notShown')}<span className="mt-1 block text-xs font-normal text-muted-foreground">{t('tiles.errorsNoPayroll')}</span></>
            : <>{f.number(ledger.payrollErrors)}<span className="mt-1 block text-xs font-normal text-muted-foreground">{t('tiles.errorsNote')}</span></> },
          { label: t('tiles.loops'), value: <>{f.number(ledger.loopActions.done)}<span className="mt-1 block text-xs font-normal text-muted-foreground">
            {changedRate === null ? t('tiles.loopsNone') : t('tiles.loopsChanged', { rate: f.number(changedRate, { style: 'percent', maximumFractionDigits: 1 }) })}</span></> },
          { label: t('tiles.questions'), value: ledger.questions === null
            ? <>{t('tiles.notShown')}<span className="mt-1 block text-xs font-normal text-muted-foreground">{t('tiles.questionsGroupOnly')}</span></>
            : <>{f.number(ledger.questions)}<span className="mt-1 block text-xs font-normal text-muted-foreground">{t('tiles.questionsNote')}</span></> },
        ]} />

        <section aria-labelledby="capacity-trend" className="space-y-2" data-capacity-chart>
          <h3 id="capacity-trend" className="font-semibold">{t('chart.title')}</h3>
          <Card className="p-4">
            <BarChart id="capacity-hours-by-month" categories={ledger.months.map(row => monthLabel(row.month, 'short'))}
              series={[{ label: t('chart.unit'), values: monthHours }]} ariaLabel={chartLabel}
              valueLabels={monthHours.map(value => (value > 0 ? one(value) : ''))}
              marker={markerIndex >= 0 ? { index: markerIndex, label: t('chart.marker') } : undefined} />
          </Card>
          <p className="text-xs text-muted-foreground">{t('chart.note')}</p>
        </section>

        <section aria-labelledby="capacity-by" className="space-y-2" data-capacity-table>
          <h3 id="capacity-by" className="font-semibold">{t('table.title')}</h3>
          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-sm">
                <caption className="sr-only">{t('table.title')}</caption>
                <thead className="border-b border-border bg-muted/40">
                  <tr>{(['item', 'done', 'manual', 'review', 'freed'] as const).map(key => <th key={key} scope="col" className={cn('px-4 py-3 font-medium', key !== 'item' && 'text-right')}>{t(`table.${key}`)}</th>)}</tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {ledger.rows.length === 0 ? (
                    <tr><td colSpan={5} className="px-4 py-3 text-muted-foreground">{t('table.noWork')}</td></tr>
                  ) : ledger.rows.map(row => {
                    const baselined = row.done - row.withoutBaseline;
                    return (
                      <tr key={row.item} data-capacity-row={row.item}>
                        <th scope="row" className="px-4 py-3 font-medium">{itemName(row.item)}
                          {row.withoutBaseline > 0 && <p className="mt-1 text-xs font-normal text-muted-foreground">{t('table.withoutBaseline', { count: row.withoutBaseline })}</p>}
                        </th>
                        <td className="px-4 py-3 text-right tabular-nums">{f.number(row.done)}</td>
                        <td className="px-4 py-3 text-right tabular-nums">{baselined > 0 ? each(row.manualMinutes / baselined) : <span className="text-muted-foreground">{t('table.notInBaseline')}</span>}</td>
                        <td className="px-4 py-3 text-right tabular-nums">{hours(row.reviewMinutes)}</td>
                        <td className="px-4 py-3 text-right font-medium tabular-nums">{one(hoursOf(row.freedMinutes))}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
          {!company && view.companies.length > 1 && <p className="text-xs text-muted-foreground">{t('table.averaged')}</p>}
          <p className="max-w-4xl text-xs text-muted-foreground">{t('method.summary')}</p>
          <details id="capacity-method" className="max-w-4xl text-xs text-muted-foreground" data-capacity-method>
            <summary className={cn('inline-flex min-h-9 cursor-pointer items-center font-medium text-primary hover:underline', target)}>{t('method.link')}</summary>
            <div className="mt-2 space-y-2">
              {(['work', 'baseline', 'review', 'arithmetic', 'access', 'records'] as const).map(key => <p key={key}>{t(`method.${key}`, { cap: REVIEW_CAP_MINUTES, hours: WORKING_DAY_HOURS })}</p>)}
            </div>
          </details>
        </section>

        {await CapacityProcesses({ reads: await processes, query: { pdays: query.pdays }, companies: view.companies, baselines: view.baselines, keep: { period: view.period, company } })}
      </>}
    </section>
  );
}

type T = Awaited<ReturnType<typeof getTranslations<'aiCentre.capacity'>>>;
function BaselineSetupForm({ setup, period, company, t, itemName, day, one }: {
  setup: BaselineSetup; period: CapacityPeriod; company: string | null; t: T; itemName: (item: CapacityItem) => string; day: (date: string) => string; one: (n: number) => string;
}) {
  const current = setup.current;
  const lastDay = addDays(setup.periodTo, -1);
  return (
    <Card id="capacity-setup" className="space-y-5 p-4" data-baseline-setup={setup.company.id}>
      <div>
        <h3 className="font-semibold">{t('setup.title', { company: setup.company.name })}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{t('setup.intro')}</p>
        {current && <p className="mt-1 text-sm text-muted-foreground">{t('setup.current', { version: current.version, from: day(current.periodFrom), to: day(addDays(current.periodTo, -1)) })}</p>}
      </div>

      <form method="get" action="/assistant" className="space-y-2">
        <h4 className="text-sm font-medium">{t('setup.step1')}</h4>
        <input type="hidden" name="view" value="insights" />
        <input type="hidden" name="period" value={period} />
        {company && <input type="hidden" name="company" value={company} />}
        <input type="hidden" name="setup" value={setup.company.id} />
        <p className="text-sm">{setup.autopilotStart ? t('setup.periodEnds', { date: day(setup.autopilotStart) }) : t('setup.periodEndsToday')}</p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">{t('setup.daysLabel')}</span>
            <select name="days" defaultValue={String(setup.days)} className={cn(inputCls, 'min-w-40', target)}>
              {BASELINE_DAYS.map(days => <option key={days} value={days}>{t('setup.daysOption', { days })}</option>)}
            </select>
          </label>
          <button type="submit" className={cn(btnGhost, target)}>{t('setup.usePeriod')}</button>
        </div>
        <p className="text-sm text-muted-foreground" data-baseline-period>{t('setup.period', { from: day(setup.periodFrom), to: day(lastDay) })}</p>
      </form>

      <div className="space-y-2">
        <h4 className="text-sm font-medium">{t('setup.step2')}</h4>
        <ul className="space-y-1 text-sm">
          {(['attendance_correction', 'profile_change'] as const).map(process => {
            const evidence = setup.evidence[process];
            return (
              <li key={process} data-baseline-evidence={process}>
                <span className="font-medium">{t(`setup.processes.${process}`)}: </span>
                {evidence == null ? t('setup.evidenceOff')
                  : measurable(evidence, setup.minCompleted)
                    ? t('setup.evidence', { cases: evidence.cases, completed: evidence.completed, actions: evidence.staffActions, perCase: one(Math.round(evidence.staffActions / evidence.cases * 10) / 10) })
                    : t('setup.evidenceShort', { completed: evidence.completed, min: setup.minCompleted })}
              </li>
            );
          })}
        </ul>
      </div>

      <form action={setCapacityBaselineAction} className="space-y-3">
        <h4 className="text-sm font-medium">{t('setup.step3')}</h4>
        <input type="hidden" name="company" value={setup.company.id} />
        <input type="hidden" name="days" value={String(setup.days)} />
        <label className="flex max-w-md flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">{t('setup.perAction')}</span>
          <Input name="minutesPerStaffAction" inputMode="decimal" defaultValue={current?.minutesPerStaffAction ?? ''} className={target} aria-describedby="capacity-per-action-help" />
          <span id="capacity-per-action-help" className="text-xs text-muted-foreground">{t('setup.perActionHelp', { max: MAX_MINUTES_PER_STAFF_ACTION })}</span>
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          {CAPACITY_ITEMS.map(item => {
            const prior = current?.items[item];
            return (
              <label key={item} className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">{t('setup.itemMinutes', { item: itemName(item) })}</span>
                <Input name={`minutes.${item}`} inputMode="decimal" defaultValue={prior?.basis === 'entered' ? String(prior.minutes) : ''} className={target} />
                {MEASURED_BY[item] && <span className="text-xs text-muted-foreground">{t('setup.itemMeasuredHelp')}</span>}
              </label>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">{t('setup.blankHelp', { max: MAX_ITEM_MINUTES })}</p>
        <div className="flex flex-wrap gap-2">
          <button type="submit" className={cn(btnPrimary, target)}>{t('setup.save')}</button>
          <Link href={href({ period, company })} className={cn(btnGhost, target)}>{t('setup.cancel')}</Link>
        </div>
      </form>
    </Card>
  );
}
