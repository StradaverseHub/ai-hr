/** Real approved configuration fixture; never used by production or as a policy bypass. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {owner} from './harness';
import {person,appUser,roleAssignment,jobGrade} from '../db/schema';
import type {SessionContext} from '../db/client';
import {ARCHITECTURE_GRADES,architectureGrade} from '../packs/job-architecture/model';
import {todayInKualaLumpur} from '../lib/hr-date';
import {saveRewardLibrary,submitRewardLibrary,confirmRewardLibrary,rewardLibraries} from '../packs/rewards/libraries';
import {proposeRewardPat,confirmRewardPat} from '../packs/rewards/pat-inputs';
import {saveRewardPolicyGroup} from '../packs/rewards/policy-groups';
import {defaultPolicy} from '../packs/rewards/model';
import {saveRewardSetupPlan,submitRewardSetupPlan,approveRewardSetupPlan} from '../packs/rewards/plan-configuration';
import {createRewardUnit,type PlannedRewardUnitInput} from '../packs/rewards/service';
export async function setupChecker(ctx:SessionContext){const[p]=await owner.db.insert(person).values({tenantId:ctx.tenantId,fullName:'Independent Rewards setup checker',primaryEmail:randomUUID()+'@reward-setup.test'}).returning();const[u]=await owner.db.insert(appUser).values({tenantId:ctx.tenantId,personId:p.id,workosUserId:randomUUID()}).returning();await owner.db.insert(roleAssignment).values({tenantId:ctx.tenantId,appUserId:u.id,role:'hr_admin',companyId:null});const checker={...ctx,userId:u.id,personId:p.id,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]};for(const who of [ctx,checker])await owner.db.execute(sql`insert into reward_setup_grant(tenant_id,user_id,company_id,role,valid_from,created_by,reason) values(${ctx.tenantId}::uuid,${who.userId}::uuid,null,'gr','2000-01-01',${ctx.userId}::uuid,'Explicit test setup authority')`);return checker;}
export async function setupGrades(ctx:SessionContext){const current=await owner.db.select().from(jobGrade).where(eq(jobGrade.tenantId,ctx.tenantId));const rows=[];for(const grade of ARCHITECTURE_GRADES){let row=current.find(g=>architectureGrade(g.code)===grade&&!g.archivedAt);if(!row)[row]=await owner.db.insert(jobGrade).values({tenantId:ctx.tenantId,code:grade,name:'Setup grade '+grade,rank:grade==='H'?0:Number(grade)}).returning();rows.push({gradeId:row.id,grade});}return rows;}
export async function createApprovedRewardUnit(ctx:SessionContext,raw:PlannedRewardUnitInput){
 const checker=await setupChecker(ctx),grades=await setupGrades(ctx),name=raw.name||'Approved fixture '+randomUUID().slice(0,8),why='Reviewed fixture configuration';
 const salary=await saveRewardLibrary(ctx,{libraryId:null,versionId:null,expectedLock:0,name:'Fixture Salary '+randomUUID(),year:raw.year,tags:[],groupDefault:false,previousLibraryId:null,data:{kind:'salary',rows:grades.map(g=>({...g,minimumCents:g.grade==='23'?null:100000,midpointCents:g.grade==='23'?null:300000,maximumCents:g.grade==='23'?null:1000000}))},reason:why});await submitRewardLibrary(ctx,salary,1);await confirmRewardLibrary(checker,salary,2);
 const bonus=await saveRewardLibrary(ctx,{libraryId:null,versionId:null,expectedLock:0,name:'Fixture Bonus '+randomUUID(),year:raw.year,tags:[],groupDefault:false,previousLibraryId:null,data:{kind:'bonus',type:'standard',rows:grades.map(g=>({...g,months:[0,10000,20000,25000,30000]})),segments:[]},reason:why});await submitRewardLibrary(ctx,bonus,1);await confirmRewardLibrary(checker,bonus,2);
 const pats=await owner.db.execute<{revision:number}>(sql`select coalesce(max(revision),0)::int as revision from reward_pat_version where tenant_id=${ctx.tenantId}::uuid and company_id=${raw.companyId}::uuid and year=${raw.year}`);const pat=await proposeRewardPat(ctx,{companyId:raw.companyId,year:raw.year,expectedRevision:pats[0].revision,inputs:{targetCents:1000000,forecastCents:null,actualCents:1000000,targetMonthsBp:20000},reason:why});await confirmRewardPat(checker,pat);
 const version=await saveRewardPolicyGroup(ctx,{groupId:null,expectedRevision:0,name,policy:defaultPolicy(raw.year),targets:[{companyId:raw.companyId,businessUnitId:raw.businessUnitId}]});
 const revision=await saveRewardSetupPlan(ctx,{versionId:version.versionId,expectedRevision:0,cycleName:name,snapshotDate:raw.snapshotDate,bindings:[{companyId:raw.companyId,businessUnitId:raw.businessUnitId,salaryVersionId:salary,bonusVersionId:bonus,branchAcknowledged:false}],reason:why});await submitRewardSetupPlan(ctx,version.versionId,revision);await approveRewardSetupPlan(checker,version.versionId,revision+1);
 return createRewardUnit(ctx,{...raw,name,cycleId:undefined,approvedPlanVersionId:version.versionId});
}
