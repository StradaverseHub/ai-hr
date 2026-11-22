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
 await recruitment.setJobReferralPortal(ctx,job.id,true);
 mark('application');
 const {applicationId,candidateId}=await recruitment.addApplication(ctx,{
  jobId:job.id,fullName:applicant,email:'fictional-recruitment@example.invalid',source:'Referral',sendReceipt:false,
 });
 mark('interview');
 const interviewer=fixture.users[4];
 assert(interviewer.role==='employee'&&interviewer.companyId===companyId);
 const [interviewerPrincipal]=await owner.client`select tenant_id,grants from app.principal(${interviewer.userId}::uuid)`;
 assert(interviewerPrincipal?.tenant_id===tenantId);
 const interviewerContext={...ctx,userId:interviewer.userId,personId:interviewer.personId,grants:interviewerPrincipal.grants,
  roles:[...new Set(interviewerPrincipal.grants.map(grant=>grant.role))]};
 await recruitment.addJobMember(ctx,job.id,'interviewer',interviewer.userId);
 const settings=await recruitment.recruitmentSettings(ctx,companyId);
 const interviewStage=settings.stages.find(stage=>stage.name==='Interview');
 assert(interviewStage,'Missing native Interview stage');
 await recruitment.moveApplication(ctx,applicationId,interviewStage.id);
 const {id:interviewId}=await recruitment.scheduleInterview(ctx,{applicationId,type:'video',
  startsAt:new Date(Date.now()-3*86400000),durationMinutes:60,interviewerIds:[interviewer.userId]});
 const form=await recruitment.scorecardForm(interviewerContext,interviewId);
 const ratings=Object.fromEntries(form.definition.sections.flatMap(section=>section.criteria.map(criterion=>
  [criterion.key,{rating:'4',notes:'Fictional browser scorecard note'}])));
 assert(Object.keys(ratings).length>0);
 const overview='Fictional scorecard browser witness';
 await recruitment.submitScorecard(interviewerContext,interviewId,{ratings,result:'recommended',overview});
 const [card]=await owner.client`select id from recruitment_scorecard
  where tenant_id=${tenantId}::uuid and interview_id=${interviewId}::uuid and interviewer_user_id=${interviewer.userId}::uuid`;
 assert(card?.id,'Missing persisted native scorecard');
 mark('agency');
 const {todayInKualaLumpur,addCalendarMonths}=await source('lib/hr-date.ts');
 const today=todayInKualaLumpur();
 const {id:agencyId}=await recruitment.saveAgency(ctx,{companyId,name:'Fictional browser agency'});
 const contractName='Fictional browser agency agreement';
 const {id:contractId}=await recruitment.saveAgencyContract(ctx,{agencyId,name:contractName,contractType:'headhunter',
  feeRate:'5',startsOn:addCalendarMonths(today,-1),endsOn:addCalendarMonths(today,2),hrContactUserId:group.userId,access:'public'});
 const {id:consultantId}=await recruitment.saveAgencyConsultant(ctx,{contractId,name:'Fictional browser consultant',
  email:'fictional-consultant@example.invalid'});
 await recruitment.assignAgencyContract(ctx,job.id,contractId);
 const submissionName='Fictional agency browser candidate';
 const {submissionId}=await recruitment.recordAgencySubmission(ctx,{jobId:job.id,contractId,consultantId,
  fullName:submissionName,email:'fictional-agency-candidate@example.invalid'});
 assert.equal((await recruitment.agencySubmissionReview(ctx,submissionId)).fullName,submissionName);
 mark('verify');
 const detail=await recruitment.applicationInterviews(ctx,applicationId);
 assert.equal(detail.candidateName,applicant);
 assert.equal(detail.jobTitle,title);
 const [binding]=await owner.client`select tenant_id,company_id,candidate_id,job_id from recruitment_application
  where id=${applicationId}::uuid`;
 assert.deepEqual({...binding},{tenant_id:tenantId,company_id:companyId,candidate_id:candidateId,job_id:job.id});
 fixture.recruitmentRecords={companyId,requisitionId:requisition.id,reqTitle,jobId:job.id,title,applicationId,applicant,
  interviewerIndex:interviewer.index,interviewerName:interviewer.name,interviewId,scorecardId:card.id,overview,
  contractId,contractName,submissionId,submissionName};
 writeFileSync(fixturePath,JSON.stringify(fixture),{mode:0o600});
 mark('complete');
}finally{
 await Promise.all([client.end({timeout:5}),owner.client.end({timeout:5})]);
}
