import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import {sql} from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
import {hireEmployee,setReportingLine} from '../core/org';
import {createAppUser} from './harness';
import {newProbationPart} from '../lib/probation-model';
import {startReview,pendingManagerReviewsFor} from '../core/employment-review';
import {recordDocumentSigningActionTx} from '../packs/document-signing/service';
import {notificationStillTargets} from '../core/notifications';
import {PROBATION_WORKFLOW_EVENTS} from '../lib/probation-workflow';
import {newProbationLetterTemplate} from '../lib/probation-letter-template';
import {probationCase,saveProbationDraft,requestProbationDateShift,applyProbationDateShift,previewProbationWorkflow,uploadProbationEvidence,actOnProbation,saveProbationLetterTemplate,prepareProbationLetter,readProbationLetter,actOnProbationLetter,releaseProbationLetter,probationIntakeWorkspace,saveProbationIntakeDisposition,uploadProbationCutoverEvidence,readProbationCutoverEvidence,prepareProbationCutover,approveProbationCutover,activatePreparedProbationCutover,saveProbationWorkflow,requestProbationLegacyReconciliation,approveProbationLegacyReconciliation,applyProbationLegacyReconciliation,probationIntakeCompanies,probationNavigationAccess,probationInbox} from '../packs/probation/service';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {adminCtx,closeAll,setModule,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {bootstrapProbationPreparer,installProbationDrafts,probationSetup,saveProbationConfiguration,DEFAULT_PROBATION_CONFIG,DEFAULT_PROBATION_FORM,defaultProbationRoutes,canConfigureProbationWorkflows,sweepProbation} from '../packs/probation/service';
let b:Base,admin:SessionContext;
beforeAll(migrateTestDb);afterAll(async()=>{await owner.db.execute(sql`update access_capability set supported=false,bindings='[]'::jsonb where id='workforce.maintain'`);await closeAll();});beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'lifecycle','active');admin=adminCtx(b);await owner.db.execute(sql`update access_capability set supported=false,bindings='[]'::jsonb where id='workforce.maintain'`);});
describe('native probation configuration custody and default-off authority',()=>{
 it('starts hidden and disabled and only bounded bootstrap creates named configuration authority',async()=>{
  expect(await canConfigureProbationWorkflows(admin)).toBe(false);
  await bootstrapProbationPreparer(admin,{companyId:b.companyId,userId:admin.userId!,reason:'Named staging preparer'});
  expect(await canConfigureProbationWorkflows(admin)).toBe(true);
  await expect(bootstrapProbationPreparer(admin,{companyId:b.companyId,userId:admin.userId!,reason:'Second bootstrap'})).rejects.toThrow();
  await installProbationDrafts(admin,b.companyId);await installProbationDrafts(admin,b.companyId);
  const setup=await probationSetup(admin,b.companyId);expect(setup.enabled).toBe(false);expect(setup.settings).toBeNull();expect(setup.drafts.form?.data).toMatchObject({name:DEFAULT_PROBATION_FORM.name});expect(setup.latestVersion).toEqual({settings:1,form:1,route:1});
  await expect(saveProbationConfiguration(admin,{companyId:b.companyId,kind:'settings',data:DEFAULT_PROBATION_CONFIG,publish:false,expectedVersion:0})).rejects.toThrow();
  await saveProbationConfiguration(admin,{companyId:b.companyId,kind:'settings',data:DEFAULT_PROBATION_CONFIG,publish:true,expectedVersion:1});expect((await probationSetup(admin,b.companyId)).settings?.version).toBe(2);
 });
 it('distinguishes an omitted hire period from an explicit zero-period exclusion and gives preparers no PBP adjudication authority',async()=>{
  await bootstrapProbationPreparer(admin,{companyId:b.companyId,userId:admin.userId!,reason:'Named missing-data preparer'});const missing=await person('Fictional missing period');
  const candidate=(await probationIntakeWorkspace(admin,b.companyId)).candidates.find(c=>c.source.employmentId===missing.employmentId)!;expect(candidate.source).toMatchObject({explicitNoProbation:false,unknownPeriod:true});expect(candidate.classification).toBe('held');expect(candidate.canValidate).toBe(false);
  await owner.db.execute(sql`update employment set probation_months=0,probation_value=0 where id=${missing.employmentId}::uuid`);const[source]=await withTenant(admin,tx=>tx.execute<{data:{explicitNoProbation:boolean}}>(sql`select app.probation_personnel_source(${missing.employmentId}::uuid) as data`));expect(source.data.explicitNoProbation).toBe(true);const after=await probationIntakeWorkspace(admin,b.companyId);expect(after.candidates.some(c=>c.source.employmentId===missing.employmentId)).toBe(false);expect(after.excludedCount).toBe(1);
 });
 it('rejects direct table writes, unapproved Grade H and an unrunnable evaluation route',async()=>{
  await bootstrapProbationPreparer(admin,{companyId:b.companyId,userId:admin.userId!,reason:'Named configuration preparer'});
  await expect(withTenant(admin,tx=>tx.execute(sql`insert into probation_activation(tenant_id,company_id,enabled) values(${b.tenantId}::uuid,${b.companyId}::uuid,true)`))).rejects.toThrow();
  await expect(saveProbationConfiguration(admin,{companyId:b.companyId,kind:'settings',data:{...DEFAULT_PROBATION_CONFIG,gradeHEnabled:true,gradeHFormPublished:true},publish:true,expectedVersion:0})).rejects.toThrow();
  const route=defaultProbationRoutes();route.parts['1'].steps.find(s=>s.role==='employee')!.stage=0;
  await expect(saveProbationConfiguration(admin,{companyId:b.companyId,kind:'route',data:route,publish:true,expectedVersion:0})).rejects.toThrow();
  await saveProbationConfiguration(admin,{companyId:b.companyId,kind:'route',data:defaultProbationRoutes(),publish:true,expectedVersion:0});
 });
 it('does not grant app callers owner scheduling or private content/source helper authority',async()=>{
  await expect(sweepProbation({...admin,userId:undefined},{withTenant},new Date())).rejects.toThrow();
  for(const query of [sql`select app.probation_content(${randomUUID()}::uuid)`,sql`select app.probation_notification_content(${b.tenantId}::uuid,${randomUUID()}::uuid,${admin.userId}::uuid)`,sql`select app.probation_activate_cutover(${randomUUID()}::uuid,current_date)`])await expect(withTenant(admin,tx=>tx.execute(query))).rejects.toThrow();
  const functions=await owner.db.execute<{name:string;public:boolean}>(sql`select p.proname as name,exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x where x.grantee=0 and x.privilege_type='EXECUTE') as public from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app' and p.proname like 'probation_%' and p.prosecdef`);expect(functions.length).toBeGreaterThan(20);expect(functions.filter(f=>f.public)).toEqual([]);
 });
});

async function person(name:string){const e=await hireEmployee(admin,{person:{fullName:name,primaryEmail:randomUUID()+'@probation.example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01'});const userId=await createAppUser(b.tenantId,e.personId,'employee');return{...e,userId,ctx:{...admin,userId,personId:e.personId,roles:['employee'],grants:undefined}};}
async function privateCase(){
 await bootstrapProbationPreparer(admin,{companyId:b.companyId,userId:admin.userId!,reason:'Named privacy fixture preparer'});
 const[hrPerson]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name) values(${b.tenantId}::uuid,'Fictional HR Partner') returning id`);await owner.db.execute(sql`update app_user set person_id=${hrPerson.id}::uuid where id=${admin.userId}::uuid`);admin={...admin,personId:hrPerson.id};
 const staff=await person('Fictional Staff'),manager=await person('Fictional Manager'),peer=await person('Fictional Peer');
 await owner.db.execute(sql`insert into lc_v9_config(tenant_id,data) values(${b.tenantId}::uuid,${JSON.stringify({version:9,peopleOpsGroup:'probation-people',bpRules:[{rules:{company:[b.companyId]},userId:admin.userId}]})}::jsonb)`);
 await owner.db.execute(sql`insert into lc_onboarding_config(tenant_id,data) values(${b.tenantId}::uuid,${JSON.stringify({groups:[{id:'probation-people',name:'Canonical People Ops',members:[admin.userId],limit:10}]})}::jsonb)`);
 await owner.db.execute(sql`update employment set probation_value=0,probation_months=0 where id in(${manager.employmentId}::uuid,${peer.employmentId}::uuid)`);
 await owner.db.execute(sql`update employment set probation_unit='month',probation_value=12,probation_months=12,probation_end_date='2026-12-31' where id=${staff.employmentId}::uuid`);
 const ids={caseId:randomUUID(),settings:randomUUID(),form:randomUUID(),route:randomUUID(),part:randomUUID()};
 const part={...newProbationPart(ids.part,3,0,'2026-12-31',30),state:'issued' as const};
 const route=defaultProbationRoutes().parts['3'];
 const blank=Object.fromEntries(DEFAULT_PROBATION_FORM.criteria.map(c=>[c.id,{rating:null,evidence:'Private staff evidence'}]));
 const data={id:ids.caseId,employmentId:staff.employmentId,companyId:b.companyId,sourceKey:'employment:'+staff.employmentId,startOn:'2026-01-01',originalEndOn:'2026-12-31',endOn:'2026-12-31',gradeAtStart:'12',revision:1,config:DEFAULT_PROBATION_CONFIG,planMonths:12,planFlag:true,extensionCount:0,kpiAcknowledged:true,state:'in_review',pendingOutcome:null,facts:{employeeName:'Fictional Staff',holders:{employee:staff.userId,lm:null,hod:null,pbp:null}}};
 await owner.db.execute(sql`insert into probation_configuration(id,tenant_id,company_id,kind,version,state,data,created_by) values(${ids.settings}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,'settings',1,'published',${JSON.stringify(DEFAULT_PROBATION_CONFIG)}::jsonb,${admin.userId}::uuid),(${ids.form}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,'form',1,'published',${JSON.stringify(DEFAULT_PROBATION_FORM)}::jsonb,${admin.userId}::uuid),(${ids.route}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,'route',1,'published',${JSON.stringify(defaultProbationRoutes())}::jsonb,${admin.userId}::uuid)`);
 await owner.db.execute(sql`insert into probation_activation(tenant_id,company_id,enabled,activation_on,dry_run_digest,approved_by) values(${b.tenantId}::uuid,${b.companyId}::uuid,true,'2026-01-01',${'a'.repeat(64)},${admin.userId}::uuid)`);
 await owner.db.execute(sql`insert into probation_case(id,tenant_id,company_id,employment_id,source_key,settings_id,form_id,route_id,data) values(${ids.caseId}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,${staff.employmentId}::uuid,${data.sourceKey},${ids.settings}::uuid,${ids.form}::uuid,${ids.route}::uuid,${JSON.stringify(data)}::jsonb)`);
 const {employee,manager:managerValues,employeeComments,kpis,support,strengths,development,managerComments,outcome,midpointStatus,justification,extensionMonths,...metadata}=part;void employee;void managerValues;void employeeComments;void kpis;void support;void strengths;void development;void managerComments;void outcome;void midpointStatus;void justification;void extensionMonths;
 await owner.db.execute(sql`insert into probation_part(id,tenant_id,case_id,data) values(${ids.part}::uuid,${b.tenantId}::uuid,${ids.caseId}::uuid,${JSON.stringify({...metadata,route})}::jsonb)`);
 await owner.db.execute(sql`insert into probation_rater_draft(part_id,tenant_id,rater,data) values(${ids.part}::uuid,${b.tenantId}::uuid,'employee',${JSON.stringify({employee:blank,employeeComments:'Private staff comment'})}::jsonb),(${ids.part}::uuid,${b.tenantId}::uuid,'lm',${JSON.stringify({manager:blank,managerComments:'Private manager draft'})}::jsonb)`);
 return{ids,staff,manager,peer};
}
describe('physical per-rater confidentiality',()=>{
 it('denies an own-case employee manager-field writes when the canonical manager is missing (NULL is denial)',async()=>{
  const{ids,staff}=await privateCase();const[role]=await withTenant(staff.ctx,tx=>tx.execute<{ok:boolean}>(sql`select app.probation_role(${staff.employmentId}::uuid,'lm') as ok`));expect(role.ok).toBe(false);
  await expect(saveProbationDraft(staff.ctx,{caseId:ids.caseId,partId:ids.part,revision:1,rater:'lm',patch:{managerComments:'Forged manager narrative'}})).rejects.toThrow();
  await expect(withTenant(staff.ctx,tx=>tx.execute(sql`select app.probation_save_draft(${ids.part}::uuid,'employee','{}'::jsonb,null)`))).rejects.toThrow();
  const visible=await probationCase(staff.ctx,ids.caseId);expect(visible.parts[0].selfVisible).toBe(true);expect(visible.parts[0].managerVisible).toBe(false);expect(JSON.stringify(visible)).not.toContain('Private manager draft');
 });
 it('isolates peers and hides staff drafts from the real manager until staff submission, through SQL and service reads',async()=>{
  const{ids,staff,manager,peer}=await privateCase();await setReportingLine(admin,{subordinateEmploymentId:staff.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:'2026-01-01'});
  const before=await probationCase(manager.ctx,ids.caseId);expect(before.parts[0].selfVisible).toBe(false);expect(before.parts[0].managerVisible).toBe(true);expect(JSON.stringify(before)).not.toContain('Private staff comment');
  const rows=await withTenant(manager.ctx,tx=>tx.execute(sql`select data from probation_rater_draft where part_id=${ids.part}::uuid and rater='employee'`));expect(rows).toHaveLength(0);
  await expect(probationCase(peer.ctx,ids.caseId)).rejects.toThrow();
  await owner.db.execute(sql`update probation_part set data=jsonb_set(data,'{staffSubmittedAt}',to_jsonb(now()::text)) where id=${ids.part}::uuid`);
  expect((await probationCase(manager.ctx,ids.caseId)).parts[0].selfVisible).toBe(true);
 });
});

describe('purpose-bound canonical date adjustments',()=>{
 it('allows mapped Lifecycle GBS to apply the approved canonical date only, with an audited movement and idempotent source receipt',async()=>{
  const{ids,staff,peer}=await privateCase();
  await owner.db.execute(sql`update employment set probation_end_date='2026-12-31' where id=${staff.employmentId}::uuid`);
  await owner.db.execute(sql`insert into probation_access(tenant_id,user_id,company_id,role,valid_from,reason) values(${b.tenantId}::uuid,${admin.userId}::uuid,${b.companyId}::uuid,'pbp','2026-01-01','Named PBP fixture'),(${b.tenantId}::uuid,${admin.userId}::uuid,${b.companyId}::uuid,'gbs','2026-01-01','Named GBS fixture')`);
  await owner.db.execute(sql`update lc_onboarding_config set data=jsonb_set(data,'{groups,0,members}',${JSON.stringify([admin.userId,peer.userId])}::jsonb) where tenant_id=${b.tenantId}::uuid`);
  await owner.db.execute(sql`insert into probation_access(tenant_id,user_id,company_id,role,valid_from,reason) values(${b.tenantId}::uuid,${peer.userId}::uuid,${b.companyId}::uuid,'gbs','2026-01-01','Employee-role canonical People Ops')`);
  await owner.db.execute(sql`insert into access_configuration(tenant_id,initialized) values(${b.tenantId}::uuid,true) on conflict(tenant_id) do update set initialized=true`);
  await owner.db.execute(sql`update access_capability set supported=true,bindings='[{"owner":"probation-purpose-fixture","operation":"maintain"}]'::jsonb where id='workforce.maintain'`);
  await owner.db.execute(sql`insert into access_user_override(tenant_id,user_id,capability_id,company_id,effect) values(${b.tenantId}::uuid,${admin.userId}::uuid,'workforce.maintain',${b.companyId}::uuid,'deny')`);
  const[access]=await withTenant(admin,tx=>tx.execute<{ok:boolean}>(sql`select app.access_workforce_company(${b.companyId}::uuid,'workforce.maintain') as ok`));expect(access.ok).toBe(false);
  await expect(withTenant(admin,tx=>tx.execute(sql`update employment set final_confirmation_date='2027-02-01' where id=${staff.employmentId}::uuid`))).rejects.toThrow();
  const requestId=await requestProbationDateShift(admin,{caseId:ids.caseId,revision:1,newEndOn:'2027-01-31',reason:'Approved long leave; preserve submitted reviews'});
  await expect(withTenant(admin,tx=>tx.execute(sql`select app.probation_date_shift_intent(${requestId}::uuid)`))).rejects.toThrow(); // source mint is private to the real owner executor
  expect(await probationIntakeCompanies(peer.ctx)).toContainEqual({id:b.companyId,name:expect.any(String),canPrepare:false});expect((await probationNavigationAccess(peer.ctx)).intake).toBe(true);
  expect(await applyProbationDateShift(peer.ctx,{caseId:ids.caseId,requestId,revision:1})).toMatchObject({queued:true,alreadyApplied:false});
  const[notApplied]=await owner.db.execute<{end:string|null}>(sql`select extended_confirmation_date::text as end from employment where id=${staff.employmentId}::uuid`);expect(notApplied.end).toBeNull();
  expect((await probationCase(peer.ctx,ids.caseId)).dateAdjustments[0].status).toBe('queued');
  await sweepProbation({...admin,userId:undefined,roles:[],grants:undefined},owner);
  const[e]=await owner.db.execute<{end:string}>(sql`select extended_confirmation_date::text as end from employment where id=${staff.employmentId}::uuid`);expect(e.end).toBe('2027-01-31');
  const events=await owner.db.execute(sql`select id from domain_event where tenant_id=${b.tenantId}::uuid and aggregate_id=${staff.employmentId}::uuid and event_type='employment.info.updated' and payload->'movement'->>'remarks'=${'probation-date-shift:'+requestId}`);expect(events).toHaveLength(1);
  expect(await applyProbationDateShift(peer.ctx,{caseId:ids.caseId,requestId,revision:1})).toMatchObject({alreadyApplied:true,queued:false});
  const[provenance]=await owner.db.execute<{reviewer:string}>(sql`select gbs_approved_by as reviewer from probation_date_adjustment where id=${requestId}::uuid`);expect(provenance.reviewer).toBe(peer.userId);
  await expect(withTenant(admin,tx=>tx.execute(sql`update employment set extended_confirmation_date='2027-03-01' where id=${staff.employmentId}::uuid`))).rejects.toThrow();
 });
});

describe('actual scoped workflow rehearsal',()=>{
 it('matches real scoped parts and renders actual recipient names and published merge fields without reading drafts',async()=>{
  const{ids}=await privateCase();await owner.db.execute(sql`update probation_part set data=jsonb_set(data,'{dueOn}',to_jsonb((now() at time zone 'Asia/Kuala_Lumpur')::date::text)) where id=${ids.part}::uuid`);
  const workflow={id:'due',name:'Due review',module:'probation' as const,status:'draft' as const,description:'Pending owner only',trigger:{event:'review_due' as const},conditions:{departmentId:b.deptA,grade:'12',part:3 as const},steps:[{id:'notify',type:'notify' as const,subject:'Review for {{ employeeName }}',body:'Part {{part}} is due {{dueOn}}.',to:['employee' as const]}]};
  const preview=await previewProbationWorkflow(admin,{companyId:b.companyId,workflow});expect(preview.sends).toBe(false);expect(preview.examples).toHaveLength(1);expect(preview.examples[0].parts[0]).toMatchObject({ready:true,messages:[{subject:'Review for Fictional Staff',recipients:[{role:'employee',name:'Fictional Staff'}]}]});expect(JSON.stringify(preview)).not.toContain('Private manager draft');expect(JSON.stringify(preview)).not.toContain('Private staff comment');
  expect((await previewProbationWorkflow(admin,{companyId:b.companyId,workflow:{...workflow,conditions:{...workflow.conditions,departmentId:b.deptB}}})).examples).toEqual([]);
 });
});

describe('pending-party rehearsal and waived self-assessment custody',()=>{
 it('waits for staff before notifying LM, allows configured parallel work, and excludes finished staff without exposing a waived draft',async()=>{
  const{ids,staff,manager}=await privateCase();await setReportingLine(admin,{subordinateEmploymentId:staff.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:'2026-01-01'});
  await owner.db.execute(sql`update probation_part set data=jsonb_set(data,'{dueOn}',to_jsonb((now() at time zone 'Asia/Kuala_Lumpur')::date::text)) where id=${ids.part}::uuid`);
  const workflow={id:'parties',name:'Pending review owners',module:'probation' as const,status:'draft' as const,description:'Only unfinished work',trigger:{event:'review_due' as const},conditions:{part:3 as const},steps:[{id:'notify',type:'notify' as const,subject:'Review {{employeeName}}',body:'Pending review',to:['employee' as const,'lm' as const,'hod' as const,'pbp' as const]}]};
  const parties=async()=>(await previewProbationWorkflow(admin,{companyId:b.companyId,workflow})).examples[0].parts[0].messages[0].recipients;
  expect((await parties()).map(p=>p.role)).toEqual(['employee']);
  await owner.db.execute(sql`update probation_case set data=jsonb_set(data,'{config,lmWaitsForEmployee}','false') where id=${ids.caseId}::uuid`);
  expect((await parties()).map(p=>p.role).sort()).toEqual(['employee','lm']);expect((await probationCase(manager.ctx,ids.caseId)).parts[0].canEditManager).toBe(true);
  await owner.db.execute(sql`update probation_part set data=jsonb_set(data,'{staffSubmittedAt}',to_jsonb(now()::text)) where id=${ids.part}::uuid`);
  expect((await parties()).map(p=>p.role)).toEqual(['lm']);
  await owner.db.execute(sql`update probation_part set data=data||jsonb_build_object('staffSubmittedAt',null,'managerSubmittedAt',now(),'state','pending_ack') where id=${ids.part}::uuid`);
  const view=await probationCase(staff.ctx,ids.caseId);expect(view.parts[0].canEditSelfAssessment).toBe(false);expect(view.parts[0].canEditEmployeeComments).toBe(false); // no source-bound signing envelope was manufactured by this fixture
  await expect(withTenant(staff.ctx,tx=>tx.execute(sql`select app.probation_save_draft(${ids.part}::uuid,'employee','{"employee":{}}'::jsonb,1)`))).rejects.toThrow();
  const[content]=await owner.withTenant({...admin,userId:undefined},tx=>tx.execute<{data:{employeeAssessment:unknown}}>(sql`select app.probation_content(${ids.part}::uuid) as data`));expect(content.data.employeeAssessment).toBeNull();
 });
 it('keeps signed review bytes and render custody inaccessible to an ordinary app principal',async()=>{
  await privateCase();for(const query of[sql`select app.probation_owner_render_context(${randomUUID()}::uuid)`,sql`select app.probation_owner_seal_render(${randomUUID()}::uuid,${'a'.repeat(64)},${Buffer.from('%PDF-forged')})`,sql`select app.probation_hold_render(${randomUUID()}::uuid,'forged')`])await expect(withTenant(admin,tx=>tx.execute(query))).rejects.toThrow();
 });
});

describe('durable Personal File source receipts',()=>{
 it('queues an authorized offline PDF without broad Personnel permission and lets only the real owner file it once',async()=>{
  const{ids,staff}=await privateCase();await owner.db.execute(sql`insert into probation_access(tenant_id,user_id,company_id,role,valid_from,reason) values(${b.tenantId}::uuid,${admin.userId}::uuid,${b.companyId}::uuid,'gbs','2026-01-01','Named canonical People Ops')`);
  await owner.db.execute(sql`insert into access_configuration(tenant_id,initialized) values(${b.tenantId}::uuid,true) on conflict(tenant_id) do update set initialized=true`);await owner.db.execute(sql`update access_capability set supported=true,bindings='[{"owner":"probation-purpose-fixture","operation":"maintain"}]'::jsonb where id='workforce.maintain'`);await owner.db.execute(sql`insert into access_user_override(tenant_id,user_id,capability_id,company_id,effect) values(${b.tenantId}::uuid,${admin.userId}::uuid,'workforce.maintain',${b.companyId}::uuid,'deny')`);
  const{PDFDocument}=await import('pdf-lib'),document=await PDFDocument.create();document.addPage();const bytes=Buffer.from(await document.save());
  const fileId=await uploadProbationEvidence(admin,{caseId:ids.caseId,partId:ids.part,revision:1,name:'completed-offline.pdf',content:bytes,reason:'Verified completed paper review before digital intake'});
  const[before]=await owner.db.execute<{id:string|null}>(sql`select employee_document_id as id from probation_file where id=${fileId}::uuid`);expect(before.id).toBeNull();
  await expect(withTenant(admin,tx=>tx.execute(sql`select app.probation_file_owner(${fileId}::uuid)`))).rejects.toThrow();
  const maintenance={...admin,userId:undefined};const[first]=await owner.withTenant(maintenance,tx=>tx.execute<{id:string}>(sql`select app.probation_file_owner(${fileId}::uuid) as id`));const[second]=await owner.withTenant(maintenance,tx=>tx.execute<{id:string}>(sql`select app.probation_file_owner(${fileId}::uuid) as id`));expect(second.id).toBe(first.id);
  const[stored]=await owner.db.execute<{content:Buffer;subject:string;actor:string|null}>(sql`select content,employment_id as subject,uploaded_by_user_id as actor from employee_document where id=${first.id}::uuid`);expect(stored.content.equals(bytes)).toBe(true);expect(stored.subject).toBe(staff.employmentId);expect(stored.actor).toBeNull();
 });
});


describe('real evaluation to signed letter custody',()=>{
 it('keeps pre-stage letters private, freezes actual signatures, holds changed Personnel and files only owner-rendered signed bytes',async()=>{
  const{ids,staff,manager,peer}=await privateCase();
  await owner.db.execute(sql`update probation_configuration set data=jsonb_set(data,'{employeeCommentsRequired}','true') where id=${ids.form}::uuid`);await owner.db.execute(sql`update probation_rater_draft set data=jsonb_set(data,'{employeeComments}','""'::jsonb) where part_id=${ids.part}::uuid and rater='employee'`);
  await setReportingLine(admin,{subordinateEmploymentId:staff.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:'2026-01-01'});
  await owner.db.execute(sql`update department set head_employment_id=${peer.employmentId}::uuid where id=${b.deptA}::uuid`);
  await owner.db.execute(sql`update employment set probation_end_date='2026-12-31' where id=${staff.employmentId}::uuid`);
  await owner.db.execute(sql`insert into probation_access(tenant_id,user_id,company_id,role,valid_from,reason) values(${b.tenantId}::uuid,${admin.userId}::uuid,${b.companyId}::uuid,'pbp','2026-01-01','Actual canonical PBP opt-in'),(${b.tenantId}::uuid,${admin.userId}::uuid,${b.companyId}::uuid,'gbs','2026-01-01','Actual canonical GBS opt-in')`);
  const current=async(ctx:SessionContext)=>(await probationCase(ctx,ids.caseId)).parts[0];
  const assessment=Object.fromEntries(DEFAULT_PROBATION_FORM.criteria.map(c=>[c.id,{rating:3,evidence:'Observed fictional evidence for this criterion'}]));
  let part=await current(staff.ctx);await saveProbationDraft(staff.ctx,{caseId:ids.caseId,partId:ids.part,revision:part.revision,rater:'employee',patch:{employee:assessment}});part=await current(staff.ctx);await actOnProbation(staff.ctx,{caseId:ids.caseId,partId:ids.part,revision:part.revision,command:'submit_employee'});
  part=await current(manager.ctx);await saveProbationDraft(manager.ctx,{caseId:ids.caseId,partId:ids.part,revision:part.revision,rater:'lm',patch:{manager:assessment,reviewOn:'2026-11-03',conductedBy:manager.userId,outcome:'confirm',justification:'Observed evidence supports confirmation'}});part=await current(manager.ctx);
  await actOnProbation(manager.ctx,{caseId:ids.caseId,partId:ids.part,revision:part.revision,command:'submit_manager',method:'typed',value:'Fictional Manager',consent:true});
  part=await current(staff.ctx);expect(part.canEditEmployeeComments).toBe(true);expect(part.canEditSelfAssessment).toBe(false);await expect(actOnProbation(staff.ctx,{caseId:ids.caseId,partId:ids.part,revision:part.revision,command:'acknowledge',method:'typed',value:'Fictional Staff',consent:true})).rejects.toThrow();await saveProbationDraft(staff.ctx,{caseId:ids.caseId,partId:ids.part,revision:part.revision,rater:'employee',patch:{employeeComments:'I acknowledge the submitted review.'}});part=await current(staff.ctx);const evaluation=part.signing!,evaluationAck=evaluation.document.route.steps.find(step=>step.role==='employee')!;await expect(withTenant(staff.ctx,tx=>recordDocumentSigningActionTx(tx,staff.ctx,{id:evaluation.id,stepId:evaluationAck.id,revision:evaluation.document.contentRevision,hash:evaluation.document.contentHash,action:'signed',comment:'A different unsaved acknowledgement',method:'typed',value:'Fictional Staff',consent:true}))).rejects.toThrow();await actOnProbation(staff.ctx,{caseId:ids.caseId,partId:ids.part,revision:part.revision,command:'acknowledge',method:'typed',value:'Fictional Staff',consent:true});
  for(const actor of[peer.ctx,admin]){part=await current(actor);await actOnProbation(actor,{caseId:ids.caseId,partId:ids.part,revision:part.revision,command:'approve',method:'typed',value:actor.userId===admin.userId?'Actual PBP':'Fictional Peer',consent:true});}
  part=await current(admin);await actOnProbation(admin,{caseId:ids.caseId,partId:ids.part,revision:part.revision,command:'record'});
  const[decision]=await owner.db.execute<{id:string;revision:number}>(sql`select id,revision from probation_outcome where part_id=${ids.part}::uuid`);
  const template=newProbationLetterTemplate('confirm',randomUUID(),'Approved fictional confirmation');template.unfinished=false;template.blocks=template.blocks.filter(b=>b.type!=='letterhead');template.blocks.find(b=>b.type==='text')!.text='Confirmation for {employeeName}. Acknowledged by {acknowledgedBy}.';
  const templateId=await saveProbationLetterTemplate(admin,{companyId:b.companyId,template,publish:true,expectedVersion:0});
  let prepared=await prepareProbationLetter(admin,{outcomeId:decision.id,templateId,revision:decision.revision,edits:{}});
  await expect(readProbationLetter(staff.ctx,ids.caseId,prepared.partId)).rejects.toThrow();
  let letter=await readProbationLetter(admin,ids.caseId,prepared.partId);const hr=letter.signing!.document.route.steps.find(s=>s.role==='pbp')!;
  await actOnProbationLetter(admin,{caseId:ids.caseId,partId:letter.id,revision:letter.storageRevision,stepId:hr.id,action:'signed',method:'typed',value:'Actual PBP',consent:true});
  letter=await readProbationLetter(staff.ctx,ids.caseId,prepared.partId);let ack=letter.signing!.document.route.steps.find(s=>s.role==='employee')!;
  const returned=letter.signing!;await withTenant(staff.ctx,tx=>recordDocumentSigningActionTx(tx,staff.ctx,{id:returned.id,stepId:ack.id,revision:returned.document.contentRevision,hash:returned.document.contentHash,action:'returned',comment:'Please prepare a corrected generation'}));
  await expect(withTenant(staff.ctx,tx=>recordDocumentSigningActionTx(tx,staff.ctx,{id:returned.id,stepId:ack.id,revision:returned.document.contentRevision,hash:returned.document.contentHash,action:'signed',comment:'',method:'typed',value:'Fictional Staff',consent:true}))).rejects.toThrow();
  prepared=await prepareProbationLetter(admin,{outcomeId:decision.id,templateId,revision:prepared.outcomeRevision,edits:{}});letter=await readProbationLetter(admin,ids.caseId,prepared.partId);await actOnProbationLetter(admin,{caseId:ids.caseId,partId:letter.id,revision:letter.storageRevision,stepId:hr.id,action:'signed',method:'typed',value:'Actual PBP',consent:true});letter=await readProbationLetter(staff.ctx,ids.caseId,prepared.partId);ack=letter.signing!.document.route.steps.find(s=>s.role==='employee')!;await actOnProbationLetter(staff.ctx,{caseId:ids.caseId,partId:letter.id,revision:letter.storageRevision,stepId:ack.id,action:'signed',method:'typed',value:'Fictional Staff',consent:true});
  await owner.db.execute(sql`update person set full_name='Changed canonical name' where id=${staff.personId}::uuid`);
  await expect(releaseProbationLetter(admin,{caseId:ids.caseId,partId:prepared.partId,outcomeRevision:prepared.outcomeRevision,reason:'Release the approved signed letter'})).rejects.toThrow();
  await owner.db.execute(sql`update person set full_name='Fictional Staff' where id=${staff.personId}::uuid`);
  const request=await releaseProbationLetter(admin,{caseId:ids.caseId,partId:prepared.partId,outcomeRevision:prepared.outcomeRevision,reason:'Release the approved signed letter'});expect(request).toMatch(/^[a-f0-9-]{36}$/);
  const[pending]=await owner.db.execute<{released:string|null;state:string}>(sql`select released_at::text as released,state from probation_outcome where id=${decision.id}::uuid`);expect(pending).toEqual({released:null,state:'release_requested'});expect((await readProbationLetter(admin,ids.caseId,prepared.partId)).canRelease).toBe(false);
  await expect(withTenant(admin,tx=>tx.execute(sql`select app.probation_file_save(${ids.caseId}::uuid,${ids.part}::uuid,'completed_part','forged.pdf',${Buffer.from('%PDF-forged')},1,'Forged completed source')`))).rejects.toThrow();
  await sweepProbation({...admin,userId:undefined,roles:[],grants:undefined},owner);
  const[file]=await owner.db.execute<{content:Buffer;documentId:string;released:string}>(sql`select f.content,f.employee_document_id as "documentId",o.released_at::text as released from probation_outcome o join probation_file f on f.id=o.letter_file_id where o.id=${decision.id}::uuid`);expect(file.documentId).toBeTruthy();expect(file.released).toBeTruthy();const{PDFDocument}=await import('pdf-lib');expect((await PDFDocument.load(file.content)).getPageCount()).toBeGreaterThan(0);
  const[review]=await owner.db.execute<{count:number}>(sql`select count(*)::integer as count from probation_file where part_id=${ids.part}::uuid and kind='completed_part' and employee_document_id is not null`);expect(review.count).toBe(1);
 });
});

describe('Part 1 actual acknowledgement contribution',()=>{
 it('exposes the employee comment to LM only after actual acknowledgement and automatically files its signed PDF',async()=>{
  const{ids,staff,manager}=await privateCase();await setReportingLine(admin,{subordinateEmploymentId:staff.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:'2026-01-01'});
  await owner.db.execute(sql`update employment set probation_end_date='2026-12-31' where id=${staff.employmentId}::uuid`);
  const route=defaultProbationRoutes().parts['1'];await owner.db.execute(sql`update probation_part set data=data||jsonb_build_object('type',1,'route',${JSON.stringify(route)}::jsonb) where id=${ids.part}::uuid`);
  const current=async(ctx:SessionContext)=>(await probationCase(ctx,ids.caseId)).parts[0];let part=await current(manager.ctx);
  await saveProbationDraft(manager.ctx,{caseId:ids.caseId,partId:ids.part,revision:part.revision,rater:'lm',patch:{kpis:[{id:'kpi',accountability:'Deliver agreed work',measure:'Observed output',target:'Complete the agreed work',targetDate:'2026-12-01'}],support:{coaching:'Weekly coaching',access:'Required tools',checkins:'Weekly check-in',other:'Ask LM for help'}}});part=await current(manager.ctx);
  await actOnProbation(manager.ctx,{caseId:ids.caseId,partId:ids.part,revision:part.revision,command:'submit_manager',method:'typed',value:'Fictional Manager',consent:true});part=await current(staff.ctx);expect(part.canEditEmployeeComments).toBe(true);
  await saveProbationDraft(staff.ctx,{caseId:ids.caseId,partId:ids.part,revision:part.revision,rater:'employee',patch:{employeeComments:'My actual Part 1 acknowledgement comment'}});
  expect(JSON.stringify(await current(manager.ctx))).not.toContain('My actual Part 1 acknowledgement comment');part=await current(staff.ctx);await actOnProbation(staff.ctx,{caseId:ids.caseId,partId:ids.part,revision:part.revision,command:'acknowledge',method:'typed',value:'Fictional Staff',consent:true});
  part=await current(manager.ctx);expect(part.employeeComments).toBe('My actual Part 1 acknowledgement comment');expect(part.canEditManager).toBe(false);
  await sweepProbation({...admin,userId:undefined,roles:[],grants:undefined},owner);const[file]=await owner.db.execute<{documentId:string}>(sql`select employee_document_id as "documentId" from probation_file where part_id=${ids.part}::uuid and kind='completed_part'`);expect(file.documentId).toBeTruthy();
 });
});


describe('reviewed existing-cohort activation and legacy ownership handoff',()=>{
 it('stages offline evidence without runtime effects, exports future/past exclusions, serializes legacy writers and resumes legacy only after a new reviewed receipt',async()=>{
  const savedOrigin=process.env.AUTH_PUBLIC_ORIGIN,savedKey=process.env.AUTH_SESSION_KEY;process.env.AUTH_PUBLIC_ORIGIN='https://probation-staging.example.test';process.env.AUTH_SESSION_KEY='a'.repeat(64);
  try{
   const{ids,staff,manager,peer}=await privateCase();await owner.db.execute(sql`delete from probation_rater_draft where part_id=${ids.part}::uuid`);await owner.db.execute(sql`delete from probation_part where id=${ids.part}::uuid`);await owner.db.execute(sql`delete from probation_case where id=${ids.caseId}::uuid`);await owner.db.execute(sql`update probation_activation set enabled=false where tenant_id=${b.tenantId}::uuid`);
   await setReportingLine(admin,{subordinateEmploymentId:staff.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:'2026-01-01'});await owner.db.execute(sql`update department set head_employment_id=${peer.employmentId}::uuid where id=${b.deptA}::uuid`);
   const grade=randomUUID();await owner.db.execute(sql`insert into job_grade(id,tenant_id,code,name) values(${grade}::uuid,${b.tenantId}::uuid,'12','Fictional Grade 12')`);await owner.db.execute(sql`update employment set grade_id=${grade}::uuid,probation_months=3,probation_unit='month',probation_value=3,probation_end_date='2026-03-31' where id=${staff.employmentId}::uuid`);
   await owner.db.execute(sql`insert into probation_access(tenant_id,user_id,company_id,role,valid_from,reason) values(${b.tenantId}::uuid,${admin.userId}::uuid,${b.companyId}::uuid,'pbp','2026-01-01','Actual intake PBP'),(${b.tenantId}::uuid,${admin.userId}::uuid,${b.companyId}::uuid,'gbs','2026-01-01','Actual intake People Ops')`);
   const legacy=await startReview(admin,{employmentId:staff.employmentId});const[event]=await owner.db.execute<{id:string}>(sql`select id from domain_event where aggregate_id=${legacy.reviewId}::uuid and event_type='employment-review.started'`);expect(await withTenant(admin,tx=>notificationStillTargets(tx,event.id,'review.started','review',manager.employmentId))).toBe(true);
   const{PDFDocument}=await import('pdf-lib'),pdf=await PDFDocument.create();pdf.addPage();const evidenceId=await uploadProbationCutoverEvidence(admin,{employmentId:staff.employmentId,name:'original-offline-p1.pdf',content:Buffer.from(await pdf.save()),reason:'Original completed paper Part 1, reviewed by actual PBP'});
   expect((await readProbationCutoverEvidence(admin,{employmentId:staff.employmentId,evidenceId})).name).toBe('original-offline-p1.pdf');await expect(readProbationCutoverEvidence(staff.ctx,{employmentId:staff.employmentId,evidenceId})).rejects.toThrow();
   let candidate=(await probationIntakeWorkspace(admin,b.companyId)).candidates.find(c=>c.source.employmentId===staff.employmentId)!;expect(candidate.classification).toBe('held');
   await saveProbationIntakeDisposition(admin,{employmentId:staff.employmentId,revision:0,sourceDigest:candidate.sourceDigest,kind:'unfinished',reason:'Verified existing employee stage and original PDF',validatedUnknown:false,exclusionFlags:{noProbation:false,internalTransfer:false,rehire:false,confirmedOnHire:false},parts:[{type:1,cycle:0,status:'completed_offline',evidenceId},{type:3,cycle:0,status:'unfinished',evidenceId:null}]});candidate=(await probationIntakeWorkspace(admin,b.companyId)).candidates.find(c=>c.source.employmentId===staff.employmentId)!;expect(candidate.classification).toBe('ready');
   const[before]=await owner.db.execute<{cases:number;files:number}>(sql`select (select count(*)::integer from probation_case where employment_id=${staff.employmentId}::uuid) as cases,(select count(*)::integer from employee_document where employment_id=${staff.employmentId}::uuid) as files`);expect(before).toEqual({cases:0,files:0});
   for(const event of PROBATION_WORKFLOW_EVENTS)await saveProbationWorkflow(admin,{companyId:b.companyId,publish:true,expectedVersion:0,workflow:{id:randomUUID(),name:'Approved '+event,module:'probation',status:'published',description:'Fictional approved test message',trigger:{event},conditions:{},steps:[{id:'notify',type:'notify',subject:'Probation work for {{companyName}}',body:'Review your pending probation work as of {{dueOn}}.',to:['employee','lm','hod','pbp','gbs']}]}});
   for(const outcome of['confirm','extend','not_confirm']as const){const template=newProbationLetterTemplate(outcome,randomUUID(),'Approved '+outcome);template.unfinished=false;template.blocks=template.blocks.filter(b=>b.type!=='letterhead');template.blocks.find(b=>b.type==='text')!.text='Approved fictional outcome for {employeeName}.';await saveProbationLetterTemplate(admin,{companyId:b.companyId,template,publish:true,expectedVersion:0});}
   const plan=await prepareProbationCutover(admin,b.companyId);expect(plan.snapshot.planComplete).toBe(true);expect(plan.snapshot.excludedPast.length).toBeGreaterThan(0);expect(plan.snapshot.wouldFire).toMatchObject([{event:'overdue_summary',recipients:[{role:'pbp'}]}]);expect(plan.snapshot.wouldFire.every(o=>o.dueOn>=plan.snapshot.activationOn)).toBe(true);await approveProbationCutover(admin,{id:plan.id,digest:plan.digest,reason:'Reviewed the complete no-catch-up would-fire export'});
   let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve}),hasLock=new Promise<void>(resolve=>{entered=resolve});
   const guardedOwner={withTenant:async<T>(ctx:SessionContext,run:(tx:Tx)=>Promise<T>)=>owner.withTenant(ctx,async tx=>{await tx.execute(sql`select app.access_workforce_write_lock()`);entered();await gate;return run(tx);})};
   const activation=activatePreparedProbationCutover({...admin,userId:undefined,roles:[],grants:undefined},guardedOwner,{id:plan.id,digest:plan.digest,installationReceipt:{origin:'https://probation-staging.example.test',reference:'Fictional staging dispatch-held and owner sign-off receipt'}});await hasLock;
   const competing=startReview(admin,{employmentId:staff.employmentId}).then(()=>'',error=>String(error));let waiting=false;for(let i=0;i<100&&!waiting;i++){const[row]=await owner.db.execute<{waiting:boolean}>(sql`select exists(select 1 from pg_locks where locktype='advisory' and not granted and database=(select oid from pg_database where datname=current_database())) as waiting`);waiting=row.waiting;if(!waiting)await new Promise(resolve=>setTimeout(resolve,10));}release();expect(waiting).toBe(true);expect((await activation).alreadyApplied).toBe(false);expect(await competing).toContain('Probation module');
   expect(await withTenant(admin,tx=>notificationStillTargets(tx,event.id,'review.started','review',manager.employmentId))).toBe(false);expect(await pendingManagerReviewsFor(manager.ctx,manager.employmentId)).toEqual([]);
   const[imported]=await owner.db.execute<{id:string;files:number}>(sql`select c.id,(select count(*)::integer from probation_file f where f.case_id=c.id and f.kind='offline' and f.employee_document_id is not null) as files from probation_case c where c.employment_id=${staff.employmentId}::uuid`);expect(imported.files).toBe(1);const[summaries]=await owner.db.execute<{count:number}>(sql`select count(*)::integer as count from probation_activation_summary where batch_id=${plan.id}::uuid`);expect(summaries.count).toBe(1);
   await owner.db.execute(sql`update probation_activation set enabled=false where tenant_id=${b.tenantId}::uuid`);expect(await withTenant(admin,tx=>notificationStillTargets(tx,event.id,'review.started','review',manager.employmentId))).toBe(false);
   const history=await probationCase(staff.ctx,imported.id);expect(history.runtimeEnabled).toBe(false);expect(history.parts.every(part=>part.allowedCommands.length===0&&!part.canEditEmployee&&!part.canEditManager)).toBe(true);expect((await probationNavigationAccess(staff.ctx)).page).toBe(true);expect((await probationInbox(staff.ctx)).count).toBe(0);await expect(withTenant(staff.ctx,tx=>tx.execute(sql`select app.probation_save_draft(${history.parts.find(p=>p.type===3)!.id}::uuid,'employee','{}'::jsonb,1)`))).rejects.toThrow();
   const current=await probationCase(admin,imported.id),reconciliation=await requestProbationLegacyReconciliation(admin,{caseId:imported.id,revision:current.record.revision,reason:'Reviewed unaffected paused cohort; preserve all new history'});await approveProbationLegacyReconciliation(admin,{id:reconciliation,reason:'GBS reviewed every uncommitted source and pending artifact'});await applyProbationLegacyReconciliation({...admin,userId:undefined,roles:[],grants:undefined},owner,reconciliation);expect(await withTenant(admin,tx=>notificationStillTargets(tx,event.id,'review.started','review',manager.employmentId))).toBe(true);
  }finally{if(savedOrigin===undefined)delete process.env.AUTH_PUBLIC_ORIGIN;else process.env.AUTH_PUBLIC_ORIGIN=savedOrigin;if(savedKey===undefined)delete process.env.AUTH_SESSION_KEY;else process.env.AUTH_SESSION_KEY=savedKey;}
 });
});
