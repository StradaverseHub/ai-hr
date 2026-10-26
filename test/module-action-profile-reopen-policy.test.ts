/** Authored UNRUN: pending private proposals require fresh canonical policy/source before disclosure. */
import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {grantAssistant} from '../core/assistant-grant';
import {readOwnProfileWorkspace} from '../core/profile-edit';
import {saveProfileEditPolicy,saveProfileVisibilityPolicy} from '../core/profile-edit-policy';
import {essVisibleFields} from '../lib/personnel-ess-contract';
import {prepareProfileModuleActionReview,reopenProfileModuleActionReview} from '../core/assistant-actions/module-action-review-store';
import {OWN_PROFILE_CHANGE_ACTION,type OwnProfileChangeHumanContent} from '../lib/assistant-actions/own-profile-change-contract';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let base:Base,ctx:SessionContext,subject:{personId:string;employmentId:string},human:OwnProfileChangeHumanContent;
const preferred='profile.personal_details.preferredname',phone='profile.contact_and_permanent_address.phone';
const group=()=>({...adminCtx(base),grants:[{role:'hr_admin' as const,companyId:null}]});
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>vi.unstubAllEnvs());beforeEach(async()=>{
 vi.stubEnv('AI_CONFIG_SECRET','fictional-shared-profile-review-master-123456789');await resetDb();base=await seedBase();await setModule(base.tenantId,'assistant','active');
 subject=await hireEmployee(group(),{person:{fullName:'Fictional Shared ESS Applicant',primaryEmail:randomUUID()+'@example.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});const userId=await createAppUser(base.tenantId,subject.personId,'employee');await grantAssistant(group(),{appUserId:userId});ctx={...await entitledCtx(base,['employee']),userId,personId:subject.personId,grants:[{role:'employee',companyId:null}]};await saveProfileEditPolicy(group(),{keys:[preferred,phone],withdrawnReason:'Fictional shared review policy'});
 const workspace=await readOwnProfileWorkspace(ctx,{employmentId:subject.employmentId});human={action:OWN_PROFILE_CHANGE_ACTION,contractVersion:1,employmentId:subject.employmentId,proposal:{v:2,fields:[{fieldId:preferred,before:workspace.baselines[preferred],value:'PRIVATE human preferred name'}],registers:[]}};
});
const prepare=async(actor=ctx,input:unknown=human)=>(await prepareProfileModuleActionReview(actor,input)).review;

async function state(){return{requests:await owner.db.select().from(schema.profileChangeRequest).where(eq(schema.profileChangeRequest.tenantId,base.tenantId)),events:await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.tenantId,base.tenantId),eq(schema.domainEvent.eventType,'profile-change.requested')))};}
describe('pending ESS custody disclosure follows current canonical policy',()=>{
 it.each(['hide','viewOnly'] as const)('refuses a retained proposal after the selected field becomes %s without effect or private-body loss',async permission=>{
  const review=await prepare();expect((await reopenProfileModuleActionReview(ctx,review.actionId)).kind).toBe('prepared');const fields:Record<string,'hide'|'viewOnly'>=Object.fromEntries(essVisibleFields().map(field=>[field.id,'viewOnly']));fields[preferred]=permission;await saveProfileVisibilityPolicy(group(),{policy:{version:3,fields,primaryOnly:[]},withdrawnReason:'Fictional current field policy closure'});const before=await state();await expect(reopenProfileModuleActionReview(ctx,review.actionId)).rejects.toThrow();expect(await state()).toEqual(before);expect(before.requests).toHaveLength(0);const [stored]=await owner.db.execute<{state:string;bodies:number}>(sql`select state,(select count(*)::int from app.assistant_own_leave_review_content c where c.action_id=r.id) as bodies from app.assistant_own_leave_review r where r.id=${review.actionId}::uuid`);expect(stored).toMatchObject({state:'awaiting_confirmation',bodies:1});
 });
});
