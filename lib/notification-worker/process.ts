/** Uninstalled functional process prototype. Native APIs own authority and counts.
 * No app pool, owner connection, generic SQL port or automatic replay/reconnect. */
import type {Sql} from 'postgres';
import {z} from 'zod';
import {isModuleEnabled,toSnapshot} from '../../core/entitlements';
import {notificationWorkerLifecycle,type NativeNotificationScope,type NotificationWorkerFailure} from './lifecycle';
import {notificationWorkerProjection,UnsupportedNotificationFacts} from './projection';

/** Strictly below the owned native 25-event/10-batch/300s/100-tenant profile.
 * An incompatible native profile refuses; these are no installation defaults. */
export const notificationProcessBounds=Object.freeze({events:20,batches:8,tenants:50,milliseconds:240000,page:25});
const nativeModules=z.object({tenantStatus:z.string(),modules:z.array(z.object({
 moduleCode:z.string(),companyId:z.uuid().nullable(),status:z.string(),
 expiresAt:z.string().refine(value=>Number.isFinite(Date.parse(value))).nullable(),
}).strict())}).strict();
export type NotificationProcessTransition=
 |Readonly<{kind:'opened';run:string}>
 |Readonly<{kind:'admitting';run:string}>
 |Readonly<{kind:'committed';run:string;processed:number;created:number}>
 |Readonly<{kind:'finished';run:string}>
 |Readonly<{kind:'failed';run:string;reason:NotificationWorkerFailure}>;
export type NotificationProcessControl={
 readonly stopping:()=>boolean;
 /** Observation only; never supplies authority, scope, counters or SQL. The
  * test child uses it to pause at a known post-COMMIT point for real SIGKILL. */
 readonly observe?:(transition:NotificationProcessTransition)=>Promise<void>;
};
function allowed(scope:NativeNotificationScope){
 const facts=nativeModules.parse(scope.entitlement_facts);
 if(facts.tenantStatus!==scope.standing)throw Error('Native notification scope mismatch');
 const now=Date.now(),modules=facts.modules.filter(row=>['active','trial'].includes(row.status)&&(!row.expiresAt||Date.parse(row.expiresAt)>now));
 const context={tenantId:scope.tenant_id,entitlements:toSnapshot(scope.tenant_id,{
  tenant_status:scope.standing,settings:{},modules:modules.map(row=>({code:row.moduleCode,company:row.companyId})),
 })};
 if(scope.consumer==='notifications')return isModuleEnabled(context,'notifications');
 return scope.consumer==='assessment-reminders'&&modules.some(row=>row.companyId&&isModuleEnabled(context,'notifications',row.companyId));
}
/** The caller owns connection teardown. An error never triggers another batch.
 * In particular, a lost/uncertain commit is not permission to replay or settle. */
export async function runNotificationProcess(connection:Sql,control:NotificationProcessControl){
 const lifecycle=notificationWorkerLifecycle(connection),projection=notificationWorkerProjection(connection);
 let run:string|undefined,batches=0,tenants=0,after:string|null=null;
 const started=Date.now(),emit=async(value:NotificationProcessTransition)=>{await control.observe?.(Object.freeze(value));};
 const exhausted=()=>batches>=notificationProcessBounds.batches||Date.now()-started>=notificationProcessBounds.milliseconds;
 const fail=async(reason:NotificationWorkerFailure)=>{if(!run)throw Error('Notification run was not admitted');await lifecycle.failRun(run,reason);await emit({kind:'failed',run,reason});return{state:'failed' as const,run,reason};};
 if(control.stopping())return{state:'not-started' as const};
 run=await lifecycle.openRun(); // First native query validates the actual LOGIN/profile.
 await emit({kind:'opened',run});
 for(;;){
  if(control.stopping())return fail('interrupted');
  if(exhausted())return fail('budget-exhausted');
  const scopes=await lifecycle.scopePage(run,after,notificationProcessBounds.page);
  if(!scopes.length){await lifecycle.finishRun(run);await emit({kind:'finished',run});return{state:'completed' as const,run};}
  for(const scope of scopes){
   if(++tenants>notificationProcessBounds.tenants)return fail('budget-exhausted');
   if(control.stopping())return fail('interrupted');
   if(!scope.consumer){await lifecycle.settleScope(run,scope.tenant_id,'disabled');after=scope.tenant_id;continue;}
   if(!allowed(scope)){await lifecycle.settleScope(run,scope.tenant_id,'disabled');return fail('scope-changed');}
   for(;;){
    if(control.stopping())return fail('interrupted');
    if(exhausted()){await lifecycle.settleScope(run,scope.tenant_id,'capped');return fail('budget-exhausted');}
    if(!allowed(scope)){await lifecycle.settleScope(run,scope.tenant_id,'disabled');return fail('scope-changed');}
    await emit({kind:'admitting',run});
    let result:{processed:number;created:number};
    try{result=await projection.projectBatch(run,scope.tenant_id,notificationProcessBounds.events);}
    catch(error){
     // Only this local, deterministic adapter refusal proves the transaction
     // rolled back. Unknown/network/SQL errors remain visibly abandoned.
     if(error instanceof UnsupportedNotificationFacts){await lifecycle.settleScope(run,scope.tenant_id,'failed');return fail('projection-unimplemented');}
     throw error;
    }
    batches++; // projectBatch resolved only AFTER the actual COMMIT.
    await emit({kind:'committed',run,processed:result.processed,created:result.created});
    if(control.stopping())return fail('interrupted');
    if(result.processed<notificationProcessBounds.events){
     const backlog=await lifecycle.settleScope(run,scope.tenant_id,'drained');
     if(backlog.pending!=='0')return fail('scope-changed');
     after=scope.tenant_id;break;
    }
   }
  }
 }
}
