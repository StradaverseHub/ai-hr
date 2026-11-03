/** AI v2 Phase 2 P2-1 — the autonomy step of a loop run, after the Prepare step (core/loops/run.ts), for the companies
 * the run covered. A loop capped at Prepare, or without an automatic step, never reaches past the first line.
 *
 * In order, for one loop and tenant:
 *  1. Recover: an action left "applying" by an interrupted run is settled from the owner's own record (the notice event
 *     written in the same transaction as the change): applied if it is there, not applied otherwise.
 *  2. Observe, under the sponsor's current authority: whether each action applied in the last 7 days still stands. A
 *     different or removed value is a person's change, marked once on the action.
 *  3. Demote, as the agent principal: for each company above Prepare, more than 1% of the last 7 days' actions undone or
 *     changed by people moves the loop back to Prepare there, with the corrections recorded (core/loops/levels.ts).
 *  4. Act, for each company still above Prepare: on open cases the loop has never acted on, oldest first, each
 *     condition is read under the sponsor (core/loops/act-clock-outs.ts, act-requests.ts), the attempt is recorded as the agent
 *     principal under a per-company lock that re-reads the level and counts tonight's actions against the company's
 *     limit, then the owner applies it under the sponsor, attributed to the loop (core/loops/attribution.ts), and the result is
 *     recorded. A condition that fails leaves the
 *     card with the person, recorded with its reason; one attempt per case, ever. The database refuses an action while
 *     the loop is off, stopped, paused or below Level 2 for the company (migration 0963). Phase 2 hardening: the apply
 *     transaction itself re-checks the switch, the stop, the pause and the level at its start and just before it commits
 *     (core/loops/act-gate.ts), so a change made between the record and the apply is honoured (`loop_stopped`).
 * Never throws: a failure in this step leaves the prepared cards as they are and is retried on the next run. No model. */
import {and,asc,count,eq,gte,inArray,isNull,lt,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../../db/client';
import {terasLoopCase} from '../../db/teras-schema';
import {terasLoopAction,terasLoopActionUndo} from '../../db/teras-autonomy-schema';
import type {LoopFacts,LoopId} from './types';
import type {LoopActionCheck,LoopActionFacts,LoopActionReason,LoopCorrection,LoopLimits} from './autonomy-types';
import {DEMOTION_RULE,promotableTo,shouldDemote} from './autonomy';
import {demoteLoopLevelTx,levelIn,loopLevelsTx} from './levels';
import {userNameTx} from './attribution';
import {loopAttribution,type LoopAttribution} from '../../lib/ai-centre/loop-attribution';
import {CLOCK_OUT_ACT_VERSION,LoopActRefused,applyClockOut,appliedRecordOf,clockOutCandidate,evaluateClockOut,observeClockOuts} from './act-clock-outs';
import {REQUEST_ACT_VERSION,applyRequest,evaluateRequest,requestCandidate,requestFacts,sentRecordOf} from './act-requests';

const DAY_MS=86_400_000;
/** An "applying" action older than this belongs to a run that did not finish. */
export const ACTION_RECOVERY_MS=15*60_000;
/** At most this many cases are considered for one company in one run (the loop's own open-card cap). */
const CANDIDATE_LIMIT=200;

type CaseRow=Readonly<{id:string;companyId:string;employmentId:string|null;facts:LoopFacts}>;
type Item=Readonly<{caseId:string;employmentId:string;facts:LoopActionFacts;data:unknown}>;
type Evaluation=Readonly<{ok:boolean;reason:LoopActionReason|null;checks:readonly LoopActionCheck[]}>;
type ApplyInput=Readonly<{item:Item;actionId:string;undoUntil:Date;principalId:string;workerId:LoopId;attribution:LoopAttribution;limits:LoopLimits}>;
/** One loop's automatic step, as the autonomy step drives it. */
type Actor=Readonly<{version:string;
 candidate:(row:CaseRow)=>Item|null;
 evaluate:(sponsor:SessionContext,item:Item,limits:LoopLimits)=>Promise<Evaluation>;
 apply:(sponsor:SessionContext,p:ApplyInput)=>Promise<Readonly<{ownerRef:string;facts:LoopActionFacts}>>;
 recordOf:(sponsor:SessionContext,actionId:string)=>Promise<Readonly<{ownerRef:string;at:Date;facts:LoopActionFacts}>|null>;
 observe:((sponsor:SessionContext,standing:readonly Readonly<{id:string;employmentId:string;facts:LoopActionFacts}>[])=>Promise<Map<string,string|null>>)|null;
 /** The case's facts once the work is done (the case closes), or null to leave the case open for the person. */
 closeFacts:((item:Item,facts:LoopFacts)=>LoopFacts)|null}>;

const ACTORS:Partial<Record<LoopId,Actor>>={
 loop_missed_clock_outs:{version:CLOCK_OUT_ACT_VERSION,
  candidate:row=>{const data=clockOutCandidate(row);return data?{caseId:data.caseId,employmentId:data.employmentId,data,
   facts:{date:data.date,checkIn:data.checkIn,checkOut:data.proposedCheckOut}}:null;},
  evaluate:(sponsor,item,limits)=>evaluateClockOut(sponsor,item.data as Parameters<typeof evaluateClockOut>[1],limits),
  apply:async(sponsor,p)=>{const result=await applyClockOut(sponsor,{item:p.item.data as Parameters<typeof applyClockOut>[1]['item'],actionId:p.actionId,
   undoUntil:p.undoUntil,principalId:p.principalId,workerId:p.workerId,attribution:p.attribution,condition:p.limits.condition});
   return {ownerRef:result.ownerRef,facts:{...p.item.facts,addedPunchId:result.addedPunchId}};},
  recordOf:async(sponsor,actionId)=>{const record=await appliedRecordOf(sponsor,actionId);return record?{ownerRef:record.ownerRef,at:record.at,facts:{addedPunchId:record.addedPunchId}}:null;},
  observe:observeClockOuts,
  closeFacts:(item,facts)=>({...facts,recordedCheckOut:item.facts.checkOut,autoApplied:true})},
 loop_missing_employee_data:{version:REQUEST_ACT_VERSION,
  candidate:row=>{const data=requestCandidate(row);return data?{caseId:data.caseId,employmentId:data.employmentId,data,facts:requestFacts(data)}:null;},
  evaluate:(sponsor,item)=>evaluateRequest(sponsor,item.data as Parameters<typeof evaluateRequest>[1]),
  apply:async(sponsor,p)=>{const result=await applyRequest(sponsor,{item:p.item.data as Parameters<typeof applyRequest>[1]['item'],actionId:p.actionId,
   undoUntil:p.undoUntil,workerId:p.workerId,attribution:p.attribution});return {ownerRef:result.ownerRef,facts:p.item.facts};},
  recordOf:async(sponsor,actionId)=>{const record=await sentRecordOf(sponsor,actionId);return record?{ownerRef:record.ownerRef,at:record.at,facts:{}}:null;},
  observe:null,closeFacts:null},
};
/** The loops with an automatic step built (core/loops/autonomy.ts declares which may have one). */
export const ACTING_LOOPS:readonly LoopId[]=Object.freeze(Object.keys(ACTORS) as LoopId[]);

export type AutonomyRunInput=Readonly<{workerId:LoopId;tenantId:string;principalId:string;agent:SessionContext;sponsor:SessionContext;sponsorUserId:string;
 runId:string;today:string;companies:readonly string[];now?:Date}>;
export type AutonomyRunSummary=Readonly<{applied:number;notApplied:number;recovered:number;changedObserved:number;demoted:readonly string[]}>;
const NONE:AutonomyRunSummary=Object.freeze({applied:0,notApplied:0,recovered:0,changedObserved:0,demoted:Object.freeze([])});

/** Start of the run's HR day (Asia/Kuala_Lumpur), the night an action counts against. */
const nightStart=(today:string)=>new Date(`${today}T00:00:00+08:00`);

export async function runLoopAutonomy(p:AutonomyRunInput):Promise<AutonomyRunSummary>{
 // The cap: a loop that may not stand above Prepare, or has no automatic step, never acts and is never observed.
 const actor=ACTORS[p.workerId];
 if(promotableTo(p.workerId)<=1||!actor)return NONE;
 try{return await autonomyStep(p,actor);}catch{return NONE;}
}

async function autonomyStep(p:AutonomyRunInput,actor:Actor):Promise<AutonomyRunSummary>{
 const now=p.now??new Date(),scope=[...p.companies];
 if(!scope.length)return NONE;
 const {agent,sponsor,tenantId,workerId}=p;
 let recovered=0,changedObserved=0,applied=0,notApplied=0;
 const demoted:string[]=[];
 // 1. Recover interrupted attempts.
 const stale=await withTenant(agent,tx=>tx.select({id:terasLoopAction.id,caseId:terasLoopAction.caseId,facts:terasLoopAction.facts}).from(terasLoopAction)
  .where(and(eq(terasLoopAction.tenantId,tenantId),eq(terasLoopAction.workerId,workerId),eq(terasLoopAction.state,'applying'),
   lt(terasLoopAction.createdAt,new Date(now.getTime()-ACTION_RECOVERY_MS)))));
 for(const row of stale){
  const record=await actor.recordOf(sponsor,row.id).catch(()=>null);
  await withTenant(agent,tx=>tx.update(terasLoopAction).set(record
   ?{state:'applied',ownerRef:record.ownerRef,appliedAt:record.at,facts:{...row.facts,...record.facts}}
   :{state:'not_applied',reason:'interrupted'}).where(and(eq(terasLoopAction.tenantId,tenantId),eq(terasLoopAction.id,row.id),eq(terasLoopAction.state,'applying'))));
  recovered++;
 }
 // 2. Observe the last 7 days' applied actions that are neither undone nor already marked.
 const since=new Date(now.getTime()-DEMOTION_RULE.windowDays*DAY_MS);
 if(actor.observe){
  const standing=await withTenant(agent,tx=>tx.select({id:terasLoopAction.id,employmentId:terasLoopAction.employmentId,facts:terasLoopAction.facts}).from(terasLoopAction)
   .leftJoin(terasLoopActionUndo,eq(terasLoopActionUndo.actionId,terasLoopAction.id))
   .where(and(eq(terasLoopAction.tenantId,tenantId),eq(terasLoopAction.workerId,workerId),eq(terasLoopAction.state,'applied'),
    gte(terasLoopAction.appliedAt,since),isNull(terasLoopAction.peopleChangedAt),isNull(terasLoopActionUndo.actionId),inArray(terasLoopAction.companyId,scope))));
  if(standing.length){
   const changed=await actor.observe(sponsor,standing).catch(()=>new Map<string,string|null>());
   for(const [id,recorded] of changed){
    const row=standing.find(item=>item.id===id)!;
    await withTenant(agent,tx=>tx.update(terasLoopAction).set({peopleChangedAt:now,facts:{...row.facts,recordedCheckOut:recorded}})
     .where(and(eq(terasLoopAction.tenantId,tenantId),eq(terasLoopAction.id,id),eq(terasLoopAction.state,'applied'),isNull(terasLoopAction.peopleChangedAt))));
    changedObserved++;
   }
  }
 }
 // 3. Demote where people corrected more than the fixed share.
 const levels=await withTenant(agent,tx=>loopLevelsTx(tx,tenantId,workerId));
 const above=scope.filter(companyId=>levelIn(levels,companyId)>=2);
 for(const companyId of above){
  const rows=await withTenant(agent,tx=>tx.select({id:terasLoopAction.id,changedAt:terasLoopAction.peopleChangedAt,undoneBy:terasLoopActionUndo.undoneBy})
   .from(terasLoopAction).leftJoin(terasLoopActionUndo,eq(terasLoopActionUndo.actionId,terasLoopAction.id))
   .where(and(eq(terasLoopAction.tenantId,tenantId),eq(terasLoopAction.workerId,workerId),eq(terasLoopAction.companyId,companyId),
    eq(terasLoopAction.state,'applied'),gte(terasLoopAction.appliedAt,since))));
  const corrections:LoopCorrection[]=rows.flatMap((row):LoopCorrection[]=>row.undoneBy?[{actionId:row.id,kind:'undone' as const,by:row.undoneBy}]
   :row.changedAt?[{actionId:row.id,kind:'changed' as const,by:null}]:[]);
  if(!shouldDemote(rows.length,corrections.length))continue;
  const done=await withTenant(agent,tx=>demoteLoopLevelTx(tx,{tenantId,workerId,companyId,runId:p.runId,now,applied:rows.length,corrected:corrections.length,corrections}));
  if(done)demoted.push(companyId);
 }
 // 4. Act where the loop still stands above Prepare.
 const acting=above.filter(companyId=>!demoted.includes(companyId));
 const sponsorName=acting.length?await withTenant(sponsor,tx=>userNameTx(tx,p.sponsorUserId)).catch(()=>null):null;
 for(const companyId of acting){
  const limits=levels.get(companyId)!.limits;
  const open=await withTenant(agent,tx=>tx.select({id:terasLoopCase.id,companyId:terasLoopCase.companyId,employmentId:terasLoopCase.employmentId,facts:terasLoopCase.facts})
   .from(terasLoopCase).leftJoin(terasLoopAction,and(eq(terasLoopAction.tenantId,terasLoopCase.tenantId),eq(terasLoopAction.caseId,terasLoopCase.id)))
   .where(and(eq(terasLoopCase.tenantId,tenantId),eq(terasLoopCase.workerId,workerId),eq(terasLoopCase.companyId,companyId),eq(terasLoopCase.state,'open'),
    isNull(terasLoopAction.id))).orderBy(sql`${terasLoopCase.facts}->>'date'`,asc(terasLoopCase.subjectKey)).limit(CANDIDATE_LIMIT));
  for(const row of open){
   const item=actor.candidate(row);if(!item)continue;
   const evaluation=await actor.evaluate(sponsor,item,limits).catch(()=>null);
   if(!evaluation)continue;
   const undoUntil=new Date(now.getTime()+limits.undoDays*DAY_MS);
   // Record the attempt under the company's lock, against tonight's limit and the level now.
   const recorded=await withTenant(agent,async tx=>{
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`teras-loop-act:${tenantId}:${workerId}:${companyId}`},0))`);
    const current=levelIn(await loopLevelsTx(tx,tenantId,workerId),companyId);
    if(current<2)return 'stop' as const;
    const [tonight]=await tx.select({n:count()}).from(terasLoopAction).where(and(eq(terasLoopAction.tenantId,tenantId),eq(terasLoopAction.workerId,workerId),
     eq(terasLoopAction.companyId,companyId),inArray(terasLoopAction.state,['applying','applied']),gte(terasLoopAction.createdAt,nightStart(p.today))));
    if(evaluation.ok&&Number(tonight?.n??0)>=limits.maxActionsPerNight)return 'cap' as const;
    const [inserted]=await tx.insert(terasLoopAction).values({tenantId,workerId,companyId,caseId:item.caseId,employmentId:item.employmentId,runId:p.runId,level:current,
     state:evaluation.ok?'applying':'not_applied',reason:evaluation.ok?null:evaluation.reason,ruleVersion:actor.version,sponsorUserId:p.sponsorUserId,
     agentPrincipalId:p.principalId,checks:[...evaluation.checks],facts:item.facts,undoUntil}).onConflictDoNothing().returning({id:terasLoopAction.id});
    return inserted?inserted.id:'exists' as const;
   }).catch(()=>'stop' as const);
   if(recorded==='stop'||recorded==='cap')break;
   if(recorded==='exists')continue;
   if(!evaluation.ok){notApplied++;continue;}
   const attribution=loopAttribution({workerId,principalId:p.principalId,actionId:recorded,employmentId:item.employmentId,sponsorUserId:p.sponsorUserId,
    sponsorName,askedBy:null,askedByUserId:null,askedByName:null});
   let reason:LoopActionReason|null=null,result:Awaited<ReturnType<Actor['apply']>>|null=null;
   try{result=await actor.apply(sponsor,{item,actionId:recorded,undoUntil,principalId:p.principalId,workerId,attribution,limits});}
   catch(error){reason=error instanceof LoopActRefused?error.reason:'owner_refused';}
   const at=new Date();
   await withTenant(agent,tx=>tx.update(terasLoopAction).set(result
    ?{state:'applied',ownerRef:result.ownerRef,appliedAt:at,facts:result.facts}
    :{state:'not_applied',reason:reason??'owner_refused'}).where(and(eq(terasLoopAction.tenantId,tenantId),eq(terasLoopAction.id,recorded),eq(terasLoopAction.state,'applying'))));
   if(!result){notApplied++;continue;}
   applied++;
   // The work is done: the case closes as done with the value it proposed, so its card leaves the person's Today.
   if(actor.closeFacts)await withTenant(agent,tx=>tx.update(terasLoopCase).set({state:'closed',closeReason:'done',resolution:'as_prepared',closedAt:at,checkedAt:at,
    checkedRunId:p.runId,facts:actor.closeFacts!(item,row.facts)})
    .where(and(eq(terasLoopCase.tenantId,tenantId),eq(terasLoopCase.id,item.caseId),eq(terasLoopCase.state,'open')))).catch(()=>undefined);
  }
 }
 return Object.freeze({applied,notApplied,recovered,changedObserved,demoted:Object.freeze(demoted)});
}
