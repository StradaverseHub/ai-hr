/** Assigned Contract work is paged by its native owner, with exact counts independent of previews. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext} from '../db/client';
import {withScopedLifecycleTenant} from './module-gate';
import {lockAccessConfigurationReadTx} from './access-configuration-lock';
import {inRenderReadScope,perRenderRead} from '../lib/request-memo';
export type ContractWorkItem={id:string;kind:'contractApproval'|'contractLetter';subjectName:string;createdAt:string;linkPath:string;action:'approval'|'review'|'approve'|'sign'|'resend'|'bindEmployee'};
export type ContractWorkPage={items:ContractWorkItem[];total:number;countsByKind:Partial<Record<ContractWorkItem['kind'],number>>;approvalTotal:number;taskTotal:number;limit:number;offset:number;hasMore:boolean};
type ContractWorkQuery={category:'all'|'approvals'|'tasks';companyIds?:string[];limit:number;offset:number};
type ContractWorkAnswer=Omit<ContractWorkPage,'limit'|'offset'|'hasMore'>;
const parseQuery=(input:{category?:'all'|'approvals'|'tasks';companyIds?:string[];limit?:number;offset?:number}):ContractWorkQuery=>
 z.object({category:z.enum(['all','approvals','tasks']).default('all'),companyIds:z.array(z.uuid()).max(500).optional(),limit:z.number().int().min(1).max(100).default(20),offset:z.number().int().min(0).max(100000).default(0)}).parse(input);
function readContractWork(ctx:SessionContext,query:ContractWorkQuery):Promise<ContractWorkAnswer>{
 return withScopedLifecycleTenant(ctx,async tx=>{
  await lockAccessConfigurationReadTx(tx,ctx.tenantId);
  const [row]=await tx.execute<{page:ContractWorkAnswer}>(sql`select app.contract_shared_work_page(${query.category},${query.companyIds?`{${query.companyIds.join(',')}}`:null}::uuid[],${query.limit},${query.offset}) as page`);
  return {...row.page,items:row.page.items.map(item=>({...item,createdAt:new Date(item.createdAt).toISOString()}))};
 });
}
/** The largest page app.contract_shared_work_page returns: the render's shared read (below) asks for it. */
export const CONTRACT_WORK_SHARED_LIMIT=100;
/** The SQL owner's category of one item (6373 `assigned`): a letter's sign or bind step is a task, everything else an approval. */
export function contractWorkItemCategory(item:Pick<ContractWorkItem,'kind'|'action'>):'approvals'|'tasks'{
 return item.kind==='contractLetter'&&(item.action==='sign'||item.action==='bindEmployee')?'tasks':'approvals';
}
/**
 * One page of `query`, derived from the owner's first page of every category with no company filter (`shared`, offset
 * 0, limit CONTRACT_WORK_SHARED_LIMIT), or null when that page cannot answer it exactly. The owner orders every
 * category by the same key (updated_at desc, kind, subject) and a category page is the full list filtered, so:
 * - an `all` page inside the shared page is its slice, with the shared totals;
 * - any category page is the filtered slice when the shared page holds every item (total equals the items returned),
 *   with its total and per-kind counts counted from the filtered items (kinds with none are absent, as jsonb_object_agg
 *   leaves them). `approvalTotal` and `taskTotal` never depend on the category, page or limit.
 * A company filter cannot be derived (the items carry no company), so it always reads the owner.
 */
export function deriveContractWorkPage(shared:ContractWorkAnswer,query:ContractWorkQuery):ContractWorkAnswer|null{
 if(query.companyIds)return null;
 if(query.category==='all'){
  if(query.offset+query.limit>shared.items.length&&shared.items.length<shared.total)return null;
  return {...shared,items:shared.items.slice(query.offset,query.offset+query.limit)};
 }
 if(shared.items.length<shared.total)return null;
 const filtered=shared.items.filter(item=>contractWorkItemCategory(item)===query.category);
 const countsByKind:ContractWorkAnswer['countsByKind']={};
 for(const item of filtered)countsByKind[item.kind]=(countsByKind[item.kind]??0)+1;
 return {items:filtered.slice(query.offset,query.offset+query.limit),total:filtered.length,countsByKind,approvalTotal:shared.approvalTotal,taskTotal:shared.taskTotal};
}
export async function contractSharedWorkPage(ctx:SessionContext,input:{category?:'all'|'approvals'|'tasks';companyIds?:string[];limit?:number;offset?:number}={}):Promise<ContractWorkPage>{
 const query=parseQuery(input);
 const page=(answer:ContractWorkAnswer):ContractWorkPage=>({...answer,limit:query.limit,offset:query.offset,hasMore:query.offset+answer.items.length<answer.total});
 // ADR 0181 queues addendum Q0: inside a page render the frame's bell and the page's own Contract slot ask the owner
 // once; each derives its page from that answer when it can do so exactly, and reads the owner itself otherwise.
 if(query.companyIds||!inRenderReadScope())return page(await readContractWork(ctx,query));
 const shared=await perRenderRead(ctx,'contract-shared-work-page:all',()=>readContractWork(ctx,{category:'all',limit:CONTRACT_WORK_SHARED_LIMIT,offset:0}));
 return page(deriveContractWorkPage(shared,query)??await readContractWork(ctx,query));
}
