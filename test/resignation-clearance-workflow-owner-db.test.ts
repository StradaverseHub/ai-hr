import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {beforeAll,beforeEach,afterAll,afterEach,vi,describe,it,expect} from 'vitest';
import {owner,migrateTestDb,resetDb,closeAll} from './harness';
import {resignationJourneyFixture} from './helpers/resignation-journey-fixture';
import {commandResignationJourney} from '../packs/lifecycle/service';
import {v9CaseDetail,v9Command,v9CreateOffboarding,v9Sweep} from '../packs/lifecycle/v9/service';
import {hireEmployee} from '../core/org';
import type {Template} from '../lib/lifecycle-v9-model';
beforeAll(migrateTestDb);beforeEach(resetDb);afterEach(()=>vi.unstubAllEnvs());afterAll(closeAll);

async function managedClearance(){
 const f=await resignationJourneyFixture(),templateId=randomUUID(),emailId=randomUUID();
 const template:Template={id:templateId,name:'Journey-owned acceptance',module:'off',type:'Letter',rules:{caseType:['Resignation']},hrStep:'before',employeeAck:false,retired:false,currentVersion:1,versions:[{version:1,state:'published',at:new Date().toISOString(),by:'Authorized configuration owner',blocks:[{id:'body',type:'text',text:'Your resignation is accepted.',section:''},{id:'sign',type:'signature',role:'step:hr',text:'',section:''}],fields:[],routing:[{id:'hr',order:1,action:'sign',who:{kind:'people',userIds:[f.managerUserId]},owner:true}]}]};
 f.config.templates.push(template);
 f.config.emails.push({id:emailId,name:'Legacy acceptance message',module:'off',active:true,sender:'',subject:'Legacy acceptance',body:'Your resignation is accepted.',cc:[],links:[],attachments:[],slots:[]});
 f.config.checklists=[{id:randomUUID(),name:'Clearance handover',module:'off',rules:{caseType:['Resignation']},tasks:[{id:'handover',name:'Complete the handover',by:'group',group:f.groupId,mode:'rr',opens:null,due:0,required:true,documentTemplate:null,documentAction:'completed'}]}];
 f.config.workflows=[{id:randomUUID(),name:'Legacy acceptance generation',module:'off',status:'published',description:'',trigger:{event:'submitted',days:0,workdays:false,repeat:false,skipIf:''},conditions:[],steps:[{id:'acceptance',type:'doc',template:templateId,release:false},{id:'message',type:'email',template:emailId,to:'employee',cc:[]}]},{id:randomUUID(),name:'Legacy scheduled acceptance',module:'off',status:'published',description:'',trigger:{event:'beforeLWD',days:1000,workdays:false,repeat:false,skipIf:''},conditions:[],steps:[{id:'message',type:'email',template:emailId,to:'employee',cc:[]}]}];
 const save=()=>owner.db.execute(sql`update lc_v9_config set data=${JSON.stringify(f.config)}::jsonb where tenant_id=${f.base.tenantId}::uuid`);await save();
 await f.workflow('accepted',[{id:'acceptance',type:'generateDocument',conditions:[],to:[],cc:[],params:{letterTemplateId:templateId}},{id:'clearance',type:'startOffboarding',conditions:[],to:[],cc:[],params:{}}]);
 let journey=await commandResignationJourney(f.admin,{caseId:f.journey.id,revision:f.journey.revision,command:{type:'accept',lastWorkingDay:f.lastWorkingDay,replacementNeeded:false}});
 const letter=journey.letters[0];journey=await commandResignationJourney(f.admin,{caseId:journey.id,revision:journey.revision,command:{type:'letterAction',documentId:letter.id,documentRevision:letter.revision,action:'sign',signature:'Journey manager',consent:true}});
 expect(journey.offboardingCaseId).toBeTruthy();return{f,journey,templateId,save};
}

describe('one communication owner for managed resignation clearance',()=>{
 it('keeps checklist work while submit and date sweeps cannot create a second legacy acceptance letter or email',async()=>{
  const {f,journey,templateId,save}=await managedClearance(),id=journey.offboardingCaseId!;
  // A linked business-letter requirement needs an explicit HR configuration decision, never a guessed completion.
  f.config.checklists[0].tasks[0].documentTemplate=templateId;await save();let detail=await v9CaseDetail(f.admin,id);
  expect(detail.resignationDocuments?.ownedTemplateIds).toEqual([templateId]);expect(detail.resignationDocuments?.configurationWarnings).toHaveLength(1);
  await expect(v9Command(f.admin,id,detail.case.revision,{type:'submit'})).rejects.toThrow(/update the checklist requirement/);
  f.config.checklists[0].tasks[0].documentTemplate=null;await save();detail=await v9CaseDetail(f.admin,id);await v9Command(f.admin,id,detail.case.revision,{type:'submit'});
  detail=await v9CaseDetail(f.admin,id);expect(detail.case.state).toBe('submitted');expect(detail.case.tasks).toEqual([expect.objectContaining({id:'handover',status:'todo',required:true,assignee:f.managerUserId})]);expect(detail.case.documents).toEqual([]);expect(detail.case.runs).toEqual([]);expect(detail.case.mails).toEqual([]);
  await expect(v9Command(f.admin,id,detail.case.revision,{type:'generate',template:templateId})).rejects.toThrow(/owned by the linked resignation journey/);
  const system={...f.admin,userId:undefined,personId:undefined,roles:[]};const day=new Date();day.setUTCHours(1,0,0,0);expect((await v9Sweep(system,owner,day)).failed).toBe(0);
  detail=await v9CaseDetail(f.admin,id);expect(detail.case.documents).toEqual([]);expect(detail.case.runs).toEqual([]);expect(detail.case.mails).toEqual([]);expect(detail.case.tasks[0].status).toBe('todo');
  const [source]=await owner.db.execute<{letters:number}>(sql`select jsonb_array_length(data->'releasedDocuments') as letters from resignation_journey where id=${journey.id}::uuid`);expect(source.letters).toBe(1);
  const clearanceTemplateId=randomUUID();f.config.templates.push({id:clearanceTemplateId,name:'Separate clearance form',module:'off',type:'Form',rules:{},hrStep:'none',employeeAck:false,retired:false,currentVersion:1,versions:[{version:1,state:'published',at:new Date().toISOString(),by:'Fixture owner',blocks:[{id:'handover-record',type:'text',text:'Clearance inventory check.',section:''}],fields:[]}]});await save();await v9Command(f.admin,id,detail.case.revision,{type:'generate',template:clearanceTemplateId});const manual=await v9CaseDetail(f.admin,id);expect(manual.case.documents).toEqual([expect.objectContaining({templateId:clearanceTemplateId})]);expect(manual.case.runs).toEqual([]);
 },90000);
 it('leaves a pre-existing native case on its legacy document/email owner, even if a raw source label names another journey',async()=>{
  const {f,journey,templateId}=await managedClearance();const employee=await hireEmployee(f.admin,{person:{fullName:'Legacy clearance employee',primaryEmail:'legacy-clearance@example.test'},companyId:f.base.companyId,departmentId:f.base.deptA,employmentType:'full_time',hiredOn:'2026-01-01'});
  const id=await v9CreateOffboarding(f.admin,{employmentId:employee.employmentId,type:'Resignation',noticeDate:journey.submittedOn,lastDay:f.lastWorkingDay});
  // A source label alone is not the protected bidirectional link.
  await owner.db.execute(sql`update lc_v9_case set data=data||jsonb_build_object('resignationSourceCaseId',${journey.id}) where id=${id}::uuid`);
  const before=await v9CaseDetail(f.admin,id);await v9Command(f.admin,id,before.case.revision,{type:'submit'});const after=await v9CaseDetail(f.admin,id);
  expect(after.resignationDocuments).toBeUndefined();expect(after.case.documents).toEqual([expect.objectContaining({templateId})]);expect(after.case.runs.length).toBeGreaterThan(0);expect(after.case.tasks).toHaveLength(1);
 },90000);
});
