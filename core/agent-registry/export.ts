/** ADR-0170 §3.11 and §11.3 changes 5 and 6, step 5 — the customer-facing outcome summary and the export of the
 * agent registry.
 *
 * outcomeSummary: what the AI did in this tenant, from outcome records: runs per worker and family, outcome
 * kinds, how far people were involved, notice, decisions (accepted, rejected, undone) and per-mandate runs.
 * Counts, families, verdict names and opaque ids only: no name, question, reply or HR record, so it holds
 * nothing beyond the tenant's own audit view.
 *
 * exportAgentRegistry: every registered worker and every mandate agent, each as an agent identity a customer's
 * own control tower can register: a stable id, a display name, the family, its sponsor (the tenant's
 * administrators, or the grantor for a mandate), how it acts (for the requester, as the tenant's agent
 * principal, or delegated by a grantor — never autonomous), its permissions (read scope from the semantic
 * model) and its effect. The shape leaves room for a Microsoft Entra Agent ID or Google Agent Identity adapter;
 * none is built here and nothing is sent anywhere (§11.3 change 6: no auto-linking of identities, ADR-0117).
 *
 * Both read only the caller's tenant (tenant filter plus RLS) and are for group administrators. */
import {and,count,eq,gte} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../../db/client';
import {terasMandate,terasOutcomeFollowup,terasOutcomeRecord} from '../../db/teras-schema';
import {mandateAgentIdentity,mandateState} from '../mandates/mandates';
import {terasEntity} from '../semantic-model/generate';
import {listWorkers,WorkerRegistryRefused} from './views';
import {registeredWorkers,type WorkerDeclaration,type WorkerFamily} from './workers';
import {isGroupAdmin} from '../../lib/authz-model';

export const AGENT_REGISTRY_EXPORT_VERSION=1 as const;
type Counts=Record<string,number>;
export type WorkerOutcomes=Readonly<{workerId:string;family:WorkerFamily|null;runs:number;outcomeKinds:Readonly<Counts>;humanInvolvement:Readonly<Counts>;
 notice:Readonly<Counts>;decisions:Readonly<Counts>}>;
export type MandateOutcomes=Readonly<{mandateId:string;jobType:string;runs:number;outcomeKinds:Readonly<Counts>}>;
export type OutcomeSummary=Readonly<{tenantId:string;since:string|null;records:number;byWorker:readonly WorkerOutcomes[];byFamily:Readonly<Counts>;
 mandates:readonly MandateOutcomes[]}>;

/** The worker a record belongs to, from its agent identity or its mandate's job type. Unregistered
 * identities (Assistant turns other than explainers) are reported as their identity, with no family. */
function workerOf(agentIdentity:string,jobType:string|null,reads:readonly {tool:string}[]):string{
 for(const worker of registeredWorkers()){
  const record=worker.record;
  if(record.kind==='mandate_runs'&&jobType===record.jobType)return worker.id;
  if(record.kind==='outcome_record'&&record.agentIdentity===agentIdentity&&(!record.tools||reads.some(read=>record.tools!.includes(read.tool))))return worker.id;
 }
 return agentIdentity.startsWith('mandate-agent:')?`mandate:${jobType??'unknown'}`:agentIdentity;
}
const bump=(counts:Counts,key:string,by=1)=>{counts[key]=(counts[key]??0)+by;};

export async function outcomeSummary(ctx:SessionContext,options:Readonly<{since?:Date}>={}):Promise<OutcomeSummary>{
 if(!ctx.userId||ctx.agent||!isGroupAdmin(ctx))throw new WorkerRegistryRefused('not_administrator');
 return withTenant(ctx,async tx=>{
  const since=options.since?gte(terasOutcomeRecord.startedAt,options.since):undefined;
  const records=await tx.select({id:terasOutcomeRecord.id,agentIdentity:terasOutcomeRecord.agentIdentity,mandateId:terasOutcomeRecord.mandateId,
   jobType:terasMandate.jobType,reads:terasOutcomeRecord.reads,outcomeKind:terasOutcomeRecord.outcomeKind,humanInvolvement:terasOutcomeRecord.humanInvolvement,notice:terasOutcomeRecord.notice})
   .from(terasOutcomeRecord).leftJoin(terasMandate,and(eq(terasMandate.tenantId,terasOutcomeRecord.tenantId),eq(terasMandate.id,terasOutcomeRecord.mandateId)))
   .where(and(eq(terasOutcomeRecord.tenantId,ctx.tenantId),since));
  const decisions=await tx.select({recordId:terasOutcomeFollowup.recordId,decision:terasOutcomeFollowup.decision,n:count()}).from(terasOutcomeFollowup)
   .innerJoin(terasOutcomeRecord,and(eq(terasOutcomeRecord.tenantId,terasOutcomeFollowup.tenantId),eq(terasOutcomeRecord.id,terasOutcomeFollowup.recordId)))
   .where(and(eq(terasOutcomeFollowup.tenantId,ctx.tenantId),since)).groupBy(terasOutcomeFollowup.recordId,terasOutcomeFollowup.decision);
  const families=new Map(registeredWorkers().map(worker=>[worker.id,worker.family]));
  const workers=new Map<string,{runs:number;outcomeKinds:Counts;humanInvolvement:Counts;notice:Counts;decisions:Counts}>();
  const mandates=new Map<string,{jobType:string;runs:number;outcomeKinds:Counts}>();
  const recordWorker=new Map<string,string>();
  for(const record of records){
   const id=workerOf(record.agentIdentity,record.jobType??null,record.reads??[]);recordWorker.set(record.id,id);
   const row=workers.get(id)??{runs:0,outcomeKinds:{},humanInvolvement:{},notice:{},decisions:{}};workers.set(id,row);
   row.runs++;bump(row.outcomeKinds,record.outcomeKind);bump(row.humanInvolvement,record.humanInvolvement);bump(row.notice,record.notice);
   if(record.mandateId){const m=mandates.get(record.mandateId)??{jobType:record.jobType??'unknown',runs:0,outcomeKinds:{}};mandates.set(record.mandateId,m);m.runs++;bump(m.outcomeKinds,record.outcomeKind);}
  }
  for(const item of decisions){const id=recordWorker.get(item.recordId);if(id&&item.decision)bump(workers.get(id)!.decisions,item.decision,Number(item.n));}
  const byWorker=[...workers].map(([workerId,row])=>Object.freeze({workerId,family:families.get(workerId)??null,...row})).sort((a,b)=>a.workerId.localeCompare(b.workerId));
  const byFamily:Counts={};for(const row of byWorker)bump(byFamily,row.family??'unregistered',row.runs);
  return Object.freeze({tenantId:ctx.tenantId,since:options.since?.toISOString()??null,records:records.length,byWorker:Object.freeze(byWorker),byFamily:Object.freeze(byFamily),
   mandates:Object.freeze([...mandates].map(([mandateId,row])=>Object.freeze({mandateId,...row})).sort((a,b)=>a.mandateId.localeCompare(b.mandateId)))});
 });
}

export type ExportedAgent=Readonly<{agentId:string;displayName:string;kind:'worker'|'mandate_agent';family:WorkerFamily;
 sponsor:Readonly<{kind:'tenant_administrators'}>|Readonly<{kind:'person';userId:string}>;
 /** How it acts. Every mandate agent acts for its grantor; nothing is autonomous. */
 actsAs:'for_requester'|'tenant_agent_principal'|'for_grantor';autonomous:false;
 permissions:readonly Readonly<{entity:string;label:string}>[];effect:WorkerDeclaration['effect'];trigger:string;
 status:'enabled'|'disabled'|'stopped'|'revoked'|'expired'|'not_started';lastRunAt:string|null;workerId:string}>;
export type AgentRegistryExport=Readonly<{kind:'teras.agent_registry_export';version:typeof AGENT_REGISTRY_EXPORT_VERSION;generatedAt:string;tenantId:string;
 agents:readonly ExportedAgent[];outcomes:OutcomeSummary;
 /** Identity-provider adapters: none is built. A later adapter maps `agents` onto its own registration. */
 adapters:Readonly<{entraAgentId:null;googleAgentIdentity:null}>}>;

const permissions=(worker:WorkerDeclaration)=>Object.freeze(worker.readScope.map(entity=>Object.freeze({entity,label:terasEntity(entity).label})));

export async function exportAgentRegistry(ctx:SessionContext,options:Readonly<{since?:Date;now?:Date}>={}):Promise<AgentRegistryExport>{
 const now=options.now??new Date();
 const rows=await listWorkers(ctx);
 const outcomes=await outcomeSummary(ctx,{since:options.since});
 const mandates=await withTenant(ctx,tx=>tx.select().from(terasMandate).where(eq(terasMandate.tenantId,ctx.tenantId)));
 const declarations=new Map(registeredWorkers().map(worker=>[worker.id,worker]));
 const agents:ExportedAgent[]=[];
 for(const row of rows){
  const worker=declarations.get(row.id)!;
  if(worker.authority.kind==='mandate')continue;// listed per mandate below: one agent identity per mandate (§3.10 rule 9)
  agents.push(Object.freeze({agentId:`teras-worker:${worker.id}`,displayName:worker.label,kind:'worker' as const,family:worker.family,sponsor:Object.freeze({kind:'tenant_administrators' as const}),
   actsAs:worker.authority.actsAs==='requester'?'for_requester' as const:'tenant_agent_principal' as const,autonomous:false as const,permissions:permissions(worker),
   effect:worker.effect,trigger:worker.trigger.kind,status:row.stopped?'stopped' as const:row.switch.on?'enabled' as const:'disabled' as const,
   lastRunAt:row.lastRunAt?.toISOString()??null,workerId:worker.id}));
 }
 for(const mandate of mandates.sort((a,b)=>a.createdAt.getTime()-b.createdAt.getTime()||a.id.localeCompare(b.id))){
  const worker=registeredWorkers().find(item=>item.authority.kind==='mandate'&&item.authority.jobType===mandate.jobType);
  if(!worker)continue;
  const row=rows.find(item=>item.id===worker.id)!,state=mandateState(mandate,now);
  agents.push(Object.freeze({agentId:mandateAgentIdentity(mandate),displayName:`${worker.label} (delegated)`,kind:'mandate_agent' as const,family:worker.family,
   sponsor:Object.freeze({kind:'person' as const,userId:mandate.grantorUserId}),actsAs:'for_grantor' as const,autonomous:false as const,permissions:permissions(worker),
   effect:worker.effect,trigger:worker.trigger.kind,status:state!=='active'?state:row.stopped?'stopped' as const:row.switch.on?'enabled' as const:'disabled' as const,
   lastRunAt:null,workerId:worker.id}));
 }
 return Object.freeze({kind:'teras.agent_registry_export' as const,version:AGENT_REGISTRY_EXPORT_VERSION,generatedAt:now.toISOString(),tenantId:ctx.tenantId,
  agents:Object.freeze(agents),outcomes,adapters:Object.freeze({entraAgentId:null,googleAgentIdentity:null})});
}
