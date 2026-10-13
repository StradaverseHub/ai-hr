import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { SessionContext } from '../../../db/client';
import { onehrCycle, onehrPlan, onehrReview, reviewCycle } from '../../../db/schema';
import { withPerformanceTenant } from '../../../core/module-gate';
import { todayInKualaLumpur } from '../../../lib/hr-date';
import { getOnehrReview } from './service';
import { personalFeedback, personalPlan, personalTrend } from './personal-record-model';
import { bandFor, scoreKPI, policySchema, type FrozenResult } from './model';

type Card={performanceReleasedAt:string|null;potentialReleasedAt:string|null;talentReleasedAt:string|null;feedbackReleasedAt:string|null;result:Pick<FrozenResult,'performance'|'potential'|'talent'|'anonymousFeedback'>};

/** Personal records have a separate, limited projection from the editable review workspace. */
export async function getAssessmentPersonalRecord(ctx:SessionContext,reviewId:string,recordId?:string,planYear?:number) {
 z.uuid().parse(reviewId);if(recordId&&recordId!=='current')z.uuid().parse(recordId);
 if(planYear!==undefined)z.number().int().min(1900).max(2200).parse(planYear);
 const data=await withPerformanceTenant(ctx,async tx=>{
  const [subject]=await tx.select({employmentId:onehrReview.employmentId}).from(onehrReview).where(and(eq(onehrReview.reviewId,reviewId),sql`exists(select 1 from employment e where e.id=${onehrReview.employmentId} and app.is_self_person(e.person_id))`));
  if(!subject)throw Error('This personal record is not assigned to you.');
  const rows=await tx.select({id:onehrReview.reviewId,name:reviewCycle.name,status:reviewCycle.status,periodEnd:reviewCycle.periodEnd,policy:onehrCycle.policy,card:sql<Card|null>`app.onehr_result_card(${onehrReview.reviewId})`})
   .from(onehrReview).innerJoin(reviewCycle,eq(reviewCycle.id,onehrReview.cycleId)).innerJoin(onehrCycle,eq(onehrCycle.cycleId,onehrReview.cycleId))
   .where(and(eq(onehrReview.employmentId,subject.employmentId),sql`${reviewCycle.status}<>'draft'`)).orderBy(desc(reviewCycle.periodEnd),asc(onehrReview.reviewId));
  const current=rows.find(r=>r.status!=='closed')??null;
  const yearOf=(r:typeof rows[number])=>Number(r.periodEnd.slice(0,4))+(policySchema.parse(r.policy).kind==='year_end'?1:0);
  const activeYear=current?yearOf(current):null;
  const plans=(await tx.select().from(onehrPlan).where(eq(onehrPlan.employmentId,subject.employmentId)).orderBy(desc(onehrPlan.planYear)))
   .map(p=>personalPlan(p,activeYear));
  const history=rows.filter(r=>r.status==='closed'||r.card?.performanceReleasedAt||r.card?.potentialReleasedAt||r.card?.talentReleasedAt).map(r=>({
   id:r.id,name:r.name,current:r.status!=='closed',
   performance:r.card?.performanceReleasedAt?r.card.result.performance:null,
   potential:r.card?.potentialReleasedAt?r.card.result.potential:null,
   talent:r.card?.talentReleasedAt?r.card.result.talent:null,
   report:personalFeedback(r.card?.feedbackReleasedAt?r.card.result.anonymousFeedback??null:null),
   plan:plans.find(p=>p.planYear===yearOf(r))??null,
  }));
  const selection=recordId??(current?'current':history[0]?.id);
  const selected=selection==='current'?null:history.find(r=>r.id===selection)??null;
  if(recordId&&!(recordId==='current'?current:selected))throw Error('This record is not available.');
  const defaultPlan=plans.find(p=>p.planYear===Number(todayInKualaLumpur().slice(0,4)))??plans[0]??null;
  const selectedPlan=planYear===undefined?defaultPlan:plans.find(p=>p.planYear===planYear)??null;
  if(planYear!==undefined&&!selectedPlan)throw Error('This development plan is not available.');
  return {currentId:current?.id??null,selection,selected,history,plans,selectedPlan,trend:personalTrend(history)};
 });
 const v=data.currentId?await getOnehrReview(ctx,data.currentId):null;
 const allLocked=!!v?.kpis.length&&v.kpis.every(k=>k.locked);
 const privateResults=v?.drafts.find(d=>d.kind==='results')?.payload;
 const privateCompetencies=v?.drafts.find(d=>d.kind==='competency_self')?.payload;
 const current=v?{
  id:v.reviewId,name:v.cycle.name,
  kpis:v.kpis.map(k=>({id:k.id,title:k.title,weightBp:k.weightBp,unit:k.unit,actual:privateResults?.kind==='results'?privateResults.lines.find(l=>l.id===k.id)?.actual??k.actual:k.actual,note:privateResults?.kind==='results'?privateResults.lines.find(l=>l.id===k.id)?.note??k.note:k.note,locked:k.locked,approvedActual:k.locked?k.approvedActual:null,managerRemark:k.locked?k.moderationRemark:'',band:k.locked&&k.approvedActual!==null?bandFor(scoreKPI(k.approvedActual,k.scoring),k.scoring.mechanism==='A'?v.policy.aBands:v.policy.bBands.find(b=>b.companyId===v.companyId)!.minima):null})),
  allLocked,performance:allLocked?v.managerPerformance:null,managerRemark:allLocked?v.managerRemark:'',reviewerRemarks:allLocked?v.reviewerRemarks:[],ownRemark:v.selfRemark,
  competencyStatus:v.competencyStatus,competencies:v.competencies.map(c=>({id:c.id,text:c.text,principle:c.principle,self:privateCompetencies?.kind==='competency_self'?privateCompetencies.answers[c.id]?.answer??c.self:c.self,manager:v.competencyStatus==='reviewed'?c.manager??c.self:null})),
  competencyOwnRemark:v.competencySelfRemark,competencyManagerRemark:v.competencyStatus==='reviewed'?v.competencyManagerRemark:'',
  report:personalFeedback(v.anonymousFeedback),plan:data.plans.find(p=>p.planYear===v.planYear)??null,
 }:null;
 return {...data,current};
}
