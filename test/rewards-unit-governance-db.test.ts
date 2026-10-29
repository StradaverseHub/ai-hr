import {ensureAgentPrincipal,agentContext} from '../core/agent-principal';
import {resolveEntitlementsTx} from '../core/entitlements';
import {readFileSync} from 'node:fs';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {getRewardUnit,createRewardUnit,getRewardUnitGovernance,saveRewardUnitInputs,confirmRewardGovernance,proposeRewardExemption,previewRewardSeniorMembership,saveRewardSeniorMembership,saveRewardSeniorAward,saveRewardEntry,postRewardUnit,decideRewardUnit} from '../packs/rewards/service';
import {configureRewardFixture,refreshRewardFixtureBudget,ensureRewardGovernanceFixtureSchema} from './rewards-governance-fixture';
import {createBatch,setPayrollInput,rewardPayrollProvenance} from '../packs/payroll/service';
import {emptyFacts} from '../packs/rewards/model';
import {owner,resetDb,seedBase,setModule,entitledCtx,createAppUser,closeAll,type Base} from './harness';
import {setRewardMember} from './rewards-access-fixture';
import {todayInKualaLumpur} from '../lib/hr-date';
const today=todayInKualaLumpur(),year=Number(today.slice(0,4));
describe('unit inputs SQL custody, independent checks and stale snapshots',()=>{
 let b:Base,gr:SessionContext,checker:SessionContext,bu:SessionContext,ctro:SessionContext,payroll:SessionContext,unitId:string,employeeId:string,entryId:string;
 const view=()=>getRewardUnit(gr,unitId);
 beforeAll(async()=>{
  if(!process.env.TEST_DB_NAMESPACE)throw new Error('Use a private disposable test namespace.');
  // Reserved SQL is deliberately unjournaled until prerequisite allocation freezes. Apply only to
  // this namespaced worker database, whose ordinary migrations globalSetup already rehearsed.
  await ensureRewardGovernanceFixtureSchema();
 });
 beforeEach(async()=>{
  await resetDb();b=await seedBase();await setModule(b.tenantId,'rewards','active');gr=await entitledCtx(b);
  const [adminPerson]=await owner.db.insert(schema.person).values({tenantId:b.tenantId,fullName:'Fictional GR doer',primaryEmail:'grdoer@fixture.test'}).returning();
  await owner.db.update(schema.appUser).set({personId:adminPerson.id}).where(eq(schema.appUser.id,gr.userId!));gr={...gr,personId:adminPerson.id};
  const [buRow]=await owner.db.insert(schema.businessUnit).values({tenantId:b.tenantId,companyId:b.companyId,code:'GOV',name:'Governance fixture'}).returning();
  const [grade]=await owner.db.insert(schema.jobGrade).values({tenantId:b.tenantId,code:'21',name:'Grade21'}).returning();
  const hired=await hireEmployee(gr,{person:{fullName:'Fictional Senior employee',primaryEmail:'senior@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:`${year-2}-01-01`});employeeId=hired.employmentId;
  await owner.db.update(schema.assignment).set({businessUnitId:buRow.id}).where(eq(schema.assignment.employmentId,employeeId));
  await owner.db.update(schema.employment).set({gradeId:grade.id,confirmationDate:`${year-2}-04-01`}).where(eq(schema.employment.id,employeeId));
  await setCompensation(gr,{employmentId:employeeId,basicSalary:5000,effectiveFrom:`${year-2}-01-01`});
  unitId=await createRewardUnit(gr,{name:'Unit governance fixture',year,companyId:b.companyId,businessUnitId:buRow.id,snapshotDate:today});
  async function actor(name:string,role:'gr'|'bu'|'ctro'|'payroll'){
   const [person]=await owner.db.insert(schema.person).values({tenantId:b.tenantId,fullName:name,primaryEmail:name+'@fixture.test'}).returning();
   const userId=await createAppUser(b.tenantId,person.id,'employee');
   const ctx={...gr,userId,personId:person.id,roles:['employee'],grants:undefined};await setRewardMember(gr,unitId,(await view()).unit.revision,userId,role);return ctx;
  }
  checker=await actor('checker','gr');bu=await actor('bu','bu');ctro=await actor('ctro','ctro');payroll=await actor('payroll','payroll');
  const v=await view();entryId=v.rows[0].id;
  await saveRewardEntry(gr,unitId,v.unit.revision,entryId,v.rows[0].recommendation,{...emptyFacts(),reviewed:true,talent:'SCORE',performance:'ME'});
  await confirmRewardGovernance(checker,unitId,(await view()).unit.revision,'selection');
 });
 afterAll(closeAll);
 const inputs={forecastCents:900000,actualCents:null,targetCents:1000000,targetMonthsBp:20000,multiplierBp:10000,branchRatings:{}};
 async function saveInputs(){await saveRewardUnitInputs(gr,unitId,(await view()).unit.revision,inputs,'Reviewed the current unit PAT evidence');}
 it('keeps raw PAT under GR SQL custody and gives approvers only exact pool snapshots',async()=>{
  await saveInputs();
  const grState=await getRewardUnitGovernance(gr,unitId);expect(grState.inputs?.forecastCents).toBe(900000);
  for(const actor of [bu,ctro,payroll]){
   const raw=await withTenant(actor,tx=>tx.select().from(schema.rewardGovernance).where(eq(schema.rewardGovernance.unitId,unitId)));expect(raw).toEqual([]);
   const data=await getRewardUnitGovernance(actor,unitId);expect(data.inputs).toBeNull();expect(data.legacyInputs).toBeNull();expect(data.history).toEqual([]);
   expect(data).not.toHaveProperty('forecastCents');expect(data).not.toHaveProperty('actualCents');expect(data).not.toHaveProperty('targetCents');expect(data.inputs).toBeNull();expect(data.pools.standard).toBe(grState.pools.standard);
   const projected=await getRewardUnit(actor,unitId);expect(projected.unit.policy.patActual).toBe(0);expect(projected.suggestion).toBeNull();
   expect(projected.budgets.standard).toEqual((await view()).budgets.standard);
  }
 });
 it('refuses same-user confirmation and serializes competing stale saves with one winner',async()=>{
  const rev=(await view()).unit.revision;
  const attempts=await Promise.allSettled([saveRewardUnitInputs(gr,unitId,rev,inputs,'First concurrent budget update'),saveRewardUnitInputs(gr,unitId,rev,{...inputs,forecastCents:800000},'Second concurrent budget update')]);
  expect(attempts.filter(x=>x.status==='fulfilled')).toHaveLength(1);expect(attempts.filter(x=>x.status==='rejected')).toHaveLength(1);
  await proposeRewardExemption(gr,unitId,(await view()).unit.revision,'Signed reason for the budget exemption');
  await expect(confirmRewardGovernance(gr,unitId,(await view()).unit.revision,'exemption')).rejects.toThrow(/different/);
  await confirmRewardGovernance(checker,unitId,(await view()).unit.revision,'exemption');expect((await getRewardUnitGovernance(gr,unitId)).exemption?.confirmedBy).toBe(checker.userId);
 });
 it('requires an independent selection check and amount check, retaining prior evidence and preventing same-person confirmation',async()=>{
  const v=await view(),selection={employmentIds:[employeeId],adoptLegacy:false},preview=await previewRewardSeniorMembership(gr,unitId,v.unit.revision,selection);
  await saveRewardSeniorMembership(gr,unitId,v.unit.revision,selection,preview.digest);
  await expect(getRewardUnit(bu,unitId)).rejects.toThrow(/independent/);
  await expect(confirmRewardGovernance(gr,unitId,(await view()).unit.revision,'selection')).rejects.toThrow(/different/);
  await confirmRewardGovernance(checker,unitId,(await view()).unit.revision,'selection');
  await saveRewardSeniorAward(gr,unitId,(await view()).unit.revision,{entryId,newBasicCents:550000,incrementBp:null,bonusCents:123400,approvalReference:'OFFLINE-1',approvalDate:today,reason:'Signed offline approval recorded',evidence:[]});
  await expect(confirmRewardGovernance(gr,unitId,(await view()).unit.revision,'award',entryId)).rejects.toThrow(/different/);
  await confirmRewardGovernance(checker,unitId,(await view()).unit.revision,'award',entryId);
  const privileged=await getRewardUnitGovernance(ctro,unitId);expect(privileged.senior[0].award).toMatchObject({newBasicCents:550000,bonusCents:123400,confirmedBy:checker.userId});
  const restricted=await getRewardUnitGovernance(bu,unitId);expect(restricted.senior[0].award).toBeNull();expect(restricted.totals).toBeNull();
  const privateRows=await withTenant(payroll,tx=>tx.select().from(schema.rewardSeniorAward).where(eq(schema.rewardSeniorAward.unitId,unitId)));expect(privateRows).toEqual([]);
  await expect(withTenant(payroll,tx=>tx.execute(sql`select app.reward_senior_awards_for_post(${unitId}::uuid)`))).rejects.toThrow(/posting authority/);
 });
 it('invalidates public budget evidence after eligibility changes rather than exposing PAT or silently using a stale pool',async()=>{
  await saveInputs();const v=await view();await saveRewardEntry(gr,unitId,v.unit.revision,entryId,v.rows[0].recommendation,{...v.rows[0].facts,performance:'OU'});
  expect((await view()).flags).toContainEqual(expect.objectContaining({code:'PAT-STALE',severity:'block'}));
 });
 it('denies no-seat callers and named agents, including a restricted physical table owner',async()=>{
  await saveInputs();
  const [outsiderPerson]=await owner.db.insert(schema.person).values({tenantId:b.tenantId,fullName:'No-seat fictional caller',primaryEmail:'noseat@fixture.test'}).returning();
  const outsiderUser=await createAppUser(b.tenantId,outsiderPerson.id,'employee');
  const outsider:SessionContext={...gr,userId:outsiderUser,personId:outsiderPerson.id,roles:['employee'],grants:undefined};
  const snapshots=await withTenant(outsider,tx=>tx.select().from(schema.rewardGovernancePublic).where(eq(schema.rewardGovernancePublic.unitId,unitId)));expect(snapshots).toEqual([]);
  const agentId=await ensureAgentPrincipal(owner.db,b.tenantId),entitlements=await owner.db.transaction(tx=>resolveEntitlementsTx(tx,b.tenantId));
  const agent=agentContext(b.tenantId,agentId,entitlements);
  await expect(saveRewardUnitInputs(agent,unitId,(await view()).unit.revision,inputs,'Agent must not write private PAT')).rejects.toThrow();
  const [current]=await owner.db.execute<{name:string}>(sql`select current_user as name`);
  await owner.db.execute(sql`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='aihr_test_rewards_owner') THEN CREATE ROLE aihr_test_rewards_owner NOLOGIN NOSUPERUSER NOBYPASSRLS INHERIT; END IF; END $$`);
  await owner.db.execute(sql`GRANT ai_hr_app TO aihr_test_rewards_owner`);
  await owner.db.execute(sql`ALTER TABLE reward_governance OWNER TO aihr_test_rewards_owner`);
  await owner.db.execute(sql`ALTER TABLE reward_senior_award OWNER TO aihr_test_rewards_owner`);
  try{
   for(const actor of [outsider,agent])await owner.db.transaction(async tx=>{
    await tx.execute(sql`select set_config('app.tenant_id',${b.tenantId},true),set_config('app.user_id',${actor.userId??''},true),set_config('app.roles','employee',true),set_config('app.grants','[]',true),set_config('app.agent_principal_id',${actor.agent?.principalId??''},true)`);
    await tx.execute(sql`SET LOCAL ROLE aihr_test_rewards_owner`);
    expect(await tx.select().from(schema.rewardGovernance).where(eq(schema.rewardGovernance.unitId,unitId))).toEqual([]);
    expect(await tx.select().from(schema.rewardSeniorAward).where(eq(schema.rewardSeniorAward.unitId,unitId))).toEqual([]);
   });
   const [role]=await owner.db.execute<{canAssume:boolean}>(sql`select pg_has_role('ai_hr_app','ai_hr_rewards_post_reader','MEMBER') as "canAssume"`);expect(role.canAssume).toBe(false);
  }finally{
   await owner.db.execute(sql`ALTER TABLE reward_governance OWNER TO ${sql.identifier(current.name)}`);
   await owner.db.execute(sql`ALTER TABLE reward_senior_award OWNER TO ${sql.identifier(current.name)}`);
  }
 });

 it('posts confirmed Senior amounts once through the dedicated reader, preserving unrelated input and historical provenance',async()=>{
  const actors:Record<string,SessionContext>={bu,ctro,gr};
  for(const role of ['bg','ec'] as const){
   const [person]=await owner.db.insert(schema.person).values({tenantId:b.tenantId,fullName:'Fictional '+role+' approver',primaryEmail:role+'-positive@fixture.test'}).returning();
   const userId=await createAppUser(b.tenantId,person.id,'employee'),actor={...gr,userId,personId:person.id,roles:['employee'],grants:undefined};
   await setRewardMember(gr,unitId,(await view()).unit.revision,userId,role);actors[role]=actor;
  }
  await setRewardMember(gr,unitId,(await view()).unit.revision,gr.userId!,'payroll');
  let v=await view();await configureRewardFixture(gr,unitId,v.unit.revision,{...v.unit.policy,effectiveFrom:today,patActual:1000000,patTarget:1000000});
  v=await view();const selection={employmentIds:[employeeId],adoptLegacy:false},preview=await previewRewardSeniorMembership(gr,unitId,v.unit.revision,selection);
  await saveRewardSeniorMembership(gr,unitId,v.unit.revision,selection,preview.digest);await confirmRewardGovernance(checker,unitId,(await view()).unit.revision,'selection');
  v=await view();await saveRewardEntry(gr,unitId,v.unit.revision,entryId,v.rows[0].recommendation,{...v.rows[0].facts,reviewed:true});await refreshRewardFixtureBudget(gr,unitId);
  await saveRewardSeniorAward(gr,unitId,(await view()).unit.revision,{entryId,newBasicCents:550000,incrementBp:null,bonusCents:123400,approvalReference:'SIGNED-OFFLINE',approvalDate:today,reason:'Signed offline approval independently retained',evidence:[]});
  await confirmRewardGovernance(checker,unitId,(await view()).unit.revision,'award',entryId);
  const revision=(await view()).unit.revision;await decideRewardUnit(bu,unitId,revision,'submit','Reviewed the checked Senior decision');
  for(const role of ['bg','gr','ctro','ec'])await decideRewardUnit(actors[role],unitId,revision,'approve','Reviewed and accepted the decision');
  const [bounded]=await withTenant(gr,tx=>tx.execute<{awards:Record<string,unknown>}>(sql`select app.reward_senior_awards_for_post(${unitId}::uuid) as awards`));
  expect(bounded.awards[entryId]).toMatchObject({newBasicCents:550000,bonusCents:123400});expect(JSON.stringify(bounded)).not.toMatch(/PAT|evidence|SIGNED-OFFLINE|approvalReference/);
  await setModule(b.tenantId,'payroll','active');const {batchId}=await createBatch(gr,{companyId:b.companyId,payPeriod:today.slice(0,7)});
  await setPayrollInput(gr,{batchId,employmentId:employeeId,overtimeAmount:123,bonusAmount:55,tp1Deduction:44,zakat:9});
  await expect(postRewardUnit(gr,unitId,revision,batchId)).resolves.toMatchObject({alreadyPosted:false});
  await expect(postRewardUnit(gr,unitId,revision,batchId)).resolves.toMatchObject({alreadyPosted:true});
  const [input]=await owner.db.select().from(schema.payrollInput).where(eq(schema.payrollInput.batchId,batchId));
  expect(input).toMatchObject({overtimeAmount:'123.00',bonusAmount:'1289.00',tp1Deduction:'44.00',zakat:'9.00'});
  expect(input.rewardProvenance).toEqual([{unitId,entryId,revision,plan:'Senior plan',confirmedBy:checker.userId,confirmedAt:expect.any(String),historicalOnly:true}]);
  const [{sources}]=await rewardPayrollProvenance(gr,batchId);expect(sources).toEqual(input.rewardProvenance);
  const compensations=await owner.db.select().from(schema.compensation).where(eq(schema.compensation.employmentId,employeeId));expect(compensations.filter(row=>row.basicSalary==='5500.00')).toHaveLength(1);
  // A subsequent manual change does not convert a historical source reference into a claim that the
  // current bonus still equals the checked award.
  await setPayrollInput(gr,{batchId,employmentId:employeeId,overtimeAmount:123,bonusAmount:2000,tp1Deduction:44,zakat:9});
  expect((await rewardPayrollProvenance(gr,batchId))[0].sources[0].historicalOnly).toBe(true);
 });

});
