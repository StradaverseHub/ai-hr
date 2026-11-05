/** Real approved configuration fixture; never used by production or as a policy bypass. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {owner} from './harness';
import {person,appUser,roleAssignment,jobGrade} from '../db/schema';
import type {SessionContext} from '../db/client';
import {ARCHITECTURE_GRADES,architectureGrade} from '../packs/job-architecture/model';
import {saveRewardLibrary,submitRewardLibrary,confirmRewardLibrary} from '../packs/rewards/libraries';
import {proposeRewardPat,confirmRewardPat} from '../packs/rewards/pat-inputs';
import {saveRewardPolicyGroup} from '../packs/rewards/policy-groups';
import {defaultPolicy,type RewardPolicy} from '../packs/rewards/model';
import {saveRewardSetupPlan,submitRewardSetupPlan,approveRewardSetupPlan,rewardSetupPlan} from '../packs/rewards/plan-configuration';
import {createRewardUnit,type PlannedRewardUnitInput} from '../packs/rewards/service';
export async function setupChecker(ctx:SessionContext){
 const [maker]=await owner.db.select({personId:appUser.personId}).from(appUser).where(eq(appUser.id,ctx.userId!));
 if(!maker)throw new Error('A real fixture maker account is required.');
 if(!maker.personId){const [p]=await owner.db.insert(person).values({tenantId:ctx.tenantId,fullName:'Fictional Rewards setup maker',primaryEmail:randomUUID()+'@reward-setup.test'}).returning();await owner.db.update(appUser).set({personId:p.id}).where(eq(appUser.id,ctx.userId!));}
const[p]=await owner.db.insert(person).values({tenantId:ctx.tenantId,fullName:'Independent Rewards setup checker',primaryEmail:randomUUID()+'@reward-setup.test'}).returning();const[u]=await owner.db.insert(appUser).values({tenantId:ctx.tenantId,personId:p.id,workosUserId:randomUUID()}).returning();await owner.db.insert(roleAssignment).values({tenantId:ctx.tenantId,appUserId:u.id,role:'hr_admin',companyId:null});const checker={...ctx,userId:u.id,personId:p.id,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]};for(const who of [ctx,checker])await owner.db.execute(sql`insert into reward_setup_grant(tenant_id,user_id,company_id,role,valid_from,created_by,reason) values(${ctx.tenantId}::uuid,${who.userId}::uuid,null,'gr','2000-01-01',${ctx.userId}::uuid,'Explicit test setup authority')`);return checker;}
export async function setupGrades(ctx:SessionContext){const current=await owner.db.select().from(jobGrade).where(eq(jobGrade.tenantId,ctx.tenantId));const rows=[];for(const grade of ARCHITECTURE_GRADES){let row=current.find(g=>architectureGrade(g.code)===grade&&!g.archivedAt);if(!row)[row]=await owner.db.insert(jobGrade).values({tenantId:ctx.tenantId,code:grade,name:'Setup grade '+grade,rank:grade==='H'?0:Number(grade)}).returning();rows.push({gradeId:row.id,grade});}return rows;}
/** Record fictional company PAT through independent doer/checker approval. */
export async function confirmFixturePat(ctx:SessionContext,companyId:string,year:number,inputs:{targetCents:number|null;forecastCents:number|null;actualCents:number|null;targetMonthsBp:number},checker?:SessionContext){
 const reviewer=checker??await setupChecker(ctx);
 const [prior]=await owner.db.execute<{revision:number}>(sql`select coalesce(max(revision),0)::int as revision from reward_pat_version where tenant_id=${ctx.tenantId}::uuid and company_id=${companyId}::uuid and year=${year}`);
 const id=await proposeRewardPat(ctx,{companyId,year,expectedRevision:prior.revision,inputs,reason:'Independently reviewed fictional company PAT'});
 await confirmRewardPat(reviewer,id);
 return id;
}
/** Existing versions are retained exactly; no replacement policy is invented for provenance tests. */
export async function createApprovedRewardUnit(ctx:SessionContext,raw:PlannedRewardUnitInput,fixturePolicy?:RewardPolicy,fixtureTargets?:{companyId:string;businessUnitId:string}[]){
 const existing=raw.sharedPolicyVersionId?await rewardSetupPlan(ctx,raw.sharedPolicyVersionId):null;
 if(existing?.setup?.state==='approved')return createRewardUnit(ctx,{...raw,name:existing.setup.cycleName,cycleId:undefined,approvedPlanVersionId:existing.source.versionId});
 const checker=await setupChecker(ctx),grades=await setupGrades(ctx),why='Reviewed fixture configuration';
 const policy=fixturePolicy??existing?.source.policy??defaultPolicy(raw.year);
 const name=raw.name||'Approved fixture '+randomUUID().slice(0,8);
 const targets=existing?.source.targets??fixtureTargets??[{companyId:raw.companyId,businessUnitId:raw.businessUnitId}];
 const salary=await saveRewardLibrary(ctx,{libraryId:null,versionId:null,expectedLock:0,name:'Fixture Salary '+randomUUID(),year:raw.year,tags:[],groupDefault:false,previousLibraryId:null,data:{kind:'salary',rows:grades.map(g=>{const band=policy.ranges[g.grade]??[100000,300000,1000000];return {...g,minimumCents:g.grade==='23'?null:band[0],midpointCents:g.grade==='23'?null:band[1],maximumCents:g.grade==='23'?null:band[2]};})},reason:why});
 await submitRewardLibrary(ctx,salary,1);await confirmRewardLibrary(checker,salary,2);
 const bonus=await saveRewardLibrary(ctx,{libraryId:null,versionId:null,expectedLock:0,name:'Fixture Bonus '+randomUUID(),year:raw.year,tags:[],groupDefault:false,previousLibraryId:null,data:{kind:'bonus',type:policy.bonusStructure,rows:grades.map(g=>({...g,months:policy.bonusMatrix[g.grade]??[0,10000,20000,25000,30000]})),segments:Object.entries(policy.branchFactors).map(([name,factors])=>({name,factors}))},reason:why});
 await submitRewardLibrary(ctx,bonus,1);await confirmRewardLibrary(checker,bonus,2);
 for(const target of targets)await confirmFixturePat(ctx,target.companyId,raw.year,{targetCents:policy.patTarget,forecastCents:null,actualCents:policy.patActual,targetMonthsBp:policy.targetMonthsBp},checker);
 const version=existing?.source??await saveRewardPolicyGroup(ctx,{groupId:null,expectedRevision:0,name,policy,targets});
 const revision=await saveRewardSetupPlan(ctx,{versionId:version.versionId,expectedRevision:existing?.setup?.revision??0,cycleName:name,snapshotDate:raw.snapshotDate,bindings:targets.map(t=>({...t,salaryVersionId:salary,bonusVersionId:bonus,branchAcknowledged:policy.bonusStructure==='branch'})),reason:why});
 await submitRewardSetupPlan(ctx,version.versionId,revision);await approveRewardSetupPlan(checker,version.versionId,revision+1);
 return createRewardUnit(ctx,{...raw,name,cycleId:undefined,approvedPlanVersionId:version.versionId});
}
