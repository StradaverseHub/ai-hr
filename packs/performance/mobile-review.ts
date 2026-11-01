/** Native approval presentation. The existing pack readers/writers remain the business owners. */
import {z} from 'zod';
import {eq} from 'drizzle-orm';
import {performanceReview,onehrReview,onehrCalibration} from '../../db/schema';
import {reviewForViewer,reviewGoals,peerFeedbackForReview,submitManagerReview,submitStageManager} from '../../core/performance';
import type {SessionContext,Tx} from '../../db/client';
import {action,block,textField,choiceField,numberField,boolField,type PreparedPackReview} from '../../lib/mobile-api/pack-form';
import type {PackAction,PackBlock,PackField,PackWorkspaceKind} from '../../lib/mobile-api/v2/pack-workspaces';
import {getOnehrReview,getOnehrReviewTx,getOnehrCalibration,getOnehrCalibrationTx,approveOnehrScorecardTx,submitAssessmentModerationTx,confirmOnehrPerformanceTx,submitOnehrCompetenciesTx,reviewOnehrPlanTx,saveOnehrCalibrationTx,lockOnehrCalibrationTx} from './onehr/service';
import {pmBands,potentialBands} from './onehr/model';
const str=(v:unknown)=>v==null?'':String(v);
export async function prepareMobilePerformanceReview(ctx:SessionContext,kind:Exclude<PackWorkspaceKind,'rewardReview'>,id:string,linkPath:string,tx?:Tx):Promise<PreparedPackReview|null>{
 if(kind==='calibration')return prepareCalibration(ctx,id,tx);
 const reviewId=kind==='careerPlan'?/^\/performance\/review\/([0-9a-f-]{36})$/i.exec(linkPath)?.[1]:id;
 if(!reviewId||!z.uuid().safeParse(reviewId).success)return null;
 if(tx){await tx.select({id:performanceReview.id}).from(performanceReview).where(eq(performanceReview.id,reviewId)).for('update');await tx.select({id:onehrReview.reviewId}).from(onehrReview).where(eq(onehrReview.reviewId,reviewId)).for('update');}
 const v=tx?await getOnehrReviewTx(tx,ctx,reviewId):await getOnehrReview(ctx,reviewId);if(!v)return kind==='performanceReview'?prepareLegacy(ctx,id,tx):null;if(v.self||v.finalized||!v.participating)return null;
 const blocks:PackBlock[]=[block('assessment',v.name,[['Cycle',v.cycle.name],['Grade',v.grade],['Status',v.cycle.status]])],actions:PackAction[]=[];
 if(kind==='careerPlan'){
  const p=v.plans.find(p=>p.id===id);if(!p||!v.planReviewer||!v.policy.modules.idp)return null;
  blocks.push(block('career',`Career plan · ${p.planYear}`,[['Aspiration',p.career.aspiration],['Current aspiration',p.career.aspirationNow],['Long-term aspiration',p.career.aspirationLong],['Strengths',p.career.strengths],['Preferences',p.career.preferences],['Mentor',p.career.mentor],['Mobility',p.career.mobility],['Mobility note',p.career.mobilityNote],['Status',p.status],['Manager feedback',p.managerComment],['Conversation',p.conversation],['Conversation date',p.conversationHeldOn],['Employee acknowledged',p.acknowledgedAt]]));
  for(const g of p.goals)blocks.push(block(g.id,g.area,[['Due',g.dueOn],['On the job',g.onJob],['Learning from others',g.fromOthers],['Formal learning',g.formalLearning],['Status',g.status],['Manager comment',g.managerComment],['Progress note',g.progressNote],...(g.checkins??[]).map(c=>[c.at,`${c.status}: ${c.note}`] as [string,unknown])]));
  const fields:PackField[]=[...(v.planRemarkWriter&&p.status!=='closed'?[textField('comment','Overall plan feedback (maximum 220 words)',p.managerComment)]:[]),textField('conversation','Career conversation',p.conversation),{key:'heldOn',label:'Conversation held on',kind:'date',value:p.conversationHeldOn,required:false}];
  actions.push(action('save','Save conversation','Record feedback and conversation details. The employee will need to acknowledge a changed conversation.',fields));
  if(p.status==='shared')actions.push(action('agree','Agree plan','Record the career conversation and close the shared plan as agreed.',fields));
  return {view:{title:`Career plan · ${v.name}`,revision:p.revision,blocks,documents:[],actions},run:async(tx,a,values)=>{await reviewOnehrPlanTx(tx,ctx,p.id,p.revision,v.planRemarkWriter&&p.status!=='closed'?str(values.comment):p.managerComment,str(values.conversation),a==='agree',reviewId,values.heldOn?str(values.heldOn):null);return a==='agree'?'closed':'shared';}};
 }
 if(v.policy.modules.pm){
  blocks.push(block('remarks','Performance remarks',[['Employee remark',v.selfRemark],['Manager remark',v.managerRemark],['Calculated performance band',v.calculatedPerformance],['Confirmed performance',v.managerPerformance],...v.reviewerRemarks.map(r=>[r.role,r.remark] as [string,unknown])]));
  for(const k of v.kpis)blocks.push(block(k.id,k.title,[['Description',k.description],['Weight',`${k.weightBp/100}%`],['Unit',k.unit],['Scoring mechanism',k.scoring.mechanism],...Object.entries(k.scoring).filter(([key])=>!['mechanism'].includes(key)).map(([key,value])=>[key,Array.isArray(value)?value.join(' / '):value] as [string,unknown]),['Setting',k.setting],['Employee actual',k.actual],['Employee note',k.note],['Moderated actual',k.approvedActual],['Moderation note',k.moderationRemark],['Setting remark',k.settingRemark],...(k.settingApprovals??[]).map(s=>['Setting decision',`${s.action} · ${s.at} · ${s.remark}`] as [string,unknown]),...(k.approvalChain??[]).map(s=>['Moderation decision',`${s.at??'Awaiting decision'} · ${s.actual??'—'} · ${s.remark}`] as [string,unknown])]));
  if(v.canApproveSettingIds.length){actions.push(action('setting-approve','Approve scorecard','Approve the KPIs currently assigned to your step.',[textField('remark','Scorecard remark')]));actions.push(action('setting-return','Return scorecard','Return the scorecard to the employee for changes.',[textField('remark','Changes required','',true)]));}
  const assigned=v.kpis.filter(k=>v.canModerateIds.includes(k.id)&&!k.locked);
  if(v.resultsSubmitted&&!v.managerPerformance&&assigned.length)actions.push(action('moderate','Submit KPI moderation','Record every KPI assigned to your current moderation step. Explain each adjusted result.',[...assigned.flatMap(k=>[numberField(`actual:${k.id}`,`${k.title} · moderated actual`,k.approvedActual??k.actual),textField(`note:${k.id}`,`${k.title} · reason for adjustment`,k.moderationRemark??'')]),textField('remark','Overall reviewer remark (maximum 220 words)',v.ownReviewerRemark)]));
  if(v.manager&&v.resultsSubmitted&&!v.managerPerformance&&v.calculatedPerformance)actions.push(action('confirm-performance',`Confirm ${v.calculatedPerformance}`,'Confirm the performance band calculated by the assessment owner from moderated KPIs.',[textField('remark','Overall reviewer remark (maximum 220 words)',v.ownReviewerRemark)]));
 }
 if(v.policy.modules.tm){
  blocks.push(block('competency-remarks','Competency remarks',[['Employee overall remark',v.competencySelfRemark],['Manager overall remark',v.competencyManagerRemark],...Object.entries(v.competencySelfSections??{}).map(([k,s])=>[`${k} · employee section remark`,s] as [string,unknown])]));
  for(const c of v.competencies)blocks.push(block(`competency:${c.id}`,`${c.principle} · ${c.skillTitle??''}`,[['Principle',c.principleDescription],['Statement',c.text],['Future competency',c.future],['Skill level',c.skillLevel],['Knowledge',c.knowledge],['Ability',c.ability],['Employee answer',c.self],['Employee explanation',c.selfRemark],['Manager answer',c.manager],['Manager explanation',c.managerRemark]]));
  if((v.manager||v.reviewer)&&v.competencyStatus==='submitted'&&v.competencies.length){
   const principles=[...new Set(v.competencies.map(c=>c.principle))];
   actions.push(action('competencies','Submit competency review','Review every assigned statement. Explain any answer that differs from the employee’s answer.',[...v.competencies.flatMap((c,i)=>[choiceField(`answer:${i}`,`${c.principle} · ${c.text}`,['yes','no'],c.manager??c.self),textField(`explain:${i}`,`${c.text} · explanation`,c.managerRemark)]),...principles.map((s,i)=>textField(`section:${i}`,`${s} · manager section remark`,(v.competencyManagerSections as Record<string,string>)[s]??'')),textField('remark','Overall competency remark (maximum 220 words)',v.competencyManagerRemark)]));
  }
 }
 if(v.policy.modules.evidence)for(const e of v.evidence)blocks.push(block(`evidence:${e.id}`,e.kind,[['Date',e.occurredOn],['Author',e.authorName],['Evidence',e.body],['Title',e.details.title],['Impact',e.details.impact],['Who',e.details.who],['Date precision',e.details.precision],['Metric',e.details.metricValue],['Metric unit',e.details.metricUnit],['Raised with employee',e.details.raisedWithSubject],...e.links.map(l=>['Related item',`${l.kind}: ${l.id}`] as [string,unknown]),...e.responses.map(r=>['Response',`${r.name} · ${r.stance} · ${r.at} · ${r.note}`] as [string,unknown]),...e.citations.map(c=>['Citation',`${c.name} · ${c.stance} · ${c.decisionKind} · ${c.at}`] as [string,unknown])]));
 const documents=v.policy.modules.evidence?v.attachments.map(a=>({id:a.id,name:a.fileName})):[];
 return {view:{title:`Assessment · ${v.name}`,revision:v.revision,blocks,documents,actions},run:async(tx,a,values)=>{
  if(a==='setting-approve'||a==='setting-return')await approveOnehrScorecardTx(tx,ctx,reviewId,v.revision,a==='setting-approve',str(values.remark));
  else if(a==='moderate')await submitAssessmentModerationTx(tx,ctx,reviewId,v.revision,v.kpis.filter(k=>v.canModerateIds.includes(k.id)&&!k.locked).map(k=>({id:k.id,actual:values[`actual:${k.id}`],note:str(values[`note:${k.id}`])})),str(values.remark));
  else if(a==='confirm-performance')await confirmOnehrPerformanceTx(tx,ctx,reviewId,v.revision,z.enum(pmBands).parse(v.calculatedPerformance),str(values.remark));
  else if(a==='competencies')await submitOnehrCompetenciesTx(tx,ctx,reviewId,v.revision,Object.fromEntries(v.competencies.map((c,i)=>[c.id,{answer:values[`answer:${i}`],remark:str(values[`explain:${i}`])}])),true,str(values.remark),Object.fromEntries([...new Set(v.competencies.map(c=>c.principle))].map((s,i)=>[s,str(values[`section:${i}`])])));
  else throw Error('Unrecognized assessment action');
  return 'recorded';
 }};
}
async function prepareCalibration(ctx:SessionContext,id:string,tx?:Tx):Promise<PreparedPackReview>{
 if(tx)await tx.select({id:onehrCalibration.id}).from(onehrCalibration).where(eq(onehrCalibration.id,id)).for('update');
 const v=(tx?await getOnehrCalibrationTx(tx,ctx,id,'both','all'):await getOnehrCalibration(ctx,id,'both','all')),actions:PackAction[]=[],blocks:PackBlock[]=[block('session','Calibration',[['Cycle',v.cycle.name],['Tier',v.session.tier],['Mode',v.session.mode],['Status',v.cycle.status],['Performance reference',v.reference?pmBands.map(b=>`${b}: ${v.reference![b]}%`).join(' · '):null],['Curve tolerance',v.curvePolicy.curveToleranceMode==='people'?v.curvePolicy.curveTolerancePeople:`${v.curvePolicy.curveTolerancePct}%`]])];
 for(const r of v.rows){
  blocks.push(block(r.entry.reviewId,r.name,[['Grade',r.grade],['Department',r.department],['Business group',r.businessGroup],['Manager performance',r.managerPerformance],['Manager potential',r.managerPotential],['Current performance',r.currentPerformance],['Current potential',r.currentPotential],['Performance note',r.entry.performanceNote],['Potential note',r.entry.potentialNote],...r.journey.map(j=>[j.tier,`Performance ${j.performance??'—'} / Potential ${j.potential??'—'}`] as [string,unknown])]));
  if(r.talent)blocks.push(block(`talent:${r.entry.reviewId}`,'Talent context',[['Performance improvement plan',r.talent.actions.pip],['PIP reason',r.talent.actions.pipReason],['Promotion',r.talent.actions.promotion],['Promotion reason',r.talent.actions.promotionReason],['Confirmed grade',r.talent.actions.confirmedGrade],['Confirmed title',r.talent.actions.confirmedTitle],['Special reward',r.talent.actions.specialReward],['Special reward reason',r.talent.actions.specialRewardReason],['Last promotion',r.talent.lastPromotionOn],['Standing eligibility',r.talent.standingReason],...r.talent.history.map(h=>[String(h.year),h.category] as [string,unknown]),...r.talent.actions.nominations.map(n=>['Promotion nomination',`${n.at} · ${n.grade} · ${n.title} · ${n.reason}`] as [string,unknown])]));
  for(const axis of ['performance','potential'] as const){const pm=axis==='performance';if(!v.isReviewer||!(pm?r.canWrite.pm:r.canWrite.pot))continue;
   actions.push(action(`save:${axis}:${r.entry.reviewId}`,`${r.name} · ${v.session.tier==='hod'?'Agree':'Save'} ${axis}`,`Record this person’s ${axis} decision at ${v.session.tier}. The department/final step locks the person’s decided axis.`,[choiceField('band',`${axis} band`,pm?pmBands:potentialBands,pm?r.entry.performance??r.currentPerformance:r.entry.potential??r.currentPotential),textField('reason',`${axis} note`,pm?r.entry.performanceNote:r.entry.potentialNote)]));
  }
 }
 for(const axis of ['performance','potential'] as const){const pm=axis==='performance';if(v.isReviewer&&v.canLockCohort&&(pm?v.canSubmit.pm:v.canSubmit.pot))actions.push(action(`lock:${axis}`,`Lock cohort ${axis}`,`Finalize the ${axis} decisions for this cohort at the ${v.session.tier} tier.`,[textField('reason','Distribution override reason (when permitted and required)')]));}
 return {view:{title:`Calibration · ${v.cycle.name}`,revision:v.session.revision,blocks,documents:[],actions},run:async(tx,a,values)=>{
  const [verb,axis,reviewId]=a.split(':');const parsed=z.enum(['performance','potential']).parse(axis);
  if(verb==='lock')await lockOnehrCalibrationTx(tx,ctx,id,v.session.revision,str(values.reason),parsed);
  else if(verb==='save')await saveOnehrCalibrationTx(tx,ctx,id,v.session.revision,{reviewId:z.uuid().parse(reviewId),axis:parsed,performance:parsed==='performance'?z.enum(pmBands).parse(values.band):null,potential:parsed==='potential'?z.enum(potentialBands).parse(values.band):null,performanceNote:parsed==='performance'?str(values.reason):'',potentialNote:parsed==='potential'?str(values.reason):''});
  else throw Error('Unrecognized calibration action');return 'recorded';
 }};
}
async function prepareLegacy(ctx:SessionContext,id:string,tx?:Tx):Promise<PreparedPackReview|null>{
 const v=await reviewForViewer(ctx,id,tx);if(!v||v.isSubject||!v.canManage||v.closed||!v.canManagerSubmit)return null;
 const [goals,peers]=await Promise.all([reviewGoals(ctx,id),peerFeedbackForReview(ctx,id)]);
 const blocks=[block('review',v.employee,[['Employee code',v.employeeCode],['Cycle',v.cycleName],['Period',`${v.periodStart} – ${v.periodEnd}`],['Status',v.status],['Goals summary',v.goalsSummary],['Employee rating',v.selfRating],['Employee comments',v.selfComments],['Mid-year employee rating',v.midSelfRating],['Mid-year employee comments',v.midSelfComments],['Mid-year manager rating',v.midManagerRating],['Mid-year manager comments',v.midManagerComments],['Manager rating',v.managerRating],['Manager comments',v.managerComments],['Overall rating',v.overallRating]])];
 for(const g of goals.linked)blocks.push(block(g.id,g.title,[['Description',g.description],['Metric',g.metric],['Target',g.target],['Weight',g.weight],['Progress',g.progress],['Status',g.status],['Due',g.dueOn]]));
 for(const f of peers.feedback)blocks.push(block(f.id,f.peer??'Anonymous peer feedback',[['Strengths',f.strengths],['Improvements',f.improvements]]));
 const rating=(key:string,label:string,value:number|null):PackField=>({key,label,kind:'choice',value:value==null?null:String(value),required:true,options:v.ratingScale.map(r=>({value:String(r.value),label:r.label}))});
 const fields=[rating('managerRating','Manager rating',v.managerRating),rating('overallRating','Overall rating',v.overallRating),textField('comments','Manager comments',v.managerComments??''),numberField('merit','Recommended merit percentage',v.recommendedMeritPct,false),numberField('bonus','Recommended bonus',v.recommendedBonus,false)];
 const actions=[action('manager-submit','Submit manager review','Finalize the manager review and any compensation recommendation for HR.',fields)];
 if(v.stages.some(s=>s.kind==='mid_year'))actions.push(action('mid-year','Submit mid-year manager review','Record the mid-year rating and comments; year-end remains separate.',[rating('managerRating','Mid-year manager rating',v.midManagerRating),textField('comments','Mid-year manager comments',v.midManagerComments??'')]));
 return {view:{title:`Performance review · ${v.employee}`,revision:0,blocks,documents:v.attachments.map(a=>({id:a.id,name:a.fileName})),actions},run:async(tx,a,values)=>{
  if(a==='mid-year')await submitStageManager(ctx,{reviewId:id,stage:'mid_year',managerRating:Number(values.managerRating),managerComments:str(values.comments)},tx);
  else if(a==='manager-submit')await submitManagerReview(ctx,{reviewId:id,managerRating:Number(values.managerRating),overallRating:Number(values.overallRating),managerComments:str(values.comments),recommendedMeritPct:values.merit==null?null:Number(values.merit),recommendedBonus:values.bonus==null?null:Number(values.bonus)},tx);
  else throw Error('Unrecognized review action');return 'submitted';
 }};
}
