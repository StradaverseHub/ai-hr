/** Add two draft joiners to the existing disposable browser database through the normal owners. */
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
const path=resolve(env.PERF_PRIVATE_DIR,'fixture.json');
const setStage=stage=>writeFileSync(resolve(env.PERF_PRIVATE_DIR,'record-fixture-stage'),stage,{mode:0o600});
function recordFailure(error){
 const knownKinds=new Set(['DrizzleQueryError','PostgresError','PerfError','ZodError','TypeError']);
 let category='unclassified',source=null;
 for(let current=error,depth=0;current instanceof Error&&depth<4;depth++){
  const code=Object.getOwnPropertyDescriptor(current,'code')?.value;
  if(typeof code==='string'&&/^(?:[0-9A-Z]{5}|ERR_ASSERTION)$/.test(code))category=code;
  else if(category==='unclassified'&&knownKinds.has(current.name))category=current.name;
  const frames=String(current.stack??'').split('\n').filter(line=>/^\s+at\b/.test(line));
  source??=frames.map(line=>line.match(/\/(core\/performance\.ts|packs\/performance\/onehr\/(?:service|participation-service)\.ts):(\d+):\d+\)?$/))
   .find(Boolean)?.slice(1).join(':')??null;
  current=Object.getOwnPropertyDescriptor(current,'cause')?.value;
 }
 writeFileSync(resolve(env.PERF_PRIVATE_DIR,'record-fixture-failure'),category,{mode:0o600});
 if(source)writeFileSync(resolve(env.PERF_PRIVATE_DIR,'record-fixture-failure-location'),source,{mode:0o600});
}
setStage('fixture');
const fixture=JSON.parse(readFileSync(path,'utf8'));
const [group,company]=fixture.users;
assert(fixture.users.length===500&&fixture.tenants.length===2&&group.tenant===0&&company.tenant===0);
assert(group.role==='groupHR'&&company.role==='companyHR'&&group.companyId===company.companyId);
const source=file=>import(pathToFileURL(resolve(process.cwd(),file)).href);
const [{client,createDb,withTenant},{resolveEntitlementsTx}]=await Promise.all([
 source('db/client.ts'),source('core/entitlements.ts'),
]);
const owner=createDb(env.MIGRATION_DATABASE_URL,{max:1});
try{
 const {onboardingContext,onboardingList,onboardingSaveConfig,v9Setup}=await source('packs/lifecycle/service.ts');
 const {saveEmployeeDraft}=await source('core/employee-draft.ts');
 const grants=[
  {role:'employee',companyId:group.companyId},{role:'hr_admin',companyId:null},
  {role:'payroll_partner',companyId:null},{role:'performance_comp_partner',companyId:null},
 ];
 const ctx={tenantId:group.tenantId,userId:group.userId,personId:group.personId,grants,
  roles:grants.map(grant=>grant.role),entitlements:await owner.db.transaction(tx=>resolveEntitlementsTx(tx,group.tenantId))};
 setStage('onboarding-config');
 await v9Setup(ctx);
 const {config,revision}=await onboardingContext(ctx);
 config.access.onboarding=[...new Set([...config.access.onboarding,group.userId,company.userId])];
 await onboardingSaveConfig(ctx,revision,config);
 setStage('draft-joiners');
 const drafts=[];
 for(const [index,organization] of fixture.tenants[0].companies.slice(0,2).entries()){
  const name='Fictional Browser Joiner '+(index+1);
  const {id}=await saveEmployeeDraft(ctx,{currentStep:1,data:{
   profile:{fullName:name,primaryEmail:'browser-joiner-'+(index+1)+'@example.invalid'},
   employment:{companyId:organization.companyId,employmentType:'full_time',hiredOn:fixture.today},
  }});
  drafts.push({id,name});
 }
 const rows=await onboardingList(ctx);
 assert(drafts.every(draft=>rows.some(row=>row.case.sourceDraftId===draft.id)),
  'The normal draft owner did not create both New Joiners rows');
 fixture.joiners=drafts.map(draft=>draft.name);
 if(env.PERF_LIFECYCLE_RECORDS==='true'){
  const lifecycle=await source('packs/lifecycle/service.ts');
  const companyId=company.companyId;
  const joiner='Fictional Lifecycle Legacy Joiner';
  const leaver='Fictional Lifecycle Legacy Leaver';
  const model='Fictional Lifecycle Browser Laptop';
  const justification='Fictional Lifecycle Browser Request';
  setStage('lifecycle-defaults');
  await lifecycle.loadHandoverDefaults(ctx);
  setStage('legacy-onboarding');
  const onboarding=await lifecycle.createOnboardingCase(ctx,{
   companyId,fullName:joiner,employeeNo:'PERF-LEGACY-ONB',joinDate:fixture.today,
  });
  setStage('legacy-offboarding');
  const offboarding=await lifecycle.createOffboardingCase(ctx,{
   companyId,fullName:leaver,employeeNo:'PERF-LEGACY-OFB',
   resignationDate:fixture.today,lastWorkingDay:fixture.today,
  });
  setStage('lifecycle-asset');
  const asset=await lifecycle.registerAsset(ctx,{companyId,assetType:'laptop',model});
  const catalogue=(await lifecycle.listCatalogue(ctx)).find(item=>item.itemCode==='HW-001'&&item.active);
  assert(catalogue,'Expected the standard active Laptop catalogue item');
  setStage('lifecycle-asset-request');
  const request=await lifecycle.createAssetRequest(ctx,{companyId,catalogueId:catalogue.id,justification});
  fixture.lifecycleRecords={onboarding,offboarding,asset,request,joiner,leaver,model,justification};
 }
 if(env.PERF_LIFECYCLE_RECORDS==='true')try{
  setStage('performance-cycle-grades');
  const [{createJobGrade},{setEmploymentGrade}]=await Promise.all([source('core/admin.ts'),source('core/org.ts')]);
  const [existingGrade]=await owner.client`select id from job_grade where tenant_id=${group.tenantId}::uuid
   and archived_at is null and app.architecture_grade_code(code)='12' order by id limit 1`;
  const grade=existingGrade??await createJobGrade(ctx,{code:'JG12',name:'Fictional Grade 12',rank:12});
  const members=fixture.users.filter(actor=>actor.tenantId===group.tenantId&&actor.companyId===company.companyId);
  assert.equal(members.length,50,'Expected the fictional company roster for the Performance cycle');
  await withTenant(ctx,async tx=>{
   for(const member of members)await setEmploymentGrade(ctx,{employmentId:member.employmentId,gradeId:grade.id},tx);
  });
  const {createCycle,openCycle,previewEligibleCount}=await source('packs/performance/service.ts');
  const year=fixture.today.slice(0,4);
  const name='Fictional Browser Performance Cycle';
  setStage('performance-cycle-create');
  const {cycleId}=await createCycle(ctx,{
   companyId:company.companyId,name,periodStart:year+'-01-01',periodEnd:year+'-12-31',assessmentWorkflow:true,
  });
  setStage('performance-cycle-participants');
  const {count}=await previewEligibleCount(ctx,{companyId:company.companyId,assessmentWorkflow:true});
  assert(count>0,'Expected eligible fictional Performance participants');
  setStage('performance-cycle-open');
  const opened=await openCycle(ctx,{cycleId});
  assert.equal(opened.reviewsSpawned,count,'Expected the populated OneHR roster to match the native preview');
  fixture.performanceRecords={cycleId,name};
 }catch(error){
  recordFailure(error);
  fixture.performanceRecordsUnavailable=true;
 }
 writeFileSync(path,JSON.stringify(fixture),{mode:0o600});
 if(!fixture.performanceRecordsUnavailable)setStage('complete');
}catch(error){
 recordFailure(error);
 throw error;
}finally{await Promise.all([owner.client.end(),client.end()]);}
