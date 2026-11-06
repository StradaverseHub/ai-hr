/** Extra Rewards membership for the workflow-only synthetic fixture. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {approvedRewardFixtures} from '../fixtures/reward-approved.ts';
import {saveRewardPlanConfiguration,saveRewardSetupPlan,submitRewardSetupPlan,approveRewardSetupPlan} from '../../packs/rewards/plan-configuration.ts';
import {establishRewardMembership} from '../../test/rewards-shared-policy-fixture.ts';
import {setCompensation} from '../../core/comp.ts';

export async function prepareRewardDraftFixture({owner,schema,ctx,tenant,companies,company,today,actor,expectedCompanyEmploymentIds}){
 assert.equal(process.env.PERF_HTTP_SUITE,'workflow-preflight','draft witness fixture must stay out of the load workload');
 assert.equal(process.env.GITHUB_ACTIONS,'true');
 assert.equal(new URL(process.env.DATABASE_URL).pathname,'/ai_hr_dev');
 assert.equal(ctx.tenantId,tenant.tenantId);
 const year=Number(today.slice(0,4));
 // Publication activates dated grouping for the tenant, including companies
 // outside this Rewards plan. Give every fictional company an approved mapping.
 const targets=[];
 for(const [index,target] of companies.entries()){
  const [unit]=await owner.db.insert(schema.businessUnit).values({
   tenantId:tenant.tenantId,companyId:target.companyId,code:'PERF-DRAFT-BU-'+index,name:'Fictional structure unit '+index,
  }).returning({id:schema.businessUnit.id});
  targets.push({companyId:target.companyId,businessUnitId:unit.id});
 }
 const rewardTarget=targets.find(target=>target.companyId===company.companyId);
 assert(rewardTarget,'Rewards target must be among the mapped companies');
 const unit={id:rewardTarget.businessUnitId};
 // The approved plan uses independently checked company structure and library/PAT facts.
 // This employee has no credentials and is created after the baseline Payroll fixture runs close.
 const person=await establishRewardMembership(ctx,{
  tenantId:tenant.tenantId,companyId:company.companyId,businessUnitId:unit.id,departmentId:company.departmentId,year,
 });
 await setCompensation(ctx,{employmentId:person.employmentId,basicSalary:5000,effectiveFrom:today});
 const maker={...ctx,userId:actor.userId,personId:actor.personId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]};
 const fixtures=approvedRewardFixtures(owner),checker=await fixtures.setupChecker(maker);
 await fixtures.setupCompanyStructureFixture(maker,targets,today,checker);
 const {policy,salary,bonus}=await fixtures.setupRewardLibrariesFixture(maker,year,undefined,checker);
 await fixtures.confirmFixturePat(maker,company.companyId,year,{targetCents:policy.patTarget,forecastCents:null,actualCents:policy.patActual,targetMonthsBp:policy.targetMonthsBp},checker);
 const name='Fictional Rewards draft '+randomUUID();
 const source=await saveRewardPlanConfiguration(maker,{groupId:null,expectedRevision:0,name,policy,targets:[{companyId:company.companyId,businessUnitId:unit.id}]});
 const revision=await saveRewardSetupPlan(maker,{versionId:source.versionId,expectedRevision:0,cycleName:name,snapshotDate:today,bindings:[{companyId:company.companyId,businessUnitId:unit.id,salaryVersionId:salary,bonusVersionId:bonus,branchAcknowledged:policy.bonusStructure==='branch'}],reason:'Independently reviewed fictional browser fixture'});
 await submitRewardSetupPlan(maker,source.versionId,revision);
 await approveRewardSetupPlan(checker,source.versionId,revision+1);
 // Company structure applies to all currently employed company members. The expected roster
 // is derived from the fixture's explicit hires, not from the Rewards projection under test.
 return {companyId:company.companyId,businessUnitId:unit.id,employmentId:person.employmentId,year,snapshotDate:today,
   planVersionId:source.versionId,planName:name,expectedEmploymentIds:[...expectedCompanyEmploymentIds,person.employmentId]};
}
