'use server';
import {readCompetencySections} from '@/packs/performance/onehr/competency-section-model';
import { readKpiSettingForm } from '@/packs/performance/onehr/setting-form-model';
import { assessmentReturnPath } from '@/lib/performance-navigation';
import { revalidateAssessmentWorkspace } from './workspace-revalidation';
import { adminReturnPath } from '@/packs/performance/onehr/admin-sections';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getSession } from '@/lib/session';
import { publicErrorMessage } from '@/lib/public-error';
import { getTranslations } from 'next-intl/server';
import { performanceAiErrorMessage } from '@/packs/performance/onehr/ai-refusal';
import * as perf from '@/packs/performance/service';
import { goalSchema, windowCells, assessmentModuleKeys, type PMBand, type PotentialBand } from '@/packs/performance/onehr/model';

/** Returned errors: a typed AI control refusal (paused, allowance or USD spend control) becomes the translated
 * assistant.err_ai_control sentence; everything else keeps publicErrorMessage's redaction. */
const actionError=(error:unknown)=>performanceAiErrorMessage(error,async key=>(await getTranslations('assistant'))(key));
const str=(f:FormData,k:string)=>String(f.get(k)??'').trim();
const num=(f:FormData,k:string)=>{const s=str(f,k);if(!s||!Number.isFinite(Number(s)))throw Error('Enter a number in every required numeric field.');return Number(s);};
const nullableNumber=(f:FormData,k:string)=>str(f,k)?num(f,k):null;
const evidenceFields=(f:FormData)=>({...Object.fromEntries(['kind','body','occurredOn','title','impact','who','precision','metricUnit'].filter(k=>f.has(k)).map(k=>[k,str(f,k)])),...(f.has('metricValue')?{metricValue:nullableNumber(f,'metricValue')}:{}),...(f.has('raisedWithSubject')?{raisedWithSubject:str(f,'raisedWithSubject')||null}:{})});
const ids=(f:FormData,k:string)=>f.getAll(k).map(v=>z.uuid().parse(String(v)));
const readWindows=(f:FormData)=>Object.fromEntries(windowCells.map(cell=>[cell,{opensAt:str(f,`${cell}.opens`)?`${str(f,`${cell}.opens`)}:00+08:00`:null,closesAt:str(f,`${cell}.closes`)?`${str(f,`${cell}.closes`)}:00+08:00`:null}]));
function planInput(f:FormData){
 const career={aspiration:str(f,'aspiration'),mobility:str(f,'mobility')||null,aspirationNow:str(f,'aspirationNow'),aspirationLong:str(f,'aspirationLong'),strengths:str(f,'strengths'),preferences:str(f,'preferences'),mentor:str(f,'mentor'),selfProfileId:str(f,'selfProfileId')||null,mobilityNote:str(f,'mobilityNote'),targetProfileId:str(f,'targetProfileId')||null};
 const careerRevision=str(f,'careerRevision')?num(f,'careerRevision'):null;
 const goals=ids(f,'goalId').filter(k=>['area','onJob','fromOthers','formalLearning'].some(field=>str(f,`${k}.${field}`))).map(k=>({id:k,area:str(f,`${k}.area`),dueOn:str(f,`${k}.dueOn`),onJob:str(f,`${k}.onJob`),fromOthers:str(f,`${k}.fromOthers`),formalLearning:str(f,`${k}.formalLearning`),status:'not_started'}));
 return {career,careerRevision,goals};
}
export async function developmentSuggestionsAction(reviewId:string){
 const s=await getSession();try{return await perf.suggestAssessmentDevelopmentGoals(s,reviewId,crypto.randomUUID());}catch(error){return {error:await actionError(error)};}
}
export async function careerPlanDraftAction(reviewId:string,authored?:{aspirationLong?:string}){
 const s=await getSession();try{const words=z.object({aspirationLong:z.string().trim().min(1).max(4000).optional()}).strict().parse(authored??{});return await perf.suggestAssessmentCareerPlan(s,reviewId,crypto.randomUUID(),words);}catch(error){return {error:await actionError(error)};}
}
export async function applyCareerPlanDraftAction(f:FormData,selected:import('@/packs/performance/onehr/career-draft-model').CareerDraftGoal[],aspirationLong:string,sourceDigest:string){
 const s=await getSession();try{const id=z.uuid().parse(str(f,'reviewId'));await perf.applyAssessmentCareerPlan(s,id,str(f,'planRevision')?num(f,'planRevision'):null,planInput(f),selected,aspirationLong,sourceDigest);revalidateAssessmentWorkspace();revalidatePath('/me/performance');revalidatePath(`/performance/assessment/${id}`);return {ok:true as const};}catch(error){return {error:await actionError(error)};}
}
export async function applyDevelopmentSuggestionsAction(f:FormData,selected:import('@/packs/performance/onehr/development-suggestion-model').SuggestedDevelopmentGoal[],sourceDigest:string){
 const s=await getSession();try{const id=z.uuid().parse(str(f,'reviewId'));await perf.applyAssessmentDevelopmentGoals(s,id,str(f,'planRevision')?num(f,'planRevision'):null,planInput(f),selected,sourceDigest);revalidateAssessmentWorkspace();revalidatePath('/me/performance');revalidatePath(`/performance/assessment/${id}`);return {ok:true as const};}catch(error){return {error:await actionError(error)};}
}


const destination=(f:FormData,fallback:string)=>assessmentReturnPath(f.get('returnTo'),fallback);
const withError=(url:string,error:unknown)=>`${url}${url.includes('?')?'&':'?'}error=${encodeURIComponent(publicErrorMessage(error))}`;
export async function assessmentIdpFitAction(reviewId:string,generate=false,sessionId?:string){
 const s=await getSession();
 try{return await perf.getAssessmentIdpFit(s,z.uuid().parse(reviewId),{generate:z.boolean().parse(generate),sessionId:sessionId?z.uuid().parse(sessionId):undefined});}
 catch(error){return {error:await actionError(error)};}
}
export async function assessmentRecordInsightAction(reviewId:string,kind:'present'|'cycle'|'trend',generate=false){
 const s=await getSession();try{return await perf.getAssessmentRecordInsight(s,z.uuid().parse(reviewId),z.enum(['present','cycle','trend']).parse(kind),{generate:z.boolean().parse(generate)});}catch(error){return {error:await actionError(error)};}
}
export async function assessmentWrittenRemarksAction(reviewId:string,sessionId:string,axis:'pm'|'pot',generate=false){
 const s=await getSession();try{return await perf.getAssessmentWrittenRemarks(s,z.uuid().parse(reviewId),z.uuid().parse(sessionId),z.enum(['pm','pot']).parse(axis),{generate:z.boolean().parse(generate)});}catch(error){return {error:await actionError(error)};}
}
export async function assessmentPotentialInsightAction(reviewId:string,sessionId:string,generate=false){
 const s=await getSession();
 try{return await perf.getAssessmentPotentialInsight(s,z.uuid().parse(reviewId),z.uuid().parse(sessionId),{generate:z.boolean().parse(generate)});}
 catch(error){return {error:await actionError(error)};}
}
export async function assessmentCompetencyInsightAction(reviewId:string,generate=false){
 const s=await getSession();
 try{return await perf.getAssessmentCompetencyInsight(s,z.uuid().parse(reviewId),{generate:z.boolean().parse(generate)});}
 catch(error){return {error:await actionError(error)};}
}
export async function assessmentInsightAction(reviewId:string,contextId:string,generate=false){
 const s=await getSession();
 try{return await perf.getAssessmentPerformanceInsight(s,z.uuid().parse(reviewId),z.uuid().parse(contextId),{generate:z.boolean().parse(generate)});}
 catch(error){return {error:await actionError(error)};}
}
export async function calibrationConversationAction(sessionId:string,axis:'performance'|'potential'|'both',expected:number|null,requestId:string,text:string){
 const s=await getSession();
 try{const result=await perf.sendCalibrationMessage(s,z.uuid().parse(sessionId),z.enum(['performance','potential','both']).parse(axis),expected,requestId,text);revalidateAssessmentWorkspace();return result;}
 catch(error){return {error:await actionError(error)};}
}



export async function enableOnehrAction(f:FormData){
  const s=await getSession(),id=z.uuid().parse(str(f,'cycleId'));
  try{await perf.configureOnehrCycle(s,id,null);}catch(e){redirect(`/performance/${id}?error=${encodeURIComponent(publicErrorMessage(e))}`);}
  revalidatePath(`/performance/${id}`);redirect(`/performance/${id}`);
}
export async function finalBandsAction(f:FormData){
 const s=await getSession(),id=z.uuid().parse(str(f,'sessionId')),url=`/performance/assessment/calibration/${id}?view=final-bands`;
 try{
  if(str(f,'action')==='mode')await perf.configureAssessmentGroupMode(s,id,num(f,'revision'),z.enum(['after','replace','blend']).parse(str(f,'mode')),num(f,'bgWeight'));
  else await perf.decideAssessmentFinalBands(s,id,str(f,'sourceDigest'),{action:str(f,'action'),reviewId:str(f,'reviewId')||undefined,band:str(f,'band')||undefined,reason:str(f,'reason')});
 }catch(error){redirect(withError(url,error));}
 revalidatePath(`/performance/assessment/calibration/${id}`);revalidateAssessmentWorkspace();revalidatePath('/me/performance');redirect(url);
}
export async function onehrCycleAction(f:FormData){
  // D-P1-32 PT-X4: a form on an admin page comes back to that page (adminReturnPath accepts only this cycle's own).
  const s=await getSession(),id=z.uuid().parse(str(f,'cycleId'));const url=adminReturnPath(str(f,'returnTo'),id)??`/performance/${id}`;
  try{
    const view=await perf.getOnehrCycle(s,id);if(!view)throw Error('Cycle not found.');
    if(str(f,'action')==='policy'){
      let catalogue={framework:view.policy.framework,leadershipPrinciples:view.policy.leadershipPrinciples,profiles:view.policy.profiles,skills:view.policy.skills??[],careerRoutes:view.policy.careerRoutes??[]};
      const file=f.get('catalogue');if(file instanceof File&&file.size){if(file.size>750_000)throw Error('Choose an assessment catalogue smaller than 750 KB.');catalogue=JSON.parse(await file.text());}
      const bBands=view.companies.filter(c=>str(f,`b.${c.id}.0`)).map(c=>({companyId:c.id,variant:str(f,`b.${c.id}.variant`)||'base',minima:[0,1,2,3,4].map(i=>num(f,`b.${c.id}.${i}`))}));
      const windows=readWindows(f);
      await perf.configureOnehrCycle(s,id,num(f,'revision'),{...view.policy,...catalogue,kind:str(f,'kind'),extremes:{enabled:f.has('extremes'),bonus:num(f,'bonus'),penalty:num(f,'penalty')},weights:Object.fromEntries(Object.keys(view.policy.weights).map(g=>[g,Math.round(num(f,`weight.${g}`)*100)])),modules:Object.fromEntries(assessmentModuleKeys.map(k=>[k,f.has(k)])),windows,bBands,aBands:[0,1,2,3,4].map(i=>num(f,`a.${i}`)),lowMaxPct:num(f,'lowMaxPct'),midMaxPct:num(f,'midMaxPct'),minValid:num(f,'minValid'),panelTarget:num(f,'panelTarget'),idpMinGoals:num(f,'idpMinGoals'),idpMaxGoals:num(f,'idpMaxGoals'),idpRequireAllActions:f.has('idpRequireAllActions'),curveStrict:f.has('curveStrict'),curveToleranceMode:str(f,'curveToleranceMode')||view.policy.curveToleranceMode,curveTolerancePct:num(f,'curveTolerancePct'),curveTolerancePeople:num(f,'curveTolerancePeople')});
    }else if(str(f,'action')==='framework'){
      const edit={action:str(f,'edit'),principleId:str(f,'principleId'),statementId:str(f,'statementId'),name:str(f,'name'),description:str(f,'description'),text:str(f,'text'),tier:Number(str(f,'tier')),future:f.has('future')};
      await perf.updateAssessmentFramework(s,id,num(f,'revision'),edit);
    }else if(str(f,'action')==='catalogue-profile'){
      const profile=view.policy.profiles.find(p=>p.id===str(f,'profileId')),available=[...new Map([...view.policy.profiles.flatMap(p=>p.competencies),...(view.policy.skills??[])].map(s=>[s.id,s])).values()];
      const chosen=f.getAll('skillId').map(String);if(chosen.some(id=>!available.some(s=>s.id===id)))throw Error('Choose current catalogue competencies.');
      await perf.saveAssessmentCatalogueProfile(s,id,num(f,'revision'),str(f,'profileId')||null,{name:str(f,'name'),jobTitle:str(f,'jobTitle'),department:str(f,'department'),grade:str(f,'grade'),companyId:str(f,'companyId')||null,active:f.has('active'),sector:str(f,'sector'),track:str(f,'track'),competencies:available.filter(s=>chosen.includes(s.id)).map(s=>({...s,future:profile?.competencies.find(c=>c.id===s.id)?.future??false}))});
    }else if(str(f,'action')==='career-route'){
      await perf.setAssessmentCareerRoute(s,id,num(f,'revision'),str(f,'fromProfileId'),str(f,'toProfileId'),z.enum(['pinned','hidden','automatic']).parse(str(f,'kind')));
    }else if(str(f,'action')==='modules'){
      await perf.updateAssessmentModules(s,id,num(f,'revision'),Object.fromEntries(assessmentModuleKeys.map(k=>[k,f.has(k)])));
    }else if(str(f,'action')==='windows'){
      await perf.updateOnehrWindows(s,id,num(f,'revision'),readWindows(f),str(f,'reason'));
    }else if(str(f,'action')==='participation'){
      await perf.setAssessmentParticipation(s,id,num(f,'revision'),str(f,'employmentId'),str(f,'participantRevision')?num(f,'participantRevision'):null,z.enum(['add','remove','clear']).parse(str(f,'mode')));
    }else if(str(f,'action')==='profit-achievement'){
      await perf.saveAssessmentProfitAchievement(s,id,{companyId:str(f,'companyId'),revision:str(f,'profitRevision')?num(f,'profitRevision'):null,achievementPct:nullableNumber(f,'achievementPct')});
    }else if(str(f,'action')==='calibration'){
      await perf.createOnehrCalibration(s,id,{name:str(f,'name'),companyId:str(f,'companyId')||null,tier:str(f,'tier'),reviewerUserIds:ids(f,'reviewerIds'),reviewIds:ids(f,'reviewIds'),pbtAchievement:nullableNumber(f,'pbt'),mode:str(f,'mode'),bgWeight:nullableNumber(f,'bgWeight')??50});
    }else throw Error('Unknown action.');
  }catch(e){redirect(withError(url,e));}
  revalidatePath(url.split('?')[0]);revalidatePath(`/performance/${id}`);revalidateAssessmentWorkspace();redirect(url);
}
export async function onehrReviewAction(f:FormData){
  const s=await getSession(),id=z.uuid().parse(str(f,'reviewId'));const url=destination(f,`/performance/review/${id}`);
  try{
    const expected=num(f,'revision');
    switch(str(f,'action')){
      case 'kpis':{
        const view=await perf.getOnehrReview(s,id);if(!view)throw Error('Assessment not found.');
        const rows=readKpiSettingForm(f,view.reviewerEmploymentId);
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
        else await perf.submitOnehrCompetencies(s,id,expected,Object.fromEntries(f.getAll('statementId').map(v=>[String(v),{answer:str(f,`answer.${v}`),remark:str(f,`remark.${v}`)}])),f.has('manager'),str(f,'overallRemark'),readCompetencySections(f));
        break;
      case 'profile':await perf.assignAssessmentProfile(s,id,expected,str(f,'profileId'));break;
      case 'panel':await perf.assignOnehrPanel(s,id,expected,ids(f,'peerIds').map(employmentId=>({employmentId,relationship:str(f,`relationship.${employmentId}`)||'peer'})));break;
      case 'panel-state':await perf.changeAssessmentPanelState(s,id,expected,str(f,'requestId'),z.enum(['archive','restore','reset']).parse(str(f,'operation')),str(f,'reason'));break;
      case 'reassign':await perf.reassignOnehrReviewer(s,id,expected,str(f,'reviewerEmploymentId'));break;
      case 'freeze':await perf.freezeOnehrReview(s,id,expected);break;
      case 'release':await perf.releaseOnehrResult(s,id,str(f,'component') as 'performance'|'potential'|'talent'|'feedback',str(f,'release')==='true');break;
      case 'plan':{
        const input=planInput(f);
        if(f.has('careerOnly')){await perf.saveAssessmentCareerProfile(s,id,input.careerRevision,input.career);break;}
        await perf.saveOnehrPlan(s,id,str(f,'planRevision')?num(f,'planRevision'):null,input,f.has('share'));break;
      }
      case 'career-comment':await perf.commentAssessmentCareerProfile(s,id,str(f,'careerRevision')?num(f,'careerRevision'):null,str(f,'comment'));break;
      case 'plan-goal-edit':await perf.editAssessmentDevelopmentGoal(s,id,str(f,'planId'),num(f,'planRevision'),str(f,'goalId'),{area:str(f,'area'),dueOn:str(f,'dueOn'),onJob:str(f,'onJob'),fromOthers:str(f,'fromOthers'),formalLearning:str(f,'formalLearning'),managerComment:str(f,'managerComment')});break;
      case 'kpi-moderator':await perf.assignAssessmentKpiModerator(s,id,expected,str(f,'kpiId'),str(f,'moderatorEmploymentId'));break;
      case 'plan-review':await perf.reviewOnehrPlan(s,str(f,'planId'),num(f,'planRevision'),str(f,'comment'),str(f,'conversation'),f.has('close'),id,str(f,'heldOn')||null);break;
      case 'reopen-plan':await perf.reopenAssessmentPlan(s,str(f,'planId'),num(f,'planRevision'));break;
      case 'plan-ack':await perf.acknowledgeOnehrPlan(s,str(f,'planId'),num(f,'planRevision'));break;
      case 'evidence-file-remove':await perf.removeAssessmentEvidenceFile(s,id,str(f,'attachmentId'));break;
      case 'goal-progress':await perf.updateOnehrGoalProgress(s,str(f,'planId'),num(f,'planRevision'),str(f,'goalId'),str(f,'status') as z.infer<typeof goalSchema>['status']);break;
      case 'evidence':await perf.addOnehrEvidence(s,id,{...evidenceFields(f),state:f.has('share')?'shared':'draft',supersedesId:str(f,'supersedesId')||null,links:f.getAll('evidenceLink').map(v=>JSON.parse(String(v)))});break;
      case 'evidence-edit':await perf.editAssessmentEvidence(s,str(f,'evidenceId'),num(f,'evidenceRevision'),evidenceFields(f));break;
      case 'evidence-link':await perf.linkAssessmentEvidence(s,id,str(f,'evidenceId'),num(f,'evidenceRevision'),JSON.parse(str(f,'evidenceLink')),str(f,'linked')!=='false');break;
      case 'evidence-cite':await perf.citeAssessmentEvidence(s,id,str(f,'evidenceId'),num(f,'evidenceRevision'),z.enum(['supports','qualifies','contradicts']).parse(str(f,'citationStance')),z.enum(['kpi_result','moderation','band_change']).parse(str(f,'decisionKind')));break;
      case 'evidence-response':await perf.respondOnehrEvidence(s,str(f,'evidenceId'),str(f,'stance') as 'endorse'|'dispute',str(f,'note'),id);break;
      case 'evidence-state':await perf.changeOnehrEvidenceState(s,str(f,'evidenceId'),str(f,'state') as 'shared'|'retracted');break;
      default:throw Error('Unknown assessment action.');
    }
  }catch(e){redirect(withError(url,e));}
  revalidatePath(url.split('?')[0]);revalidateAssessmentWorkspace();revalidatePath('/me/performance');redirect(url);
}
export async function onehrFeedbackAction(f:FormData){
  const s=await getSession(),id=z.uuid().parse(str(f,'requestId'));const url=destination(f,`/performance/assessment/feedback/${id}`);
  const declined=str(f,'action')==='decline';
  try{if(declined)await perf.declineOnehrFeedback(s,id);else if(str(f,'intent')==='draft')await saveDraftForm(s,f);else await perf.submitOnehrFeedback(s,id,Object.fromEntries(f.getAll('statementId').map(v=>[String(v),str(f,`answer.${v}`)])),str(f,'remark'),Object.fromEntries(f.getAll('principle').map(p=>[String(p),str(f,`comment.${p}`)])));}catch(e){redirect(withError(url,e));}
  revalidatePath('/me/performance');revalidatePath(url.split('?')[0]);revalidateAssessmentWorkspace();redirect(declined?'/me/performance':url);
}
export async function agreeDepartmentAction(f:FormData){
 const s=await getSession(),id=z.uuid().parse(str(f,'sessionId')),url=destination(f,`/performance/assessment/calibration/${id}`);
 try{await perf.agreeAssessmentDepartment(s,id,num(f,'revision'),z.enum(['performance','potential']).parse(str(f,'axis')),ids(f,'reviewId'));}catch(error){redirect(withError(url,error));}
 revalidateAssessmentWorkspace();revalidatePath(url.split('?')[0]);redirect(url);
}
export async function lockGroupPeopleAction(f:FormData){
 const s=await getSession(),id=z.uuid().parse(str(f,'sessionId')),url=destination(f,`/performance/assessment/calibration/${id}`);
 try{await perf.lockAssessmentGroupPeople(s,id,num(f,'revision'),ids(f,'reviewId'));}catch(error){redirect(withError(url,error));}
 revalidateAssessmentWorkspace();revalidatePath(url.split('?')[0]);redirect(url);
}
/** The Group performance list: a changed call may carry the Group Chief's reason (optional under APR-022); a given one is stored. */
export async function changeGroupBandAction(sessionId:string,revision:number,reviewId:string,band:PMBand,reason:string){
 const s=await getSession();
 try{const v=await perf.getOnehrCalibration(s,sessionId);if(v.session.tier!=='group')throw Error('This action belongs to Group calibration.');await perf.saveOnehrCalibration(s,sessionId,revision,{reviewId,axis:'performance',performance:band,potential:null,performanceNote:reason,potentialNote:''});revalidateAssessmentWorkspace();return {ok:true as const};}catch(error){return {error:await actionError(error)};}
}
/** Reversible Talent Box saves refresh the same route, retaining the person's list filters. */
export async function saveCalibrationBandAction(f:FormData){
 const s=await getSession();
 try{const id=z.uuid().parse(str(f,'sessionId'));await perf.moveAssessmentTalentBox(s,id,num(f,'revision'),{reviewId:str(f,'reviewId'),performance:str(f,'performance')||null,potential:str(f,'potential')||null,performanceNote:str(f,'performanceNote'),potentialNote:str(f,'potentialNote')});revalidateAssessmentWorkspace();revalidatePath(`/performance/assessment/calibration/${id}`);return {ok:true as const};}
 catch(error){return {error:await actionError(error)};}
}
export async function onehrCalibrationAction(f:FormData){
  const s=await getSession(),id=z.uuid().parse(str(f,'sessionId'));const url=destination(f,`/performance/assessment/calibration/${id}`);
  try{if(str(f,'action')==='talent-save')await perf.saveAssessmentTalentDecision(s,id,num(f,'revision'),str(f,'reviewId'),str(f,'kind') as 'pip'|'promotion'|'specialReward'|'nomination',f.has('selected'),str(f,'reason'),{grade:str(f,'grade'),title:str(f,'title'),talentRevision:f.has('talentRevision')?num(f,'talentRevision'):undefined});else if(['talent-lock','talent-reopen'].includes(str(f,'action')))await perf.confirmAssessmentTalentList(s,id,num(f,'revision'),str(f,'kind') as 'pip'|'promotion',str(f,'action')==='talent-reopen',str(f,'reason'));else if(str(f,'action')==='unlock')await perf.unlockOnehrCalibration(s,id,num(f,'revision'),str(f,'reason'),(str(f,'axis')||'both') as 'performance'|'potential'|'both',str(f,'reviewId')||undefined);else if(str(f,'action')==='lock')await perf.lockOnehrCalibration(s,id,num(f,'revision'),str(f,'reason'),(str(f,'axis')||'both') as 'performance'|'potential'|'both',str(f,'reviewId')||undefined,str(f,'companyId')||undefined);else await perf.saveOnehrCalibration(s,id,num(f,'revision'),{reviewId:str(f,'reviewId'),axis:str(f,'axis')||'both',performance:str(f,'performance') as PMBand||null,potential:str(f,'potential') as PotentialBand||null,performanceNote:str(f,'performanceNote'),potentialNote:str(f,'potentialNote'),confirmTalentDecisions:f.has('confirmTalentDecisions'),pip:f.has('pip'),promotion:f.has('promotion'),specialReward:f.has('specialReward')});}catch(e){redirect(withError(url,e));}
  revalidatePath(url.split('?')[0]);revalidateAssessmentWorkspace();redirect(url);
}
export async function onehrDraftAction(reviewId:string,words:string) {
  const s=await getSession();
  try{return {draft:await perf.draftOnehrNarrative(s,reviewId,words)};}catch(e){return {error:await actionError(e)};}
}

async function saveDraftForm(s:Awaited<ReturnType<typeof getSession>>,f:FormData) {
  const kind=str(f,'draftKind'),reviewId=z.uuid().parse(str(f,'reviewId'));
  let payload:unknown;
  if(kind==='results'||kind==='moderation')payload={kind,lines:ids(f,'kpiId').map(id=>({id,actual:nullableNumber(f,`${id}.actual`),note:str(f,`${id}.note`)})),remark:str(f,'overallRemark')};
  else if(kind==='feedback')payload={kind,comments:Object.fromEntries(f.getAll('principle').map(p=>[String(p),str(f,`comment.${p}`)])),answers:Object.fromEntries(f.getAll('statementId').map(id=>[String(id),str(f,`answer.${id}`)]).filter(([,answer])=>!!answer)),remark:str(f,'remark')};
  else payload={kind,sections:readCompetencySections(f),answers:Object.fromEntries(f.getAll('statementId').map(id=>[String(id),{answer:str(f,`answer.${id}`)||null,remark:str(f,`remark.${id}`)}])),remark:str(f,'overallRemark')};
  return perf.saveAssessmentDraft(s,reviewId,kind==='feedback'?0:num(f,'revision'),str(f,'draftRevision')?num(f,'draftRevision'):null,payload,kind==='feedback'?str(f,'requestId'):reviewId);
}
export async function saveAssessmentDraftAction(f:FormData) {
  const s=await getSession();
  try{return await saveDraftForm(s,f);}catch(e){return {error:await actionError(e)};}
}

export async function reviewConversationAction(reviewId:string,stage:perf.ConversationStage,revision:number|null,requestId:string,text:string,intent:'guide'|'draft'|'starter',contextId?:string) {
 const s=await getSession();
 try{if(stage==='feedback'){if(!contextId)throw Error('Choose an assigned colleague.');if(intent==='starter')throw Error('Scorecard suggestions are only available in KPI setting.');return await perf.sendFeedbackMessage(s,reviewId,contextId,revision,requestId,text,intent);}return await perf.sendReviewMessage(s,reviewId,stage,revision,requestId,text,intent);}catch(e){return {error:await actionError(e)};}
}

export async function assessmentKpiImportAction(cycleId:string,csv:string,kind:'targets'|'library',previewToken?:string) {
 const session=await getSession();
 try {
  const result=await perf.importAssessmentKpis(session,cycleId,csv,kind,previewToken);
  if(result.applied){revalidatePath(`/performance/${cycleId}`);revalidateAssessmentWorkspace();}
  return {result};
 } catch(error){return {error:await actionError(error)};}
}

export async function assessmentCompanyKpiAction(cycleId:string,input:{companyId:string|null;title:string;actual:number;note:string},previewToken?:string) {
 const session=await getSession();
 try {
  const result=await perf.fillAssessmentCompanyKpi(session,cycleId,input,previewToken);
  if(result.applied){revalidatePath(`/performance/${cycleId}`);revalidateAssessmentWorkspace();}
  return {result};
 } catch(error){return {error:await actionError(error)};}
}

export async function captureRatingRecordsAction(f:FormData){
 const s=await getSession(),id=z.uuid().parse(str(f,'cycleId'));
 const filters={company:str(f,'company'),department:str(f,'department'),businessGroup:str(f,'businessGroup')};
 const q=new URLSearchParams(Object.entries(filters).filter(([,v])=>!!v)),url=`/performance/${id}/records?${q}`;
 try{await perf.captureAssessmentRatingRecords(s,id,filters);}catch(e){redirect(withError(url,e));}
 revalidatePath(`/performance/${id}/records`);redirect(url);
}

/** WP-E (CF-08) — one bulk release or revoke at one step; the page shows the per-person counts it returns. */
export async function bulkReleaseAction(f:FormData){
 const s=await getSession(),cycleId=z.uuid().parse(str(f,'cycleId'));
 const filters=new URLSearchParams(Object.entries({businessGroup:str(f,'businessGroup'),companyId:str(f,'companyId'),department:str(f,'department'),status:str(f,'status')}).filter(([,v])=>!!v));
 const base=`/performance/${cycleId}/release`,back=filters.size?`${base}?${filters}`:base;
 let summary:string;
 try{
  const step=z.enum(perf.releaseSteps).parse(str(f,'to')),action=z.enum(['release','revoke']).parse(str(f,'action'));
  const result=await perf.releaseOnehrResults(s,{cycleId,reviewIds:ids(f,'ids'),result:z.enum(perf.releaseResults).parse(str(f,'result')),step,action});
  summary=Buffer.from(JSON.stringify({step,action,...result}),'utf8').toString('base64url');
 }catch(e){redirect(withError(back,e));}
 const q=new URLSearchParams(filters);q.set('outcome',summary);
 revalidatePath(base);revalidatePath(`/performance/${cycleId}`);revalidatePath('/performance/led');redirect(`${base}?${q}`);
}
export async function assessmentArchitectureAction(cycleId:string,sheets:{Job_Profile:string;Job_Skills:string},token?:string){
 const s=await getSession();try{const result=await perf.importAssessmentArchitecture(s,cycleId,sheets,token);if(result.applied){revalidatePath(`/performance/${cycleId}`);revalidateAssessmentWorkspace();}return {result};}catch(error){return {error:await actionError(error)};}
}
export async function assessmentGenerateProfilesAction(cycleId:string,token?:string){
 const s=await getSession();try{const result=await perf.generateAssessmentProfiles(s,cycleId,token);if(result.applied){revalidatePath(`/performance/${cycleId}`);revalidateAssessmentWorkspace();}return {result};}catch(error){return {error:await actionError(error)};}
}

export async function assessmentPanelsBuildAction(cycleId:string,mode:'missing'|'topup',token?:string){
 const s=await getSession();try{const result=await perf.buildAssessmentPanels(s,cycleId,mode,token);if(result.applied){revalidatePath(`/performance/${cycleId}`);revalidateAssessmentWorkspace();}return {result};}catch(error){return {error:await actionError(error)};}
}
export async function assessmentPanelsImportAction(cycleId:string,csv:string,mode:'add'|'replace',token?:string){
 const s=await getSession();try{const result=await perf.importAssessmentPanels(s,cycleId,csv,mode,token);if(result.applied){revalidatePath(`/performance/${cycleId}`);revalidateAssessmentWorkspace();}return {result};}catch(error){return {error:await actionError(error)};}
}

export async function saveAssessmentKpiSettingAction(f:FormData){
 const s=await getSession();
 try{
  const id=z.uuid().parse(str(f,'reviewId')),view=await perf.getOnehrReview(s,id);if(!view)throw Error('Assessment not found.');
  const expected=num(f,'draftRevision');
  const revision=await perf.saveOnehrKpis(s,id,expected,readKpiSettingForm(f,view.reviewerEmploymentId));
  return {revision};
 }catch(e){return {error:await actionError(e)};}
}

export async function assessmentTalentInsightAction(reviewId:string,sessionId:string,generate=false){
 const s=await getSession();try{return await perf.getAssessmentTalentInsight(s,z.uuid().parse(reviewId),z.uuid().parse(sessionId),{generate:z.boolean().parse(generate)});}catch(error){return {error:await actionError(error)};}
}
export async function assessmentTalentPersonAction(reviewId:string,sessionId:string){
 const s=await getSession();try{return await perf.getAssessmentTalentPerson(s,z.uuid().parse(reviewId),z.uuid().parse(sessionId));}catch(error){return {error:await actionError(error)};}
}
export async function saveAssessmentTalentRemarkAction(f:FormData){
 const s=await getSession();try{return {revision:await perf.saveAssessmentTalentRemark(s,z.uuid().parse(str(f,'sessionId')),z.uuid().parse(str(f,'reviewId')),num(f,'draftRevision'),str(f,'remark'))};}catch(error){return {error:await actionError(error)};}
}

export async function previewCalibrationFitAction(sessionId:string,axis:'performance'|'potential',companyId:string|null){
 const s=await getSession();try{return await perf.previewAssessmentCalibrationFit(s,sessionId,axis,companyId);}catch(error){return {error:await actionError(error)};}
}
export async function applyCalibrationFitAction(sessionId:string,axis:'performance'|'potential',companyId:string|null,moves:unknown){
 const s=await getSession();try{const result=await perf.applyAssessmentCalibrationFit(s,sessionId,axis,companyId,moves);revalidateAssessmentWorkspace();revalidatePath(`/performance/assessment/calibration/${sessionId}`);return result;}catch(error){return {error:await actionError(error)};}
}

export async function keepCompetencyReflectionAction(reviewId:string,messageId:string){
 const ctx=await getSession();try{const result=await perf.keepCompetencyReflection(ctx,reviewId,messageId);revalidateAssessmentWorkspace();return result;}catch(error){return {error:await actionError(error)};}
}

export async function assessmentCalibrationPersonAction(sessionId:string,reviewId:string,axis:'performance'|'potential'|'both'){
 const s=await getSession();try{return await perf.getAssessmentCalibrationPerson(s,z.uuid().parse(sessionId),z.uuid().parse(reviewId),z.enum(['performance','potential','both']).parse(axis));}catch(error){return {error:await actionError(error)};}
}

export async function askPerformanceGuideAction(question:string,history:unknown=[]){
 const s=await getSession();try{return await perf.askPerformanceGuide(s,question,history);}catch(error){return {error:await actionError(error)};}
}
export async function performanceGuideReportAction(filters:unknown={}){
 const s=await getSession();try{return await perf.getPerformanceGuideReport(s,filters);}catch(error){return {error:await actionError(error)};}
}
export async function performanceGuideExportAction(filters:unknown={}){
 const s=await getSession();try{return {csv:await perf.exportPerformanceGuideReport(s,filters)};}catch(error){return {error:await actionError(error)};}
}

export async function performanceAdminAssistantAction(cycleId?:string){const s=await getSession();try{return await perf.getAssessmentAdminAssistant(s,cycleId);}catch(error){return {error:await actionError(error)};}}
export async function performanceAdminAskAction(cycleId:string|undefined,question:string,history:unknown=[]){const s=await getSession();try{return await perf.askAssessmentAdmin(s,cycleId,question,history);}catch(error){return {error:await actionError(error)};}}
export async function performanceAdminToolAction(cycleId:string|undefined,action:unknown){const s=await getSession();try{return await perf.runAssessmentAdminAction(s,cycleId,action);}catch(error){return {error:await actionError(error)};}}
