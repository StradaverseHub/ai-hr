/** Test fixtures use the same two-person request owner as the screen. No production bypass exists. */
import {randomUUID} from 'node:crypto';
import {and,eq} from 'drizzle-orm';
import type {SessionContext} from '../db/client';
import * as s from '../db/schema';
import {todayInKualaLumpur} from '../lib/hr-date';
import {previewRewardAccessChange as nativePreview,previewRewardAccessBatch as nativeBatchPreview,saveRewardAccessChange as nativeSave,saveRewardAccessBatch as nativeBatchSave,setRewardMember as nativeSet,decideRewardAccessRequest,type RewardAccessChange} from '../packs/rewards/service';
import {owner,createAppUser} from './harness';
/** Existing fictional CEO logins now need real People scope. Do not rewrite an existing employment. */
async function fixturePeople(ctx:SessionContext,change:RewardAccessChange){
 if(change.after?.role!=='bu')return;
 const [user]=await owner.db.select().from(s.appUser).where(and(eq(s.appUser.id,change.after.userId),eq(s.appUser.tenantId,ctx.tenantId)));
 const [unit]=await owner.db.select().from(s.rewardUnit).where(and(eq(s.rewardUnit.id,change.unitId),eq(s.rewardUnit.tenantId,ctx.tenantId)));
 if(!user?.personId||!unit)return;
 const exists=await owner.db.select({id:s.employment.id}).from(s.employment).where(and(eq(s.employment.personId,user.personId),eq(s.employment.tenantId,ctx.tenantId)));
 if(exists.length)return;
 const [dept]=await owner.db.select().from(s.department).where(and(eq(s.department.companyId,unit.companyId),eq(s.department.tenantId,ctx.tenantId))).limit(1);
 if(!dept)return;
 const [employment]=await owner.db.insert(s.employment).values({tenantId:ctx.tenantId,personId:user.personId,companyId:unit.companyId,hiredOn:todayInKualaLumpur(),employeeCode:'REVIEWER-'+randomUUID().slice(0,8)}).returning();
 await owner.db.insert(s.assignment).values({tenantId:ctx.tenantId,employmentId:employment.id,departmentId:dept.id,businessUnitId:unit.businessUnitId,companyId:unit.companyId,employmentType:'full_time',validFrom:todayInKualaLumpur()});
}
async function independentChecker(ctx:SessionContext,changes:RewardAccessChange[]){
 const excluded=new Set([ctx.userId,...changes.flatMap(c=>[c.before?.userId,c.after?.userId])]);
 const [person]=await owner.db.insert(s.person).values({tenantId:ctx.tenantId,fullName:'Independent fictional access checker',primaryEmail:randomUUID()+'@fixture.test'}).returning();
 const userId=await createAppUser(ctx.tenantId,person.id,'hr_admin');
 if(excluded.has(userId))throw Error('Fixture checker must be independent');
 return {...ctx,userId,personId:person.id,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]} satisfies SessionContext;
}
export async function previewRewardAccessChange(ctx:SessionContext,raw:unknown){
 await fixturePeople(ctx,raw as RewardAccessChange);return nativePreview(ctx,raw);
}
export async function previewRewardAccessBatch(ctx:SessionContext,raw:unknown){
 for(const change of (raw as {changes:RewardAccessChange[]}).changes)await fixturePeople(ctx,change);
 return nativeBatchPreview(ctx,raw);
}
export async function saveRewardAccessChange(...args:Parameters<typeof nativeSave>){
 const result=await nativeSave(...args),checker=await independentChecker(args[0],[args[1] as RewardAccessChange]);
 const decision=await decideRewardAccessRequest(checker,result.requestId,true);
 if(decision.status!=='approved')throw Error('Access fixture approval lapsed');
 return result;
}
export async function saveRewardAccessBatch(...args:Parameters<typeof nativeBatchSave>){
 const result=await nativeBatchSave(...args);
 if(result.requestId){const checker=await independentChecker(args[0],(args[1] as {changes:RewardAccessChange[]}).changes);const decision=await decideRewardAccessRequest(checker,result.requestId,true);if(decision.status!=='approved')throw Error('Access fixture approval lapsed');}
 return result;
}
export async function setRewardMember(...args:Parameters<typeof nativeSet>){
 const [ctx,unitId,revision,userId,role,remove]=args;
 const change={unitId,revision,before:remove?{userId,role}:null,after:remove?null:{userId,role}};
 await fixturePeople(ctx,change);
 const result=await nativeSet(...args),checker=await independentChecker(ctx,[change]);
 const decision=await decideRewardAccessRequest(checker,result.requestId,true);if(decision.status!=='approved')throw Error('Access fixture approval lapsed');
 return result;
}
