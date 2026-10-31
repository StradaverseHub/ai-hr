import { Fragment } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import type { RewardBoardRow, RewardRouteStep } from '@/packs/rewards/service';
import { Badge, tableWrapCls, tbodyCls, theadCls } from '@/components/ui';
import { RewardSubmit } from '../submit-button';
import { boardDecideAction } from './actions';

/**
 * P1 approvals matrix — the cells the Approvals board's List and Matrix views share, and the Matrix view itself.
 * Sync components (useTranslations), so the server page and a DOM test render the same markup. Every value comes
 * from the RewardBoardRow the service projected for THIS viewer; nothing here reads or decides anything.
 */
type T = ReturnType<typeof useTranslations<'rewards'>>;
type DutySeat = 'bu' | 'bg' | 'gr' | 'ctro' | 'ec' | 'payroll';
const RETURN_SEATS = ['bg', 'gr', 'ctro', 'ec'] as const;

export const rm = (cents: number) => new Intl.NumberFormat('en-MY', { style: 'currency', currency: 'MYR', maximumFractionDigits: 0 }).format(cents / 100);
export const boardDueDate = (locale: string, iso: string) => new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));
const dayMonth = (locale: string, iso: string) => new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));
const percent = (locale: string, bp: number) => new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(bp / 10000);
/** A step's decision time, compact in the cell ("27 Oct 22:52"), in full in its title and for screen readers. */
const decidedShort = (locale: string, at: Date) => new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Kuala_Lumpur' }).format(at);
const decidedFull = (locale: string, at: Date) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kuala_Lumpur' }).format(at);
/** Matrix header cells: thCls with a tighter gutter, so a whole route fits at 1440px. */
const mthCls = 'px-2 py-2 font-medium';
const dash = <span className="text-muted-foreground">—</span>;

/**
 * The decision words for a row waiting on the viewer: `full` names where the review goes (header sentence),
 * `short` is the table-row button. One label per seat at the current step: BU submits, BG approves, Group
 * Rewards sends to CTRO, CTRO sends to EC, EC approves for payroll; an off-cycle route that ends early approves
 * for payroll at its last approver. Labels only — the decision itself is boardDecideAction's.
 */
export function boardActionLabels(t: T, r: Pick<RewardBoardRow, 'action' | 'seat' | 'nextSeat'>): { full: string; short: string } | null {
  const seat = (s: string) => t(`board.seat.${s}`);
  if (r.action === 'submit') return { full: r.nextSeat ? t('board.submitTo', { seat: seat(r.nextSeat) }) : t('board.button.submit'), short: t('board.button.submit') };
  if (r.action !== 'approve') return null;
  if (r.nextSeat === 'payroll') return { full: t('board.approveFinal'), short: t('board.button.approve') };
  if (r.seat === 'bg' || !r.nextSeat) return { full: t('board.button.approve'), short: t('board.button.approve') };
  return { full: t('board.sendTo', { seat: seat(r.nextSeat) }), short: t('board.sendTo', { seat: r.nextSeat === 'ec' ? t('board.seatShort.ec') : seat(r.nextSeat) }) };
}
/** The Return link's words for the seat that holds the review; null where no return exists (BU, payroll). */
export function boardReturnLabel(t: T, seat: RewardBoardRow['seat']): string | null {
  return RETURN_SEATS.includes(seat as typeof RETURN_SEATS[number]) ? t(`board.returnTo.${seat}`) : null;
}
/** One header phrase per distinct step waiting on the viewer: "Send to CTRO or return to BG / BU". */
export function boardStepPhrase(t: T, locale: string, r: RewardBoardRow): string {
  if (r.action === 'post') return t('board.stepPhrase.post');
  const full = boardActionLabels(t, r)?.full ?? '';
  const back = r.canReturn ? boardReturnLabel(t, r.seat) : null;
  return back ? t('board.stepOr', { action: full, return: back.charAt(0).toLocaleLowerCase(locale) + back.slice(1) }) : full;
}

export function BoardUnitLink({ r }: { r: RewardBoardRow }) {
  return <Link className="font-medium text-primary hover:underline" href={`/rewards/${r.id}`}>{r.cycle} · {r.name}</Link>;
}

export function BoardSalary({ r }: { r: RewardBoardRow }) {
  const t = useTranslations('rewards'), locale = useLocale();
  return r.salary ? <>
    <div className="whitespace-nowrap tabular-nums">{rm(r.salary.increaseCents)}</div>
    {r.salary.poolShareBp !== null && <div className={`text-xs ${r.salary.overLimit ? 'font-semibold text-destructive' : 'text-muted-foreground'}`}>{t('board.ofPool', { percent: percent(locale, r.salary.poolShareBp) })}{r.salary.overLimit && <> · {t('board.overLimit')}</>}</div>}
  </> : dash;
}

export function BoardBonus({ r }: { r: RewardBoardRow }) {
  const t = useTranslations('rewards'), locale = useLocale();
  return r.bonus ? <>
    <div className="whitespace-nowrap tabular-nums">{rm(r.bonus.totalCents)}</div>
    {r.bonus.budgetShareBp !== null && <div className={`text-xs ${r.bonus.overLimit ? 'font-semibold text-destructive' : 'text-muted-foreground'}`}>{t('board.ofBudget', { percent: percent(locale, r.bonus.budgetShareBp) })}{r.bonus.overLimit && <> · {t('board.overLimit')}</>}</div>}
  </> : dash;
}

export function BoardAction({ r }: { r: RewardBoardRow }) {
  const t = useTranslations('rewards');
  const back = r.canReturn ? boardReturnLabel(t, r.seat) : null;
  return <div className="flex flex-wrap items-center justify-end gap-2">
    {back && <Link className="whitespace-nowrap text-sm text-primary hover:underline" href={`/rewards/${r.id}?view=approvals`}>{back}</Link>}
    {r.ready && (r.action === 'approve' || r.action === 'submit')
      ? <form action={boardDecideAction}><input type="hidden" name="unitId" value={r.id} /><input type="hidden" name="revision" value={r.revision} /><input type="hidden" name="action" value={r.action} /><RewardSubmit type="submit" size="sm">{boardActionLabels(t, r)!.short}</RewardSubmit></form>
      : <Link className="whitespace-nowrap text-sm font-medium text-primary hover:underline" href={`/rewards/${r.id}${r.waiting ? '?view=approvals' : ''}`}>{t('board.openReview')}</Link>}
    {r.waiting && r.blocking > 0 && <span className="basis-full text-right text-xs text-muted-foreground">{t('board.blockedHint')}</span>}
  </div>;
}

function StepCell({ r, p }: { r: RewardBoardRow; p: RewardRouteStep }) {
  const t = useTranslations('rewards'), locale = useLocale();
  if (p.state === 'done') return <>
    <Badge variant="success" className="whitespace-nowrap normal-case">{t('board.stepState.done')}</Badge>
    {p.doneAt && <div title={decidedFull(locale, p.doneAt)} className="mt-1 whitespace-nowrap text-xs tabular-nums text-muted-foreground"><time dateTime={p.doneAt.toISOString()}><span aria-hidden="true">{decidedShort(locale, p.doneAt)}</span><span className="sr-only">{decidedFull(locale, p.doneAt)}</span></time></div>}
  </>;
  if (p.state === 'pending') return <><span aria-hidden="true" className="text-muted-foreground">○</span><span className="sr-only">{t('board.stepState.notReached')}</span></>;
  const chip = r.returnedTo
    ? <Badge variant="warning" className="whitespace-nowrap normal-case">{t('board.stepState.returned')}</Badge>
    : r.waiting
      ? <span className="inline-flex items-center whitespace-nowrap rounded-full bg-primary px-2 py-0.5 text-xs font-semibold text-primary-foreground">{t('board.stepState.yours')}</span>
      : <span className="inline-flex items-center whitespace-nowrap rounded-full border border-border px-2 py-0.5 text-xs font-medium text-foreground">{t('board.stepState.withThem')}</span>;
  const overdue = r.daysUntilDue !== null && r.daysUntilDue < 0;
  return <>{chip}{r.due && <div className={`mt-1 whitespace-nowrap text-xs tabular-nums ${overdue ? 'font-semibold text-destructive' : 'text-muted-foreground'}`}>{t(overdue ? 'board.overdueOn' : 'board.dueOn', { date: dayMonth(locale, r.due) })}</div>}</>;
}

/** The route a row travels. Annual and off-cycle reviews can share the same seats, so the kind is part of the key. */
const routeKey = (r: RewardBoardRow) => `${r.kind === 'annual' ? 'annual' : 'offcycle'}:${r.progress ? r.progress.map(p => p.seat).join('>') : ''}`;

/**
 * The Matrix view of one board section: one table per distinct route, one column per step of that route, and a
 * header row per company (AI-HR has no business-group entity). A row whose review has left the route (progress
 * null) sits in a table of its own, with "—" for its step. The payroll column names the calendar's payroll date
 * only when every review in the table shares it.
 */
export function RewardBoardMatrix({ rows, section }: { rows: RewardBoardRow[]; section: string }) {
  const t = useTranslations('rewards'), locale = useLocale();
  const routes = new Map<string, RewardBoardRow[]>();
  for (const r of rows) routes.set(routeKey(r), [...(routes.get(routeKey(r)) ?? []), r]);
  return <div className="space-y-4">{[...routes.values()].map((list, i) => {
    const seats = list[0].progress?.map(p => p.seat as DutySeat) ?? null;
    const payDates = [...new Set(list.map(r => r.payrollDue))];
    const payOn = payDates.length === 1 && payDates[0] ? payDates[0] : null;
    const id = `board-${section}-route-${i}`;
    const span = 5 + (seats?.length ?? 1);
    return <div key={routeKey(list[0])} className="space-y-1">
      <h3 id={id} className="text-sm font-medium text-muted-foreground">{t(list[0].kind === 'annual' ? 'board.route.annual' : 'board.route.offcycle')}</h3>
      <div className={tableWrapCls}><table aria-labelledby={id} className="w-full text-sm">
        <thead className={theadCls}><tr>
          <th scope="col" className={mthCls}>{t('board.columns.unit')}</th>
          <th scope="col" className={`${mthCls} text-right`}>{t('board.columns.salary')}</th>
          <th scope="col" className={`${mthCls} text-right`}>{t('board.columns.bonus')}</th>
          <th scope="col" className={`${mthCls} text-right`}>{t('board.columns.flags')}</th>
          {/* The header may wrap (the Atelier theme sets nowrap on every th, so the wrapping lives on an inner div). */}
          {seats ? seats.map((seat, n) => <th key={seat} scope="col" className="min-w-[5.5rem] px-1.5 py-2 align-bottom text-xs font-medium">
            <div className="whitespace-normal"><span className="tabular-nums">{n + 1}</span> {t(`board.seat.${seat}`)}</div>
            <div className="whitespace-normal font-normal normal-case leading-snug tracking-normal">{seat === 'payroll' && payOn ? t('board.payOn', { date: dayMonth(locale, payOn) }) : t(`board.duty.${seat}`)}</div>
          </th>) : <th scope="col" className={mthCls}>{t('board.columns.stage')}</th>}
          <th scope="col" className={`${mthCls} text-right`}>{t('board.columns.action')}</th>
        </tr></thead>
        <tbody className={tbodyCls}>{list.map((r, n) => <Fragment key={r.id}>
          {(n === 0 || list[n - 1].companyId !== r.companyId) && <tr><th scope="colgroup" colSpan={span} className="bg-muted/30 px-3 py-1.5 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">{r.company}</th></tr>}
          <tr className="align-top">
            <td className="px-2 py-3">
              <Link className="font-semibold text-primary hover:underline" href={`/rewards/${r.id}`}>{r.name}</Link>
              <div className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">{t('board.peopleCount', { count: r.people })}</div>
              <div title={r.cycle} className="max-w-[8rem] truncate text-xs text-muted-foreground">{r.cycle}</div>
            </td>
            <td className="px-2 py-3 text-right"><BoardSalary r={r} /></td>
            <td className="px-2 py-3 text-right"><BoardBonus r={r} /></td>
            <td className="px-2 py-3 text-right"><span className={`tabular-nums ${r.blocking ? 'font-semibold text-destructive' : r.exceptions ? '' : 'text-muted-foreground'}`}>{r.exceptions + r.blocking}</span></td>
            {r.progress ? r.progress.map(p => <td key={p.seat} className="px-1.5 py-3"><StepCell r={r} p={p} /></td>) : <td className="px-1.5 py-3">{dash}</td>}
            <td className="px-2 py-3 text-right"><BoardAction r={r} /></td>
          </tr>
        </Fragment>)}</tbody>
      </table></div>
    </div>;
  })}</div>;
}
