/** AI v2 Phase 2 P2-1 — the read services behind a loop's levels, actions and promotion (no React here).
 *
 * loopAutonomyDetail: for one loop, its ceiling, the level and limits in each company the viewer administers (with who
 * chose the condition, and when), its recent automatic actions with their outcome and whether the viewer may undo each,
 * its action figures for the window, and at Level 3 each company's weekly sample for HR to review.
 * loopPromotion: for one loop and company, the certificate for the next level (computed from the loop's own records),
 * a sample of recent cases with their outcomes, and the limits.
 * loopLevelSummaries: for the Loops overview, how many of the viewer's companies stand at each level, per loop.
 * Group or HR administrators only (the pages' requireAdmin, checked again here); every read runs under the viewer's
 * row-level security (migrations 0960 and 0963). Only a group administrator may change a level (canChange). */
import {and,desc,eq,gte,inArray,sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {appUser,company,employment,person} from '../../db/schema';
import {terasLoopCase} from '../../db/teras-schema';
import {terasLoopAction,terasLoopActionUndo} from '../../db/teras-autonomy-schema';
import {isAdmin,isGroupAdmin} from '../../lib/authz-model';
import {isLoopId,type LoopCaseState,type LoopCloseReason,type LoopFacts,type LoopId,type LoopResolution} from './types';
import {DEFAULT_LIMITS,SITE_EXIT_RECORDED,type AutonomyLevel,type LevelChangeKind,type LoopActionFacts,type LoopActionReason,type LoopActionState,type LoopLimits,type UndoneBy} from './autonomy-types';
import {PROMOTION_RULES,isCappedLoop,maxLevel,promotableTo,usesCondition,LOOP_AUTONOMY,type Certificate} from './autonomy';
import {currentWeekStart,weeklySampleTx} from './samples';
import {LOOP_IDS} from './types';
import {certificateFor,latestLevelChangesTx,levelIn,loopLevelsTx,promotionEvidenceTx,type PromotionEvidence} from './levels';
import {LoopViewRefused} from './views';

const DAY_MS=86_400_000;
const RECENT=20,SAMPLE=10;
const requireAdmin=(ctx:SessionContext)=>{if(!ctx.userId||ctx.agent||!isAdmin(ctx))throw new LoopViewRefused('not_administrator');};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AutonomyCompany=Readonly<{companyId:string;companyName:string;level:AutonomyLevel;limits:LoopLimits|null;
 changedAt:Date|null;changedBy:'administrator'|'automatic'|null;changedByName:string|null;lastChange:LevelChangeKind|null;
 conditionSetByName:string|null;conditionSetAt:Date|null}>;
export type AutonomySample=Readonly<{companyId:string;companyName:string;weekStart:string;total:number;actions:readonly AutonomyActionView[];
 reviewed:Readonly<{byName:string|null;at:Date;covered:number}>|null;canReview:boolean}>;
export type AutonomyActionView=Readonly<{id:string;at:Date;personName:string|null;companyName:string|null;state:LoopActionState;reason:LoopActionReason|null;
 facts:LoopActionFacts;undoUntil:Date;undo:Readonly<{by:UndoneBy;at:Date}>|null;peopleChanged:boolean;canUndo:boolean}>;
export type AutonomyFigures=Readonly<{applied:number;corrected:number;undoneByEmployee:number;correctedShare:number|null}>;
export type LoopAutonomyDetail=Readonly<{workerId:LoopId;maxLevel:AutonomyLevel;promotableTo:AutonomyLevel;capped:boolean;hasActor:boolean;canChange:boolean;
 usesCondition:boolean;siteExitRecorded:boolean;windowDays:number;companies:readonly AutonomyCompany[];actions:readonly AutonomyActionView[];figures:AutonomyFigures;
 samples:readonly AutonomySample[]}>;

async function namesTx(tx:Tx,userIds:readonly string[]){
 if(!userIds.length)return new Map<string,string|null>();
 const rows=await tx.select({id:appUser.id,name:person.fullName}).from(appUser).leftJoin(person,eq(person.id,appUser.personId)).where(inArray(appUser.id,[...userIds]));
 return new Map(rows.map(row=>[row.id,row.name??null]));
}

export async function loopAutonomyDetail(ctx:SessionContext,workerId:unknown,options:Readonly<{now?:Date}>={}):Promise<LoopAutonomyDetail>{
 requireAdmin(ctx);
 if(!isLoopId(workerId))throw new LoopViewRefused('not_found');
 const now=options.now??new Date(),since=new Date(now.getTime()-PROMOTION_RULES.windowDays*DAY_MS);
 return withTenant(ctx,async tx=>{
  const companies=Array.from(await tx.execute(sql`select c.id,c.legal_name from public.company c where c.tenant_id=${ctx.tenantId}::uuid and app.is_admin_for(c.id)
   order by c.legal_name,c.id`) as unknown as {id:string;legal_name:string}[]);
  const levels=await loopLevelsTx(tx,ctx.tenantId,workerId);
  const changes=await latestLevelChangesTx(tx,ctx.tenantId,workerId,companies.map(item=>item.id));
  const names=await namesTx(tx,[...new Set([...levels.values()].flatMap(row=>[row.changedByUserId,row.conditionSetByUserId].filter((id):id is string=>!!id)))]);
  const select=()=>tx.select({id:terasLoopAction.id,at:terasLoopAction.createdAt,personName:person.fullName,personId:employment.personId,companyName:company.legalName,
   state:terasLoopAction.state,reason:terasLoopAction.reason,facts:terasLoopAction.facts,undoUntil:terasLoopAction.undoUntil,peopleChangedAt:terasLoopAction.peopleChangedAt,
   undoneBy:terasLoopActionUndo.undoneBy,undoneAt:terasLoopActionUndo.undoneAt,admin:sql<boolean>`app.can_admin_employment(${terasLoopAction.employmentId})`})
   .from(terasLoopAction).leftJoin(terasLoopActionUndo,eq(terasLoopActionUndo.actionId,terasLoopAction.id))
   .leftJoin(employment,eq(employment.id,terasLoopAction.employmentId)).leftJoin(person,eq(person.id,employment.personId))
   .leftJoin(company,eq(company.id,terasLoopAction.companyId));
  const rows=await select().where(and(eq(terasLoopAction.tenantId,ctx.tenantId),eq(terasLoopAction.workerId,workerId))).orderBy(desc(terasLoopAction.createdAt),desc(terasLoopAction.id)).limit(RECENT);
  const applied=await tx.select({undoneBy:terasLoopActionUndo.undoneBy,changedAt:terasLoopAction.peopleChangedAt}).from(terasLoopAction)
   .leftJoin(terasLoopActionUndo,eq(terasLoopActionUndo.actionId,terasLoopAction.id))
   .where(and(eq(terasLoopAction.tenantId,ctx.tenantId),eq(terasLoopAction.workerId,workerId),eq(terasLoopAction.state,'applied'),gte(terasLoopAction.appliedAt,since)));
  const corrected=applied.filter(row=>row.undoneBy!==null||row.changedAt!==null).length;
  const view=(row:(typeof rows)[number]):AutonomyActionView=>{
   const own=!!ctx.personId&&row.personId===ctx.personId;
   const undo=row.undoneBy&&row.undoneAt?Object.freeze({by:row.undoneBy,at:row.undoneAt}):null;
   return Object.freeze({id:row.id,at:row.at,personName:row.personName??null,companyName:row.companyName??null,state:row.state,reason:row.reason??null,facts:row.facts,
    undoUntil:row.undoUntil,undo,peopleChanged:row.peopleChangedAt!==null,
    canUndo:row.state==='applied'&&!undo&&now.getTime()<=row.undoUntil.getTime()&&row.admin===true&&!own});
  };
  // Level 3: each company's weekly sample, for HR to review instead of every action.
  const weekStart=currentWeekStart(now),samples:AutonomySample[]=[];
  for(const item of companies.filter(entry=>levelIn(levels,entry.id)===3)){
   const sample=await weeklySampleTx(tx,ctx.tenantId,workerId,item.id,weekStart);
   const sampled=sample.actionIds.length?await select().where(and(eq(terasLoopAction.tenantId,ctx.tenantId),inArray(terasLoopAction.id,[...sample.actionIds]))):[];
   const order=new Map(sample.actionIds.map((id,index)=>[id,index]));
   const reviewer=sample.reviewed?(await namesTx(tx,[sample.reviewed.byUserId])).get(sample.reviewed.byUserId)??null:null;
   samples.push(Object.freeze({companyId:item.id,companyName:item.legal_name,weekStart,total:sample.total,
    actions:Object.freeze(sampled.sort((a,b)=>(order.get(a.id)??0)-(order.get(b.id)??0)).map(view)),
    reviewed:sample.reviewed?Object.freeze({byName:reviewer,at:sample.reviewed.at,covered:sample.reviewed.actionIds.length}):null,canReview:sample.actionIds.length>0}));
  }
  return Object.freeze({workerId,maxLevel:maxLevel(workerId),promotableTo:promotableTo(workerId),capped:isCappedLoop(workerId),hasActor:LOOP_AUTONOMY[workerId].actor,
   canChange:isGroupAdmin(ctx),usesCondition:usesCondition(workerId),siteExitRecorded:SITE_EXIT_RECORDED,windowDays:PROMOTION_RULES.windowDays,
   companies:Object.freeze(companies.map(item=>{
    const row=levels.get(item.id),change=changes.get(item.id);
    return Object.freeze({companyId:item.id,companyName:item.legal_name,level:levelIn(levels,item.id),limits:row?.limits??null,changedAt:row?.changedAt??null,
     changedBy:row?.changedBy??null,changedByName:row?.changedByUserId?names.get(row.changedByUserId)??null:null,lastChange:change?.kind??null,
     conditionSetByName:row?.conditionSetByUserId?names.get(row.conditionSetByUserId)??null:null,conditionSetAt:row?.conditionSetAt??null});
   })),
   actions:Object.freeze(rows.map(view)),samples:Object.freeze(samples),
   figures:Object.freeze({applied:applied.length,corrected,undoneByEmployee:applied.filter(row=>row.undoneBy==='employee').length,
    correctedShare:applied.length>0?corrected/applied.length:null})});
 });
}

export type PromotionSample=Readonly<{id:string;at:Date;personName:string|null;state:LoopCaseState;closeReason:LoopCloseReason|null;resolution:LoopResolution|null;facts:LoopFacts}>;
export type LoopPromotionView=Readonly<{workerId:LoopId;companyId:string;companyName:string;level:AutonomyLevel;targetLevel:AutonomyLevel|null;maxLevel:AutonomyLevel;
 capped:boolean;hasActor:boolean;canChange:boolean;usesCondition:boolean;siteExitRecorded:boolean;certificate:Certificate|null;evidence:PromotionEvidence;
 sample:readonly PromotionSample[];limits:LoopLimits;limitsStored:boolean;version:number|null;conditionSetByName:string|null;conditionSetAt:Date|null}>;

/** One loop in one company the viewer administers, with the certificate for its next level. */
export async function loopPromotion(ctx:SessionContext,workerId:unknown,companyId:unknown,options:Readonly<{now?:Date}>={}):Promise<LoopPromotionView>{
 requireAdmin(ctx);
 if(!isLoopId(workerId)||typeof companyId!=='string'||!UUID.test(companyId))throw new LoopViewRefused('not_found');
 const now=options.now??new Date();
 return withTenant(ctx,async tx=>{
  const [found]=await tx.execute(sql`select c.id,c.legal_name from public.company c where c.id=${companyId}::uuid and c.tenant_id=${ctx.tenantId}::uuid
   and app.is_admin_for(c.id)`) as unknown as {id:string;legal_name:string}[];
  if(!found)throw new LoopViewRefused('not_found');
  const levels=await loopLevelsTx(tx,ctx.tenantId,workerId),level=levelIn(levels,companyId);
  const evidence=await promotionEvidenceTx(tx,ctx.tenantId,workerId,companyId,level,now);
  const ceiling=promotableTo(workerId);
  const targetLevel=level<ceiling?(level+1) as AutonomyLevel:null;
  const sample=await tx.select({id:terasLoopCase.id,at:terasLoopCase.checkedAt,personName:person.fullName,state:terasLoopCase.state,closeReason:terasLoopCase.closeReason,
   resolution:terasLoopCase.resolution,facts:terasLoopCase.facts}).from(terasLoopCase)
   .leftJoin(employment,eq(employment.id,terasLoopCase.employmentId)).leftJoin(person,eq(person.id,employment.personId))
   .where(and(eq(terasLoopCase.tenantId,ctx.tenantId),eq(terasLoopCase.workerId,workerId),eq(terasLoopCase.companyId,companyId)))
   .orderBy(desc(terasLoopCase.checkedAt),desc(terasLoopCase.id)).limit(SAMPLE);
  const stored=levels.get(companyId);
  const chooser=stored?.conditionSetByUserId?(await namesTx(tx,[stored.conditionSetByUserId])).get(stored.conditionSetByUserId)??null:null;
  return Object.freeze({workerId,companyId,companyName:found.legal_name,level,targetLevel,maxLevel:maxLevel(workerId),capped:isCappedLoop(workerId),
   hasActor:LOOP_AUTONOMY[workerId].actor,canChange:isGroupAdmin(ctx),usesCondition:usesCondition(workerId),siteExitRecorded:SITE_EXIT_RECORDED,
   certificate:targetLevel!==null&&targetLevel>=2?certificateFor(workerId,evidence):null,evidence,
   sample:Object.freeze(sample.map(row=>Object.freeze({...row,personName:row.personName??null}))),limits:stored?.limits??DEFAULT_LIMITS,
   limitsStored:!!stored&&stored.level>=2,version:stored?.version??null,conditionSetByName:chooser,conditionSetAt:stored?.conditionSetAt??null});
 });
}

export type LoopLevelSummary=Readonly<{level:AutonomyLevel;count:number}>;
/** Per loop, how many of the companies the viewer administers stand at each level, highest first. */
export async function loopLevelSummaries(ctx:SessionContext):Promise<Readonly<Record<LoopId,readonly LoopLevelSummary[]>>>{
 requireAdmin(ctx);
 return withTenant(ctx,async tx=>{
  const companies=Array.from(await tx.execute(sql`select c.id from public.company c where c.tenant_id=${ctx.tenantId}::uuid and app.is_admin_for(c.id)`) as unknown as {id:string}[]);
  const out={} as Record<LoopId,readonly LoopLevelSummary[]>;
  for(const id of LOOP_IDS){
   const levels=await loopLevelsTx(tx,ctx.tenantId,id),counts=new Map<AutonomyLevel,number>();
   for(const item of companies){const level=levelIn(levels,item.id);counts.set(level,(counts.get(level)??0)+1);}
   out[id]=Object.freeze([...counts].sort((a,b)=>b[0]-a[0]).map(([level,count])=>Object.freeze({level,count})));
  }
  return Object.freeze(out);
 });
}
