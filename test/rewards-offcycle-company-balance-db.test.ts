/** Board b945f0cc: off-cycle and mid-year requests on a real database with fictional data. One balance per company
 * (frozen year-end remainder, held by requests in approval or approved, consumed by posted requests), the off-cycle
 * year opened by Group Rewards only after the year-end cycle closed, the blackout and mid-year window, budget-exception
 * routing, subject exclusion, company isolation, concurrency under the annual parent locks, idempotent posting, the
 * pinned Limit Controls version and the October-December year-end exclusion. */
import {createApprovedRewardUnit} from './rewards-setup-fixture';
import {configureRewardFixture,refreshRewardFixtureBudget} from './rewards-governance-fixture';
import {setRewardMember} from './rewards-access-fixture';
import {migrateRewardMembershipFixture} from './rewards-shared-policy-fixture';
import {offcycleMidyearWindowFixture,openRewardOffcycleYearFixture,outsideOffcycleBlackout} from './helpers/rewards-offcycle-fixture';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {createBatch} from '../packs/payroll/service';
import {createOffcycleReview,decideRewardUnit,getRewardUnit,postRewardUnit,previewRewardOffcycleYearSave,rewardOffcycleDashboard,rewardOffcycleSettings,saveRewardEntry,saveRewardOffcycleYear} from '../packs/rewards/service';
import {rewardConfigChangeLog} from '../packs/rewards/config-change';
import {baselineRewardLimitValues,previewRewardLimitSave,rewardConfigurableLimitKeys,rewardOffcycleLimitsTx,saveRewardLimits,type RewardLimitValues} from '../packs/rewards/limit-controls';
import {emptyFacts,type RewardRole} from '../packs/rewards/model';
import {closeAll,createAppUser,entitledCtx,owner,resetDb,seedBase,setModule,type Base} from './harness';
import {todayInKualaLumpur} from '../lib/hr-date';

beforeAll(migrateRewardMembershipFixture);afterAll(closeAll);
const today=todayInKualaLumpur(),year=Number(today.slice(0,4));
const reason='Fictional Group Rewards off-cycle decision';

describe('Rewards off-cycle company balance (b945f0cc)',()=>{
 let b:Base,admin:SessionContext,unitId:string,cycleId:string,employments:string[]=[];
 const actors:Partial<Record<RewardRole,SessionContext>>={};
 const view=()=>getRewardUnit(admin,unitId);
 beforeEach(async()=>{
  await resetDb();b=await seedBase();await setModule(b.tenantId,'rewards','active');await setModule(b.tenantId,'payroll','active');admin=await entitledCtx(b);
  const [adminPerson]=await owner.db.insert(schema.person).values({tenantId:b.tenantId,fullName:'Fictional Group Rewards',primaryEmail:'gr@offcycle.test'}).returning();
  await owner.db.update(schema.appUser).set({personId:adminPerson.id}).where(eq(schema.appUser.id,admin.userId!));admin={...admin,personId:adminPerson.id};
  const [bu]=await owner.db.insert(schema.businessUnit).values({tenantId:b.tenantId,companyId:b.companyId,code:'OC',name:'Off-cycle unit'}).returning();
  const [grade]=await owner.db.insert(schema.jobGrade).values({tenantId:b.tenantId,code:'12',name:'Grade 12'}).returning();
  employments=[];
  // The second employee is also the CTRO reviewer: a request about them must never reach their list or decision.
  for(const n of [1,2]){
   const hire=await hireEmployee(admin,{person:{fullName:n===2?'Fictional ctro reviewer':`Fictional Off-cycle Employee ${n}`,primaryEmail:`oc${n}@offcycle.test`},companyId:b.companyId,departmentId:b.deptA,businessUnitId:bu.id,employmentType:'full_time',hiredOn:`${year-2}-01-01`});
   await owner.db.update(schema.employment).set({gradeId:grade.id,confirmationDate:`${year-2}-04-01`}).where(eq(schema.employment.id,hire.employmentId));
   await setCompensation(admin,{employmentId:hire.employmentId,basicSalary:5000,effectiveFrom:`${year-2}-01-01`});
   employments.push(hire.employmentId);
  }
  unitId=await createApprovedRewardUnit(admin,{name:'Fictional Off-cycle Year-end',year,companyId:b.companyId,businessUnitId:bu.id,snapshotDate:today});
  const [subject]=await owner.db.select({personId:schema.employment.personId}).from(schema.employment).where(eq(schema.employment.id,employments[1]));
  for(const role of ['bu','bg','ctro','ec'] as const){
   const personId=role==='ctro'?subject.personId:(await owner.db.insert(schema.person).values({tenantId:b.tenantId,fullName:`Fictional ${role} reviewer`,primaryEmail:`${role}@offcycle.test`}).returning())[0].id;
   const userId=await createAppUser(b.tenantId,personId,'employee');
   actors[role]={...admin,userId,personId,roles:['employee'],grants:undefined};
   await setRewardMember(admin,unitId,(await view()).unit.revision,userId,role);
  }
  actors.gr=admin;
  await setRewardMember(admin,unitId,(await view()).unit.revision,admin.userId!,'payroll');
  let v=await view();
  await configureRewardFixture(admin,unitId,v.unit.revision,{...v.unit.policy,effectiveFrom:today,patActual:100,patTarget:100,targetMonthsBp:20000,ranges:{'12':[300000,500000,700000]}});
  for(const i of [0,1]){v=await view();await saveRewardEntry(admin,unitId,v.unit.revision,v.rows[i].id,v.rows[i].recommendation,{...emptyFacts(),reviewed:true,talent:'SCORE',performance:'ME'});}
  await refreshRewardFixtureBudget(admin,unitId);
  cycleId=(await view()).unit.cycleId;
 },180_000);
 async function postAnnual(){
  await refreshRewardFixtureBudget(admin,unitId);
  const rev=(await view()).unit.revision;
  expect(await decideRewardUnit(actors.bu!,unitId,rev,'submit','Fictional reviewed recommendations')).toBe('bg');
  for(const role of ['bg','gr','ctro','ec'] as const)await decideRewardUnit(actors[role]!,unitId,rev,'approve','Fictional reviewed recommendations');
  const {batchId}=await createBatch(admin,{companyId:b.companyId,payPeriod:today.slice(0,7)});
  await postRewardUnit(admin,unitId,rev,batchId);
  const [row]=await owner.db.select({funding:schema.rewardUnit.fundingCents}).from(schema.rewardUnit).where(eq(schema.rewardUnit.id,unitId));
  return row.funding.standard+row.funding.h;
 }
 /** A request for one annual entry (by employment), with the given merit, created by the BU CEO. */
 async function request(employmentId:string,meritBp:number|((basicCents:number)=>number),opts:{kind?:'adhoc'|'midyear';effectiveFrom?:string;exceptionReason?:string;who?:SessionContext}={}){
  const parent=await view(),entry=parent.rows.find(r=>r.source.employmentId===employmentId)??(await getRewardUnit(actors.bu!,unitId)).rows.find(r=>r.source.employmentId===employmentId)!;
  const who=opts.who??actors.bu!;
  const id=await createOffcycleReview(who,unitId,{kind:opts.kind??'adhoc',entryIds:[entry.id],effectiveFrom:opts.effectiveFrom??`${year+1}-02-01`,exceptionReason:opts.exceptionReason??''});
  const v=await getRewardUnit(who,id);
  const merit=typeof meritBp==='function'?meritBp(v.rows[0].source.basicCents):meritBp;
  await saveRewardEntry(who,id,v.unit.revision,v.rows[0].id,{...v.rows[0].recommendation,meritBp:merit,reason:'Fictional expanded responsibilities'});
  return id;
 }
 const revisionOf=async(id:string,who:SessionContext=actors.bu!)=>(await getRewardUnit(who,id)).unit.revision;
 const balances=(who:SessionContext=admin)=>withTenant(who,tx=>tx.execute<{company_id:string;frozen_cents:string;held_cents:string;consumed_cents:string;available_cents:string}>(sql`select * from app.reward_offcycle_balances(${cycleId}::uuid)`))
  .then(rows=>Object.fromEntries(rows.map(r=>[r.company_id,{frozen:Number(r.frozen_cents),held:Number(r.held_cents),consumed:Number(r.consumed_cents),available:Number(r.available_cents)}])));
 async function open(window:{from:string;to:string}|null=null){
  const input={cycleId,expectedRevision:0,midyearFrom:window?.from??null,midyearTo:window?.to??null},{digest}=await previewRewardOffcycleYearSave(admin,input);
  return saveRewardOffcycleYear(admin,{...input,reason,summaryDigest:digest});
 }

 it('opens the off-cycle year only after the year-end cycle closed, through Review before saving and one change-log row',async()=>{
  const input={cycleId,expectedRevision:0,midyearFrom:null,midyearTo:null};
  await expect(previewRewardOffcycleYearSave(admin,input)).rejects.toThrow(/Every year-end review must finish/);
  const frozen=await postAnnual();
  expect(frozen).toBeGreaterThan(0);
  // Requests are switched off until the year opens.
  await expect(request(employments[0],100)).rejects.toThrow(/not opened the off-cycle year/);
  // Only Group Rewards with whole-group configuration authority.
  for(const who of [actors.bu!,actors.bg!,actors.ctro!])await expect(previewRewardOffcycleYearSave(who,input)).rejects.toThrow(/Group Rewards only/);
  expect((await rewardOffcycleSettings(admin)).find(c=>c.cycleId===cycleId)).toMatchObject({revision:0,canOpen:true,readiness:{posted:1,open:0}});
  const window=offcycleMidyearWindowFixture(),full={...input,midyearFrom:window.from,midyearTo:window.to};
  const preview=await previewRewardOffcycleYearSave(admin,full);
  expect(preview.summary.highImpact).toEqual(['offcycle-window','open-offcycle']);
  expect(preview.summary.lines.map(l=>[l.key,l.before,l.after])).toEqual([['midyear',null,`${window.from} – ${window.to}`],['state','Closed','Open']]);
  await expect(saveRewardOffcycleYear(admin,{...full,reason})).rejects.toThrow('This changed. Review the summary again.');
  await expect(saveRewardOffcycleYear(admin,{...full,reason:'short',summaryDigest:preview.digest})).rejects.toThrow(/reason/);
  expect(await saveRewardOffcycleYear(admin,{...full,reason,summaryDigest:preview.digest})).toEqual({revision:1});
  await expect(saveRewardOffcycleYear(admin,{...full,reason,summaryDigest:preview.digest})).rejects.toThrow(/changed/);
  const log=await rewardConfigChangeLog(admin,{area:'offcycle'});
  expect(log.rows.map(r=>[r.area,r.action,r.itemLabel])).toEqual([['offcycle','opened',expect.stringContaining('Off-cycle year')]]);
  // The database writer refuses everyone else too.
  await expect(withTenant(actors.bu!,tx=>tx.execute(sql`select app.reward_offcycle_year_save(${cycleId}::uuid,1,null,null)`))).rejects.toThrow();
  expect((await rewardOffcycleDashboard(actors.bu!,[b.companyId])).cycle).toMatchObject({id:cycleId});
 },240_000);

 it('holds nothing for drafts, holds on submission, releases on return and consumes once on idempotent posting',async()=>{
  const frozen=await postAnnual();await open();
  const id=await request(employments[0],100);
  const created=await getRewardUnit(actors.bu!,id),amount=created.offcycleBalance!.requestCents;
  // 1% of the current salary (after the year-end increase), worked out by the service.
  expect(amount).toBe(Math.round(created.rows[0].source.basicCents/10000)*100);expect(amount).toBeGreaterThan(2000);expect(amount).toBeLessThanOrEqual(frozen);
  expect((await balances())[b.companyId]).toEqual({frozen,held:0,consumed:0,available:frozen});
  const rev=await revisionOf(id);
  expect(await outsideOffcycleBlackout(()=>decideRewardUnit(actors.bu!,id,rev,'submit','Fictional reviewed request'))).toBe('bg');
  expect((await balances())[b.companyId]).toEqual({frozen,held:amount,consumed:0,available:frozen-amount});
  expect(await decideRewardUnit(actors.bg!,id,rev,'return','Fictional comparator needed first')).toBe('draft');
  expect((await balances())[b.companyId]).toEqual({frozen,held:0,consumed:0,available:frozen});
  const next=await revisionOf(id);
  await outsideOffcycleBlackout(async()=>{
   expect(await decideRewardUnit(actors.bu!,id,next,'submit','Fictional revised request')).toBe('bg');
   for(const role of ['bg','gr'] as const)await decideRewardUnit(actors[role]!,id,next,'approve','Fictional reviewed request');
  });
  // Historical per-plan reservations are summed exactly once (reconciliation without double counting).
  await owner.db.update(schema.rewardUnit).set({reservedCents:{standard:amount-2000,h:2000}}).where(eq(schema.rewardUnit.id,id));
  expect((await balances())[b.companyId]).toEqual({frozen,held:amount,consumed:0,available:frozen-amount});
  await outsideOffcycleBlackout(()=>decideRewardUnit(actors.ctro!,id,next,'approve','Fictional reviewed request'));
  // The CTRO seat holder here is also a subject of the year-end review, but not of this request: they may decide it.
  expect((await getRewardUnit(admin,id)).unit.status).toBe('approved');
  expect(await postRewardUnit(admin,id,next)).toEqual({alreadyPosted:false});
  expect(await postRewardUnit(admin,id,next)).toEqual({alreadyPosted:true});
  expect((await balances())[b.companyId]).toEqual({frozen,held:0,consumed:amount,available:frozen-amount});
  expect((await getRewardUnit(actors.bu!,await request(employments[0],100,{effectiveFrom:`${year+1}-03-01`}))).offcycleBalance).toMatchObject({availableCents:frozen-amount,requestCents:amount});
 },300_000);

 it('serializes concurrent submissions against one company balance under the annual parent locks',async()=>{
  const frozen=await postAnnual();await open();
  // Each request fits alone; together they exceed the company balance.
  const bp=(basic:number)=>Math.floor(frozen*6000/basic);
  const ids=[await request(employments[0],bp),await request(employments[1],bp)];
  const amounts=await Promise.all(ids.map(async id=>(await getRewardUnit(actors.bu!,id)).offcycleBalance!.requestCents));
  for(const amount of amounts)expect(amount).toBeLessThanOrEqual(frozen);expect(amounts[0]+amounts[1]).toBeGreaterThan(frozen);
  const revisions=await Promise.all(ids.map(id=>revisionOf(id)));
  const results=await outsideOffcycleBlackout(()=>Promise.allSettled(ids.map((id,i)=>decideRewardUnit(actors.bu!,id,revisions[i],'submit','Fictional concurrent request'))));
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
  const accepted=results.findIndex(r=>r.status==='fulfilled');
  expect((await balances())[b.companyId]).toEqual({frozen,held:amounts[accepted],consumed:0,available:frozen-amounts[accepted]});
  const other=ids[1-accepted];
  expect((await getRewardUnit(actors.bu!,other)).flags).toContainEqual(expect.objectContaining({code:'OC-11',severity:'block'}));
 },300_000);

 it('keeps each company balance isolated and never lists or lets the subject decide a request about them',async()=>{
  const frozen=await postAnnual();await open();
  // Balances are per company and only for readers with a seat on that company's year-end review (or whole-group
  // configuration authority); the dashboard read is further narrowed to the scope it is asked for.
  const [company]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Fictional Other Company',companyLabel:'OTHER'}).returning();
  expect(await balances()).toEqual({[b.companyId]:{frozen,held:0,consumed:0,available:frozen}});
  expect(Object.keys(await balances(actors.bu!))).toEqual([b.companyId]);
  const [outsiderPerson]=await owner.db.insert(schema.person).values({tenantId:b.tenantId,fullName:'Fictional outsider',primaryEmail:'outsider@offcycle.test'}).returning();
  const outsider={...admin,userId:await createAppUser(b.tenantId,outsiderPerson.id,'employee'),personId:outsiderPerson.id,roles:['employee'],grants:undefined} as SessionContext;
  expect(await balances(outsider)).toEqual({});
  expect((await rewardOffcycleDashboard(actors.bu!,[company.id])).balances).toEqual([]);
  expect((await rewardOffcycleDashboard(actors.bu!,[b.companyId,company.id])).balances.map(x=>[x.companyId,x.availableCents])).toEqual([[b.companyId,frozen]]);
  // A request about the CTRO reviewer (employee 2).
  const id=await request(employments[1],100),rev=await revisionOf(id);
  await outsideOffcycleBlackout(async()=>{
   expect(await decideRewardUnit(actors.bu!,id,rev,'submit','Fictional reviewed request')).toBe('bg');
   for(const role of ['bg','gr'] as const)await decideRewardUnit(actors[role]!,id,rev,'approve','Fictional reviewed request');
   await expect(decideRewardUnit(actors.ctro!,id,rev,'approve','Fictional self approval attempt')).rejects.toThrow(/about you/);
   await expect(decideRewardUnit(actors.ctro!,id,rev,'return','Fictional self return attempt')).rejects.toThrow(/about you/);
  });
  expect((await rewardOffcycleDashboard(actors.bu!,[b.companyId])).requests.map(r=>r.id)).toContain(id);
  expect((await rewardOffcycleDashboard(actors.ctro!,[b.companyId])).requests.map(r=>r.id)).not.toContain(id);
  expect((await getRewardUnit(admin,id)).unit.status).toBe('ctro');
 },300_000);

 it('applies the blackout, the open year and the mid-year window; budget exceptions go on their own through BG',async()=>{
  await postAnnual();await open(offcycleMidyearWindowFixture());
  const set=await request(employments[0],100,{kind:'midyear'}),rev=await revisionOf(set);
  const y=new Date().getUTCFullYear();
  await expect(outsideOffcycleBlackout(()=>decideRewardUnit(actors.bu!,set,rev,'submit','Fictional set'),`${y}-07-15`)).rejects.toThrow(/mid-year window/);
  await expect(outsideOffcycleBlackout(()=>decideRewardUnit(actors.bu!,set,rev,'submit','Fictional set'),`${y}-11-15`)).rejects.toThrow(/1 October to 31 January/);
  await expect(outsideOffcycleBlackout(()=>decideRewardUnit(actors.bu!,set,rev,'submit','Fictional set'),`${y}-01-31`)).rejects.toThrow(/1 October to 31 January/);
  expect(await outsideOffcycleBlackout(()=>decideRewardUnit(actors.bu!,set,rev,'submit','Fictional set'))).toBe('bg');
  // A mid-year set cannot carry a budget exception.
  await expect(request(employments[1],100,{kind:'midyear',exceptionReason:'Fictional retention case that cannot wait for the year end'})).rejects.toThrow(/ad-hoc request/);
  const exception=await request(employments[1],100,{exceptionReason:'Fictional retention case that cannot wait for the year end'}),erev=await revisionOf(exception);
  expect((await getRewardUnit(actors.bu!,exception)).route).toEqual(['bg','gr','ctro','ec']);
  await expect(outsideOffcycleBlackout(()=>decideRewardUnit(actors.bu!,exception,erev,'submit','Fictional exception'))).rejects.toThrow();
  expect(await outsideOffcycleBlackout(()=>decideRewardUnit(actors.bg!,exception,erev,'submit','Fictional exception'))).toBe('gr');
  // Returned exceptions go back to the BG CEO.
  expect(await decideRewardUnit(admin,exception,erev,'return','Fictional return to the BG CEO')).toBe('draft');
  expect((await getRewardUnit(actors.bg!,exception)).returned).toMatchObject({toSeat:'bg'});
 },300_000);

 it('pins the Limit Controls version on submission and records the October-December year-end exclusion at final approval',async()=>{
  await postAnnual();await open();
  const values=(change:(v:RewardLimitValues)=>void)=>{const v=baselineRewardLimitValues();change(v);return Object.fromEntries(rewardConfigurableLimitKeys.map(key=>[key,v[key]]));};
  const saveLimits=async(expectedRevision:number,change:(v:RewardLimitValues)=>void)=>{const input={year,expectedRevision,values:values(change)},{digest}=await previewRewardLimitSave(admin,input);return saveRewardLimits(admin,{...input,reason,summaryDigest:digest});};
  await saveLimits(0,v=>{v['increase.withoutPromotion']={value:1200,type:'warning'};});
  const id=await request(employments[0],100,{effectiveFrom:`${year+1}-10-01`}),rev=await revisionOf(id);
  const limitsFor=(who:SessionContext)=>withTenant(who,async tx=>{const [u]=await tx.select().from(schema.rewardUnit).where(eq(schema.rewardUnit.id,id));return rewardOffcycleLimitsTx(tx,u);});
  expect(await limitsFor(actors.bu!)).toMatchObject({source:'version',revision:1});
  await outsideOffcycleBlackout(()=>decideRewardUnit(actors.bu!,id,rev,'submit','Fictional reviewed request'));
  const [pin]=await owner.db.execute<{source:string;revision:number}>(sql`select p.source,v.revision from reward_unit_limit_pin p join reward_limit_version v on v.id=p.limit_version_id where p.unit_id=${id}::uuid`);
  expect(pin).toEqual({source:'submitted',revision:1});
  await saveLimits(1,v=>{v['increase.withoutPromotion']={value:50,type:'block'};});
  // The submitted request keeps version 1: the new 0.5% block does not reach it, so its approvals go through.
  expect(await limitsFor(actors.bg!)).toMatchObject({source:'version',revision:1});
  await outsideOffcycleBlackout(async()=>{for(const role of ['bg','gr','ctro'] as const)await decideRewardUnit(actors[role]!,id,rev,'approve','Fictional reviewed request');});
  const approved=await getRewardUnit(admin,id);
  expect(approved.unit.status).toBe('approved');
  expect(approved.unit.offcycle).toMatchObject({yearEndExclusion:year+1});
  // A Draft request follows the year's current version.
  const draft=await request(employments[1],100,{effectiveFrom:`${year+1}-03-01`});
  expect((await getRewardUnit(actors.bu!,draft)).flags).toContainEqual(expect.objectContaining({code:'INC-01',severity:'block'}));
  expect(await withTenant(actors.bu!,async tx=>{const [u]=await tx.select().from(schema.rewardUnit).where(eq(schema.rewardUnit.id,draft));return (await rewardOffcycleLimitsTx(tx,u)).revision;})).toBe(2);
 },300_000);
});
