/** Assigned Contract work is paged by its native owner, with exact counts independent of previews. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext} from '../db/client';
import {withScopedLifecycleTenant} from './module-gate';
import {lockAccessConfigurationReadTx} from './access-configuration-lock';
export type ContractWorkItem={id:string;kind:'contractApproval'|'contractLetter';subjectName:string;createdAt:string;linkPath:string;action:'approval'|'review'|'approve'|'sign'|'resend'};
export type ContractWorkPage={items:ContractWorkItem[];total:number;countsByKind:Partial<Record<ContractWorkItem['kind'],number>>;approvalTotal:number;taskTotal:number;limit:number;offset:number;hasMore:boolean};
export async function contractSharedWorkPage(ctx:SessionContext,input:{category?:'all'|'approvals'|'tasks';companyIds?:string[];limit?:number;offset?:number}={}):Promise<ContractWorkPage>{
 const query=z.object({category:z.enum(['all','approvals','tasks']).default('all'),companyIds:z.array(z.uuid()).max(500).optional(),limit:z.number().int().min(1).max(100).default(20),offset:z.number().int().min(0).max(100000).default(0)}).parse(input);
 return withScopedLifecycleTenant(ctx,async tx=>{
  await lockAccessConfigurationReadTx(tx,ctx.tenantId);
  const [row]=await tx.execute<{page:Omit<ContractWorkPage,'limit'|'offset'|'hasMore'>}>(sql`select app.contract_shared_work_page(${query.category},${query.companyIds?`{${query.companyIds.join(',')}}`:null}::uuid[],${query.limit},${query.offset}) as page`);
  return {...row.page,items:row.page.items.map(item=>({...item,createdAt:new Date(item.createdAt).toISOString()})),limit:query.limit,offset:query.offset,hasMore:query.offset+row.page.items.length<row.page.total};
 });
}
