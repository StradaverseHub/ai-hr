import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {beforeAll,beforeEach,afterAll,afterEach,vi,describe,it,expect} from 'vitest';
import {withTenant} from '../db/client';
import {owner,migrateTestDb,resetDb,closeAll} from './harness';
import {resignationJourneyFixture} from './helpers/resignation-journey-fixture';
import {commandResignationJourney,resignationCase} from '../packs/lifecycle/resignation/service';
import {v9CreateOffboarding} from '../packs/lifecycle/v9/service';
beforeAll(migrateTestDb);beforeEach(resetDb);afterEach(()=>vi.unstubAllEnvs());afterAll(closeAll);
async function awaitingNonHrRelease(){
 const f=await resignationJourneyFixture(),templateId=randomUUID();
 f.config.templates.push({id:templateId,name:'Acceptance signed by assigned business partner',module:'off',type:'Letter',rules:{caseType:['Resignation']},hrStep:'before',employeeAck:false,retired:false,currentVersion:1,versions:[{version:1,state:'published',at:new Date().toISOString(),by:'Fixture owner',blocks:[{id:'acceptance',type:'text',text:'Your resignation has been accepted.',section:''},{id:'signature',type:'signature',role:'step:assigned-sign',text:'',section:''}],fields:[],routing:[{id:'assigned-sign',order:1,action:'sign',who:{kind:'people',userIds:[f.fyiUserId]},owner:true}]}]});
 await owner.db.execute(sql`update lc_v9_config set data=${JSON.stringify(f.config)}::jsonb where tenant_id=${f.base.tenantId}::uuid`);
 await f.workflow('accepted',[{id:'acceptance',type:'generateDocument',conditions:[],to:[],cc:[],params:{letterTemplateId:templateId}},{id:'clearance',type:'startOffboarding',conditions:[],to:[],cc:[],params:{}}]);
 const accepted=await commandResignationJourney(f.admin,{caseId:f.journey.id,revision:f.journey.revision,command:{type:'accept',lastWorkingDay:f.lastWorkingDay,replacementNeeded:false}});
 const assigned=await resignationCase(f.watcher,accepted.id);expect(assigned.letters[0].capabilities.sign).toBe(true);expect(assigned.offboardingCaseId).toBeNull();
 return{f,assigned};
}
describe('Case-bound resignation handoff under a non-HR letter signer',()=>{
 it('constructs the matching clearance case without granting workforce access or exposing an unrestricted source projection',async()=>{
  const {f,assigned}=await awaitingNonHrRelease();
  const [authority]=await withTenant(f.watcher,tx=>tx.execute<{maintain:boolean}>(sql`select app.access_workforce_employment(${f.employee.employmentId}::uuid,'workforce.maintain') as maintain`));expect(authority.maintain).toBe(false);
  await expect(withTenant(f.watcher,tx=>tx.execute(sql`select app.resignation_offboarding_intent(${assigned.id}::uuid)`))).rejects.toThrow();
  const letter=assigned.letters[0],released=await commandResignationJourney(f.watcher,{caseId:assigned.id,revision:assigned.revision,command:{type:'letterAction',documentId:letter.id,documentRevision:letter.revision,action:'sign',signature:'Assigned business partner',consent:true}});
  expect(released.offboardingCaseId).toBeTruthy();
  const [created]=await owner.db.execute<{companyId:string;employmentId:string;source:string;employee:string;employeeUserId:string}>(sql`select company_id as "companyId",employment_id as "employmentId",data->>'resignationSourceCaseId' as source,data->'facts'->>'personId' as employee,data->'facts'->>'employeeUserId' as "employeeUserId" from lc_v9_case where id=${released.offboardingCaseId}::uuid`);
  expect(created).toEqual({companyId:f.base.companyId,employmentId:f.employee.employmentId,source:assigned.id,employee:f.employee.personId,employeeUserId:f.employeeUserId});
  const [stillDenied]=await withTenant(f.watcher,tx=>tx.execute<{maintain:boolean}>(sql`select app.access_workforce_employment(${f.employee.employmentId}::uuid,'workforce.maintain') as maintain`));expect(stillDenied.maintain).toBe(false);
 },90000);
 it('detects another pending exit even when that case is hidden from the releasing signer',async()=>{
  const {f,assigned}=await awaitingNonHrRelease();
  const prior=await v9CreateOffboarding(f.admin,{employmentId:f.employee.employmentId,type:'Resignation',noticeDate:assigned.submittedOn,lastDay:f.lastWorkingDay});
  const hidden=await withTenant(f.watcher,tx=>tx.execute(sql`select id from lc_v9_case where id=${prior}::uuid`));expect(hidden).toHaveLength(0);
  const letter=assigned.letters[0];await expect(commandResignationJourney(f.watcher,{caseId:assigned.id,revision:assigned.revision,command:{type:'letterAction',documentId:letter.id,documentRevision:letter.revision,action:'sign',signature:'Assigned business partner',consent:true}})).rejects.toThrow(/open offboarding case/i);
  const rows=await owner.db.execute(sql`select id from lc_v9_case where tenant_id=${f.base.tenantId}::uuid and employment_id=${f.employee.employmentId}::uuid and module='off'`);expect(rows).toHaveLength(1);
 },90000);
});
