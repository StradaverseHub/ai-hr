import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const env=process.env;
assert(env.GITHUB_ACTIONS==='true'&&env.CI==='true'&&env.RUNNER_ENVIRONMENT==='github-hosted');
assert(env.GITHUB_REPOSITORY==='StradaverseHub/ai-hr'&&env.GITHUB_EVENT_NAME==='workflow_dispatch');
assert(env.GITHUB_WORKFLOW==='alpha-focused-checks'&&env.GITHUB_JOB==='selected-tests');
assert(env.PERF_HTTP_SUITE==='browser-route-baseline'&&env.AUTH_PROVIDER==='internal');
assert.equal(env.DATABASE_URL,'postgres://ai_hr_app@127.0.0.1:5433/ai_hr_dev');
assert.equal(env.MIGRATION_DATABASE_URL,'postgres://postgres@127.0.0.1:5433/ai_hr_dev');
const fixturePath=resolve(env.PERF_PRIVATE_DIR,'fixture.json');
const fixture=JSON.parse(readFileSync(fixturePath,'utf8'));
const [group,companyAdmin]=fixture.users;
assert(group.role==='groupHR'&&companyAdmin.role==='companyHR'&&group.companyId===companyAdmin.companyId);
const source=file=>import(pathToFileURL(resolve(process.cwd(),file)).href);
const [{client,createDb},{resolveEntitlementsTx},recruitment]=await Promise.all([
 source('db/client.ts'),source('core/entitlements.ts'),source('packs/recruitment/service.ts'),
]);
const owner=createDb(env.MIGRATION_DATABASE_URL,{max:1});
const tenantId=group.tenantId,companyId=group.companyId;
const stageFile=resolve(env.PERF_PRIVATE_DIR,'recruitment-fixture-stage');
const mark=stage=>writeFileSync(stageFile,stage,{mode:0o600});
try{
 mark('principal');
 const [principal]=await owner.client`select tenant_id,grants from app.principal(${group.userId}::uuid)`;
 assert(principal?.tenant_id===tenantId&&principal.grants.some(grant=>grant.role==='hr_admin'&&grant.companyId===null));
 const ctx={tenantId,userId:group.userId,personId:group.personId,grants:principal.grants,
  roles:[...new Set(principal.grants.map(grant=>grant.role))],
  entitlements:await owner.db.transaction(tx=>resolveEntitlementsTx(tx,tenantId))};
 const [grade]=await owner.client`insert into job_grade(tenant_id,code,name,rank)
  values (${tenantId}::uuid,'PERFREC','Fictional recruitment grade',100) returning id`;
 const shared={companyId,workLocation:'Kuala Lumpur',employmentType:'full_time',recruitmentType:'budgeted'};
 const title='Fictional roster analyst recruitment';
 const reqTitle='Fictional administrative requisition';
 const applicant='Fictional roster analyst applicant';
 mark('requisition');
 const requisition=await recruitment.createRequisition(ctx,{...shared,title:reqTitle,vacancies:'2'});
 mark('position');
 const job=await recruitment.createJob(ctx,{...shared,title,jobGradeIds:[grade.id]});
 mark('application');
 const {applicationId,candidateId}=await recruitment.addApplication(ctx,{
  jobId:job.id,fullName:applicant,email:'fictional-recruitment@example.invalid',source:'Referral',sendReceipt:false,
 });
 mark('verify');
 const detail=await recruitment.applicationInterviews(ctx,applicationId);
 assert.equal(detail.candidateName,applicant);
 assert.equal(detail.jobTitle,title);
 const [binding]=await owner.client`select tenant_id,company_id,candidate_id,job_id from recruitment_application
  where id=${applicationId}::uuid`;
 assert.deepEqual({...binding},{tenant_id:tenantId,company_id:companyId,candidate_id:candidateId,job_id:job.id});
 fixture.recruitmentRecords={companyId,requisitionId:requisition.id,reqTitle,jobId:job.id,title,applicationId,applicant};
 writeFileSync(fixturePath,JSON.stringify(fixture),{mode:0o600});
 mark('complete');
}finally{
 await Promise.all([client.end({timeout:5}),owner.client.end({timeout:5})]);
}
