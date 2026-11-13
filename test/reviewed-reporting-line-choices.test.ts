/** Authored UNRUN: real scoped Workforce purpose predicates, literal human search and fresh admission. */
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
vi.mock('server-only',()=>({}));
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {assignRole} from '../core/admin';
import {grantAssistant,revokeAssistant} from '../core/assistant-grant';
import {readOrgModuleActionAvailability,readOrgModuleActionChoices} from '../core/assistant-actions/module-action-server';
import {reviewedReportingLineLabelsTx} from '../core/workforce-commands';
import {withAccessDisplayRead} from '../core/access-configuration-lock';
import {withTenant,type SessionContext} from '../db/client';
import {setAiAllowance} from '../core/ai-management';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

let b:Base,ctx:SessionContext,employee:{employmentId:string};
const group=()=>({...adminCtx(b),grants:[{role:'hr_admin' as const,companyId:null}]});
const hire=(name:string,companyId=b.companyId,departmentId=b.deptA)=>hireEmployee(group(),{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId,departmentId,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'assistant','active');employee=await hire('Literal % employee');const hr=await hire('Scoped HR');const [user]=await owner.db.insert(s.appUser).values({tenantId:b.tenantId,workosUserId:'fixture_'+randomUUID(),personId:hr.personId}).returning({id:s.appUser.id});await assignRole(group(),{appUserId:user.id,role:'hr_admin',companyId:b.companyId});await grantAssistant(group(),{appUserId:user.id});ctx={...await entitledCtx(b),userId:user.id,personId:hr.personId,grants:[{role:'hr_admin',companyId:b.companyId}]};});
async function foreign(){const [co]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'PRIVATE OTHER',companyLabel:'OTHER'}).returning({id:s.company.id}),[d]=await owner.db.insert(s.department).values({tenantId:b.tenantId,companyId:co.id,name:'Other department'}).returning({id:s.department.id});return hire('PRIVATE Literal % manager',co.id,d.id);}
describe('bounded authorised Org human choices',()=>{
 it('uses literal percent/underscore search, projects only four permitted label fields and excludes unauthorised company people',async()=>{await foreign();await hire('Literal underscore_employee');const percent=await readOrgModuleActionChoices(ctx,{role:'subordinate',query:'% e'});expect(percent.items).toHaveLength(1);expect(percent.items[0].employmentId).toBe(employee.employmentId);expect(Object.keys(percent.items[0]).sort()).toEqual(['companyName','employeeCode','employmentId','name']);const underscore=await readOrgModuleActionChoices(ctx,{role:'subordinate',query:'_e'});expect(underscore.items).toHaveLength(1);expect(underscore.items[0].name).toBe('Literal underscore_employee');expect(JSON.stringify(percent)).not.toContain('PRIVATE');});
 it('requires maintain on the actual selected subordinate before manager candidates, and never returns a self-manager',async()=>{const other=await foreign();await expect(readOrgModuleActionChoices(ctx,{role:'manager',query:'Literal',subordinateEmploymentId:other.employmentId})).rejects.toThrow();const choices=await readOrgModuleActionChoices(ctx,{role:'manager',query:'Literal',subordinateEmploymentId:employee.employmentId});expect(choices.items.some(r=>r.employmentId===employee.employmentId)).toBe(false);expect(JSON.stringify(choices)).not.toContain('PRIVATE');});
 it('returns at most20 in deterministic company/code/id order with truthful truncation, without listing all people',async()=>{for(let n=0;n<22;n++)await hire('Bounded Search '+String(n).padStart(2,'0'));const result=await readOrgModuleActionChoices(ctx,{role:'subordinate',query:'Bounded Search'});expect(result.items).toHaveLength(20);expect(result.truncated).toBe(true);const next=await readOrgModuleActionChoices(ctx,{role:'subordinate',query:'Bounded Search'});expect(next.items.map(r=>r.employmentId)).toEqual(result.items.map(r=>r.employmentId));});
 it.each(['assistant_grant','assistant_module','pause'] as const)('refuses current %s revocation before returning any search labels',async kind=>{if(kind==='assistant_grant')await revokeAssistant(group(),{appUserId:ctx.userId!});else if(kind==='assistant_module')await setModule(b.tenantId,'assistant','disabled');else await setAiAllowance(group(),{kind:'user',subjectId:ctx.userId!,enabled:false,dailyRequests:null,monthlyTokens:null});await expect(readOrgModuleActionChoices(ctx,{role:'subordinate',query:'Literal'})).rejects.toThrow();});
 it('does not let an employee login turn Assistant access into Workforce maintenance',async()=>{const own=await hire('Employee only'),userId=await createAppUser(b.tenantId,own.personId,'employee');await grantAssistant(group(),{appUserId:userId});const who={...await entitledCtx(b,['employee']),userId,personId:own.personId,grants:[{role:'employee' as const,companyId:null}]},result=await readOrgModuleActionChoices(who,{role:'subordinate',query:'Literal'});expect(result.items).toHaveLength(0);});
 it('gives a company administrator the group administrator\'s rows for its company under the shared lock, and refuses another company and tenant',async()=>{
  // Reads since 12 November 2026 (shared Access lock): the same rows and refusals as the exclusive reads they replaced.
  const other=await foreign(),manager=await hire('Literal shared manager'),person=await hire('Group HR'),userId=await createAppUser(b.tenantId,person.personId,'hr_admin');await grantAssistant(group(),{appUserId:userId});
  const whole:SessionContext={...await entitledCtx(b),userId,personId:person.personId,grants:[{role:'hr_admin',companyId:null}]};
  const all=await readOrgModuleActionChoices(whole,{role:'subordinate',query:'Literal'}),scoped=await readOrgModuleActionChoices(ctx,{role:'subordinate',query:'Literal'});
  expect(all.items.map(r=>r.employmentId)).toContain(other.employmentId);expect(scoped.items).toEqual(all.items.filter(r=>r.employmentId!==other.employmentId));
  expect(await readOrgModuleActionAvailability(ctx)).toEqual({kind:'available'});
  // A review's labels, as the module server reads them: the same for both, and nothing for another company's subordinate.
  const labels=(who:SessionContext,subordinateEmploymentId:string)=>withAccessDisplayRead(()=>withTenant(who,tx=>reviewedReportingLineLabelsTx(tx,who,{subordinateEmploymentId,managerEmploymentId:manager.employmentId,previousManagerEmploymentId:null})));
  const own=await labels(ctx,employee.employmentId);expect(own.subordinate.employmentId).toBe(employee.employmentId);expect(own).toEqual(await labels(whole,employee.employmentId));
  await expect(labels(ctx,other.employmentId)).rejects.toThrow();
  const fb=await seedBase();await setModule(fb.tenantId,'assistant','active');const fadmin={...adminCtx(fb),grants:[{role:'hr_admin' as const,companyId:null}]};
  const foreignHr=await hireEmployee(fadmin,{person:{fullName:'Literal foreign HR',primaryEmail:randomUUID()+'@fixture.test'},companyId:fb.companyId,departmentId:fb.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
  const foreignUser=await createAppUser(fb.tenantId,foreignHr.personId,'hr_admin');await grantAssistant(fadmin,{appUserId:foreignUser});
  const stranger:SessionContext={...await entitledCtx(fb),userId:foreignUser,personId:foreignHr.personId,grants:[{role:'hr_admin',companyId:null}]};
  const strangerItems=(await readOrgModuleActionChoices(stranger,{role:'subordinate',query:'Literal'})).items.map(r=>r.employmentId);
  for(const id of [employee.employmentId,manager.employmentId,other.employmentId])expect(strangerItems).not.toContain(id);
  await expect(readOrgModuleActionChoices(stranger,{role:'manager',query:'Literal',subordinateEmploymentId:employee.employmentId})).rejects.toThrow();
  await expect(labels(stranger,employee.employmentId)).rejects.toThrow();
 });
});
