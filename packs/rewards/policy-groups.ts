/** Canonical reusable configuration owner. No employee roster or confidential review is read here. */
import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../db/client';
import {withRewardsTenant} from '../../core/module-gate';
import {pgSqlState} from '../../lib/db-error';
import {policySchema,type RewardPolicy} from './model';
import {normalizedRewardTargets,parseRewardPolicyGroupVersion,rewardPgUuid,rewardPolicyGroupEditSchema,type RewardPolicyGroupVersion} from './policy-group-model';
export class RewardPolicyGroupError extends Error{
 constructor(readonly code:'invalid'|'changed'|'scope'|'system'){super(`Reward shared configuration: ${code}`);this.name='RewardPolicyGroupError';}
}
function refusal(error:unknown):never{
 const state=pgSqlState(error);
 if(state==='40001')throw new RewardPolicyGroupError('changed');
 if(state==='42501')throw new RewardPolicyGroupError('scope');
 if(['23503','23505','23514','22P02'].includes(state??''))throw new RewardPolicyGroupError('invalid');
 throw error;
}
export function saveRewardPolicyGroup(ctx:SessionContext,raw:unknown):Promise<RewardPolicyGroupVersion>{
 const p=rewardPolicyGroupEditSchema.parse(raw),targets=normalizedRewardTargets(p.targets);
 return withRewardsTenant(ctx,async tx=>{
  try{
   const [row]=await tx.execute<{version:unknown}>(sql`select app.reward_policy_group_commit(${p.groupId}::uuid,${p.expectedRevision},${p.name},${JSON.stringify(p.policy)}::jsonb,${JSON.stringify(targets)}::jsonb) as version`);
   return parseRewardPolicyGroupVersion(row?.version);
  }catch(error){return refusal(error);}
 });
}
export function listRewardPolicyGroups(ctx:SessionContext){
 return withRewardsTenant(ctx,async tx=>{
  const rows=await tx.execute<{version:unknown}>(sql`select app.reward_policy_groups() as version`);
  return rows.map(row=>parseRewardPolicyGroupVersion(row.version));
 });
}
export function rewardPolicyGroupUsage(ctx:SessionContext,groupId:string){
 return withRewardsTenant(ctx,async tx=>{
  const rows=await tx.execute<{unit_id:string;cycle:string;company:string;business_unit:string;status:string;revision:number}>(sql`select * from app.reward_policy_group_usage(${rewardPgUuid.parse(groupId)}::uuid)`);
  return rows.map(row=>({unitId:rewardPgUuid.parse(row.unit_id),cycle:row.cycle,company:row.company,businessUnit:row.business_unit,status:row.status,revision:row.revision}));
 });
}
/** The read-only settings a review creator sees (56595838): no salary ranges, profit figures or people. */
export type RewardPolicySummary=Pick<RewardPolicy,'effectiveFrom'|'meritMatrix'|'standardPools'|'hPools'|'targetMonthsBp'|'bonusMatrix'|'exemptReason'>;
const summary=(p:RewardPolicy):RewardPolicySummary=>({effectiveFrom:p.effectiveFrom,meritMatrix:p.meritMatrix,standardPools:p.standardPools,hPools:p.hPools,targetMonthsBp:p.targetMonthsBp,bonusMatrix:p.bonusMatrix,exemptReason:p.exemptReason});
export type RewardSharedChoice={groupId:string;versionId:string;revision:number;name:string;year:number;companyId:string;businessUnitId:string;policy:RewardPolicySummary|null};
export function rewardSharedPolicyChoices(ctx:SessionContext,companyIds:readonly string[]):Promise<RewardSharedChoice[]>{
 if(companyIds.length>500)throw new RewardPolicyGroupError('invalid');
 const ids=[...new Set(companyIds.map(value=>rewardPgUuid.parse(value)))];
 return withRewardsTenant(ctx,async tx=>{
  const result:RewardSharedChoice[]=[];
  for(const companyId of ids){
   const rows=await tx.execute<{group_id:string;version_id:string;revision:number;name:string;year:number;business_unit_id:string}>(sql`select * from app.reward_policy_choices(${companyId}::uuid)`);
   for(const row of rows){
    // Contents come through the same consumption authority as creating a review from this version;
    // a version that changed or left scope since the list read shows no contents rather than failing the page.
    let policy:RewardPolicySummary|null=null;
    try{policy=await tx.transaction(async sp=>{const [bound]=await sp.execute<{binding:{policy:unknown}|null}>(sql`select app.reward_policy_for_new_unit(${row.version_id}::uuid,${companyId}::uuid,${row.business_unit_id}::uuid) as binding`);return bound?.binding?summary(policySchema.parse(bound.binding.policy)):null;});}
    catch(error){if(!['40001','42501'].includes(pgSqlState(error)??''))throw error;}
    result.push({groupId:rewardPgUuid.parse(row.group_id),versionId:rewardPgUuid.parse(row.version_id),revision:row.revision,name:row.name,year:row.year,companyId,businessUnitId:rewardPgUuid.parse(row.business_unit_id),policy});
   }
  }
  return result;
 });
}
/** Internal same-transaction consumption; holding the group head prevents a stale future-review copy. */
export async function rewardPolicyForReviewTx(tx:Tx,versionId:string|undefined,companyId:string,businessUnitId:string,year:number){
 const wantedVersion=versionId?rewardPgUuid.parse(versionId):null;
 try{
  const [row]=await tx.execute<{binding:{groupId:string;versionId:string;revision:number;name:string;policy:unknown}|null}>(sql`select app.reward_policy_for_review(${wantedVersion}::uuid,${rewardPgUuid.parse(companyId)}::uuid,${rewardPgUuid.parse(businessUnitId)}::uuid,${year}) as binding`);
  if(row?.binding===null&&wantedVersion===null)return null;
  if(!row?.binding||row.binding.versionId!==wantedVersion)throw new RewardPolicyGroupError('changed');
  return {...row.binding,groupId:rewardPgUuid.parse(row.binding.groupId),policy:policySchema.parse(row.binding.policy)};
 }catch(error){return refusal(error);}
}
