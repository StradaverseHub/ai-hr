import { settingNumbersComplete } from '@/packs/performance/onehr/setting-default-model';
import { Lock } from 'lucide-react';
import { ItemNavigator } from './item-navigator';
import { PersonalRecord } from './personal-record';
import { RecordDrawer } from './record-drawer';
import { JourneyPanel,JourneyProgressProvider,JourneySteps } from './journey-panel';
import { AssessmentCalibrationView } from '../onehr/calibration-view';
import { ReviewConversation } from './review-conversation';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { requireModule } from '@/lib/authz';
import { performanceWorkspace, getAssessmentPersonalRecord, getOnehrReview, getOnehrFeedback, getOnehrCalibration, getReviewConversation, getFeedbackConversation, type ConversationStage, type PerformanceWorkspaceItem } from '@/packs/performance/service';
import { ErrorBanner, inputCls } from '@/components/ui';
import { OnehrReviewView } from '../onehr/review-view';
import { FeedbackView } from '../onehr/feedback-view';
import { WorkspaceRail } from './workspace-rail';

type Query={cycle?:string;view?:string;module?:string;review?:string;feedback?:string;calibration?:string;stage?:string;record?:string;recordTab?:string;planYear?:string;error?:string};
const views=['mine','team','dept','bu','bg','group'] as const;
const modules=['pm','tm','idp','cal'] as const;
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
 const partOrder=['feedback','competency','department_review','calibration','department_potential_review','potential_calibration','talent_box','group_calibration'];
 const parts=[...new Set(moduleItems.map(i=>i.stage))].sort((a,b)=>partOrder.indexOf(a)-partOrder.indexOf(b));
 const part=module==='tm'||module==='cal'?(parts.find(p=>p===query.stage)??(parts.includes('feedback')?'feedback':parts[0])):undefined;
 const cards=moduleItems.filter(i=>!part||i.stage===part).sort((a,b)=>order[a.state]-order[b.state]||a.title.localeCompare(b.title));
 const requested=query.review??query.feedback??query.calibration;
 const selected=cards.find(i=>i.id===requested)??cards[0];
 function href(changes:Record<string,string|undefined>={},item?:PerformanceWorkspaceItem){
  const params=new URLSearchParams({...(cycle?{cycle}:{}),view,module,...(part?{stage:part}:{})});
  for(const [key,value] of Object.entries(changes)){if(value===undefined)params.delete(key);else params.set(key,value);}
  if(item)params.set(item.kind,item.id);
  return `/performance/workspace?${params}`;
 }
 const returnTo=href({},selected);
 const review=selected?.kind==='review'?await getOnehrReview(s,selected.id):null;
 const calibration=selected?.kind==='calibration'?await getOnehrCalibration(s,selected.id):null;
 const feedback=selected?.kind==='feedback'?await getOnehrFeedback(s,selected.id):null;
 if(selected?.kind==='review'&&!review)notFound();
 const stage=query.stage==='record'?'record':query.stage==='evidence'&&review?.policy.modules.evidence?'evidence':module;
 const personalRecord=stage==='record'&&review?.self?await getAssessmentPersonalRecord(s,review.reviewId,query.record,query.planYear?Number(query.planYear):undefined):null;
 const conversationStage:ConversationStage=feedback?'feedback':stage==='evidence'?'evidence':module==='tm'?'competency':module==='idp'?'career':selected?.stage==='setting'?'setting':selected?.stage==='moderation'?'moderation':'results';
 const conversation=review&&review.policy.modules.review!==false&&(review.self||review.manager||review.moderator)&&stage!=='record'&&!selected?.locked?await getReviewConversation(s,review.reviewId,conversationStage):feedback&&feedback.guidedReview!==false?await getFeedbackConversation(s,feedback.reviewId,feedback.requestId):null;
 const conversationAiEnabled=review?.aiEnabled??(!!conversation&&'aiEnabled' in conversation&&conversation.aiEnabled===true);
 const conversationLabels=Object.fromEntries(['title','you','draft','guide','action','message','next','preparing','help','updated','send','starter','starterHelp'].map(key=>[key,t(`conversation.${key}`)]));
 if(review&&(review.manager||review.moderator))conversationLabels.help=t('conversation.managerHelp');
 conversationLabels.starterQuota=t('conversation.starterQuota',{remaining:'{remaining}',limit:'{limit}'});
 const pending=cards.filter(c=>c.state==='open').length,done=cards.filter(c=>c.state==='done').length;
 const listRail=<><div className="border-b border-border px-4 py-3"><h2 className="text-sm font-semibold">{t(module==='cal'&&view==='dept'?'workspace.departmentReview':`workspace.modules.${module}`)}</h2><p className="mt-1 text-xs text-muted-foreground">{t('workspace.progress',{done,total:cards.length})}</p><progress aria-label={t('workspace.progress',{done,total:cards.length})} value={done} max={Math.max(1,cards.length)} className="mt-2 h-1.5 w-full accent-primary"/></div>{(['open','waiting','later','done'] as const).map(state=>{
  const group=cards.filter(c=>c.state===state);if(!group.length)return null;
  return <details key={state} open={state!=='done'||!pending} className="border-b border-border"><summary className="cursor-pointer px-4 py-3 text-xs font-semibold text-muted-foreground">{t(`workspace.states.${state}`)} <span className="float-right tabular-nums">{group.length}</span></summary><ul className="space-y-1 p-2">{group.map(item=><li key={item.key}><Link href={href({},item)} aria-current={selected?.key===item.key?'page':undefined} className={`block min-h-11 rounded-md border px-3 py-2 text-sm ${selected?.key===item.key?'border-primary bg-primary/5 font-medium':'border-transparent hover:bg-muted'}`}><span className="line-clamp-2">{item.title}</span><span className="mt-1 block text-xs font-normal text-muted-foreground">{t(`workspace.stages.${item.stage}`)}</span></Link></li>)}</ul></details>;
 })}</>;
 const privateResults=review?.drafts.find(d=>d.kind==='results')?.payload;
 const privateCompetencies=review?.drafts.find(d=>d.kind==='competency_self')?.payload;
 const navigation=review?.self?(module==='pm'?review.kpis.map(k=>({id:`kpi-${k.id}`,title:k.title,meta:`${k.weightBp/100}%`,done:selected?.stage==='setting'?settingNumbersComplete(k.scoring):!!k.hrOwned||review.resultsSubmitted||!!k.checkIn||(privateResults?.kind==='results'&&privateResults.lines.some(l=>l.id===k.id&&l.actual!=null))})):module==='tm'?[...new Set(review.competencies.map(c=>c.principle))].map((p,i)=>({id:`competency-category-${i}`,title:p,meta:'',done:review.competencies.filter(c=>c.principle===p).every(c=>!!c.self||privateCompetencies?.kind==='competency_self'&&!!privateCompetencies.answers[c.id]?.answer)})):[{id:'career-aspiration',title:t('aspiration'),meta:'',done:[review.careerProfile?.career.aspiration,review.careerProfile?.career.aspirationNow,review.careerProfile?.career.aspirationLong].some(s=>!!s?.trim())},{id:'career-mobility',title:t('mobility'),meta:'',done:!!review.careerProfile?.career.mobility},...review.plans.flatMap(p=>(p.goals as {id:string;area:string}[]).map(g=>({id:`goal-${g.id}`,title:g.area,meta:'',done:p.status!=='draft'})))]):[];
 if(calibration)navigation.push(...calibration.rows.map(r=>({id:`assessment-${r.entry.reviewId}`,title:r.name,meta:r.grade,done:!!(selected?.axis==='performance'?r.entry.performanceLockedAt:selected?.axis==='potential'?r.entry.potentialLockedAt:r.entry.lockedAt)})));
 if(review?.self&&module==='pm'&&selected?.stage!=='setting'&&review.policy.kind!=='quarterly')navigation.push({id:'assessment-overall-remark',title:t('overallRemark'),meta:'',done:!!(privateResults?.remark??review.selfRemark)},{id:'assessment-submit-results',title:t('submitResults'),meta:'',done:review.resultsSubmitted});
 const partSwitcher=(module==='tm'||module==='cal')&&parts.length>1?<nav aria-label={t('workspace.parts')} className="flex gap-1 border-b border-border p-2">{parts.map(p=><Link key={p} href={href({stage:p})} className={`flex min-h-11 flex-1 items-center justify-center rounded-md px-2 text-xs ${part===p?'bg-primary/10 font-semibold text-primary':'hover:bg-muted'}`}>{t(`workspace.stages.${p}`)}</Link>)}</nav>:null;
 const activeDraft=review?.drafts.find(d=>d.kind===(module==='tm'?(review.manager?'competency_manager':'competency_self'):review.manager||review.moderator?'moderation':'results'))?.payload??feedback?.draft?.payload;
 const activeStatements=feedback?.statements??review?.competencies??[];
 const activeKpis=review?.kpis.filter(k=>!k.hrOwned&&(review.self||review.canModerateIds.includes(k.id)))??[];
 const total=module==='tm'?activeStatements.length:activeKpis.length;
 const answered=module==='tm'?activeStatements.filter(s=>activeDraft&&'answers' in activeDraft?(activeDraft.kind==='feedback'?!!activeDraft.answers[s.id]:!!activeDraft.answers[s.id]?.answer):feedback?!!feedback.answers?.[s.id]:review?.competencyStatus!=='pending').length:activeKpis.filter(k=>activeDraft&&'lines' in activeDraft?activeDraft.lines.some(l=>l.id===k.id&&l.actual!=null):k.actual!=null).length;
 const stepProgress={answered,total,remark:!!(activeDraft?.remark??(feedback?.remark??(module==='tm'?review?.competencySelfRemark:review?.selfRemark))),submitted:feedback?.submitted??(module==='tm'?review?.competencyStatus!=='pending':review?.self?!!review.resultsSubmitted:!!review?.managerPerformance)};
 const widget=selected?.locked?<p className="p-6 text-sm text-muted-foreground">{t('workspace.planLocked')}</p>:review?<OnehrReviewView key={`${review.reviewId}.${module}.${stage}.${review.revision}.${review.drafts.map(d=>`${d.kind}:${d.revision}`).join(".")}`} v={review} section={stage==='cal'?'admin':personalRecord&&module!=='cal'?module:stage} returnTo={returnTo}/>:feedback?<FeedbackView key={feedback.requestId} v={feedback} returnTo={returnTo}/>:calibration?<AssessmentCalibrationView v={calibration} embedded axis={selected?.axis??'both'} returnTo={returnTo}/>:null;
 const journeyLabels:[string,string,string]=[t(module==='tm'?'workspace.steps.rate':'workspace.steps.results'),t(module==='tm'?'workspace.steps.remark':'workspace.steps.justification'),t('workspace.steps.confirm')];
 const journeyWidget=(review?.self||feedback)&&['pm','tm'].includes(stage)&&selected?.stage!=='setting'&&review?.policy.kind!=='quarterly'?<JourneyPanel key={`${selected?.key}.${stage}.${review?.drafts.map(d=>`${d.kind}:${d.revision}`).join(".")}`} initial={stepProgress} labels={journeyLabels}>{widget}</JourneyPanel>:widget;
 const navigatorItems=navigation.map(n=>({...n,setting:selected?.stage==='setting'&&module==='pm'&&n.id.startsWith('kpi-'),fields:module==='pm'?(n.id.startsWith('kpi-')?review?.kpis.find(k=>`kpi-${k.id}`===n.id)?.hrOwned?[]:[`${n.id.slice(4)}.actual`]:n.id==='assessment-overall-remark'?['overallRemark']:[]):module==='tm'&&review?review.competencies.filter(c=>c.principle===n.title).map(c=>`answer.${c.id}`):[]}));
 const rail=<>{partSwitcher}{navigation.length>0?<ItemNavigator key={`${review?.reviewId}.${module}`} title={selected?t(`workspace.stages.${selected.stage}`):''} items={navigatorItems}/>:listRail}</>;

 return <JourneyProgressProvider key={`${selected?.key}.${stage}.${review?.revision}.${review?.drafts.map(d=>d.revision).join(".")}`} initial={stepProgress} labels={journeyLabels}><div className="mx-auto max-w-[100rem] space-y-3">
  <h1 className="sr-only">{t('workspace.title')}</h1>
  <ErrorBanner message={query.error}/>
  {!items.length?<section className="rounded-lg border border-border p-8"><h2 className="font-semibold">{t('workspace.empty')}</h2><p className="mt-2 text-sm text-muted-foreground">{t('workspace.emptyHelp')}</p><Link href="/performance" className="mt-4 inline-flex min-h-11 items-center text-sm text-primary underline">{t('workspace.manageCycles')}</Link></section>:<>
   <div className="grid gap-3 lg:grid-cols-[224px_minmax(0,1fr)]">
    <nav aria-label={t('workspace.viewsLabel')} className="flex flex-wrap gap-1 rounded-lg border border-border p-1">{availableViews.map(v=><Link key={v} href={href({view:v,module:undefined,stage:undefined})} aria-current={view===v?'page':undefined} className={`flex min-h-11 flex-1 items-center justify-center rounded-md px-3 text-sm ${view===v?'bg-foreground text-background':'hover:bg-muted'}`}>{t(`workspace.views.${v}`)}</Link>)}</nav>
    <nav aria-label={t('workspace.modulesLabel')} className="flex flex-wrap gap-2">{availableModules.map(m=>{const locked=items.some(item=>item.cycleId===cycle&&item.view===view&&item.module===m&&item.locked);return <div key={m} className={`flex min-h-11 flex-wrap items-center gap-x-3 rounded-lg border px-3 text-sm ${module===m?'flex-1 border-primary bg-primary/5':'border-border hover:bg-muted'}`}>{locked?<span aria-disabled="true" title={t('workspace.planLocked')} className="flex min-h-11 items-center gap-2 text-muted-foreground"><b>{m.toUpperCase()}</b><Lock size={14} aria-hidden/></span>:<Link href={href({module:m,stage:undefined})} aria-current={module===m?'page':undefined} className="flex min-h-11 items-center gap-2"><b>{m==='cal'&&view==='dept'?'DR':m.toUpperCase()}</b>{module===m&&<span>{t(m==='cal'&&view==='dept'?'workspace.departmentReview':`workspace.modules.${m}`)}</span>}</Link>}{module===m&&journeyWidget!==widget&&<div className="ml-auto"><JourneySteps/></div>}</div>;})}</nav>
   </div>
   <div className="grid items-start gap-4 lg:grid-cols-[224px_minmax(0,1fr)]">
    <WorkspaceRail label={t('workspace.navigator')}>{rail}</WorkspaceRail>
    <main className="min-w-0 rounded-lg border border-border bg-card lg:overflow-hidden">
     <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-2"><div><h2 className="font-semibold">{selected?.title}</h2><p className="text-xs text-muted-foreground">{selected&&t(`workspace.stages.${selected.stage}`)}</p></div>{cycleIds.length>0&&<form className="flex items-center gap-2" action="/performance/workspace"><label className="sr-only" htmlFor="workspace-cycle">{t('workspace.cycle')}</label><select id="workspace-cycle" name="cycle" defaultValue={cycle} className={`${inputCls} w-auto`}>{cycleIds.map(id=>{const first=items.find(i=>i.cycleId===id)!;return <option key={id} value={id}>{first.cycle}</option>;})}</select><button type="submit" className="min-h-11 rounded-md border border-border px-3 text-sm hover:bg-muted">{t('workspace.openCycle')}</button></form>}{review&&<nav aria-label={t('workspace.recordsLabel')} className="flex gap-4 text-sm"><Link href={href({stage:'record'},selected)} className="text-primary hover:underline">{t('workspace.record')}</Link>{review.policy.modules.evidence&&<Link href={href({stage:'evidence'},selected)} className="text-primary hover:underline">{t('evidence')}</Link>}{!review.self&&<Link href={`/performance/review/${review.reviewId}`} className="text-muted-foreground hover:underline">{t('workspace.fullView')}</Link>}</nav>}</header>
     {conversation&&(review||feedback)?<ReviewConversation key={`${feedback?.requestId??review?.reviewId}.${conversationStage}`} reviewId={feedback?.reviewId??review!.reviewId} contextId={feedback?.requestId} stage={conversationStage} initial={conversation} aiEnabled={conversationAiEnabled} labels={conversationLabels}>{journeyWidget}</ReviewConversation>:journeyWidget}
    </main>
   </div>
  </>}
  {personalRecord&&<RecordDrawer title={t('workspace.record')} closeLabel={t('personalRecord.close')} returnTo={href({stage:module},selected)}><PersonalRecord v={personalRecord} tab={query.recordTab} baseHref={href({stage:'record'},selected)}/></RecordDrawer>}
  <Link href="/" className="fixed bottom-5 left-5 z-20 inline-flex min-h-11 items-center gap-2 rounded-full border border-border bg-card px-4 text-sm shadow-sm"><span aria-hidden="true">←</span>{t('workspace.dashboard')}</Link>
 </div></JourneyProgressProvider>;
}
