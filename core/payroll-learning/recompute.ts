import {assertAiCentreRunningTx} from '../ai-centre-control';
/** Payroll history learning, P1 — the learning run: recompute each company's learned baselines.
 *
 * When (the trigger, owner brief of 4 November 2026):
 *  - the 15-minute payroll tick (core/loops/tick.ts runPayrollTick), for the companies whose payroll history changed since
 *    the company's last learning run: a run closed, unlocked (reopened after close) or reset; a payroll-history import
 *    confirmed or reverted; or the learning mode switched on since;
 *  - the nightly sweep (scripts/review-sweep.ts), for every company learning is on for: the backstop.
 * Who: the run is the tenant's agent principal's, but it learns ONLY under the authority of the payroll administrator who
 * switched learning on for the company (its sponsor, ./mode.ts), re-read from the database for every run
 * (core/loops/run.ts currentSponsorTx). A sponsor who no longer administers the company's payroll, or whose login is
 * blocked or gone, stops learning for that company until an administrator switches it on again; the run records that. The
 * agent principal itself never reads a payslip or a baseline (migration 2012).
 * What, per company, in one transaction as the sponsor, serialised per company:
 *  - the latest closed month L; for as-of months L and the month after (the baseline the latest closed month's evidence
 *    uses, and the one the next run's uses), the closed-run history before each (./history.ts), each person's baselines
 *    (./learn.ts) and a new version only where a basis's result changed (its digest), never an update;
 *  - nobody whose learned baseline is due to go under the leaver retention rule (3 months after their final pay closed);
 *  - then the retention purge for the company (app.payroll_learned_baseline_purge), as the agent principal.
 * One append-only run row per company records the status, the sponsor and the counts. One company's failure never stops
 * the next. No model is called; nothing here changes pay, a run, a check, a permission or a disclosure rule.
 * THE TENANT'S STOP SWITCH (teras_mandate_control, the switch every loop honours) halts it: while it is on nothing is
 * recomputed and no evidence is shown (./evidence.ts), and the database refuses a baseline written anyway (migration 2012).
 * The leaver retention purge still runs: it only deletes what the retention rule says must go. */
import {createHash,randomUUID} from 'node:crypto';
import {and,desc,eq,inArray,sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {payrollBatch} from '../../db/schema';
import {payrollLearnedBaseline,payrollLearningMode,payrollLearningRun,type BaselineStatus,type LearningBasis,type LearningRunCounts} from '../../db/payroll-learning-schema';
import type {EntitlementSnapshot} from '../entitlement-types';
import {isModuleEnabled} from '../entitlements';
import {agentContext} from '../agent-principal';
import {tenantStoppedTx} from '../agent-registry/controls';
import {currentSponsorTx} from '../loops/run';
import {nextPeriod} from '../loops/period';
import {listPayComponents} from '../../packs/payroll/service';
import {BASELINE_METHOD} from './baseline-math';
import {readLearningHistoryTx} from './history';
import {LEARNING_BASES,learnBaselines,type LearnedBaseline} from './learn';

/** The payroll owner's run events after which what a company's history teaches can change. */
export const LEARNING_RUN_EVENTS=Object.freeze(['payroll-batch.closed','payroll-batch.unlocked','payroll-batch.reset']);
/** And the payroll-history import's own (core/payroll-history-revisions.ts). */
export const LEARNING_IMPORT_EVENTS=Object.freeze(['payroll-history-import.committed','payroll-history-import.reverted']);

export type LearningTrigger='tick'|'sweep';
export type LearningRunOptions=Readonly<{tenantId:string;principalId:string;entitlements:EntitlementSnapshot;trigger:LearningTrigger;
 /** The tick: only companies whose history changed since their last learning run. The sweep leaves it out. */
 onlyChanged?:true;now?:Date}>;
export type LearningCompanyResult=Readonly<{companyId:string;status:'ran'|'sponsor_lost'|'failed'|'unchanged';counts:LearningRunCounts|null}>;
export type LearningRunResult=Readonly<{runId:string;companies:readonly LearningCompanyResult[];purged:number;
 /** The tenant's stop switch is on: nothing was learned (the retention purge still ran). */
 stopped:boolean}>;

const ZERO:LearningRunCounts=Object.freeze({people:0,appended:0,none:0,provisional:0,stable:0,rebasing:0,contradicted:0,purged:0});
const canonical=(value:unknown):string=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`
 :value&&typeof value==='object'?`{${Object.keys(value as object).sort().map(k=>`${JSON.stringify(k)}:${canonical((value as Record<string,unknown>)[k])}`).join(',')}}`
 :JSON.stringify(value);
/** The digest of what a baseline says: the same learned result is never written twice. */
export function baselineDigest(asOf:string,baseline:LearnedBaseline):string{
 return createHash('sha256').update(canonical({method:BASELINE_METHOD,asOf,basis:baseline.basis,status:baseline.status,runs:baseline.runs,excluded:baseline.excluded,
  throughPeriod:baseline.throughPeriod,components:baseline.components})).digest('hex');
}

type ModeRow=Readonly<{companyId:string;mode:string;setByUserId:string;setAt:Date}>;
/** Every company with a mode row, its current mode and who set it, as the agent principal. */
async function currentModesTx(tx:Tx,tenantId:string):Promise<ModeRow[]>{
 const rows=await tx.select({companyId:payrollLearningMode.companyId,mode:payrollLearningMode.mode,setByUserId:payrollLearningMode.setByUserId,setAt:payrollLearningMode.setAt})
  .from(payrollLearningMode).where(eq(payrollLearningMode.tenantId,tenantId)).orderBy(desc(payrollLearningMode.version));
 const seen=new Set<string>(),out:ModeRow[]=[];
 for(const row of rows){if(seen.has(row.companyId))continue;seen.add(row.companyId);out.push(row);}
 return out;
}
/** Each company's last learning run that ran, as the agent principal. */
async function lastRunsTx(tx:Tx,tenantId:string,companies:readonly string[]):Promise<Map<string,Date>>{
 if(!companies.length)return new Map();
 const rows=await tx.select({companyId:payrollLearningRun.companyId,at:sql<string>`max(${payrollLearningRun.startedAt})`}).from(payrollLearningRun)
  .where(and(eq(payrollLearningRun.tenantId,tenantId),eq(payrollLearningRun.status,'ran'),inArray(payrollLearningRun.companyId,[...companies]))).groupBy(payrollLearningRun.companyId);
 return new Map(rows.filter(row=>row.at).map(row=>[row.companyId,(row.at as unknown) instanceof Date?row.at as unknown as Date:new Date(String(row.at))]));
}
/** Whether the company's payroll history changed after `since`, read as the sponsor (domain events are an administrator's). */
export async function historyChangedTx(tx:Tx,tenantId:string,companyId:string,since:Date):Promise<boolean>{
 const [row]=await tx.execute(sql`select exists(select 1 from public.domain_event d join public.payroll_batch b on b.id=d.aggregate_id and b.tenant_id=d.tenant_id
   where d.tenant_id=${tenantId}::uuid and d.aggregate_type='payroll-batch' and b.company_id=${companyId}::uuid
    and d.event_type in (${sql.join(LEARNING_RUN_EVENTS.map(type=>sql`${type}`),sql`,`)}) and d.occurred_at>${since.toISOString()}::timestamptz)
  or exists(select 1 from public.domain_event d where d.tenant_id=${tenantId}::uuid and d.aggregate_type='payroll-history-import'
    and d.event_type in (${sql.join(LEARNING_IMPORT_EVENTS.map(type=>sql`${type}`),sql`,`)}) and d.occurred_at>${since.toISOString()}::timestamptz
    and exists(select 1 from public.payroll_batch b where b.tenant_id=d.tenant_id and b.history_import_attempt_id=d.aggregate_id and b.company_id=${companyId}::uuid)) as changed`) as unknown as {changed:boolean}[];
 return row?.changed===true;
}

/** One company's recompute as the sponsor: the counts, or null when the sponsor may no longer learn for it. */
async function learnCompany(sponsor:SessionContext,companyId:string,componentIds:ReadonlyMap<string,string>,generation:number):Promise<(LearningRunCounts&{asOf:string|null})|null>{
 return withTenant(sponsor,async tx=>{
  await assertAiCentreRunningTx(tx,sponsor,generation);
  const [authority]=await tx.execute(sql`select app.principal_snapshot_current() is true and app.can_admin_payroll_for(${companyId}::uuid) is true
   and app.payroll_learning_mode_of(${companyId}::uuid) in ('evidence','classify') as ok`) as unknown as {ok:boolean}[];
  if(authority?.ok!==true)return null;
  // Stopped since the run began: nothing is written.
  if(await tenantStoppedTx(tx,sponsor.tenantId))return {...ZERO,asOf:null};
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`payroll-learning:${sponsor.tenantId}:${companyId}`},0))`);
  const [latest]=await tx.select({period:sql<string|null>`max(${payrollBatch.payPeriod})`}).from(payrollBatch)
   .where(and(eq(payrollBatch.companyId,companyId),eq(payrollBatch.status,'closed')));
  const latestClosed=latest?.period??null;
  if(!latestClosed)return {...ZERO,asOf:null};
  const asOfs=[latestClosed,nextPeriod(latestClosed)];
  let appended=0;
  const statuses=new Map<string,BaselineStatus>();
  const people=new Set<string>();
  for(const asOf of asOfs){
   const history=await readLearningHistoryTx(tx,{companyId,asOf,skipRetired:true});
   const stored=await tx.execute(sql`select distinct on (b.employment_id,b.basis) b.employment_id,b.basis,b.input_digest from public.payroll_learned_baseline b
    where b.tenant_id=${sponsor.tenantId}::uuid and b.company_id=${companyId}::uuid and b.as_of_period=${asOf}
    order by b.employment_id,b.basis,b.version desc`) as unknown as {employment_id:string;basis:LearningBasis;input_digest:string}[];
   const digests=new Map(Array.from(stored).map(row=>[`${row.employment_id}:${row.basis}`,row.input_digest]));
   const values:(typeof payrollLearnedBaseline.$inferInsert)[]=[];
   for(const [employmentId,months] of history.months){
    const learned=learnBaselines(months,componentIds);
    for(const basis of LEARNING_BASES){
     const baseline=learned[basis];
     if(baseline.runs+baseline.excluded===0)continue;
     if(asOf===asOfs[1]){people.add(employmentId);if(basis==='regular')statuses.set(employmentId,baseline.status);}
     const digest=baselineDigest(asOf,baseline);
     if(digests.get(`${employmentId}:${basis}`)===digest)continue;
     values.push({tenantId:sponsor.tenantId,companyId,employmentId,basis,asOfPeriod:asOf,version:1,status:baseline.status,runs:baseline.runs,excluded:baseline.excluded,
      throughPeriod:baseline.throughPeriod,components:{...baseline.components},inputDigest:digest,method:BASELINE_METHOD,sponsorUserId:sponsor.userId!});
    }
   }
   // The version and the time are the database's (app.payroll_learned_baseline_stamp).
   for(let i=0;i<values.length;i+=200){await tx.insert(payrollLearnedBaseline).values(values.slice(i,i+200));}
   appended+=values.length;
  }
  const count=(status:BaselineStatus)=>[...statuses.values()].filter(value=>value===status).length;
  return {people:people.size,appended,none:count('none'),provisional:count('provisional'),stable:count('stable'),rebasing:count('rebasing'),contradicted:count('contradicted'),
   purged:0,asOf:asOfs[1]};
 });
}

/** Whether the sponsor may learn for the company now: current login, payroll administrator of it, learning on there. */
async function sponsorMayLearn(sponsor:SessionContext,companyId:string):Promise<boolean>{
 const [row]=await withTenant(sponsor,tx=>tx.execute(sql`select app.principal_snapshot_current() is true and app.can_admin_payroll_for(${companyId}::uuid) is true
  and app.payroll_learning_mode_of(${companyId}::uuid) in ('evidence','classify') as ok`)) as unknown as {ok:boolean}[];
 return row?.ok===true;
}

/** One learning run for one tenant. Never throws for one company's failure; each is recorded. */
export async function runPayrollLearning(options:LearningRunOptions):Promise<LearningRunResult>{
 const runId=randomUUID(),agent=agentContext(options.tenantId,options.principalId,options.entitlements);
 const modes=await withTenant(agent,tx=>currentModesTx(tx,options.tenantId));
 // The leaver retention purge first, as the agent principal, for every company that has ever had learning on: a company
 // switched off keeps its baselines (switching it on again resumes), but never a leaver's past the retention rule.
 const purgedBy=new Map<string,number>();
 for(const row of modes){
  const removed=await withTenant(agent,tx=>tx.execute(sql`select app.payroll_learned_baseline_purge(${row.companyId}::uuid) as n`))
   .then(rows=>Number((rows as unknown as {n:number}[])[0]?.n??0)).catch(()=>0);
  purgedBy.set(row.companyId,removed);
 }
 // The tenant's stop switch halts learning itself (no recompute, no evidence); the purge above has already run.
 if(await withTenant(agent,tx=>tenantStoppedTx(tx,options.tenantId)))
  return Object.freeze({runId,companies:Object.freeze([]),purged:[...purgedBy.values()].reduce((sum,n)=>sum+n,0),stopped:true});
 const generation=await withTenant(agent,tx=>assertAiCentreRunningTx(tx,agent));
 const payroll=modes.filter(row=>isModuleEnabled(agent,'payroll',row.companyId));
 const on=payroll.filter(row=>row.mode==='evidence'||row.mode==='classify');
 const last=on.length?await withTenant(agent,tx=>lastRunsTx(tx,options.tenantId,on.map(row=>row.companyId))):new Map<string,Date>();
 const results:LearningCompanyResult[]=[];
 const record=(companyId:string,startedAt:Date,status:'ran'|'sponsor_lost'|'failed',sponsorUserId:string|null,counts:LearningRunCounts,asOf:string|null)=>
  withTenant(agent,tx=>tx.insert(payrollLearningRun).values({tenantId:options.tenantId,companyId,runId,trigger:options.trigger,status,asOfPeriod:asOf,sponsorUserId,
   agentPrincipalId:options.principalId,method:BASELINE_METHOD,counts,startedAt,finishedAt:new Date(Math.max(Date.now(),startedAt.getTime()))}));
 const lost=async(companyId:string,startedAt:Date,sponsorUserId:string)=>{
  await record(companyId,startedAt,'sponsor_lost',sponsorUserId,{...ZERO,purged:purgedBy.get(companyId)??0},null);
  results.push(Object.freeze({companyId,status:'sponsor_lost' as const,counts:null}));
 };
 const componentCache=new Map<string,ReadonlyMap<string,string>>();
 for(const row of on){
  const startedAt=options.now??new Date();
  try{
   const sponsor=await withTenant(agent,tx=>currentSponsorTx(tx,options.tenantId,row.setByUserId,options.entitlements));
   if(!sponsor||!await sponsorMayLearn(sponsor,row.companyId)){await lost(row.companyId,startedAt,row.setByUserId);continue;}
   if(options.onlyChanged){
    const since=last.get(row.companyId);
    const changed=!since||row.setAt.getTime()>since.getTime()||(purgedBy.get(row.companyId)??0)>0
     ||await withTenant(sponsor,tx=>historyChangedTx(tx,options.tenantId,row.companyId,since)).catch(()=>true);
    if(!changed){results.push(Object.freeze({companyId:row.companyId,status:'unchanged',counts:null}));continue;}
   }
   let componentIds=componentCache.get(sponsor.userId!);
   if(!componentIds){
    componentIds=new Map((await listPayComponents(sponsor,{includeArchived:true})).map(component=>[component.code,component.id]));
    componentCache.set(sponsor.userId!,componentIds);
   }
   const counts=await learnCompany(sponsor,row.companyId,componentIds,generation);
   if(!counts){await lost(row.companyId,startedAt,row.setByUserId);continue;}
   const {asOf,...rest}=counts;
   const final=Object.freeze({...rest,purged:purgedBy.get(row.companyId)??0});
   await record(row.companyId,startedAt,'ran',row.setByUserId,final,asOf);
   results.push(Object.freeze({companyId:row.companyId,status:'ran',counts:final}));
  }catch{
   await record(row.companyId,startedAt,'failed',row.setByUserId,ZERO,null).catch(()=>undefined);
   results.push(Object.freeze({companyId:row.companyId,status:'failed',counts:null}));
  }
 }
 return Object.freeze({runId,companies:Object.freeze(results),purged:[...purgedBy.values()].reduce((sum,n)=>sum+n,0),stopped:false});
}
