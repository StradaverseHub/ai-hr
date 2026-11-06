/** Extra Rewards membership for the workflow-only synthetic fixture. */
import assert from 'node:assert/strict';
import {establishRewardMembership} from '../../test/rewards-shared-policy-fixture.ts';

export async function prepareRewardDraftFixture({owner,schema,ctx,tenant,company,today}){
 assert.equal(process.env.PERF_HTTP_SUITE,'workflow-preflight','draft witness fixture must stay out of the load workload');
 assert.equal(process.env.GITHUB_ACTIONS,'true');
 assert.equal(new URL(process.env.DATABASE_URL).pathname,'/ai_hr_dev');
 assert.equal(ctx.tenantId,tenant.tenantId);
 const year=Number(today.slice(0,4));
 const [unit]=await owner.db.insert(schema.businessUnit).values({
  tenantId:tenant.tenantId,companyId:company.companyId,code:'PERF-DRAFT-BU',name:'Fictional draft witness unit',
 }).returning({id:schema.businessUnit.id});
 // The live setup form uses canonical company/BU membership, not a master catalogue row alone.
 // This employee has no credentials and is created after the baseline Payroll fixture runs close.
 const person=await establishRewardMembership(ctx,{
  tenantId:tenant.tenantId,companyId:company.companyId,businessUnitId:unit.id,departmentId:company.departmentId,year,
 });
 return {companyId:company.companyId,businessUnitId:unit.id,employmentId:person.employmentId,year,snapshotDate:today};
}
