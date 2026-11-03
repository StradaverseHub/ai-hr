/** AI v2 W8 — the loop runner: one run of one loop for one tenant, at the Prepare level.
 *
 * Every run, in order:
 *  1. Gate, as the tenant's agent principal (core/agent-principal.ts: no login, no grant, no model spend): the loop is
 *     registered, its own switch is on (teras_worker_control, off by default), the tenant-wide stop switch is off and
 *     its module is in use. A switched-off or stopped loop does not run and records nothing.
 *  2. Sponsor: the group administrator who switched the loop on answers for it. Their CURRENT authority is re-read from
 *     the database (app.principal, app.login_blocked, app.principal_snapshot_current), never from a cached session. A
 *     sponsor who lost administrator access, was blocked or archived stops the loop; the run records that and nothing
 *     else. The scope is every company the sponsor administers now, minus the companies where the loop is paused.
 *  3. Detect, diagnose and verify through the native owners under the sponsor's authority (core/loops/<loop>.ts):
 *     row-level security applies to every read, so a loop never sees more than its sponsor could, and the agent
 *     principal itself gains no read. No model is called.
 *  4. Prepare, as the agent principal, in one transaction serialised per tenant and loop: the gate and the sponsor's
 *     switch-on are checked again (a switch changed since step 1 discards the run), then each observation opens,
 *     updates, closes or reopens its case. The database refuses a case write whenever the loop is off, stopped or the
 *     company paused (migration 0960). A case is a card for its person; it changes no HR record.
 *  5. Record: one append-only outcome row per company (teras_loop_run): the sponsor, the checks with their versions,
 *     the owners read and what changed. A detector failure records a failed run and changes no case.
 * Phase 2 hardening (4 November 2026): detection runs ONE COMPANY AT A TIME, so one company's failure records a failed
 * run for that company only and every other company is still checked and prepared. And a run may be asked to cover only
 * the companies whose payroll changed since the loop last ran there (`onlyChanged`, the payroll tick's refresh of the
 * Salary payroll loop: core/loops/payroll-freshness.ts); a loop that declares no such check is then not run.
 * Called by the nightly sweep (scripts/review-sweep.ts) and the payroll tick (core/loops/tick.ts). */
import {createHash,randomUUID} from 'node:crypto';
import {and,count,eq,inArray,sql} from 'drizzle-orm';
import {withTenant,type Grant,type SessionContext,type Tx} from '../../db/client';
import {terasLoopCase,terasLoopPause,terasLoopRun,terasMandateControl,terasWorkerControl} from '../../db/teras-schema';
import {isAdmin} from '../../lib/authz-model';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {agentContext} from '../agent-principal';
import {workerModule,workerRunGateTx} from '../agent-registry/controls';
import type {EntitlementSnapshot} from '../entitlement-types';
import {isModuleEnabled} from '../entitlements';
import {LOOP_DEFINITIONS} from './definitions';
import {runLoopAutonomy} from './act';
import {LoopObservationSchema,unique,type LoopObservation,type TrackedCase} from './detect';
import {LOOP_IDS,type LoopCheck,type LoopId,type LoopRead} from './types';
import {lastLoopRunsTx} from './payroll-freshness';

export type LoopRunOptions=Readonly<{tenantId:string;principalId:string;entitlements:EntitlementSnapshot;
 /** The HR day the run is for (Asia/Kuala_Lumpur); defaults to today. */
 today?:string;
 /** AI v2 P2-2a: the instant the run starts (a loop with a per-company interval compares it with its last run). */
 now?:Date;
 /** Phase 2 hardening: only the companies whose payroll changed since this loop last ran there (the loop's own
  * `changedSince` check; a loop without one is not run). The payroll tick passes it; the nightly sweep does not. */
 onlyChanged?:true}>;
export type LoopCounts={observed:number;opened:number;reopened:number;closed:number;openNow:number;waitingNow:number;capped:boolean};
export type LoopRunResult=
 |Readonly<{workerId:LoopId;status:'not_run';reasons:readonly string[]}>
 |Readonly<{workerId:LoopId;status:'sponsor_lost'|'failed';runId:string}>
 |Readonly<{workerId:LoopId;status:'ran';runId:string;companies:number;totals:Readonly<LoopCounts>}>;

const zero=():LoopCounts=>({observed:0,opened:0,reopened:0,closed:0,openNow:0,waitingNow:0,capped:false});
const check=(name:string,ruleVersion:string|null,ok:boolean):LoopCheck=>Object.freeze({check:name,ruleVersion,result:ok?'pass':'fail'});
/** A fingerprint of the sponsor's roles and grants as resolved for this run, for the record; never the grants. */
const authorityFingerprint=(ctx:SessionContext)=>createHash('sha256').update(JSON.stringify([ctx.tenantId,ctx.userId,ctx.personId??null,
 [...(ctx.grants??[])].map(grant=>grant.role+'@'+(grant.companyId??'*')).sort()])).digest('hex').slice(0,16);

/** The sponsor's authority now, from the database. Null when the login is gone or blocked, or not of this tenant. */
export async function currentSponsorTx(tx:Tx,tenantId:string,userId:string,entitlements:EntitlementSnapshot):Promise<SessionContext|null>{
 const [principal]=await tx.execute(sql`select p.tenant_id,p.person_id,p.grants,app.login_blocked(${userId}::uuid) as blocked from app.principal(${userId}::uuid) p`) as unknown as
  {tenant_id:string;person_id:string|null;grants:Grant[]|null;blocked:boolean}[];
 if(!principal||principal.tenant_id!==tenantId||principal.blocked)return null;
 const grants=(principal.grants??[]).map(grant=>({role:grant.role,companyId:grant.companyId??null}));
 return{tenantId,userId,personId:principal.person_id??null,grants,roles:[...new Set(grants.map(grant=>grant.role))],entitlements};
}

async function controlTx(tx:Tx,tenantId:string,workerId:LoopId){
 const [row]=await tx.select({enabled:terasWorkerControl.enabled,version:terasWorkerControl.version,sponsorUserId:terasWorkerControl.changedByUserId})
  .from(terasWorkerControl).where(and(eq(terasWorkerControl.tenantId,tenantId),eq(terasWorkerControl.workerId,workerId))).limit(1);
 return row??null;
}
async function pausedTx(tx:Tx,tenantId:string,workerId:LoopId):Promise<Set<string>>{
 const rows=await tx.select({companyId:terasLoopPause.companyId}).from(terasLoopPause)
  .where(and(eq(terasLoopPause.tenantId,tenantId),eq(terasLoopPause.workerId,workerId),eq(terasLoopPause.paused,true)));
 return new Set(rows.map(row=>row.companyId));
}

/** One run of one loop for one tenant. Never throws for a refusal; a database failure while preparing propagates. */
export async function runLoop(workerId:LoopId,options:LoopRunOptions):Promise<LoopRunResult>{
 const def=LOOP_DEFINITIONS[workerId],today=options.today??todayInKualaLumpur(),runId=randomUUID(),startedAt=options.now??new Date();
 const agent=agentContext(options.tenantId,options.principalId,options.entitlements),module=workerModule(workerId);
 // 1 and 2: gate and sponsor, as the agent principal.
 const first=await withTenant(agent,async tx=>{
  const gate=await workerRunGateTx(tx,agent,workerId);
  const control=await controlTx(tx,options.tenantId,workerId);
  const [stop]=await tx.select({version:terasMandateControl.version}).from(terasMandateControl).where(eq(terasMandateControl.tenantId,options.tenantId)).limit(1);
  const paused=await pausedTx(tx,options.tenantId,workerId);
  const sponsor=gate.run&&control?.sponsorUserId?await currentSponsorTx(tx,options.tenantId,control.sponsorUserId,options.entitlements):null;
  return{gate,control,stopVersion:stop?.version??null,paused,sponsor};
 });
 if(!first.gate.run)return Object.freeze({workerId,status:'not_run' as const,reasons:Object.freeze([...first.gate.reasons])});
 if(!isModuleEnabled(agent,module))return Object.freeze({workerId,status:'not_run' as const,reasons:Object.freeze(['module_off'])});
 const control=first.control!,sponsorUserId=control.sponsorUserId;
 const gateChecks=[
  check('loop_switch',`teras_worker_control:${workerId}@v${control.version}`,true),
  check('stop_switch',first.stopVersion===null?'teras_mandate_control:none':`teras_mandate_control@v${first.stopVersion}`,true),
  check('module_enabled',`module:${module}`,true),
 ];
 const recordStatus=(status:'sponsor_lost'|'failed',checks:readonly LoopCheck[],reads:readonly LoopRead[])=>withTenant(agent,async tx=>{
  await tx.insert(terasLoopRun).values({tenantId:options.tenantId,runId,workerId,companyId:null,status,sponsorUserId,loopVersion:def.version,
   startedAt,finishedAt:new Date(Math.max(Date.now(),startedAt.getTime())),checks:[...checks],reads:[...reads]});
  return Object.freeze({workerId,status,runId});
 });
 // The sponsor's current authority and scope, read as the sponsor.
 const sponsor=first.sponsor&&isAdmin(first.sponsor)?first.sponsor:null;
 const scope=sponsor?await withTenant(sponsor,async tx=>{
  const [snapshot]=await tx.execute(sql`select app.principal_snapshot_current() as ok`) as unknown as {ok:boolean|null}[];
  if(snapshot?.ok!==true)return null;
  const rows=await tx.execute(sql`select c.id from public.company c where c.tenant_id=${options.tenantId}::uuid and app.is_admin_for(c.id) order by c.id`) as unknown as {id:string}[];
  return Array.from(rows).map(row=>row.id);
 }).catch(()=>null):null;
 if(!sponsor||!scope)return recordStatus('sponsor_lost',[...gateChecks,check('sponsor_authority',sponsor?`authority:${authorityFingerprint(sponsor)}`:null,false)],[]);
 const checks=[...gateChecks,check('sponsor_authority',`authority:${authorityFingerprint(sponsor)}`,true)];
 const inScope=scope.filter(companyId=>!first.paused.has(companyId)&&isModuleEnabled(agent,module,companyId));
 // AI v2 P2-2a: a loop with a per-company interval (the Pre-salary loop) runs only for the companies due now; the others
 // are left untouched and record nothing, so their last run stays the one their interval counts from.
 let companies=def.due&&inScope.length?await withTenant(agent,tx=>def.due!(tx,{tenantId:options.tenantId,workerId,companies:inScope,now:startedAt})):inScope;
 // Phase 2 hardening: a refresh between sweeps covers only the companies whose payroll changed since the last run there.
 if(options.onlyChanged){
  if(!def.changedSince||!companies.length)companies=[];
  else{
   const since=await withTenant(agent,tx=>lastLoopRunsTx(tx,options.tenantId,workerId,companies));
   companies=await def.changedSince(sponsor,{companies,since}).catch(()=>[]);
  }
 }
 if(!companies.length)return Object.freeze({workerId,status:'ran' as const,runId,companies:0,totals:Object.freeze(zero())});
 // The cases this loop is tracking in scope, as the agent principal.
 const tracked:TrackedCase[]=await withTenant(agent,tx=>tx.select({id:terasLoopCase.id,subjectKey:terasLoopCase.subjectKey,companyId:terasLoopCase.companyId,
  employmentId:terasLoopCase.employmentId,state:terasLoopCase.state,facts:terasLoopCase.facts}).from(terasLoopCase)
  .where(and(eq(terasLoopCase.tenantId,options.tenantId),eq(terasLoopCase.workerId,workerId),inArray(terasLoopCase.state,['open','waiting']),inArray(terasLoopCase.companyId,companies))));
 // 3: detect, diagnose and verify through the owners, as the sponsor, one company at a time: a company whose read fails
 // records a failed run of its own and changes no case, and every other company is still checked.
 const observations:LoopObservation[]=[],failed=new Set<string>(),readsByTool=new Map<string,LoopRead>();
 for(const companyId of companies){
  try{
   const detection=await def.detect(sponsor,{companyIds:[companyId],today,tracked:tracked.filter(item=>item.companyId===companyId)});
   const parsed=detection.observations.map(item=>LoopObservationSchema.parse(item) as LoopObservation);
   if(parsed.some(item=>item.companyId!==companyId))throw new Error('A detector observed another company.');
   observations.push(...parsed);
   for(const item of detection.reads)if(!readsByTool.has(item.tool))readsByTool.set(item.tool,item);
  }catch{failed.add(companyId);}
 }
 const reads:readonly LoopRead[]=[...readsByTool.values()];
 if(failed.size===companies.length)return recordStatus('failed',[...checks,check('owner_read',def.version,false)],[]);
 // 4 and 5: prepare and record, as the agent principal, one run of this loop at a time.
 const prepared=await withTenant(agent,async tx=>{
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`teras-loop:${options.tenantId}:${workerId}`},0))`);
  const gate=await workerRunGateTx(tx,agent,workerId),now=await controlTx(tx,options.tenantId,workerId);
  if(!gate.run||!now||now.version!==control.version||now.sponsorUserId!==sponsorUserId)
   return Object.freeze({workerId,status:'not_run' as const,reasons:Object.freeze([...gate.reasons,'switch_changed'])});
  const paused=await pausedTx(tx,options.tenantId,workerId);
  // AI v2 P2-2a: a loop with an interval checks again, under this lock, that each company is still due. A run of the
  // same loop that recorded meanwhile (an overlapping tick, or the nightly sweep) already checked it: this run writes
  // nothing there, so one company is never run twice in its interval, however the runs overlap.
  const stillDue=def.due?new Set(await def.due(tx,{tenantId:options.tenantId,workerId,companies:companies.filter(companyId=>!paused.has(companyId)),now:startedAt})):null;
  const counts=new Map(companies.filter(companyId=>!failed.has(companyId)&&!paused.has(companyId)&&(!stillDue||stillDue.has(companyId))).map(companyId=>[companyId,zero()]));
  const keys=unique(observations.map(item=>item.subjectKey));
  const existing:(typeof terasLoopCase.$inferSelect)[]=[];
  for(let offset=0;offset<keys.length;offset+=500)existing.push(...await tx.select().from(terasLoopCase)
   .where(and(eq(terasLoopCase.tenantId,options.tenantId),eq(terasLoopCase.workerId,workerId),inArray(terasLoopCase.subjectKey,keys.slice(offset,offset+500)))));
  const byKey=new Map(existing.map(row=>[row.subjectKey,row])),at=new Date();
  for(const item of observations){
   const row=byKey.get(item.subjectKey),counted=counts.get(row?.companyId??item.companyId);
   if(!counted)continue;// not in scope now (paused since, or another company)
   counted.observed++;
   if(item.state!=='closed'){
    if(!row){
     if(counted.opened>=def.openCap){counted.capped=true;continue;}
     await tx.insert(terasLoopCase).values({tenantId:options.tenantId,workerId,companyId:item.companyId,employmentId:item.employmentId,subjectKey:item.subjectKey,
      recipient:item.recipient,state:item.state,facts:item.facts,firstOpenedAt:at,openedAt:at,checkedAt:at,openedRunId:runId,checkedRunId:runId});
     counted.opened++;
    }else if(row.state==='closed'){
     // A recurrence: the same subject's condition holds again. The same case reopens and counts it.
     await tx.update(terasLoopCase).set({state:item.state,closeReason:null,resolution:null,closedAt:null,openedAt:at,checkedAt:at,openedRunId:runId,checkedRunId:runId,
      reopenCount:sql`${terasLoopCase.reopenCount}+1`,facts:item.facts,recipient:item.recipient}).where(and(eq(terasLoopCase.tenantId,options.tenantId),eq(terasLoopCase.id,row.id)));
     counted.reopened++;
    }else{
     await tx.update(terasLoopCase).set({state:item.state,facts:item.facts,checkedAt:at,checkedRunId:runId,recipient:item.recipient})
      .where(and(eq(terasLoopCase.tenantId,options.tenantId),eq(terasLoopCase.id,row.id)));
    }
   }else if(row&&row.state!=='closed'){
    await tx.update(terasLoopCase).set({state:'closed',closeReason:item.closeReason!,resolution:item.resolution??null,closedAt:at,checkedAt:at,checkedRunId:runId,facts:item.facts})
     .where(and(eq(terasLoopCase.tenantId,options.tenantId),eq(terasLoopCase.id,row.id)));
    counted.closed++;
   }
  }
  const live=[...counts.keys()];
  if(live.length){
   const totals=await tx.select({companyId:terasLoopCase.companyId,state:terasLoopCase.state,n:count()}).from(terasLoopCase)
    .where(and(eq(terasLoopCase.tenantId,options.tenantId),eq(terasLoopCase.workerId,workerId),inArray(terasLoopCase.companyId,live),inArray(terasLoopCase.state,['open','waiting'])))
    .groupBy(terasLoopCase.companyId,terasLoopCase.state);
   for(const row of totals){const counted=counts.get(row.companyId);if(!counted)continue;if(row.state==='open')counted.openNow=Number(row.n);else counted.waitingNow=Number(row.n);}
   const finishedAt=new Date(Math.max(Date.now(),startedAt.getTime()));
   await tx.insert(terasLoopRun).values(live.map(companyId=>{const c=counts.get(companyId)!;return{tenantId:options.tenantId,runId,workerId,companyId,status:'ran' as const,
    sponsorUserId,loopVersion:def.version,startedAt,finishedAt,observed:c.observed,opened:c.opened,reopened:c.reopened,closed:c.closed,openNow:c.openNow,
    waitingNow:c.waitingNow,capped:c.capped,checks:[...checks,check('company_not_paused','teras_loop_pause',true)],reads:[...reads]};}));
  }
  // A company whose own read failed: its failed run, nothing else.
  const failedHere=[...failed].filter(companyId=>!paused.has(companyId));
  if(failedHere.length){
   const finishedAt=new Date(Math.max(Date.now(),startedAt.getTime()));
   await tx.insert(terasLoopRun).values(failedHere.map(companyId=>({tenantId:options.tenantId,runId,workerId,companyId,status:'failed' as const,sponsorUserId,
    loopVersion:def.version,startedAt,finishedAt,checks:[...checks,check('owner_read',def.version,false)],reads:[]})));
  }
  const totals=zero();
  for(const c of counts.values()){totals.observed+=c.observed;totals.opened+=c.opened;totals.reopened+=c.reopened;totals.closed+=c.closed;
   totals.openNow+=c.openNow;totals.waitingNow+=c.waitingNow;totals.capped||=c.capped;}
  return Object.freeze({workerId,status:'ran' as const,runId,companies:live.length,totals:Object.freeze(totals)});
 });
 // AI v2 Phase 2 P2-1: above Prepare, act within each company's limits, observe, and demote (core/loops/act.ts). A loop
 // capped at Prepare returns at once; this step never throws and never changes the Prepare result.
 if(prepared.status==='ran'&&prepared.companies>0)await runLoopAutonomy({workerId,tenantId:options.tenantId,principalId:options.principalId,agent,sponsor,
  sponsorUserId:sponsor.userId!,runId,today,companies});
 // Phase 2 hardening: a notice step (the Pre-salary loop's cut-off reminders), only for the companies this run prepared.
 // It never throws and never changes the Prepare result.
 if(prepared.status==='ran'&&prepared.companies>0&&def.afterPrepare)await def.afterPrepare({tenantId:options.tenantId,principalId:options.principalId,runId,agent,sponsor,
  companies:companies.filter(companyId=>!failed.has(companyId)),today}).catch(()=>undefined);
 return prepared;
}

/** Every loop for one tenant, in registry order. One loop's failure never stops the others. */
export async function runLoopsForTenant(options:LoopRunOptions):Promise<readonly LoopRunResult[]>{
 const out:LoopRunResult[]=[];
 for(const workerId of LOOP_IDS){
  try{out.push(await runLoop(workerId,options));}
  catch{out.push(Object.freeze({workerId,status:'failed' as const,runId:''}));}
 }
 return Object.freeze(out);
}
