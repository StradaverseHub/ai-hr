/** Repeated managed submissions use real signing and posting services; no closed case or outcome is forged. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {owner,migrateTestDb,resetDb,closeAll} from './harness';
import {resignationJourneyFixture} from './helpers/resignation-journey-fixture';
import {commandResignationJourney,resignationCase,resignationEmployeeView,submitResignationJourney,v9Configuration,v9SaveConfig} from '../packs/lifecycle/service';
import {listPersonnelPostings,personnelPosting} from '../packs/personnel-postings/service';
import {todayInKualaLumpur} from '../lib/hr-date';
import type {Template} from '../lib/lifecycle-v9-model';
beforeAll(migrateTestDb);beforeEach(resetDb);afterEach(()=>vi.unstubAllEnvs());afterAll(closeAll);

// The existing real journey fixture family uses 90 s; two full submissions/signing/configuration chains get 120 s.
it('records a second resignation after retention, preserves its pending posting and enforces default versus blank re-offer limits',async()=>{
 const f=await resignationJourneyFixture({compensation:{basicSalary:5000,currency:'MYR'}}),templateId=randomUUID();
 const config=structuredClone((await v9Configuration(f.admin)).config!);delete config.offboarding;
 const template:Template={id:templateId,name:'Repeated resignation retention terms',module:'off',type:'Letter',rules:{caseType:['Resignation']},hrStep:'none',employeeAck:true,retired:false,currentVersion:1,versions:[{version:1,state:'published',at:new Date().toISOString(),by:'Fixture configuration owner',fields:[],blocks:[{id:'terms',type:'text',text:'Dear {employee.name}. Revised basic salary {retention.salary}.',section:''},{id:'hr-signature',type:'signature',role:'step:hr',text:'',section:''},{id:'employee-signature',type:'signature',role:'step:employee',text:'',section:''}],routing:[{id:'hr',order:1,action:'sign',who:{kind:'people',userIds:[f.managerUserId]},owner:true},{id:'employee',order:2,action:'sign',who:{kind:'employee'},owner:false}]}]};
 config.templates.push(template);await v9SaveConfig(f.admin,config.revision,config);
 await f.workflow('retention',[{id:'generate',type:'generateDocument',conditions:[],to:[],cc:[],params:{letterTemplateId:templateId}}]);
 await f.workflow('offerAccepted',[{id:'salary-posting',type:'createPosting',conditions:[],to:[],cc:[],params:{eventType:'Increment',dateFrom:'offerEff',fields:['salary']}}]);
 const offer={position:'Agreed retention position',jobGrade:'',basicSalary:'5500.00',effectiveDate:f.lastWorkingDay,justification:'Signed terms for the first resignation.'};
 let first=await commandResignationJourney(f.admin,{caseId:f.journey.id,revision:f.journey.revision,command:{type:'offer',offer}});
 first=await commandResignationJourney(f.admin,{caseId:first.id,revision:first.revision,command:{type:'letterAction',documentId:first.letters[0].id,documentRevision:first.letters[0].revision,action:'sign',signature:'Journey manager',consent:true}});
 first=await commandResignationJourney(f.staff,{caseId:first.id,revision:first.revision,command:{type:'openLetter',documentId:first.letters[0].id,documentRevision:first.letters[0].revision}});
 first=await commandResignationJourney(f.staff,{caseId:first.id,revision:first.revision,command:{type:'letterAction',documentId:first.letters[0].id,documentRevision:first.letters[0].revision,action:'sign',signature:'Journey employee',consent:true}});expect(first.stage).toBe('retained');
 const postings=(await listPersonnelPostings(f.admin,{source:'offboarding',status:'pending'})).rows;expect(postings).toHaveLength(1);const posting=postings[0];
 expect(await personnelPosting(f.admin,posting.id)).toMatchObject({sourceRef:first.id,status:'pending',eventType:'increment',proposed:{effectiveDate:f.lastWorkingDay,basicSalary:'5500.00'}});
 const snapshot=async()=>{const[row]=await owner.db.execute<{posting:string;journey:string}>(sql`select to_jsonb(p)::text as posting,to_jsonb(j)::text as journey from personnel_posting p join resignation_journey j on j.tenant_id=p.tenant_id and j.id=p.source_ref where p.tenant_id=${f.base.tenantId}::uuid and p.id=${posting.id}::uuid`);return row;},before=await snapshot();
 const form=await resignationEmployeeView(f.staff,f.employee.employmentId);expect(form.canSubmit).toBe(true);expect(form.cases[0].id).toBe(first.id);
 let second=await submitResignationJourney(f.staff,{employmentId:f.employee.employmentId,lastWorkingDay:f.lastWorkingDay,reason:'A second independent resignation after signed retention.'});expect(second.id).not.toBe(first.id);expect(second.stage).toBe('decision');expect(second.priorCases).toEqual([expect.objectContaining({id:first.id,stage:'retained',closedOn:todayInKualaLumpur(),offer})]);
 second=await resignationCase(f.admin,second.id);expect(second.decisionChoices).toBe('both');expect(second.capabilities.offer).toBe(false);expect(second.offerBlock).toMatch(/accepted recently/);
 const revision=second.revision;await expect(commandResignationJourney(f.admin,{caseId:second.id,revision,command:{type:'offer',offer:{...offer,basicSalary:'5700.00'}}})).rejects.toMatchObject({code:'forbidden',message:expect.stringContaining('accepted recently')});
 expect((await resignationCase(f.admin,second.id)).revision).toBe(revision);expect(await snapshot()).toEqual(before);
 const blank=structuredClone((await v9Configuration(f.admin)).config!);blank.offboarding={postingApproverGroupId:f.groupId,reofferMonths:null};await v9SaveConfig(f.admin,blank.revision,blank);
 second=await resignationCase(f.admin,second.id);expect(second.capabilities.offer).toBe(true);expect(second.offerBlock).toBeNull();
 second=await commandResignationJourney(f.admin,{caseId:second.id,revision:second.revision,command:{type:'offer',offer:{...offer,basicSalary:'5700.00'}}});expect(second.stage).toBe('retention');expect(second.offer?.basicSalary).toBe('5700.00');expect(second.letters).toHaveLength(1);expect(second.letters[0].id).not.toBe(first.letters[0].id);
 expect((await listPersonnelPostings(f.admin,{source:'offboarding',status:'pending'})).rows.map(row=>row.id)).toEqual([posting.id]);expect(await snapshot()).toEqual(before);
 const cases=(await resignationEmployeeView(f.staff,f.employee.employmentId)).cases;expect(cases.map(row=>row.id)).toEqual([second.id,first.id]);expect(cases[1].stage).toBe('retained');
},120000);
