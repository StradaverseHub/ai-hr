import { AssessmentCalibrationView } from '../onehr/calibration-view';
import { ReviewConversation } from './review-conversation';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { requireModule } from '@/lib/authz';
import { performanceWorkspace, getOnehrReview, getOnehrFeedback, getOnehrCalibration, getReviewConversation, type ConversationStage, type PerformanceWorkspaceItem } from '@/packs/performance/service';
import { ErrorBanner, PageHeader, inputCls } from '@/components/ui';
import { OnehrReviewView } from '../onehr/review-view';
import { FeedbackView } from '../onehr/feedback-view';
import { WorkspaceRail } from './workspace-rail';

type Query={cycle?:string;view?:string;module?:string;review?:string;feedback?:string;calibration?:string;stage?:string;error?:string};
const views=['mine','team','dept','bu','bg','group'] as const;
const modules=['pm','tm','idp'] as const;
export default async function PerformanceWorkspacePage({searchParams}:{searchParams:Promise<Query>}) {
 await requireModule('performance');const {s}=await scopedSession(),query=await searchParams;
 const [items,t]=await Promise.all([performanceWorkspace(s),getTranslations('onehr')]);
 const cycleIds=[...new Set(items.map(i=>i.cycleId))];
 const cycle=query.cycle&&cycleIds.includes(query.cycle)?query.cycle:cycleIds[0];
 const current=items.filter(i=>i.cycleId===cycle),availableViews=views.filter(view=>current.some(i=>i.view===view));
 const view=availableViews.find(v=>v===query.view)??availableViews[0]??'mine';
 const inView=current.filter(i=>i.view===view),availableModules=modules.filter(m=>inView.some(i=>i.module===m));
 const module=availableModules.find(m=>m===query.module)??availableModules[0]??'pm';
 const order={open:0,waiting:1,later:2,done:3};
 const moduleItems=inView.filter(i=>i.module===module);
 const parts=[...new Set(moduleItems.map(i=>i.stage))];
 const part=module==='tm'?(parts.find(p=>p===query.stage)??(parts.includes('feedback')?'feedback':parts[0])):undefined;
 const cards=moduleItems.filter(i=>!part||i.stage===part).sort((a,b)=>order[a.state]-order[b.state]||a.title.localeCompare(b.title));
 const requested=query.review??query.feedback??query.calibration;
 const selected=cards.find(i=>i.id===requested)??cards[0];
 function href(changes:Record<string,string|undefined>={},item?:PerformanceWorkspaceItem){
  const params=new URLSearchParams({...(cycle?{cycle}:{}),view,module,...(part?{stage:part}:{}),...Object.fromEntries(Object.entries(changes).filter((entry):entry is [string,string]=>entry[1]!==undefined))});
  if(item)params.set(item.kind,item.id);
  return `/performance/workspace?${params}`;
 }
 const returnTo=href({},selected);
 const review=selected?.kind==='review'?await getOnehrReview(s,selected.id):null;
 const calibration=selected?.kind==='calibration'?await getOnehrCalibration(s,selected.id):null;
 const feedback=selected?.kind==='feedback'?await getOnehrFeedback(s,selected.id):null;
 if(selected?.kind==='review'&&!review)notFound();
 const stage=query.stage==='record'?'record':query.stage==='evidence'&&review?.policy.modules.evidence?'evidence':module;
 const conversationStage:ConversationStage=stage==='evidence'?'evidence':module==='tm'?'competency':module==='idp'?'career':selected?.stage==='setting'?'setting':selected?.stage==='moderation'?'moderation':'results';
 const conversation=review&&(review.self||review.manager)&&stage!=='record'&&!selected?.locked?await getReviewConversation(s,review.reviewId,conversationStage):null;
 const conversationLabels=Object.fromEntries(['title','you','draft','guide','message','next','preparing','help'].map(key=>[key,t(`conversation.${key}`)]));
 const pending=cards.filter(c=>c.state==='open').length,done=cards.filter(c=>c.state==='done').length;
 const listRail=<><div className="border-b border-border px-4 py-3"><h2 className="text-sm font-semibold">{t(`workspace.modules.${module}`)}</h2><p className="mt-1 text-xs text-muted-foreground">{t('workspace.progress',{done,total:cards.length})}</p><progress aria-label={t('workspace.progress',{done,total:cards.length})} value={done} max={Math.max(1,cards.length)} className="mt-2 h-1.5 w-full accent-primary"/></div>{(['open','waiting','later','done'] as const).map(state=>{
  const group=cards.filter(c=>c.state===state);if(!group.length)return null;
  return <details key={state} open={state!=='done'||!pending} className="border-b border-border"><summary className="cursor-pointer px-4 py-3 text-xs font-semibold text-muted-foreground">{t(`workspace.states.${state}`)} <span className="float-right tabular-nums">{group.length}</span></summary><ul className="space-y-1 p-2">{group.map(item=><li key={item.key}><Link href={href({},item)} aria-current={selected?.key===item.key?'page':undefined} className={`block min-h-11 rounded-md border px-3 py-2 text-sm ${selected?.key===item.key?'border-primary bg-primary/5 font-medium':'border-transparent hover:bg-muted'}`}><span className="line-clamp-2">{item.title}</span><span className="mt-1 block text-xs font-normal text-muted-foreground">{t(`workspace.stages.${item.stage}`)}</span></Link></li>)}</ul></details>;
 })}</>;
 const privateResults=review?.drafts.find(d=>d.kind==='results')?.payload;
 const privateCompetencies=review?.drafts.find(d=>d.kind==='competency_self')?.payload;
 const navigation=review?.self?(module==='pm'?review.kpis.map(k=>({id:`kpi-${k.id}`,title:k.title,meta:`${k.weightBp/100}%`,done:!!k.hrOwned||review.resultsSubmitted||!!k.checkIn||(privateResults?.kind==='results'&&privateResults.lines.some(l=>l.id===k.id&&l.actual!=null))})):module==='tm'?[...new Set(review.competencies.map(c=>c.principle))].map((p,i)=>({id:`competency-category-${i}`,title:p,meta:'',done:review.competencies.filter(c=>c.principle===p).every(c=>!!c.self||privateCompetencies?.kind==='competency_self'&&!!privateCompetencies.answers[c.id]?.answer)})):[{id:'career-aspiration',title:t('aspiration'),meta:'',done:!!review.plans[0]?.career},{id:'career-mobility',title:t('mobility'),meta:'',done:!!review.plans[0]?.career},...review.plans.flatMap(p=>(p.goals as {id:string;area:string}[]).map(g=>({id:`goal-${g.id}`,title:g.area,meta:'',done:p.status!=='draft'})))]):[];
 const partSwitcher=module==='tm'&&parts.length>1?<nav aria-label={t('workspace.parts')} className="flex gap-1 border-b border-border p-2">{parts.map(p=><Link key={p} href={href({stage:p})} className={`flex min-h-11 flex-1 items-center justify-center rounded-md px-2 text-xs ${part===p?'bg-primary/10 font-semibold text-primary':'hover:bg-muted'}`}>{t(`workspace.stages.${p}`)}</Link>)}</nav>:null;
 const rail=<>{partSwitcher}{navigation.length>0?<><div className="border-b border-border px-4 py-3"><h2 className="text-sm font-semibold">{selected&&t(`workspace.stages.${selected.stage}`)}</h2><p className="mt-1 text-xs text-muted-foreground">{t('workspace.progress',{done:navigation.filter(n=>n.done).length,total:navigation.length})}</p></div>{[false,true].map(complete=><details key={String(complete)} open={!complete} className="border-b border-border"><summary className="cursor-pointer px-4 py-3 text-xs font-semibold text-muted-foreground">{t(complete?'workspace.states.done':'workspace.toDo')} <span className="float-right">{navigation.filter(n=>n.done===complete).length}</span></summary><ul className="space-y-1 p-2">{navigation.filter(n=>n.done===complete).map(n=><li key={n.id}><a href={`#${n.id}`} className="block min-h-11 rounded-md px-3 py-2 text-sm hover:bg-muted"><span className="line-clamp-2">{n.title}</span>{n.meta&&<span className="mt-1 block text-xs text-muted-foreground">{n.meta}</span>}</a></li>)}</ul></details>)}</>:listRail}</>;
 return <div className="mx-auto max-w-[100rem] space-y-4">
  <PageHeader title={t('workspace.title')} description={t('workspace.description')} back={{href:'/me/performance',label:t('back')}}/>
  <ErrorBanner message={query.error}/>
  {cycleIds.length>0&&<form className="flex flex-wrap items-end justify-between gap-3" action="/performance/workspace"><label className="text-sm">{t('workspace.cycle')}<select name="cycle" defaultValue={cycle} className={`${inputCls} ml-3 w-auto`}>{cycleIds.map(id=>{const first=items.find(i=>i.cycleId===id)!;return <option key={id} value={id}>{first.cycle}</option>;})}</select></label><button type="submit" className="min-h-11 rounded-md border border-border px-4 text-sm hover:bg-muted">{t('workspace.openCycle')}</button></form>}
  {!items.length?<section className="rounded-lg border border-border p-8"><h2 className="font-semibold">{t('workspace.empty')}</h2><p className="mt-2 text-sm text-muted-foreground">{t('workspace.emptyHelp')}</p><Link href="/performance" className="mt-4 inline-flex min-h-11 items-center text-sm text-primary underline">{t('workspace.manageCycles')}</Link></section>:<>
   <div className="grid gap-3 lg:grid-cols-[224px_minmax(0,1fr)]">
    <nav aria-label={t('workspace.viewsLabel')} className="flex flex-wrap gap-1 rounded-lg border border-border p-1">{availableViews.map(v=><Link key={v} href={href({view:v,module:undefined})} aria-current={view===v?'page':undefined} className={`flex min-h-11 flex-1 items-center justify-center rounded-md px-3 text-sm ${view===v?'bg-foreground text-background':'hover:bg-muted'}`}>{t(`workspace.views.${v}`)}</Link>)}</nav>
    <nav aria-label={t('workspace.modulesLabel')} className="flex flex-wrap gap-2">{availableModules.map(m=><Link key={m} href={href({module:m})} aria-current={module===m?'page':undefined} className={`flex min-h-11 items-center gap-3 rounded-lg border px-4 text-sm ${module===m?'flex-1 border-primary bg-primary/5':'border-border hover:bg-muted'}`}><b>{m.toUpperCase()}</b>{module===m&&<span>{t(`workspace.modules.${m}`)}</span>}</Link>)}</nav>
   </div>
   <div className="grid items-start gap-4 lg:grid-cols-[224px_minmax(0,1fr)]">
    <WorkspaceRail label={t('workspace.navigator')}>{rail}</WorkspaceRail>
    <main className="min-w-0 overflow-hidden rounded-lg border border-border bg-card">
     <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4"><div><h2 className="font-semibold">{selected?.title}</h2><p className="text-xs text-muted-foreground">{selected&&t(`workspace.stages.${selected.stage}`)}</p></div>{review&&<nav aria-label={t('workspace.recordsLabel')} className="flex gap-4 text-sm"><Link href={href({stage:'record'},selected)} className="text-primary hover:underline">{t('workspace.record')}</Link>{review.policy.modules.evidence&&<Link href={href({stage:'evidence'},selected)} className="text-primary hover:underline">{t('evidence')}</Link>}<Link href={`/performance/review/${review.reviewId}`} className="text-muted-foreground hover:underline">{t('workspace.fullView')}</Link></nav>}</header>
     {selected?.locked?<p className="p-6 text-sm text-muted-foreground">{t('workspace.planLocked')}</p>:review?<OnehrReviewView key={`${review.reviewId}.${module}.${stage}`} v={review} section={stage} returnTo={returnTo}/>:feedback?<FeedbackView key={feedback.requestId} v={feedback} returnTo={returnTo}/>:calibration?<AssessmentCalibrationView v={calibration} embedded returnTo={returnTo}/>:null}
     {review&&conversation&&<ReviewConversation key={`${review.reviewId}.${conversationStage}`} reviewId={review.reviewId} stage={conversationStage} initial={conversation} aiEnabled={review.aiEnabled} labels={conversationLabels}/>}
    </main>
   </div>
  </>}
 </div>;
}
