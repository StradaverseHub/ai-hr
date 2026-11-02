/** Explicit maintenance connection for finite OneHR notification sources. */
import {sql} from 'drizzle-orm';
import type {SessionContext,Tx,createDb} from '../../../db/client';
import {assertNotificationSweepConnection} from '../../../core/notice-projection';
export type OnehrWorkerConnection=Pick<ReturnType<typeof createDb>,'withTenant'>;
export type OnehrWorkerSource={kind:'cycle'|'event'|'recipient';id:string};
const uuid=(id:string)=>/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id);
export async function enrollOnehrWorkerSourceTx(tx:Tx,source:OnehrWorkerSource){
 if(!uuid(source.id))throw Error('OneHR worker source unavailable.');
 await tx.execute(sql`select app.financial_onehr_worker_enroll(${source.kind},${source.id}::uuid)`);
}
export async function withOnehrWorkerSource<T>(ctx:SessionContext,connection:OnehrWorkerConnection,source:OnehrWorkerSource,run:(tx:Tx)=>Promise<T>,options:{downgrade?:boolean}={}){
 if(ctx.userId||ctx.agent||!uuid(ctx.tenantId))throw Error('OneHR worker requires a maintenance context.');
 return connection.withTenant(ctx,async tx=>{
  const prior=await assertNotificationSweepConnection(tx);
  await enrollOnehrWorkerSourceTx(tx,source);
  if(options.downgrade!==false)await tx.execute(sql`SET LOCAL ROLE ai_hr_app`);
  const result=await run(tx);
  if(options.downgrade!==false)await tx.execute(sql`select set_config('role',${prior},true)`);
  return result;
 });
}
const minted=new WeakSet<OnehrWorkerAccess>();
export type OnehrWorkerAccess={readonly tenantId:string;readonly withEvent:<T>(eventId:string,run:(tx:Tx)=>Promise<T>)=>Promise<T>};
export async function createOnehrWorkerAccess(ctx:SessionContext,connection:OnehrWorkerConnection):Promise<OnehrWorkerAccess>{
 if(ctx.userId||ctx.agent||!uuid(ctx.tenantId))throw Error('OneHR worker requires a maintenance context.');
 await connection.withTenant(ctx,assertNotificationSweepConnection,{readOnlySnapshot:true});
 const bound={...ctx,roles:[...(ctx.roles??[])],grants:ctx.grants?.map(grant=>({...grant}))};
 const access:OnehrWorkerAccess=Object.freeze({tenantId:bound.tenantId,withEvent:<T>(eventId:string,run:(tx:Tx)=>Promise<T>)=>withOnehrWorkerSource(bound,connection,{kind:'event',id:eventId},run)});
 minted.add(access);return access;
}
export function onehrWorkerEventReader(ctx:SessionContext,access?:OnehrWorkerAccess){
 if(!access)return undefined;
 if(ctx.userId||ctx.agent||!minted.has(access)||ctx.tenantId!==access.tenantId)throw Error('OneHR worker access does not match this maintenance context.');
 return access.withEvent;
}
export const isOnehrWorkerEvent=(eventType:string)=>['assessment.reminder-queued','onehr.results-submitted','onehr.competencies-submitted','onehr.plan-shared','onehr.kpi-approval-needed'].includes(eventType);
