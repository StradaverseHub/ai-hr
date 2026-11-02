import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import {sql} from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
import {hireEmployee,setReportingLine} from '../core/org';
import {createAppUser} from './harness';
import {newProbationPart} from '../lib/probation-model';
import {probationCase,saveProbationDraft,requestProbationDateShift,applyProbationDateShift,previewProbationWorkflow,uploadProbationEvidence} from '../packs/probation/service';
import {withTenant,type SessionContext} from '../db/client';
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

async function person(name:string){const e=await hireEmployee(admin,{person:{fullName:name,primaryEmail:randomUUID()+'@probation.example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01'});const userId=await createAppUser(b.tenantId,e.personId,'employee');return{...e,userId,ctx:{...admin,userId,roles:['employee'],grants:undefined}};}
async function privateCase(){
 await bootstrapProbationPreparer(admin,{companyId:b.companyId,userId:admin.userId!,reason:'Named privacy fixture preparer'});
 const staff=await person('Fictional Staff'),manager=await person('Fictional Manager'),peer=await person('Fictional Peer');
 await owner.db.execute(sql`insert into lc_v9_config(tenant_id,data) values(${b.tenantId}::uuid,${JSON.stringify({version:9,peopleOpsGroup:'probation-people',bpRules:[{rules:{company:[b.companyId]},userId:admin.userId}]})}::jsonb)`);
 await owner.db.execute(sql`insert into lc_onboarding_config(tenant_id,data) values(${b.tenantId}::uuid,${JSON.stringify({groups:[{id:'probation-people',name:'Canonical People Ops',members:[admin.userId],limit:10}]})}::jsonb)`);
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
  const{ids,staff}=await privateCase();
  await owner.db.execute(sql`update employment set probation_end_date='2026-12-31' where id=${staff.employmentId}::uuid`);
  await owner.db.execute(sql`insert into probation_access(tenant_id,user_id,company_id,role,valid_from,reason) values(${b.tenantId}::uuid,${admin.userId}::uuid,${b.companyId}::uuid,'pbp','2026-01-01','Named PBP fixture'),(${b.tenantId}::uuid,${admin.userId}::uuid,${b.companyId}::uuid,'gbs','2026-01-01','Named GBS fixture')`);
  await owner.db.execute(sql`insert into access_configuration(tenant_id,initialized) values(${b.tenantId}::uuid,true) on conflict(tenant_id) do update set initialized=true`);
  await owner.db.execute(sql`update access_capability set supported=true,bindings='[{"owner":"probation-purpose-fixture","operation":"maintain"}]'::jsonb where id='workforce.maintain'`);
  await owner.db.execute(sql`insert into access_user_override(tenant_id,user_id,capability_id,company_id,effect) values(${b.tenantId}::uuid,${admin.userId}::uuid,'workforce.maintain',${b.companyId}::uuid,'deny')`);
  const[access]=await withTenant(admin,tx=>tx.execute<{ok:boolean}>(sql`select app.access_workforce_company(${b.companyId}::uuid,'workforce.maintain') as ok`));expect(access.ok).toBe(false);
  await expect(withTenant(admin,tx=>tx.execute(sql`update employment set final_confirmation_date='2027-02-01' where id=${staff.employmentId}::uuid`))).rejects.toThrow();
  const requestId=await requestProbationDateShift(admin,{caseId:ids.caseId,revision:1,newEndOn:'2027-01-31',reason:'Approved long leave; preserve submitted reviews'});
  await expect(withTenant(admin,tx=>tx.execute(sql`select app.probation_date_shift_intent(${requestId}::uuid)`))).rejects.toThrow(); // minted intent cannot commit without canonical movement and source receipt
  await applyProbationDateShift(admin,{caseId:ids.caseId,requestId,revision:1});
  const[e]=await owner.db.execute<{end:string}>(sql`select extended_confirmation_date::text as end from employment where id=${staff.employmentId}::uuid`);expect(e.end).toBe('2027-01-31');
  const events=await owner.db.execute(sql`select id from domain_event where tenant_id=${b.tenantId}::uuid and aggregate_id=${staff.employmentId}::uuid and event_type='employment.info.updated' and payload->'movement'->>'remarks'=${'probation-date-shift:'+requestId}`);expect(events).toHaveLength(1);
  expect(await applyProbationDateShift(admin,{caseId:ids.caseId,requestId,revision:1})).toEqual({alreadyApplied:true});
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
  await owner.db.execute(sql`update probation_part set data=data||jsonb_build_object('staffSubmittedAt',null,'managerSubmittedAt',now(),'state','manager_submitted') where id=${ids.part}::uuid`);
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
