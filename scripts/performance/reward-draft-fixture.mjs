/** Extra Rewards membership for the isolated fictional browser workloads. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {approvedRewardFixtures} from '../fixtures/reward-approved.ts';
import {createRewardUnit} from '../../packs/rewards/service.ts';
import {saveRewardSetupPlan,submitRewardSetupPlan,approveRewardSetupPlan} from '../../packs/rewards/plan-configuration.ts';
import {establishRewardMembership} from '../../test/rewards-shared-policy-fixture.ts';
import {REWARDS_ORG_FIXTURE_NAME} from './fixture-workload.mjs';
import {setupAuthority,setupLock,setupTenant} from '../../packs/rewards/setup-data.ts';
import {normalizedRewardTargets,parseRewardPolicyGroupVersion,rewardPolicyGroupEditSchema} from '../../packs/rewards/policy-group-model.ts';
import {assertRewardPolicyGrids} from '../../packs/rewards/policy-grid-validation.ts';
import {sharedRewardPolicyProjection} from '../../packs/rewards/shared-policy-projection.ts';

// The standalone fixture loader uses static imports for validation. The draft still goes
// through the same authenticated transaction, authority check, lock and storage function.
async function seedRewardPlanSource(ctx,input){
 const draft=rewardPolicyGroupEditSchema.parse(input);
 assertRewardPolicyGrids(draft.policy);
 return setupTenant(ctx,async tx=>{
  await setupAuthority(tx,null,'manage');
  await setupLock(tx,ctx,'plans');
  const [row]=await tx.execute(sql`select app.reward_setup_policy_commit(${draft.groupId}::uuid,${draft.expectedRevision},${draft.name},
   ${JSON.stringify(sharedRewardPolicyProjection(draft.policy))}::jsonb,${JSON.stringify(normalizedRewardTargets(draft.targets))}::jsonb) as version`);
  return parseRewardPolicyGroupVersion(row?.version);
 });
}

export async function prepareRewardDraftFixture({owner,schema,ctx,tenant,companies,company,today,actor,includeOrgExplorerMember,expectedCompanyEmploymentIds,phase=(_name,run)=>run()}){
 const suite=process.env.PERF_HTTP_SUITE;
 assert(suite==='workflow-preflight'||suite==='whole-system','Rewards fixture requires an isolated browser workload');
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
 const person=await phase('membership',()=>establishRewardMembership(ctx,{
  tenantId:tenant.tenantId,companyId:company.companyId,businessUnitId:unit.id,departmentId:company.departmentId,year,
  ...(includeOrgExplorerMember?{hiredOn:today}:{}),
 }));
 // The base load fixture inserts starting salaries as data. This additional hire
 // also has no prior salary or payslip. Keep the salary mutation separate from setup.
 await phase('compensation-seed',async()=>{
  const salaries=await owner.client`
   insert into public.compensation (tenant_id,employment_id,basic_salary,valid_from)
   select e.tenant_id,e.id,5000,${today}::date
   from public.employment e
   where e.tenant_id=${tenant.tenantId}::uuid and e.company_id=${company.companyId}::uuid
    and e.id=${person.employmentId}::uuid and e.hired_on<=${today}::date and e.terminated_on is null
    and not exists(select 1 from public.compensation c where c.tenant_id=e.tenant_id and c.employment_id=e.id)
    and not exists(select 1 from public.payslip p where p.tenant_id=e.tenant_id and p.employment_id=e.id)
   returning id
  `;
  assert.equal(salaries.length,1,'The Rewards fixture requires a new, unpaid employment');
 });
 const maker={...ctx,userId:actor.userId,personId:actor.personId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]};
 const fixtures=approvedRewardFixtures(owner);
 const checker=await phase('checker',()=>fixtures.setupChecker(maker));
 await phase('company-structure',()=>fixtures.setupCompanyStructureFixture(maker,targets,today,checker));
 const {policy,salary,bonus}=await phase('libraries',()=>fixtures.setupRewardLibrariesFixture(maker,year,undefined,checker));
 await phase('pat',()=>fixtures.confirmFixturePat(maker,company.companyId,year,{targetCents:policy.patTarget,forecastCents:null,actualCents:policy.patActual,targetMonthsBp:policy.targetMonthsBp},checker));
 const name='Fictional Rewards draft '+randomUUID();
 const source=await phase('draft',()=>seedRewardPlanSource(maker,{groupId:null,expectedRevision:0,name,policy,targets:[{companyId:company.companyId,businessUnitId:unit.id}]}));
 const revision=await phase('setup',()=>saveRewardSetupPlan(maker,{versionId:source.versionId,expectedRevision:0,cycleName:name,snapshotDate:today,bindings:[{companyId:company.companyId,businessUnitId:unit.id,salaryVersionId:salary,bonusVersionId:bonus,branchAcknowledged:policy.bonusStructure==='branch'}],reason:'Independently reviewed fictional browser fixture'}));
 await phase('submit',()=>submitRewardSetupPlan(maker,source.versionId,revision));
 await phase('approve',()=>approveRewardSetupPlan(checker,source.versionId,revision+1));
 // Company structure applies to all currently employed company members. The expected roster
 // is derived from the fixture's explicit hires, not from the Rewards projection under test.
 const rewardDraft={companyId:company.companyId,businessUnitId:unit.id,employmentId:person.employmentId,year,snapshotDate:today,
   planVersionId:source.versionId,planName:name,expectedEmploymentIds:[...expectedCompanyEmploymentIds,person.employmentId]};
 if(process.env.PERF_CREATE_REWARD_CENSUS_RECORD==='true'){
  const id=await phase('record',()=>createRewardUnit(maker,{
   name,year,companyId:company.companyId,businessUnitId:unit.id,snapshotDate:today,approvedPlanVersionId:source.versionId,
  }));
  const rows=await owner.client`select u.id,u.status,u.kind,u.created_by,c.name
   from reward_unit u join reward_cycle c on c.id=u.cycle_id and c.tenant_id=u.tenant_id
   where u.tenant_id=${tenant.tenantId}::uuid and u.id=${id}::uuid and u.company_id=${company.companyId}::uuid`;
  assert.deepEqual(rows.map(row=>[row.id,row.status,row.kind,row.created_by,row.name]),[[id,'draft','annual',actor.userId,name]]);
  const entries=await owner.client`select employment_id from reward_entry
   where tenant_id=${tenant.tenantId}::uuid and unit_id=${id}::uuid`;
  assert.deepEqual(entries.map(row=>row.employment_id).sort(),[...rewardDraft.expectedEmploymentIds].sort());
  const events=await owner.client`select actor_id,actor_type from domain_event
   where tenant_id=${tenant.tenantId}::uuid and aggregate_id=${id}::uuid and event_type='reward-unit.created'`;
  assert.deepEqual(events.map(row=>[row.actor_id,row.actor_type]),[[actor.userId,'user']]);
  rewardDraft.unitId=id;
 }
 if(!includeOrgExplorerMember)return rewardDraft;
 const members=await owner.client`select true as verified
   from public.employment e join public.person p on p.id=e.person_id and p.tenant_id=e.tenant_id
   where e.tenant_id=${tenant.tenantId}::uuid and e.id=${person.employmentId}::uuid
     and e.company_id=${company.companyId}::uuid and p.full_name=${REWARDS_ORG_FIXTURE_NAME}
     and e.hired_on=${today}::date and e.terminated_on is null
     and not exists(select 1 from public.app_user u where u.tenant_id=e.tenant_id and u.person_id=e.person_id)
     and not exists(select 1 from public.payslip s where s.tenant_id=e.tenant_id and s.employment_id=e.id)`;
 assert(members.length===1&&members[0].verified===true,
  'Rewards Org Explorer member differs from the independent fictional employment');
 return {...rewardDraft,organisationMember:{
  employmentId:person.employmentId,companyId:company.companyId,name:REWARDS_ORG_FIXTURE_NAME,
 }};
}
