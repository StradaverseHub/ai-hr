import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateBrowserSource} from './contract-browser.mjs';
import {validateContractFixture,REQUIRED_CONTRACT_CAPTURES} from '../../scripts/contract-browser-acceptance.mjs';
const sha='a'.repeat(40),env={GITHUB_ACTIONS:'true',CI:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_REPOSITORY:'StradaverseHub/ai-hr',AIHR_CI_HEAD:sha,AIHR_CI_CONTROL_HEAD:sha};
const id=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function prepared(){return{preparationOnly:true,cases:[],postings:[],fixture:{version:1,tenantId:id(1),companyId:id(2),departmentId:id(3),employmentId:id(4),roleId:id(5),workflowId:id(6),templateId:id(7),contractNumber:4,initialSalary:'4800.00',agreedSalary:'5200.12',actors:['configurer','proposer','peopleOps','ceo','bp','employee','outsider'].map((key,n)=>({key,userId:id(n+20),personId:id(n+40)})),scenarios:{renewPay:{employmentId:id(4)}}}};}
test('binds a clean hosted source and refuses installation auth and seed overrides',()=>{
 assert.doesNotThrow(()=>validateBrowserSource(env,sha,''));
 for(const change of [{GITHUB_ACTIONS:'false'},{RUNNER_ENVIRONMENT:'self-hosted'},{AIHR_CI_HEAD:'c'.repeat(40)},{AIHR_CI_CONTROL_HEAD:'b'.repeat(40)},{AUTH_PROVIDER:'internal'},{SEED_MAY_DESTROY_OTHER_TENANTS:'true'}])assert.throws(()=>validateBrowserSource({...env,...change},sha,''));
 assert.throws(()=>validateBrowserSource(env,sha,' M app/page.tsx'));
});
test('native preparation cannot fake a case, posting, actor, or expected monetary outcome',()=>{
 assert.equal(validateContractFixture(prepared()).version,1);
 for(const mutate of [v=>v.cases.push({id:id(70)}),v=>v.postings.push({id:id(71)}),v=>v.fixture.actors.pop(),v=>v.fixture.actors[1].userId=v.fixture.actors[0].userId,v=>v.fixture.agreedSalary='9999.00',v=>v.fixture.scenarios.renewPay.employmentId=id(90)]){const value=prepared();mutate(value);assert.throws(()=>validateContractFixture(value));}
});
test('requires actual builder, approval, both signatures, posting, manual pay, closure and denial captures',()=>{
 assert.equal(new Set(REQUIRED_CONTRACT_CAPTURES).size,REQUIRED_CONTRACT_CAPTURES.length);
 for(const required of ['shared-workflow-editor','ceo-approval','people-ops-review','bp-signature','employee-signature','posting-pending','posting-editor','posting-queued','posting-queued-mobile','posting-approved','pay-confirmation','closed-case','outsider-denied','posting-pending-mobile','posting-editor-mobile','pay-confirmation-mobile'])assert(REQUIRED_CONTRACT_CAPTURES.includes(required));
});
