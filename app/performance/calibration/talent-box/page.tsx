import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { requireModule } from '@/lib/authz';
import { scopedSession } from '@/lib/scope';
import { getOnehrCalibration, performanceWorkspace } from '@/packs/performance/service';
import { AssessmentCalibrationView } from '../../onehr/calibration-view';
import { CalibrationStrip } from './calibration-strip';
import { TalentAxisList } from './axis-list';
import { talentBoxHref, talentBoxRoute } from './talent-box-route';

type Query={session?:string|string[];axis?:string|string[]};

/**
 * D-P1-27 — the standalone Talent Box: the Calibration strip, then the one board (TalentBoard through the embedded
 * calibration view, so the person panel, the moves and the lock are the workspace's own) and, once locked, the
 * PIP and promotion lists below it (APR-012). Thin: which session opens is talentBoxRoute over the viewer's own
 * workspace items — BU, BG and Group Talent Box parts only — so an HOD, or a ?session= the viewer does not hold,
 * gets notFound. A session whose cycle does not run both performance and potential has no board here (C1).
 */
export default async function TalentBoxPage({searchParams}:{searchParams:Promise<Query>}){
 await requireModule('performance');
 const {s}=await scopedSession(),query=await searchParams;
 if(Array.isArray(query.session)||Array.isArray(query.axis))notFound();
 const route=talentBoxRoute(await performanceWorkspace(s),{session:query.session,axis:query.axis});
 if(!route)notFound();
 const [v,t]=await Promise.all([getOnehrCalibration(s,route.box.id,'both','roster'),getTranslations('onehr.talentBoard')]);
 if(!(v.modules.pm&&v.modules.tm))notFound();
 const unitName=new Map(v.units.map(u=>[u.id,u.name]));
 return <div className="min-w-0 space-y-4">
  <CalibrationStrip label={t('calibrationTabs')} tabs={route.tabs.map(tab=>({...tab,label:t(`tabs.${tab.id}`)}))}/>
  {route.boxes.length>1&&<nav aria-label={t('sessions')} className="flex min-w-0 gap-2 overflow-x-auto py-0.5">{route.boxes.map(box=><Link key={box.key} href={talentBoxHref(box.id)} aria-current={box.key===route.box.key?'page':undefined} className={`flex min-h-9 shrink-0 items-center whitespace-nowrap rounded-full border px-[15px] text-[12.5px] font-medium ${box.key===route.box.key?'border-primary bg-primary text-primary-foreground':'border-input bg-card text-foreground hover:bg-muted'}`}>{box.title} · {box.cycle}</Link>)}</nav>}
  {route.axis?<TalentAxisList scope={v.session.name} axis={route.axis} rows={v.rows.map(r=>({id:r.entry.reviewId,name:r.name,unit:unitName.get(r.companyId)??'',department:r.department??'',grade:r.grade,band:route.axis==='performance'?r.entry.performance??r.currentPerformance:r.entry.potential??r.currentPotential}))}/>
   :<AssessmentCalibrationView v={v} embedded standalone axis="both" returnTo={route.returnTo}/>}
 </div>;
}
