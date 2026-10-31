import type { ReactNode } from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import {nanosToUsd} from '@/lib/ai/spend-allocation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { type requireAdmin, isAdmin, isGroupAdmin } from '@/lib/authz';
import { AI_RUN_STATE_FILTERS, aiManagementView, bulkAssistantDepartments, previewBulkAssistantAccess, type BulkAssistantPreview, type AiAllowanceUse, type AiRunFilter, type AiUsageSummary } from '@/core/ai-management';
import { AI_FEATURES, isAiFeature } from '@/lib/ai/features';
import type { AgentFeature } from '@/core/agent-principal';
import { orchestrationQueue } from '@/core/hr-orchestrator';
import { Badge, Card, ErrorBanner, PageHeader, SectionHeader, btnPrimary, btnGhost, inputCls, pageWideCls } from '@/components/ui';
import { OrchestrationWorkQueue } from '../work-queue';
import { usdDisplay } from './usd-display';
import { isZeroCapped } from '@/core/ai-zero-cap';
import { isModuleEnabledOrFalse } from '@/core/entitlements';
import { MODULE_JOBS } from '@/lib/ai/module-jobs';
import { aiManagementHref, availableAiManagementSections, type AiManagementSection } from './sections';
import { aiInventoryView, aiManagementAlerts, aiRunHistory } from '@/core/ai-inventory';
import { AI_RUN_PAGE_SIZE } from '@/lib/ai/ai-inventory';
import { AiInventorySection } from './inventory-section';
import { applyBulkAssistantAction, clearGroupAllowanceAction, setGroupAllowanceAction, clearUserAllowanceAction, setAiSpendBudgetAction, setAiAllowanceAction, setAiFeatureAction, setAiFeatureCapAction, setAssistantPermissionAction } from './actions';

export type AiManagementSearch = {error?:string;toast?:string;q?:string;refresh?:string;runs?:string;feature?:string;planning?:string;bulk?:string;bulkWho?:string;bulkUser?:string|string[];from?:string;to?:string;page?:string};

/** One AI management section per route (app/control-tower/agents/<section>/page.tsx); the sub-menu links them.
 * Provider and Assistant pages pass their own content as children. */
export async function AiManagementScreen({session:s,section,searchParams,children}:{session:Awaited<ReturnType<typeof requireAdmin>>;section:AiManagementSection;searchParams:Promise<AiManagementSearch>;children?:ReactNode}) {
  const sp = await searchParams;
  const t = await getTranslations('aiManagement');
  const f = await getFormatter();
  const runFilter:AiRunFilter = {state:AI_RUN_STATE_FILTERS.find(v=>v===sp.runs),feature:isAiFeature(sp.feature)?sp.feature:undefined};
  const view = await aiManagementView(s, sp.q, runFilter);
  // One section per page, chosen in the sidebar's AI management menu. A section this session cannot use
  // goes to the Overview.
  // Only the orchestrator page reads the work queue.
  // Provider setup is tenant-wide (getAiConfigView refuses a company administrator).
  const sections = availableAiManagementSections({spend:!!view.spend,provider:isGroupAdmin(s)});
  if(!sections.includes(section)) redirect(aiManagementHref('overview'));
  const queue = section==='orchestrator' ? await orchestrationQueue(s) : null;
  // WP12 (R8, R20): the inventory section, the alert banner on every section, and paged, dated run history.
  const inventory = section==='inventory' ? await aiInventoryView(s, view) : null;
  // Awaited here (not rendered as an async child) so the section renders wherever the screen does.
  const inventorySection = inventory ? await AiInventorySection({inventory,mayPause:isGroupAdmin(s)}) : null;
  const alertBanner = await aiManagementAlerts(s, view);
  const alerts = alertBanner.status==='ok' ? alertBanner.alerts : [];
  const history = section==='runs' && isGroupAdmin(s) ? await aiRunHistory(s,{from:sp.from,to:sp.to,page:sp.page},runFilter) : null;
  const runsHref = (page:number) => { const p=new URLSearchParams(); if(history){p.set('from',history.range.from);p.set('to',history.range.to);} if(runFilter.state)p.set('runs',runFilter.state); if(runFilter.feature)p.set('feature',runFilter.feature); if(page>1)p.set('page',String(page)); return `${aiManagementHref('runs')}?${p.toString()}#ai-runs`; };
  // Closed save outcomes only: a query string can never put its own words on this screen.
  const toast = sp.toast==='saved' ? t('saved') : sp.toast==='default' ? t('usesDefault') : sp.toast==='bulk' ? t('bulkDone') : undefined;
  const numbers = (value:unknown) => f.number(Number(value??0));
  const compact = (value:number) => f.number(value,{notation:'compact',maximumFractionDigits:1});
  // Display only: stored nano-USD stays exact. Unknown is never shown as zero; a non-zero amount is never shown as US$0.00.
  const usd = (nanos:string|null) => { const d = usdDisplay(nanos); return d.kind==='unknown'?t('spendUnknown'):d.kind==='belowCent'?t('spendBelowCent'):t('spendUsd',{amount:f.number(d.value,{minimumFractionDigits:2,maximumFractionDigits:2})}); };
  const usage = (row?:Partial<AiUsageSummary>) => <span className="text-xs text-muted-foreground">{t('usage',{daily:numbers(row?.daily_requests),tokens:numbers(row?.monthly_tokens),held:numbers(row?.held_tokens)})}</span>;
  // Usage against the cap that admission applies: requests today, and recorded plus reserved tokens this month.
  const meters = (u:AiAllowanceUse) => {
    const level = u.daily.level==='at'||u.tokens.level==='at'?'at':u.daily.level??u.tokens.level;
    return <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <span>{u.daily.limit==null?t('requestsNoCap',{used:numbers(u.daily.used)}):t('requestsOfLimit',{used:numbers(u.daily.used),limit:numbers(u.daily.limit)})}</span>
      <span aria-hidden>·</span>
      <span>{u.tokens.limit==null?t('tokensNoCap',{used:compact(u.tokens.used)}):t('tokensOfLimit',{used:compact(u.tokens.used),limit:compact(u.tokens.limit)})}{u.held>0&&` (${t('heldIncluded',{held:compact(u.held)})})`}</span>
      {!u.enabled?<Badge>{t('paused')}</Badge>:isZeroCapped(u)?<Badge variant="danger">{t('zeroCapPaused')}</Badge>:level&&<Badge variant={level==='at'?'danger':'warning'}>{t(`levels.${level}`)}</Badge>}
    </p>;
  };
  const query = sp.q??'';
  const userLink = (label:string) => aiManagementHref('allowances',{q:label,anchor:'#user-limits'});
  const limitFields = (label:string,u:Pick<AiAllowanceUse,'daily'|'tokens'|'enabled'|'maxConcurrent'>) => <>
    <label className="text-xs">{t('daily')}<input aria-label={`${label} · ${t('daily')}`} className={`${inputCls} mt-1`} type="number" min="0" max="1000000" step="1" name="dailyRequests" defaultValue={u.daily.limit??''} placeholder={t('unlimited')}/></label>
    <label className="text-xs">{t('monthly')}<input aria-label={`${label} · ${t('monthly')}`} className={`${inputCls} mt-1`} type="number" min="0" max="1000000000000" step="1" name="monthlyTokens" defaultValue={u.tokens.limit??''} placeholder={t('unlimited')}/></label>
    <label className="text-xs">{t('concurrent')}<input aria-label={`${label} · ${t('concurrent')}`} className={`${inputCls} mt-1`} type="number" min="0" max="1000000" step="1" name="maxConcurrent" defaultValue={u.maxConcurrent??''} placeholder={t('unlimited')}/></label>
    <label className="text-xs">{t('access')}<select aria-label={`${label} · ${t('access')}`} name="enabled" defaultValue={String(u.enabled)} className={`${inputCls} mt-1`}><option value="true">{t('allowed')}</option><option value="false">{t('paused')}</option></select></label>
    <button className={btnPrimary} type="submit">{t('save')}</button>
  </>;
  const formGrid = 'grid items-end gap-3 md:grid-cols-2 xl:grid-cols-[minmax(10rem,1fr)_minmax(7rem,10rem)_minmax(8rem,12rem)_minmax(7rem,10rem)_minmax(6rem,8rem)_auto]';
  // WP14 / R19 — per-feature caps: the shared feature row (0694) holds the same three limits; its on/off switch stays
  // on the features page. Only features without a module setting have such a row (setAiFeatureCap re-checks this).
  const capFeatures = view.mayWriteUsers ? AI_FEATURES.filter(feature=>feature.setting===null) : [];
  const capLevel = (used:number,limit:number|null) => limit==null?null:used>=limit?'at' as const:used>=limit*0.8?'near' as const:null;
  const featureCapRow = (feature:typeof capFeatures[number]) => {
    const policy = view.policies.find(p=>p.scopeKey===`feature:${feature.id}`), activity = view.usage.find(u=>u.feature_id===feature.id);
    const daily = Number(activity?.daily_requests??0), recorded = Number(activity?.monthly_tokens??0), held = Number(activity?.held_tokens??0);
    const use:AiAllowanceUse = {daily:{used:daily,limit:policy?.dailyRequests??null,level:capLevel(daily,policy?.dailyRequests??null)},tokens:{used:recorded+held,limit:policy?.monthlyTokens??null,level:capLevel(recorded+held,policy?.monthlyTokens??null)},recorded,held,enabled:policy?.enabled!==false,maxConcurrent:policy?.maxConcurrent??null};
    const label = t(`features.${feature.id}`);
    return <li key={feature.id} id={`ai-feature-cap-${feature.id}`} className="scroll-mt-4 py-4">
      <form action={setAiFeatureCapAction} className={formGrid}>
        <input type="hidden" name="feature" value={feature.id}/>
        <div className="min-w-0 md:col-span-2 xl:col-span-1"><p className="break-words font-medium">{label}</p>{meters(use)}</div>
        <label className="text-xs">{t('daily')}<input aria-label={`${label} · ${t('daily')}`} className={`${inputCls} mt-1`} type="number" min="0" max="1000000" step="1" name="dailyRequests" defaultValue={use.daily.limit??''} placeholder={t('unlimited')}/></label>
        <label className="text-xs">{t('monthly')}<input aria-label={`${label} · ${t('monthly')}`} className={`${inputCls} mt-1`} type="number" min="0" max="1000000000000" step="1" name="monthlyTokens" defaultValue={use.tokens.limit??''} placeholder={t('unlimited')}/></label>
        <label className="text-xs">{t('concurrent')}<input aria-label={`${label} · ${t('concurrent')}`} className={`${inputCls} mt-1`} type="number" min="0" max="1000000" step="1" name="maxConcurrent" defaultValue={use.maxConcurrent??''} placeholder={t('unlimited')}/></label>
        <span aria-hidden className="hidden xl:block"/>
        <button className={btnPrimary} type="submit">{t('save')}</button>
      </form>
    </li>;
  };
  const companyRow = (c:typeof view.companies[number]) => <li key={c.id} id={`ai-company-${c.id}`} className="scroll-mt-4 py-4">
    <form action={setAiAllowanceAction} className={formGrid}>
      <input type="hidden" name="q" value={query}/><input type="hidden" name="kind" value="company"/><input type="hidden" name="subjectId" value={c.id}/>
      <div className="min-w-0 md:col-span-2 xl:col-span-1"><p className="break-words font-medium">{c.label}</p>{meters(c)}{(c.blocked>0||c.failed>0)&&<p className="text-xs text-muted-foreground">{t('exceptions',{blocked:numbers(c.blocked),failed:numbers(c.failed)})}</p>}</div>
      {limitFields(c.label,c)}
    </form>
  </li>;
  const userRow = (u:typeof view.users[number]) => <li key={u.id} id={`ai-user-${u.id}`} className="scroll-mt-4 py-4">
    <label className="mb-2 flex min-h-11 w-fit items-center gap-2 text-xs"><input type="checkbox" form="ai-bulk-selected" name="bulkUser" value={u.id} className="size-4"/>{t('bulkSelect',{name:u.label})}</label>
    {/* A login following the default is prefilled with the default's values: saving it creates an individual copy, never an accidental "no cap". */}
    <form action={setAiAllowanceAction} className={formGrid}>
      <input type="hidden" name="q" value={query}/><input type="hidden" name="kind" value="user"/><input type="hidden" name="subjectId" value={u.id}/>
      <div className="min-w-0 md:col-span-2 xl:col-span-1"><p className="break-words font-medium">{u.label}</p>{meters(u)}{u.source&&<p className="text-xs text-muted-foreground">{u.source==='group'&&u.group?t('sourceGroup',{group:groupLabel(u.group.scopeKey)}):t(u.source==='individual'?'sourceIndividual':'sourceDefault')}</p>}</div>
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
  // The AI map: every AI piece, whether it can run now, and where to change it. Read from the same
  // owners the sections use; nothing here is a declared status.
  const ready = (rows:typeof view.features) => rows.filter(row=>row.state==='ready').length;
  const assistantFeature = view.features.find(row=>row.id==='hr_assistant');
  const specialists = MODULE_JOBS.filter(([code])=>isModuleEnabledOrFalse(s,code)&&(code!=='system_explorer'||isAdmin(s)));
  const agents = view.features.filter(row=>row.kind==='agent'), builtIn = view.features.filter(row=>row.kind!=='agent'&&row.id!=='hr_assistant');
  const map = [
    {key:'provider',title:t('mapProvider'),help:t('mapProviderHelp'),status:view.provider?t('provider',{provider:view.provider.provider,model:view.provider.model}):t('noProvider'),href:sections.includes('provider')?aiManagementHref('provider'):null},
    {key:'assistant',title:t('mapAssistant'),help:t('mapAssistantHelp'),status:`${assistantFeature?t(`states.${assistantFeature.state}`):t('states.module')} · ${t('mapSpecialists',{available:specialists.length,total:MODULE_JOBS.length})}`,href:aiManagementHref('assistant')},
    {key:'agents',title:t('mapAgents'),help:t('mapAgentsHelp'),status:t('mapReady',{ready:ready(agents),total:agents.length}),href:aiManagementHref('features',{anchor:'#ai-features'})},
    {key:'features',title:t('mapFeatures'),help:t('mapFeaturesHelp'),status:t('mapReady',{ready:ready(builtIn),total:builtIn.length}),href:aiManagementHref('features',{anchor:'#ai-features'})},
    {key:'limits',title:t('mapLimits'),help:t('mapLimitsHelp'),status:t('mapLimitsStatus',{count:view.attention.companies.length+view.attention.users.length}),href:aiManagementHref('allowances')},
  ];
  const attention = view.attention;
  // Bulk HR assistant access (Allowances, group administrators): a GET review shows the count first; only
  // the confirmed POST writes. The scope comes from closed controls and is re-derived by the owner.
  const bulkEnabled = sp.bulk==='grant' ? true : sp.bulk==='revoke' ? false : null;
  const bulkUsers = (Array.isArray(sp.bulkUser) ? sp.bulkUser : sp.bulkUser ? [sp.bulkUser] : []).slice(0,50);
  const [whoKind, whoId] = (sp.bulkWho ?? '').split(':');
  const bulkScope = whoKind==='company' ? {kind:'company',companyId:whoId} : whoKind==='department' ? {kind:'department',departmentId:whoId}
    : whoKind==='role' ? {kind:'role',role:whoId} : whoKind==='search' ? {kind:'search',q:sp.q??''} : bulkUsers.length ? {kind:'users',userIds:bulkUsers} : null;
  let bulkPreview: BulkAssistantPreview | 'invalid' | null = null;
  if (section==='allowances' && view.mayWriteUsers && bulkEnabled!==null && bulkScope) {
    try { bulkPreview = await previewBulkAssistantAccess(s, bulkScope, bulkEnabled); } catch { bulkPreview = 'invalid'; }
  }
  const departments = section==='allowances' && view.mayWriteUsers ? await bulkAssistantDepartments(s).catch(()=>[]) : [];
  const roleLabels = await getTranslations('reports.permRole');
  const ROLES = ['employee','manager','hr_admin','super_admin','payroll_partner','performance_comp_partner','performance_partner'] as const;
  const groupLabel = (scopeKey:string) => {
    const [kind, subject] = [scopeKey.slice(0, scopeKey.indexOf(':')), scopeKey.slice(scopeKey.indexOf(':') + 1)];
    if (kind==='group_role') return t('groupRole',{name:(ROLES as readonly string[]).includes(subject)?roleLabels(subject as typeof ROLES[number]):subject});
    if (kind==='group_company') return t('groupCompany',{name:view.companies.find(c=>c.id===subject)?.label??t('groupUnknown')});
    return t('groupDepartment',{name:departments.find(d=>d.id===subject)?.label??t('groupUnknown')});
  };
  const attentionEmpty = attention.companies.length+attention.users.length+attention.blocked.length===0;
  const filtered = !!(runFilter.state||runFilter.feature);
  const defaultUse = {daily:{used:0,limit:view.userDefault?.dailyRequests??null,level:null},tokens:{used:0,limit:view.userDefault?.monthlyTokens??null,level:null},enabled:view.userDefault?.enabled!==false,maxConcurrent:view.userDefault?.maxConcurrent??null};
  return <div className={pageWideCls}>
    <PageHeader back={{href:'/control-tower',label:t('back')}} title={t('title')} description={t('description')}/>
    {/* Provider and Assistant pages own their refusal wording; elsewhere the banner shows owned sentences. */}
    {section!=='provider'&&section!=='assistant'&&<ErrorBanner message={sp.error}/>}
    {/* Sticky: a save scrolls to its own row, and the outcome must stay in view there. */}
    {toast && <p role="status" className="sticky top-2 z-10 rounded-md border border-border bg-background p-3 text-sm shadow-sm">{toast}</p>}
    <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
      <p className="min-w-0 break-words">{view.provider?t('provider',{provider:view.provider.provider,model:view.provider.model}):t('noProvider')}</p>
      <div className="flex flex-wrap gap-3">{sections.includes('provider')&&<Link href={aiManagementHref('provider')} className={btnGhost}>{t('configureProvider')}</Link>}<Link href={aiManagementHref(section)} className={btnGhost}>{t('refresh')}</Link></div>
    </div>
    {alerts.length>0&&<section role="alert" aria-labelledby="ai-alerts-heading" className="rounded-xl border border-amber-500/50 bg-amber-50 p-4 text-sm dark:bg-amber-950/30">
      <h2 id="ai-alerts-heading" className="font-semibold">{t('inv.alerts.title')}</h2>
      <ul className="mt-2 list-disc space-y-1 pl-5">{alerts.map(a=><li key={a.kind}><span className={a.level==='critical'?'font-semibold text-red-700 dark:text-red-300':''}>{t(`inv.alerts.${a.kind}`,{count:a.count,detail:a.detail??''})}</span></li>)}</ul>
      <p className="mt-2 text-xs text-muted-foreground">{t('inv.alerts.help')}</p>
    </section>}
    {alertBanner.status==='unavailable'&&<p role="status" className="rounded-xl border border-border p-4 text-sm text-muted-foreground">{t('inv.alerts.unavailable')}</p>}
    {section==='inventory'&&inventorySection}
    {section==='overview'&&<Card id="ai-map" className="scroll-mt-4 p-5">
      <SectionHeader title={t('mapTitle')}/><p className="mt-1 max-w-4xl text-sm text-muted-foreground">{t('mapIntro')}</p>
      <ul className="mt-3 divide-y divide-border">{map.map(row=><li key={row.key} className="flex flex-wrap items-start justify-between gap-3 py-3">
        <div className="min-w-0 max-w-3xl"><p className="font-medium">{row.title}</p><p className="mt-1 text-xs text-muted-foreground">{row.help}</p><p className="mt-1 text-sm">{row.status}</p></div>
        {row.href&&<Link href={row.href} className="py-2 text-sm font-medium text-primary hover:underline" aria-label={`${t('mapManage')} · ${row.title}`}>{t('mapManage')}</Link>}
      </li>)}</ul>
    </Card>}
    {section==='overview'&&<Card id="ai-attention" className="scroll-mt-4 p-5">
      <SectionHeader title={t('attention')}/><p className="mt-1 max-w-4xl text-sm text-muted-foreground">{t('attentionHelp')}</p>{!view.mayWriteUsers&&<p className="mt-1 text-xs text-muted-foreground">{t('attentionScoped')}</p>}
      {attentionEmpty?<p className="mt-3 text-sm text-muted-foreground">{t('attentionNone')}</p>:<div className="mt-3 grid gap-5 lg:grid-cols-3">
        {attention.companies.length>0&&<section><h3 className="text-sm font-medium">{t('attentionCompanies')}</h3><ul className="mt-1 divide-y divide-border">{attention.companies.map(c=><li key={c.id} className="py-2"><Link href={aiManagementHref('allowances',{anchor:`#ai-company-${c.id}`})} className="break-words text-sm text-primary hover:underline">{c.label}</Link>{meters(c)}</li>)}</ul></section>}
        {attention.users.length>0&&<section><h3 className="text-sm font-medium">{t('attentionUsers')}</h3><ul className="mt-1 divide-y divide-border">{attention.users.map(u=><li key={u.id} className="py-2"><Link href={userLink(u.label)} className="break-words text-sm text-primary hover:underline">{u.label}</Link>{meters(u)}</li>)}</ul></section>}
        {attention.blocked.length>0&&<section><h3 className="text-sm font-medium">{t('attentionBlocked')}</h3><ul className="mt-1 divide-y divide-border">{attention.blocked.map(b=><li key={b.id} className="py-2"><Link href={userLink(b.label)} className="break-words text-sm text-primary hover:underline">{b.label}</Link><p className="mt-1 text-xs text-muted-foreground">{t('blockedToday',{count:b.count})}{b.reason&&t.has(`reasons.${b.reason}`)?` · ${t(`reasons.${b.reason}`)}`:''}</p></li>)}</ul></section>}
      </div>}
    </Card>}
    {section==='features'&&<Card id="ai-features" className="scroll-mt-4 overflow-hidden">
      <div className="p-5"><SectionHeader title={t('inventory')}/><p className="mt-1 max-w-4xl text-sm text-muted-foreground">{t('inventoryHelp')}</p>{!isGroupAdmin(s)&&<p className="mt-2 text-sm text-muted-foreground">{t('scopedNotice')}</p>}</div>
      <div className="overflow-x-auto"><table className="w-full min-w-[700px] text-left text-sm"><caption className="sr-only">{t('inventory')}</caption>
        <thead className="border-y border-border bg-muted/40"><tr>{['feature','state','activity','control'].map(key=><th key={key} scope="col" className="px-5 py-3 font-medium">{t(key)}</th>)}</tr></thead>
        <tbody className="divide-y divide-border">{view.features.map(feature=>{
          const activity=view.usage.find(u=>u.feature_id===feature.id);
          return <tr key={feature.id} id={`ai-feature-${feature.id}`} className="scroll-mt-4">
            <td className="px-5 py-4"><p className="font-medium">{t(`features.${feature.id}`)}</p><p className="mt-1 text-xs text-muted-foreground">{t(`kinds.${feature.kind}`)}</p><p className="mt-2 max-w-md text-xs leading-relaxed text-muted-foreground">{t(`privateFeatures.${feature.id}`)}</p>{(()=>{
              // ADR-0151 §4.5 — the named agent principal runs a switched-on agent only under a named administrator's switch-on.
              const sw=view.agentSwitches[feature.id as AgentFeature];
              return sw?.state==='attributed'?<p className="mt-1 text-xs text-muted-foreground">{t('agentRunsAs',{by:sw.by??t('agentUnknownAdmin'),date:f.dateTime(sw.at,{dateStyle:'medium',timeZone:'Asia/Kuala_Lumpur'})})}</p>
                :sw?.state==='unattributed'?<p className="mt-1 text-xs text-amber-700 dark:text-amber-300">{t('agentUnattributed')}</p>:null;})()}
              {feature.staleOverride&&<p className="mt-1 text-xs text-amber-700 dark:text-amber-300">{t(feature.staleOverride.enabled?'staleOverrideOn':'staleOverrideOff')}</p>}</td>
            <td className="px-5 py-4"><span className={feature.state==='ready'?'text-emerald-700 dark:text-emerald-300':'text-muted-foreground'}>{t(`states.${feature.state}`)}</span></td>
            <td className="px-5 py-4">{usage(activity)}{activity&&<p className="mt-1 text-xs text-muted-foreground">{t('exceptions',{blocked:numbers(activity.blocked),failed:numbers(activity.failed)})}</p>}</td>
            <td className="px-5 py-4">{feature.mayWrite?<form action={setAiFeatureAction}><input type="hidden" name="feature" value={feature.id}/><input type="hidden" name="enabled" value={String(!feature.enabled)}/><button type="submit" className={btnGhost} aria-label={`${t(feature.enabled?'pause':'enable')} · ${t(`features.${feature.id}`)}`}>{t(feature.enabled?'pause':'enable')}</button></form>:t(feature.kind==='platform'?'platformManaged':'readOnly')}</td>
          </tr>;
        })}</tbody></table></div>
      <p className="border-t border-border p-5 text-xs text-muted-foreground">{t('noHistory')} {t('reservationHelp')}</p>
    </Card>}
    {section==='allowances'&&<>
    <Card id="company-limits" className="scroll-mt-4 p-5">
      <SectionHeader title={t('companyLimits')}/><p className="mt-1 max-w-4xl text-sm text-muted-foreground">{t('limitHelp')}</p><p className="mt-1 max-w-4xl text-xs text-muted-foreground">{t('concurrentHelp')}</p><p className="mt-2 max-w-4xl text-xs text-muted-foreground">{t('attribution')}</p>
      <ul className="mt-2 divide-y divide-border">{view.companies.map(companyRow)}</ul>{view.companies.length===0&&<p className="py-4 text-sm text-muted-foreground">{t('noCompanies')}</p>}
    </Card>
    {capFeatures.length>0&&<Card id="feature-limits" className="scroll-mt-4 p-5">
      <SectionHeader title={t('featureCapsTitle')}/><p className="mt-1 max-w-4xl text-sm text-muted-foreground">{t('featureCapsHelp')}</p>
      <ul className="mt-2 divide-y divide-border">{capFeatures.map(featureCapRow)}</ul>
    </Card>}
    {view.mayWriteUsers&&<Card id="user-limits" className="scroll-mt-4 p-5">
      <SectionHeader title={t('userLimits')}/><p className="mt-1 text-sm text-muted-foreground">{t('userHelp')}</p>
      <section id="ai-bulk" aria-labelledby="ai-bulk-heading" className="mt-4 scroll-mt-4 rounded-lg border border-border p-4">
        <h3 id="ai-bulk-heading" className="text-sm font-medium">{t('bulkTitle')}</h3><p className="mt-1 max-w-4xl text-xs text-muted-foreground">{t('bulkHelp')}</p>
        {bulkPreview && bulkEnabled!==null && bulkScope && <div role="region" aria-label={t('bulkReview')} className="mt-3 rounded-md border border-primary/40 bg-primary/5 p-3 text-sm">
          {bulkPreview==='invalid' ? <p role="alert">{t('bulkInvalid')}</p> : <>
            <p className="font-medium">{bulkPreview.changing===0 ? t('bulkNothing') : t(bulkEnabled?'bulkConfirmGrant':'bulkConfirmRevoke',{count:bulkPreview.changing})}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t('bulkMatched',{matched:bulkPreview.matched,changing:bulkPreview.changing})}</p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              {bulkPreview.changing>0&&<form action={applyBulkAssistantAction}><input type="hidden" name="scope" value={JSON.stringify(bulkScope)}/><input type="hidden" name="enabled" value={String(bulkEnabled)}/><input type="hidden" name="confirmed" value={bulkPreview.changing}/><button type="submit" className={btnPrimary}>{t(bulkEnabled?'bulkConfirmGrantButton':'bulkConfirmRevokeButton',{count:bulkPreview.changing})}</button></form>}
              <Link href={aiManagementHref('allowances',{q:query,anchor:'#ai-bulk'})} className="py-2 text-sm font-medium text-primary hover:underline">{t('bulkCancel')}</Link>
            </div></>}
        </div>}
        <form method="get" action={aiManagementHref('allowances',{anchor:'#ai-bulk'})} className="mt-3 flex flex-wrap items-end gap-3">
          {query&&<input type="hidden" name="q" value={query}/>}
          <label className="text-xs">{t('bulkWho')}<select name="bulkWho" required defaultValue="" className={`${inputCls} mt-1 min-w-56`}>
            <option value="" disabled>{t('bulkChoose')}</option>
            <optgroup label={t('bulkCompany')}>{view.companies.map(c=><option key={c.id} value={`company:${c.id}`}>{c.label}</option>)}</optgroup>
            {departments.length>0&&<optgroup label={t('bulkDepartment')}>{departments.map(d=><option key={d.id} value={`department:${d.id}`}>{d.label}</option>)}</optgroup>}
            <optgroup label={t('bulkRole')}>{(['employee','manager','hr_admin','super_admin','payroll_partner','performance_comp_partner','performance_partner'] as const).map(r=><option key={r} value={`role:${r}`}>{roleLabels(r)}</option>)}</optgroup>
          </select></label>
          <label className="text-xs">{t('bulkChange')}<select name="bulk" defaultValue="grant" className={`${inputCls} mt-1`}><option value="grant">{t('bulkGrant')}</option><option value="revoke">{t('bulkRevoke')}</option></select></label>
          <button type="submit" className={btnGhost}>{t('bulkReviewButton')}</button>
        </form>
      </section>
      <section id="ai-groups" aria-labelledby="ai-groups-heading" className="mt-4 scroll-mt-4 rounded-lg border border-border p-4">
        <h3 id="ai-groups-heading" className="text-sm font-medium">{t('groupsTitle')}</h3><p className="mt-1 max-w-4xl text-xs text-muted-foreground">{t('groupsHelp')}</p>
        {view.groups.length===0?<p className="mt-2 text-xs text-muted-foreground">{t('groupsNone')}</p>:<ul className="mt-2 divide-y divide-border">{view.groups.map(g=>{const key=`${g.kind}|${g.kind==='group_role'?g.scopeKey.slice('group_role:'.length):g.subjectId}`;const label=groupLabel(g.scopeKey);return <li key={g.scopeKey} id={`ai-group-${g.scopeKey.replace(/[^a-z0-9_-]/gi,'-')}`} className="scroll-mt-4 py-3">
          <form action={setGroupAllowanceAction} className={formGrid}>
            <input type="hidden" name="group" value={key}/>
            <div className="min-w-0 md:col-span-2 xl:col-span-1"><p className="break-words text-sm font-medium">{label}</p></div>
            {limitFields(label,{daily:{used:0,limit:g.dailyRequests,level:null},tokens:{used:0,limit:g.monthlyTokens,level:null},enabled:g.enabled,maxConcurrent:g.maxConcurrent??null})}
          </form>
          <form action={clearGroupAllowanceAction} className="mt-2"><input type="hidden" name="group" value={key}/><button type="submit" className="text-xs font-medium text-primary hover:underline" aria-label={`${label} · ${t('groupRemove')}`}>{t('groupRemove')}</button></form>
        </li>;})}</ul>}
        <form action={setGroupAllowanceAction} className={`mt-3 ${formGrid}`}>
          <label className="min-w-0 text-xs md:col-span-2 xl:col-span-1">{t('groupAdd')}<select name="group" required defaultValue="" className={`${inputCls} mt-1 w-full`}>
            <option value="" disabled>{t('bulkChoose')}</option>
            {departments.length>0&&<optgroup label={t('bulkDepartment')}>{departments.map(d=><option key={d.id} value={`group_department|${d.id}`}>{d.label}</option>)}</optgroup>}
            <optgroup label={t('bulkCompany')}>{view.companies.map(c=><option key={c.id} value={`group_company|${c.id}`}>{c.label}</option>)}</optgroup>
            <optgroup label={t('bulkRole')}>{ROLES.map(r=><option key={r} value={`group_role|${r}`}>{roleLabels(r)}</option>)}</optgroup>
          </select></label>
          {limitFields(t('groupAdd'),{daily:{used:0,limit:null,level:null},tokens:{used:0,limit:null,level:null},enabled:true,maxConcurrent:null})}
        </form>
        <p className="mt-2 text-xs text-muted-foreground">{t('groupsPrecedence')}</p>
      </section>
      <section aria-labelledby="ai-user-default" className="mt-4 rounded-lg border border-border p-4">
        <h3 id="ai-user-default" className="scroll-mt-4 text-sm font-medium">{t('defaultAllowance')}</h3><p className="mt-1 max-w-4xl text-xs text-muted-foreground">{t('defaultHelp')}</p>
        <form action={setAiAllowanceAction} className={`mt-3 ${formGrid}`}>
          <input type="hidden" name="q" value={query}/><input type="hidden" name="kind" value="user_default"/>
          <p className="min-w-0 text-xs text-muted-foreground md:col-span-2 xl:col-span-1">{t(view.userDefault?'defaultSet':'defaultNotSet')}</p>
          {limitFields(t('defaultAllowance'),defaultUse)}
        </form>
      </section>
      <p className="mt-4 text-xs text-muted-foreground">{t('individualHelp')}</p>
      <form method="get" action={aiManagementHref('allowances',{anchor:'#user-limits'})} className="mt-3 flex max-w-lg gap-2"><label className="flex-1"><span className="sr-only">{t('searchUsers')}</span><input name="q" defaultValue={query} placeholder={t('searchUsers')} className={inputCls}/></label><button className={btnGhost} type="submit">{t('search')}</button></form>
      <p className="mt-2 text-xs text-muted-foreground">{t('userSort')}</p>
      <form id="ai-bulk-selected" method="get" action={aiManagementHref('allowances',{anchor:'#ai-bulk'})} className="mt-3 flex flex-wrap items-end gap-3 text-xs">
        {query&&<input type="hidden" name="q" value={query}/>}
        <label>{t('bulkSelectedChange')}<select name="bulk" defaultValue="grant" className={`${inputCls} mt-1`}><option value="grant">{t('bulkGrant')}</option><option value="revoke">{t('bulkRevoke')}</option></select></label>
        <button type="submit" className={btnGhost}>{t('bulkSelectedButton')}</button>
        {query&&<button type="submit" name="bulkWho" value="search" className={btnGhost}>{t('bulkAllMatching',{q:query})}</button>}
      </form>
      <ul className="mt-2 divide-y divide-border">{view.users.map(userRow)}</ul>
      {view.users.length===0&&<p className="py-4 text-sm text-muted-foreground">{t('noUsers')}</p>}{view.moreUsers&&<p className="text-xs text-muted-foreground">{t('moreUsers')}</p>}
    </Card>}
    <Card className="p-5"><SectionHeader title={t('inherited')}/><p className="mt-1 text-sm text-muted-foreground">{t('businessLimits')}</p>{view.legacyBudget&&<p className="mt-2 text-sm">{t('legacyAssistant',{daily:numbers(view.legacyBudget.daily),tokens:numbers(view.legacyBudget.monthly)})}</p>}<p className="mt-2 text-xs text-muted-foreground">{t('humanDecisions')}</p></Card>
    </>}
    {section==='spending'&&view.spend&&<Card id="ai-spend" className="scroll-mt-4 p-5"><SectionHeader title={t('spendTitle')}/>
      <p className="mt-2 text-sm">{t('spendOptionalPolicy')}</p><p className="mt-2 text-sm">{view.spend.reviewedCarrierRecords===null?t('spendRecordsUnknown'):t('spendRecords',{count:view.spend.reviewedCarrierRecords})}</p><p className="mt-2 text-xs text-muted-foreground">{t('spendLiveUnverified')}</p><p className="mt-2 text-xs text-muted-foreground">{t('spendSemantics')}</p>
      <p className="mt-2 text-sm">{t('spendHeld',{value:usd(view.spend.heldNanos)})} · {t('spendConfirmed',{value:usd(view.spend.confirmedNanos)})}</p>
      {view.spend.breached&&<p role="alert">{t('spendBreach')}</p>}
      <p className="mt-2 text-xs text-muted-foreground">{t('spendUnpricedUnknown',{count:view.spend.unpricedUnknownRuns==null?t('spendUnknown'):String(view.spend.unpricedUnknownRuns)})}</p>
      <p className="mt-2 text-xs text-muted-foreground">{t('spendOptionalHelp')}</p>
      <form action={setAiSpendBudgetAction} className="mt-4 flex flex-wrap items-end gap-3">
        <label htmlFor="ai-spend-monthly" className="text-sm">{t('spendMonthly')}<input id="ai-spend-monthly" className={inputCls} name="monthlyUsd" inputMode="decimal" defaultValue={view.spend.budgets.find(b=>b.scopeKey==='tenant')?.monthlyNanos!=null?nanosToUsd(view.spend.budgets.find(b=>b.scopeKey==='tenant')!.monthlyNanos!):''}/></label>
        <label htmlFor="ai-spend-root" className="text-sm">{t('spendRoot')}<input id="ai-spend-root" className={inputCls} name="rootUsd" inputMode="decimal" defaultValue={view.spend.budgets.find(b=>b.scopeKey==='tenant')?.rootNanos!=null?nanosToUsd(view.spend.budgets.find(b=>b.scopeKey==='tenant')!.rootNanos!):''}/></label>
        <button className={btnPrimary}>{t('save')}</button>
      </form></Card>}
    {(section==='provider'||section==='assistant')&&children}
    {section==='orchestrator'&&queue&&<section id="orchestrator" aria-labelledby="ai-orchestrator-heading" className="scroll-mt-4 rounded-xl border border-border p-5"><h2 id="ai-orchestrator-heading" className="font-semibold">{t('orchestrator')}</h2><p className="my-3 max-w-4xl text-sm text-muted-foreground">{t('orchestratorHelp')}</p><OrchestrationWorkQueue returnTo="/control-tower/agents" view={queue} refresh={sp.refresh} canViewRuns={isGroupAdmin(s)}/></section>}
    {section==='runs'&&<Card id="ai-runs" className="scroll-mt-4 overflow-hidden"><div className="p-5"><SectionHeader title={t('recentRuns')}/><p className="mt-1 text-sm text-muted-foreground">{t('runsHelp')}</p>
      {isGroupAdmin(s)&&<form method="get" action={aiManagementHref('runs',{anchor:'#ai-runs'})} className="mt-3 flex flex-wrap items-end gap-3 text-xs">
        {query&&<input type="hidden" name="q" value={query}/>}
        <label>{t('inv.rangeFrom')}<input type="date" name="from" defaultValue={history?.range.from} max={history?.range.to} className={`${inputCls} mt-1`}/></label>
        <label>{t('inv.rangeTo')}<input type="date" name="to" defaultValue={history?.range.to} className={`${inputCls} mt-1`}/></label>
        <label>{t('runFilter')}<select name="runs" defaultValue={runFilter.state??''} className={`${inputCls} mt-1`}><option value="">{t('runAll')}</option><option value="blocked">{t('runBlocked')}</option><option value="failed">{t('runFailed')}</option></select></label>
        <label>{t('feature')}<select name="feature" defaultValue={runFilter.feature??''} className={`${inputCls} mt-1`}><option value="">{t('allFeatures')}</option>{AI_FEATURES.map(feature=><option key={feature.id} value={feature.id}>{t(`features.${feature.id}`)}</option>)}</select></label>
        <button type="submit" className={btnGhost}>{t('applyFilter')}</button>
        {filtered&&<Link href={aiManagementHref('runs',{q:query,anchor:'#ai-runs'})} className="py-2 font-medium text-primary hover:underline">{t('clearFilter')}</Link>}
      </form>}
      {isGroupAdmin(s)&&filtered&&<p className="mt-2 text-xs text-muted-foreground">{t('runsFiltered')}</p>}
    </div>
      {history&&<p className="px-5 pb-2 text-xs text-muted-foreground">{t('inv.rangeShown',{from:f.dateTime(new Date(`${history.range.from}T00:00:00+08:00`),{dateStyle:'medium',timeZone:'Asia/Kuala_Lumpur'}),to:f.dateTime(new Date(`${history.range.to}T00:00:00+08:00`),{dateStyle:'medium',timeZone:'Asia/Kuala_Lumpur'}),page:history.range.page,size:AI_RUN_PAGE_SIZE})}</p>}
      {!isGroupAdmin(s)||!history?<p className="px-5 pb-5 text-sm text-muted-foreground">{t('runsScoped')}</p>:history.rows.length===0?<p className="px-5 pb-5 text-sm text-muted-foreground">{t(filtered?'noMatchingRuns':'noRuns')}</p>:<div className="overflow-x-auto"><table className="w-full min-w-[700px] text-left text-sm"><thead className="border-y border-border bg-muted/40"><tr>{['time','actor','feature','state','tokens','observedAccounting'].map(key=><th key={key} scope="col" className="px-5 py-3 font-medium">{t(key)}</th>)}</tr></thead><tbody className="divide-y divide-border">{history.rows.map(run=><tr key={run.id}><td className="px-5 py-3 whitespace-nowrap">{f.dateTime(run.startedAt,{dateStyle:'short',timeStyle:'short',timeZone:'Asia/Kuala_Lumpur'})}</td><td className="px-5 py-3">{run.actor?<Link className="text-primary hover:underline" href={userLink(run.actor)}>{run.actor}</Link>:t('scheduledActor')}</td><td className="px-5 py-3">{t.has(`features.${run.feature}`)?t(`features.${run.feature}`):run.feature}<p className="text-xs text-muted-foreground">{run.provider} · {run.model} · {t(`operations.${run.operation}`)}</p></td><td className="px-5 py-3">{t(`runStates.${run.state}`)}{run.reason&&<p className="text-xs text-muted-foreground">{t(`reasons.${run.reason}`)}</p>}</td><td className="px-5 py-3 tabular-nums">{run.state==='blocked'?(run.reason==='monthly_limit'?t('required',{tokens:numbers(run.reserved)}):'—'):run.actual==null?t('held',{tokens:numbers(run.reserved)}):numbers(run.actual)}</td><td className="px-5 py-3 tabular-nums"><p>{t('reportedCredits')}: {run.reportedCredits==null?t('unknownObservation'):f.number(Number(run.reportedCredits),{maximumSignificantDigits:15})}</p><p>{t('roundTrip')}: {run.roundTripMs==null?t('unknownObservation'):t('milliseconds',{value:numbers(run.roundTripMs)})}</p><p className="text-xs text-muted-foreground">{t(`observationStates.${run.observationStatus??'missing'}`)}</p></td></tr>)}</tbody></table></div>}
      {history&&(history.range.page>1||history.hasMore)&&<nav aria-label={t('inv.paging')} className="flex flex-wrap items-center justify-between gap-3 border-t border-border p-5 text-sm">
        {history.range.page>1?<Link href={runsHref(history.range.page-1)} className={btnGhost}>{t('inv.previous')}</Link>:<span/>}
        <span className="text-muted-foreground">{t('inv.pageOf',{page:history.range.page})}</span>
        {history.hasMore?<Link href={runsHref(history.range.page+1)} className={btnGhost}>{t('inv.next')}</Link>:<span/>}
      </nav>}
    </Card>}
  </div>;
}
