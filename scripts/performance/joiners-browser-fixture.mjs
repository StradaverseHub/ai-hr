/** Add two draft joiners to the existing disposable browser database through the normal owners. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {clockingFixtureText,performanceFixtureCalendar} from './fixture-workload.mjs';

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
 if(env.PERF_LETTER_CATALOG_RECORDS==='true'){
  const {saveLetterField,saveLetterTemplate}=await source('core/letters.ts');
  const companyId=company.companyId,key='performanceEmployeeName',fieldLabel='Fictional employee name';
  const field=await saveLetterField(ctx,{companyId,active:true,definition:{
   key,label:fieldLabel,description:'Name for the fictional preview',kind:'text',source:'employee.name',
   required:true,editable:false,sensitive:false,
  }});
  const code='PERF-CATALOG-CHECK',name='Fictional confirmation template',salutation='Fictional confirmation for ';
  const {versionId}=await saveLetterTemplate(ctx,{
   companyId,code,name,category:'confirmation',effectiveFrom:fixture.today,
   document:{version:1,language:'en',blocks:[{type:'paragraph',content:[{type:'text',text:salutation},{type:'field',key}]}]},
   fieldVersionIds:[field.id],
  });
  fixture.letterCatalogRecord={versionId,fieldId:field.id,fieldLabel,code,name,salutation,key};
 }

 if(env.PERF_PAYROLL_REPORT_RECORDS==='true'){
  setStage('employee-master-report');
  const [{saveEmployeeMasterReport},{defaultMasterColumn},{PERSONNEL_FIELDS},{saveCustomReport},
   {DEFAULT_PAYROLL_COMPARISON,PAYROLL_COMPARISON_DATASET},{payrollComparisonSpec}]=await Promise.all([
   source('core/employee-master-reports.ts'),source('lib/employee-master-report.ts'),
   source('lib/personnel-field-registry.ts'),source('core/custom-reports.ts'),source('lib/payroll-period-comparison.ts'),
   source('core/report-payroll-comparison.ts'),
  ]);
  const employee=fixture.users[4];
  assert(employee.role==='employee'&&employee.companyId===company.companyId);
  const employeeCode='PERF'+String(employee.index).padStart(4,'0');
  const code=PERSONNEL_FIELDS.find(field=>field.owner==='employment'&&field.ownerField==='employeeCode');
  assert(code);
  const companyIds=[company.companyId];
  const masterName='Fictional saved Employee Master';
  const master=await saveEmployeeMasterReport(ctx,companyIds,{name:masterName,description:'Fictional browser report',sharedRoleIds:['hr_admin'],
   spec:{v:2,asAt:fixture.today,companyIds,includeDrafts:false,columns:[defaultMasterColumn(code)],
    expression:{id:'root',type:'group',logic:'and',children:[{id:'employee',type:'condition',field:code.id,operator:'eq',value:employeeCode}]},
    sorts:[],groups:[],pdf:{paper:'A4',orientation:'landscape',margins:'normal',logo:false,pageBreakGroups:false}},
  });
  const comparisonName='Fictional saved Payroll Comparison';
  const historicalMonth=performanceFixtureCalendar(fixture.today).historicalMonth;
  setStage('payroll-comparison-report');
  const comparison=await saveCustomReport(ctx,{name:comparisonName,companyIds,shared:false,datasetId:PAYROLL_COMPARISON_DATASET,
   spec:payrollComparisonSpec({...DEFAULT_PAYROLL_COMPARISON,columns:['employeeCode','employeeName'],onlyVariances:false}),
  });
  fixture.payrollReportRecords={masterId:master.id,masterName,comparisonId:comparison.id,comparisonName,historicalMonth,employeeCode};
 }

 if(env.PERF_SAVED_REPORT_RECORDS==='true'){
  const {saveCustomReport}=await source('core/custom-reports.ts');
  const employee=fixture.users[4];
  assert(employee.role==='employee'&&employee.companyId===company.companyId);
  const name='Fictional saved Daily Attendance report';
  const datasetId='attendance_daily';
  const {id}=await saveCustomReport(ctx,{name,datasetId,shared:true,spec:{
   datasetId,columns:['employeeCode','name','attendanceDate'],sort:null,groupBy:null,
   filters:{month:fixture.today.slice(0,7),name:employee.name},layout:{orientation:'landscape'},
  }});
  fixture.savedReportRecord={id,name,datasetId};
 }

 if(env.PERF_LOAN_RECORDS==='true'){
  const {createLoan}=await source('core/loans.ts');
  const employee=fixture.users[4];
  assert(employee.role==='employee'&&employee.companyId===company.companyId);
  const {id}=await createLoan(ctx,{
   employmentId:employee.employmentId,loanType:'personal',principal:1200,interestRate:0,
   interestMethod:'flat',durationMonths:4,startDate:fixture.today.slice(0,7)+'-01',
  });
  fixture.loanRecord={id};
 }

 if(env.PERF_ATTENDANCE_HISTORY_RECORDS==='true'){
  const [{requestAttendanceCorrection},{commitClockingImport}]=await Promise.all([
   source('core/attendance.ts'),source('core/attendance-clocking-import.ts'),
  ]);
  const employee=fixture.users[4];
  assert(employee.role==='employee'&&employee.companyId===company.companyId);
  const [principal]=await owner.client`select tenant_id,grants from app.principal(${employee.userId}::uuid)`;
  assert(principal?.tenant_id===group.tenantId&&Array.isArray(principal.grants));
  const self={tenantId:employee.tenantId,userId:employee.userId,personId:employee.personId,grants:principal.grants,
   roles:[...new Set(principal.grants.map(grant=>grant.role))],entitlements:ctx.entitlements};
  const reason='Fictional attendance shift correction';
  const {correctionId}=await requestAttendanceCorrection(self,{
   employmentId:employee.employmentId,date:fixture.today,checkIn:'09:15',checkOut:'18:15',reason,
  });
  const date=performanceFixtureCalendar(fixture.today).importDate(2);
  const text=clockingFixtureText(fixture.users,company.tenant,company.company,date);
  const fileName='PERF_CLOCKING_HISTORY.csv';
  const imported=await commitClockingImport(ctx,{
   mappingId:fixture.tenants[company.tenant].clockingMappingId,companyId:company.companyId,
   fileName,text,fileBytes:Buffer.byteLength(text),
  });
  assert(imported.runId&&imported.imported===100&&!imported.failureReason);
  fixture.attendanceHistoryRecords={correctionId,reason,clockingRunId:imported.runId,fileName};
 }

 if(env.PERF_ATTENDANCE_CONFIGURATION_RECORDS==='true'){
  const [{createHolidayGroup},{ensureStandardRule},{seedPayComponentCatalog},{createAllowancePolicy}]=await Promise.all([
   source('core/admin.ts'),source('core/attendance-rule.ts'),source('core/pay-components.ts'),source('core/attendance-allowance.ts'),
  ]);
  const calendarName='Fictional Selangor Warehouse Calendar';
  const calendar=await createHolidayGroup(ctx,{name:calendarName,states:['Selangor'],code:'PERF-SGR'});
  const rule=await ensureStandardRule(ctx);
  await seedPayComponentCatalog(ctx);
  const [component]=await owner.client`select id from pay_component
   where tenant_id=${group.tenantId}::uuid and code='ATTENDANCE'`;
  assert(component,'Expected the supported Attendance payroll component');
  const allowanceName='Fictional Monthly Attendance Allowance';
  const allowanceCode='PERF-ATT-ALLOW';
  const allowance=await createAllowancePolicy(ctx,{
   companyId:company.companyId,name:allowanceName,code:allowanceCode,method:'monthly',amount:125,
   payComponentId:component.id,effectiveFrom:fixture.today.slice(0,7)+'-01',criteria:{maxAbsentDays:0},
  });
  fixture.attendanceConfigurationRecords={
   calendarId:calendar.id,calendarName,ruleId:rule.id,allowanceId:allowance.id,allowanceName,allowanceCode,
  };
 }

 if(env.PERF_NOTICE_RECORDS==='true'){
  const employee=fixture.users[4];
  assert(employee.role==='employee'&&employee.companyId===company.companyId);
  const {createNotice,publishNotice}=await source('core/notice.ts');
  const title='Fictional Warehouse Safety Notice';
  const body='Confirm that you reviewed the shift handover instructions.';
  const {id}=await createNotice(ctx,{
   companyId:company.companyId,title,body,targetMode:'individual',employmentIds:[employee.employmentId],
   startOn:fixture.today,endOn:fixture.today,requiresAcknowledgement:true,notifyOnPublish:false,popupEnabled:false,
  });
  assert.equal((await publishNotice(ctx,id)).recipients,1);
  fixture.noticeRecord={id,title,body,employmentId:employee.employmentId};
 }

 if(env.PERF_JOB_DESCRIPTION_RECORDS==='true'){
  const {saveJobDraft}=await source('packs/job-descriptions/service.ts');
  const title='Fictional Warehouse Coordinator';
  const code='PERF-WAREHOUSE-COORD';
  const purpose='Verify stock handovers and shift records';
  const record=await saveJobDraft(ctx,{
   companyId:company.companyId,jobCode:code,title,owner:'Fictional warehouse team',
   org:{department:fixture.tenants[company.tenant].companies[company.company].departmentId},
   answers:{purpose:[{purpose}]},effectiveOn:fixture.today,reviewOn:fixture.today,
   reason:'New fictional warehouse role',reviewerIds:[],approverId:company.userId,
  });
  fixture.jobDescriptionRecord={...record,title,code,purpose};
 }

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
 if(env.PERF_LIFECYCLE_RECORDS==='true'||env.PERF_PERFORMANCE_REPORT_RECORDS==='true')try{
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
  const {createCycle,openCycle,previewEligibleCount,getOnehrReview,saveOnehrKpis,
   approveOnehrScorecard,submitOnehrResults,performanceTabAccess}=await source('packs/performance/service.ts');
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
  setStage('performance-team-review');
  const manager=fixture.users[2],employee=fixture.users[6];
  assert(manager.role==='manager'&&employee.role==='employee'&&manager.companyId===company.companyId&&employee.companyId===company.companyId);
  const [review]=await owner.client`select id from performance_review where tenant_id=${group.tenantId}::uuid
   and cycle_id=${cycleId}::uuid and employment_id=${employee.employmentId}::uuid
   and reviewer_employment_id=${manager.employmentId}::uuid`;
  assert(review,'Expected a native review for the manager’s assigned subject');
  const sessionFor=async actor=>{
   const [principal]=await owner.client`select tenant_id,grants from app.principal(${actor.userId}::uuid)`;
   assert(principal?.tenant_id===group.tenantId&&Array.isArray(principal.grants));
   return {tenantId:group.tenantId,userId:actor.userId,personId:actor.personId,grants:principal.grants,
    roles:[...new Set(principal.grants.map(grant=>grant.role))],entitlements:ctx.entitlements};
  };
  const [viewer,reviewer]=await Promise.all([sessionFor(employee),sessionFor(manager)]);
  const revision=async actor=>(await getOnehrReview(actor,review.id)).revision;
  const objective='Fictional review objective',id=randomUUID();
  await saveOnehrKpis(viewer,review.id,await revision(viewer),[{
   id,title:objective,description:'Verified work',weightBp:10000,unit:'items',
   scoring:{mechanism:'A',method:'more',rates:[0,50,100,150,200]},moderatorEmploymentId:manager.employmentId,
  }],true);
  await approveOnehrScorecard(reviewer,review.id,await revision(reviewer),true,'');
  await submitOnehrResults(viewer,review.id,await revision(viewer),[{id,actual:100,note:'Verified work'}],'Completed the agreed work.');
  assert((await performanceTabAccess(reviewer,'pm.team')).mayOpen,'Expected assigned moderation to admit Team PM');
  fixture.performanceRecords={cycleId,name,teamReviewId:review.id,objective};
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
