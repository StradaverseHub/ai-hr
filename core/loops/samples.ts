/** AI v2 Phase 2 P2-1 — Level 3 (Act and audit): the weekly sample HR reviews instead of every action.
 *
 * A Level 3 loop acts exactly as at Level 2 and tells the employee; undo and demotion are unchanged. What changes is HR's
 * view: at Level 2 every action shows in HR's feed on Today; at Level 3 HR reviews a sample of each week's actions, at
 * least 10% and at least 5 (all of them when there are fewer), chosen the same way for everyone who looks (ordered by a
 * hash of the action and the week, so it is reproducible and not chosen by the loop). The week runs Monday to Sunday,
 * Asia/Kuala_Lumpur. An administrator of the company records the review in their own name (migration 0963,
 * teras_loop_sample_review, append-only); a review covers the sample as it stood then. No model. */
import {and,desc,eq,gte,lt,sql} from 'drizzle-orm';
import {z} from 'zod';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {actorOf,appendEvent} from '../../db/events';
import {terasLoopAction,terasLoopSampleReview} from '../../db/teras-autonomy-schema';
import {isAdmin} from '../../lib/authz-model';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {addHrDays} from '../../lib/today/audience';
import {isLoopId,type LoopId} from './types';
import {sampleSize} from './autonomy';
import {levelIn,loopLevelsTx} from './levels';

export class LoopSampleRefused extends Error{constructor(readonly reason:'not_administrator'|'invalid'|'not_level_3'|'empty'|'not_found'){super('Loop sample refused: '+reason);this.name='LoopSampleRefused';}}

/** Monday of the HR week that holds `date` (yyyy-mm-dd). */
export function weekStartOf(date:string):string{
 const weekday=new Date(`${date}T00:00:00Z`).getUTCDay();// 0 Sunday … 6 Saturday
 return addHrDays(date,-((weekday+6)%7));
}
export const currentWeekStart=(now:Date=new Date())=>weekStartOf(todayInKualaLumpur(now));
const weekBounds=(weekStart:string)=>({from:new Date(`${weekStart}T00:00:00+08:00`),to:new Date(`${addHrDays(weekStart,7)}T00:00:00+08:00`)});

export type WeeklySample=Readonly<{weekStart:string;total:number;actionIds:readonly string[];reviewed:Readonly<{byUserId:string;at:Date;actionIds:readonly string[]}>|null}>;

/** The week's sample for one loop and company, under the caller's row-level security. */
export async function weeklySampleTx(tx:Tx,tenantId:string,workerId:LoopId,companyId:string,weekStart:string):Promise<WeeklySample>{
 const {from,to}=weekBounds(weekStart);
 const where=and(eq(terasLoopAction.tenantId,tenantId),eq(terasLoopAction.workerId,workerId),eq(terasLoopAction.companyId,companyId),
  eq(terasLoopAction.state,'applied'),gte(terasLoopAction.appliedAt,from),lt(terasLoopAction.appliedAt,to));
 const all=await tx.select({id:terasLoopAction.id}).from(terasLoopAction).where(where)
  .orderBy(sql`md5(${terasLoopAction.id}::text || ${weekStart})`,terasLoopAction.id);
 const size=sampleSize(all.length);
 const [review]=await tx.select({by:terasLoopSampleReview.reviewedByUserId,at:terasLoopSampleReview.reviewedAt,ids:terasLoopSampleReview.actionIds})
  .from(terasLoopSampleReview).where(and(eq(terasLoopSampleReview.tenantId,tenantId),eq(terasLoopSampleReview.workerId,workerId),
   eq(terasLoopSampleReview.companyId,companyId),eq(terasLoopSampleReview.weekStart,weekStart)))
  .orderBy(desc(terasLoopSampleReview.reviewedAt),desc(terasLoopSampleReview.id)).limit(1);
 return Object.freeze({weekStart,total:all.length,actionIds:Object.freeze(all.slice(0,size).map(row=>row.id)),
  reviewed:review?Object.freeze({byUserId:review.by,at:review.at,actionIds:Object.freeze([...review.ids])}):null});
}

const Input=z.object({workerId:z.string(),companyId:z.guid(),weekStart:z.string().regex(/^\d{4}-\d{2}-\d{2}$/)});

/** An administrator of the company records that they reviewed this week's sample. */
export async function reviewLoopSample(supplied:SessionContext,input:Readonly<{workerId:unknown;companyId:unknown;weekStart:unknown}>){
 const ctx:SessionContext={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(grant=>({...grant}))};
 if(!ctx.userId||ctx.agent||!isAdmin(ctx))throw new LoopSampleRefused('not_administrator');
 const parsed=Input.safeParse(input);
 if(!parsed.success||!isLoopId(parsed.data.workerId)||weekStartOf(parsed.data.weekStart)!==parsed.data.weekStart)throw new LoopSampleRefused('invalid');
 const workerId:LoopId=parsed.data.workerId,{companyId,weekStart}=parsed.data;
 return withTenant(ctx,async tx=>{
  const [admin]=await tx.execute(sql`select app.is_admin_for(c.id) as ok from public.company c where c.id=${companyId}::uuid and c.tenant_id=${ctx.tenantId}::uuid`) as unknown as {ok:boolean|null}[];
  if(!admin)throw new LoopSampleRefused('not_found');
  if(admin.ok!==true)throw new LoopSampleRefused('not_administrator');
  if(levelIn(await loopLevelsTx(tx,ctx.tenantId,workerId),companyId)!==3)throw new LoopSampleRefused('not_level_3');
  const sample=await weeklySampleTx(tx,ctx.tenantId,workerId,companyId,weekStart);
  if(!sample.actionIds.length)throw new LoopSampleRefused('empty');
  const [row]=await tx.insert(terasLoopSampleReview).values({tenantId:ctx.tenantId,workerId,companyId,weekStart,actionIds:[...sample.actionIds],reviewedByUserId:ctx.userId!}).returning();
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'teras-loop',aggregateId:companyId,eventType:'teras-loop.sample-reviewed',actor:actorOf(ctx),
   payload:{workerId,companyId,weekStart,sampled:sample.actionIds.length,total:sample.total}});
  return Object.freeze(row);
 });
}
