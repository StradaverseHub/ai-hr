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
import {terasMandateControl,terasWorkerControl,type TerasSwitchedWorker} from '../../db/teras-schema';
import {isGroupAdmin} from '../../lib/authz-model';
import {agentSwitchStatesTx} from '../agent-principal';
import {resolveActiveAiConfig} from '../ai-config';
import {readMandateKeysTx} from '../mandates/mandates';
import {registeredWorker,registeredWorkers,type WorkerDeclaration} from './workers';

export class WorkerControlRefused extends Error{constructor(readonly reason:'not_administrator'|'not_switchable_here'|'invalid'){super('Worker control refused: '+reason);this.name='WorkerControlRefused';}}
const SWITCHED:readonly TerasSwitchedWorker[]=Object.freeze(['approver_recommendation','explainers']);

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

/** A group administrator turns a teras_worker_control worker on or off. Workers with an existing switch are
 * changed where that switch lives, never here. */
export async function setWorkerSwitch(supplied:SessionContext,input:Readonly<{workerId:unknown;enabled:unknown}>){
 const ctx:SessionContext={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(grant=>({...grant}))};
 if(!ctx.userId||ctx.agent||!isGroupAdmin(ctx))throw new WorkerControlRefused('not_administrator');
 if(typeof input.enabled!=='boolean'||typeof input.workerId!=='string')throw new WorkerControlRefused('invalid');
 const worker=registeredWorker(input.workerId);
 if(!worker||worker.switch.kind!=='worker_control'||!SWITCHED.includes(worker.switch.workerId))throw new WorkerControlRefused('not_switchable_here');
 const workerId=worker.switch.workerId,enabled=input.enabled;
 return withTenant(ctx,async tx=>{
  const values={enabled,changedByUserId:ctx.userId!,changedAt:sql`now()`};
  const [row]=await tx.insert(terasWorkerControl).values({tenantId:ctx.tenantId,workerId,...values})
   .onConflictDoUpdate({target:[terasWorkerControl.tenantId,terasWorkerControl.workerId],set:values}).returning();
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'teras-worker',aggregateId:ctx.tenantId,
   eventType:enabled?'teras-worker.enabled':'teras-worker.disabled',actor:actorOf(ctx),payload:{workerId,version:row.version}});
  return Object.freeze(row);
 });
}
