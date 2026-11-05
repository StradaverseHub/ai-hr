/** Real approved configuration fixture; never used by production or as a policy bypass. */
import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {person,appUser,roleAssignment,jobGrade,company} from '../../db/schema';
import type {Db,SessionContext} from '../../db/client';
import {ARCHITECTURE_GRADES,architectureGrade} from '../../packs/job-architecture/model';
import {saveRewardLibrary,submitRewardLibrary,confirmRewardLibrary} from '../../packs/rewards/libraries';
import {proposeRewardPat,confirmRewardPat} from '../../packs/rewards/pat-inputs';
import {prepareCompanyOrganisationRun,companyOrganisationRunReport,decideCompanyOrganisationRun,processCompanyOrganisationRun} from '../../core/company-organisation';
import {withTenant} from '../../db/client';
import {defaultPolicy,type RewardPolicy} from '../../packs/rewards/model';
import {saveRewardSetupPlan,submitRewardSetupPlan,approveRewardSetupPlan,rewardSetupPlan,saveRewardPlanConfiguration} from '../../packs/rewards/plan-configuration';
import {createRewardUnit,type PlannedRewardUnitInput} from '../../packs/rewards/service';
export function approvedRewardFixtures(owner:{db:Db}) {
async function ensureFixtureSetupGrant(ctx:SessionContext,createdBy=ctx.userId){
 if(!ctx.userId||!createdBy)throw new Error('A real fixture setup actor is required.');
 await owner.db.execute(sql`insert into reward_setup_grant(tenant_id,user_id,company_id,role,valid_from,created_by,reason)
  select ${ctx.tenantId}::uuid,${ctx.userId}::uuid,null,'gr','2000-01-01',${createdBy}::uuid,'Explicit fictional setup authority'
  where not exists(select 1 from reward_setup_grant where tenant_id=${ctx.tenantId}::uuid and user_id=${ctx.userId}::uuid and company_id is null and role='gr' and active and valid_from<='2000-01-01' and valid_to is null)`);
}
async function setupChecker(ctx:SessionContext){
 const [maker]=await owner.db.select({personId:appUser.personId}).from(appUser).where(eq(appUser.id,ctx.userId!));
 if(!maker)throw new Error('A real fixture maker account is required.');
 if(!maker.personId){const [p]=await owner.db.insert(person).values({tenantId:ctx.tenantId,fullName:'Fictional Rewards setup maker',primaryEmail:randomUUID()+'@reward-setup.test'}).returning();await owner.db.update(appUser).set({personId:p.id}).where(eq(appUser.id,ctx.userId!));}
const[p]=await owner.db.insert(person).values({tenantId:ctx.tenantId,fullName:'Independent Rewards setup checker',primaryEmail:randomUUID()+'@reward-setup.test'}).returning();const[u]=await owner.db.insert(appUser).values({tenantId:ctx.tenantId,personId:p.id,workosUserId:randomUUID()}).returning();await owner.db.insert(roleAssignment).values({tenantId:ctx.tenantId,appUserId:u.id,role:'hr_admin',companyId:null});const checker={...ctx,userId:u.id,personId:p.id,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]};await ensureFixtureSetupGrant(ctx);await ensureFixtureSetupGrant(checker,ctx.userId);return checker;}
async function setupGrades(ctx:SessionContext){const current=await owner.db.select().from(jobGrade).where(eq(jobGrade.tenantId,ctx.tenantId));const rows=[];for(const grade of ARCHITECTURE_GRADES){let row=current.find(g=>architectureGrade(g.code)===grade&&!g.archivedAt);if(!row)[row]=await owner.db.insert(jobGrade).values({tenantId:ctx.tenantId,code:grade,name:'Setup grade '+grade,rank:grade==='H'?0:Number(grade)}).returning();rows.push({gradeId:row.id,grade});}return rows;}
/** Publish real independently checked company tags before constructing any approved Rewards plan.
 * Tests that deliberately remove Workforce authority call this during their authorized setup phase. */
async function setupCompanyStructureFixture(ctx:SessionContext,targets:{companyId:string;businessUnitId:string}[],effectiveOn:string,checker?:SessionContext){
 const reviewer=checker??await setupChecker(ctx);
 const changes:{companyId:string;businessUnitId:string;parentCompanyId:string|null}[]=[];
 for(const target of targets){
  const [current]=await withTenant(ctx,tx=>tx.execute<{tags:{status:string;businessUnitId:string|null}|null}>(sql`select app.reward_company_structure(${target.companyId}::uuid,${effectiveOn}::date) as tags`));
  if(current?.tags?.status==='ready'){
   if(current.tags.businessUnitId!==target.businessUnitId)throw new Error('A checked fixture company already belongs to another Business unit.');
   continue;
  }
  const [c]=await owner.db.select({parentCompanyId:company.parentCompanyId}).from(company).where(and(eq(company.id,target.companyId),eq(company.tenantId,ctx.tenantId)));
  if(!c)throw new Error('Fixture company is unavailable.');
  changes.push({...target,parentCompanyId:c.parentCompanyId});
 }
 if(!changes.length)return;
 const id=await prepareCompanyOrganisationRun(ctx,{kind:'mapping',companyIds:changes.map(c=>c.companyId),effectiveOn,changes});
 const {run}=await companyOrganisationRunReport(reviewer,id);
 await decideCompanyOrganisationRun(reviewer,{id,digest:run.digest,approve:true,reason:'Independent review of fictional company structure'});
 let result=await processCompanyOrganisationRun(ctx,id);
 for(let step=0;result.state==='staging'&&step<100;step++)result=await processCompanyOrganisationRun(ctx,id);
 if(result.state!=='published')throw new Error('Fixture company structure did not publish: '+result.state+' '+(result.failure??''));
}
/** Record fictional company PAT through independent doer/checker approval. */
async function confirmFixturePat(ctx:SessionContext,companyId:string,year:number,inputs:{targetCents:number|null;forecastCents:number|null;actualCents:number|null;targetMonthsBp:number},checker?:SessionContext){
 const reviewer=checker??await setupChecker(ctx);
 const [prior]=await owner.db.execute<{revision:number}>(sql`select coalesce(max(revision),0)::int as revision from reward_pat_version where tenant_id=${ctx.tenantId}::uuid and company_id=${companyId}::uuid and year=${year}`);
 const id=await proposeRewardPat(ctx,{companyId,year,expectedRevision:prior.revision,inputs,reason:'Independently reviewed fictional company PAT'});
 await confirmRewardPat(reviewer,id);
 return id;
}
/** Valid independent library records shared by plan-admission and review fixtures. */
async function setupRewardLibrariesFixture(ctx:SessionContext,year:number,basePolicy:RewardPolicy=defaultPolicy(year),reviewer?:SessionContext){
 const checker=reviewer??await setupChecker(ctx),grades=await setupGrades(ctx),why='Reviewed fixture configuration';
 const policy:RewardPolicy={...basePolicy,ranges:{...basePolicy.ranges},bonusMatrix:{...basePolicy.bonusMatrix}};
 for(const {grade} of grades){
  if(grade==='23')delete policy.ranges[grade];
  else policy.ranges[grade]??=grade==='12'?[300000,500000,700000]:[100000,500000,1000000];
  policy.bonusMatrix[grade]??=[0,10000,20000,25000,30000];
 }
 const salary=await saveRewardLibrary(ctx,{libraryId:null,versionId:null,expectedLock:0,name:'Fixture Salary '+randomUUID(),year:year,tags:[],groupDefault:false,previousLibraryId:null,data:{kind:'salary',rows:grades.map(g=>{const band=policy.ranges[g.grade]??[100000,500000,1000000];return {...g,minimumCents:g.grade==='23'?null:band[0],midpointCents:g.grade==='23'?null:band[1],maximumCents:g.grade==='23'?null:band[2]};})},reason:why});
 await submitRewardLibrary(ctx,salary,1);await confirmRewardLibrary(checker,salary,2);
 const bonus=await saveRewardLibrary(ctx,{libraryId:null,versionId:null,expectedLock:0,name:'Fixture Bonus '+randomUUID(),year:year,tags:[],groupDefault:false,previousLibraryId:null,data:{kind:'bonus',type:policy.bonusStructure,rows:grades.map(g=>({...g,months:policy.bonusMatrix[g.grade]??[0,10000,20000,25000,30000]})),segments:Object.entries(policy.branchFactors).map(([name,factors])=>({name,factors}))},reason:why});
 await submitRewardLibrary(ctx,bonus,1);await confirmRewardLibrary(checker,bonus,2);
 return {policy,salary,bonus};
}
/** Existing versions are retained exactly; no replacement policy is invented for provenance tests. */
async function createApprovedRewardUnit(ctx:SessionContext,raw:PlannedRewardUnitInput,fixturePolicy?:RewardPolicy,fixtureTargets?:{companyId:string;businessUnitId:string}[]){
 await ensureFixtureSetupGrant(ctx);
 const existing=raw.sharedPolicyVersionId?await rewardSetupPlan(ctx,raw.sharedPolicyVersionId):null;
 if(existing?.setup?.state==='approved')return createRewardUnit(ctx,{...raw,name:existing.setup.cycleName,cycleId:undefined,approvedPlanVersionId:existing.source.versionId});
 const checker=await setupChecker(ctx),why='Reviewed fixture configuration';
 const name=raw.name||'Approved fixture '+randomUUID().slice(0,8);
 const targets=existing?.source.targets??fixtureTargets??[{companyId:raw.companyId,businessUnitId:raw.businessUnitId}];
 await setupCompanyStructureFixture(ctx,targets,raw.snapshotDate,checker);
 const {policy,salary,bonus}=await setupRewardLibrariesFixture(ctx,raw.year,fixturePolicy??existing?.source.policy??defaultPolicy(raw.year),checker);
 const fixturePat=fixturePolicy??defaultPolicy(raw.year);
 for(const target of targets)await confirmFixturePat(ctx,target.companyId,raw.year,{targetCents:fixturePat.patTarget,forecastCents:null,actualCents:fixturePat.patActual,targetMonthsBp:fixturePat.targetMonthsBp},checker);
 const version=existing?.source??await saveRewardPlanConfiguration(ctx,{groupId:null,expectedRevision:0,name,policy,targets});
 const revision=await saveRewardSetupPlan(ctx,{versionId:version.versionId,expectedRevision:existing?.setup?.revision??0,cycleName:name,snapshotDate:raw.snapshotDate,bindings:targets.map(t=>({...t,salaryVersionId:salary,bonusVersionId:bonus,branchAcknowledged:policy.bonusStructure==='branch'})),reason:why});
 await submitRewardSetupPlan(ctx,version.versionId,revision);await approveRewardSetupPlan(checker,version.versionId,revision+1);
 return createRewardUnit(ctx,{...raw,name,cycleId:undefined,approvedPlanVersionId:version.versionId});
}
 return {setupChecker,setupGrades,setupCompanyStructureFixture,confirmFixturePat,setupRewardLibrariesFixture,createApprovedRewardUnit};
}
