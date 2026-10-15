import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { SessionContext, Tx } from '../../../db/client';
import { actorOf, appendEvent } from '../../../db/events';
import { assessmentRatingRecord, onehrCycle, onehrReview, reviewCycle } from '../../../db/schema';
import { withPerformanceTenant } from '../../../core/module-gate';
import { ratingRecordSnapshotSchema } from './rating-record-model';
const filter=z.string().trim().max(300).transform(s=>s||undefined).optional();
const filtersSchema=z.object({company:filter,department:filter,businessGroup:filter});
export type RatingRecordFilters=z.input<typeof filtersSchema>;
async function cycleFor(tx:Tx,cycleId:string){
 z.uuid().parse(cycleId);
 const [cycle]=await tx.select({id:reviewCycle.id,name:reviewCycle.name,status:reviewCycle.status}).from(reviewCycle).innerJoin(onehrCycle,eq(onehrCycle.cycleId,reviewCycle.id)).where(and(eq(reviewCycle.id,cycleId),sql`app.onehr_cycle_admin(${reviewCycle.id})`));
 if(!cycle)throw Error('Performance administrator access is required.');return cycle;
}
function scope(cycleId:string,filters:ReturnType<typeof filtersSchema.parse>){
 return and(eq(onehrReview.cycleId,cycleId),filters.company?sql`${assessmentRatingRecord.snapshot}->>'company'=${filters.company}`:undefined,filters.department?sql`${assessmentRatingRecord.snapshot}->>'department'=${filters.department}`:undefined,filters.businessGroup?sql`${assessmentRatingRecord.snapshot}->>'businessGroup'=${filters.businessGroup}`:undefined);
}
function recordsQuery(tx:Tx,cycleId:string,filters:ReturnType<typeof filtersSchema.parse>){
 return tx.select({reviewId:assessmentRatingRecord.reviewId,snapshot:assessmentRatingRecord.snapshot,lastEvent:assessmentRatingRecord.lastEvent,recordedAt:assessmentRatingRecord.recordedAt,frozenAt:assessmentRatingRecord.frozenAt}).from(assessmentRatingRecord).innerJoin(onehrReview,eq(onehrReview.reviewId,assessmentRatingRecord.reviewId)).where(scope(cycleId,filters)).orderBy(sql`${assessmentRatingRecord.snapshot}->>'name'`,asc(assessmentRatingRecord.reviewId));
}
export async function getAssessmentRatingRecords(ctx:SessionContext,cycleId:string,raw:RatingRecordFilters={},page=1){
 const filters=filtersSchema.parse(raw);z.number().int().min(1).max(100000).parse(page);
 return withPerformanceTenant(ctx,async tx=>{
  const cycle=await cycleFor(tx,cycleId);
  const [count]=await tx.select({value:sql<number>`count(*)::integer`}).from(assessmentRatingRecord).innerJoin(onehrReview,eq(onehrReview.reviewId,assessmentRatingRecord.reviewId)).where(scope(cycleId,filters));
  const currentPage=Math.min(page,Math.max(1,Math.ceil(count.value/50)));
  const rows=await recordsQuery(tx,cycleId,filters).limit(50).offset((currentPage-1)*50);
  const options=await tx.selectDistinct({company:sql<string>`${assessmentRatingRecord.snapshot}->>'company'`,department:sql<string|null>`${assessmentRatingRecord.snapshot}->>'department'`,businessGroup:sql<string|null>`${assessmentRatingRecord.snapshot}->>'businessGroup'`}).from(assessmentRatingRecord).innerJoin(onehrReview,eq(onehrReview.reviewId,assessmentRatingRecord.reviewId)).where(eq(onehrReview.cycleId,cycleId));
  const [missing]=await tx.execute<{value:number}>(sql`select count(*)::integer value from performance_onehr_review r join employment e on e.id=r.employment_id and e.tenant_id=r.tenant_id join company co on co.id=e.company_id and co.tenant_id=e.tenant_id left join company bg on bg.id=co.parent_company_id and bg.tenant_id=e.tenant_id
   where r.cycle_id=${cycleId}::uuid and r.tenant_id=app.current_tenant_id() and app.onehr_admin(r.company_id) and app.onehr_admin(e.company_id) and not app.is_self_person(e.person_id)
   and not exists(select 1 from performance_assessment_rating_record rr where rr.review_id=r.review_id and rr.tenant_id=r.tenant_id)
   and (jsonb_array_length(r.kpis)>0 or jsonb_array_length(r.competencies)>0 or exists(select 1 from performance_onehr_panel p where p.review_id=r.review_id and p.archived_at is null and p.tenant_id=r.tenant_id))
   and (${filters.company??null}::text is null or co.legal_name=${filters.company??null}) and (${filters.businessGroup??null}::text is null or coalesce(bg.legal_name,co.legal_name)=${filters.businessGroup??null})
   and (${filters.department??null}::text is null or exists(select 1 from assignment a join department d on d.id=a.department_id and d.tenant_id=a.tenant_id where a.employment_id=e.id and a.superseded_at is null and a.valid_from<=(now() at time zone 'Asia/Kuala_Lumpur')::date and (a.valid_to is null or a.valid_to>(now() at time zone 'Asia/Kuala_Lumpur')::date) and d.name=${filters.department??null}))`);
  return {cycle,filters,page:currentPage,total:count.value,missing:missing?.value??0,options,rows:rows.map(r=>({...r,snapshot:ratingRecordSnapshotSchema.parse(r.snapshot)}))};
 });
}
export async function captureAssessmentRatingRecords(ctx:SessionContext,cycleId:string,raw:RatingRecordFilters={}){
 const f=filtersSchema.parse(raw);
 return withPerformanceTenant(ctx,async tx=>{
  await cycleFor(tx,cycleId);
  const [r]=await tx.execute<{captured:number}>(sql`select app.assessment_rating_records_capture(${cycleId}::uuid,${f.company??null}::text,${f.department??null}::text,${f.businessGroup??null}::text) as captured`);
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'onehr',aggregateId:cycleId,eventType:'onehr.rating-records-captured',actor:actorOf(ctx),payload:{captured:r.captured,filters:f}});
  return r.captured;
 });
}
export async function exportAssessmentRatingRecords(ctx:SessionContext,cycleId:string,raw:RatingRecordFilters={}){
 const filters=filtersSchema.parse(raw);
 return withPerformanceTenant(ctx,async tx=>{
  const cycle=await cycleFor(tx,cycleId),records=(await recordsQuery(tx,cycleId,filters)).map(r=>({...r,snapshot:ratingRecordSnapshotSchema.parse(r.snapshot)}));
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'onehr',aggregateId:cycleId,eventType:'onehr.rating-records-exported',actor:actorOf(ctx),payload:{people:records.length,filters}});
  return {cycle:cycle.name,records,scope:Object.entries(filters).filter(([,v])=>v).map(([k,v])=>`${k}: ${v}`).join('; ')||'All companies within your Performance administration scope',generatedAt:new Date()};
 });
}
