/** Read/write owner for company-year participation and immutable shared-configuration history. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext} from '../../db/client';
import {withRewardsTenant} from '../../core/module-gate';
import {parseRewardPolicyGroupVersion,rewardPgUuid} from './policy-group-model';
export type RewardCompanyExclusion={id:string;companyId:string;company:string;year:number;reason:string;createdBy:string|null;createdAt:string;endedAt:string|null;endReason:string|null};
export type RewardPolicyHistory={version:ReturnType<typeof parseRewardPolicyGroupVersion>;savedAt:string;savedBy:string|null;current:boolean;locked:boolean;usageCount:number};
const yearSchema=z.number().int().min(2000).max(2200);
export function rewardCompanyExclusions(ctx:SessionContext,year?:number){
 if(year!==undefined)yearSchema.parse(year);
 return withRewardsTenant(ctx,async tx=>{
  const rows=await tx.execute<{id:string;company_id:string;company:string;year:number;reason:string;created_by:string|null;created_at:string;ended_at:string|null;end_reason:string|null}>(sql`
   select e.id,e.company_id,c.legal_name as company,e.year,e.reason,p.full_name as created_by,e.created_at::text,e.ended_at::text,e.end_reason
   from reward_company_exclusion e join company c on c.id=e.company_id and c.tenant_id=e.tenant_id
   left join app_user u on u.id=e.created_by and u.tenant_id=e.tenant_id left join person p on p.id=u.person_id and p.tenant_id=e.tenant_id and app.access_workforce_person(p.id,'workforce.view')
   where e.tenant_id=app.current_tenant_id() and app.reward_admin(e.company_id) and ${year===undefined?sql`true`:sql`e.year=${year}`}
   order by c.legal_name,e.created_at desc,e.id`);
  return rows.map(row=>({id:row.id,companyId:row.company_id,company:row.company,year:row.year,reason:row.reason,createdBy:row.created_by,createdAt:new Date(row.created_at).toISOString(),endedAt:row.ended_at?new Date(row.ended_at).toISOString():null,endReason:row.end_reason})) satisfies RewardCompanyExclusion[];
 });
}
export function changeRewardCompanyExclusion(ctx:SessionContext,raw:unknown){
 const p=z.object({companyId:rewardPgUuid,year:yearSchema,reason:z.string().trim().min(10).max(2000),endId:rewardPgUuid.nullable()}).strict().parse(raw);
 return withRewardsTenant(ctx,async tx=>{
  const [row]=await tx.execute<{id:string}>(sql`select app.reward_company_exclusion_change(${p.companyId}::uuid,${p.year},${p.reason},${p.endId}::uuid) as id`);
  return rewardPgUuid.parse(row?.id);
 });
}
export function rewardPolicyHistory(ctx:SessionContext,groupId:string):Promise<RewardPolicyHistory[]>{
 rewardPgUuid.parse(groupId);
 return withRewardsTenant(ctx,async tx=>{
  const rows=await tx.execute<{row:Omit<RewardPolicyHistory,'version'>&{version:unknown}}>(sql`select app.reward_policy_group_versions(${groupId}::uuid) as row`);
  return rows.map(({row})=>({...row,version:parseRewardPolicyGroupVersion(row.version)}));
 });
}
export function rewardPolicyHiddenCount(ctx:SessionContext){
 return withRewardsTenant(ctx,async tx=>{
  const [row]=await tx.execute<{count:number}>(sql`select app.reward_policy_group_hidden_count() as count`);return row?.count??0;
 });
}
