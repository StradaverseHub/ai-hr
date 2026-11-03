/** AI v2 Phase 2 P2-1 — a loop's level per company: read it, compute its promotion certificate, change it.
 *
 * Only a group administrator changes a level, under their own login (code here, and migration 0963 policies):
 *  - up one level at a time, only to a level the loop may reach (core/loops/autonomy.ts: the cap is code), and above
 *    Prepare only when every criterion of its certificate is met now, computed in the same transaction from the loop's
 *    own records. The limits are set with the promotion (most actions a night, the undo window, the condition);
 *  - down at any time, to any lower level.
 * Every change is recorded with the administrator's name: the level row, an append-only history row with the
 * certificate and limits, and an audit event. The loop itself only ever moves itself back down to Prepare
 * (demoteLoopLevelTx, called by core/loops/act.ts as the agent principal). No model is called. */
import {and,asc,count,desc,eq,gte,inArray,isNull,or,sql} from 'drizzle-orm';
import {z} from 'zod';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {actorOf,appendEvent} from '../../db/events';
import {terasLoopCase,terasLoopRun} from '../../db/teras-schema';
import {terasLoopAction,terasLoopActionUndo,terasLoopLevel,terasLoopLevelChange} from '../../db/teras-autonomy-schema';
import {isGroupAdmin} from '../../lib/authz-model';
import {isLoopId,type LoopId} from './types';
import {DEFAULT_LIMITS,isAutonomyLevel,type AutonomyLevel,type LoopCorrection,type LoopLimits} from './autonomy-types';
import {PROMOTION_RULES,certificate,levelAllowed,maxLevel,parseLimits,promotableTo,type Certificate} from './autonomy';

const DAY_MS=86_400_000;
export class LoopLevelRefused extends Error{
 constructor(readonly reason:'not_group_administrator'|'invalid'|'capped'|'no_actor'|'not_next_level'|'certificate'|'changed'|'unchanged'|'not_found'){super('Loop level refused: '+reason);this.name='LoopLevelRefused';}
}
const capture=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))});

export type LoopLevelRow=Readonly<{companyId:string;level:AutonomyLevel;limits:LoopLimits;version:number;changedBy:'administrator'|'automatic';changedByUserId:string|null;changedAt:Date}>;
const limitsOf=(row:{maxActionsPerNight:number;undoDays:3|7;actCondition:LoopLimits['condition']}):LoopLimits=>
 Object.freeze({maxActionsPerNight:row.maxActionsPerNight,undoDays:row.undoDays,condition:row.actCondition});
const toRow=(row:typeof terasLoopLevel.$inferSelect):LoopLevelRow=>Object.freeze({companyId:row.companyId,level:row.level,limits:limitsOf(row),version:row.version,
 changedBy:row.changedBy,changedByUserId:row.changedByUserId,changedAt:row.changedAt});

/** Every stored level of one loop in the tenant, by company. A company with no row is at Prepare. */
export async function loopLevelsTx(tx:Tx,tenantId:string,workerId:LoopId):Promise<Map<string,LoopLevelRow>>{
 const rows=await tx.select().from(terasLoopLevel).where(and(eq(terasLoopLevel.tenantId,tenantId),eq(terasLoopLevel.workerId,workerId)));
 return new Map(rows.map(row=>[row.companyId,toRow(row)]));
}
export const levelIn=(levels:ReadonlyMap<string,LoopLevelRow>,companyId:string):AutonomyLevel=>levels.get(companyId)?.level??1;

export type PromotionEvidence=Readonly<{windowDays:number;since:Date;currentLevel:AutonomyLevel;prepared:number;asPrepared:number;changed:number;
 ruleBroken:number;daysAtLevel:number;levelSince:Date|null}>;

/** What the certificate is computed from, read under the caller's row-level security, for one loop and company:
 *  - at Watch or Prepare: the cases it prepared in the window (cards a person acted on), and of those done, how many were
 *    completed as prepared and how many changed by the person. A case the loop completed itself is not evidence;
 *  - at Level 2 or above: the actions it applied in the window, and how many people undid or changed afterwards;
 *  - rule broken: runs that did not finish (a failed owner read) and actions the owner refused;
 *  - days at the level: since the latest change into the current level, or at Prepare with no change, since its first
 *    run for the company. */
export async function promotionEvidenceTx(tx:Tx,tenantId:string,workerId:LoopId,companyId:string,currentLevel:AutonomyLevel,now:Date):Promise<PromotionEvidence>{
 const since=new Date(now.getTime()-PROMOTION_RULES.windowDays*DAY_MS);
 const acted=sql`exists (select 1 from public.teras_loop_action a where a.case_id=${terasLoopCase.id} and a.state='applied')`;
 let prepared=0,asPrepared=0,changed=0;
 if(currentLevel<=1){
  const [opened]=await tx.select({n:count()}).from(terasLoopCase).where(and(eq(terasLoopCase.tenantId,tenantId),eq(terasLoopCase.workerId,workerId),
   eq(terasLoopCase.companyId,companyId),gte(terasLoopCase.openedAt,since),sql`not ${acted}`));
  const done=await tx.select({resolution:terasLoopCase.resolution,n:count()}).from(terasLoopCase).where(and(eq(terasLoopCase.tenantId,tenantId),
   eq(terasLoopCase.workerId,workerId),eq(terasLoopCase.companyId,companyId),eq(terasLoopCase.state,'closed'),eq(terasLoopCase.closeReason,'done'),
   gte(terasLoopCase.closedAt,since),sql`not ${acted}`)).groupBy(terasLoopCase.resolution);
  prepared=Number(opened?.n??0);
  asPrepared=Number(done.find(row=>row.resolution==='as_prepared')?.n??0);
  changed=Number(done.find(row=>row.resolution==='changed')?.n??0);
 }else{
  const applied=await tx.select({id:terasLoopAction.id,changedAt:terasLoopAction.peopleChangedAt,undone:terasLoopActionUndo.actionId}).from(terasLoopAction)
   .leftJoin(terasLoopActionUndo,eq(terasLoopActionUndo.actionId,terasLoopAction.id))
   .where(and(eq(terasLoopAction.tenantId,tenantId),eq(terasLoopAction.workerId,workerId),eq(terasLoopAction.companyId,companyId),
    eq(terasLoopAction.state,'applied'),gte(terasLoopAction.appliedAt,since)));
  prepared=applied.length;
  changed=applied.filter(row=>row.undone!==null||row.changedAt!==null).length;
  asPrepared=prepared-changed;
 }
 const [failedRuns]=await tx.select({n:count()}).from(terasLoopRun).where(and(eq(terasLoopRun.tenantId,tenantId),eq(terasLoopRun.workerId,workerId),
  eq(terasLoopRun.status,'failed'),gte(terasLoopRun.startedAt,since),or(eq(terasLoopRun.companyId,companyId),isNull(terasLoopRun.companyId))));
 const [refused]=await tx.select({n:count()}).from(terasLoopAction).where(and(eq(terasLoopAction.tenantId,tenantId),eq(terasLoopAction.workerId,workerId),
  eq(terasLoopAction.companyId,companyId),eq(terasLoopAction.state,'not_applied'),eq(terasLoopAction.reason,'owner_refused'),gte(terasLoopAction.createdAt,since)));
 const [change]=await tx.select({at:terasLoopLevelChange.changedAt}).from(terasLoopLevelChange).where(and(eq(terasLoopLevelChange.tenantId,tenantId),
  eq(terasLoopLevelChange.workerId,workerId),eq(terasLoopLevelChange.companyId,companyId),eq(terasLoopLevelChange.toLevel,currentLevel)))
  .orderBy(desc(terasLoopLevelChange.changedAt),desc(terasLoopLevelChange.id)).limit(1);
 let levelSince:Date|null=change?.at??null;
 if(!levelSince&&currentLevel===1){
  const [first]=await tx.select({at:terasLoopRun.startedAt}).from(terasLoopRun).where(and(eq(terasLoopRun.tenantId,tenantId),eq(terasLoopRun.workerId,workerId),
   eq(terasLoopRun.companyId,companyId),eq(terasLoopRun.status,'ran'))).orderBy(asc(terasLoopRun.startedAt)).limit(1);
  levelSince=first?.at??null;
 }
 const daysAtLevel=levelSince?Math.max(0,Math.floor((now.getTime()-levelSince.getTime())/DAY_MS)):0;
 return Object.freeze({windowDays:PROMOTION_RULES.windowDays,since,currentLevel,prepared,asPrepared,changed,ruleBroken:Number(failedRuns?.n??0)+Number(refused?.n??0),daysAtLevel,levelSince});
}

/** The certificate for the next level up from `currentLevel`, or null when there is no level above Prepare to earn. */
export function certificateFor(workerId:LoopId,evidence:PromotionEvidence):Certificate|null{
 const target=evidence.currentLevel+1;
 if(target<2||target>promotableTo(workerId))return null;
 return certificate(workerId,{targetLevel:target as 2|3,prepared:evidence.prepared,asPrepared:evidence.asPrepared,changed:evidence.changed,
  ruleBroken:evidence.ruleBroken,daysAtLevel:evidence.daysAtLevel});
}

const Input=z.object({workerId:z.string(),companyId:z.guid(),toLevel:z.number().int(),expectedLevel:z.number().int(),limits:z.unknown().optional()});

/** A group administrator moves a loop up one level (with a met certificate above Prepare) or down any number of levels,
 * for one company. `expectedLevel` is the level the page showed: a change since then is refused. */
export async function setLoopLevel(supplied:SessionContext,input:Readonly<{workerId:unknown;companyId:unknown;toLevel:unknown;expectedLevel:unknown;limits?:unknown}>,now:Date=new Date()){
 const ctx=capture(supplied);
 if(!ctx.userId||ctx.agent||!isGroupAdmin(ctx))throw new LoopLevelRefused('not_group_administrator');
 const parsed=Input.safeParse(input);
 if(!parsed.success||!isLoopId(parsed.data.workerId)||!isAutonomyLevel(parsed.data.toLevel)||!isAutonomyLevel(parsed.data.expectedLevel))throw new LoopLevelRefused('invalid');
 const workerId:LoopId=parsed.data.workerId,companyId=parsed.data.companyId,toLevel=parsed.data.toLevel,expectedLevel=parsed.data.expectedLevel;
 // The cap, in code, before anything is read: no input can raise a capped loop above Prepare.
 if(!levelAllowed(workerId,toLevel))throw new LoopLevelRefused(toLevel>maxLevel(workerId)?'capped':'no_actor');
 return withTenant(ctx,async tx=>{
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`teras-loop-level:${ctx.tenantId}:${workerId}:${companyId}`},0))`);
  const [admin]=await tx.execute(sql`select app.is_admin_for(c.id) as ok from public.company c where c.id=${companyId}::uuid and c.tenant_id=${ctx.tenantId}::uuid`) as unknown as {ok:boolean|null}[];
  if(!admin)throw new LoopLevelRefused('not_found');
  if(admin.ok!==true)throw new LoopLevelRefused('not_group_administrator');
  const where=and(eq(terasLoopLevel.tenantId,ctx.tenantId),eq(terasLoopLevel.workerId,workerId),eq(terasLoopLevel.companyId,companyId));
  const [before]=await tx.select().from(terasLoopLevel).where(where).limit(1).for('update');
  const current:AutonomyLevel=before?.level??1;
  if(current!==expectedLevel)throw new LoopLevelRefused('changed');
  if(toLevel===current)throw new LoopLevelRefused('unchanged');
  let limits:LoopLimits=before?limitsOf(before):DEFAULT_LIMITS,evidence:Record<string,unknown>={};
  if(toLevel>current){
   if(toLevel!==current+1)throw new LoopLevelRefused('not_next_level');
   if(toLevel>=2){
    const given=parseLimits(input.limits);
    if(!given)throw new LoopLevelRefused('invalid');
    limits=given;
    const facts=await promotionEvidenceTx(tx,ctx.tenantId,workerId,companyId,current,now);
    const cert=certificateFor(workerId,facts);
    if(!cert||!cert.met)throw new LoopLevelRefused('certificate');
    evidence={certificate:cert,windowDays:facts.windowDays,since:facts.since.toISOString(),levelSince:facts.levelSince?.toISOString()??null};
   }
  }
  const values={level:toLevel,maxActionsPerNight:limits.maxActionsPerNight,undoDays:limits.undoDays,actCondition:limits.condition,
   changedBy:'administrator' as const,changedByUserId:ctx.userId!,changedAt:now};
  const [row]=before
   ?await tx.update(terasLoopLevel).set(values).where(where).returning()
   :await tx.insert(terasLoopLevel).values({tenantId:ctx.tenantId,workerId,companyId,...values}).returning();
  if(!row)throw new LoopLevelRefused('not_group_administrator');
  const kind=toLevel>current?'promoted' as const:'moved_down' as const;
  await tx.insert(terasLoopLevelChange).values({tenantId:ctx.tenantId,workerId,companyId,fromLevel:current,toLevel,kind,changedBy:'administrator',
   changedByUserId:ctx.userId!,limits:{...limits},evidence,changedAt:now});
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'teras-loop',aggregateId:companyId,eventType:'teras-loop.level-changed',actor:actorOf(ctx),
   payload:{workerId,companyId,from:current,to:toLevel,kind,limits:{...limits},version:row.version}});
  return toRow(row);
 });
}

/** The loop moves itself back to Prepare for one company, as the agent principal, recording the corrections that
 * crossed the fixed demotion rule. A level already at or below Prepare is left alone (returns false). */
export async function demoteLoopLevelTx(tx:Tx,p:Readonly<{tenantId:string;workerId:LoopId;companyId:string;runId:string;now:Date;
 applied:number;corrected:number;corrections:readonly LoopCorrection[]}>):Promise<boolean>{
 const where=and(eq(terasLoopLevel.tenantId,p.tenantId),eq(terasLoopLevel.workerId,p.workerId),eq(terasLoopLevel.companyId,p.companyId));
 const [before]=await tx.select().from(terasLoopLevel).where(where).limit(1).for('update');
 if(!before||before.level<=1)return false;
 await tx.update(terasLoopLevel).set({level:1,changedBy:'automatic',changedByUserId:null,changedAt:p.now}).where(and(where,sql`${terasLoopLevel.level}>1`));
 await tx.insert(terasLoopLevelChange).values({tenantId:p.tenantId,workerId:p.workerId,companyId:p.companyId,fromLevel:before.level,toLevel:1,kind:'demoted_auto',
  changedBy:'automatic',changedByUserId:null,runId:p.runId,limits:{...limitsOf(before)},
  evidence:{applied:p.applied,corrected:p.corrected,share:p.applied>0?p.corrected/p.applied:null,corrections:p.corrections.slice(0,50).map(item=>({...item}))},changedAt:p.now});
 return true;
}

/** The latest history row of each company, for the pages. */
export async function latestLevelChangesTx(tx:Tx,tenantId:string,workerId:LoopId,companyIds:readonly string[]){
 if(!companyIds.length)return new Map<string,typeof terasLoopLevelChange.$inferSelect>();
 const rows=await tx.select().from(terasLoopLevelChange).where(and(eq(terasLoopLevelChange.tenantId,tenantId),eq(terasLoopLevelChange.workerId,workerId),
  inArray(terasLoopLevelChange.companyId,[...companyIds]))).orderBy(desc(terasLoopLevelChange.changedAt),desc(terasLoopLevelChange.id));
 const out=new Map<string,typeof terasLoopLevelChange.$inferSelect>();
 for(const row of rows)if(!out.has(row.companyId))out.set(row.companyId,row);
 return out;
}
