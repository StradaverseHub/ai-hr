import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateBrowserSource} from './resignation-browser.mjs';
import {validateResignationFixture,REQUIRED_RESIGNATION_CAPTURES,assertResignationCaptureVisibility} from '../../scripts/resignation-browser-acceptance.mjs';
const sha='a'.repeat(40),env={GITHUB_ACTIONS:'true',CI:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_REPOSITORY:'StradaverseHub/ai-hr',AIHR_CI_HEAD:sha,AIHR_CI_CONTROL_HEAD:'b'.repeat(40)};
const id=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function prepared(){
 const actors=['configurer','manager','gbs','ceo','bp','accept','retain','decline','recall','unconfigured','upload','outsider'].map((key,index)=>({key,userId:id(index+20),personId:id(index+40),name:'Fictional '+key,...(key==='configurer'?{}:{employmentId:id(index+120)})}));
 return{preparationOnly:true,reused:false,cases:{accept:[],retain:[],decline:[],recall:[],unconfigured:[],upload:[]},normalEmailObservation:{identityCount:12,normalMessageCount:0,rows:[]},fixture:{
  version:2,tenantId:id(1),companyId:id(2),groupId:id(3),normalDepartmentId:id(60),gapDepartmentId:id(61),repairWorkflowId:id(62),
  uploadDepartmentId:id(63),uploadEmailId:id(64),uploadWorkflowId:id(65),uploadGroupId:id(66),postingApproverGroupId:id(67),
  receivedEmailId:id(90),acceptanceEmailId:id(91),retentionEmailId:id(92),acceptanceWorkflowId:id(6),acceptanceWorkflowName:'Fictional acceptance workflow',submittedWorkflowName:'Fictional submission workflow',
  lastWorkingDay:'2027-02-17',correctedLastWorkingDay:'2027-03-17',effectiveDate:'2027-01-17',acceptanceTemplateId:id(93),retentionTemplateId:id(94),
  acceptanceLetterName:'Resignation acceptance letter',retentionLetterName:'Retention offer e-letter',privateSentinel:'RJ_BROWSER_PRIVATE_93017',workflowIds:Array.from({length:11},(_,index)=>id(index+4)),actors,
  roleBindings:['gbs','ceo','bp'].map((role,index)=>({role,userId:actors.find(actor=>actor.key===role).userId,groupId:role==='gbs'?id(3):id(index+70),...(role!=='gbs'?{routingId:id(index+80)}:{})})),
 }};
}
function rejectsFixture(change,description){
 const value=prepared();assert.doesNotThrow(()=>validateResignationFixture(value),'The baseline must be valid before testing '+description);change(value);assert.throws(()=>validateResignationFixture(value),description);
}

test('requires the exact clean hosted candidate without installation auth or seed override',()=>{assert.doesNotThrow(()=>validateBrowserSource(env,sha,''));for(const changed of [{GITHUB_ACTIONS:'false'},{RUNNER_ENVIRONMENT:'self-hosted'},{AIHR_CI_HEAD:'c'.repeat(40)},{AUTH_PROVIDER:'internal'},{SEED_MAY_DESTROY_OTHER_TENANTS:'true'}])assert.throws(()=>validateBrowserSource({...env,...changed},sha,''));assert.throws(()=>validateBrowserSource(env,sha,' M app/page.tsx'));});

test('accepts the current twelve-actor prepared fixture before screenshot evidence',()=>{
 const value=prepared();assert.equal(validateResignationFixture(value),value.fixture);assert.equal(value.fixture.actors.length,12);assert(value.fixture.actors.every(actor=>actor.personId));assert.deepEqual(Object.keys(value.cases).sort(),['accept','decline','recall','retain','unconfigured','upload']);
});
test('refuses missing native delivery evidence and any identity count other than twelve',()=>{
 rejectsFixture(value=>{delete value.normalEmailObservation;},'Missing delivery identity evidence');
 for(const count of [undefined,0,11,13,'12'])rejectsFixture(value=>{value.normalEmailObservation.identityCount=count;},'Invalid native identity count '+String(count));
});
const newNativeIds=['uploadDepartmentId','uploadEmailId','uploadWorkflowId','uploadGroupId','postingApproverGroupId','acceptanceWorkflowId','receivedEmailId','acceptanceEmailId','retentionEmailId'];
for(const field of newNativeIds)test('requires a native UUID for '+field,()=>{
 rejectsFixture(value=>{delete value.fixture[field];},'Missing '+field);rejectsFixture(value=>{value.fixture[field]='legacy-demo-id';},'Malformed '+field);
});
test('requires the acceptance workflow to be named and belong to the declared defaults',()=>{
 for(const name of [undefined,'','   ',42])rejectsFixture(value=>{value.fixture.acceptanceWorkflowName=name;},'Missing or invalid acceptance workflow name');
 rejectsFixture(value=>{value.fixture.acceptanceWorkflowId=id(999);},'Unrelated acceptance workflow');
});
test('requires a formatted correction date strictly later than the original date',()=>{
 for(const date of [undefined,'tomorrow','2027-2-18','2027-02-17','2027-01-17'])rejectsFixture(value=>{value.fixture.correctedLastWorkingDay=date;},'Invalid or non-advancing correction date '+String(date));
});
test('refuses missing upload actors, duplicate accounts and pre-executed submissions',()=>{
 rejectsFixture(value=>{value.fixture.actors=value.fixture.actors.filter(actor=>actor.key!=='upload');},'Missing upload actor');
 rejectsFixture(value=>{value.fixture.actors[1].userId=value.fixture.actors[0].userId;},'Duplicate actor account');
 rejectsFixture(value=>{value.fixture.actors[1].userId='legacy-demo-user';},'Malformed actor account');
 rejectsFixture(value=>{value.fixture.workflowIds=[];},'Missing default workflows');
 for(const key of ['accept','upload'])rejectsFixture(value=>{value.cases[key]=[{id:id(140)}];},'Pre-executed '+key+' case');
 rejectsFixture(value=>{value.preparationOnly=false;},'Execution receipt used as preparation');
});
test('requires actual GBS, CEO and BP identities and a distinct repair department',()=>{
 rejectsFixture(value=>{value.fixture.roleBindings.pop();},'Missing default role binding');
 rejectsFixture(value=>{value.fixture.roleBindings[0].userId=id(999);},'Role points at a different actor');
 rejectsFixture(value=>{value.fixture.gapDepartmentId=value.fixture.normalDepartmentId;},'Repair department not isolated');
 for(const role of ['gbs','ceo','bp'])rejectsFixture(value=>{value.fixture.actors.find(actor=>actor.key===role).personId=null;},'Unlinked '+role+' Person');
});

// Independent handoff contract: additions or omissions need a reviewed update here, not a derived count.
const requiredByPage={
 configuration:['configuration-navigation','configuration-workflows','configuration-decision','configuration-templates','configuration-document-editor','configuration-email-editor','configuration-groups-routing','configuration-settings','configuration-routing-editor','configuration-document-routing','configuration-retention-settings','configuration-decision-mobile','offboarding-settings-cards-mobile'],
 employee:['employee-submit','employee-tracking','employee-sign','private-offer','employee-offer','retained-outcome','declined-offer','unconfigured-employee-recorded','employee-submit-mobile','employee-tracking-mobile','employee-offer-mobile','employee-offer-posting-blocked'],
 decision:['manager-decision','manager-acceptance','manager-retention','bp-fyi','manager-decision-mobile','declined-accept-only-decision'],
 letters:['letter-review','recalled-letter','owner-regenerated-letter','bp-sign-acceptance','ceo-sign-retention','owner-corrected-last-day'],
 offboarding:['accepted-clearance','personnel-postings-pending','personnel-postings-approved','clearance-posting','linked-acceptance-documents','linked-acceptance-pdf','personnel-posting-edit','personnel-postings-nonapprover'],
 nativeInboxes:['approvals-resignations-list','approvals-fyi-list','my-tasks-list','my-tasks-sign-panel','my-tasks-update-panel','my-tasks-upload-panel','my-tasks-team-peer'],
 communications:['case-communication-owner-edit','case-communication-test-queued','offboarding-communication-preview'],
 repair:['unconfigured-gbs-repair','repaired-decision-assigned'],
 security:['outsider-denied'],
};
test('requires all fifty-eight independent page, role, control and negative-path captures',()=>{
 const expected=Object.values(requiredByPage).flat();assert.equal(expected.length,58);assert.equal(new Set(expected).size,58);assert.equal(REQUIRED_RESIGNATION_CAPTURES.length,58);assert.equal(new Set(REQUIRED_RESIGNATION_CAPTURES).size,58);assert.deepEqual([...REQUIRED_RESIGNATION_CAPTURES].sort(),expected.sort());
});
test('requires exactly six named mobile views including settings and employee offer terms',()=>{
 assert.deepEqual(REQUIRED_RESIGNATION_CAPTURES.filter(id=>id.endsWith('-mobile')).sort(),['configuration-decision-mobile','employee-submit-mobile','employee-tracking-mobile','manager-decision-mobile','offboarding-settings-cards-mobile','employee-offer-mobile'].sort());
});
test('capture evidence refuses empty controls and clipping by the actual app viewport',()=>{
 const visible={bounds:{width:600,height:180},clip:{width:1000,height:800},visibleWidth:600,visibleHeight:180};
 assert.doesNotThrow(()=>assertResignationCaptureVisibility(visible,'visible control'));
 assert.throws(()=>assertResignationCaptureVisibility({...visible,bounds:{width:0,height:0}},'empty control'),/empty/);
 assert.throws(()=>assertResignationCaptureVisibility({...visible,visibleHeight:80},'inner scroll cutoff'),/clipped/);
 assert.throws(()=>assertResignationCaptureVisibility({...visible,visibleWidth:300},'horizontal cutoff'),/horizontally clipped/);
 assert.throws(()=>assertResignationCaptureVisibility({...visible,clip:{width:1000,height:30}},'covered viewport'),/no available/);
});
