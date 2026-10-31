import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { requireModule } from '@/lib/authz';
import { rewardApprovalsBoard, rewardDueWording, type RewardBoardRow } from '@/packs/rewards/service';
import { Badge, ErrorBanner, PageHeader, tableWrapCls, tbodyCls, theadCls, thCls } from '@/components/ui';
import { SEGMENTED_BTN, SEGMENTED_BTN_ACTIVE, SEGMENTED_BTN_INACTIVE, SEGMENTED_GROUP } from '@/lib/segmented-control';
import { RewardSubmit } from '../submit-button';
import { sendReadyAction } from './actions';
import { BoardAction, BoardBonus, BoardSalary, BoardUnitLink, RewardBoardMatrix, boardDueDate, boardStepPhrase } from './board-parts';

const COLUMNS = ['unit', 'stage', 'due', 'people', 'salary', 'bonus', 'exceptions', 'blocking', 'action'] as const;

/**
 * P1 WP-G — the Rewards approvals board. Every number comes from rewardApprovalsBoard, which reads each review
 * through the review page's own projection: a row shows only what this viewer may see on that review.
 * Two views of the same rows: Matrix (default; one column per step of each route) and List.
 */
export default async function RewardApprovalsPage({ searchParams }: { searchParams: Promise<{ view?: string; group?: string; error?: string; decided?: string; sent?: string; skipped?: string; refused?: string; refusedDetail?: string }> }) {
  await requireModule('rewards');
  const { s, scopeIds } = await scopedSession();
  const sp = await searchParams;
  const t = await getTranslations('rewards');
  const locale = await getLocale();
  const all = await rewardApprovalsBoard(s, scopeIds);
  const groups = [...new Map(all.map(r => [r.companyId, r.company])).entries()].sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]));
  const group = groups.some(([id]) => id === sp.group) ? sp.group : undefined;
  const view: 'matrix' | 'list' = sp.view === 'list' ? 'list' : 'matrix';
  const href = (next: { view: 'matrix' | 'list'; group: string | undefined }) => {
    const q = new URLSearchParams({ ...(next.view === 'list' ? { view: 'list' } : {}), ...(next.group ? { group: next.group } : {}) }).toString();
    return q ? `/rewards/approvals?${q}` : '/rewards/approvals';
  };
  const rows = group ? all.filter(r => r.companyId === group) : all;
  const waiting = rows.filter(r => r.waiting), elsewhere = rows.filter(r => !r.waiting);
  const sendable = waiting.filter(r => r.action === 'approve');
  const ready = sendable.filter(r => r.ready);
  // One phrase per distinct step waiting on the viewer, in the words of its decision: "Send to CTRO or return to BG / BU".
  const steps = [...new Set(all.filter(r => r.waiting).map(r => boardStepPhrase(t, locale, r)))];
  const dueDate = (iso: string) => boardDueDate(locale, iso);
  let refusedDetail: [string, string][] = [];
  try { refusedDetail = sp.refusedDetail ? JSON.parse(sp.refusedDetail) : []; } catch { refusedDetail = []; }

  const relative = (n: number) => { const w = rewardDueWording(n); return t(`board.${w.key}`, { days: w.days }); };
  const cell = (r: RewardBoardRow, key: typeof COLUMNS[number]) => {
    switch (key) {
      case 'unit': return <><BoardUnitLink r={r} /><div className="text-xs text-muted-foreground">{r.company}</div></>;
      case 'stage': return <>
        <Badge className="whitespace-nowrap normal-case" variant={r.returnedTo ? 'warning' : r.waiting ? 'accent' : 'default'}>{r.returnedTo ? t(`returnedTo.${r.returnedTo}`) : r.seat ? t('board.with', { seat: t(`board.seat.${r.seat}`) }) : t(`stages.${r.status}`)}</Badge>
        {r.step && <div className="mt-1 text-xs text-muted-foreground">{t('board.stepOf', r.step)}</div>}
      </>;
      case 'due': return r.due && r.daysUntilDue !== null ? <>
        <div className="tabular-nums">{dueDate(r.due)}</div>
        <div className={`text-xs ${r.daysUntilDue < 0 ? 'font-semibold text-destructive' : 'text-muted-foreground'}`}>{relative(r.daysUntilDue)}</div>
      </> : <span className="text-muted-foreground">—</span>;
      case 'people': return <span className="tabular-nums">{r.people}</span>;
      case 'salary': return <BoardSalary r={r} />;
      case 'bonus': return <BoardBonus r={r} />;
      case 'exceptions': return <span className={`tabular-nums ${r.exceptions ? '' : 'text-muted-foreground'}`}>{r.exceptions}</span>;
      case 'blocking': return <span className={`tabular-nums ${r.blocking ? 'font-semibold text-destructive' : 'text-muted-foreground'}`}>{r.blocking}</span>;
      case 'action': return <BoardAction r={r} />;
    }
  };
  const table = (list: RewardBoardRow[]) => <div className={tableWrapCls}><table className="w-full text-sm">
    <thead className={theadCls}><tr>{COLUMNS.map(k => <th key={k} scope="col" className={`${thCls} ${['people', 'salary', 'bonus', 'exceptions', 'blocking', 'action'].includes(k) ? 'text-right' : ''}`}>{t(`board.columns.${k}`)}</th>)}</tr></thead>
    <tbody className={tbodyCls}>{list.map(r => <tr key={r.id} className="align-top">{COLUMNS.map(k => <td key={k} className={`px-3 py-3 ${['people', 'salary', 'bonus', 'exceptions', 'blocking', 'action'].includes(k) ? 'text-right' : ''}`}>{cell(r, k)}</td>)}</tr>)}</tbody>
  </table></div>;
  const section = (list: RewardBoardRow[], name: string) => view === 'matrix' ? <RewardBoardMatrix rows={list} section={name} /> : table(list);

  return <div className="w-full space-y-6">
    <Link href="/rewards" className="text-sm text-primary hover:underline">← {t('title')}</Link>
    <PageHeader title={t('board.title')} description={steps.length ? t('board.yourStep', { steps: steps.join('; ') }) : t('board.nothingYours')}
      actions={<>
        {all.length > 0 && <nav aria-label={t('board.view.label')} className={SEGMENTED_GROUP}>{(['matrix', 'list'] as const).map(v =>
          <Link key={v} href={href({ view: v, group })} aria-current={view === v ? 'page' : undefined} className={`${SEGMENTED_BTN} ${view === v ? SEGMENTED_BTN_ACTIVE : SEGMENTED_BTN_INACTIVE}`}>{t(`board.view.${v}`)}</Link>)}</nav>}
        {ready.length > 0 && <form action={sendReadyAction}>{sendable.map(r => <input key={r.id} type="hidden" name="seen" value={`${r.id}:${r.revision}`} />)}<RewardSubmit type="submit">{t('board.sendAll', { count: ready.length })}</RewardSubmit></form>}
      </>} />
    <ErrorBanner message={sp.error} />
    {sp.decided && <p role="status" className="text-sm">{t('board.decided')}</p>}
    {sp.sent !== undefined && <div role="status" className="space-y-1 text-sm">
      <p>{t('board.sendResult', { sent: Number(sp.sent) || 0, skipped: Number(sp.skipped) || 0, refused: Number(sp.refused) || 0 })}</p>
      {refusedDetail.length > 0 && <ul className="list-disc pl-5 text-muted-foreground">{refusedDetail.map(([name, message], i) => <li key={i}>{t('board.refusedItem', { name, message })}</li>)}</ul>}
    </div>}
    {groups.length > 1 && <nav aria-label={t('board.groups')} className="flex flex-wrap gap-2">
      {[[undefined, t('board.allGroups'), all.length] as const, ...groups.map(([id, name]) => [id, name, all.filter(r => r.companyId === id).length] as const)].map(([id, name, count]) =>
        <Link key={id ?? 'all'} href={href({ view, group: id })} aria-current={group === id ? 'page' : undefined}
          className={`rounded-full border px-3 py-1 text-sm ${group === id ? 'border-primary bg-primary/10 font-semibold text-primary' : 'border-border text-muted-foreground hover:bg-accent'}`}>{name} <span className="tabular-nums">{count}</span></Link>)}
    </nav>}
    {!all.length ? <p className="max-w-2xl text-sm text-muted-foreground">{t('board.empty')}</p> : <>
      <section className="space-y-2"><h2 className="text-base font-semibold">{t('board.waiting', { count: waiting.length })}</h2>
        {waiting.length ? section(waiting, 'waiting') : <p className="text-sm text-muted-foreground">{t('board.noneWaiting')}</p>}</section>
      {elsewhere.length > 0 && <section className="space-y-2"><h2 className="text-base font-semibold">{t('board.elsewhere', { count: elsewhere.length })}</h2>{section(elsewhere, 'elsewhere')}</section>}
      <p className="max-w-3xl text-xs text-muted-foreground">{t('board.footer')}</p>
    </>}
  </div>;
}
