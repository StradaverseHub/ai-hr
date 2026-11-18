import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext} from '../../../db/client';
import {actorOf,appendEvent} from '../../../db/events';
import {withLifecycleTenant} from '../../../core/module-gate';
import {withAccessDisplayRead,lockAccessConfigurationReadTx} from '../../../core/access-configuration-lock';
import type {OffboardingRequisition} from '../../../lib/offboarding-requisition';
import {V9Error} from '../../../lib/lifecycle-v9-model';
import {v9Command,v9OwnItem} from './service';
export async function offboardingRequisition(ctx:SessionContext,id:string):Promise<OffboardingRequisition>{
 z.uuid().parse(id);
 return withAccessDisplayRead(()=>withLifecycleTenant(ctx,async tx=>{
  const [row]=await tx.execute<{detail:OffboardingRequisition|null}>(sql`select app.offboarding_requisition(${id}::uuid) as detail`);
  if(!row?.detail)throw new V9Error('Requisition unavailable.','not_found');return row.detail;
 }));
}
export async function updateOffboardingRequisitionItem(ctx:SessionContext,input:{caseId:string;revision:number;itemId:string;status:'todo'|'progress'|'done'|'notReturned'|'notNeeded';reason:string}){
 const value=z.object({caseId:z.uuid(),revision:z.number().int().positive(),itemId:z.string().min(1).max(120),status:z.enum(['todo','progress','done','notReturned','notNeeded']),reason:z.string().max(4000)}).strict().parse(input);
 const detail=await offboardingRequisition(ctx,value.caseId),item=detail.items.find(i=>i.id===value.itemId);
 if(detail.revision!==value.revision)throw new V9Error('This requisition changed. Refresh before updating.','conflict');
 if(!item?.canAct)throw new V9Error('This item is unavailable for update.','forbidden');
 if(detail.fullView)await v9Command(ctx,value.caseId,value.revision,{type:'item',id:value.itemId,status:value.status,reason:value.reason});
 else if(value.status==='notReturned')await withLifecycleTenant(ctx,async tx=>{
  await lockAccessConfigurationReadTx(tx,ctx.tenantId);
  await tx.execute(sql`select app.offboarding_requisition_not_returned(${value.caseId}::uuid,${value.revision},${value.itemId},${value.reason})`);
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'lifecycle-v9-case',aggregateId:value.caseId,eventType:'lifecycle-v9.itemNotReturned',actor:actorOf(ctx),payload:{itemId:value.itemId}});
 });
 else if(value.status==='notNeeded')throw new V9Error('HR must adjudicate this exception.','forbidden');
 else await v9OwnItem(ctx,{...value,status:value.status});
 return offboardingRequisition(ctx,value.caseId);
}
export async function offboardingRequisitions(ctx:SessionContext,input:{companyId?:string;search?:string;offset?:number;limit?:number}={}){
 const query=z.object({companyId:z.uuid().optional(),search:z.string().max(100).default(''),offset:z.number().int().min(0).max(1000000).default(0),limit:z.number().int().min(1).max(100).default(50)}).parse(input);
 return withAccessDisplayRead(()=>withLifecycleTenant(ctx,async tx=>{
  const [row]=await tx.execute<{page:{items:import('../../../lib/offboarding-requisition').OffboardingRequisitionRow[];total:number}}>(sql`select app.offboarding_requisitions(${query.companyId??null}::uuid,${query.search},${query.offset},${query.limit}) as page`);return {...row.page,offset:query.offset,limit:query.limit};
 }));
}
