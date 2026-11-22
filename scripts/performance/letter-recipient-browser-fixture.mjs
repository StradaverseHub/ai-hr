/** Add a submitted and an issued letter to the job-owned fictional fixture. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const env=process.env;
assert(env.GITHUB_ACTIONS==='true'&&env.CI==='true'&&env.RUNNER_ENVIRONMENT==='github-hosted');
assert(env.GITHUB_REPOSITORY==='StradaverseHub/ai-hr'&&env.GITHUB_EVENT_NAME==='workflow_dispatch');
assert(env.GITHUB_WORKFLOW==='alpha-focused-checks'&&env.GITHUB_JOB==='selected-tests');
assert(env.PERF_HTTP_SUITE==='workflow-preflight'&&env.AUTH_PROVIDER==='internal');
assert.equal(env.DATABASE_URL,'postgres://ai_hr_app@127.0.0.1:5433/ai_hr_dev');
assert.equal(env.MIGRATION_DATABASE_URL,'postgres://postgres@127.0.0.1:5433/ai_hr_dev');
const fixturePath=resolve(env.PERF_PRIVATE_DIR,'fixture.json');
const fixture=JSON.parse(readFileSync(fixturePath,'utf8'));
const [tenant]=fixture.tenants;
const seed=tenant.letterDraft;
assert(fixture.users.length===500&&fixture.tenants.length===2&&seed);
const companyActors=fixture.users.filter(actor=>actor.tenant===0&&actor.companyId===seed.companyId);
const author=companyActors.find(actor=>actor.role==='companyHR'&&actor.index===seed.authorIndex);
const reviewer=companyActors.find(actor=>actor.role==='companyHR'&&actor.index!==seed.authorIndex);
const [recipient,otherEmployee]=companyActors.filter(actor=>actor.role==='employee');
assert(author&&reviewer&&recipient&&otherEmployee);

async function source(file){
 const loaded=await import(pathToFileURL(resolve(file)).href);
 return {...loaded.default,...loaded};
}

const [{client,createDb},{resolveEntitlementsTx},letters]=await Promise.all([
 source('db/client.ts'),source('core/entitlements.ts'),source('core/letters.ts'),
]);
const owner=createDb(env.MIGRATION_DATABASE_URL,{max:1});
try{
 const entitlements=await owner.db.transaction(tx=>resolveEntitlementsTx(tx,tenant.tenantId));
 const context=actor=>({tenantId:actor.tenantId,userId:actor.userId,personId:actor.personId,roles:['hr_admin'],
  grants:[{role:'hr_admin',companyId:seed.companyId}],entitlements});
 const writer=context(author),signatory=context(reviewer);
 const [{policy}]=await owner.client`
  select policy from letter_policy_version where tenant_id=${tenant.tenantId}::uuid and company_id=${seed.companyId}::uuid
   and category='confirmation' and enabled order by ordinal desc limit 1`;
 assert.equal(policy.emailNotifications,false);
 assert.equal(policy.portalNotifications,false);
 assert.equal(policy.acknowledgement,'acknowledge');
 assert.equal(policy.signatoryUserId,reviewer.userId);
 async function submitted(employee){
  const {batchId}=await letters.createLetterDraftBatch(writer,{companyId:seed.companyId,templateVersionId:seed.versionId,
   employmentIds:[employee.employmentId],operationKey:randomUUID(),
   customValues:{[employee.employmentId]:{effectiveDate:{kind:'date',value:fixture.today}}}});
  await letters.submitLetterBatch(writer,batchId);
  const batch=await letters.getLetterGenerationBatch(writer,batchId);
  assert(batch?.rows.length===1);
  const [{record,revision}]=batch.rows;
  assert(record.state==='submitted'&&revision?.id);
  return {id:record.id,reference:record.reference,expectedRevisionId:revision.id,expectedLockVersion:record.lockVersion};
 }
 const issued=await submitted(recipient);
 const approved=await letters.decideLetter(signatory,{letterId:issued.id,
  expectedRevisionId:issued.expectedRevisionId,expectedLockVersion:issued.expectedLockVersion,
  decision:{action:'approve',comment:'Fictional Chromium fixture signoff',confirmSignature:true}});
 const {artifactId}=await letters.issueLetter(signatory,{letterId:issued.id,
  expectedRevisionId:issued.expectedRevisionId,expectedLockVersion:approved.lockVersion});
 const pending=await submitted(otherEmployee);
 fixture.letterRecipientRecords={issued:{id:issued.id,reference:issued.reference,artifactId},
  pending:{id:pending.id,reference:pending.reference},reviewerIndex:reviewer.index,recipientIndex:recipient.index,
  otherEmployeeIndex:otherEmployee.index};
 writeFileSync(fixturePath,JSON.stringify(fixture),{mode:0o600});
}finally{
 await Promise.all([owner.client.end({timeout:5}),client.end({timeout:5})]);
}
