/** Authored UNRUN real canonical own-choice/RLS cases. HTTP session/provider seams are unused. */
import {randomUUID} from 'node:crypto';
import {beforeAll,beforeEach,afterAll,it,expect,vi} from 'vitest';
import type {SessionContext,Grant} from '../db/client';
import {sql} from 'drizzle-orm';
vi.mock('server-only',()=>({}));
vi.mock('../lib/real-auth',()=>({appOrigin:()=>undefined}));
vi.mock('../core/assistant-actions/own-leave-server',()=>({authenticateOwnLeaveBrowserSession:vi.fn(()=>{throw Error('HTTP auth not used by this source test.');})}));
vi.mock('../lib/identity/provider',()=>({currentProviderSession:vi.fn(async()=>null)}));
import {readNotificationModuleActionChoices} from '../core/assistant-actions/module-action-server';
import {hireEmployee} from '../core/org';
import {grantAssistant,revokeAssistant} from '../core/assistant-grant';
import {setAiFeature} from '../core/ai-management';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let base:Base;
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();base=await seedBase();await setModule(base.tenantId,'assistant','active');await setModule(base.tenantId,'notifications','active');});afterAll(closeAll);
async function fixture(role:'employee'|'hr_admin'='employee'){
 const original=adminCtx(base),[principal]=await owner.db.execute<{grants:Grant[]}>(sql`select grants from app.principal(${base.adminUserId}::uuid) where tenant_id=${base.tenantId}::uuid`);
 const admin:SessionContext={...original,grants:principal.grants},hire=async(name:string)=>hireEmployee(admin,{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const mine=await hire('Fictional Own Notification Selector'),other=await hire('Fictional Other Notification Subject'),userId=await createAppUser(base.tenantId,mine.personId,role);await grantAssistant(admin,{appUserId:userId});
 const ctx:SessionContext={...await entitledCtx(base,[role]),userId,personId:mine.personId,roles:[role],grants:[{role,companyId:null}]};return{admin,mine,other,ctx,userId};
}
it.each(['employee','hr_admin'] as const)('returns only explicit own salary-free choices even with %s visibility',async role=>{
 const f=await fixture(role),result=await readNotificationModuleActionChoices(f.ctx);expect(result.kind).toBe('choices');if(result.kind!=='choices')throw Error('Expected actual own choices.');
 expect(result.employments).toHaveLength(1);expect(result.employments[0].employmentId).toBe(f.mine.employmentId);expect(Object.keys(result.employments[0]).sort()).toEqual(['companyName','employeeCode','employmentId']);expect(JSON.stringify(result)).not.toContain(f.other.employmentId);expect(JSON.stringify(result)).not.toContain('Fictional Own Notification Selector');
});
it('refuses a forged same-tenant person snapshot instead of returning another employee choices',async()=>{const f=await fixture();expect(await readNotificationModuleActionChoices({...f.ctx,personId:f.other.personId})).toEqual({kind:'unavailable'});});
it('refreshes actual Assistant grant and Notifications entitlement rather than trusting the captured page snapshot',async()=>{
 const f=await fixture();expect((await readNotificationModuleActionChoices(f.ctx)).kind).toBe('choices');await revokeAssistant(f.admin,{appUserId:f.userId});expect(await readNotificationModuleActionChoices(f.ctx)).toEqual({kind:'unavailable'});await grantAssistant(f.admin,{appUserId:f.userId});await setModule(base.tenantId,'notifications','disabled');expect(await readNotificationModuleActionChoices(f.ctx)).toEqual({kind:'unavailable'});
});
it('checks the nonadmitting Assistant pause before returning any subject metadata',async()=>{const f=await fixture();await setAiFeature(f.admin,'hr_assistant',false);expect(await readNotificationModuleActionChoices(f.ctx)).toEqual({kind:'unavailable'});});
