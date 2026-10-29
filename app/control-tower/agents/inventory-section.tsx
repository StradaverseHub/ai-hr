/** WP12 (R8, R21): the one AI inventory, grouped by component kind, and the provider data register.
 * Desktop: one table per group. Mobile: each row stacks into a card. A company HR administrator gets the read-only
 * registry/tier columns only (core/ai-inventory.ts already withheld everything else). */
import { getFormatter, getTranslations } from 'next-intl/server';
import { Badge, Card, SectionHeader, btnGhost } from '@/components/ui';
import { AI_COMPONENT_KINDS, type AiComponentKind } from '@/lib/ai/ai-inventory';
import type { AiInventoryView, AiInventoryRuntime } from '@/core/ai-inventory';
import { setAgentActionPauseAction } from './actions';

type Row = Extract<AiInventoryView,{scope:'full'}>['rows'][number] | Extract<AiInventoryView,{scope:'registry'}>['rows'][number];
const isPaused = (r:Row) => ('runtime' in r ? r.runtime.actionPaused : r.actionPaused) === true;
const rowAnchor = (key:string) => `ai-component-${key.replace(/[^a-z0-9_-]/gi,'-')}`;

export async function AiInventorySection({inventory,mayPause}:{inventory:AiInventoryView;mayPause:boolean}) {
  const t = await getTranslations('aiManagement');
  const f = await getFormatter();
  const full = inventory.scope==='full';
  const n = (v:number) => f.number(v);
  const date = (d:Date|null) => d ? f.dateTime(d,{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kuala_Lumpur'}) : t('inv.never');
  const name = (r:Row) => {
    switch (r.kind) {
      case 'chat': case 'specialist': case 'embedded_feature': return t.has(`features.${r.id}`) ? t(`features.${r.id}`) : r.id;
      case 'scheduled_job': return t(`inv.jobs.${r.id.replace('.','-')}`);
      case 'orchestrator_step': return t(`inv.steps.${r.id}`);
      case 'operator_loop': return t('inv.improve');
      default: return r.id;
    }
  };
  const tier = (r:Row) => r.tier ? <Badge className="whitespace-nowrap" variant={r.tier==='automatic'?'warning':undefined}>{t(`inv.tiers.${r.tier}`)}</Badge> : <span className="text-muted-foreground">{r.category==='read'?t('inv.readOnly'):'—'}</span>;
  const pause = (r:Row) => r.pauseKey ? <span className="break-all font-mono text-xs">{r.pauseKey}</span> : <span className="text-muted-foreground">—</span>;
  const pausedState = (r:Row) => r.kind==='action' ? (isPaused(r) ? <Badge className="whitespace-nowrap" variant="danger">{t('inv.actionPaused')}</Badge> : <span className="text-xs text-emerald-700 dark:text-emerald-300">{t('inv.actionActive')}</span>) : null;
  const pauseControl = (r:Row) => mayPause && full && r.kind==='action' ? <form action={setAgentActionPauseAction}>
    <input type="hidden" name="action" value={r.id}/><input type="hidden" name="paused" value={String(!isPaused(r))}/>
    <button type="submit" className={btnGhost} aria-label={`${t(isPaused(r)?'inv.resumeAction':'inv.pauseAction')} · ${r.id}`}>{t(isPaused(r)?'inv.resumeAction':'inv.pauseAction')}</button>
  </form> : null;
  const sw = (rt:AiInventoryRuntime, r:Row) => r.outOfBand ? t('inv.outOfBand') : rt.switch.kind==='none' ? '—'
    : `${t(`inv.switchKinds.${rt.switch.kind}`)} · ${rt.switch.on===null?'—':t(rt.switch.on?'inv.on':'inv.off')}${rt.switch.state&&t.has(`states.${rt.switch.state}`)?` · ${t(`states.${rt.switch.state}`)}`:''}`;
  const allowance = (rt:AiInventoryRuntime) => rt.allowance ? t('inv.allowanceDefault',{daily:rt.allowance.dailyRequests==null?t('unlimited'):n(rt.allowance.dailyRequests),tokens:rt.allowance.monthlyTokens==null?t('unlimited'):n(rt.allowance.monthlyTokens)}) : t('inv.allowanceNone');
  const use = (rt:AiInventoryRuntime, r:Row) => r.kind==='action'||r.kind==='read_binding' ? <span className="text-xs text-muted-foreground">{t('inv.countedUnderChat')}</span>
    : rt.use30 ? <span className="text-xs">{t('inv.use30',{runs:n(rt.use30.runs),tokens:n(rt.use30.tokens),failed:n(rt.use30.failed),blocked:n(rt.use30.blocked)})}<br/><span className="text-muted-foreground">{rt.use30.reportedCredits==null?t('inv.creditsUnknown'):t('inv.credits',{credits:f.number(rt.use30.reportedCredits,{maximumSignificantDigits:6})})}</span></span> : '—';
  const outcomes = (rt:AiInventoryRuntime) => rt.outcomes ? <span className="text-xs">{t('inv.outcomes',{prepared:n(rt.outcomes.prepared),completed:n(rt.outcomes.completed),refused:n(rt.outcomes.refused),discarded:n(rt.outcomes.discarded),expired:n(rt.outcomes.expired)})}{rt.outcomes.prepared>0&&<><br/><span className="text-muted-foreground">{t('inv.rates',{completed:f.number(rt.outcomes.completed/rt.outcomes.prepared,{style:'percent'}),refused:f.number(rt.outcomes.refused/rt.outcomes.prepared,{style:'percent'})})}</span></>}</span> : '—';
  const audit = (rt:AiInventoryRuntime) => rt.audit.count ? t('inv.audit',{count:rt.audit.count,date:date(rt.audit.latestAt)}) : t('inv.auditNone');
  const cols = full ? ['component','tier','switch','pauseKey','allowance','lastRun','use30','outcomes','audit'] as const : ['component','tier','pauseKey'] as const;
  const cell = (r:Row, col:typeof cols[number]) => {
    const rt = 'runtime' in r ? r.runtime : null;
    switch (col) {
      case 'component': return <><p className="font-medium break-words">{name(r)}</p>{r.kind!=='action'&&r.kind!=='read_binding'?null:<p className="text-xs text-muted-foreground">{r.module}</p>}{r.outOfBand&&<p className="text-xs text-amber-700 dark:text-amber-300">{t('inv.outOfBandHelp')}</p>}</>;
      case 'tier': return tier(r);
      case 'pauseKey': return <div className="flex flex-col items-start gap-1">{pause(r)}{pausedState(r)}{pauseControl(r)}</div>;
      case 'switch': return rt ? sw(rt,r) : null;
      case 'allowance': return rt ? <span className="text-xs">{allowance(rt)}</span> : null;
      case 'lastRun': return rt ? <span className="whitespace-nowrap text-xs">{r.kind==='action'?'—':date(rt.lastRun)}</span> : null;
      case 'use30': return rt ? use(rt,r) : null;
      case 'outcomes': return rt ? outcomes(rt) : null;
      case 'audit': return rt ? <span className="text-xs">{audit(rt)}</span> : null;
    }
  };
  const pausedRows = (inventory.rows as readonly Row[]).filter(r=>r.kind==='action'&&isPaused(r));
  const groups = AI_COMPONENT_KINDS.map(kind=>({kind,rows:(inventory.rows as readonly Row[]).filter(r=>r.kind===kind)})).filter(g=>g.rows.length>0);
  return <>
    <Card id="ai-inventory" className="scroll-mt-4 overflow-hidden">
      <div className="p-5"><SectionHeader title={t('inv.title')}/><p className="mt-1 max-w-4xl text-sm text-muted-foreground">{t('inv.intro')}</p>
        {!full&&<p className="mt-2 max-w-4xl text-sm text-muted-foreground" role="note">{t('inv.registryNotice')}</p>}
        {full&&<p className="mt-2 max-w-4xl text-xs text-muted-foreground">{t('inv.costHelp')}</p>}</div>
      {/* Mobile: paused actions first, then each group collapsed; a row is a compact summary that expands. */}
      {pausedRows.length>0&&<section aria-labelledby="ai-paused-mobile" className="border-t border-border px-4 py-3 md:hidden">
        <h3 id="ai-paused-mobile" className="text-sm font-semibold">{t('inv.pausedTitle')} <span className="font-normal text-muted-foreground">({n(pausedRows.length)})</span></h3>
        <ul className="mt-1 space-y-1">{pausedRows.map(r=><li key={r.key} className="flex flex-wrap items-center gap-2 text-sm"><a href={`#${rowAnchor(r.key)}-card`} className="break-all text-primary hover:underline">{name(r)}</a>{pausedState(r)}</li>)}</ul>
      </section>}
      {groups.map(({kind,rows})=><section key={kind} aria-labelledby={`ai-kind-${kind}`} className="border-t border-border">
        <div className="hidden md:block">
          <h3 id={`ai-kind-${kind}`} className="bg-muted/40 px-5 py-2 text-sm font-semibold">{t(`inv.kinds.${kind as AiComponentKind}`)} <span className="font-normal text-muted-foreground">({n(rows.length)})</span></h3>
          <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-left text-sm"><caption className="sr-only">{t(`inv.kinds.${kind as AiComponentKind}`)}</caption>
            <thead className="border-b border-border"><tr>{cols.map(c=><th key={c} scope="col" className="px-5 py-2 text-xs font-medium text-muted-foreground">{t(`inv.cols.${c}`)}</th>)}</tr></thead>
            <tbody className="divide-y divide-border">{rows.map(r=><tr key={r.key} id={rowAnchor(r.key)} className="scroll-mt-4 align-top">{cols.map(c=><td key={c} className="px-5 py-3">{cell(r,c)}</td>)}</tr>)}</tbody>
          </table></div>
        </div>
        <details className="group md:hidden">
          <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-2 bg-muted/40 px-4 py-2 text-sm font-semibold">
            <span>{t(`inv.kinds.${kind as AiComponentKind}`)} <span className="font-normal text-muted-foreground">({n(rows.length)})</span></span>
            {rows.some(isPaused)&&<Badge className="whitespace-nowrap" variant="danger">{t('inv.actionPaused')}</Badge>}
          </summary>
          <ul className="divide-y divide-border">{[...rows].sort((a,b)=>Number(isPaused(b))-Number(isPaused(a))).map(r=><li key={r.key} id={`${rowAnchor(r.key)}-card`} className="scroll-mt-4">
            <details>
              <summary className="flex min-h-11 cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2 text-sm">
                <span className="min-w-0 break-all font-medium">{name(r)}</span>{r.tier&&tier(r)}{r.kind==='action'&&isPaused(r)&&pausedState(r)}
              </summary>
              <div className="px-4 pb-3">
                {cell(r,'component')}
                <dl className="mt-2 grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">{cols.filter(c=>c!=='component').map(c=><div key={c} className="contents"><dt className="break-words text-xs text-muted-foreground">{t(`inv.cols.${c}`)}</dt><dd className="min-w-0 break-words">{cell(r,c)}</dd></div>)}</dl>
              </div>
            </details>
          </li>)}</ul>
        </details>
      </section>)}
    </Card>
    {inventory.scope==='full'&&<Card id="ai-data-register" className="scroll-mt-4 overflow-hidden">
      <div className="p-5"><SectionHeader title={t('inv.register.title')}/><p className="mt-1 max-w-4xl text-sm text-muted-foreground">{t('inv.register.intro')}</p>
        <p className="mt-2 text-sm">{inventory.provider?t('provider',{provider:inventory.provider.provider,model:inventory.provider.model}):t('noProvider')}</p>
        <p className="mt-1 max-w-4xl text-xs text-muted-foreground">{t('inv.register.namesNote')}</p></div>
      <div className="hidden md:block overflow-x-auto"><table className="w-full min-w-[800px] text-left text-sm"><caption className="sr-only">{t('inv.register.title')}</caption>
        <thead className="border-y border-border bg-muted/40"><tr>{(['feature','fields','redaction','images'] as const).map(c=><th key={c} scope="col" className="px-5 py-2 text-xs font-medium">{t(`inv.register.cols.${c}`)}</th>)}</tr></thead>
        <tbody className="divide-y divide-border">{inventory.register.map(({featureId,entry})=><tr key={featureId} className="align-top">
          <td className="px-5 py-3"><p className="font-medium">{t(`features.${featureId}`)}</p><p className="break-all text-xs text-muted-foreground">{entry.anchor}</p></td>
          <td className="px-5 py-3 text-xs">{entry.fields.map(field=>t(`inv.register.fields.${field}`)).join(' · ')}{entry.principalSendsNothing&&<p className="mt-1 text-muted-foreground">{t('inv.register.principalNothing')}</p>}</td>
          <td className="px-5 py-3 text-xs"><Badge variant={entry.redaction==='none'?'danger':entry.redaction==='partial'?'warning':undefined}>{t(`inv.register.redaction.${entry.redaction}`)}</Badge></td>
          <td className="px-5 py-3 text-xs">{t(entry.images?'inv.register.imagesYes':'inv.register.imagesNo')}</td>
        </tr>)}</tbody></table></div>
      <ul className="divide-y divide-border border-t border-border md:hidden">{inventory.register.map(({featureId,entry})=><li key={featureId} className="px-4 py-3 text-sm">
        <p className="font-medium">{t(`features.${featureId}`)}</p>
        <p className="mt-1 text-xs">{entry.fields.map(field=>t(`inv.register.fields.${field}`)).join(' · ')}</p>
        {entry.principalSendsNothing&&<p className="mt-1 text-xs text-muted-foreground">{t('inv.register.principalNothing')}</p>}
        <p className="mt-1 flex flex-wrap items-center gap-2 text-xs"><Badge variant={entry.redaction==='none'?'danger':entry.redaction==='partial'?'warning':undefined}>{t(`inv.register.redaction.${entry.redaction}`)}</Badge>{t(entry.images?'inv.register.imagesYes':'inv.register.imagesNo')}</p>
        <p className="mt-1 break-all text-xs text-muted-foreground">{entry.anchor}</p>
      </li>)}</ul>
    </Card>}
  </>;
}
