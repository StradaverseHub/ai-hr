import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { requireModule } from '@/lib/authz';
import { rewardApprovalsBoard, rewardDueWording, type RewardBoardRow } from '@/packs/rewards/service';
import { Badge, ErrorBanner, PageHeader, tableWrapCls, tbodyCls, theadCls, thCls } from '@/components/ui';
import { RewardSubmit } from '../submit-button';
import { boardDecideAction, sendReadyAction } from './actions';

const rm = (cents: number) => new Intl.NumberFormat('en-MY', { style: 'currency', currency: 'MYR', maximumFractionDigits: 0 }).format(cents / 100);
const COLUMNS = ['unit', 'stage', 'due', 'people', 'salary', 'bonus', 'exceptions', 'blocking', 'action'] as const;

/**
 * P1 WP-G — the Rewards approvals board. Every number comes from rewardApprovalsBoard, which reads each review
 * through the review page's own projection: a row shows only what this viewer may see on that review.
 */
export default async function RewardApprovalsPage({ searchParams }: { searchParams: Promise<{ group?: string; error?: string; decided?: string; sent?: string; skipped?: string; refused?: string; refusedDetail?: string }> }) {
  await requireModule('rewards');
  const { s, scopeIds } = await scopedSession();
  const sp = await searchParams;
  const t = await getTranslations('rewards');
  const locale = await getLocale();
  const all = await rewardApprovalsBoard(s, scopeIds);
  const groups = [...new Map(all.map(r => [r.companyId, r.company])).entries()].sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]));
  const group = groups.some(([id]) => id === sp.group) ? sp.group : undefined;
  const rows = group ? all.filter(r => r.companyId === group) : all;
  const waiting = rows.filter(r => r.waiting), elsewhere = rows.filter(r => !r.waiting);
  const sendable = waiting.filter(r => r.action === 'approve');
  const ready = sendable.filter(r => r.ready);
  const steps = [...new Set(all.filter(r => r.waiting).map(r => r.action!))];
  const dueDate = (iso: string) => new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));
  const percent = (bp: number) => new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(bp / 10000);
  let refusedDetail: [string, string][] = [];
  try { refusedDetail = sp.refusedDetail ? JSON.parse(sp.refusedDetail) : []; } catch { refusedDetail = []; }

  const relative = (n: number) => { const w = rewardDueWording(n); return t(`board.${w.key}`, { days: w.days }); };
  const cell = (r: RewardBoardRow, key: typeof COLUMNS[number]) => {
    switch (key) {
      case 'unit': return <><Link className="font-medium text-primary hover:underline" href={`/rewards/${r.id}`}>{r.cycle} · {r.name}</Link><div className="text-xs text-muted-foreground">{r.company}</div></>;
      case 'stage': return <>
        <Badge variant={r.returnedTo ? 'warning' : r.waiting ? 'accent' : 'default'}>{r.returnedTo ? t(`returnedTo.${r.returnedTo}`) : r.seat ? t('board.with', { seat: t(`board.seat.${r.seat}`) }) : t(`stages.${r.status}`)}</Badge>
        {r.step && <div className="mt-1 text-xs text-muted-foreground">{t('board.stepOf', r.step)}</div>}
      </>;
      case 'due': return r.due && r.daysUntilDue !== null ? <>
        <div className="tabular-nums">{dueDate(r.due)}</div>
        <div className={`text-xs ${r.daysUntilDue < 0 ? 'font-semibold text-destructive' : 'text-muted-foreground'}`}>{relative(r.daysUntilDue)}</div>
      </> : <span className="text-muted-foreground">—</span>;
      case 'people': return <span className="tabular-nums">{r.people}</span>;
      case 'salary': return r.salary ? <>
        <div className="tabular-nums">{rm(r.salary.increaseCents)}</div>
        {r.salary.poolShareBp !== null && <div className={`text-xs ${r.salary.overLimit ? 'font-semibold text-destructive' : 'text-muted-foreground'}`}>{t('board.ofPool', { percent: percent(r.salary.poolShareBp) })}{r.salary.overLimit && <> · {t('board.overLimit')}</>}</div>}
      </> : <span className="text-muted-foreground">—</span>;
      case 'bonus': return r.bonus ? <>
        <div className="tabular-nums">{rm(r.bonus.totalCents)}</div>
        {r.bonus.budgetShareBp !== null && <div className={`text-xs ${r.bonus.overLimit ? 'font-semibold text-destructive' : 'text-muted-foreground'}`}>{t('board.ofBudget', { percent: percent(r.bonus.budgetShareBp) })}{r.bonus.overLimit && <> · {t('board.overLimit')}</>}</div>}
      </> : <span className="text-muted-foreground">—</span>;
      case 'exceptions': return <span className={`tabular-nums ${r.exceptions ? '' : 'text-muted-foreground'}`}>{r.exceptions}</span>;
      case 'blocking': return <span className={`tabular-nums ${r.blocking ? 'font-semibold text-destructive' : 'text-muted-foreground'}`}>{r.blocking}</span>;
      case 'action': return <div className="flex flex-wrap items-center justify-end gap-2">
        {r.canReturn && <Link className="text-sm text-primary hover:underline" href={`/rewards/${r.id}?view=approvals`}>{t('board.return')}</Link>}
        {r.ready && (r.action === 'approve' || r.action === 'submit')
          ? <form action={boardDecideAction}><input type="hidden" name="unitId" value={r.id} /><input type="hidden" name="revision" value={r.revision} /><input type="hidden" name="action" value={r.action} /><RewardSubmit type="submit" size="sm">{t(r.action)}</RewardSubmit></form>
          : <Link className="text-sm font-medium text-primary hover:underline" href={`/rewards/${r.id}${r.waiting ? '?view=approvals' : ''}`}>{t('board.openReview')}</Link>}
        {r.waiting && r.blocking > 0 && <span className="basis-full text-right text-xs text-muted-foreground">{t('board.blockedHint')}</span>}
      </div>;
    }
  };
  const table = (list: RewardBoardRow[]) => <div className={tableWrapCls}><table className="w-full text-sm">
    <thead className={theadCls}><tr>{COLUMNS.map(k => <th key={k} scope="col" className={`${thCls} ${['people', 'salary', 'bonus', 'exceptions', 'blocking', 'action'].includes(k) ? 'text-right' : ''}`}>{t(`board.columns.${k}`)}</th>)}</tr></thead>
    <tbody className={tbodyCls}>{list.map(r => <tr key={r.id} className="align-top">{COLUMNS.map(k => <td key={k} className={`px-3 py-3 ${['people', 'salary', 'bonus', 'exceptions', 'blocking', 'action'].includes(k) ? 'text-right' : ''}`}>{cell(r, k)}</td>)}</tr>)}</tbody>
  </table></div>;

  return <div className="w-full space-y-6">
    <Link href="/rewards" className="text-sm text-primary hover:underline">← {t('title')}</Link>
    <PageHeader title={t('board.title')} description={steps.length ? t('board.yourStep', { steps: steps.map(a => t(`board.stepPhrase.${a}`)).join('; ') }) : t('board.nothingYours')}
      actions={ready.length > 0 ? <form action={sendReadyAction}>{sendable.map(r => <input key={r.id} type="hidden" name="seen" value={`${r.id}:${r.revision}`} />)}<RewardSubmit type="submit">{t('board.sendAll', { count: ready.length })}</RewardSubmit></form> : undefined} />
    <ErrorBanner message={sp.error} />
    {sp.decided && <p role="status" className="text-sm">{t('board.decided')}</p>}
    {sp.sent !== undefined && <div role="status" className="space-y-1 text-sm">
      <p>{t('board.sendResult', { sent: Number(sp.sent) || 0, skipped: Number(sp.skipped) || 0, refused: Number(sp.refused) || 0 })}</p>
      {refusedDetail.length > 0 && <ul className="list-disc pl-5 text-muted-foreground">{refusedDetail.map(([name, message], i) => <li key={i}>{t('board.refusedItem', { name, message })}</li>)}</ul>}
    </div>}
    {groups.length > 1 && <nav aria-label={t('board.groups')} className="flex flex-wrap gap-2">
      {[[undefined, t('board.allGroups'), all.length] as const, ...groups.map(([id, name]) => [id, name, all.filter(r => r.companyId === id).length] as const)].map(([id, name, count]) =>
        <Link key={id ?? 'all'} href={id ? `/rewards/approvals?group=${id}` : '/rewards/approvals'} aria-current={group === id ? 'page' : undefined}
          className={`rounded-full border px-3 py-1 text-sm ${group === id ? 'border-primary bg-primary/10 font-semibold text-primary' : 'border-border text-muted-foreground hover:bg-accent'}`}>{name} <span className="tabular-nums">{count}</span></Link>)}
    </nav>}
    {!all.length ? <p className="max-w-2xl text-sm text-muted-foreground">{t('board.empty')}</p> : <>
      <section className="space-y-2"><h2 className="text-base font-semibold">{t('board.waiting', { count: waiting.length })}</h2>
        {waiting.length ? table(waiting) : <p className="text-sm text-muted-foreground">{t('board.noneWaiting')}</p>}</section>
      {elsewhere.length > 0 && <section className="space-y-2"><h2 className="text-base font-semibold">{t('board.elsewhere', { count: elsewhere.length })}</h2>{table(elsewhere)}</section>}
      <p className="max-w-3xl text-xs text-muted-foreground">{t('board.footer')}</p>
    </>}
  </div>;
}
