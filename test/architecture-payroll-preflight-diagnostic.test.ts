/** Isolated diagnosis of Payroll visibility before/after real approved Rewards fixture setup. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {closeAll,migrateTestDb,resetDb,seedBase,entitledCtx,owner,setModule} from './harness';
import * as s from '../db/schema';
import {withTenant} from '../db/client';
import {hireEmployee} from '../core/org';
import {createBatch,preProcessAdvisory} from '../core/payroll';
import {todayInKualaLumpur} from '../lib/hr-date';
import {approvedRewardFixtures} from '../scripts/fixtures/reward-approved';
import {saveRewardPlanConfiguration,saveRewardSetupPlan,submitRewardSetupPlan,approveRewardSetupPlan} from '../packs/rewards/plan-configuration';
beforeAll(async()=>{await migrateTestDb();await resetDb();});afterAll(closeAll);
it('keeps all current salaries visible through native Payroll after Rewards setup',async()=>{
 const b=await seedBase();await setModule(b.tenantId,'rewards','active');
 const base=await entitledCtx(b),today=todayInKualaLumpur(),year=Number(today.slice(0,4));
 const actor=await hireEmployee(base,{companyId:b.companyId,departmentId:b.deptA,hiredOn:'2021-01-01',employmentType:'full_time',person:{fullName:'Fictional payroll actor',primaryEmail:randomUUID()+'@example.test'}});
 await owner.db.update(s.appUser).set({personId:actor.personId}).where(eq(s.appUser.id,b.adminUserId));
 const ctx={...base,personId:actor.personId,grants:[{role:'hr_admin',companyId:null}]};
 const companies=[];
 for(let c=0;c<2;c++){
  const [company]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Diagnostic company '+c,country:'MY'}).returning();
  const [department]=await owner.db.insert(s.department).values({tenantId:b.tenantId,companyId:company.id,name:'Diagnostic department'}).returning();
  const employees=[];
  for(let i=0;i<50;i++)employees.push(await hireEmployee(ctx,{companyId:company.id,departmentId:department.id,hiredOn:'2021-01-01',employmentType:'full_time',person:{fullName:'Fictional '+c+' '+i,primaryEmail:randomUUID()+'@example.test'}}));
  await owner.db.insert(s.compensation).values(employees.map(e=>({tenantId:b.tenantId,employmentId:e.employmentId,basicSalary:'5000',validFrom:'2021-01-01'})));
  const {batchId}=await createBatch(ctx,{companyId:company.id,payPeriod:today.slice(0,7)});companies.push({company,department,batchId,employees});
 }
 const evidence:unknown[]=[];
 async function check(stage:string){
  const count=await withTenant(ctx,tx=>tx.execute(sql`select count(*)::int as count from compensation`));
  const checks=await preProcessAdvisory(ctx,companies[0].batchId);
  evidence.push({stage,visibleCompensation:count,missingCompensation:checks.missingCompensation.length});
  if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'payroll-preflight-diagnostic.json'),JSON.stringify(evidence,null,2));
  expect(count[0].count).toBe(100);expect(checks.missingCompensation).toEqual([]);
 }
 await check('before-rewards');
 const [unit]=await owner.db.insert(s.businessUnit).values({tenantId:b.tenantId,companyId:companies[1].company.id,code:'DIAG',name:'Diagnostic unit'}).returning();
 const fixtures=approvedRewardFixtures(owner),checker=await fixtures.setupChecker(ctx);
 await check('after-checker');
 await fixtures.setupCompanyStructureFixture(ctx,[{companyId:companies[1].company.id,businessUnitId:unit.id}],today,checker);
 await check('after-company-structure');
 const {policy,salary,bonus}=await fixtures.setupRewardLibrariesFixture(ctx,year,undefined,checker);
 await fixtures.confirmFixturePat(ctx,companies[1].company.id,year,{targetCents:policy.patTarget,forecastCents:null,actualCents:policy.patActual,targetMonthsBp:policy.targetMonthsBp},checker);
 const name='Fictional diagnostic '+randomUUID(),source=await saveRewardPlanConfiguration(ctx,{groupId:null,expectedRevision:0,name,policy,targets:[{companyId:companies[1].company.id,businessUnitId:unit.id}]});
 const revision=await saveRewardSetupPlan(ctx,{versionId:source.versionId,expectedRevision:0,cycleName:name,snapshotDate:today,bindings:[{companyId:companies[1].company.id,businessUnitId:unit.id,salaryVersionId:salary,bonusVersionId:bonus,branchAcknowledged:policy.bonusStructure==='branch'}],reason:'Fictional isolated diagnostic'});
 await submitRewardSetupPlan(ctx,source.versionId,revision);await approveRewardSetupPlan(checker,source.versionId,revision+1);
 await check('after-approved-plan');
},240000);
