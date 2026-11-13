/** Board fc804e8c: Limit Controls on a real database with fictional data. Group Rewards saves a reward year's limits
 * directly with a reason (board 60f1fdcd: no second person), CTRO and EC view, every other role is refused and cannot
 * read a value, the review calculation uses the confirmed version, a submitted review keeps its version until Group
 * Rewards explicitly re-applies a newer one, and financial invariants cannot be stored. */
import {createApprovedRewardUnit} from './rewards-setup-fixture';
import {sql,and,eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {migrateRewardMembershipFixture} from './rewards-shared-policy-fixture';
import {configureRewardFixture,refreshRewardFixtureBudget} from './rewards-governance-fixture';
import {setRewardMember} from './rewards-access-fixture';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {getRewardUnit,saveRewardEntry,decideRewardUnit,getRewardConfiguration,saveRewardPolicy} from '../packs/rewards/service';
import {saveRewardAdvisorSettings} from '../packs/rewards/advisor';
import {rewardRulesForReview} from '../packs/rewards/applied-rules';
import {emptyFacts,type RewardRole} from '../packs/rewards/model';
import {
 baselineRewardLimitValues,previewRewardLimitReapply,previewRewardLimitSave,reapplyRewardLimits,rewardConfigurableLimitKeys,rewardLimitControls,rewardLimitControlsAccessTx,
 rewardLimitsForUnitTx,saveRewardLimits,type RewardLimitValues,
} from '../packs/rewards/limit-controls';
import {closeAll,createAppUser,entitledCtx,owner,resetDb,seedBase,setModule,type Base} from './harness';
import {todayInKualaLumpur} from '../lib/hr-date';

beforeAll(migrateRewardMembershipFixture);afterAll(closeAll);
const today=todayInKualaLumpur(),year=Number(today.slice(0,4));
const values=(change:(v:RewardLimitValues)=>void=()=>{})=>{const v=baselineRewardLimitValues();change(v);return Object.fromEntries(rewardConfigurableLimitKeys.map(key=>[key,v[key]]));};
const reason='Fictional Group Rewards limit decision for this year';

describe('Rewards Limit Controls',()=>{
 let b:Base,admin:SessionContext,unitId:string;
 const actors:Partial<Record<RewardRole,SessionContext>>={};
 const view=()=>getRewardUnit(admin,unitId);
 beforeEach(async()=>{
  await resetDb();b=await seedBase();await setModule(b.tenantId,'rewards','active');admin=await entitledCtx(b);
  const [adminPerson]=await owner.db.insert(schema.person).values({tenantId:b.tenantId,fullName:'Fictional Group Rewards editor',primaryEmail:'editor@limit-controls.test'}).returning();
  await owner.db.update(schema.appUser).set({personId:adminPerson.id}).where(eq(schema.appUser.id,admin.userId!));admin={...admin,personId:adminPerson.id};
  const [bu]=await owner.db.insert(schema.businessUnit).values({tenantId:b.tenantId,companyId:b.companyId,code:'LC',name:'Limit Controls unit'}).returning();
  const [grade]=await owner.db.insert(schema.jobGrade).values({tenantId:b.tenantId,code:'12',name:'Grade 12'}).returning();
  for(const n of [1,2]){
   const hire=await hireEmployee(admin,{person:{fullName:`Fictional Limit Employee ${n}`,primaryEmail:`limit${n}@limit-controls.test`},companyId:b.companyId,departmentId:b.deptA,businessUnitId:bu.id,employmentType:'full_time',hiredOn:`${year-2}-01-01`});
   await owner.db.update(schema.employment).set({gradeId:grade.id,confirmationDate:`${year-2}-04-01`}).where(eq(schema.employment.id,hire.employmentId));
   await setCompensation(admin,{employmentId:hire.employmentId,basicSalary:5000,effectiveFrom:`${year-2}-01-01`});
  }
  unitId=await createApprovedRewardUnit(admin,{name:'Fictional Limit Controls Review',year,companyId:b.companyId,businessUnitId:bu.id,snapshotDate:today});
  for(const role of ['bu','bg','ctro','ec'] as const){
   const [p]=await owner.db.insert(schema.person).values({tenantId:b.tenantId,fullName:`Fictional ${role} limit reviewer`,primaryEmail:`${role}@limit-controls.test`}).returning();
   const userId=await createAppUser(b.tenantId,p.id,'employee');
   actors[role]={...admin,userId,personId:p.id,roles:['employee'],grants:undefined};
   await setRewardMember(admin,unitId,(await view()).unit.revision,userId,role);
  }
  actors.gr=admin;
  await setRewardMember(admin,unitId,(await view()).unit.revision,admin.userId!,'payroll');
 });
 async function submit(){
  let v=await view();
  await configureRewardFixture(admin,unitId,v.unit.revision,{...v.unit.policy,effectiveFrom:today,patActual:100,patTarget:100,ranges:{'12':[300000,500000,700000]}});
  for(const i of [0,1]){v=await view();await saveRewardEntry(admin,unitId,v.unit.revision,v.rows[i].id,v.rows[i].recommendation,{...emptyFacts(),reviewed:true,talent:'SCORE',performance:'ME'});}
  await refreshRewardFixtureBudget(admin,unitId);
  expect(await decideRewardUnit(actors.bu!,unitId,(await view()).unit.revision,'submit','Reviewed recommendations and their checks')).toBe('bg');
 }
 async function save(who:SessionContext,expectedRevision:number,change:(v:RewardLimitValues)=>void){
  const input={year,expectedRevision,values:values(change)},{digest}=await previewRewardLimitSave(who,input);
  return saveRewardLimits(who,{...input,reason,summaryDigest:digest});
 }
 const limitsFor=(who:SessionContext)=>withTenant(who,async tx=>{const [u]=await tx.select().from(schema.rewardUnit).where(eq(schema.rewardUnit.id,unitId));return rewardLimitsForUnitTx(tx,u);});
 const changeRows=()=>owner.db.execute<{action:string;high_impact:boolean;actor_id:string;item_label:string;summary:{lines:{key:string;before:string|null;after:string|null}[];affected:{reviewId:string;consequence:string}[]}}>(sql`select action,high_impact,actor_id,item_label,summary from reward_config_change where tenant_id=${b.tenantId}::uuid and area='limit' order by at,id`);

 it('lets Group Rewards edit, CTRO and EC view, and refuses every other role on the page, the commands and the table',async()=>{
  const access=async(who:SessionContext)=>withTenant(who,tx=>rewardLimitControlsAccessTx(tx));
  expect([await access(admin),await access(actors.ctro!),await access(actors.ec!),await access(actors.bu!),await access(actors.bg!)]).toEqual(['edit','view','view',null,null]);
  await save(admin,0,v=>{v['increase.withoutPromotion']={value:1200,type:'warning'};});
  for(const who of [actors.bu!,actors.bg!]){
   await expect(rewardLimitControls(who,year)).rejects.toThrow(/not available/);
   await expect(saveRewardLimits(who,{year,expectedRevision:1,values:values(),reason})).rejects.toThrow(/not available/);
   // Row security: the stored values never reach a reviewer outside Limit Controls.
   expect((await withTenant(who,tx=>tx.execute<{n:number}>(sql`select count(*)::int as n from reward_limit_version`)))[0].n).toBe(0);
  }
  const ctro=await rewardLimitControls(actors.ctro!,year);
  expect(ctro).toMatchObject({access:'view',canEdit:false,version:{revision:1}});expect(ctro.values['increase.withoutPromotion'].value).toBe(1200);
  await expect(save(actors.ctro!,1,v=>{v['bonus.underUse']={value:7000,type:'warning'};})).rejects.toThrow(/not available/);
  await expect(withTenant(actors.ec!,tx=>tx.execute(sql`insert into reward_limit_version(tenant_id,year,revision,limit_values,reason,created_by) values(app.current_tenant_id(),${year},2,${JSON.stringify(values())}::jsonb,${reason},app.current_user_id())`))).rejects.toThrow();
 },120_000);

 it('saves a version directly with a reason, logs it once and refuses a stale save or a changed summary',async()=>{
  const input={year,expectedRevision:0,values:values(v=>{v['increase.withoutPromotion']={value:1200,type:'exception'};})};
  const preview=await previewRewardLimitSave(admin,input);
  // A review using the limits has been released to the BU CEO, so the save is high impact and needs the digest.
  expect(preview.summary.highImpact).toEqual(['released-limit']);
  expect(preview.summary.affected).toEqual([expect.objectContaining({reviewId:unitId,stage:'draft',consequence:'repriced'})]);
  await expect(saveRewardLimits(admin,{...input,reason})).rejects.toThrow('This changed. Review the summary again.');
  await expect(saveRewardLimits(admin,{...input,reason:'short',summaryDigest:preview.digest})).rejects.toThrow(/reason/);
  expect(await saveRewardLimits(admin,{...input,reason,summaryDigest:preview.digest})).toMatchObject({revision:1});
  await expect(saveRewardLimits(admin,{...input,reason,summaryDigest:preview.digest})).rejects.toThrow(/changed/);
  const [version]=await owner.db.execute<{created_by:string;created_by_person_id:string;limit_values:Record<string,{value:number;type:string}>}>(sql`select created_by,created_by_person_id,limit_values from reward_limit_version where tenant_id=${b.tenantId}::uuid and year=${year}`);
  expect(version).toMatchObject({created_by:admin.userId,created_by_person_id:admin.personId});expect(version.limit_values['increase.withoutPromotion']).toEqual({value:1200,type:'exception'});
  const rows=await changeRows();
  expect(rows.map(r=>[r.action,r.high_impact,r.actor_id,r.item_label])).toEqual([['saved',true,admin.userId,`Limit Controls ${year}`]]);
  expect(rows[0].summary.lines).toEqual(expect.arrayContaining([{key:'increase.withoutPromotion:value',label:'Total increase without promotion · Value',before:'10%',after:'12%'},{key:'increase.withoutPromotion:type',label:'Total increase without promotion · Type',before:'Warning',after:'Exception'}]));
  const page=await rewardLimitControls(admin,year);
  expect(page.history['increase.withoutPromotion']).toMatchObject({changedBy:'Fictional Group Rewards editor',revision:1});
  expect(page.history['bonus.poolCap'].changedAt).toBe(page.history['increase.withoutPromotion'].changedAt);
 },120_000);

 it('refuses fixed financial invariants and any change to a stored version, even for the database owner',async()=>{
  await save(admin,0,()=>{});
  await expect(owner.db.execute(sql`insert into reward_limit_version(tenant_id,year,revision,limit_values,reason,created_by) values(${b.tenantId}::uuid,${year},2,${JSON.stringify({...values(),'salary.noReduction':{value:null,type:'note'}})}::jsonb,${reason},${admin.userId}::uuid)`)).rejects.toThrow();
  await expect(owner.db.execute(sql`update reward_limit_version set reason='Rewritten fictional history' where tenant_id=${b.tenantId}::uuid`)).rejects.toThrow();
  await expect(owner.db.execute(sql`delete from reward_limit_version where tenant_id=${b.tenantId}::uuid`)).rejects.toThrow();
  await expect(previewRewardLimitSave(admin,{year,expectedRevision:1,values:{...values(),'salary.noReduction':{value:null,type:'note'}}})).rejects.toThrow(/fixed/);
 },120_000);

 it('calculates Draft reviews on the current version and keeps a submitted review on its version until re-applied',async()=>{
  expect((await limitsFor(actors.bu!)).source).toBe('baseline');
  await save(admin,0,v=>{v['increase.withoutPromotion']={value:1200,type:'warning'};});
  // The BU CEO's calculation uses the confirmed version without being able to read Limit Controls.
  expect(await limitsFor(actors.bu!)).toMatchObject({source:'version',revision:1});
  await submit();
  const [pin]=await owner.db.execute<{source:string;revision:number}>(sql`select p.source,v.revision from reward_unit_limit_pin p join reward_limit_version v on v.id=p.limit_version_id where p.unit_id=${unitId}::uuid`);
  expect(pin).toEqual({source:'submitted',revision:1});
  const input={year,expectedRevision:1,values:values(v=>{v['increase.withoutPromotion']={value:1500,type:'warning'};})},preview=await previewRewardLimitSave(admin,input);
  expect(preview.summary.affected).toEqual([expect.objectContaining({reviewId:unitId,stage:'bg',consequence:'keeps-version'})]);
  await saveRewardLimits(admin,{...input,reason,summaryDigest:preview.digest});
  expect(await limitsFor(actors.bg!)).toMatchObject({source:'version',revision:1});
  // The approver sees plain rules; Group Rewards sees the values the review uses.
  const plain=await rewardRulesForReview(actors.bg!,unitId),full=await rewardRulesForReview(admin,unitId);
  expect(plain.showLimits).toBe(false);expect(plain.rules.find(r=>r.ref==='SAL-02')).toMatchObject({values:{},control:null,plain:true});expect(plain.limitVersion).toBeNull();
  expect(full.rules.find(r=>r.ref==='SAL-02')?.values).toEqual({limit:12});expect(full.limitVersion).toBe(1);
  // Re-application: Group Rewards only, the year's current version, reviews in the approval route.
  const request={year,revision:2,reviewIds:[unitId]};
  await expect(previewRewardLimitReapply(actors.bg!,request)).rejects.toThrow(/not available/);
  await expect(previewRewardLimitReapply(admin,{...request,revision:1})).rejects.toThrow(/changed/);
  const reapply=await previewRewardLimitReapply(admin,request);
  expect(reapply.summary.lines).toEqual([expect.objectContaining({key:unitId,before:'Version 1',after:'Version 2'})]);
  await expect(reapplyRewardLimits(admin,{...request,reason})).rejects.toThrow('This changed. Review the summary again.');
  expect(await reapplyRewardLimits(admin,{...request,reason,summaryDigest:reapply.digest})).toEqual({applied:[unitId]});
  expect(await limitsFor(actors.bg!)).toMatchObject({source:'version',revision:2});
  const events=await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId,unitId),eq(schema.domainEvent.eventType,'reward-unit.limits-reapplied')));
  expect(events).toHaveLength(1);expect(JSON.stringify(events[0].payload)).not.toMatch(/1500|15%/);
  expect((await changeRows()).map(r=>r.action)).toEqual(['saved','saved','applied']);
  // The re-applied review is rechecked by the same calculation at its next decision.
  expect((await getRewardUnit(actors.bg!,unitId)).unit.status).toBe('bg');
 },180_000);

 it('keeps reviews past Draft from before Limit Controls on the baseline and refuses re-applying to a Draft review',async()=>{
  await submit();
  await owner.db.execute(sql`delete from reward_unit_limit_pin where unit_id=${unitId}::uuid`);
  await save(admin,0,v=>{v['increase.withoutPromotion']={value:1500,type:'warning'};});
  expect((await limitsFor(actors.bg!)).source).toBe('baseline');
  await decideRewardUnit(actors.bg!,unitId,(await view()).unit.revision,'return','Fictional return to the BU CEO for changes');
  expect(await limitsFor(actors.bu!)).toMatchObject({source:'version',revision:1});
  await expect(previewRewardLimitReapply(admin,{year,revision:1,reviewIds:[unitId]})).rejects.toThrow(/selection changed/);
 },180_000);
 it('keeps the review policy pools, lump-sum settings and advisor thresholds read-only once the year has a version',async()=>{
  // Before a version the review's own policy owns the pools and lump-sum settings, and a Group Rewards save changes them.
  let config=await getRewardConfiguration(admin,unitId);
  expect(config.limitsOwned).toBe(false);
  await saveRewardPolicy(admin,unitId,config.unit.revision,{...config.unit.policy,standardPools:[400,100,100]});
  const stored=async()=>(await owner.db.select({policy:schema.rewardUnit.policy}).from(schema.rewardUnit).where(eq(schema.rewardUnit.id,unitId)))[0].policy;
  expect((await stored()).standardPools).toEqual([400,100,100]);
  await save(admin,0,v=>{v['pool.standard.merit']={value:700,type:'block'};});
  config=await getRewardConfiguration(admin,unitId);
  expect(config.limitsOwned).toBe(true);
  // A crafted save cannot change them: the stored values are kept and Limit Controls supply the calculation.
  const before=await stored();
  await saveRewardPolicy(admin,unitId,config.unit.revision,{...config.unit.policy,standardPools:[900,900,900],hPools:[800,800,800],lumpShareBp:1000,lumpStepCents:2000,lumpCapCents:100});
  const after=await stored();
  expect({standardPools:after.standardPools,hPools:after.hPools,lumpShareBp:after.lumpShareBp,lumpStepCents:after.lumpStepCents,lumpCapCents:after.lumpCapCents})
   .toEqual({standardPools:[400,100,100],hPools:before.hPools,lumpShareBp:before.lumpShareBp,lumpStepCents:before.lumpStepCents,lumpCapCents:before.lumpCapCents});
  expect((await limitsFor(admin)).values['pool.standard.merit'].value).toBe(700);
  // The advisor keeps its stored thresholds; only "enabled" and the fairness gap are saved.
  await saveRewardAdvisorSettings(admin,unitId,{enabled:true,overrideThresholdBp:9999,longWithoutIncreaseYears:19,equityGapBp:9999,fairnessGapBp:1200});
  const [setting]=await owner.db.execute<{settings:{enabled:boolean;overrideThresholdBp:number;longWithoutIncreaseYears:number;equityGapBp:number;fairnessGapBp:number}}>(sql`select settings from reward_advisor_setting where unit_id=${unitId}::uuid`);
  expect(setting.settings).toEqual({enabled:true,overrideThresholdBp:200,longWithoutIncreaseYears:3,equityGapBp:1500,fairnessGapBp:1200});
 },180_000);
});
