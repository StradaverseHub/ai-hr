import {beforeAll,beforeEach,afterAll,afterEach,vi,describe,it,expect} from 'vitest';
import {setCompensation} from '../core/comp';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {withTenant} from '../db/client';
import {owner,migrateTestDb,resetDb,closeAll} from './harness';
import {resignationJourneyFixture} from './helpers/resignation-journey-fixture';
import {commandResignationJourney,resignationCase,resignationInbox,resignationEmployeeView,submitResignationJourney,installResignationDefaults,resignationWorkflowDryRun} from '../packs/lifecycle/service';
import {myResignation,listResignationRequests,decideResignation,submitResignation} from '../core/offboarding';

beforeAll(migrateTestDb);beforeEach(resetDb);afterEach(()=>vi.unstubAllEnvs());afterAll(closeAll);

describe('managed resignation service composes one workflow authority',()=>{
 it('uses the same scoped canonical BP resolution for No BP skip in execution and dry run',async()=>{
  const f=await resignationJourneyFixture({decisionWorkflow:false}),workflowId=await f.workflow('submitted',[{id:'decision',type:'requestDecision',conditions:[],to:[{kind:'person',userId:f.managerUserId}],cc:[],params:{choices:'both'}}]);
  await owner.db.execute(sql`update automation_workflow_version set definition=jsonb_set(definition,'{skipWhen}','"noPbp"'::jsonb) where tenant_id=${f.base.tenantId}::uuid and workflow_id=${workflowId}::uuid`);
  const [row]=await owner.db.execute<{definition:import('../lib/automation/workflow').AutomationWorkflow}>(sql`select definition from automation_workflow_version where workflow_id=${workflowId}::uuid`);
  expect((await resignationWorkflowDryRun(f.admin,{caseId:f.journey.id,workflow:row.definition})).run).toMatchObject({wouldRun:false,reason:'Skipped: no People Business Partner is found for the case'});
  let current=await commandResignationJourney(f.admin,{caseId:f.journey.id,revision:f.journey.revision,command:{type:'runWorkflowsAgain'}});expect(current.deciders).toEqual([]);
  f.config.bpRules=[{rules:{company:[randomUUID()]},userId:f.fyiUserId}];
  await owner.db.execute(sql`update lc_v9_config set data=${JSON.stringify(f.config)}::jsonb where tenant_id=${f.base.tenantId}::uuid`);
  expect((await resignationWorkflowDryRun(f.admin,{caseId:f.journey.id,workflow:row.definition})).run.wouldRun).toBe(false);
  f.config.bpRules.push({rules:{company:[f.base.companyId]},userId:f.fyiUserId});
  await owner.db.execute(sql`update lc_v9_config set data=${JSON.stringify(f.config)}::jsonb where tenant_id=${f.base.tenantId}::uuid`);
  expect((await resignationWorkflowDryRun(f.admin,{caseId:f.journey.id,workflow:row.definition})).run.wouldRun).toBe(true);
  current=await commandResignationJourney(f.admin,{caseId:current.id,revision:current.revision,command:{type:'runWorkflowsAgain'}});expect(current.deciders.map(person=>person.id)).toEqual([f.managerUserId]);
 },90000);
 it('assigns decision and FYI separately, preserves the request UUID and excludes managed cases from legacy inboxes',async()=>{
  const f=await resignationJourneyFixture();
  const action=await resignationInbox(f.admin,{kind:'approvals'}),fyi=await resignationInbox(f.watcher,{kind:'approvals'});
  expect(action).toMatchObject({total:1,actionableTotal:1,fyiTotal:0});expect(action.items[0]).toMatchObject({caseId:f.journey.id,kind:'decision',actionable:true});expect(action.cases.map(c=>c.id)).toEqual([f.journey.id]);
  expect(fyi).toMatchObject({total:1,actionableTotal:0,fyiTotal:1});expect(fyi.items[0]).toMatchObject({kind:'fyi',canComment:true,actionable:false});
  await expect(submitResignation(f.staff,{employmentId:f.employee.employmentId,lastWorkingDay:f.lastWorkingDay})).rejects.toThrow(/current resignation form/);
  expect(await myResignation(f.staff,f.employee.employmentId)).toBeNull();expect(await listResignationRequests(f.admin)).toEqual([]);
  const commented=await commandResignationJourney(f.watcher,{caseId:f.journey.id,revision:f.journey.revision,command:{type:'comment',text:'Please confirm the handover.'}});expect(commented.comments.at(-1)?.text).toBe('Please confirm the handover.');
  await expect(commandResignationJourney(f.watcher,{caseId:f.journey.id,revision:commented.revision,command:{type:'accept',lastWorkingDay:f.lastWorkingDay,replacementNeeded:false}})).rejects.toMatchObject({code:'forbidden'});
  await expect(commandResignationJourney(f.admin,{caseId:f.journey.id,revision:f.journey.revision,command:{type:'accept',lastWorkingDay:f.lastWorkingDay,replacementNeeded:false}})).rejects.toMatchObject({code:'conflict'});
 },90000);
 it('lets an active account-only configured decider manage the request without inventing a Person identity',async()=>{
  const f=await resignationJourneyFixture({accountOnlyDecisionMaker:true});expect(f.admin.personId).toBeNull();const inbox=await resignationInbox(f.admin,{kind:'approvals'});expect(inbox.actionableTotal).toBe(1);
  const progressed=await commandResignationJourney(f.admin,{caseId:f.journey.id,revision:f.journey.revision,command:{type:'taskProgress',taskId:inbox.items[0].id,status:'progress'}});expect(progressed.tasks[0].status).toBe('progress');
  const commented=await commandResignationJourney(f.watcher,{caseId:f.journey.id,revision:progressed.revision,command:{type:'comment',text:'Handover is ready for the assigned account to decide.'}});
  const accepted=await commandResignationJourney(f.admin,{caseId:f.journey.id,revision:commented.revision,command:{type:'accept',lastWorkingDay:f.lastWorkingDay,replacementNeeded:true}});expect(accepted.stage).toBe('leaving');expect(accepted.replacementRequest?.status).toBe('requested');
  const completed=await commandResignationJourney(f.admin,{caseId:accepted.id,revision:accepted.revision,command:{type:'completeReplacement',taskId:accepted.replacementRequest!.id,reference:'https://recruitment.example.test/account-request'}});expect(completed.replacementRequest?.status).toBe('completed');
  const [stored]=await owner.db.execute<{personId:string|null;termination:string|null}>(sql`select u.person_id as "personId",e.terminated_on::text as termination from app_user u join employment e on e.tenant_id=u.tenant_id and e.id=${f.employee.employmentId}::uuid where u.id=${f.managerUserId}::uuid`);expect(stored).toEqual({personId:null,termination:null});
 },90000);
 it('blocks a letter route assigned only to an account without a Person instead of creating a dead signing task',async()=>{
  const f=await resignationJourneyFixture({accountOnlyDecisionMaker:true}),templateId=randomUUID();f.config.templates.push({id:templateId,name:'Requires a linked signing identity',module:'off',type:'Letter',rules:{},hrStep:'before',employeeAck:false,retired:false,currentVersion:1,versions:[{version:1,state:'published',at:new Date().toISOString(),by:'Fixture owner',blocks:[{id:'body',type:'text',text:'Resignation accepted.',section:''},{id:'sign',type:'signature',role:'step:hr',text:'',section:''}],fields:[],routing:[{id:'hr',order:1,action:'sign',who:{kind:'people',userIds:[f.managerUserId]},owner:true}]}]});await owner.db.execute(sql`update lc_v9_config set data=${JSON.stringify(f.config)}::jsonb where tenant_id=${f.base.tenantId}::uuid`);await f.workflow('accepted',[{id:'letter',type:'generateDocument',conditions:[],to:[],cc:[],params:{letterTemplateId:templateId}}]);
  const accepted=await commandResignationJourney(f.admin,{caseId:f.journey.id,revision:f.journey.revision,command:{type:'accept',lastWorkingDay:f.lastWorkingDay,replacementNeeded:false}});expect(accepted.stage).toBe('accepted');expect(accepted.letters).toEqual([]);expect(accepted.tasks.filter(task=>['sign','review','approve','update'].includes(task.kind))).toEqual([]);expect(accepted.blocked.join(' ')).toMatch(/linked Person/);expect(accepted.offboardingCaseId).toBeNull();
 },90000);
 it('freezes the canonical compensation currency and preserves it on prior-case offers without guessing a currency',async()=>{
  const f=await resignationJourneyFixture({compensation:{basicSalary:5000,currency:'USD'}});expect(f.journey.currency).toBe('USD');const withdrawn=await commandResignationJourney(f.staff,{caseId:f.journey.id,revision:f.journey.revision,command:{type:'withdraw'}});
  await setCompensation(f.admin,{employmentId:f.employee.employmentId,basicSalary:5000,currency:'SGD',effectiveFrom:withdrawn.submittedOn});expect((await resignationCase(f.staff,withdrawn.id)).currency).toBe('USD');
  const next=await submitResignationJourney(f.staff,{employmentId:f.employee.employmentId,lastWorkingDay:f.lastWorkingDay});expect(next.currency).toBe('SGD');expect(next.priorCases[0].currency).toBe('USD');
  const unknown=await resignationJourneyFixture();expect(unknown.journey.currency).toBeNull();
 },90000);
 it('records an unconfigured submission, flags the real PeopleOps team and repairs from fresh Live workflows exactly once',async()=>{
  const f=await resignationJourneyFixture({decisionWorkflow:false,peopleOps:'watcher'});expect(f.journey.stage).toBe('decision');expect(f.journey.deciders).toEqual([]);expect(f.journey.blocked.join(' ')).toMatch(/Nobody was asked/);
  const repairs=await resignationInbox(f.watcher,{kind:'tasks'});expect(repairs.items.map(item=>item.kind)).toEqual(['repair']);const[authority]=await withTenant(f.watcher,tx=>tx.execute<{configure:boolean}>(sql`select app.automation_can_configure('off') as configure`));expect(authority.configure).toBe(false);
  await expect(commandResignationJourney(f.staff,{caseId:f.journey.id,revision:f.journey.revision,command:{type:'runWorkflowsAgain'}})).rejects.toMatchObject({code:'forbidden'});
  await f.workflow('submitted',[{id:'received',type:'notify',conditions:[],to:[{kind:'role',role:'employee'}],cc:[],params:{subject:'Submission recorded',body:'Your resignation is recorded.'}}]);
  const stillMissing=await commandResignationJourney(f.watcher,{caseId:f.journey.id,revision:f.journey.revision,command:{type:'runWorkflowsAgain'}});expect(stillMissing.deciders).toEqual([]);const [oldRun]=await owner.db.execute<{id:string;snapshot:unknown}>(sql`select id,to_jsonb(r) as snapshot from automation_run r where tenant_id=${f.base.tenantId}::uuid and subject_id=${f.journey.id}::uuid order by started_at,id limit 1`);expect(oldRun).toBeTruthy();
  await f.workflow('submitted',[{id:'decision',type:'requestDecision',conditions:[],to:[{kind:'person',userId:f.managerUserId}],cc:[],params:{choices:'both',watch:[],canComment:true}}]);
  const assigned=await commandResignationJourney(f.watcher,{caseId:f.journey.id,revision:stillMissing.revision,command:{type:'runWorkflowsAgain'}});expect(assigned.deciders.map(person=>person.id)).toEqual([f.managerUserId]);expect(assigned.blocked).toEqual([]);expect((await resignationInbox(f.watcher,{kind:'tasks'})).items.filter(task=>task.kind==='repair')).toEqual([]);
  const [unchanged]=await owner.db.execute<{snapshot:unknown}>(sql`select to_jsonb(r) as snapshot from automation_run r where id=${oldRun.id}::uuid`);expect(unchanged.snapshot).toEqual(oldRun.snapshot);
  await expect(commandResignationJourney(f.watcher,{caseId:assigned.id,revision:assigned.revision,command:{type:'runWorkflowsAgain'}})).rejects.toMatchObject({code:'forbidden'});
  const waiting=await owner.db.execute(sql`select id from automation_run where subject_id=${assigned.id}::uuid and status='waiting'`);expect(waiting).toHaveLength(1);
 },90000);
 it('keeps submission open without configuration and truthfully records an absent repair audience',async()=>{
  const f=await resignationJourneyFixture({decisionWorkflow:false});await owner.db.execute(sql`update lc_onboarding_config set data=jsonb_set(jsonb_set(data,'{groups}', '[]'::jsonb),'{access,offboarding}','[]'::jsonb) where tenant_id=${f.base.tenantId}::uuid`);
  const closed=await commandResignationJourney(f.staff,{caseId:f.journey.id,revision:f.journey.revision,command:{type:'withdraw'}});const form=await resignationEmployeeView(f.staff,f.employee.employmentId);expect(form.canSubmit).toBe(true);expect(form.unavailableReason).toBeNull();expect(form.configurationMessage).toBeTruthy();
  const recorded=await submitResignationJourney(f.staff,{employmentId:f.employee.employmentId,lastWorkingDay:closed.lastWorkingDay});expect(recorded.stage).toBe('decision');expect(recorded.blocked.join(' ')).toMatch(/No repair notification was sent/);expect(recorded.tasks.filter(task=>task.kind==='repair')).toEqual([]);
 },90000);
 it('installs defaults through canonical shared groups in dependency order and never overwrites customized definitions',async()=>{
  const f=await resignationJourneyFixture({decisionWorkflow:false});const installed=await installResignationDefaults(f.admin);expect(installed).toMatchObject({workflows:11,templates:2,emails:3,groups:2});
  const [shared]=await owner.db.execute<{groups:{id:string;members:string[]}[]}>(sql`select data->'groups' as groups from lc_onboarding_config where tenant_id=${f.base.tenantId}::uuid`);expect(shared.groups.find(group=>group.id===f.groupId)?.members).toEqual([f.managerUserId]);
  await owner.db.execute(sql`update lc_v9_config set data=jsonb_set(data,'{templates}',(select jsonb_agg(case when t->>'id'='a0710000-0000-4000-8000-000000000002' then t||jsonb_build_object('name','Customized acceptance') else t end) from jsonb_array_elements(data->'templates') t)) where tenant_id=${f.base.tenantId}::uuid`);
  expect(await installResignationDefaults(f.admin)).toMatchObject({workflows:0,templates:0,emails:0,groups:0});const[stored]=await owner.db.execute<{name:string;allPaused:boolean}>(sql`select (select t->>'name' from lc_v9_config c,jsonb_array_elements(c.data->'templates') t where c.tenant_id=${f.base.tenantId}::uuid and t->>'id'='a0710000-0000-4000-8000-000000000002') as name,(select bool_and(status='paused') from automation_workflow_version where tenant_id=${f.base.tenantId}::uuid) as "allPaused"`);expect(stored).toEqual({name:'Customized acceptance',allPaused:true});expect((await resignationCase(f.staff,f.journey.id)).stage).toBe('decision');
 },90000);
 it('acceptance keeps employment active and leave unfrozen until clearance; replacement creates one actionable HR request',async()=>{
  const f=await resignationJourneyFixture();const accepted=await commandResignationJourney(f.admin,{caseId:f.journey.id,revision:f.journey.revision,command:{type:'accept',lastWorkingDay:f.lastWorkingDay,replacementNeeded:true}});
  expect(accepted.replacementRequest).toMatchObject({status:'requested',reference:null});
  const [row]=await owner.db.execute<{termination:string|null;status:string}>(sql`select e.terminated_on::text as termination,r.status from employment e join resignation_request r on r.employment_id=e.id where e.id=${f.employee.employmentId}::uuid and r.id=${f.journey.id}::uuid`);expect(row).toEqual({termination:null,status:'pending'});
  await expect(decideResignation(f.admin,{requestId:f.journey.id,decision:'accepted'})).rejects.toThrow(/clearance/);
  const tasks=await resignationInbox(f.admin,{kind:'tasks'});expect(tasks.items.filter(t=>t.kind==='recruitment')).toHaveLength(1);
  const complete=await commandResignationJourney(f.admin,{caseId:f.journey.id,revision:accepted.revision,command:{type:'completeReplacement',taskId:accepted.replacementRequest!.id,reference:'https://recruitment.example.test/requests/approved'}});expect(complete.replacementRequest?.status).toBe('completed');
  await expect(commandResignationJourney(f.admin,{caseId:f.journey.id,revision:complete.revision,command:{type:'completeReplacement',taskId:accepted.replacementRequest!.id,reference:'https://recruitment.example.test/requests/duplicate'}})).rejects.toMatchObject({code:'forbidden'});
 },90000);
 it('keeps a retention offer private until it reaches the employee and never reveals it to an unrelated FYI reader',async()=>{
  const f=await resignationJourneyFixture(),templateId=randomUUID();
  f.config.templates.push({id:templateId,name:'Private retention offer',module:'off',type:'Letter',rules:{caseType:['Resignation']},hrStep:'before',employeeAck:true,retired:false,currentVersion:1,versions:[{version:1,state:'published',at:new Date().toISOString(),by:'Fixture owner',blocks:[{id:'offer',type:'text',text:'Salary {retention.salary}; {retention.title}',section:''},{id:'hr',type:'signature',role:'step:hr-sign',text:'',section:''},{id:'employee',type:'signature',role:'step:employee',text:'',section:''}],fields:[],routing:[{id:'review',order:1,action:'review',who:{kind:'people',userIds:[f.managerUserId]},owner:true},{id:'hr-sign',order:2,action:'sign',who:{kind:'people',userIds:[f.managerUserId]},owner:false},{id:'employee',order:3,action:'sign',who:{kind:'employee'},owner:false}]}]});
  await owner.db.execute(sql`update lc_v9_config set data=${JSON.stringify(f.config)}::jsonb where tenant_id=${f.base.tenantId}::uuid`);
  await f.workflow('retention',[{id:'offer-letter',type:'generateDocument',conditions:[],to:[],cc:[],params:{letterTemplateId:templateId,replyDays:5,remindDays:2}}]);
  let current=await commandResignationJourney(f.admin,{caseId:f.journey.id,revision:f.journey.revision,command:{type:'offer',offer:{position:'New position',jobGrade:'M1',basicSalary:'12345.67',effectiveDate:f.lastWorkingDay,justification:'Private salary proposal'}}});
  const privateEmployee=await resignationCase(f.staff,current.id),privateFyi=await resignationCase(f.watcher,current.id);
  for(const projected of [privateEmployee,privateFyi]){expect(projected.offer).toBeNull();expect(projected.emails).toEqual([]);expect(projected.letters[0]).toMatchObject({private:true,document:null,blocks:[],routing:[],changes:[],sentBack:null});expect(JSON.stringify(projected)).not.toContain('12345.67');expect(JSON.stringify(projected)).not.toContain('Private salary proposal');}
  expect(current.offer?.basicSalary).toBe('12345.67');
  let letter=current.letters[0];current=await commandResignationJourney(f.admin,{caseId:current.id,revision:current.revision,command:{type:'letterAction',documentId:letter.id,documentRevision:letter.revision,action:'review'}});
  letter=current.letters[0];const originalGeneratedOn=letter.generatedOn,previousRevision=letter.revision;const template=f.config.templates.find(t=>t.id===templateId)!;const version=structuredClone(template.versions[0]);version.version=2;version.blocks[0].text='Latest approved template: {retention.salary}';template.versions.push(version);template.currentVersion=2;await owner.db.execute(sql`update lc_v9_config set data=${JSON.stringify(f.config)}::jsonb where tenant_id=${f.base.tenantId}::uuid`);
  await expect(commandResignationJourney(f.watcher,{caseId:current.id,revision:current.revision,command:{type:'regenerateLetter',documentId:letter.id,documentRevision:letter.revision}})).rejects.toMatchObject({code:'forbidden'});
  current=await commandResignationJourney(f.admin,{caseId:current.id,revision:current.revision,command:{type:'regenerateLetter',documentId:letter.id,documentRevision:letter.revision}});letter=current.letters[0];expect(letter.templateVersion).toBe(2);expect(letter.revision).toBe(previousRevision+1);expect(letter.generatedOn).toBe(originalGeneratedOn);expect(letter.document?.blocks[0].text).toContain('Latest approved template:');expect(letter.routing[0].status).toBe('pending');
  current=await commandResignationJourney(f.admin,{caseId:current.id,revision:current.revision,command:{type:'letterAction',documentId:letter.id,documentRevision:letter.revision,action:'review'}});letter=current.letters[0];current=await commandResignationJourney(f.admin,{caseId:current.id,revision:current.revision,command:{type:'letterAction',documentId:letter.id,documentRevision:letter.revision,action:'sign',signature:'Journey manager',consent:true}});
  await expect(commandResignationJourney(f.admin,{caseId:current.id,revision:current.revision,command:{type:'regenerateLetter',documentId:letter.id,documentRevision:current.letters[0].revision}})).rejects.toMatchObject({code:'forbidden'});
  const visible=await resignationCase(f.staff,current.id);expect(visible.offer?.basicSalary).toBe('12345.67');expect(visible.letters[0].private).toBe(false);expect((await resignationCase(f.watcher,current.id)).offer).toBeNull();
 },90000);
 it.each(['unknown token','required field'] as const)('does not persist a final signature, delivery or posting when a retention letter has an unresolved %s',async problem=>{
  const f=await resignationJourneyFixture(),templateId=randomUUID();
  f.config.templates.push({id:templateId,name:'Release validation fixture',module:'off',type:'Letter',rules:{caseType:['Resignation']},hrStep:'none',employeeAck:true,retired:false,currentVersion:1,versions:[{version:1,state:'published',at:new Date().toISOString(),by:'Fixture owner',blocks:[{id:'body',type:'text',text:problem==='unknown token'?'Dear {employee.name}, reference {unknown.code}.':'Dear {employee.name}.',section:'main'},...(problem==='required field'?[{id:'required',type:'field' as const,fieldId:'required-confirmation',text:'',section:'main'}]:[]),{id:'employee-signature',type:'signature',role:'step:employee',text:'',section:'main'}],fields:problem==='required field'?[{id:'required-confirmation',label:'Required confirmation',type:'text',owner:'employee',pmKey:null,required:true,sensitive:false,options:[],section:'main',when:null}]:[],routing:[{id:'review',order:1,action:'review',who:{kind:'people',userIds:[f.managerUserId]},owner:true},{id:'employee',order:2,action:'sign',who:{kind:'employee'},owner:false}]}]});
  await owner.db.execute(sql`update lc_v9_config set data=${JSON.stringify(f.config)}::jsonb where tenant_id=${f.base.tenantId}::uuid`);
  await f.workflow('retention',[{id:'generate',type:'generateDocument',conditions:[],to:[],cc:[],params:{letterTemplateId:templateId}}]);
  await f.workflow('offerAccepted',[{id:'deliver',type:'notify',conditions:[],to:[{kind:'role',role:'employee'}],cc:[],params:{subject:'Accepted offer',body:'Your signed letter is ready.'}},{id:'posting',type:'createPosting',conditions:[],to:[],cc:[],params:{eventType:'Promotion',dateFrom:'offerEff',fields:['title']}}]);
  let current=await commandResignationJourney(f.admin,{caseId:f.journey.id,revision:f.journey.revision,command:{type:'offer',offer:{position:'Proposed position',jobGrade:'M1',basicSalary:'5500.00',effectiveDate:f.lastWorkingDay,justification:'Fixture proposal'}}});
  let letter=current.letters[0];current=await commandResignationJourney(f.admin,{caseId:current.id,revision:current.revision,command:{type:'letterAction',documentId:letter.id,documentRevision:letter.revision,action:'review'}});
  letter=current.letters[0];current=await commandResignationJourney(f.staff,{caseId:current.id,revision:current.revision,command:{type:'openLetter',documentId:letter.id,documentRevision:letter.revision}});
  const [before]=await owner.db.execute<{data:unknown;revision:number}>(sql`select data,revision from resignation_journey where id=${current.id}::uuid`);
  const [mailBefore]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from automation_email_delivery where tenant_id=${f.base.tenantId}::uuid and subject_id=${current.id}::uuid`);
  await expect(commandResignationJourney(f.staff,{caseId:current.id,revision:current.revision,command:{type:'letterAction',documentId:letter.id,documentRevision:letter.revision,action:'sign',signature:'Journey employee',consent:true}})).rejects.toMatchObject({code:'invalid',message:expect.stringContaining(problem==='unknown token'?'Unknown merge field {unknown.code}':'required visible letter field')});
  const [after]=await owner.db.execute<{data:unknown;revision:number}>(sql`select data,revision from resignation_journey where id=${current.id}::uuid`);expect(after).toEqual(before);
  const stored=after.data as {letters:{state:string;document:{actions:{action:string}[]}}[];releasedDocuments:unknown[]};expect(stored.letters[0].state).not.toBe('released');expect(stored.letters[0].document.actions.some(action=>action.action==='signed')).toBe(false);expect(stored.releasedDocuments).toEqual([]);
  const [mailAfter]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from automation_email_delivery where tenant_id=${f.base.tenantId}::uuid and subject_id=${current.id}::uuid`);expect(mailAfter).toEqual(mailBefore);
  expect(await owner.db.execute(sql`select id from automation_run where subject_id=${current.id}::uuid and trigger_event='offerAccepted'`)).toHaveLength(0);
  expect(await owner.db.execute(sql`select id from personnel_posting where source='offboarding' and source_ref=${current.id}::uuid`)).toHaveLength(0);
 },90000);
 it('does not expose a private letter or salary through a frozen teammate account relinked to another Person',async()=>{
  const f=await resignationJourneyFixture(),templateId=randomUUID();
  f.config.templates.push({id:templateId,name:'Identity-bound private offer',module:'off',type:'Letter',rules:{caseType:['Resignation']},hrStep:'none',employeeAck:true,retired:false,currentVersion:1,versions:[{version:1,state:'published',at:new Date().toISOString(),by:'Fixture owner',blocks:[{id:'terms',type:'text',text:'New salary {retention.salary}.',section:''},{id:'employee',type:'signature',text:'',role:'step:employee',section:''}],fields:[],routing:[{id:'review',order:1,action:'review',who:{kind:'people',userIds:[f.fyiUserId]},owner:true},{id:'employee',order:2,action:'sign',who:{kind:'employee'},owner:false}]}]});
  await owner.db.execute(sql`update lc_v9_config set data=${JSON.stringify(f.config)}::jsonb where tenant_id=${f.base.tenantId}::uuid`);await f.workflow('retention',[{id:'letter',type:'generateDocument',conditions:[],to:[],cc:[],params:{letterTemplateId:templateId}}]);
  const offered=await commandResignationJourney(f.admin,{caseId:f.journey.id,revision:f.journey.revision,command:{type:'offer',offer:{position:'New position',jobGrade:'M1',basicSalary:'8123.45',effectiveDate:f.lastWorkingDay,justification:'Private identity test'}}});
  const before=await resignationCase(f.watcher,offered.id);expect(before.offer?.basicSalary).toBe('8123.45');expect(before.letters[0].document).toBeTruthy();
  await owner.db.execute(sql`update app_user set person_id=${f.manager.personId}::uuid where tenant_id=${f.base.tenantId}::uuid and id=${f.fyiUserId}::uuid`);
  const relinked={...f.watcher,personId:f.manager.personId},hidden=await resignationCase(relinked,offered.id);
  expect(hidden.offer).toBeNull();expect(hidden.currentBasicSalary).toBeNull();expect(hidden.letters[0]).toMatchObject({private:true,document:null,editableFieldIds:[]});expect(hidden.tasks.filter(task=>task.documentId).every(task=>!task.actionable)).toBe(true);expect(JSON.stringify(hidden)).not.toContain('8123.45');
  expect((await resignationCase(f.admin,offered.id)).offer?.basicSalary).toBe('8123.45');
 },90000);
 it('an own withdrawal closes only this managed case and preserves history; cross-case readers remain denied',async()=>{
  const f=await resignationJourneyFixture(),other=await resignationJourneyFixture();await expect(resignationCase(other.staff,f.journey.id)).rejects.toMatchObject({code:'not_found'});
  const withdrawn=await commandResignationJourney(f.staff,{caseId:f.journey.id,revision:f.journey.revision,command:{type:'withdraw'}});expect(withdrawn.stage).toBe('withdrawn');expect((await resignationInbox(f.admin,{kind:'approvals'})).total).toBe(0);
  const [request]=await owner.db.execute<{status:string}>(sql`select status from resignation_request where id=${f.journey.id}::uuid`);expect(request.status).toBe('withdrawn');expect((await resignationCase(f.staff,f.journey.id)).id).toBe(f.journey.id);
 },90000);
});
