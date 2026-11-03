/** ADR-0170 §3.13 step 5 — the per-tenant worker switches and the run gate.
 *
 * Each registered worker's switch is read from the owner that already holds it (./workers.ts): the tenant
 * setting of an agent specialist (attributed switch-on only, as the agent principal requires), the tenant's
 * active AI provider, mandate job-type enablement (key 1), or teras_worker_control for the workers with no
 * switch of their own. All are off by default. The tenant-wide stop switch is the mandate stop switch
 * (teras_mandate_control.stopped): one stop for every worker and every mandate.
 *
 * workerRunGate is the single question a worker asks before it runs: registered, switched on, not stopped.
 * A worker id outside the loaded registry never runs. */
import {and,eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {actorOf,appendEvent} from '../../db/events';
import {terasMandateControl,terasWorkerControl,type TerasAttestedProvider,type TerasSwitchedWorker} from '../../db/teras-schema';
import {isGroupAdmin} from '../../lib/authz-model';
import {agentSwitchStatesTx} from '../agent-principal';
import {resolveActiveAiConfig} from '../ai-config';
import {isModuleEnabled} from '../entitlements';
import {readMandateKeysTx} from '../mandates/mandates';
import {newRunId,writeOutcomeRecordTx} from '../outcome-record/record';
import {registeredWorker,registeredWorkers,type WorkerDeclaration} from './workers';

export class WorkerControlRefused extends Error{constructor(readonly reason:'not_administrator'|'not_switchable_here'|'module_not_enabled'|'invalid'|'attestation_not_applicable'){super('Worker control refused: '+reason);this.name='WorkerControlRefused';}}
const SWITCHED:readonly TerasSwitchedWorker[]=Object.freeze(['approver_recommendation','explainers','conversation',
 // AI v2 W8 (migration 0960): the five loops at the Prepare level.
 'loop_probation_ending','loop_payroll_inputs','loop_missing_employee_data','loop_missed_clock_outs','loop_document_expiry',
 // AI v2 P2-2b (migration 0965): the payroll Audit loop.
 'loop_payroll_audit']);
/** The module each registry-controlled worker belongs to, checked on every switch change. */
const SWITCHED_MODULE:Readonly<Record<TerasSwitchedWorker,string>>=Object.freeze({approver_recommendation:'leave',explainers:'assistant',conversation:'assistant',
 loop_probation_ending:'employees',loop_payroll_inputs:'payroll',loop_missing_employee_data:'employees',loop_missed_clock_outs:'attendance',loop_document_expiry:'employees',
 // AI v2 P2-2b: the Audit loop's work is payroll.
 loop_payroll_audit:'payroll'});
/** AI v2 W8: the module a loop's work belongs to; the loop runs only while it is enabled for the tenant. */
export const workerModule=(workerId:TerasSwitchedWorker):string=>SWITCHED_MODULE[workerId];
const DIRECT_PROVIDERS:readonly TerasAttestedProvider[]=Object.freeze(['anthropic','openai','google']);
/** The outcome-record identity of an administrator's switch change. It is not a worker run, so the outcome
 * summary leaves it out of the run counts (./export.ts). */
export const WORKER_SWITCH_IDENTITY='worker-control.switch';

export type WorkerSwitchState=Readonly<{on:boolean;
 /** Where the switch lives, so the screen sends the administrator to the one place that changes it. */
 owner:'tenant_setting'|'ai_provider'|'job_type'|'worker_control';
 /** A tenant setting that is on but not attributed to an administrator does not run under the principal. */
 detail:'off'|'on'|'unattributed'}>;

/** The worker's switch as of this transaction. */
export async function workerSwitchStateTx(tx:Tx,ctx:SessionContext,worker:WorkerDeclaration):Promise<WorkerSwitchState>{
 const sw=worker.switch;
 if(sw.kind==='tenant_setting'){
  const state=(await agentSwitchStatesTx(tx,ctx)).find(row=>row.feature===sw.feature);
  const detail=state?.state==='attributed'?'on':state?.state==='unattributed'?'unattributed':'off';
  return Object.freeze({on:detail==='on',owner:'tenant_setting',detail});
 }
 if(sw.kind==='ai_provider'){const on=(await resolveActiveAiConfig(tx,ctx,sw.feature))!=null;return Object.freeze({on,owner:'ai_provider',detail:on?'on':'off'});}
 if(sw.kind==='job_type'){const on=(await readMandateKeysTx(tx,ctx.tenantId,sw.jobType)).enablement?.enabled===true;return Object.freeze({on,owner:'job_type',detail:on?'on':'off'});}
 const [row]=await tx.select({enabled:terasWorkerControl.enabled}).from(terasWorkerControl)
  .where(and(eq(terasWorkerControl.tenantId,ctx.tenantId),eq(terasWorkerControl.workerId,sw.workerId))).limit(1);
 const on=row?.enabled===true;
 return Object.freeze({on,owner:'worker_control',detail:on?'on':'off'});
}

/** The tenant-wide stop switch. No row means not stopped. */
export async function tenantStoppedTx(tx:Tx,tenantId:string):Promise<boolean>{
 const [row]=await tx.select({stopped:terasMandateControl.stopped}).from(terasMandateControl).where(eq(terasMandateControl.tenantId,tenantId)).limit(1);
 return row?.stopped===true;
}

export type WorkerGate=Readonly<{run:boolean;reasons:readonly ('not_registered'|'switched_off'|'stopped')[]}>;
/** Registered, switched on and not stopped, all read in the caller's transaction. */
export async function workerRunGateTx(tx:Tx,ctx:SessionContext,workerId:string):Promise<WorkerGate>{
 const worker=registeredWorker(workerId);
 if(!worker)return Object.freeze({run:false,reasons:Object.freeze(['not_registered' as const])});
 const reasons:('switched_off'|'stopped')[]=[];
 if(!(await workerSwitchStateTx(tx,ctx,worker)).on)reasons.push('switched_off');
 if(await tenantStoppedTx(tx,ctx.tenantId))reasons.push('stopped');
 return Object.freeze({run:reasons.length===0,reasons:Object.freeze(reasons)});
}
export const workerRunGate=(ctx:SessionContext,workerId:string)=>withTenant(ctx,tx=>workerRunGateTx(tx,ctx,workerId));
/** Every registered worker's gate, for the stop switch's effect on the whole registry. */
export async function registryGates(ctx:SessionContext):Promise<Readonly<Record<string,WorkerGate>>>{
 return withTenant(ctx,async tx=>{const out:Record<string,WorkerGate>={};for(const worker of registeredWorkers())out[worker.id]=await workerRunGateTx(tx,ctx,worker.id);return Object.freeze(out);});
}

/** A group administrator turns a teras_worker_control worker on or off, while the worker's module is enabled.
 * The change is audited (actor, time, worker, state before and after) and recorded as an outcome. Workers
 * with an existing switch are changed where that switch lives, never here.
 *
 * The Noveri conversation switch may also carry `attestDirectProvider`: the administrator confirms that the
 * tenant's active direct upstream provider account (Anthropic, OpenAI or Google) has zero data retention and no
 * training terms. The attestation is recorded for that provider only; switching off or switching on without it
 * clears it. It is refused for any other worker. */
export async function setWorkerSwitch(supplied:SessionContext,input:Readonly<{workerId:unknown;enabled:unknown;attestDirectProvider?:unknown}>){
 const ctx:SessionContext={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(grant=>({...grant}))};
 if(!ctx.userId||ctx.agent||!isGroupAdmin(ctx))throw new WorkerControlRefused('not_administrator');
 if(typeof input.enabled!=='boolean'||typeof input.workerId!=='string'||(input.attestDirectProvider!==undefined&&typeof input.attestDirectProvider!=='boolean'))throw new WorkerControlRefused('invalid');
 const worker=registeredWorker(input.workerId);
 if(!worker||worker.switch.kind!=='worker_control'||!SWITCHED.includes(worker.switch.workerId))throw new WorkerControlRefused('not_switchable_here');
 const workerId=worker.switch.workerId,enabled=input.enabled,attest=input.attestDirectProvider===true;
 if(attest&&workerId!=='conversation')throw new WorkerControlRefused('attestation_not_applicable');
 if(!isModuleEnabled(ctx,SWITCHED_MODULE[workerId]))throw new WorkerControlRefused('module_not_enabled');
 return withTenant(ctx,async tx=>{
  const startedAt=new Date();
  // The attestation names the provider active now; a later change of provider is not covered by it.
  let attestedProvider:TerasAttestedProvider|null=null;
  if(attest&&enabled){
   const active=(await resolveActiveAiConfig(tx,ctx,'hr_assistant'))?.provider;
   if(!active||!(DIRECT_PROVIDERS as readonly string[]).includes(active))throw new WorkerControlRefused('attestation_not_applicable');
   attestedProvider=active as TerasAttestedProvider;
  }
  const values={enabled,changedByUserId:ctx.userId!,changedByOperator:null,changedAt:sql`now()`,...(workerId==='conversation'?{attestedProvider}:{})};
  // First change: insert the row, or do nothing when it exists. ON CONFLICT waits for a concurrent first insert to
  // commit, so exactly one caller creates the row (from: no row, i.e. off). Everyone else then locks the existing row
  // and reads the state before their change; SELECT ... FOR UPDATE alone locks nothing while no row exists.
  const [inserted]=await tx.insert(terasWorkerControl).values({tenantId:ctx.tenantId,workerId,...values})
   .onConflictDoNothing({target:[terasWorkerControl.tenantId,terasWorkerControl.workerId]}).returning();
  let from=false,row=inserted;
  if(!inserted){
   const [before]=await tx.select({enabled:terasWorkerControl.enabled}).from(terasWorkerControl)
    .where(and(eq(terasWorkerControl.tenantId,ctx.tenantId),eq(terasWorkerControl.workerId,workerId))).limit(1).for('update');
   from=before?.enabled===true;
   [row]=await tx.update(terasWorkerControl).set(values)
    .where(and(eq(terasWorkerControl.tenantId,ctx.tenantId),eq(terasWorkerControl.workerId,workerId))).returning();
  }
  if(!row)throw new WorkerControlRefused('not_administrator');
  // Audit: who (the event actor), when (the event time), which worker, and the state before and after.
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'teras-worker',aggregateId:ctx.tenantId,
   eventType:enabled?'teras-worker.enabled':'teras-worker.disabled',actor:actorOf(ctx),payload:{workerId,from,to:enabled,version:row.version,...(workerId==='conversation'?{attestedProvider}:{})}});
  await writeOutcomeRecordTx(tx,ctx,{runId:newRunId(),runKind:'turn',startedAt,finishedAt:new Date(Math.max(Date.now(),startedAt.getTime())),
   authority:{kind:'person',askedByUserId:ctx.userId!},agentIdentity:WORKER_SWITCH_IDENTITY,reads:[],checks:[],
   replay:{model:null,provider:null,instructionSet:null,specVersion:null,specDigest:null,toolCatalogue:null},
   outcomeKind:'done',outcome:{workerId,from,to:enabled,version:row.version,...(workerId==='conversation'?{attestedProvider}:{})},humanInvolvement:'decided',notice:'not_applicable'});
  return Object.freeze(row);
 });
}
