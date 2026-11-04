import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext} from '../../db/client';
import {withRewardsTenant} from '../../core/module-gate';
import {rewardPgUuid} from './policy-group-model';
import type {RewardCompanyClassification} from './company-picker';
export function rewardCompanyClassifications(ctx:SessionContext):Promise<RewardCompanyClassification[]>{
 return withRewardsTenant(ctx,async tx=>{
  const rows=await tx.execute<{company_id:string;disposition:RewardCompanyClassification['disposition'];canonical_company_id:string|null;reason:string;updated_at:string}>(sql`select company_id,disposition,case when canonical_company_id is null or app.reward_admin(canonical_company_id) then canonical_company_id else null end as canonical_company_id,reason,updated_at::text from reward_company_classification where tenant_id=app.current_tenant_id() order by company_id`);
  return rows.map(row=>({companyId:row.company_id,disposition:row.disposition,canonicalCompanyId:row.canonical_company_id,reason:row.reason,updatedAt:new Date(row.updated_at).toISOString()}));
 });
}
export function classifyRewardCompany(ctx:SessionContext,raw:unknown){
 const p=z.object({companyId:rewardPgUuid,disposition:z.enum(['visible','test_demo','alias']),canonicalCompanyId:rewardPgUuid.nullable(),reason:z.string().trim().min(10).max(2000)}).strict().parse(raw);
 return withRewardsTenant(ctx,async tx=>{await tx.execute(sql`select app.reward_company_classify(${p.companyId}::uuid,${p.disposition},${p.canonicalCompanyId}::uuid,${p.reason})`);});
}
