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
 *     condition is read under the sponsor (core/loops/act-clock-outs.ts), the attempt is recorded as the agent
 *     principal under a per-company lock that re-reads the level and counts tonight's actions against the company's
 *     limit, then the owner applies it under the sponsor and the result is recorded. A condition that fails leaves the
 *     card with the person, recorded with its reason; one attempt per case, ever. The database refuses an action while
 *     the loop is off, stopped, paused or below Level 2 for the company (migration 0963).
 * Never throws: a failure in this step leaves the prepared cards as they are and is retried on the next run. No model. */
import {and,asc,count,eq,gte,inArray,isNull,lt,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../../db/client';
import {terasLoopCase} from '../../db/teras-schema';
import {terasLoopAction,terasLoopActionUndo} from '../../db/teras-autonomy-schema';
import type {LoopId} from './types';
import type {LoopActionFacts,LoopActionReason,LoopCorrection} from './autonomy-types';
import {DEMOTION_RULE,promotableTo,shouldDemote} from './autonomy';
import {demoteLoopLevelTx,levelIn,loopLevelsTx} from './levels';
import {CLOCK_OUT_ACT_VERSION,LoopActRefused,applyClockOut,appliedRecordOf,clockOutCandidate,evaluateClockOut,observeClockOuts} from './act-clock-outs';

const DAY_MS=86_400_000;
/** An "applying" action older than this belongs to a run that did not finish. */
export const ACTION_RECOVERY_MS=15*60_000;
/** At most this many cases are considered for one company in one run (the loop's own open-card cap). */
const CANDIDATE_LIMIT=200;

export type AutonomyRunInput=Readonly<{workerId:LoopId;tenantId:string;principalId:string;agent:SessionContext;sponsor:SessionContext;sponsorUserId:string;
 runId:string;today:string;companies:readonly string[];now?:Date}>;
export type AutonomyRunSummary=Readonly<{applied:number;notApplied:number;recovered:number;changedObserved:number;demoted:readonly string[]}>;
const NONE:AutonomyRunSummary=Object.freeze({applied:0,notApplied:0,recovered:0,changedObserved:0,demoted:Object.freeze([])});

/** Start of the run's HR day (Asia/Kuala_Lumpur), the night an action counts against. */
const nightStart=(today:string)=>new Date(`${today}T00:00:00+08:00`);

export async function runLoopAutonomy(p:AutonomyRunInput):Promise<AutonomyRunSummary>{
 // The cap: a loop that may not stand above Prepare, or has no automatic step, never acts and is never observed.
 if(promotableTo(p.workerId)<=1||p.workerId!=='loop_missed_clock_outs')return NONE;
 try{return await autonomyStep(p);}catch{return NONE;}
}

async function autonomyStep(p:AutonomyRunInput):Promise<AutonomyRunSummary>{
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
  const record=await appliedRecordOf(sponsor,row.id).catch(()=>null);
  await withTenant(agent,tx=>tx.update(terasLoopAction).set(record
   ?{state:'applied',ownerRef:record.ownerRef,appliedAt:record.at,facts:{...row.facts,addedPunchId:record.addedPunchId}}
   :{state:'not_applied',reason:'interrupted'}).where(and(eq(terasLoopAction.tenantId,tenantId),eq(terasLoopAction.id,row.id),eq(terasLoopAction.state,'applying'))));
  recovered++;
 }
 // 2. Observe the last 7 days' applied actions that are neither undone nor already marked.
 const since=new Date(now.getTime()-DEMOTION_RULE.windowDays*DAY_MS);
 const standing=await withTenant(agent,tx=>tx.select({id:terasLoopAction.id,employmentId:terasLoopAction.employmentId,facts:terasLoopAction.facts}).from(terasLoopAction)
  .leftJoin(terasLoopActionUndo,eq(terasLoopActionUndo.actionId,terasLoopAction.id))
  .where(and(eq(terasLoopAction.tenantId,tenantId),eq(terasLoopAction.workerId,workerId),eq(terasLoopAction.state,'applied'),
   gte(terasLoopAction.appliedAt,since),isNull(terasLoopAction.peopleChangedAt),isNull(terasLoopActionUndo.actionId),inArray(terasLoopAction.companyId,scope))));
 if(standing.length){
  const changed=await observeClockOuts(sponsor,standing).catch(()=>new Map<string,string|null>());
  for(const [id,recorded] of changed){
   const row=standing.find(item=>item.id===id)!;
   await withTenant(agent,tx=>tx.update(terasLoopAction).set({peopleChangedAt:now,facts:{...row.facts,recordedCheckOut:recorded}})
    .where(and(eq(terasLoopAction.tenantId,tenantId),eq(terasLoopAction.id,id),eq(terasLoopAction.state,'applied'),isNull(terasLoopAction.peopleChangedAt))));
   changedObserved++;
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
 for(const companyId of above.filter(companyId=>!demoted.includes(companyId))){
  const limits=levels.get(companyId)!.limits;
  const open=await withTenant(agent,tx=>tx.select({id:terasLoopCase.id,companyId:terasLoopCase.companyId,employmentId:terasLoopCase.employmentId,facts:terasLoopCase.facts})
   .from(terasLoopCase).leftJoin(terasLoopAction,and(eq(terasLoopAction.tenantId,terasLoopCase.tenantId),eq(terasLoopAction.caseId,terasLoopCase.id)))
   .where(and(eq(terasLoopCase.tenantId,tenantId),eq(terasLoopCase.workerId,workerId),eq(terasLoopCase.companyId,companyId),eq(terasLoopCase.state,'open'),
    isNull(terasLoopAction.id))).orderBy(sql`${terasLoopCase.facts}->>'date'`,asc(terasLoopCase.subjectKey)).limit(CANDIDATE_LIMIT));
  for(const row of open){
   const item=clockOutCandidate(row);if(!item)continue;
   const evaluation=await evaluateClockOut(sponsor,item,limits).catch(()=>null);
   if(!evaluation)continue;
   const facts:LoopActionFacts={date:item.date,checkIn:item.checkIn,checkOut:item.proposedCheckOut};
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
     state:evaluation.ok?'applying':'not_applied',reason:evaluation.ok?null:evaluation.reason,ruleVersion:CLOCK_OUT_ACT_VERSION,sponsorUserId:p.sponsorUserId,
     checks:[...evaluation.checks],facts,undoUntil}).onConflictDoNothing().returning({id:terasLoopAction.id});
    return inserted?inserted.id:'exists' as const;
   }).catch(()=>'stop' as const);
   if(recorded==='stop'||recorded==='cap')break;
   if(recorded==='exists')continue;
   if(!evaluation.ok){notApplied++;continue;}
   let reason:LoopActionReason|null=null,result:Awaited<ReturnType<typeof applyClockOut>>|null=null;
   try{result=await applyClockOut(sponsor,{item,actionId:recorded,undoUntil,principalId:p.principalId,workerId});}
   catch(error){reason=error instanceof LoopActRefused?error.reason:'owner_refused';}
   const at=new Date();
   await withTenant(agent,tx=>tx.update(terasLoopAction).set(result
    ?{state:'applied',ownerRef:result.ownerRef,appliedAt:at,facts:{...facts,addedPunchId:result.addedPunchId}}
    :{state:'not_applied',reason:reason??'owner_refused'}).where(and(eq(terasLoopAction.tenantId,tenantId),eq(terasLoopAction.id,recorded),eq(terasLoopAction.state,'applying'))));
   if(!result){notApplied++;continue;}
   applied++;
   // The work is done: the case closes as done with the value it proposed, so its card leaves the person's Today.
   await withTenant(agent,tx=>tx.update(terasLoopCase).set({state:'closed',closeReason:'done',resolution:'as_prepared',closedAt:at,checkedAt:at,checkedRunId:p.runId,
    facts:{...row.facts,recordedCheckOut:item.proposedCheckOut,autoApplied:true}})
    .where(and(eq(terasLoopCase.tenantId,tenantId),eq(terasLoopCase.id,item.caseId),eq(terasLoopCase.state,'open')))).catch(()=>undefined);
  }
 }
 return Object.freeze({applied,notApplied,recovered,changedObserved,demoted:Object.freeze(demoted)});
}
