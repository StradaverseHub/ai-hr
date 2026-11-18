import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateBrowserSource} from './contract-browser.mjs';
import {validateContractFixture,REQUIRED_CONTRACT_CAPTURES,SUPPORT_CONTRACT_CAPTURES,CONTRACT_MOCKUP_CAPTURE_MAP,assertContractCaptureCoverage,assertDeniedContractResponse} from '../../scripts/contract-browser-acceptance.mjs';
const sha='a'.repeat(40),env={GITHUB_ACTIONS:'true',CI:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_REPOSITORY:'StradaverseHub/ai-hr',AIHR_CI_HEAD:sha,AIHR_CI_CONTROL_HEAD:sha};
const id=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function prepared(){
 const keys=['configurer','proposer','peopleOps','ceo','bp','employee','outsider','conversionEmployee','endingEmployee','declineEmployee'];
 const actors=keys.map((key,n)=>({key,userId:id(n+20),personId:id(n+40),employmentId:id(n+60)}));
 return{preparationOnly:true,cases:[],postings:[],letters:[],approvals:[],fixture:{version:2,tenantId:id(1),companyId:id(2),departmentId:id(3),employmentId:actors.find(a=>a.key==='employee').employmentId,roleId:id(5),workflowId:id(6),templateId:id(7),routingId:id(8),emailTemplateId:id(9),contractNumber:4,initialSalary:'4800.00',agreedSalary:'5200.12',actors,scenarios:Object.fromEntries(Object.entries({renewPay:'employee',conversion:'conversionEmployee',ending:'endingEmployee',decline:'declineEmployee'}).map(([key,actorKey])=>[key,{actorKey,employmentId:actors.find(a=>a.key===actorKey).employmentId}]))}};
}
test('binds a clean hosted source and refuses installation auth and seed overrides',()=>{
 assert.doesNotThrow(()=>validateBrowserSource(env,sha,''));
 for(const change of [{GITHUB_ACTIONS:'false'},{RUNNER_ENVIRONMENT:'self-hosted'},{AIHR_CI_HEAD:'c'.repeat(40)},{AIHR_CI_CONTROL_HEAD:'b'.repeat(40)},{AUTH_PROVIDER:'internal'},{SEED_MAY_DESTROY_OTHER_TENANTS:'true'}])assert.throws(()=>validateBrowserSource({...env,...change},sha,''));
 assert.throws(()=>validateBrowserSource(env,sha,' M app/page.tsx'));
});
test('native preparation cannot fake a case, posting, actor, or expected monetary outcome',()=>{
 assert.equal(validateContractFixture(prepared()).version,2);
 for(const mutate of [v=>v.cases.push({id:id(70)}),v=>v.letters.push({id:id(72)}),v=>v.approvals.push({id:id(73)}),v=>v.fixture.scenarios.ending.actorKey='employee',v=>v.fixture.scenarios.conversion.employmentId=v.fixture.employmentId,v=>v.fixture.actors[1].personId=v.fixture.actors[0].personId,v=>v.postings.push({id:id(71)}),v=>v.fixture.actors.pop(),v=>v.fixture.actors[1].userId=v.fixture.actors[0].userId,v=>v.fixture.agreedSalary='9999.00',v=>v.fixture.scenarios.renewPay.employmentId=id(90)]){const value=prepared();mutate(value);assert.throws(()=>validateContractFixture(value));}
});
test('requires actual builder, approval, both signatures, posting, manual pay, closure and denial captures',()=>{
 assert.equal(REQUIRED_CONTRACT_CAPTURES.length,72);
 assert.equal(new Set(REQUIRED_CONTRACT_CAPTURES).size,REQUIRED_CONTRACT_CAPTURES.length);
 assert.deepEqual(SUPPORT_CONTRACT_CAPTURES,['conversion-preview-result','case-progress-rail-mobile','workflow-steps','workflow-actions','dry-run-result','document-fields-controls-mobile','recipient-options-mobile','posting-actions-mobile','posting-editor-action-mobile','pay-confirmation-action-mobile','decline-recorded-outcome','contract-settings-controls','contract-settings-controls-mobile','contract-role-assignments','contract-role-permissions','routing-actions']);
 for(const required of ['shared-workflow-editor','ceo-approval','people-ops-review','bp-signature','employee-signature','posting-pending','posting-editor','posting-queued','posting-queued-mobile','posting-approved','pay-confirmation','closed-case','outsider-denied','posting-pending-mobile','posting-editor-mobile','pay-confirmation-mobile'])assert(REQUIRED_CONTRACT_CAPTURES.includes(required));
});

test('pins every approved product view and rejects partial/mobile-only/duplicated review evidence',()=>{
 const ids=['tracker','decision','decision-preview','conversion','ending','case-progress','approvals','approval-detail','letter-review','letter-edit','tasks','needs','sign','decline','postings','movement','pay','payroll','handoff','leavers','leaver','personnel','settings','access','workflows','workflow','dryrun','templates','template','fields','template-preview','versions','email','email-preview','groups','routing','recipients','states','conversion-preview','closed'];
 assert.deepEqual(Object.keys(CONTRACT_MOCKUP_CAPTURE_MAP).sort(),ids.sort());
 const captures=REQUIRED_CONTRACT_CAPTURES.map(id=>({id,url:'/actual-route',geometry:{width:id.endsWith('-mobile')?390:1440,height:id.endsWith('-mobile')?844:1000},sha256:'f'.repeat(64),...(SUPPORT_CONTRACT_CAPTURES.includes(id)?{captureMode:'viewport',target:{x:20,y:120,width:200,height:100,unobscured:true},targetAfter:{x:20,y:120,width:200,height:100,unobscured:true}}:{})}));
 assert.doesNotThrow(()=>assertContractCaptureCoverage(captures));
 for(const mutate of [v=>v.splice(v.findIndex(c=>c.id==='conversion-preview'),1),v=>v.push({...v[0]}),v=>v.find(c=>c.id==='my-tasks').geometry.width=390,v=>v.find(c=>c.id==='native-offboarding-case').sha256='',v=>v.find(c=>c.id==='recipient-picker').url='']){const value=structuredClone(captures);mutate(value);assert.throws(()=>assertContractCaptureCoverage(value));}
});

test('denial requires the actual native screen, noindex and no private case evidence for either HTTP status',()=>{
 const privateEvidence=['5200.12','5,200.12','Fictional Contract employee','Retain the agreed fictional specialist role.',id(90)];
 const denial={status:404,notFoundHeading:true,notFoundMessage:true,robots:['noindex'],caseUiCount:0,html:'<h1>404</h1><h2>This page could not be found.</h2>'};
 for(const status of [200,404]){
  assert.doesNotThrow(()=>assertDeniedContractResponse({...denial,status},privateEvidence));
  for(const change of [{notFoundHeading:false},{notFoundMessage:false},{robots:[]},{robots:['index, follow']},{caseUiCount:1},{html:''},{html:'<main>Actual Contract case</main>',notFoundHeading:false,notFoundMessage:false}])assert.throws(()=>assertDeniedContractResponse({...denial,status,...change},privateEvidence));
  for(const evidence of privateEvidence)assert.throws(()=>assertDeniedContractResponse({...denial,status,html:denial.html+evidence},privateEvidence));
 }
 for(const status of [201,302,401,403,500])assert.throws(()=>assertDeniedContractResponse({...denial,status},privateEvidence));
 for(const evidence of [[],[''],[5200.12]])assert.throws(()=>assertDeniedContractResponse(denial,evidence));
});

test('requires visible bounded target evidence for every support capture at the real viewport size',()=>{
 const captures=REQUIRED_CONTRACT_CAPTURES.map(id=>({id,url:'/actual-route',geometry:{width:id.endsWith('-mobile')?390:1440,height:id.endsWith('-mobile')?844:1000},sha256:'f'.repeat(64),...(SUPPORT_CONTRACT_CAPTURES.includes(id)?{captureMode:'viewport',target:{x:20,y:120,width:200,height:100,unobscured:true},targetAfter:{x:20,y:120,width:200,height:100,unobscured:true}}:{})}));
 for(const id of SUPPORT_CONTRACT_CAPTURES){
  assert.throws(()=>assertContractCaptureCoverage(captures.filter(c=>c.id!==id)));
  for(const mutate of [c=>delete c.target,c=>delete c.targetAfter,c=>c.captureMode='fullPage',c=>c.targetAfter.y+=2,c=>c.targetAfter.unobscured=false,c=>c.target.unobscured=false,c=>c.target.x=-2,c=>c.target.y=c.geometry.height,c=>c.target.width=0,c=>c.target.height=NaN,c=>c.target.width=true,c=>c.geometry.height+=100]){
   const value=structuredClone(captures);mutate(value.find(c=>c.id===id));assert.throws(()=>assertContractCaptureCoverage(value));
  }
 }
});

test('provisions the shared inbox verifier through its canonical owner before fixture and browser work',()=>{
 const source=readFileSync(new URL('./contract-browser.mjs',import.meta.url),'utf8');
 const seed=source.indexOf("run('seed',process.execPath,['--import','tsx','db/seed.ts']);");
 const provision=source.indexOf("run('provision-resignation-runtime',process.execPath,['--conditions=react-server','--import','tsx','scripts/provision-resignation-runtime.ts']);");
 const fixture=source.indexOf("const first=fixture('prepare')");
 assert(seed>=0&&provision>seed&&fixture>provision,'Canonical owner provisioning precedes preparation on the actual same database environment');
 assert.match(source,/AUTH_SESSION_KEY:sessionKey/);
 assert.match(source,/env=dbEnv/);
 const owner=readFileSync(new URL('../../scripts/provision-resignation-runtime.ts',import.meta.url),'utf8');
 assert.match(owner,/Schema-owner admission required/);
 assert.match(owner,/rotation requires a separate reviewed procedure/);
});
