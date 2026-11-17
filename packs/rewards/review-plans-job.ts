/** One company per fenced worker transaction; a crash cannot duplicate a review or its checkpoint. */
import 'server-only';
import {sql} from 'drizzle-orm';
import type {BulkJobHandler} from '../../core/bulk-job-worker';
import {lockAccessConfigurationReadTx} from '../../core/access-configuration-lock';
import {appendEvent,actorOf} from '../../db/events';
import {policySchema} from './model';
import {setupReadTenant} from './setup-data';
import {REWARD_PLAN_REVIEWS_JOB} from './review-plans';
import type {RewardReviewPlanRow} from './review-plans-model';
type ReviewStep={companyId:string;year:number};
export const rewardPlanReviewsJobHandler:BulkJobHandler<ReviewStep>={
 kind:REWARD_PLAN_REVIEWS_JOB,mode:'per-step',chunkBudgetMs:100,maxStepsPerChunk:1,
 stepRef:step=>step.payload.companyId,phaseOf:()=>'companies',
 async prepare(ctx,job){const input=job.input as {year:number;companyIds:string[]};const rows=await setupReadTenant(ctx,async tx=>{const[r]=await tx.execute<{rows:RewardReviewPlanRow[]}>(sql`select app.reward_review_plan_selected(${input.year},${JSON.stringify(input.companyIds)}::jsonb) as rows`);return r.rows;});return{steps:rows.map((r,i)=>({kind:'company',rowNum:i+1,payload:{companyId:r.companyId,year:input.year}})),counters:{total:rows.length},plan:{year:input.year}};},
 async beginChunkTx(tx,ctx){await lockAccessConfigurationReadTx(tx,ctx.tenantId);},
 async applyStepTx(tx,ctx,_job,step){const p=step.payload;const [r]=await tx.execute<{rows:RewardReviewPlanRow[]}>(sql`select app.reward_review_plan_selected(${p.year},${JSON.stringify([p.companyId])}::jsonb) as rows`);const row=r.rows[0];if(!row)throw Error('Company is no longer available.');
  // The native owner rechecks current creation authority and all plan/own-pay conditions, never the stored admission.
  const [authority]=await tx.execute<{allowed:boolean}>(sql`select app.reward_setup_allowed(${p.companyId}::uuid,'manage') as allowed`);if(!authority?.allowed)throw Error('Group Rewards review creation authority is required.');
  if(row.reviewUnitId)return{result:{unitId:row.reviewUnitId,skipped:'already-reviewed'},counters:{skipped:1}};
  if(row.planType==='no_awards'||row.status!=='ready'||!row.planVersionId||!row.businessUnitId)return{result:{skipped:'not-ready'},counters:{skipped:1}};
  await tx.execute(sql`select app.reward_review_plan_activate(${p.year},${p.companyId}::uuid)`);
  let unitId:string;
  if(row.planType==='uploaded'){
   const [settings]=await tx.execute<{settings:Record<string,unknown>;snapshotDate:string}>(sql`select settings,settings->>'snapshotDate' as "snapshotDate" from reward_plan_year where tenant_id=app.current_tenant_id() and year=${p.year}`);
   const {snapshotDate:_snapshot,...policySettings}=settings.settings;const policy=policySchema.parse({...policySettings,year:p.year});
   const [created]=await tx.execute<{id:string}>(sql`select app.reward_create_uploaded_unit(${p.companyId}::uuid,${row.businessUnitId}::uuid,null::uuid,${p.year},${settings.snapshotDate}::date,${JSON.stringify(policy)}::jsonb,${'Rewards '+p.year}) as id`);unitId=created.id;
  }else{const [created]=await tx.execute<{id:string}>(sql`select app.reward_config_create_planned_unit(${row.planVersionId}::uuid,${p.companyId}::uuid,${row.businessUnitId}::uuid) as id`);unitId=created.id;}
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'reward-plan',aggregateId:row.planVersionId,eventType:'reward-plan.review-created',actor:actorOf(ctx),payload:{year:p.year,companyId:p.companyId,unitId,planType:row.planType}});
  return{result:{unitId},counters:{created:1}};
 },
 async finalize(_ctx,job){return{result:{year:(job.plan as {year:number}).year,created:job.counters.created??0,skipped:job.counters.skipped??0,failed:job.errors.length}};},
};
