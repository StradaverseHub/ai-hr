/** Authored UNRUN: fresh actual publisher admission before private form availability, no article read/write. */
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
vi.mock('server-only',()=>({}));
import * as s from '../db/schema';
import {readKnowledgeModuleActionAvailability} from '../core/assistant-actions/module-action-server';
import {grantAssistant,revokeAssistant} from '../core/assistant-grant';
import {setAiAllowance} from '../core/ai-management';
import {hireEmployee} from '../core/org';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'assistant','active');await grantAssistant(adminCtx(b),{appUserId:b.adminUserId});});
async function state(){return{articles:await owner.db.select().from(s.kbDocument).where(eq(s.kbDocument.tenantId,b.tenantId)).orderBy(s.kbDocument.id),events:await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.tenantId,b.tenantId)).orderBy(s.domainEvent.id)};}
describe('article publisher form availability',()=>{
 it('admits a real standalone admin with no person/employment and returns only actual audience choices without publishing',async()=>{const before=await state(),who=adminCtx(b);expect(who.personId??null).toBeNull();expect(await readKnowledgeModuleActionAvailability(who)).toEqual({kind:'available',audiences:['all','employee','manager','hr_admin']});expect(await state()).toEqual(before);});
 it.each(['assistant_grant','assistant_module','pause'] as const)('withholds the private form after fresh %s revocation without changing any record',async kind=>{const ctx=adminCtx(b);if(kind==='assistant_grant')await revokeAssistant(ctx,{appUserId:b.adminUserId});else if(kind==='assistant_module')await setModule(b.tenantId,'assistant','disabled');else await setAiAllowance({...ctx,grants:[{role:'hr_admin',companyId:null}]},{kind:'user',subjectId:b.adminUserId,enabled:false,dailyRequests:null,monthlyTokens:null});const before=await state();expect(await readKnowledgeModuleActionAvailability(ctx)).toEqual({kind:'unavailable'});expect(await state()).toEqual(before);});
 it('withholds publisher availability after actual author-role revocation while the core module remains on',async()=>{const current=adminCtx(b);await owner.db.update(s.roleAssignment).set({role:'employee'}).where(eq(s.roleAssignment.appUserId,b.adminUserId));const narrowed={...current,roles:['employee'],grants:[{role:'employee' as const,companyId:null}]},before=await state();expect(await readKnowledgeModuleActionAvailability(narrowed)).toEqual({kind:'unavailable'});expect(await state()).toEqual(before);});
 it('does not turn an employee Assistant grant or forged role carrier into publisher authority',async()=>{const ctx=adminCtx(b),employee=await hireEmployee(ctx,{person:{fullName:'Fictional reader',primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()}),userId=await createAppUser(b.tenantId,employee.personId,'employee');await grantAssistant(ctx,{appUserId:userId});const who={...ctx,userId,personId:employee.personId,roles:['employee'],grants:[{role:'employee' as const,companyId:null}]},before=await state();expect(await readKnowledgeModuleActionAvailability(who)).toEqual({kind:'unavailable'});expect(await readKnowledgeModuleActionAvailability({...who,roles:['hr_admin']})).toEqual({kind:'unavailable'});expect(await state()).toEqual(before);});
});
