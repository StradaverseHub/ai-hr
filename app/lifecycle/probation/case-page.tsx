import {notFound} from 'next/navigation';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {viewerIdentity} from '@/lib/viewer';
import {todayInKualaLumpur} from '@/lib/hr-date';
import {probationCase,probationAutomationHistory,probationSignerCandidates,type ProbationPartView} from '@/packs/probation/service';
import {ProbationCaseViewScreen} from './case-view';
import {probationDefaultTab,probationPartsByType,type ProbationCaseTab} from './case-stage';

const TABS:readonly ProbationCaseTab[]=['p1','p2','p3','outcome','files','history'];
/**
 * One server reader for the case view (L1) behind both addresses: /lifecycle/probation/[id] (?tab=…) and a part's own
 * address /lifecycle/probation/[id]/[partId], which opens the case on that part's tab. The case read authorizes; only the
 * selected tab's extra data (signer choices, the viewer's name, workflow history) is read.
 */
export async function ProbationCasePage({id,tab,partId}:{id:string;tab?:string;partId?:string}){
 const ctx=await requireScopedLifecycleModule();
 const view=await probationCase(ctx,id);
 let selected:ProbationCaseTab=TABS.includes(tab as ProbationCaseTab)?tab as ProbationCaseTab:probationDefaultTab(view);
 let part:ProbationPartView|null=null;
 if(partId){part=view.parts.find(p=>p.id===partId)??null;if(!part)notFound();selected=('p'+part.type) as ProbationCaseTab;}
 else if(selected==='p1'||selected==='p2'||selected==='p3')part=probationPartsByType(view).find(p=>'p'+p.type===selected)??null;
 const operations=view.runtimeEnabled&&view.roles.some(role=>role==='pbp'||role==='gbs');
 const [viewer,signerCandidates,history]=await Promise.all([
  part?viewerIdentity(ctx):Promise.resolve(null),
  part&&operations?probationSignerCandidates(ctx,id).then(rows=>Array.from(rows)):Promise.resolve(undefined),
  // I5: the shared workflow run log; a failure to read it never blocks the case (the case itself authorised the read).
  selected==='history'?probationAutomationHistory(ctx,id).catch(()=>undefined):Promise.resolve(undefined),
 ]);
 return <ProbationCaseViewScreen view={view} today={todayInKualaLumpur()} tab={selected} part={part} actor={{id:ctx.userId??'',name:viewer?.name??''}} signerCandidates={signerCandidates} history={history}/>;
}
