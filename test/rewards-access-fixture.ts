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
 // Use the tenant-bound owner transaction so the real assignment guard derives the published BU.
 await owner.withTenant(ctx,async tx=>{
  const [employment]=await tx.insert(s.employment).values({tenantId:ctx.tenantId,personId:user.personId!,companyId:unit.companyId,hiredOn:todayInKualaLumpur(),employeeCode:'REVIEWER-'+randomUUID().slice(0,8)}).returning();
  await tx.insert(s.assignment).values({tenantId:ctx.tenantId,employmentId:employment.id,departmentId:dept.id,businessUnitId:unit.businessUnitId,companyId:unit.companyId,employmentType:'full_time',validFrom:todayInKualaLumpur()});
 });
}
async function independentChecker(ctx:SessionContext,changes:RewardAccessChange[]){
 const excluded=new Set([ctx.userId,...changes.flatMap(c=>[c.before?.userId,c.after?.userId])]);
 const members=await owner.db.select().from(s.rewardMember).where(eq(s.rewardMember.unitId,changes[0].unitId));
 const gr=members.find(m=>m.role==='gr'&&!excluded.has(m.userId));
 if(!gr)throw Error('Fixture needs an existing independent Group Rewards holder');
 const [user]=await owner.db.select().from(s.appUser).where(eq(s.appUser.id,gr.userId));
 return {...ctx,userId:user.id,personId:user.personId??undefined,roles:['employee'],grants:[{role:'employee',companyId:null}]} satisfies SessionContext;
}
export async function previewRewardAccessChange(ctx:SessionContext,raw:unknown){
 await fixturePeople(ctx,raw as RewardAccessChange);const {pending:_,...preview}=await nativePreview(ctx,{...(raw as object),reason:'Fictional access fixture change'});return preview;
}
export async function previewRewardAccessBatch(ctx:SessionContext,raw:unknown){
 for(const change of (raw as {changes:RewardAccessChange[]}).changes)await fixturePeople(ctx,change);
 return nativeBatchPreview(ctx,{...(raw as object),reason:'Fictional access fixture change'});
}
export async function saveRewardAccessChange(...args:Parameters<typeof nativeSave>){
 const result=await nativeSave(args[0],{...(args[1] as object),reason:'Fictional access fixture change'},args[2]);
 if(!result.pending)return result;
 const checker=await independentChecker(args[0],[args[1] as RewardAccessChange]);
 const decision=await decideRewardAccessRequest(checker,result.requestId,true);
 if(decision.status!=='approved')throw Error('Access fixture approval lapsed');
 return result;
}
export async function saveRewardAccessBatch(...args:Parameters<typeof nativeBatchSave>){
 const result=await nativeBatchSave(args[0],{...(args[1] as object),reason:'Fictional access fixture change'},args[2]);
 if(result.requestId&&result.pending){const checker=await independentChecker(args[0],(args[1] as {changes:RewardAccessChange[]}).changes);const decision=await decideRewardAccessRequest(checker,result.requestId,true);if(decision.status!=='approved')throw Error('Access fixture approval lapsed');}
 return result;
}
export async function setRewardMember(...args:Parameters<typeof nativeSet>){
 const [ctx,unitId,revision,userId,role,remove]=args;
 const change={unitId,revision,before:remove?{userId,role}:null,after:remove?null:{userId,role}};
 await fixturePeople(ctx,change);
 const existing=await owner.db.select().from(s.rewardMember).where(and(eq(s.rewardMember.unitId,unitId),eq(s.rewardMember.userId,userId),eq(s.rewardMember.role,role)));
 if(!remove&&existing.length)return {requestId:'',pending:false,status:'applied_no_second_approval'};
 const result=await nativeSet(...args);if(!result.pending)return result;
 const checker=await independentChecker(ctx,[change]);
 const decision=await decideRewardAccessRequest(checker,result.requestId,true);if(decision.status!=='approved')throw Error('Access fixture approval lapsed');
 return result;
}
