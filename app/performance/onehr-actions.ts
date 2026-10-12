'use server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getSession } from '@/lib/session';
import { publicErrorMessage } from '@/lib/public-error';
import * as perf from '@/packs/performance/service';
import { goalSchema, windowCells, type PMBand, type PotentialBand } from '@/packs/performance/onehr/model';

const str=(f:FormData,k:string)=>String(f.get(k)??'').trim();
const num=(f:FormData,k:string)=>{const s=str(f,k);if(!s||!Number.isFinite(Number(s)))throw Error('Enter a number in every required numeric field.');return Number(s);};
const nullableNumber=(f:FormData,k:string)=>str(f,k)?num(f,k):null;
const ids=(f:FormData,k:string)=>f.getAll(k).map(v=>z.uuid().parse(String(v)));
export async function enableOnehrAction(f:FormData){
  const s=await getSession(),id=z.uuid().parse(str(f,'cycleId'));
  try{await perf.configureOnehrCycle(s,id,null);}catch(e){redirect(`/performance/${id}?error=${encodeURIComponent(publicErrorMessage(e))}`);}
  revalidatePath(`/performance/${id}`);redirect(`/performance/${id}`);
}
export async function onehrCycleAction(f:FormData){
  const s=await getSession(),id=z.uuid().parse(str(f,'cycleId'));const url=`/performance/${id}`;
  try{
    const view=await perf.getOnehrCycle(s,id);if(!view)throw Error('Cycle not found.');
    if(str(f,'action')==='policy'){
      let catalogue={framework:view.policy.framework,profiles:view.policy.profiles};
      const file=f.get('catalogue');if(file instanceof File&&file.size){if(file.size>2_000_000)throw Error('Choose an assessment catalogue smaller than 2 MB.');catalogue=JSON.parse(await file.text());}
      const bBands=view.companies.filter(c=>str(f,`b.${c.id}.0`)).map(c=>({companyId:c.id,minima:[0,1,2,3,4].map(i=>num(f,`b.${c.id}.${i}`))}));
      const windows=Object.fromEntries(windowCells.map(cell=>[cell,{opensAt:str(f,`${cell}.opens`)?`${str(f,`${cell}.opens`)}:00+08:00`:null,closesAt:str(f,`${cell}.closes`)?`${str(f,`${cell}.closes`)}:00+08:00`:null}]));
      await perf.configureOnehrCycle(s,id,num(f,'revision'),{...view.policy,...catalogue,kind:str(f,'kind'),extremes:{enabled:f.has('extremes'),bonus:num(f,'bonus'),penalty:num(f,'penalty')},weights:Object.fromEntries(Object.keys(view.policy.weights).map(g=>[g,Math.round(num(f,`weight.${g}`)*100)])),modules:{pm:f.has('pm'),tm:f.has('tm'),idp:f.has('idp'),evidence:f.has('evidence')},windows,bBands,aBands:[0,1,2,3,4].map(i=>num(f,`a.${i}`)),lowMaxPct:num(f,'lowMaxPct'),midMaxPct:num(f,'midMaxPct'),minValid:num(f,'minValid'),idpMinGoals:num(f,'idpMinGoals'),idpRequireAllActions:f.has('idpRequireAllActions'),curveStrict:f.has('curveStrict'),curveTolerancePct:num(f,'curveTolerancePct'),curveTolerancePeople:num(f,'curveTolerancePeople')});
    }else if(str(f,'action')==='calibration'){
      await perf.createOnehrCalibration(s,id,{name:str(f,'name'),companyId:str(f,'companyId')||null,tier:str(f,'tier'),reviewerUserIds:ids(f,'reviewerIds'),reviewIds:ids(f,'reviewIds'),pbtAchievement:nullableNumber(f,'pbt'),mode:str(f,'mode')});
    }else throw Error('Unknown action.');
  }catch(e){redirect(`${url}?error=${encodeURIComponent(publicErrorMessage(e))}`);}
  revalidatePath(url);redirect(url);
}
export async function onehrReviewAction(f:FormData){
  const s=await getSession(),id=z.uuid().parse(str(f,'reviewId'));const url=`/performance/review/${id}`;
  try{
    const expected=num(f,'revision');
    switch(str(f,'action')){
      case 'kpis':{
        const view=await perf.getOnehrReview(s,id);if(!view)throw Error('Assessment not found.');
        const rows=ids(f,'kpiId').map(k=>({id:k,title:str(f,`${k}.title`),description:str(f,`${k}.description`),weightBp:Math.round(num(f,`${k}.weight`)*100),unit:str(f,`${k}.unit`),moderatorEmploymentId:str(f,`${k}.moderator`)||view.reviewerEmploymentId,scoring:str(f,`${k}.mechanism`)==='A'?{mechanism:'A',method:str(f,`${k}.method`),rates:[0,1,2,3,4].map(i=>num(f,`${k}.rate.${i}`))}:{mechanism:'B',method:str(f,`${k}.method`),variant:str(f,`${k}.variant`),threshold:num(f,`${k}.threshold`),target:num(f,`${k}.target`),multiple:num(f,`${k}.multiple`),excellence:nullableNumber(f,`${k}.excellence`)}}));
        await perf.saveOnehrKpis(s,id,expected,rows,f.has('propose'));break;
      }
      case 'approve':await perf.approveOnehrScorecard(s,id,expected,str(f,'decision')==='approve',str(f,'remark'));break;
      case 'results':await perf.submitOnehrResults(s,id,expected,ids(f,'kpiId').map(k=>({id:k,actual:num(f,`${k}.actual`),note:str(f,`${k}.note`)})));break;
      case 'moderate':await perf.moderateOnehrKpi(s,id,expected,str(f,'kpiId'),num(f,'actual'),str(f,'remark'));break;
      case 'performance':await perf.confirmOnehrPerformance(s,id,expected,str(f,'band') as PMBand,str(f,'remark'));break;
      case 'competencies':await perf.submitOnehrCompetencies(s,id,expected,Object.fromEntries(f.getAll('statementId').map(v=>[String(v),{answer:str(f,`answer.${v}`),remark:str(f,`remark.${v}`)}])),f.has('manager'));break;
      case 'panel':await perf.assignOnehrPanel(s,id,expected,ids(f,'peerIds').map(employmentId=>({employmentId,relationship:str(f,`relationship.${employmentId}`)||'peer'})));break;
      case 'reassign':await perf.reassignOnehrReviewer(s,id,expected,str(f,'reviewerEmploymentId'));break;
      case 'freeze':await perf.freezeOnehrReview(s,id,expected);break;
      case 'release':await perf.releaseOnehrResult(s,id,str(f,'component') as 'performance'|'potential'|'talent'|'feedback',str(f,'release')==='true');break;
      case 'plan':{
        const goals=ids(f,'goalId').filter(k=>str(f,`${k}.area`)).map(k=>({id:k,area:str(f,`${k}.area`),dueOn:str(f,`${k}.dueOn`),onJob:str(f,`${k}.onJob`),fromOthers:str(f,`${k}.fromOthers`),formalLearning:str(f,`${k}.formalLearning`),status:'not_started'}));
        await perf.saveOnehrPlan(s,id,str(f,'planRevision')?num(f,'planRevision'):null,{career:{aspiration:str(f,'aspiration'),mobility:str(f,'mobility'),mobilityNote:str(f,'mobilityNote'),targetProfileId:str(f,'targetProfileId')||null},goals},f.has('share'));break;
      }
      case 'plan-review':await perf.reviewOnehrPlan(s,str(f,'planId'),num(f,'planRevision'),str(f,'comment'),str(f,'conversation'),f.has('close'),id);break;
      case 'plan-ack':await perf.acknowledgeOnehrPlan(s,str(f,'planId'),num(f,'planRevision'));break;
      case 'goal-progress':await perf.updateOnehrGoalProgress(s,str(f,'planId'),num(f,'planRevision'),str(f,'goalId'),str(f,'status') as z.infer<typeof goalSchema>['status']);break;
      case 'evidence':await perf.addOnehrEvidence(s,id,{kind:str(f,'kind'),body:str(f,'body'),occurredOn:str(f,'occurredOn'),state:f.has('share')?'shared':'draft',supersedesId:str(f,'supersedesId')||null,links:f.getAll('evidenceLink').map(v=>JSON.parse(String(v)))});break;
      case 'evidence-response':await perf.respondOnehrEvidence(s,str(f,'evidenceId'),str(f,'stance') as 'endorse'|'dispute',str(f,'note'),id);break;
      case 'evidence-state':await perf.changeOnehrEvidenceState(s,str(f,'evidenceId'),str(f,'state') as 'shared'|'retracted');break;
      default:throw Error('Unknown assessment action.');
    }
  }catch(e){redirect(`${url}?error=${encodeURIComponent(publicErrorMessage(e))}`);}
  revalidatePath(url);revalidatePath('/me/performance');redirect(url);
}
export async function onehrFeedbackAction(f:FormData){
  const s=await getSession(),id=z.uuid().parse(str(f,'requestId'));const url=`/performance/onehr/feedback/${id}`;
  const declined=str(f,'action')==='decline';
  try{if(declined)await perf.declineOnehrFeedback(s,id);else await perf.submitOnehrFeedback(s,id,Object.fromEntries(f.getAll('statementId').map(v=>[String(v),str(f,`answer.${v}`)])),str(f,'remark'));}catch(e){redirect(`${url}?error=${encodeURIComponent(publicErrorMessage(e))}`);}
  revalidatePath('/me/performance');revalidatePath(url);redirect(declined?'/me/performance':url);
}
export async function onehrCalibrationAction(f:FormData){
  const s=await getSession(),id=z.uuid().parse(str(f,'sessionId'));const url=`/performance/onehr/calibration/${id}`;
  try{if(str(f,'action')==='lock')await perf.lockOnehrCalibration(s,id,num(f,'revision'),str(f,'reason'),(str(f,'axis')||'both') as 'performance'|'potential'|'both',str(f,'reviewId')||undefined);else await perf.saveOnehrCalibration(s,id,num(f,'revision'),{reviewId:str(f,'reviewId'),axis:str(f,'axis')||'both',performance:str(f,'performance') as PMBand||null,potential:str(f,'potential') as PotentialBand||null,performanceNote:str(f,'performanceNote'),potentialNote:str(f,'potentialNote'),pip:f.has('pip'),promotion:f.has('promotion'),specialReward:f.has('specialReward')});}catch(e){redirect(`${url}?error=${encodeURIComponent(publicErrorMessage(e))}`);}
  revalidatePath(url);redirect(url);
}
export async function onehrDraftAction(reviewId:string,words:string) {
  const s=await getSession();
  try{return {draft:await perf.draftOnehrNarrative(s,reviewId,words)};}catch(e){return {error:publicErrorMessage(e)};}
}
