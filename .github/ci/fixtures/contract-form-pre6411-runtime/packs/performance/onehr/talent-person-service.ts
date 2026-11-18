import {z} from 'zod';
import type {SessionContext} from '../../../db/client';
import {withPerformanceTenant} from '../../../core/module-gate';
import {getAssessmentTalentEvidenceTx} from './talent-insight-service';
import {getAssessmentTalentRemarkTx} from './service';
import {talentInsightCase,talentStrengths} from './talent-insight-model';
/** Only the selected person's presentation facts leave the service; anonymous ballot tallies stay here. */
export async function getAssessmentTalentPerson(ctx:SessionContext,reviewId:string,sessionId:string){
 z.uuid().parse(reviewId);z.uuid().parse(sessionId);
 return withPerformanceTenant(ctx,async tx=>{
  const evidence=await getAssessmentTalentEvidenceTx(tx,ctx,reviewId,sessionId),s=evidence.source;
  const strengths=talentStrengths(s.leadership,s.pot.minimum===1),label=({name,label}:{name:string;label:string})=>({name,label});
  const competencies=new Map<string,boolean>();for(const c of s.pot.competencies){const name=c.skillTitle??c.text;competencies.set(name,(competencies.get(name)??true)&&(c.manager??c.self)==='yes');}
  return {position:evidence.position,facts:talentInsightCase(s,evidence.position,evidence.remarks,evidence.fit).facts,
   potential:{valid:s.pot.valid,top:strengths.top.map(label),development:strengths.bottom.map(label),even:strengths.even,competencyStatus:s.pot.competencyStatus,competencies:[...competencies].map(([name,demonstrated])=>({name,demonstrated}))},
   plan:s.plan?{status:s.plan.status,goals:s.plan.goals.map(g=>({id:g.id,area:g.area,dueOn:g.dueOn,onJob:g.onJob,fromOthers:g.fromOthers,formalLearning:g.formalLearning})),aspiration:s.plan.career.aspiration,aspirationLong:s.plan.career.aspirationLong,mobility:s.plan.career.mobility,mobilityNote:s.plan.career.mobilityNote,managerRemark:s.plan.managerRemark}:null,
   remark:await getAssessmentTalentRemarkTx(tx,sessionId,reviewId)};
 });
}
