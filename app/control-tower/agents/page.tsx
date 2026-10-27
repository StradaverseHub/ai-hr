import Link from 'next/link';
import {nanosToUsd} from '@/lib/ai/spend-allocation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { requireAdmin, isGroupAdmin } from '@/lib/authz';
import { AI_RUN_STATE_FILTERS, aiManagementView, type AiAllowanceUse, type AiRunFilter, type AiUsageSummary } from '@/core/ai-management';
import { AI_FEATURES, isAiFeature } from '@/lib/ai/features';
import { orchestrationQueue } from '@/core/hr-orchestrator';
import { Badge, Card, ErrorBanner, PageHeader, SectionHeader, btnPrimary, btnGhost, inputCls, pageWideCls } from '@/components/ui';
import { OrchestrationWorkQueue } from '../work-queue';
import { clearUserAllowanceAction, setAiSpendBudgetAction, setAiAllowanceAction, setAiFeatureAction, setAssistantPermissionAction } from './actions';

type Search = {error?:string;toast?:string;q?:string;refresh?:string;runs?:string;feature?:string};

export default async function AiManagementPage({searchParams}:{searchParams:Promise<Search>}) {
  const s = await requireAdmin();
  const sp = await searchParams;
  const t = await getTranslations('aiManagement');
  const f = await getFormatter();
  const runFilter:AiRunFilter = {state:AI_RUN_STATE_FILTERS.find(v=>v===sp.runs),feature:isAiFeature(sp.feature)?sp.feature:undefined};
  const view = await aiManagementView(s, sp.q, runFilter);
  const queue = await orchestrationQueue(s);
  const numbers = (value:unknown) => f.number(Number(value??0));
  const compact = (value:number) => f.number(value,{notation:'compact',maximumFractionDigits:1});
  const usage = (row?:Partial<AiUsageSummary>) => <span className="text-xs text-muted-foreground">{t('usage',{daily:numbers(row?.daily_requests),tokens:numbers(row?.monthly_tokens),held:numbers(row?.held_tokens)})}</span>;
  // Usage against the cap that admission applies: requests today, and recorded plus reserved tokens this month.
  const meters = (u:AiAllowanceUse) => {
    const level = u.daily.level==='at'||u.tokens.level==='at'?'at':u.daily.level??u.tokens.level;
    return <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <span>{u.daily.limit==null?t('requestsNoCap',{used:numbers(u.daily.used)}):t('requestsOfLimit',{used:numbers(u.daily.used),limit:numbers(u.daily.limit)})}</span>
      <span aria-hidden>·</span>
      <span>{u.tokens.limit==null?t('tokensNoCap',{used:compact(u.tokens.used)}):t('tokensOfLimit',{used:compact(u.tokens.used),limit:compact(u.tokens.limit)})}{u.held>0&&` (${t('heldIncluded',{held:compact(u.held)})})`}</span>
      {!u.enabled?<Badge>{t('paused')}</Badge>:level&&<Badge variant={level==='at'?'danger':'warning'}>{t(`levels.${level}`)}</Badge>}
    </p>;
  };
  const query = sp.q??'';
  const userLink = (label:string) => `/control-tower/agents?q=${encodeURIComponent(label)}#user-limits`;
  const limitFields = (label:string,u:Pick<AiAllowanceUse,'daily'|'tokens'|'enabled'|'maxConcurrent'>) => <>
    <label className="text-xs">{t('daily')}<input aria-label={`${label} · ${t('daily')}`} className={`${inputCls} mt-1`} type="number" min="0" max="1000000" step="1" name="dailyRequests" defaultValue={u.daily.limit??''} placeholder={t('unlimited')}/></label>
    <label className="text-xs">{t('monthly')}<input aria-label={`${label} · ${t('monthly')}`} className={`${inputCls} mt-1`} type="number" min="0" max="1000000000000" step="1" name="monthlyTokens" defaultValue={u.tokens.limit??''} placeholder={t('unlimited')}/></label>
    <label className="text-xs">{t('concurrent')}<input aria-label={`${label} · ${t('concurrent')}`} className={`${inputCls} mt-1`} type="number" min="0" max="1000000" step="1" name="maxConcurrent" defaultValue={u.maxConcurrent??''} placeholder={t('unlimited')}/></label>
    <label className="text-xs">{t('access')}<select aria-label={`${label} · ${t('access')}`} name="enabled" defaultValue={String(u.enabled)} className={`${inputCls} mt-1`}><option value="true">{t('allowed')}</option><option value="false">{t('paused')}</option></select></label>
    <button className={btnPrimary} type="submit">{t('save')}</button>
  </>;
  const formGrid = 'grid items-end gap-3 md:grid-cols-2 xl:grid-cols-[minmax(10rem,1fr)_minmax(7rem,10rem)_minmax(8rem,12rem)_minmax(7rem,10rem)_minmax(6rem,8rem)_auto]';
  const companyRow = (c:typeof view.companies[number]) => <li key={c.id} className="py-4">
    <form action={setAiAllowanceAction} className={formGrid}>
      <input type="hidden" name="q" value={query}/><input type="hidden" name="kind" value="company"/><input type="hidden" name="subjectId" value={c.id}/>
      <div className="min-w-0 md:col-span-2 xl:col-span-1"><p className="break-words font-medium">{c.label}</p>{meters(c)}{(c.blocked>0||c.failed>0)&&<p className="text-xs text-muted-foreground">{t('exceptions',{blocked:numbers(c.blocked),failed:numbers(c.failed)})}</p>}</div>
      {limitFields(c.label,c)}
    </form>
  </li>;
  const userRow = (u:typeof view.users[number]) => <li key={u.id} className="py-4">
    {/* A login following the default is prefilled with the default's values: saving it creates an individual copy, never an accidental "no cap". */}
    <form action={setAiAllowanceAction} className={formGrid}>
      <input type="hidden" name="q" value={query}/><input type="hidden" name="kind" value="user"/><input type="hidden" name="subjectId" value={u.id}/>
      <div className="min-w-0 md:col-span-2 xl:col-span-1"><p className="break-words font-medium">{u.label}</p>{meters(u)}{u.source&&<p className="text-xs text-muted-foreground">{t(u.source==='individual'?'sourceIndividual':'sourceDefault')}</p>}</div>
      {limitFields(u.label,u)}
    </form>
    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
      <form action={setAssistantPermissionAction} className="flex flex-wrap items-center gap-3">
        <input type="hidden" name="userId" value={u.id}/><input type="hidden" name="q" value={query}/><input type="hidden" name="enabled" value={String(!u.assistantGranted)}/>
        <span>{t(u.assistantGranted?'assistantGranted':'assistantNotGranted')}</span>
        <button type="submit" className="font-medium text-primary hover:underline" aria-label={`${u.label} · ${t(u.assistantGranted?'revokeAssistant':'grantAssistant')}`}>{t(u.assistantGranted?'revokeAssistant':'grantAssistant')}</button>
      </form>
      {u.source==='individual'&&<form action={clearUserAllowanceAction}>
        <input type="hidden" name="userId" value={u.id}/><input type="hidden" name="q" value={query}/>
        <button type="submit" className="font-medium text-primary hover:underline" aria-label={`${u.label} · ${t('useDefault')}`}>{t('useDefault')}</button>
      </form>}
    </div>
  </li>;
  const attention = view.attention;
  const attentionEmpty = attention.companies.length+attention.users.length+attention.blocked.length===0;
  const filtered = !!(runFilter.state||runFilter.feature);
  const defaultUse = {daily:{used:0,limit:view.userDefault?.dailyRequests??null,level:null},tokens:{used:0,limit:view.userDefault?.monthlyTokens??null,level:null},enabled:view.userDefault?.enabled!==false,maxConcurrent:view.userDefault?.maxConcurrent??null};
  return <div className={pageWideCls}>
    <PageHeader back={{href:'/control-tower',label:t('back')}} title={t('title')} description={t('description')}/>
    <ErrorBanner message={sp.error}/>
    {sp.toast && <p role="status" className="rounded-md border border-border p-3 text-sm">{sp.toast}</p>}
    <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
      <p className="min-w-0 break-words">{view.provider?t('provider',{provider:view.provider.provider,model:view.provider.model}):t('noProvider')}</p>
      <div className="flex flex-wrap gap-3"><Link href="/admin/ai" className={btnGhost}>{t('configureProvider')}</Link><Link href="/control-tower/agents" className={btnGhost}>{t('refresh')}</Link></div>
    </div>
    <nav aria-label={t('sections')} className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
      <a href="#ai-attention" className="text-primary hover:underline">{t('attention')}</a>
      <a href="#ai-features" className="text-primary hover:underline">{t('inventory')}</a>
      <a href="#company-limits" className="text-primary hover:underline">{t('companyLimits')}</a>
      {view.mayWriteUsers&&<a href="#user-limits" className="text-primary hover:underline">{t('userLimits')}</a>}
      <a href="#orchestrator" className="text-primary hover:underline">{t('orchestrator')}</a>
      <a href="#ai-runs" className="text-primary hover:underline">{t('recentRuns')}</a>
    </nav>
    <Card id="ai-attention" className="scroll-mt-4 p-5">
      <SectionHeader title={t('attention')}/><p className="mt-1 max-w-4xl text-sm text-muted-foreground">{t('attentionHelp')}</p>{!view.mayWriteUsers&&<p className="mt-1 text-xs text-muted-foreground">{t('attentionScoped')}</p>}
      {attentionEmpty?<p className="mt-3 text-sm text-muted-foreground">{t('attentionNone')}</p>:<div className="mt-3 grid gap-5 lg:grid-cols-3">
        {attention.companies.length>0&&<section><h3 className="text-sm font-medium">{t('attentionCompanies')}</h3><ul className="mt-1 divide-y divide-border">{attention.companies.map(c=><li key={c.id} className="py-2"><a href="#company-limits" className="break-words text-sm text-primary hover:underline">{c.label}</a>{meters(c)}</li>)}</ul></section>}
        {attention.users.length>0&&<section><h3 className="text-sm font-medium">{t('attentionUsers')}</h3><ul className="mt-1 divide-y divide-border">{attention.users.map(u=><li key={u.id} className="py-2"><Link href={userLink(u.label)} className="break-words text-sm text-primary hover:underline">{u.label}</Link>{meters(u)}</li>)}</ul></section>}
        {attention.blocked.length>0&&<section><h3 className="text-sm font-medium">{t('attentionBlocked')}</h3><ul className="mt-1 divide-y divide-border">{attention.blocked.map(b=><li key={b.id} className="py-2"><Link href={userLink(b.label)} className="break-words text-sm text-primary hover:underline">{b.label}</Link><p className="mt-1 text-xs text-muted-foreground">{t('blockedToday',{count:b.count})}{b.reason&&t.has(`reasons.${b.reason}`)?` · ${t(`reasons.${b.reason}`)}`:''}</p></li>)}</ul></section>}
      </div>}
    </Card>
    <Card id="ai-features" className="scroll-mt-4 overflow-hidden">
      <div className="p-5"><SectionHeader title={t('inventory')}/><p className="mt-1 max-w-4xl text-sm text-muted-foreground">{t('inventoryHelp')}</p>{!isGroupAdmin(s)&&<p className="mt-2 text-sm text-muted-foreground">{t('scopedNotice')}</p>}</div>
      <div className="overflow-x-auto"><table className="w-full min-w-[700px] text-left text-sm"><caption className="sr-only">{t('inventory')}</caption>
        <thead className="border-y border-border bg-muted/40"><tr>{['feature','state','activity','control'].map(key=><th key={key} scope="col" className="px-5 py-3 font-medium">{t(key)}</th>)}</tr></thead>
        <tbody className="divide-y divide-border">{view.features.map(feature=>{
          const activity=view.usage.find(u=>u.feature_id===feature.id);
          return <tr key={feature.id}>
            <td className="px-5 py-4"><p className="font-medium">{t(`features.${feature.id}`)}</p><p className="mt-1 text-xs text-muted-foreground">{t(`kinds.${feature.kind}`)}{feature.id.startsWith('performance_')?` · ${t('imagesIncluded')}`:''}</p></td>
            <td className="px-5 py-4"><span className={feature.state==='ready'?'text-emerald-700 dark:text-emerald-300':'text-muted-foreground'}>{t(`states.${feature.state}`)}</span></td>
            <td className="px-5 py-4">{usage(activity)}{activity&&<p className="mt-1 text-xs text-muted-foreground">{t('exceptions',{blocked:numbers(activity.blocked),failed:numbers(activity.failed)})}</p>}</td>
            <td className="px-5 py-4">{feature.mayWrite?<form action={setAiFeatureAction}><input type="hidden" name="feature" value={feature.id}/><input type="hidden" name="enabled" value={String(!feature.enabled)}/><button type="submit" className={btnGhost} aria-label={`${t(feature.enabled?'pause':'enable')} · ${t(`features.${feature.id}`)}`}>{t(feature.enabled?'pause':'enable')}</button></form>:t(feature.kind==='platform'?'platformManaged':'readOnly')}</td>
          </tr>;
        })}</tbody></table></div>
      <p className="border-t border-border p-5 text-xs text-muted-foreground">{t('noHistory')} {t('reservationHelp')}</p>
    </Card>
    <Card id="company-limits" className="scroll-mt-4 p-5">
      <SectionHeader title={t('companyLimits')}/><p className="mt-1 max-w-4xl text-sm text-muted-foreground">{t('limitHelp')}</p><p className="mt-1 max-w-4xl text-xs text-muted-foreground">{t('concurrentHelp')}</p><p className="mt-2 max-w-4xl text-xs text-muted-foreground">{t('attribution')}</p>
      <ul className="mt-2 divide-y divide-border">{view.companies.map(companyRow)}</ul>{view.companies.length===0&&<p className="py-4 text-sm text-muted-foreground">{t('noCompanies')}</p>}
    </Card>
    {view.mayWriteUsers&&<Card id="user-limits" className="scroll-mt-4 p-5">
      <SectionHeader title={t('userLimits')}/><p className="mt-1 text-sm text-muted-foreground">{t('userHelp')}</p>
      <section aria-labelledby="ai-user-default" className="mt-4 rounded-lg border border-border p-4">
        <h3 id="ai-user-default" className="text-sm font-medium">{t('defaultAllowance')}</h3><p className="mt-1 max-w-4xl text-xs text-muted-foreground">{t('defaultHelp')}</p>
        <form action={setAiAllowanceAction} className={`mt-3 ${formGrid}`}>
          <input type="hidden" name="q" value={query}/><input type="hidden" name="kind" value="user_default"/>
          <p className="min-w-0 text-xs text-muted-foreground md:col-span-2 xl:col-span-1">{t(view.userDefault?'defaultSet':'defaultNotSet')}</p>
          {limitFields(t('defaultAllowance'),defaultUse)}
        </form>
      </section>
      <p className="mt-4 text-xs text-muted-foreground">{t('individualHelp')}</p>
      <form method="get" action="/control-tower/agents#user-limits" className="mt-3 flex max-w-lg gap-2"><label className="flex-1"><span className="sr-only">{t('searchUsers')}</span><input name="q" defaultValue={query} placeholder={t('searchUsers')} className={inputCls}/></label><button className={btnGhost} type="submit">{t('search')}</button></form>
      <p className="mt-2 text-xs text-muted-foreground">{t('userSort')}</p>
      <ul className="mt-2 divide-y divide-border">{view.users.map(userRow)}</ul>
      {view.users.length===0&&<p className="py-4 text-sm text-muted-foreground">{t('noUsers')}</p>}{view.moreUsers&&<p className="text-xs text-muted-foreground">{t('moreUsers')}</p>}
    </Card>}
    {view.spend&&<Card className="p-5"><SectionHeader title={t('spendTitle')}/>
      <p className="mt-2 text-sm">{t('spendOptionalPolicy')}</p><p className="mt-2 text-sm">{view.spend.reviewedCarrierRecords===null?t('spendRecordsUnknown'):t('spendRecords',{count:view.spend.reviewedCarrierRecords})}</p><p className="mt-2 text-xs text-muted-foreground">{t('spendLiveUnverified')}</p><p className="mt-2 text-xs text-muted-foreground">{t('spendSemantics')}</p>
      <p className="mt-2 text-sm">{t('spendHeld',{value:view.spend.heldNanos})} · {t('spendConfirmed',{value:view.spend.confirmedNanos??t('spendUnknown')})}</p>
      {view.spend.breached&&<p role="alert">{t('spendBreach')}</p>}
      <p className="mt-2 text-xs text-muted-foreground">{t('spendUnpricedUnknown',{count:view.spend.unpricedUnknownRuns==null?t('spendUnknown'):String(view.spend.unpricedUnknownRuns)})}</p>
      <p className="mt-2 text-xs text-muted-foreground">{t('spendOptionalHelp')}</p>
      <form action={setAiSpendBudgetAction} className="mt-4 flex flex-wrap items-end gap-3">
        <label className="text-sm">{t('spendMonthly')}<input className={inputCls} name="monthlyUsd" inputMode="decimal" defaultValue={view.spend.budgets.find(b=>b.scopeKey==='tenant')?.monthlyNanos!=null?nanosToUsd(view.spend.budgets.find(b=>b.scopeKey==='tenant')!.monthlyNanos!):''}/></label>
        <label className="text-sm">{t('spendRoot')}<input className={inputCls} name="rootUsd" inputMode="decimal" defaultValue={view.spend.budgets.find(b=>b.scopeKey==='tenant')?.rootNanos!=null?nanosToUsd(view.spend.budgets.find(b=>b.scopeKey==='tenant')!.rootNanos!):''}/></label>
        <button className={btnPrimary}>{t('save')}</button>
      </form></Card>}
    <Card className="p-5"><SectionHeader title={t('inherited')}/><p className="mt-1 text-sm text-muted-foreground">{t('businessLimits')}</p>{view.legacyBudget&&<p className="mt-2 text-sm">{t('legacyAssistant',{daily:numbers(view.legacyBudget.daily),tokens:numbers(view.legacyBudget.monthly)})}</p>}<p className="mt-2 text-xs text-muted-foreground">{t('humanDecisions')}</p></Card>
    <details id="orchestrator" className="scroll-mt-4 rounded-xl border border-border p-5"><summary className="cursor-pointer font-semibold">{t('orchestrator')}</summary><p className="my-3 max-w-4xl text-sm text-muted-foreground">{t('orchestratorHelp')}</p><OrchestrationWorkQueue returnTo="/control-tower/agents" view={queue} refresh={sp.refresh} canViewRuns={isGroupAdmin(s)}/></details>
    <Card id="ai-runs" className="scroll-mt-4 overflow-hidden"><div className="p-5"><SectionHeader title={t('recentRuns')}/><p className="mt-1 text-sm text-muted-foreground">{t('runsHelp')}</p>
      {isGroupAdmin(s)&&<form method="get" action="/control-tower/agents#ai-runs" className="mt-3 flex flex-wrap items-end gap-3 text-xs">
        {query&&<input type="hidden" name="q" value={query}/>}
        <label>{t('runFilter')}<select name="runs" defaultValue={runFilter.state??''} className={`${inputCls} mt-1`}><option value="">{t('runAll')}</option><option value="blocked">{t('runBlocked')}</option><option value="failed">{t('runFailed')}</option></select></label>
        <label>{t('feature')}<select name="feature" defaultValue={runFilter.feature??''} className={`${inputCls} mt-1`}><option value="">{t('allFeatures')}</option>{AI_FEATURES.map(feature=><option key={feature.id} value={feature.id}>{t(`features.${feature.id}`)}</option>)}</select></label>
        <button type="submit" className={btnGhost}>{t('applyFilter')}</button>
        {filtered&&<Link href={query?`/control-tower/agents?q=${encodeURIComponent(query)}#ai-runs`:'/control-tower/agents#ai-runs'} className="py-2 font-medium text-primary hover:underline">{t('clearFilter')}</Link>}
      </form>}
      {isGroupAdmin(s)&&filtered&&<p className="mt-2 text-xs text-muted-foreground">{t('runsFiltered')}</p>}
    </div>
      {!isGroupAdmin(s)?<p className="px-5 pb-5 text-sm text-muted-foreground">{t('runsScoped')}</p>:view.runs.length===0?<p className="px-5 pb-5 text-sm text-muted-foreground">{t(filtered?'noMatchingRuns':'noRuns')}</p>:<div className="overflow-x-auto"><table className="w-full min-w-[700px] text-left text-sm"><thead className="border-y border-border bg-muted/40"><tr>{['time','actor','feature','state','tokens','observedAccounting'].map(key=><th key={key} scope="col" className="px-5 py-3 font-medium">{t(key)}</th>)}</tr></thead><tbody className="divide-y divide-border">{view.runs.map(run=><tr key={run.id}><td className="px-5 py-3 whitespace-nowrap">{f.dateTime(run.startedAt,{dateStyle:'short',timeStyle:'short',timeZone:'Asia/Kuala_Lumpur'})}</td><td className="px-5 py-3">{run.actor?<Link className="text-primary hover:underline" href={userLink(run.actor)}>{run.actor}</Link>:t('scheduledActor')}</td><td className="px-5 py-3">{t.has(`features.${run.feature}`)?t(`features.${run.feature}`):run.feature}<p className="text-xs text-muted-foreground">{run.provider} · {run.model} · {t(`operations.${run.operation}`)}</p></td><td className="px-5 py-3">{t(`runStates.${run.state}`)}{run.reason&&<p className="text-xs text-muted-foreground">{t(`reasons.${run.reason}`)}</p>}</td><td className="px-5 py-3 tabular-nums">{run.state==='blocked'?(run.reason==='monthly_limit'?t('required',{tokens:numbers(run.reserved)}):'—'):run.actual==null?t('held',{tokens:numbers(run.reserved)}):numbers(run.actual)}</td><td className="px-5 py-3 tabular-nums"><p>{t('reportedCredits')}: {run.reportedCredits==null?t('unknownObservation'):f.number(Number(run.reportedCredits),{maximumSignificantDigits:15})}</p><p>{t('roundTrip')}: {run.roundTripMs==null?t('unknownObservation'):t('milliseconds',{value:numbers(run.roundTripMs)})}</p><p className="text-xs text-muted-foreground">{t(`observationStates.${run.observationStatus??'missing'}`)}</p></td></tr>)}</tbody></table></div>}
    </Card>
  </div>;
}
