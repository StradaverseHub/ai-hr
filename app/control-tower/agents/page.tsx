import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { requireAdmin, isGroupAdmin } from '@/lib/authz';
import { aiManagementView, type AiUsageSummary } from '@/core/ai-management';
import { orchestrationQueue } from '@/core/hr-orchestrator';
import { Card, ErrorBanner, PageHeader, SectionHeader, btnPrimary, btnGhost, inputCls, pageWideCls } from '@/components/ui';
import { OrchestrationWorkQueue } from '../work-queue';
import { setAiAllowanceAction, setAiFeatureAction, setAssistantPermissionAction } from './actions';

export default async function AiManagementPage({searchParams}:{searchParams:Promise<{error?:string;toast?:string;q?:string;refresh?:string}>}) {
  const s = await requireAdmin();
  const sp = await searchParams;
  const t = await getTranslations('aiManagement');
  const f = await getFormatter();
  const view = await aiManagementView(s, sp.q);
  const queue = await orchestrationQueue(s);
  const numbers = (value:unknown) => f.number(Number(value??0));
  const usage = (row?:Partial<AiUsageSummary>) => <span className="text-xs text-muted-foreground">{t('usage',{daily:numbers(row?.daily_requests),tokens:numbers(row?.monthly_tokens),held:numbers(row?.held_tokens)})}</span>;
  const allowance = (kind:'company'|'user',id:string,label:string,row?:Partial<AiUsageSummary>) => {
    const user = kind==='user'?view.users.find(u=>u.id===id):undefined;
    const policy = view.policies.find(p=>p.scopeKey===`${kind}:${id}`);
    return <li key={id} className="py-4">
      <form action={setAiAllowanceAction} className="grid items-end gap-3 md:grid-cols-2 xl:grid-cols-[minmax(10rem,1fr)_minmax(7rem,10rem)_minmax(8rem,12rem)_minmax(6rem,8rem)_auto]">
        <input type="hidden" name="q" value={sp.q??''}/><input type="hidden" name="kind" value={kind}/><input type="hidden" name="subjectId" value={id}/>
        <div className="min-w-0 md:col-span-2 xl:col-span-1"><p className="break-words font-medium">{label}</p>{usage(row)}</div>
        <label className="text-xs">{t('daily')}<input aria-label={`${label} · ${t('daily')}`} className={`${inputCls} mt-1`} type="number" min="0" max="1000000" step="1" name="dailyRequests" defaultValue={policy?.dailyRequests??''} placeholder={t('unlimited')}/></label>
        <label className="text-xs">{t('monthly')}<input aria-label={`${label} · ${t('monthly')}`} className={`${inputCls} mt-1`} type="number" min="0" max="1000000000000" step="1" name="monthlyTokens" defaultValue={policy?.monthlyTokens??''} placeholder={t('unlimited')}/></label>
        <label className="text-xs">{t('access')}<select aria-label={`${label} · ${t('access')}`} name="enabled" defaultValue={String(policy?.enabled!==false)} className={`${inputCls} mt-1`}><option value="true">{t('allowed')}</option><option value="false">{t('paused')}</option></select></label>
        <button className={btnPrimary} type="submit">{t('save')}</button>
      </form>
      {user&&<form action={setAssistantPermissionAction} className="mt-2 flex flex-wrap items-center gap-3 text-xs">
        <input type="hidden" name="userId" value={user.id}/><input type="hidden" name="q" value={sp.q??''}/><input type="hidden" name="enabled" value={String(!user.assistantGranted)}/>
        <span>{t(user.assistantGranted?'assistantGranted':'assistantNotGranted')}</span>
        <button type="submit" className="font-medium text-primary hover:underline" aria-label={`${label} · ${t(user.assistantGranted?'revokeAssistant':'grantAssistant')}`}>{t(user.assistantGranted?'revokeAssistant':'grantAssistant')}</button>
      </form>}
    </li>;
  };
  return <div className={pageWideCls}>
    <PageHeader back={{href:'/control-tower',label:t('back')}} title={t('title')} description={t('description')}/>
    <ErrorBanner message={sp.error}/>
    {sp.toast && <p role="status" className="rounded-md border border-border p-3 text-sm">{sp.toast}</p>}
    <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
      <p className="min-w-0 break-words">{view.provider?t('provider',{provider:view.provider.provider,model:view.provider.model}):t('noProvider')}</p>
      <div className="flex flex-wrap gap-3"><Link href="/admin/ai" className={btnGhost}>{t('configureProvider')}</Link><Link href="/control-tower/agents" className={btnGhost}>{t('refresh')}</Link></div>
    </div>
    <nav aria-label={t('sections')} className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
      <a href="#ai-features" className="text-primary hover:underline">{t('inventory')}</a>
      <a href="#company-limits" className="text-primary hover:underline">{t('companyLimits')}</a>
      {view.mayWriteUsers&&<a href="#user-limits" className="text-primary hover:underline">{t('userLimits')}</a>}
      <a href="#orchestrator" className="text-primary hover:underline">{t('orchestrator')}</a>
      <a href="#ai-runs" className="text-primary hover:underline">{t('recentRuns')}</a>
    </nav>
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
      <SectionHeader title={t('companyLimits')}/><p className="mt-1 max-w-4xl text-sm text-muted-foreground">{t('limitHelp')}</p><p className="mt-2 max-w-4xl text-xs text-muted-foreground">{t('attribution')}</p>
      <ul className="mt-2 divide-y divide-border">{view.companies.map(c=>{
        const rows=view.companyUsage.filter(u=>u.company_id===c.id);
        const total=rows.reduce((a,r)=>({daily_requests:String(Number(a.daily_requests)+Number(r.daily_requests)),monthly_tokens:String(Number(a.monthly_tokens)+Number(r.monthly_tokens)),held_tokens:String(Number(a.held_tokens)+Number(r.held_tokens))}),{daily_requests:'0',monthly_tokens:'0',held_tokens:'0'});
        return allowance('company',c.id,c.label,total);
      })}</ul>{view.companies.length===0&&<p className="py-4 text-sm text-muted-foreground">{t('noCompanies')}</p>}
    </Card>
    {view.mayWriteUsers&&<Card id="user-limits" className="scroll-mt-4 p-5">
      <SectionHeader title={t('userLimits')}/><p className="mt-1 text-sm text-muted-foreground">{t('userHelp')}</p>
      <form method="get" className="mt-4 flex max-w-lg gap-2"><label className="flex-1"><span className="sr-only">{t('searchUsers')}</span><input name="q" defaultValue={sp.q??''} placeholder={t('searchUsers')} className={inputCls}/></label><button className={btnGhost} type="submit">{t('search')}</button></form>
      <ul className="mt-2 divide-y divide-border">{view.users.map(u=>allowance('user',u.id,u.label,view.userUsage.find(r=>r.user_id===u.id)))}</ul>
      {view.users.length===0&&<p className="py-4 text-sm text-muted-foreground">{t('noUsers')}</p>}{view.moreUsers&&<p className="text-xs text-muted-foreground">{t('moreUsers')}</p>}
    </Card>}
    <Card className="p-5"><SectionHeader title={t('inherited')}/><p className="mt-1 text-sm text-muted-foreground">{t('businessLimits')}</p>{view.legacyBudget&&<p className="mt-2 text-sm">{t('legacyAssistant',{daily:numbers(view.legacyBudget.daily),tokens:numbers(view.legacyBudget.monthly)})}</p>}<p className="mt-2 text-xs text-muted-foreground">{t('humanDecisions')}</p></Card>
    <details id="orchestrator" className="scroll-mt-4 rounded-xl border border-border p-5"><summary className="cursor-pointer font-semibold">{t('orchestrator')}</summary><p className="my-3 max-w-4xl text-sm text-muted-foreground">{t('orchestratorHelp')}</p><OrchestrationWorkQueue returnTo="/control-tower/agents" view={queue} refresh={sp.refresh} canViewRuns={isGroupAdmin(s)}/></details>
    <Card id="ai-runs" className="scroll-mt-4 overflow-hidden"><div className="p-5"><SectionHeader title={t('recentRuns')}/><p className="mt-1 text-sm text-muted-foreground">{t('runsHelp')}</p></div>
      {!isGroupAdmin(s)?<p className="px-5 pb-5 text-sm text-muted-foreground">{t('runsScoped')}</p>:view.runs.length===0?<p className="px-5 pb-5 text-sm text-muted-foreground">{t('noRuns')}</p>:<div className="overflow-x-auto"><table className="w-full min-w-[700px] text-left text-sm"><thead className="border-y border-border bg-muted/40"><tr>{['time','actor','feature','state','tokens'].map(key=><th key={key} scope="col" className="px-5 py-3 font-medium">{t(key)}</th>)}</tr></thead><tbody className="divide-y divide-border">{view.runs.map(run=><tr key={run.id}><td className="px-5 py-3 whitespace-nowrap">{f.dateTime(run.startedAt,{dateStyle:'short',timeStyle:'short',timeZone:'Asia/Kuala_Lumpur'})}</td><td className="px-5 py-3">{run.actor?<Link className="text-primary hover:underline" href={`/control-tower/agents?q=${encodeURIComponent(run.actor)}#user-limits`}>{run.actor}</Link>:t('scheduledActor')}</td><td className="px-5 py-3">{t.has(`features.${run.feature}`)?t(`features.${run.feature}`):run.feature}<p className="text-xs text-muted-foreground">{run.provider} · {run.model} · {t(`operations.${run.operation}`)}</p></td><td className="px-5 py-3">{t(`runStates.${run.state}`)}{run.reason&&<p className="text-xs text-muted-foreground">{t(`reasons.${run.reason}`)}</p>}</td><td className="px-5 py-3 tabular-nums">{run.state==='blocked'?(run.reason==='monthly_limit'?t('required',{tokens:numbers(run.reserved)}):'—'):run.actual==null?t('held',{tokens:numbers(run.reserved)}):numbers(run.actual)}</td></tr>)}</tbody></table></div>}
    </Card>
  </div>;
}
