/** Actual app-role stale-carrier and same-transaction native projection proof. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {beforeAll,beforeEach,afterAll,afterEach,describe,it,expect,vi} from 'vitest';
import type {SessionContext} from '../db/client';
import * as s from '../db/schema';
import * as native from '../packs/lifecycle/service';
import * as guard from '../core/assistant-actions/agent-action-guard';
import {grantAssistant,revokeAssistant} from '../core/assistant-grant';
import {readOffboardingStepChoices} from '../core/assistant-actions/offboarding-step-completion-source';
import {pgSqlState} from '../lib/db-error';
import {adminCtx,closeAll,createAppUser,harnessSnapshot,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
vi.mock('../packs/lifecycle/service',async original=>{const actual=await original<typeof import('../packs/lifecycle/service')>();return{...actual,offboardingStepChoicesTx:vi.fn(actual.offboardingStepChoicesTx)};});
vi.mock('../core/assistant-actions/agent-action-guard',async original=>{const actual=await original<typeof import('../core/assistant-actions/agent-action-guard')>();return{...actual,withAgentActionGuard:vi.fn(actual.withAgentActionGuard)};});
let b:Base,ctx:SessionContext,caseId:string,number:string,realProjection:typeof native.offboardingStepChoicesTx;
beforeAll(async()=>{await migrateTestDb();realProjection=(await vi.importActual<typeof import('../packs/lifecycle/service')>('../packs/lifecycle/service')).offboardingStepChoicesTx;});afterAll(closeAll);afterEach(()=>vi.restoreAllMocks());
beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'assistant','active');await setModule(b.tenantId,'lifecycle','active');const userId=await createAppUser(b.tenantId,null,'employee');await owner.db.insert(s.lcStaff).values({tenantId:b.tenantId,userId,companyId:b.companyId,level:'agent'});await grantAssistant(adminCtx(b),{appUserId:userId});ctx={tenantId:b.tenantId,userId,personId:null,roles:['employee'],grants:[{role:'employee',companyId:null}],entitlements:harnessSnapshot(b.tenantId)};const c=await native.createOffboardingCase(adminCtx(b),{companyId:b.companyId,fullName:'PRIVATE fictional person',employeeNo:'Q-'+randomUUID().slice(0,8),resignationDate:'2026-10-01',notes:'PRIVATE fictional case notes'});caseId=c.id;number=c.number;vi.mocked(native.offboardingStepChoicesTx).mockImplementation(realProjection).mockClear();vi.mocked(guard.withAgentActionGuard).mockClear();});
describe('offboarding choices authorization interval',()=>{
 it('projects only case identity and actionable steps for a real unlinked lifecycle staff USER',async()=>{
  const result=await readOffboardingStepChoices(ctx,{caseNumber:number});expect(result.kind).toBe('choices');if(result.kind!=='choices')throw Error('expected choices');expect(result.cases).toHaveLength(1);expect(Object.keys(result.cases[0]).sort()).toEqual(['caseId','caseNumber','steps']);expect(result.cases[0]).toMatchObject({caseId,caseNumber:number});expect(result.cases[0].steps.some(step=>step.key==='resign_submit')).toBe(true);expect(JSON.stringify(result)).not.toContain('PRIVATE');expect(result.cases[0].steps.some(step=>step.key==='resign_outcome')).toBe(false);
 });
 it.each(['assistant_grant','role_assignment','person_link','module'] as const)('refuses stale %s before invoking native projection',async change=>{
  if(change==='assistant_grant')await revokeAssistant(adminCtx(b),{appUserId:ctx.userId!});
  else if(change==='role_assignment')await owner.db.delete(s.roleAssignment).where(eq(s.roleAssignment.appUserId,ctx.userId!));
  else if(change==='person_link'){const [person]=await owner.db.insert(s.person).values({tenantId:b.tenantId,fullName:'New fictional link',primaryEmail:randomUUID()+'@fixture.test'}).returning({id:s.person.id});await owner.db.update(s.appUser).set({personId:person.id}).where(eq(s.appUser.id,ctx.userId!));}
  else await setModule(b.tenantId,'lifecycle',null);
  expect(await readOffboardingStepChoices(ctx,{caseNumber:number})).toEqual({kind:'unavailable'});expect(native.offboardingStepChoicesTx).not.toHaveBeenCalled();
 });
 it('uses the SAME guarded Tx/fresh actor and holds Access/case locks across projection, releasing them after return',async()=>{
  vi.mocked(native.offboardingStepChoicesTx).mockImplementation(async(tx,fresh,selected)=>{
   expect(tx).toBe(vi.mocked(guard.withAgentActionGuard).mock.calls.at(-1)![0]);expect(fresh).not.toBe(ctx);expect(fresh.userId).toBe(ctx.userId);
   const [access]=await owner.db.execute<{locked:boolean}>(sql`select pg_try_advisory_xact_lock(hashtextextended(${'access-configuration:'+b.tenantId},0)) locked`);expect(access.locked).toBe(false);
   const result=await realProjection(tx,fresh,selected);let error:unknown;try{await owner.db.transaction(other=>other.select({id:s.lcCase.id}).from(s.lcCase).where(eq(s.lcCase.id,caseId)).for('update',{noWait:true}));}catch(cause){error=cause;}expect(pgSqlState(error)).toBe('55P03');let staffError:unknown;try{await owner.db.transaction(other=>other.execute(sql`lock table lc_staff in row exclusive mode nowait`));}catch(cause){staffError=cause;}expect(pgSqlState(staffError)).toBe('55P03');return result;
  });
  expect((await readOffboardingStepChoices(ctx,{caseNumber:number})).kind).toBe('choices');const [released]=await owner.db.execute<{locked:boolean}>(sql`select pg_try_advisory_xact_lock(hashtextextended(${'access-configuration:'+b.tenantId},0)) locked`);expect(released.locked).toBe(true);
  expect(await owner.db.transaction(other=>other.select({id:s.lcCase.id}).from(s.lcCase).where(eq(s.lcCase.id,caseId)).for('update',{noWait:true}))).toHaveLength(1);
 });
 it('refuses another company and completed cases through the native owner',async()=>{
  const [company]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'PRIVATE other company',companyLabel:'OC'}).returning({id:s.company.id});const c=await native.createOffboardingCase(adminCtx(b),{companyId:company.id,fullName:'PRIVATE foreign person',employeeNo:'OTHER',resignationDate:'2026-10-01'});expect(await readOffboardingStepChoices(ctx,{caseNumber:c.number})).toEqual({kind:'unavailable'});
  await owner.db.update(s.lcCase).set({status:'completed',completedAt:new Date()}).where(eq(s.lcCase.id,caseId));expect(await readOffboardingStepChoices(ctx,{caseNumber:number})).toEqual({kind:'unavailable'});
 });
});
