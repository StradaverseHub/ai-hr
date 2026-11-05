import 'server-only';
import {sql} from 'drizzle-orm';
import type {SessionContext} from '../../db/client';
import {withRewardsTenant} from '../../core/module-gate';
import {listRewardUnits} from './service';
import type {RewardPolicy} from './model';
import {assertRewardCapabilityTx} from './access-policy';
import {publicAppliedRules} from './applied-rules-model';
type AppliedReferences={plan:{name:string;version:number};salary:{name:string;version:number};bonus:{name:string;version:number;type:string};pat:{status:string;version:number}};
export async function rewardRulesForReview(ctx:SessionContext,unitId:string){
 return withRewardsTenant(ctx,async tx=>{
  await assertRewardCapabilityTx(tx,unitId,'rules.view');
  const [v]=await tx.execute<{policy:RewardPolicy;policyGroupVersionId:string|null;companyName:string;cycleId:string;cycleName:string}>(sql`select u.policy,u.policy_group_version_id as "policyGroupVersionId",c.legal_name as "companyName",y.id as "cycleId",y.name as "cycleName" from reward_unit u join company c on c.id=u.company_id and c.tenant_id=u.tenant_id join reward_cycle y on y.id=u.cycle_id and y.tenant_id=u.tenant_id where u.id=${unitId}::uuid and u.tenant_id=app.current_tenant_id() and u.deleted_at is null`);if(!v)throw Error('Applied rules unavailable.');
  const [origin]=await tx.execute<{name:string;version:number;current:boolean}>(sql`select v.name,v.revision as version,(g.current_version_id=v.id) as current from reward_policy_group_version v join reward_policy_group g on g.id=v.group_id and g.tenant_id=v.tenant_id where v.id=${v.policyGroupVersionId}::uuid and v.tenant_id=app.current_tenant_id()`);
  const [uploadedReady]=await tx.execute<{ready:boolean}>(sql`select to_regclass('public.reward_uploaded_review') is not null as ready`);
  const uploaded=uploadedReady?.ready?(await tx.execute<{yes:boolean}>(sql`select exists(select 1 from reward_uploaded_review where unit_id=${unitId}::uuid and tenant_id=app.current_tenant_id()) as yes`))[0]?.yes??false:false;
  let versions:AppliedReferences|null=null;
  const [setupReady]=await tx.execute<{ready:boolean}>(sql`select to_regprocedure('app.reward_applied_public_references(uuid)') is not null as ready`);
  if(setupReady?.ready){const [r]=await tx.execute<{value:AppliedReferences|null}>(sql`select app.reward_applied_public_references(${unitId}::uuid) as value`);versions=r?.value??null;}
  return{unitId,company:v.companyName,cycle:v.cycleName,cycleId:v.cycleId,origin:origin??null,versions,...publicAppliedRules(v.policy,uploaded)};
 });
}
export async function rewardRulesChoices(ctx:SessionContext,companyIds:string[]){const choices=await listRewardUnits(ctx,companyIds);return withRewardsTenant(ctx,async tx=>{const out=[];for(const u of choices){const [cap]=await tx.execute<{allowed:boolean}>(sql`select app.reward_capability(${u.id}::uuid,'rules.view') as allowed`);if(cap?.allowed)out.push({id:u.id,cycleId:u.cycleId,cycle:u.cycle,companyId:u.companyId,company:u.company,year:u.year});}return out;});}
