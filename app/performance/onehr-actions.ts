'use server';
import { assessmentReturnPath } from '@/lib/performance-navigation';
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
const readWindows=(f:FormData)=>Object.fromEntries(windowCells.map(cell=>[cell,{opensAt:str(f,`${cell}.opens`)?`${str(f,`${cell}.opens`)}:00+08:00`:null,closesAt:str(f,`${cell}.closes`)?`${str(f,`${cell}.closes`)}:00+08:00`:null}]));

const destination=(f:FormData,fallback:string)=>assessmentReturnPath(f.get('returnTo'),fallback);
const withError=(url:string,error:unknown)=>`${url}${url.includes('?')?'&':'?'}error=${encodeURIComponent(publicErrorMessage(error))}`;

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
      let catalogue={framework:view.policy.framework,profiles:view.policy.profiles,skills:view.policy.skills??[],careerRoutes:view.policy.careerRoutes??[]};
      const file=f.get('catalogue');if(file instanceof File&&file.size){if(file.size>750_000)throw Error('Choose an assessment catalogue smaller than 750 KB.');catalogue=JSON.parse(await file.text());}
      const bBands=view.companies.filter(c=>str(f,`b.${c.id}.0`)).map(c=>({companyId:c.id,variant:str(f,`b.${c.id}.variant`)||'base',minima:[0,1,2,3,4].map(i=>num(f,`b.${c.id}.${i}`))}));
      const windows=readWindows(f);
      await perf.configureOnehrCycle(s,id,num(f,'revision'),{...view.policy,...catalogue,kind:str(f,'kind'),extremes:{enabled:f.has('extremes'),bonus:num(f,'bonus'),penalty:num(f,'penalty')},weights:Object.fromEntries(Object.keys(view.policy.weights).map(g=>[g,Math.round(num(f,`weight.${g}`)*100)])),modules:{pm:f.has('pm'),tm:f.has('tm'),idp:f.has('idp'),evidence:f.has('evidence')},windows,bBands,aBands:[0,1,2,3,4].map(i=>num(f,`a.${i}`)),lowMaxPct:num(f,'lowMaxPct'),midMaxPct:num(f,'midMaxPct'),minValid:num(f,'minValid'),idpMinGoals:num(f,'idpMinGoals'),idpMaxGoals:num(f,'idpMaxGoals'),idpRequireAllActions:f.has('idpRequireAllActions'),curveStrict:f.has('curveStrict'),curveToleranceMode:str(f,'curveToleranceMode')||view.policy.curveToleranceMode,curveTolerancePct:num(f,'curveTolerancePct'),curveTolerancePeople:num(f,'curveTolerancePeople')});
    }else if(str(f,'action')==='windows'){
      await perf.updateOnehrWindows(s,id,num(f,'revision'),readWindows(f),str(f,'reason'));
    }else if(str(f,'action')==='participation'){
      await perf.setAssessmentParticipation(s,id,num(f,'revision'),str(f,'employmentId'),str(f,'participantRevision')?num(f,'participantRevision'):null,z.enum(['add','remove','clear']).parse(str(f,'mode')));
    }else if(str(f,'action')==='calibration'){
      await perf.createOnehrCalibration(s,id,{name:str(f,'name'),companyId:str(f,'companyId')||null,tier:str(f,'tier'),reviewerUserIds:ids(f,'reviewerIds'),reviewIds:ids(f,'reviewIds'),pbtAchievement:nullableNumber(f,'pbt'),mode:str(f,'mode')});
    }else throw Error('Unknown action.');
  }catch(e){redirect(withError(url,e));}
  revalidatePath(url.split('?')[0]);revalidatePath('/performance/workspace');redirect(url);
}
export async function onehrReviewAction(f:FormData){
  const s=await getSession(),id=z.uuid().parse(str(f,'reviewId'));const url=destination(f,`/performance/review/${id}`);
  try{
    const expected=num(f,'revision');
    switch(str(f,'action')){
      case 'kpis':{
        const view=await perf.getOnehrReview(s,id);if(!view)throw Error('Assessment not found.');
        const rows=ids(f,'kpiId').map(k=>({id:k,title:str(f,`${k}.title`),category:str(f,`${k}.category`),libraryId:str(f,`${k}.libraryId`)||null,description:str(f,`${k}.description`),weightBp:Math.round(num(f,`${k}.weight`)*100),unit:str(f,`${k}.unit`),moderatorEmploymentId:str(f,`${k}.moderator`)||view.reviewerEmploymentId,approverEmploymentIds:ids(f,`${k}.approverIds`),scoring:str(f,`${k}.mechanism`)==='A'?{mechanism:'A',method:str(f,`${k}.method`),rates:[0,1,2,3,4].map(i=>num(f,`${k}.rate.${i}`))}:{mechanism:'B',method:str(f,`${k}.method`),variant:str(f,`${k}.variant`),threshold:num(f,`${k}.threshold`),target:num(f,`${k}.target`),multiple:num(f,`${k}.multiple`),excellence:nullableNumber(f,`${k}.excellence`)}}));
        await perf.saveOnehrKpis(s,id,expected,rows,f.has('propose'));break;
      }
      case 'approve':await perf.approveOnehrScorecard(s,id,expected,str(f,'decision')==='approve',str(f,'remark'));break;
      case 'results':
        if(str(f,'intent')==='draft')await saveDraftForm(s,f);
        else await perf.submitOnehrResults(s,id,expected,ids(f,'kpiId').map(k=>({id:k,actual:num(f,`${k}.actual`),note:str(f,`${k}.note`)})),str(f,'overallRemark'));
        break;
      case 'check-in':await perf.saveOnehrKpiCheckIn(s,id,expected,str(f,'kpiId'),str(f,'answer') as 'on_track'|'at_risk'|'off_track'|'nothing_yet',str(f,'note'));break;
      case 'moderation':
        if(str(f,'intent')==='draft')await saveDraftForm(s,f);
        else await perf.submitAssessmentModeration(s,id,expected,ids(f,'kpiId').map(k=>({id:k,actual:num(f,`${k}.actual`),note:str(f,`${k}.note`)})),str(f,'overallRemark'));
        break;
      case 'moderate':await perf.moderateOnehrKpi(s,id,expected,str(f,'kpiId'),num(f,'actual'),str(f,'remark'));break;
      case 'performance':await perf.confirmOnehrPerformance(s,id,expected,str(f,'band') as PMBand,str(f,'remark'));break;
      case 'competencies':
        if(str(f,'intent')==='draft')await saveDraftForm(s,f);
        else await perf.submitOnehrCompetencies(s,id,expected,Object.fromEntries(f.getAll('statementId').map(v=>[String(v),{answer:str(f,`answer.${v}`),remark:str(f,`remark.${v}`)}])),f.has('manager'),str(f,'overallRemark'));
        break;
      case 'profile':await perf.assignAssessmentProfile(s,id,expected,str(f,'profileId'));break;
      case 'panel':await perf.assignOnehrPanel(s,id,expected,ids(f,'peerIds').map(employmentId=>({employmentId,relationship:str(f,`relationship.${employmentId}`)||'peer'})));break;
      case 'reassign':await perf.reassignOnehrReviewer(s,id,expected,str(f,'reviewerEmploymentId'));break;
      case 'freeze':await perf.freezeOnehrReview(s,id,expected);break;
      case 'release':await perf.releaseOnehrResult(s,id,str(f,'component') as 'performance'|'potential'|'talent'|'feedback',str(f,'release')==='true');break;
      case 'plan':{
        const career={aspiration:str(f,'aspiration'),mobility:str(f,'mobility')||null,aspirationNow:str(f,'aspirationNow'),aspirationLong:str(f,'aspirationLong'),strengths:str(f,'strengths'),preferences:str(f,'preferences'),mentor:str(f,'mentor'),selfProfileId:str(f,'selfProfileId')||null,mobilityNote:str(f,'mobilityNote'),targetProfileId:str(f,'targetProfileId')||null};
        const careerRevision=str(f,'careerRevision')?num(f,'careerRevision'):null;
        if(f.has('careerOnly')){await perf.saveAssessmentCareerProfile(s,id,careerRevision,career);break;}
        const goals=ids(f,'goalId').filter(k=>['area','onJob','fromOthers','formalLearning'].some(field=>str(f,`${k}.${field}`))).map(k=>({id:k,area:str(f,`${k}.area`),dueOn:str(f,`${k}.dueOn`),onJob:str(f,`${k}.onJob`),fromOthers:str(f,`${k}.fromOthers`),formalLearning:str(f,`${k}.formalLearning`),status:'not_started'}));
        await perf.saveOnehrPlan(s,id,str(f,'planRevision')?num(f,'planRevision'):null,{career,careerRevision,goals},f.has('share'));break;
      }
      case 'career-comment':await perf.commentAssessmentCareerProfile(s,id,str(f,'careerRevision')?num(f,'careerRevision'):null,str(f,'comment'));break;
      case 'plan-goal-edit':await perf.editAssessmentDevelopmentGoal(s,id,str(f,'planId'),num(f,'planRevision'),str(f,'goalId'),{area:str(f,'area'),dueOn:str(f,'dueOn'),onJob:str(f,'onJob'),fromOthers:str(f,'fromOthers'),formalLearning:str(f,'formalLearning'),managerComment:str(f,'managerComment')});break;
      case 'kpi-moderator':await perf.assignAssessmentKpiModerator(s,id,expected,str(f,'kpiId'),str(f,'moderatorEmploymentId'));break;
      case 'plan-review':await perf.reviewOnehrPlan(s,str(f,'planId'),num(f,'planRevision'),str(f,'comment'),str(f,'conversation'),f.has('close'),id,str(f,'heldOn')||null);break;
      case 'reopen-plan':await perf.reopenAssessmentPlan(s,str(f,'planId'),num(f,'planRevision'));break;
      case 'plan-ack':await perf.acknowledgeOnehrPlan(s,str(f,'planId'),num(f,'planRevision'));break;
      case 'goal-progress':await perf.updateOnehrGoalProgress(s,str(f,'planId'),num(f,'planRevision'),str(f,'goalId'),str(f,'status') as z.infer<typeof goalSchema>['status']);break;
      case 'evidence':await perf.addOnehrEvidence(s,id,{kind:str(f,'kind'),body:str(f,'body'),occurredOn:str(f,'occurredOn'),state:f.has('share')?'shared':'draft',supersedesId:str(f,'supersedesId')||null,links:f.getAll('evidenceLink').map(v=>JSON.parse(String(v)))});break;
      case 'evidence-response':await perf.respondOnehrEvidence(s,str(f,'evidenceId'),str(f,'stance') as 'endorse'|'dispute',str(f,'note'),id);break;
      case 'evidence-state':await perf.changeOnehrEvidenceState(s,str(f,'evidenceId'),str(f,'state') as 'shared'|'retracted');break;
      default:throw Error('Unknown assessment action.');
    }
  }catch(e){redirect(withError(url,e));}
  revalidatePath(url.split('?')[0]);revalidatePath('/performance/workspace');revalidatePath('/me/performance');redirect(url);
}
export async function onehrFeedbackAction(f:FormData){
  const s=await getSession(),id=z.uuid().parse(str(f,'requestId'));const url=destination(f,`/performance/assessment/feedback/${id}`);
  const declined=str(f,'action')==='decline';
  try{if(declined)await perf.declineOnehrFeedback(s,id);else if(str(f,'intent')==='draft')await saveDraftForm(s,f);else await perf.submitOnehrFeedback(s,id,Object.fromEntries(f.getAll('statementId').map(v=>[String(v),str(f,`answer.${v}`)])),str(f,'remark'),Object.fromEntries(f.getAll('principle').map(p=>[String(p),str(f,`comment.${p}`)])));}catch(e){redirect(withError(url,e));}
  revalidatePath('/me/performance');revalidatePath(url.split('?')[0]);revalidatePath('/performance/workspace');redirect(declined?'/me/performance':url);
}
export async function onehrCalibrationAction(f:FormData){
  const s=await getSession(),id=z.uuid().parse(str(f,'sessionId'));const url=destination(f,`/performance/assessment/calibration/${id}`);
  try{if(str(f,'action')==='talent-save')await perf.saveAssessmentTalentDecision(s,id,num(f,'revision'),str(f,'reviewId'),str(f,'kind') as 'pip'|'promotion'|'specialReward'|'nomination',f.has('selected'),str(f,'reason'),{grade:str(f,'grade'),title:str(f,'title'),talentRevision:f.has('talentRevision')?num(f,'talentRevision'):undefined});else if(['talent-lock','talent-reopen'].includes(str(f,'action')))await perf.confirmAssessmentTalentList(s,id,num(f,'revision'),str(f,'kind') as 'pip'|'promotion',str(f,'action')==='talent-reopen',str(f,'reason'));else if(str(f,'action')==='unlock')await perf.unlockOnehrCalibration(s,id,num(f,'revision'),str(f,'reason'),(str(f,'axis')||'both') as 'performance'|'potential'|'both',str(f,'reviewId')||undefined);else if(str(f,'action')==='lock')await perf.lockOnehrCalibration(s,id,num(f,'revision'),str(f,'reason'),(str(f,'axis')||'both') as 'performance'|'potential'|'both',str(f,'reviewId')||undefined,str(f,'companyId')||undefined);else await perf.saveOnehrCalibration(s,id,num(f,'revision'),{reviewId:str(f,'reviewId'),axis:str(f,'axis')||'both',performance:str(f,'performance') as PMBand||null,potential:str(f,'potential') as PotentialBand||null,performanceNote:str(f,'performanceNote'),potentialNote:str(f,'potentialNote'),confirmTalentDecisions:f.has('confirmTalentDecisions'),pip:f.has('pip'),promotion:f.has('promotion'),specialReward:f.has('specialReward')});}catch(e){redirect(withError(url,e));}
  revalidatePath(url.split('?')[0]);revalidatePath('/performance/workspace');redirect(url);
}
export async function onehrDraftAction(reviewId:string,words:string) {
  const s=await getSession();
  try{return {draft:await perf.draftOnehrNarrative(s,reviewId,words)};}catch(e){return {error:publicErrorMessage(e)};}
}

async function saveDraftForm(s:Awaited<ReturnType<typeof getSession>>,f:FormData) {
  const kind=str(f,'draftKind'),reviewId=z.uuid().parse(str(f,'reviewId'));
  let payload:unknown;
  if(kind==='results'||kind==='moderation')payload={kind,lines:ids(f,'kpiId').map(id=>({id,actual:nullableNumber(f,`${id}.actual`),note:str(f,`${id}.note`)})),remark:str(f,'overallRemark')};
  else if(kind==='feedback')payload={kind,comments:Object.fromEntries(f.getAll('principle').map(p=>[String(p),str(f,`comment.${p}`)])),answers:Object.fromEntries(f.getAll('statementId').map(id=>[String(id),str(f,`answer.${id}`)]).filter(([,answer])=>!!answer)),remark:str(f,'remark')};
  else payload={kind,answers:Object.fromEntries(f.getAll('statementId').map(id=>[String(id),{answer:str(f,`answer.${id}`)||null,remark:str(f,`remark.${id}`)}])),remark:str(f,'overallRemark')};
  return perf.saveAssessmentDraft(s,reviewId,kind==='feedback'?0:num(f,'revision'),str(f,'draftRevision')?num(f,'draftRevision'):null,payload,kind==='feedback'?str(f,'requestId'):reviewId);
}
export async function saveAssessmentDraftAction(f:FormData) {
  const s=await getSession();
  try{return await saveDraftForm(s,f);}catch(e){return {error:publicErrorMessage(e)};}
}

export async function reviewConversationAction(reviewId:string,stage:perf.ConversationStage,revision:number|null,requestId:string,text:string,intent:'guide'|'draft') {
 const s=await getSession();
 try{return await perf.sendReviewMessage(s,reviewId,stage,revision,requestId,text,intent);}catch(e){return {error:publicErrorMessage(e)};}
}

export async function assessmentKpiImportAction(cycleId:string,csv:string,kind:'targets'|'library',previewToken?:string) {
 const session=await getSession();
 try {
  const result=await perf.importAssessmentKpis(session,cycleId,csv,kind,previewToken);
  if(result.applied){revalidatePath(`/performance/${cycleId}`);revalidatePath('/performance/workspace');}
  return {result};
 } catch(error){return {error:publicErrorMessage(error)};}
}

export async function assessmentCompanyKpiAction(cycleId:string,input:{companyId:string|null;title:string;actual:number;note:string},previewToken?:string) {
 const session=await getSession();
 try {
  const result=await perf.fillAssessmentCompanyKpi(session,cycleId,input,previewToken);
  if(result.applied){revalidatePath(`/performance/${cycleId}`);revalidatePath('/performance/workspace');}
  return {result};
 } catch(error){return {error:publicErrorMessage(error)};}
}

export async function captureRatingRecordsAction(f:FormData){
 const s=await getSession(),id=z.uuid().parse(str(f,'cycleId'));
 const filters={company:str(f,'company'),department:str(f,'department'),businessGroup:str(f,'businessGroup')};
 const q=new URLSearchParams(Object.entries(filters).filter(([,v])=>!!v)),url=`/performance/${id}/records?${q}`;
 try{await perf.captureAssessmentRatingRecords(s,id,filters);}catch(e){redirect(withError(url,e));}
 revalidatePath(`/performance/${id}/records`);redirect(url);
}
