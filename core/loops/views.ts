/** AI v2 W8 — the read services behind AI Centre › Operations › Loops (no React here).
 *
 * loopsOverview: one row per loop: its switch and the tenant stop switch, its level (Prepare), its sponsor, its last
 * run, and over the last LOOP_WINDOW_DAYS the cards it prepared, how many people completed as prepared, and how many
 * they changed (the correction rate, only for a loop whose card proposes a value of its own). loopDetail adds the
 * per-company pauses the viewer may change, its recent runs and its recent cases.
 *
 * Group or HR administrators only (the page's requireAdmin, and checked again here). Every count is read under the
 * viewer's row-level security (migration 0960), so an HR administrator of one company sees that company's cards and
 * runs only. A rate whose denominator is zero is null, never 0. */
import {and,count,desc,eq,gte,inArray,sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {appUser,company,employment,person} from '../../db/schema';
import {terasLoopCase,terasLoopPause,terasLoopRun} from '../../db/teras-schema';
import {isAdmin,isGroupAdmin} from '../../lib/authz-model';
import {tenantStoppedTx,workerRunGateTx,workerSwitchStateTx} from '../agent-registry/controls';
import {registeredWorker} from '../agent-registry/workers';
import {LOOP_DEFINITIONS} from './definitions';
import {LOOP_IDS,isLoopId,type LoopCaseState,type LoopCloseReason,type LoopFacts,type LoopId,type LoopResolution,type LoopRunStatus} from './types';

export class LoopViewRefused extends Error{constructor(readonly reason:'not_administrator'|'not_found'){super('Loop view refused: '+reason);this.name='LoopViewRefused';}}
export const LOOP_WINDOW_DAYS=30;
const DAY_MS=86_400_000;

export type LoopRow=Readonly<{id:LoopId;level:'prepare';on:boolean;stopped:boolean;running:boolean;
 sponsor:Readonly<{userId:string;name:string|null}>|null;
 lastRun:Readonly<{at:Date;status:LoopRunStatus;capped:boolean}>|null;
 prepared:number;confirmed:number;changed:number;correctionRate:number|null;proposesValue:boolean;openNow:number;waitingNow:number;pausedCompanies:number}>;
export type LoopsOverview=Readonly<{rows:readonly LoopRow[];canSwitch:boolean;windowDays:number}>;

const requireAdmin=(ctx:SessionContext)=>{if(!ctx.userId||ctx.agent||!isAdmin(ctx))throw new LoopViewRefused('not_administrator');};

async function sponsorTx(tx:Tx,userId:string|null):Promise<LoopRow['sponsor']>{
 if(!userId)return null;
 // The sponsor's own name through their person record, where the viewer may read it; otherwise no name.
 const [row]=await tx.select({name:person.fullName}).from(appUser).leftJoin(person,eq(person.id,appUser.personId)).where(eq(appUser.id,userId)).limit(1);
 return Object.freeze({userId,name:row?.name??null});
}

async function rowTx(tx:Tx,ctx:SessionContext,id:LoopId,since:Date,stopped:boolean,paused:Map<string,number>):Promise<LoopRow>{
 const worker=registeredWorker(id)!,def=LOOP_DEFINITIONS[id];
 const state=await workerSwitchStateTx(tx,ctx,worker),gate=await workerRunGateTx(tx,ctx,id);
 const [control]=await tx.execute(sql`select changed_by_user_id from public.teras_worker_control where tenant_id=${ctx.tenantId}::uuid and worker_id=${id} and enabled`) as unknown as {changed_by_user_id:string|null}[];
 const [last]=await tx.select({at:terasLoopRun.startedAt,status:terasLoopRun.status,capped:terasLoopRun.capped}).from(terasLoopRun)
  .where(and(eq(terasLoopRun.tenantId,ctx.tenantId),eq(terasLoopRun.workerId,id))).orderBy(desc(terasLoopRun.startedAt),desc(terasLoopRun.id)).limit(1);
 const [prepared]=await tx.select({n:count()}).from(terasLoopCase).where(and(eq(terasLoopCase.tenantId,ctx.tenantId),eq(terasLoopCase.workerId,id),gte(terasLoopCase.openedAt,since)));
 const closed=await tx.select({resolution:terasLoopCase.resolution,n:count()}).from(terasLoopCase)
  .where(and(eq(terasLoopCase.tenantId,ctx.tenantId),eq(terasLoopCase.workerId,id),eq(terasLoopCase.state,'closed'),eq(terasLoopCase.closeReason,'done'),gte(terasLoopCase.closedAt,since)))
  .groupBy(terasLoopCase.resolution);
 const now=await tx.select({state:terasLoopCase.state,n:count()}).from(terasLoopCase)
  .where(and(eq(terasLoopCase.tenantId,ctx.tenantId),eq(terasLoopCase.workerId,id),inArray(terasLoopCase.state,['open','waiting']))).groupBy(terasLoopCase.state);
 const of=(resolution:LoopResolution)=>Number(closed.find(row=>row.resolution===resolution)?.n??0);
 const confirmed=of('as_prepared')+of('completed'),changed=of('changed');
 return Object.freeze({id,level:'prepare' as const,on:state.on,stopped,running:gate.run,sponsor:state.on?await sponsorTx(tx,control?.changed_by_user_id??null):null,
  lastRun:last?Object.freeze({at:last.at,status:last.status,capped:last.capped}):null,
  prepared:Number(prepared?.n??0),confirmed,changed,
  correctionRate:def.proposesValue&&of('as_prepared')+changed>0?changed/(of('as_prepared')+changed):null,proposesValue:def.proposesValue,
  openNow:Number(now.find(row=>row.state==='open')?.n??0),waitingNow:Number(now.find(row=>row.state==='waiting')?.n??0),pausedCompanies:paused.get(id)??0});
}

async function pausedCountsTx(tx:Tx,ctx:SessionContext){
 const rows=await tx.select({workerId:terasLoopPause.workerId,n:count()}).from(terasLoopPause)
  .where(and(eq(terasLoopPause.tenantId,ctx.tenantId),eq(terasLoopPause.paused,true),sql`app.is_admin_for(${terasLoopPause.companyId})`)).groupBy(terasLoopPause.workerId);
 return new Map(rows.map(row=>[row.workerId,Number(row.n)]));
}

export async function loopsOverview(ctx:SessionContext,options:Readonly<{now?:Date}>={}):Promise<LoopsOverview>{
 requireAdmin(ctx);
 const since=new Date((options.now??new Date()).getTime()-LOOP_WINDOW_DAYS*DAY_MS);
 return withTenant(ctx,async tx=>{
  const stopped=await tenantStoppedTx(tx,ctx.tenantId),paused=await pausedCountsTx(tx,ctx);
  const rows:LoopRow[]=[];
  for(const id of LOOP_IDS)rows.push(await rowTx(tx,ctx,id,since,stopped,paused));
  return Object.freeze({rows:Object.freeze(rows),canSwitch:isGroupAdmin(ctx),windowDays:LOOP_WINDOW_DAYS});
 });
}

/** Per loop, the names of the companies the viewer administers where it is paused (AI Centre's loops overview read,
 * core/semantic-model/entities-loops.ts). Administrators only; read under the viewer's row-level security and
 * app.is_admin_for, so an HR administrator of one company sees that company's pauses only. Company names only. */
export async function loopPausedCompanies(ctx:SessionContext):Promise<Readonly<Record<LoopId,readonly string[]>>>{
 requireAdmin(ctx);
 return withTenant(ctx,async tx=>{
  const rows=await tx.select({workerId:terasLoopPause.workerId,name:company.legalName}).from(terasLoopPause)
   .innerJoin(company,and(eq(company.id,terasLoopPause.companyId),eq(company.tenantId,terasLoopPause.tenantId)))
   .where(and(eq(terasLoopPause.tenantId,ctx.tenantId),eq(terasLoopPause.paused,true),sql`app.is_admin_for(${terasLoopPause.companyId})`))
   .orderBy(company.legalName,company.id);
  const out=Object.fromEntries(LOOP_IDS.map(id=>[id,[] as string[]])) as Record<LoopId,string[]>;
  for(const row of rows)if(isLoopId(row.workerId))out[row.workerId].push(row.name);
  return Object.freeze(Object.fromEntries(LOOP_IDS.map(id=>[id,Object.freeze(out[id])])) as Record<LoopId,readonly string[]>);
 });
}

export type LoopCompanyPause=Readonly<{companyId:string;companyName:string;paused:boolean}>;
export type LoopRunView=Readonly<{at:Date;companyName:string|null;status:LoopRunStatus;observed:number;opened:number;reopened:number;closed:number;openNow:number;waitingNow:number;capped:boolean}>;
export type LoopCaseView=Readonly<{id:string;openedAt:Date;closedAt:Date|null;personName:string|null;companyName:string|null;state:LoopCaseState;
 closeReason:LoopCloseReason|null;resolution:LoopResolution|null;reopenCount:number;facts:LoopFacts}>;
export type LoopDetail=Readonly<{row:LoopRow;canSwitch:boolean;windowDays:number;companies:readonly LoopCompanyPause[];runs:readonly LoopRunView[];cases:readonly LoopCaseView[]}>;
const RECENT=20;

export async function loopDetail(ctx:SessionContext,workerId:unknown,options:Readonly<{now?:Date}>={}):Promise<LoopDetail>{
 requireAdmin(ctx);
 if(!isLoopId(workerId))throw new LoopViewRefused('not_found');
 const since=new Date((options.now??new Date()).getTime()-LOOP_WINDOW_DAYS*DAY_MS);
 return withTenant(ctx,async tx=>{
  const stopped=await tenantStoppedTx(tx,ctx.tenantId),paused=await pausedCountsTx(tx,ctx);
  const row=await rowTx(tx,ctx,workerId,since,stopped,paused);
  // The companies the viewer administers, each with this loop's pause.
  const companies=await tx.execute(sql`select c.id,c.legal_name,coalesce(p.paused,false) as paused from public.company c
   left join public.teras_loop_pause p on p.tenant_id=c.tenant_id and p.company_id=c.id and p.worker_id=${workerId}
   where c.tenant_id=${ctx.tenantId}::uuid and app.is_admin_for(c.id) order by c.legal_name,c.id`) as unknown as {id:string;legal_name:string;paused:boolean}[];
  const runs=await tx.select({at:terasLoopRun.startedAt,companyName:company.legalName,status:terasLoopRun.status,observed:terasLoopRun.observed,opened:terasLoopRun.opened,
   reopened:terasLoopRun.reopened,closed:terasLoopRun.closed,openNow:terasLoopRun.openNow,waitingNow:terasLoopRun.waitingNow,capped:terasLoopRun.capped})
   .from(terasLoopRun).leftJoin(company,eq(company.id,terasLoopRun.companyId))
   .where(and(eq(terasLoopRun.tenantId,ctx.tenantId),eq(terasLoopRun.workerId,workerId))).orderBy(desc(terasLoopRun.startedAt),desc(terasLoopRun.id)).limit(RECENT);
  const cases=await tx.select({id:terasLoopCase.id,openedAt:terasLoopCase.openedAt,closedAt:terasLoopCase.closedAt,personName:person.fullName,companyName:company.legalName,
   state:terasLoopCase.state,closeReason:terasLoopCase.closeReason,resolution:terasLoopCase.resolution,reopenCount:terasLoopCase.reopenCount,facts:terasLoopCase.facts})
   .from(terasLoopCase).leftJoin(employment,eq(employment.id,terasLoopCase.employmentId)).leftJoin(person,eq(person.id,employment.personId))
   .leftJoin(company,eq(company.id,terasLoopCase.companyId))
   .where(and(eq(terasLoopCase.tenantId,ctx.tenantId),eq(terasLoopCase.workerId,workerId))).orderBy(desc(terasLoopCase.checkedAt),desc(terasLoopCase.id)).limit(RECENT);
  return Object.freeze({row,canSwitch:isGroupAdmin(ctx),windowDays:LOOP_WINDOW_DAYS,
   companies:Object.freeze(Array.from(companies).map(item=>Object.freeze({companyId:item.id,companyName:item.legal_name,paused:item.paused===true}))),
   runs:Object.freeze(runs.map(item=>Object.freeze({...item,companyName:item.companyName??null}))),
   cases:Object.freeze(cases.map(item=>Object.freeze({...item,personName:item.personName??null,companyName:item.companyName??null})))});
 });
}
