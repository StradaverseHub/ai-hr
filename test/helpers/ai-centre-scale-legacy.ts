/** VERBATIM REFERENCES of the owners this branch changed, as they stood at f7ee5177 (the deployed release), for the
 * equivalence test only (test/ai-centre-scale-equivalence.test.ts). Only imports and names differ: each is renamed legacy*
 * and imports the unchanged per-company helpers it called. Never imported by product code. */
import {and,desc,eq,gte,inArray,sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {appUser,company,employment,person} from '../../db/schema';
import {terasLoopAction,terasLoopActionUndo} from '../../db/teras-autonomy-schema';
import {isAdmin,isGroupAdmin} from '../../lib/authz-model';
import {isLoopId,type LoopId} from '../../core/loops/types';
import {SITE_EXIT_RECORDED,type AutonomyLevel} from '../../core/loops/autonomy-types';
import {PROMOTION_RULES,isCappedLoop,maxLevel,promotableTo,usesCondition,LOOP_AUTONOMY} from '../../core/loops/autonomy';
import {currentWeekStart,weeklySampleTx} from '../../core/loops/samples';
import {LOOP_IDS} from '../../core/loops/types';
import {latestLevelChangesTx,levelIn,loopLevelsTx} from '../../core/loops/levels';
import {LoopViewRefused} from '../../core/loops/views';
import type {AutonomyActionView,AutonomySample,LoopAutonomyDetail,LoopCompanyLevel,LoopLevelSummary} from '../../core/loops/autonomy-views';
import {acknowledgedBlocks} from '../../core/loops/grouped-dispositions';

const DAY_MS=86_400_000;
const RECENT=20;
const requireAdmin=(ctx:SessionContext)=>{if(!ctx.userId||ctx.agent||!isAdmin(ctx))throw new LoopViewRefused('not_administrator');};

async function namesTx(tx:Tx,userIds:readonly string[]){
 if(!userIds.length)return new Map<string,string|null>();
 const rows=await tx.select({id:appUser.id,name:person.fullName}).from(appUser).leftJoin(person,eq(person.id,appUser.personId)).where(inArray(appUser.id,[...userIds]));
 return new Map(rows.map(row=>[row.id,row.name??null]));
}

export async function legacyLoopAutonomyDetail(ctx:SessionContext,workerId:unknown,options:Readonly<{now?:Date}>={}):Promise<LoopAutonomyDetail>{
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
   state:terasLoopAction.state,reason:terasLoopAction.reason,facts:terasLoopAction.facts,employmentId:terasLoopAction.employmentId,undoUntil:terasLoopAction.undoUntil,peopleChangedAt:terasLoopAction.peopleChangedAt,
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
    ...(workerId==='loop_missed_clock_outs'&&row.admin===true&&typeof row.facts.date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(row.facts.date)?{reviewHref:`/attendance/individual/${row.facts.date}?emp=${encodeURIComponent(row.employmentId)}`} : {}),
    canUndo:workerId!=='loop_missed_clock_outs'&&row.state==='applied'&&!undo&&now.getTime()<=row.undoUntil.getTime()&&row.admin===true&&!own});
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

export async function legacyLoopLevelSummaries(ctx:SessionContext):Promise<Readonly<Record<LoopId,readonly LoopLevelSummary[]>>>{
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

/** Per loop, each company the viewer administers (by name) with the loop's level there; a company with no stored level
 * is at Prepare (core/loops/levels.ts levelIn). For the loops overview read (core/semantic-model/entities-loops.ts):
 * company names and levels only. */
export async function legacyLoopCompanyLevels(ctx:SessionContext):Promise<Readonly<Record<LoopId,readonly LoopCompanyLevel[]>>>{
 requireAdmin(ctx);
 return withTenant(ctx,async tx=>{
  const companies=Array.from(await tx.execute(sql`select c.id,c.legal_name from public.company c where c.tenant_id=${ctx.tenantId}::uuid and app.is_admin_for(c.id) order by c.legal_name,c.id`) as unknown as {id:string;legal_name:string}[]);
  const out={} as Record<LoopId,readonly LoopCompanyLevel[]>;
  for(const id of LOOP_IDS){
   const levels=await loopLevelsTx(tx,ctx.tenantId,id);
   out[id]=Object.freeze(companies.map(item=>Object.freeze({companyName:item.legal_name,level:levelIn(levels,item.id)})));
  }
  return Object.freeze(out);
 });
}

/** app/control-tower/exceptions/page.tsx at f7ee5177: one acknowledgedBlocks transaction per month, all at once. */
export async function legacyExceptionsAcknowledged(s:SessionContext,companies:readonly string[],periods:readonly string[]){
 return companies.length
  ? (await Promise.all(periods.map(payPeriod => acknowledgedBlocks(s, { companyIds: companies, payPeriod }).then(list => list.map(block => ({ ...block, payPeriod })))))).flat()
  : [];
}
