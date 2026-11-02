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
import {and,count,desc,eq,inArray,max,sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {agentProposal,domainEvent} from '../../db/schema';
import {terasMandate,terasOutcomeFollowup,terasOutcomeRecord} from '../../db/teras-schema';
import {isGroupAdmin} from '../../lib/authz-model';
import {agreementView,type AgreementView} from '../control-tower';
import {mandateState,type MandateState} from '../mandates/mandates';
import {tenantStoppedTx,workerRunGateTx,workerSwitchStateTx,type WorkerGate,type WorkerSwitchState} from './controls';
import {registeredWorker,registeredWorkers,type WorkerDeclaration} from './workers';

export class WorkerRegistryRefused extends Error{constructor(readonly reason:'not_administrator'|'not_found'){super('Worker registry refused: '+reason);this.name='WorkerRegistryRefused';}}
const requireAdmin=(ctx:SessionContext)=>{if(!ctx.userId||ctx.agent||!isGroupAdmin(ctx))throw new WorkerRegistryRefused('not_administrator');};

export type WorkerMetricsView=Readonly<{measured:boolean;acceptanceRate:number|null;reversalRate:number|null;decided:number;reason:string|null}>;
export type WorkerRow=Readonly<{id:string;label:string;family:WorkerDeclaration['family'];trigger:WorkerDeclaration['trigger'];readScope:readonly string[];
 effect:WorkerDeclaration['effect'];authority:WorkerDeclaration['authority'];owners:readonly string[];
 switch:WorkerSwitchState;stopped:boolean;stopHonoured:boolean;stopPending:string|null;gate:WorkerGate;
 lastRunAt:Date|null;metrics:WorkerMetricsView;mandates:Readonly<{active:number;total:number}>|null}>;

/** When the worker last ran, from where its declaration says runs are recorded. */
async function lastRunTx(tx:Tx,tenantId:string,worker:WorkerDeclaration):Promise<Date|null>{
 const record=worker.record;
 if(record.kind==='outcome_record'){
  const tools=record.tools?sql`(${sql.join(record.tools.map(tool=>sql`${terasOutcomeRecord.reads} @> ${JSON.stringify([{tool}])}::jsonb`),sql` or `)})`:undefined;
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
 const [row]=await tx.select({at:max(domainEvent.occurredAt)}).from(domainEvent)
  .where(and(eq(domainEvent.tenantId,tenantId),eq(domainEvent.eventType,record.eventType),
   record.source?sql`${domainEvent.payload}->>'source'=${record.source}`:undefined));
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
 const rows=view.rates.filter(row=>types.includes(row.type));
 const approved=rows.reduce((n,row)=>n+row.approved,0),declined=rows.reduce((n,row)=>n+row.declined,0);
 // agreementView already blanks reversal rates that are not yet honest; keep its null.
 const reversal=rows.length===1?rows[0].reversalRate:null;
 return Object.freeze({measured:approved+declined>0,acceptanceRate:rate(approved,approved+declined),reversalRate:reversal,decided:approved+declined,
  reason:approved+declined>0?null:view.blockedBy.length?`Not measured yet: ${view.blockedBy.join(', ')}.`:'Nobody has decided on one of its suggestions yet.'});
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
    :Object.freeze({measured:false,acceptanceRate:null,reversalRate:null,decided:0,reason:worker.metrics.kind==='not_measurable'?worker.metrics.reason:'Not measured.'});
   const own=worker.authority.kind==='mandate'?mandates.filter(row=>row.jobType===(worker.authority as {jobType:string}).jobType):null;
   out.push(Object.freeze({id:worker.id,label:worker.label,family:worker.family,trigger:worker.trigger,readScope:worker.readScope,effect:worker.effect,
    authority:worker.authority,owners:worker.owners,switch:await workerSwitchStateTx(tx,ctx,worker),stopped,stopHonoured:worker.stop.honoured,
    stopPending:worker.stop.honoured?null:worker.stop.pending,gate:await workerRunGateTx(tx,ctx,worker.id),lastRunAt:await lastRunTx(tx,ctx.tenantId,worker),metrics,
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
      record.tools?sql`(${sql.join(record.tools.map(tool=>sql`${terasOutcomeRecord.reads} @> ${JSON.stringify([{tool}])}::jsonb`),sql` or `)})`:undefined))
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
  }else{
   const rows=await tx.select({at:domainEvent.occurredAt}).from(domainEvent).where(and(eq(domainEvent.tenantId,ctx.tenantId),eq(domainEvent.eventType,record.eventType),
    record.source?sql`${domainEvent.payload}->>'source'=${record.source}`:undefined)).orderBy(desc(domainEvent.occurredAt)).limit(RECENT);
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
