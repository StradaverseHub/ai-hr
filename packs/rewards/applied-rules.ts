import 'server-only';
import {sql} from 'drizzle-orm';
import type {SessionContext} from '../../db/client';
import {withRewardsTenant} from '../../core/module-gate';
import {getRewardUnit,listRewardUnits} from './service';
import {assertRewardCapabilityTx} from './access-policy';
import {publicAppliedRules} from './applied-rules-model';
export async function rewardRulesForReview(ctx:SessionContext,unitId:string){
 const v=await getRewardUnit(ctx,unitId);
 return withRewardsTenant(ctx,async tx=>{
  await assertRewardCapabilityTx(tx,unitId,'rules.view');
  const [origin]=await tx.execute<{name:string;version:number;current:boolean}>(sql`select v.name,v.revision as version,(g.current_version_id=v.id) as current from reward_policy_group_version v join reward_policy_group g on g.id=v.group_id and g.tenant_id=v.tenant_id where v.id=${v.unit.policyGroupVersionId}::uuid and v.tenant_id=app.current_tenant_id()`);
  const [uploadedReady]=await tx.execute<{ready:boolean}>(sql`select to_regclass('public.reward_uploaded_review') is not null as ready`);
  const uploaded=uploadedReady?.ready?(await tx.execute<{yes:boolean}>(sql`select exists(select 1 from reward_uploaded_review where unit_id=${unitId}::uuid and tenant_id=app.current_tenant_id()) as yes`))[0]?.yes??false:false;
  let versions:{plan:{name:string;version:number};salary:{name:string;version:number};bonus:{name:string;version:number;type:string};pat:{status:string;version:number}}|null=null;
  const [setupReady]=await tx.execute<{ready:boolean}>(sql`select to_regprocedure('app.reward_applied_public_references(uuid)') is not null as ready`);
  if(setupReady?.ready){const [r]=await tx.execute<{value:typeof versions}>(sql`select app.reward_applied_public_references(${unitId}::uuid) as value`);versions=r?.value??null;}
  return{unitId,company:v.companyName,cycle:v.cycle?.name??'',cycleId:v.unit.cycleId,origin:origin??null,versions,...publicAppliedRules(v.unit.policy,uploaded)};
 });
}
export async function rewardRulesChoices(ctx:SessionContext,companyIds:string[]){return(await listRewardUnits(ctx,companyIds)).map(u=>({id:u.id,cycleId:u.cycleId,cycle:u.cycle,companyId:u.companyId,company:u.company,year:u.year}));}
