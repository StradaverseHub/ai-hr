import {and,desc,eq,inArray,sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../../db/client';
import {onehrCycle,onehrReview,reviewCycle} from '../../../db/schema';
import {onehrEmployment} from './employment-projection';
import {getAssessmentProgress} from './progress-service';
/** Native PM progress, never scores, statements or a substitute module when PM is unavailable. */
export async function performanceAnalysisSourceTx(tx:Tx,ctx:SessionContext,companyIds:readonly string[],suppliedCycleId?:string){
 if(!companyIds.length)throw Error('Performance analysis requires a company scope.');
 const cycles=await tx.select({id:reviewCycle.id}).from(onehrCycle).innerJoin(reviewCycle,eq(reviewCycle.id,onehrCycle.cycleId))
  .where(and(suppliedCycleId?eq(reviewCycle.id,suppliedCycleId):undefined,sql`app.onehr_cycle_admin(${reviewCycle.id})`,
   sql`exists(select 1 from performance_onehr_review r where r.cycle_id=${reviewCycle.id} and r.company_id in (${sql.join(companyIds.map(id=>sql`${id}::uuid`),sql`, `)}))`))
  .orderBy(desc(reviewCycle.periodEnd),desc(reviewCycle.id)).limit(1);
 const cycleId=cycles[0]?.id;if(!cycleId)throw Error('An authorized assessment cycle is unavailable.');
 const progress=[];
 for(const companyId of companyIds){const source=await getAssessmentProgress(ctx,cycleId,{module:'pm',state:'all',companyId},tx);
  if(source.filter.module!=='pm')throw Error('PM progress is unavailable.');progress.push(...source.rows);}
 const ids=progress.map(row=>row.reviewId);
 const people=ids.length?await tx.select({reviewId:onehrReview.reviewId,personId:onehrEmployment.personId}).from(onehrReview)
  .innerJoin(onehrEmployment,eq(onehrEmployment.id,onehrReview.employmentId))
  .where(and(inArray(onehrReview.reviewId,ids),eq(onehrReview.cycleId,cycleId),inArray(onehrReview.companyId,[...companyIds]))):[];
 const byId=new Map(people.map(row=>[row.reviewId,row.personId]));
 return {selection:cycleId,rows:progress.map(row=>{const personId=byId.get(row.reviewId);if(!personId||!row.cells.pm)throw Error('Incomplete PM population.');
  return {personId,conditions:{review_completion:row.cells.pm.state==='done'}};})};
}
