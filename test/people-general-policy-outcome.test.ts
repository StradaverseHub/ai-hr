/** Closed canonical outcome/privacy integration; fictional fixtures, hosted only. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeEach,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import {peopleGeneralPolicyReviews as reviews} from '../core/assistant-actions/people-general-policy-review-store';
import {readCompletedNativeOutcomeTx} from '../core/assistant-actions/completed-outcome-readers';
import {getPeopleGeneral,savePeopleGeneral} from '../core/people-general';
import {grantAssistant} from '../core/assistant-grant';
import {hireEmployee} from '../core/org';
import {erasePersonPii} from '../core/pdpa';
import {adminCtx,owner,resetDb,seedBase,setModule,createAppUser,closeAll,type Base} from './harness';
let b:Base,ctx:SessionContext;
const action='org.people_general.change' as const,off={allowDuplicatedNric:false,allowDuplicatedEmail:false},on={allowDuplicatedNric:true,allowDuplicatedEmail:true};
async function recorded(who=ctx){const r=(await reviews.prepare(who,{action,contractVersion:1,expected:off,desired:on})).review,done=await reviews.confirm(who,{action,contractVersion:1,actionId:r.actionId,reviewedDigest:r.reviewedDigest});if(done.kind!=='completed')throw Error('Missing native policy receipt');return{reference:{source:'review' as const,action,actionId:r.actionId},eventId:done.receipt.receipt.eventId};}
const read=(reference:unknown,who=ctx)=>withTenant(who,tx=>readCompletedNativeOutcomeTx(tx,who,reference));
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-policy-outcome-key');await resetDb();b=await seedBase();await setModule(b.tenantId,'assistant','active');ctx={...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]};await grantAssistant(ctx,{appUserId:b.adminUserId});});afterEach(()=>vi.unstubAllEnvs());afterAll(closeAll);
it('verifies a real unlinked USER native policy event through the closed canonical outcome reader',async()=>{expect(ctx.personId).toBeUndefined();const r=await recorded();expect((await read(r.reference)).evidence).toEqual({action,sourceId:r.reference.actionId,eventId:r.eventId,currentStatus:null});await owner.db.execute(sql`update people_general_policy set admission_version=admission_version+1 where tenant_id=${b.tenantId}::uuid`);expect((await read(r.reference)).evidence.eventId).toBe(r.eventId);await savePeopleGeneral(ctx,{...off,revision:(await getPeopleGeneral(ctx)).revision});await expect(read(r.reference)).rejects.toThrow();});
it('refuses another login and wrong registered action without adopting the review',async()=>{const r=await recorded(),userId=await createAppUser(b.tenantId,null,'hr_admin');await grantAssistant(ctx,{appUserId:userId});await expect(read(r.reference,{...ctx,userId})).rejects.toThrow();await expect(read({...r.reference,action:'org.employee_id_template.status'})).rejects.toThrow();expect((await read(r.reference)).evidence.eventId).toBe(r.eventId);});
it('captures the actual actor PERSON for canonical erasure without inventing a policy employment target',async()=>{const e=await hireEmployee(ctx,{companyId:b.companyId,departmentId:b.deptA,person:{fullName:'Fictional Policy Outcome Author',primaryEmail:randomUUID()+'@fixture.test'},employmentType:'full_time',hiredOn:'2025-01-01'}),userId=await createAppUser(b.tenantId,e.personId,'hr_admin');await grantAssistant(ctx,{appUserId:userId});const author={...ctx,userId,personId:e.personId},r=await recorded(author);expect((await read(r.reference,author)).evidence.eventId).toBe(r.eventId);await erasePersonPii(ctx,{subjectEmploymentId:e.employmentId,scope:'contact',reason:'Fictional policy outcome privacy request',requestRef:'FIC-POLICY-OUTCOME-ERASURE'});await expect(read(r.reference,author)).rejects.toThrow();});
