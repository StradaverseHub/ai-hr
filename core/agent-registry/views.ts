/** ADR-0170 §3.13 step 5 — read services for the Workers page in the Control Tower (no React here).
 *
 * listWorkers: every registered worker with its family, trigger, read scope, effect, authority, switch (and
 * where that switch lives), the tenant-wide stop, whether its run path honours the stop yet, its run gate,
 * last run, and acceptance and reversal rates. workerDetail adds recent runs and, for mandate workers, the
 * mandates with their grantor (ids only; the screen resolves names through its own reads).
 *
 * Rates reuse the Control Tower agreement view (core/control-tower.ts agreementView) for workers recorded in
 * the agent proposal ledger, and the outcome record follow-ups for Teras workers. A rate whose denominator is
 * zero is null, never 0, with the same discipline as agreementView. Group administrators only. */
import {and,count,desc,eq,inArray,max,sql,type SQL} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {agentProposal,domainEvent} from '../../db/schema';
import {terasLoopRun,terasMandate,terasOutcomeFollowup,terasOutcomeRecord} from '../../db/teras-schema';
import type {LoopId} from '../loops/types';
import {isGroupAdmin} from '../../lib/authz-model';
import {agreementView,workerAgreementPageRatesTx,type AgreementView} from '../control-tower';
import type {ProposalRates} from '../agent-proposal';
import {mandateState,type MandateState} from '../mandates/mandates';
import {captureWorkerPageReadFacts,workerPageContextTx,workerPageSwitchesTx,tenantStoppedTx,workerGateFromState,workerSwitchStateTx,type WorkerGate,type WorkerSwitchState,type WorkerPageReadFacts} from './controls';
import {registeredWorker,registeredWorkers,type WorkerDeclaration} from './workers';

export class WorkerRegistryRefused extends Error{constructor(readonly reason:'not_administrator'|'not_found'){super('Worker registry refused: '+reason);this.name='WorkerRegistryRefused';}}
const requireAdmin=(ctx:SessionContext)=>{if(!ctx.userId||ctx.agent||!isGroupAdmin(ctx))throw new WorkerRegistryRefused('not_administrator');};

export type WorkerMetricsView=Readonly<{measured:boolean;acceptanceRate:number|null;reversalRate:number|null;decided:number;reason:string|null}>;
export type WorkerRow=Readonly<{id:string;label:string;family:WorkerDeclaration['family'];trigger:WorkerDeclaration['trigger'];readScope:readonly string[];
 effect:WorkerDeclaration['effect'];authority:WorkerDeclaration['authority'];owners:readonly string[];
 switch:WorkerSwitchState;stopped:boolean;stopHonoured:boolean;stopPending:string|null;gate:WorkerGate;
 lastRunAt:Date|null;metrics:WorkerMetricsView;mandates:Readonly<{active:number;total:number}>|null}>;


/** One predicate owner for the registry's existing source-specific tool partition. */
function outcomeWorkerTools(record:Extract<WorkerDeclaration['record'],{kind:'outcome_record'}>){
 return record.tools?sql`(${sql.join(record.tools.map(tool=>sql`${terasOutcomeRecord.reads} @> ${JSON.stringify([{tool}])}::jsonb`),sql` or `)})`:undefined;
}
function eventWorkerSource(record:Extract<WorkerDeclaration['record'],{kind:'domain_event'}>){
 return record.source?sql`${domainEvent.payload}->>'source'=${record.source}`:undefined;
}

/** When the worker last ran, from where its declaration says runs are recorded. */
async function lastRunTx(tx:Tx,tenantId:string,worker:WorkerDeclaration):Promise<Date|null>{
 const record=worker.record;
 if(record.kind==='outcome_record'){
  const tools=outcomeWorkerTools(record);
  const [row]=await tx.select({at:max(terasOutcomeRecord.startedAt)}).from(terasOutcomeRecord)
   .where(and(eq(terasOutcomeRecord.tenantId,tenantId),eq(terasOutcomeRecord.agentIdentity,record.agentIdentity),tools));
  return row?.at??null;
 }
 if(record.kind==='mandate_runs'){
  const [row]=await tx.select({at:max(terasOutcomeRecord.startedAt)}).from(terasOutcomeRecord)
   .innerJoin(terasMandate,and(eq(terasMandate.tenantId,terasOutcomeRecord.tenantId),eq(terasMandate.id,terasOutcomeRecord.mandateId)))
   .where(and(eq(terasOutcomeRecord.tenantId,tenantId),eq(terasMandate.jobType,record.jobType)));
  return row?.at??null;
 }
 if(record.kind==='agent_proposal'){
  const [row]=await tx.select({at:max(agentProposal.proposedAt)}).from(agentProposal)
   .where(and(eq(agentProposal.tenantId,tenantId),inArray(agentProposal.proposalType,[...record.proposalTypes])));
  return row?.at??null;
 }
 // AI v2 W8: a loop's runs, as the caller may read them (RLS: the companies they administer).
 if(record.kind==='loop_runs'){
  const [row]=await tx.select({at:max(terasLoopRun.startedAt)}).from(terasLoopRun)
   .where(and(eq(terasLoopRun.tenantId,tenantId),eq(terasLoopRun.workerId,worker.id as LoopId)));
  return row?.at??null;
 }
 const [row]=await tx.select({at:max(domainEvent.occurredAt)}).from(domainEvent)
  .where(and(eq(domainEvent.tenantId,tenantId),eq(domainEvent.eventType,record.eventType),
   eventWorkerSource(record)));
 return row?.at??null;
}

const rate=(n:number,d:number)=>d===0?null:n/d;
/** Agreement from outcome record follow-ups: accepted / (accepted + rejected); undone / accepted. */
async function followupMetricsTx(tx:Tx,tenantId:string,agentIdentity:string):Promise<WorkerMetricsView>{
 const rows=await tx.select({decision:terasOutcomeFollowup.decision,n:count()}).from(terasOutcomeFollowup)
  .innerJoin(terasOutcomeRecord,and(eq(terasOutcomeRecord.tenantId,terasOutcomeFollowup.tenantId),eq(terasOutcomeRecord.id,terasOutcomeFollowup.recordId)))
  .where(and(eq(terasOutcomeFollowup.tenantId,tenantId),eq(terasOutcomeRecord.agentIdentity,agentIdentity))).groupBy(terasOutcomeFollowup.decision);
 const of=(decision:string)=>Number(rows.find(row=>row.decision===decision)?.n??0);
 const accepted=of('accepted'),rejected=of('rejected'),undone=of('undone');
 return Object.freeze({measured:accepted+rejected>0,acceptanceRate:rate(accepted,accepted+rejected),reversalRate:rate(undone,accepted),decided:accepted+rejected,
  reason:accepted+rejected>0?null:'Nobody has decided on one of its suggestions yet.'});
}
function agreementMetrics(view:AgreementView|null,types:readonly string[]):WorkerMetricsView{
 if(!view)return Object.freeze({measured:false,acceptanceRate:null,reversalRate:null,decided:0,reason:'The agreement view could not be read.'});
 const metrics=agreementPageMetrics(view.rates,types);
 return Object.freeze({...metrics,reason:metrics.measured?null:view.blockedBy.length?`Not measured yet: ${view.blockedBy.join(', ')}.`:'Nobody has decided on one of its suggestions yet.'});
}

export type PageWorkerMetrics=Pick<WorkerMetricsView,'measured'|'acceptanceRate'|'reversalRate'|'decided'>;
/** The original aggregation, shared by the full service and the smaller page DTO. */
function agreementPageMetrics(rates:readonly ProposalRates[],types:readonly string[]):PageWorkerMetrics{
 const rows=rates.filter(row=>types.includes(row.type));
 const approved=rows.reduce((n,row)=>n+row.approved,0),declined=rows.reduce((n,row)=>n+row.declined,0);
 const reversal=rows.length===1?rows[0].reversalRate:null;
 return Object.freeze({measured:approved+declined>0,acceptanceRate:rate(approved,approved+declined),reversalRate:reversal,decided:approved+declined});
}

async function rowsFor(ctx:SessionContext,workers:readonly WorkerDeclaration[]):Promise<WorkerRow[]>{
 // agreementView opens its own transactions; it is called outside ours (see its own warning).
 let agreement:AgreementView|null=null;
 if(workers.some(worker=>worker.metrics.kind==='agreement_view')){try{agreement=await agreementView(ctx);}catch{agreement=null;}}
 return withTenant(ctx,async tx=>{
  const stopped=await tenantStoppedTx(tx,ctx.tenantId);
  const mandates=await tx.select().from(terasMandate).where(eq(terasMandate.tenantId,ctx.tenantId));
  const now=new Date(),out:WorkerRow[]=[];
  for(const worker of workers){
   const metrics=worker.metrics.kind==='agreement_view'?agreementMetrics(agreement,worker.metrics.proposalTypes)
    :worker.metrics.kind==='outcome_followups'&&worker.record.kind==='outcome_record'?await followupMetricsTx(tx,ctx.tenantId,worker.record.agentIdentity)
    :Object.freeze({measured:false,acceptanceRate:null,reversalRate:null,decided:0,reason:worker.metrics.kind==='not_measurable'?worker.metrics.reason
     :worker.metrics.kind==='loop_cases'?'Measured from its cards on Operations, Loops.':'Not measured.'});
   const own=worker.authority.kind==='mandate'?mandates.filter(row=>row.jobType===(worker.authority as {jobType:string}).jobType):null;
   const switchState=await workerSwitchStateTx(tx,ctx,worker);
   out.push(Object.freeze({id:worker.id,label:worker.label,family:worker.family,trigger:worker.trigger,readScope:worker.readScope,effect:worker.effect,
    authority:worker.authority,owners:worker.owners,switch:switchState,stopped,stopHonoured:worker.stop.honoured,
    stopPending:worker.stop.honoured?null:worker.stop.pending,gate:workerGateFromState(switchState.on,stopped),lastRunAt:await lastRunTx(tx,ctx.tenantId,worker),metrics,
    mandates:own?Object.freeze({active:own.filter(row=>mandateState(row,now)==='active').length,total:own.length}):null}));
  }
  return out;
 });
}

/** The Workers list: every registered worker, in registry order. */
export async function listWorkers(ctx:SessionContext):Promise<readonly WorkerRow[]>{
 requireAdmin(ctx);
 return Object.freeze(await rowsFor(ctx,registeredWorkers()));
}

export type WorkerRun=Readonly<{at:Date;runId:string|null;outcomeKind:string|null;humanInvolvement:string|null;decision:string|null;mandateId:string|null}>;
export type WorkerMandateRow=Readonly<{id:string;grantorUserId:string;grantorPersonId:string;agentIdentity:string;state:MandateState;validUntil:Date;
 revokedBy:'grantor'|'administrator'|'manager'|null;version:number}>;
export type WorkerDetail=Readonly<{worker:WorkerRow;recentRuns:readonly WorkerRun[];mandates:readonly WorkerMandateRow[]}>;
const RECENT=20;

/** One worker: its row, its recent runs (from where it records them) and, for mandate workers, its mandates. */
export async function workerDetail(ctx:SessionContext,workerId:string):Promise<WorkerDetail>{
 requireAdmin(ctx);
 const worker=registeredWorker(workerId);
 if(!worker)throw new WorkerRegistryRefused('not_found');
 const [row]=await rowsFor(ctx,[worker]);
 return withTenant(ctx,async tx=>{
  const record=worker.record,now=new Date();
  let recentRuns:WorkerRun[]=[];
  if(record.kind==='outcome_record'||record.kind==='mandate_runs'){
   const rows=record.kind==='outcome_record'
    ?await tx.select({record:terasOutcomeRecord}).from(terasOutcomeRecord).where(and(eq(terasOutcomeRecord.tenantId,ctx.tenantId),eq(terasOutcomeRecord.agentIdentity,record.agentIdentity),
      outcomeWorkerTools(record)))
      .orderBy(desc(terasOutcomeRecord.startedAt),desc(terasOutcomeRecord.id)).limit(RECENT)
    :await tx.select({record:terasOutcomeRecord}).from(terasOutcomeRecord)
      .innerJoin(terasMandate,and(eq(terasMandate.tenantId,terasOutcomeRecord.tenantId),eq(terasMandate.id,terasOutcomeRecord.mandateId)))
      .where(and(eq(terasOutcomeRecord.tenantId,ctx.tenantId),eq(terasMandate.jobType,record.jobType))).orderBy(desc(terasOutcomeRecord.startedAt),desc(terasOutcomeRecord.id)).limit(RECENT);
   const ids=rows.map(item=>item.record.id);
   const followups=ids.length?await tx.select({recordId:terasOutcomeFollowup.recordId,decision:terasOutcomeFollowup.decision,at:terasOutcomeFollowup.at}).from(terasOutcomeFollowup)
    .where(and(eq(terasOutcomeFollowup.tenantId,ctx.tenantId),inArray(terasOutcomeFollowup.recordId,ids))).orderBy(terasOutcomeFollowup.at):[];
   recentRuns=rows.map(({record:run})=>Object.freeze({at:run.startedAt,runId:run.runId,outcomeKind:run.outcomeKind,humanInvolvement:run.humanInvolvement,
    decision:followups.filter(item=>item.recordId===run.id&&item.decision).at(-1)?.decision??null,mandateId:run.mandateId}));
  }else if(record.kind==='agent_proposal'){
   const rows=await tx.select({at:agentProposal.proposedAt,decision:agentProposal.decision}).from(agentProposal)
    .where(and(eq(agentProposal.tenantId,ctx.tenantId),inArray(agentProposal.proposalType,[...record.proposalTypes]))).orderBy(desc(agentProposal.proposedAt)).limit(RECENT);
   recentRuns=rows.map(item=>Object.freeze({at:item.at,runId:null,outcomeKind:null,humanInvolvement:null,decision:item.decision,mandateId:null}));
  }else if(record.kind==='loop_runs'){
   const rows=await tx.select({at:terasLoopRun.startedAt,runId:terasLoopRun.runId,status:terasLoopRun.status}).from(terasLoopRun)
    .where(and(eq(terasLoopRun.tenantId,ctx.tenantId),eq(terasLoopRun.workerId,worker.id as LoopId))).orderBy(desc(terasLoopRun.startedAt),desc(terasLoopRun.id)).limit(RECENT);
   recentRuns=rows.map(item=>Object.freeze({at:item.at,runId:item.runId,outcomeKind:item.status==='ran'?'prepared':'stopped',humanInvolvement:'none',decision:null,mandateId:null}));
  }else{
   const rows=await tx.select({at:domainEvent.occurredAt}).from(domainEvent).where(and(eq(domainEvent.tenantId,ctx.tenantId),eq(domainEvent.eventType,record.eventType),
    eventWorkerSource(record))).orderBy(desc(domainEvent.occurredAt)).limit(RECENT);
   recentRuns=rows.map(item=>Object.freeze({at:item.at,runId:null,outcomeKind:null,humanInvolvement:null,decision:null,mandateId:null}));
  }
  const mandates=worker.authority.kind==='mandate'
   ?(await tx.select().from(terasMandate).where(and(eq(terasMandate.tenantId,ctx.tenantId),eq(terasMandate.jobType,worker.authority.jobType)))
     .orderBy(desc(terasMandate.createdAt),desc(terasMandate.id))).map(item=>Object.freeze({id:item.id,grantorUserId:item.grantorUserId,grantorPersonId:item.grantorPersonId,
      agentIdentity:`mandate-agent:${item.agentIdentityId}`,state:mandateState(item,now),validUntil:item.validUntil,revokedBy:item.revokedBy,version:item.version}))
   :[];
  return Object.freeze({worker:row,recentRuns:Object.freeze(recentRuns),mandates:Object.freeze(mandates)});
 });
}

/** Exact fields rendered by the Workers registry; omitted ownership/read-scope/reason
 * fields are not fabricated into a full WorkerRow. Full legacy services stay available. */
export type PageWorkerRow=Pick<WorkerRow,'id'|'label'|'family'|'trigger'|'effect'|'authority'|'switch'|'stopped'|'stopHonoured'|'gate'|'lastRunAt'|'mandates'>&Readonly<{metrics:PageWorkerMetrics}>;
export type PageWorkerRun=Omit<WorkerRun,'mandateId'>;
export type PageWorkerMandate=Pick<WorkerMandateRow,'id'|'state'|'validUntil'|'revokedBy'>;
export type PageWorkerDetail=Readonly<{worker:Pick<WorkerRow,'id'|'label'>;recentRuns:readonly PageWorkerRun[];mandates:readonly PageWorkerMandate[]}>;

/** Every old last-run answer is MAX(timestamp) over the same tenant/RLS/source predicate.
 * FILTER permits one scan per record kind; it neither deduplicates records nor chooses a tie row. */
async function pageLastRunsTx(tx:Tx,tenantId:string,workers:readonly WorkerDeclaration[]):Promise<ReadonlyMap<string,Date|null>>{
 const out=new Map<string,Date|null>(workers.map(worker=>[worker.id,null]));
 const collect=(group:readonly {worker:WorkerDeclaration}[],rows:readonly Record<string,Date|null>[])=>{
  group.forEach(({worker},i)=>out.set(worker.id,rows[0]?.['worker_'+i]??null));
 };
 const outcome=workers.flatMap(worker=>worker.record.kind==='outcome_record'?[{worker,record:worker.record}]:[]);
 if(outcome.length){
  const predicates=outcome.map(({record})=>and(eq(terasOutcomeRecord.agentIdentity,record.agentIdentity),outcomeWorkerTools(record))!);
  const columns:Record<string,SQL<Date|null>>=Object.fromEntries(predicates.map((predicate,i)=>['worker_'+i,sql<Date|null>`max(${terasOutcomeRecord.startedAt}) filter(where ${predicate})`.mapWith(terasOutcomeRecord.startedAt)]));
  collect(outcome,await tx.select(columns).from(terasOutcomeRecord).where(and(eq(terasOutcomeRecord.tenantId,tenantId),sql`(${sql.join(predicates,sql` or `)})`)));
 }
 const mandate=workers.flatMap(worker=>worker.record.kind==='mandate_runs'?[{worker,record:worker.record}]:[]);
 if(mandate.length){
  const columns:Record<string,SQL<Date|null>>=Object.fromEntries(mandate.map(({record},i)=>['worker_'+i,sql<Date|null>`max(${terasOutcomeRecord.startedAt}) filter(where ${terasMandate.jobType}=${record.jobType})`.mapWith(terasOutcomeRecord.startedAt)]));
  collect(mandate,await tx.select(columns).from(terasOutcomeRecord).innerJoin(terasMandate,and(eq(terasMandate.tenantId,terasOutcomeRecord.tenantId),eq(terasMandate.id,terasOutcomeRecord.mandateId)))
   .where(and(eq(terasOutcomeRecord.tenantId,tenantId),inArray(terasMandate.jobType,mandate.map(({record})=>record.jobType)))));
 }
 const proposals=workers.flatMap(worker=>worker.record.kind==='agent_proposal'?[{worker,record:worker.record}]:[]);
 if(proposals.length){
  const columns:Record<string,SQL<Date|null>>=Object.fromEntries(proposals.map(({record},i)=>['worker_'+i,sql<Date|null>`max(${agentProposal.proposedAt}) filter(where ${inArray(agentProposal.proposalType,[...record.proposalTypes])})`.mapWith(agentProposal.proposedAt)]));
  collect(proposals,await tx.select(columns).from(agentProposal).where(and(eq(agentProposal.tenantId,tenantId),inArray(agentProposal.proposalType,[...new Set(proposals.flatMap(({record})=>record.proposalTypes))]))));
 }
 const loops=workers.filter(worker=>worker.record.kind==='loop_runs');
 if(loops.length){
  const columns:Record<string,SQL<Date|null>>=Object.fromEntries(loops.map((worker,i)=>['worker_'+i,sql<Date|null>`max(${terasLoopRun.startedAt}) filter(where ${terasLoopRun.workerId}=${worker.id})`.mapWith(terasLoopRun.startedAt)]));
  collect(loops.map(worker=>({worker})),await tx.select(columns).from(terasLoopRun).where(and(eq(terasLoopRun.tenantId,tenantId),sql`(${sql.join(loops.map(worker=>sql`${terasLoopRun.workerId}=${worker.id}`),sql` or `)})`)));
 }
 const events=workers.flatMap(worker=>worker.record.kind==='domain_event'?[{worker,record:worker.record}]:[]);
 if(events.length){
  const predicates=events.map(({record})=>and(eq(domainEvent.eventType,record.eventType),eventWorkerSource(record))!);
  const columns:Record<string,SQL<Date|null>>=Object.fromEntries(predicates.map((predicate,i)=>['worker_'+i,sql<Date|null>`max(${domainEvent.occurredAt}) filter(where ${predicate})`.mapWith(domainEvent.occurredAt)]));
  collect(events,await tx.select(columns).from(domainEvent).where(and(eq(domainEvent.tenantId,tenantId),sql`(${sql.join(predicates,sql` or `)})`)));
 }
 return out;
}

/** One supplied snapshot, no provider issuance, nested transaction or execution gate. */
export async function listWorkersPageTx(tx:Tx,supplied:SessionContext,suppliedFacts:WorkerPageReadFacts):Promise<readonly PageWorkerRow[]>{
 const facts=captureWorkerPageReadFacts(suppliedFacts),ctx=await workerPageContextTx(tx,supplied),workers=registeredWorkers();
 const types=[...new Set(workers.flatMap(worker=>worker.metrics.kind==='agreement_view'?worker.metrics.proposalTypes:[]))];
 const rates=await workerAgreementPageRatesTx(tx,ctx,types),states=await workerPageSwitchesTx(tx,ctx,facts),lastRuns=await pageLastRunsTx(tx,ctx.tenantId,workers);
 const mandates=await tx.select({jobType:terasMandate.jobType,validFrom:terasMandate.validFrom,validUntil:terasMandate.validUntil,revokedAt:terasMandate.revokedAt})
  .from(terasMandate).where(eq(terasMandate.tenantId,ctx.tenantId));
 const rows:PageWorkerRow[]=[];
 for(const worker of workers){
  const fullMetric=worker.metrics.kind==='outcome_followups'&&worker.record.kind==='outcome_record'?await followupMetricsTx(tx,ctx.tenantId,worker.record.agentIdentity):null;
  const metrics=worker.metrics.kind==='agreement_view'?agreementPageMetrics(rates,worker.metrics.proposalTypes):fullMetric
   ?Object.freeze({measured:fullMetric.measured,acceptanceRate:fullMetric.acceptanceRate,reversalRate:fullMetric.reversalRate,decided:fullMetric.decided})
   :Object.freeze({measured:false,acceptanceRate:null,reversalRate:null,decided:0});
  const sw=states.switches.get(worker.id);if(!sw)throw new Error('Registered worker display switch missing.');
  const job=worker.authority.kind==='mandate'?worker.authority.jobType:null,own=job===null?null:mandates.filter(row=>row.jobType===job);
  rows.push(Object.freeze({id:worker.id,label:worker.label,family:worker.family,trigger:worker.trigger,effect:worker.effect,authority:worker.authority,
   switch:sw,stopped:states.stopped,stopHonoured:worker.stop.honoured,gate:workerGateFromState(sw.on,states.stopped),lastRunAt:lastRuns.get(worker.id)??null,metrics,
   mandates:own?Object.freeze({active:own.filter(row=>mandateState(row,facts.at)==='active').length,total:own.length}):null}));
 }
 return Object.freeze(rows);
}

/** Detail does not re-read the entire worker row, agreement or provider just for id/label. */
export async function workerDetailPageTx(tx:Tx,supplied:SessionContext,workerId:string,at:Date):Promise<PageWorkerDetail>{
 const id=workerId,now=new Date(at.getTime()),ctx=await workerPageContextTx(tx,supplied),worker=registeredWorker(id);
 if(!worker)throw new WorkerRegistryRefused('not_found');
 if(!Number.isFinite(now.getTime()))throw new WorkerRegistryRefused('not_found');
 const record=worker.record;let recentRuns:PageWorkerRun[]=[];
 if(record.kind==='outcome_record'||record.kind==='mandate_runs'){
  const fields={id:terasOutcomeRecord.id,at:terasOutcomeRecord.startedAt,runId:terasOutcomeRecord.runId,outcomeKind:terasOutcomeRecord.outcomeKind,humanInvolvement:terasOutcomeRecord.humanInvolvement};
  const runs=record.kind==='outcome_record'
   ?await tx.select(fields).from(terasOutcomeRecord).where(and(eq(terasOutcomeRecord.tenantId,ctx.tenantId),eq(terasOutcomeRecord.agentIdentity,record.agentIdentity),
    outcomeWorkerTools(record)))
    .orderBy(desc(terasOutcomeRecord.startedAt),desc(terasOutcomeRecord.id)).limit(RECENT)
   :await tx.select(fields).from(terasOutcomeRecord).innerJoin(terasMandate,and(eq(terasMandate.tenantId,terasOutcomeRecord.tenantId),eq(terasMandate.id,terasOutcomeRecord.mandateId)))
    .where(and(eq(terasOutcomeRecord.tenantId,ctx.tenantId),eq(terasMandate.jobType,record.jobType))).orderBy(desc(terasOutcomeRecord.startedAt),desc(terasOutcomeRecord.id)).limit(RECENT);
  const ids=runs.map(run=>run.id),followups=ids.length?await tx.select({recordId:terasOutcomeFollowup.recordId,decision:terasOutcomeFollowup.decision,at:terasOutcomeFollowup.at}).from(terasOutcomeFollowup)
   .where(and(eq(terasOutcomeFollowup.tenantId,ctx.tenantId),inArray(terasOutcomeFollowup.recordId,ids))).orderBy(terasOutcomeFollowup.at):[];
  recentRuns=runs.map(run=>Object.freeze({at:run.at,runId:run.runId,outcomeKind:run.outcomeKind,humanInvolvement:run.humanInvolvement,
   decision:followups.filter(item=>item.recordId===run.id&&item.decision).at(-1)?.decision??null}));
 }else if(record.kind==='agent_proposal'){
  const runs=await tx.select({at:agentProposal.proposedAt,decision:agentProposal.decision}).from(agentProposal)
   .where(and(eq(agentProposal.tenantId,ctx.tenantId),inArray(agentProposal.proposalType,[...record.proposalTypes]))).orderBy(desc(agentProposal.proposedAt)).limit(RECENT);
  recentRuns=runs.map(run=>Object.freeze({at:run.at,runId:null,outcomeKind:null,humanInvolvement:null,decision:run.decision}));
 }else if(record.kind==='loop_runs'){
  const runs=await tx.select({at:terasLoopRun.startedAt,runId:terasLoopRun.runId,status:terasLoopRun.status}).from(terasLoopRun)
   .where(and(eq(terasLoopRun.tenantId,ctx.tenantId),sql`${terasLoopRun.workerId}=${worker.id}`)).orderBy(desc(terasLoopRun.startedAt),desc(terasLoopRun.id)).limit(RECENT);
  recentRuns=runs.map(run=>Object.freeze({at:run.at,runId:run.runId,outcomeKind:run.status==='ran'?'prepared':'stopped',humanInvolvement:'none',decision:null}));
 }else{
  const runs=await tx.select({at:domainEvent.occurredAt}).from(domainEvent).where(and(eq(domainEvent.tenantId,ctx.tenantId),eq(domainEvent.eventType,record.eventType),
   eventWorkerSource(record))).orderBy(desc(domainEvent.occurredAt)).limit(RECENT);
  recentRuns=runs.map(run=>Object.freeze({at:run.at,runId:null,outcomeKind:null,humanInvolvement:null,decision:null}));
 }
 const mandates=worker.authority.kind==='mandate'?(await tx.select({id:terasMandate.id,validFrom:terasMandate.validFrom,validUntil:terasMandate.validUntil,revokedAt:terasMandate.revokedAt,revokedBy:terasMandate.revokedBy}).from(terasMandate)
  .where(and(eq(terasMandate.tenantId,ctx.tenantId),eq(terasMandate.jobType,worker.authority.jobType))).orderBy(desc(terasMandate.createdAt),desc(terasMandate.id)))
  .map(row=>Object.freeze({id:row.id,state:mandateState(row,now),validUntil:row.validUntil,revokedBy:row.revokedBy})):[];
 return Object.freeze({worker:Object.freeze({id:worker.id,label:worker.label}),recentRuns:Object.freeze(recentRuns),mandates:Object.freeze(mandates)});
}
