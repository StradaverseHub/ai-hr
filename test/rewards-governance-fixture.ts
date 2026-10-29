/** Valid fictional policy/input setup through the same native doer/checker services as the product. */
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import type {SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {getRewardUnit,getRewardUnitGovernance,saveRewardPolicy,saveRewardUnitInputs,confirmRewardGovernance,proposeRewardExemption,getRewardSeniorMembership,previewRewardSeniorMembership,saveRewardSeniorMembership} from '../packs/rewards/service';
import {defaultPolicy,type RewardPolicy} from '../packs/rewards/model';
import {owner,createAppUser} from './harness';
import {setRewardMember} from './rewards-access-fixture';
const checkers=new Map<string,SessionContext>();
export async function ensureRewardGovernanceFixtureSchema(){
 const [ready]=await owner.db.execute<{ready:boolean}>(sql`select to_regclass('public.reward_governance') is not null as ready`);
 if(!ready.ready)await owner.client.unsafe(readFileSync('docs/migration-drafts/0689_rewards_unit_governance.sql','utf8'));
}
export async function initializeRewardGovernanceFixture(ctx:SessionContext,unitId:string){
 await ensureRewardGovernanceFixtureSchema();
 let checker=checkers.get(unitId);
 if(!checker){
  const [person]=await owner.db.insert(schema.person).values({tenantId:ctx.tenantId,fullName:'Independent fictional Rewards checker',primaryEmail:randomUUID()+'@rewards-fixture.test'}).returning();
  const userId=await createAppUser(ctx.tenantId,person.id,'hr_admin');
  checker={...ctx,userId,personId:person.id,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]};
  await setRewardMember(ctx,unitId,(await getRewardUnit(ctx,unitId)).unit.revision,userId,'gr');checkers.set(unitId,checker);
 }
 let v=await getRewardUnitGovernance(ctx,unitId);
 if(!v.selection){const roster=await getRewardSeniorMembership(ctx,unitId),selection={employmentIds:roster.rows.filter(row=>row.member).map(row=>row.employmentId),adoptLegacy:roster.mode!=='named-members'},preview=await previewRewardSeniorMembership(ctx,unitId,v.revision,selection);await saveRewardSeniorMembership(ctx,unitId,v.revision,selection,preview.digest);v=await getRewardUnitGovernance(ctx,unitId);}
 if(v.selection&&!v.selection.confirmedBy)await confirmRewardGovernance(checker,unitId,v.revision,'selection');
 return checker;
}
export function completeRewardFixturePolicy(raw:RewardPolicy):RewardPolicy{
 const ranges={...raw.ranges},bonusMatrix={...raw.bonusMatrix};
 for(const grade of ['H',...Array.from({length:12},(_,index)=>String(index+12))]){
  // Independently specified fictional bands for unused grades, never production defaults.
  if(grade!=='23')ranges[grade]??=[100000,500000,1000000];else delete ranges[grade];
  bonusMatrix[grade]??=[0,5000,15000,22500,30000];
 }
 return {...raw,ranges,bonusMatrix};
}
export async function configureRewardFixture(ctx:SessionContext,unitId:string,_revision:number,raw:RewardPolicy){
 const checker=await initializeRewardGovernanceFixture(ctx,unitId),policy=completeRewardFixturePolicy(raw);
 await saveRewardPolicy(ctx,unitId,(await getRewardUnit(ctx,unitId)).unit.revision,policy);
 await saveRewardUnitInputs(ctx,unitId,(await getRewardUnit(ctx,unitId)).unit.revision,{forecastCents:null,actualCents:raw.patActual,targetCents:raw.patTarget,targetMonthsBp:raw.targetMonthsBp,multiplierBp:raw.bonusStructure==='branch'?10000:raw.multiplierBp,branchRatings:raw.branchRatings},'Fictional approved unit budget basis');
 if(raw.exemptReason){
  await proposeRewardExemption(ctx,unitId,(await getRewardUnit(ctx,unitId)).unit.revision,raw.exemptReason);
  await confirmRewardGovernance(checker,unitId,(await getRewardUnit(ctx,unitId)).unit.revision,'exemption');
 }
}
export async function refreshRewardFixtureBudget(ctx:SessionContext,unitId:string){
 const value=await getRewardUnitGovernance(ctx,unitId);
 if(value.inputs)await saveRewardUnitInputs(ctx,unitId,value.revision,value.inputs,'Reviewed fictional eligibility and current source facts');
}
export async function changeRewardFixtureInputs(ctx:SessionContext,unitId:string,values:Partial<{patActual:number;patTarget:number;targetMonthsBp:number;multiplierBp:number|null;branchRatings:RewardPolicy['branchRatings'];exemptReason:string}>){
 const checker=await initializeRewardGovernanceFixture(ctx,unitId),value=await getRewardUnitGovernance(ctx,unitId),existing=value.inputs??value.legacyInputs!;
 await saveRewardUnitInputs(ctx,unitId,value.revision,{...existing,...(values.patActual===undefined?{}:{actualCents:values.patActual}),...(values.patTarget===undefined?{}:{targetCents:values.patTarget}),...(values.targetMonthsBp===undefined?{}:{targetMonthsBp:values.targetMonthsBp}),...(values.multiplierBp===undefined?{}:{multiplierBp:values.multiplierBp}),...(values.branchRatings===undefined?{}:{branchRatings:values.branchRatings})},'Fictional independently reviewed budget input change');
 if(values.exemptReason){await proposeRewardExemption(ctx,unitId,(await getRewardUnit(ctx,unitId)).unit.revision,values.exemptReason);await confirmRewardGovernance(checker,unitId,(await getRewardUnit(ctx,unitId)).unit.revision,'exemption');}
}
