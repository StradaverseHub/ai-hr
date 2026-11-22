/** Seed fictional System Testing records through the canonical workspace owners. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const env=process.env;
assert(env.GITHUB_ACTIONS==='true'&&env.CI==='true'&&env.RUNNER_ENVIRONMENT==='github-hosted');
assert(env.GITHUB_REPOSITORY==='StradaverseHub/ai-hr'&&env.GITHUB_EVENT_NAME==='workflow_dispatch');
assert(env.GITHUB_WORKFLOW==='alpha-focused-checks'&&env.GITHUB_JOB==='selected-tests');
assert(env.PERF_HTTP_SUITE==='browser-route-baseline'&&env.AUTH_PROVIDER==='internal');
assert.equal(env.DATABASE_URL,'postgres://ai_hr_app@127.0.0.1:5433/ai_hr_dev');
assert.equal(env.MIGRATION_DATABASE_URL,'postgres://postgres@127.0.0.1:5433/ai_hr_dev');
const fixturePath=resolve(env.PERF_PRIVATE_DIR,'fixture.json');
const setStage=stage=>writeFileSync(resolve(env.PERF_PRIVATE_DIR,'record-fixture-stage'),stage,{mode:0o600});
const fixture=JSON.parse(readFileSync(fixturePath,'utf8'));
const [group,company]=fixture.users;
assert(fixture.users.length===500&&fixture.tenants.length===2&&group.tenant===0&&company.tenant===0);
assert(group.role==='groupHR'&&company.role==='companyHR'&&group.companyId===company.companyId);

async function source(file){
 const loaded=await import(pathToFileURL(resolve(file)).href);
 return {...loaded.default,...loaded};
}

setStage('system-testing-session');
const [{client,createDb},{resolveEntitlementsTx}]=await Promise.all([source('db/client.ts'),source('core/entitlements.ts')]);
const owner=createDb(env.MIGRATION_DATABASE_URL,{max:1});
try{
 const grants=await owner.client`
  select role,company_id as "companyId" from role_assignment
  where tenant_id=${group.tenantId}::uuid and app_user_id=${group.userId}::uuid
 `;
 assert(grants.some(grant=>grant.role==='hr_admin'&&grant.companyId===null));
 const ctx={tenantId:group.tenantId,userId:group.userId,personId:group.personId,
  grants,roles:[...new Set(grants.map(grant=>grant.role))],
  entitlements:await owner.db.transaction(tx=>resolveEntitlementsTx(tx,group.tenantId))};
 setStage('system-testing-workspace-import');
 const owners=await source('core/system-testing-workspace.ts');
 const {saveTestInstructionDraft,publishTestInstruction,assignTestingCase,beginTestingExecution,saveTestingExecution}=owners;
 assert([saveTestInstructionDraft,publishTestInstruction,assignTestingCase,beginTestingExecution,saveTestingExecution]
  .every(owner=>typeof owner==='function'),'Missing native System Testing workspace owner');
 const employee=fixture.users[4];
 assert(employee.role==='employee'&&employee.companyId===company.companyId);
 const tester={tenantId:ctx.tenantId,userId:employee.userId,personId:employee.personId,roles:['employee'],
  grants:[{role:'employee',companyId:employee.companyId}],entitlements:ctx.entitlements};
 const title='Fictional Personnel save and reopen';
 setStage('system-testing-draft');
 const draft=await saveTestInstructionDraft(ctx,{caseId:null,expectedRevision:0,definition:{
  format:1,title,objective:'Check a saved preferred name.',functionKey:'personnel.profile',
  area:'personnel',moduleCode:'employees',category:'functional',priority:'high',active:true,
  prerequisites:['Use the assigned fictional employee and company HR authority.'],testData:['A fictional preferred name.'],
  steps:[{id:'save',action:'Save the fictional preferred name.',expected:'The profile saves the name.'}],
  expectedBehavior:'The saved name remains visible.',expectedFunction:'Personnel profile write and read.',
  permissions:['Company HR access to the fictional employee.'],jurisdiction:null,configuration:null,screenKeys:['personnelAdmin'],
 }});
 setStage('system-testing-publish');
 const version=await publishTestInstruction(ctx,{caseId:draft.caseId,expectedDraftRevision:draft.revision,expectedVersionId:null});
 setStage('system-testing-assign');
 const assignment=await assignTestingCase(ctx,{caseId:draft.caseId,testerUserId:tester.userId,expectedVersionId:version.versionId,
  active:true,expectedRevision:null});
 setStage('system-testing-begin');
 const execution=await beginTestingExecution(tester,{assignmentId:assignment.assignmentId,expectedVersionId:version.versionId,newAttempt:false});
 const actualResult='The fictional preferred name was retained.';
 setStage('system-testing-save');
 await saveTestingExecution(tester,{executionId:execution.executionId,assignmentId:assignment.assignmentId,versionId:version.versionId,
  expectedRevision:execution.revision,status:'passed',actualResult,comments:'Fictional browser timing fixture',defectNotes:'',improvementNotes:''});
 fixture.systemTestingRecord={caseId:draft.caseId,caseNo:draft.caseNo,versionId:version.versionId,
  ordinal:version.ordinal,executionId:execution.executionId,title,actualResult};
 writeFileSync(fixturePath,JSON.stringify(fixture),{mode:0o600});
 setStage('system-testing-complete');
}catch(error){
 const kinds=new Set(['DrizzleQueryError','PostgresError','TestingRefusal','ZodError','TypeError','AssertionError']);
 const failure=String(error?.message??'').includes('This module cannot be imported from a Client Component module')?'SERVER_ONLY':
  kinds.has(error?.name)?error.name:'unclassified';
 writeFileSync(resolve(env.PERF_PRIVATE_DIR,'record-fixture-failure'),failure,{mode:0o600});
 const frame=String(error?.stack??'').split('\n').map(row=>row.match(/\/(core\/(?:system-testing(?:-workspace)?|feedback|ai-governance)\.ts):(\d+):\d+\)?$/))
  .find(Boolean);
 if(frame)writeFileSync(resolve(env.PERF_PRIVATE_DIR,'record-fixture-failure-location'),frame.slice(1).join(':'),{mode:0o600});
 throw error;
}finally{
 await Promise.all([owner.client.end({timeout:5}),client.end({timeout:5})]);
}
