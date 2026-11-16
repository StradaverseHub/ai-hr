import {beforeAll,beforeEach,afterAll,afterEach,vi,describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {owner,migrateTestDb,resetDb,closeAll} from './harness';
import {resignationJourneyFixture} from './helpers/resignation-journey-fixture';
import {commandResignationJourney,resignationCase,resignationInbox} from '../packs/lifecycle/resignation/service';
import {myResignation,listResignationRequests,decideResignation,submitResignation} from '../core/offboarding';

beforeAll(migrateTestDb);beforeEach(resetDb);afterEach(()=>vi.unstubAllEnvs());afterAll(closeAll);

describe('managed resignation service composes one workflow authority',()=>{
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
 it('acceptance keeps employment active and leave unfrozen until clearance; replacement creates one actionable HR request',async()=>{
  const f=await resignationJourneyFixture();const accepted=await commandResignationJourney(f.admin,{caseId:f.journey.id,revision:f.journey.revision,command:{type:'accept',lastWorkingDay:f.lastWorkingDay,replacementNeeded:true}});
  expect(accepted.replacementRequest).toMatchObject({status:'requested',reference:null});
  const [row]=await owner.db.execute<{termination:string|null;status:string}>(sql`select e.termination_date::text as termination,r.status from employment e join resignation_request r on r.employment_id=e.id where e.id=${f.employee.employmentId}::uuid and r.id=${f.journey.id}::uuid`);expect(row).toEqual({termination:null,status:'pending'});
  await expect(decideResignation(f.admin,{requestId:f.journey.id,decision:'accepted'})).rejects.toThrow(/clearance/);
  const tasks=await resignationInbox(f.admin,{kind:'tasks'});expect(tasks.items.filter(t=>t.kind==='recruitment')).toHaveLength(1);
  const complete=await commandResignationJourney(f.admin,{caseId:f.journey.id,revision:accepted.revision,command:{type:'completeReplacement',taskId:accepted.replacementRequest!.id,reference:'https://recruitment.example.test/requests/approved'}});expect(complete.replacementRequest?.status).toBe('completed');
  await expect(commandResignationJourney(f.admin,{caseId:f.journey.id,revision:complete.revision,command:{type:'completeReplacement',taskId:accepted.replacementRequest!.id,reference:'https://recruitment.example.test/requests/duplicate'}})).rejects.toMatchObject({code:'forbidden'});
 },90000);
 it('keeps a retention offer private until it reaches the employee and never reveals it to an unrelated FYI reader',async()=>{
  const f=await resignationJourneyFixture(),templateId=randomUUID();
  f.config.templates.push({id:templateId,name:'Private retention offer',module:'off',type:'Letter',rules:{caseType:['Resignation']},hrStep:'before',employeeAck:true,retired:false,currentVersion:1,versions:[{version:1,state:'published',at:new Date().toISOString(),by:'Fixture owner',blocks:[{id:'offer',type:'text',text:'Salary {{retention.salary}}; {{retention.title}}',section:''},{id:'hr',type:'signature',role:'step:hr-sign',text:'',section:''},{id:'employee',type:'signature',role:'step:employee',text:'',section:''}],fields:[],routing:[{id:'review',order:1,action:'review',who:{kind:'people',userIds:[f.managerUserId]},owner:true},{id:'hr-sign',order:2,action:'sign',who:{kind:'people',userIds:[f.managerUserId]},owner:false},{id:'employee',order:3,action:'sign',who:{kind:'employee'},owner:false}]}]});
  await owner.db.execute(sql`update lc_v9_config set data=${JSON.stringify(f.config)}::jsonb where tenant_id=${f.base.tenantId}::uuid`);
  await f.workflow('retention',[{id:'offer-letter',type:'generateDocument',conditions:[],to:[],cc:[],params:{letterTemplateId:templateId,replyDays:5,remindDays:2}}]);
  let current=await commandResignationJourney(f.admin,{caseId:f.journey.id,revision:f.journey.revision,command:{type:'offer',offer:{position:'New position',jobGrade:'M1',basicSalary:'12345.67',effectiveDate:f.lastWorkingDay,justification:'Private salary proposal'}}});
  const privateEmployee=await resignationCase(f.staff,current.id),privateFyi=await resignationCase(f.watcher,current.id);
  for(const projected of [privateEmployee,privateFyi]){expect(projected.offer).toBeNull();expect(projected.emails).toEqual([]);expect(projected.letters[0]).toMatchObject({private:true,document:null,blocks:[],routing:[],changes:[],sentBack:null});expect(JSON.stringify(projected)).not.toContain('12345.67');expect(JSON.stringify(projected)).not.toContain('Private salary proposal');}
  expect(current.offer?.basicSalary).toBe('12345.67');
  let letter=current.letters[0];current=await commandResignationJourney(f.admin,{caseId:current.id,revision:current.revision,command:{type:'letterAction',documentId:letter.id,documentRevision:letter.revision,action:'review'}});
  letter=current.letters[0];const originalGeneratedOn=letter.generatedOn,previousRevision=letter.revision;const template=f.config.templates.find(t=>t.id===templateId)!;const version=structuredClone(template.versions[0]);version.version=2;version.blocks[0].text='Latest approved template: {{retention.salary}}';template.versions.push(version);template.currentVersion=2;await owner.db.execute(sql`update lc_v9_config set data=${JSON.stringify(f.config)}::jsonb where tenant_id=${f.base.tenantId}::uuid`);
  await expect(commandResignationJourney(f.watcher,{caseId:current.id,revision:current.revision,command:{type:'regenerateLetter',documentId:letter.id,documentRevision:letter.revision}})).rejects.toMatchObject({code:'forbidden'});
  current=await commandResignationJourney(f.admin,{caseId:current.id,revision:current.revision,command:{type:'regenerateLetter',documentId:letter.id,documentRevision:letter.revision}});letter=current.letters[0];expect(letter.templateVersion).toBe(2);expect(letter.revision).toBe(previousRevision+1);expect(letter.generatedOn).toBe(originalGeneratedOn);expect(letter.document?.blocks[0].text).toContain('Latest approved template:');expect(letter.routing[0].status).toBe('pending');
  current=await commandResignationJourney(f.admin,{caseId:current.id,revision:current.revision,command:{type:'letterAction',documentId:letter.id,documentRevision:letter.revision,action:'review'}});letter=current.letters[0];current=await commandResignationJourney(f.admin,{caseId:current.id,revision:current.revision,command:{type:'letterAction',documentId:letter.id,documentRevision:letter.revision,action:'sign',signature:'Journey manager',consent:true}});
  await expect(commandResignationJourney(f.admin,{caseId:current.id,revision:current.revision,command:{type:'regenerateLetter',documentId:letter.id,documentRevision:current.letters[0].revision}})).rejects.toMatchObject({code:'forbidden'});
  const visible=await resignationCase(f.staff,current.id);expect(visible.offer?.basicSalary).toBe('12345.67');expect(visible.letters[0].private).toBe(false);expect((await resignationCase(f.watcher,current.id)).offer).toBeNull();
 },90000);
 it('an own withdrawal closes only this managed case and preserves history; cross-case readers remain denied',async()=>{
  const f=await resignationJourneyFixture(),other=await resignationJourneyFixture();await expect(resignationCase(other.staff,f.journey.id)).rejects.toMatchObject({code:'not_found'});
  const withdrawn=await commandResignationJourney(f.staff,{caseId:f.journey.id,revision:f.journey.revision,command:{type:'withdraw'}});expect(withdrawn.stage).toBe('withdrawn');expect((await resignationInbox(f.admin,{kind:'approvals'})).total).toBe(0);
  const [request]=await owner.db.execute<{status:string}>(sql`select status from resignation_request where id=${f.journey.id}::uuid`);expect(request.status).toBe('withdrawn');expect((await resignationCase(f.staff,f.journey.id)).id).toBe(f.journey.id);
 },90000);
});
