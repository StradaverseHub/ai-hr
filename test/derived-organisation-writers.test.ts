/** Native public owners against reviewed, independently approved mappings. No owner-mode
 * mapping insertion: publication, RLS, source freezing and the projection callback all run. */
import {afterAll,beforeAll,beforeEach,it,expect} from 'vitest';
import {and,asc,eq,isNull,sql} from 'drizzle-orm';
import * as schema from '../db/schema';
import {withTenant,type SessionContext} from '../db/client';
import {closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import {hireEmployee,setEmploymentAssignment,projectEmploymentOrganisationAssignmentTx} from '../core/org';
import {setCompanyParent} from '../core/admin';
import {setCompensation} from '../core/comp';
import {prepareCompanyOrganisationRun,companyOrganisationRuns,decideCompanyOrganisationRun,processCompanyOrganisationRun,employmentOrganisationTagsTx} from '../core/company-organisation';
import {organisationImportWarningsTx} from '../core/derived-organisation-display';
import {createMovementEvent} from '../core/movement';
import {correctHireDetails} from '../core/hire-correction';
import {correctInformation,previewInformationCorrection} from '../core/information-correction';
import {createBatch,preProcessAdvisory,generatePayslips} from '../core/payroll';
import {rewardPolicyMemberships} from '../packs/rewards/service';
import {setupChecker,setupRewardLibrariesFixture} from './rewards-setup-fixture';
import {saveRewardPlanConfiguration,saveRewardSetupPlan} from '../packs/rewards/plan-configuration';
import {todayInKualaLumpur} from '../lib/hr-date';
let b:Base,ctx:SessionContext,checker:SessionContext,oldBu:string,newBu:string;
const today=todayInKualaLumpur(),year=Number(today.slice(0,4)),hireDate=`${year-2}-01-01`;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();await setModule(b.tenantId,'rewards','active');ctx=await entitledCtx(b);
 const [doerPerson]=await owner.db.insert(schema.person).values({tenantId:b.tenantId,fullName:'Fictional HR doer',primaryEmail:'doer@org.invalid'}).returning();
 await owner.db.update(schema.appUser).set({personId:doerPerson.id}).where(eq(schema.appUser.id,ctx.userId!));ctx={...ctx,personId:doerPerson.id};
 const [checkPerson]=await owner.db.insert(schema.person).values({tenantId:b.tenantId,fullName:'Fictional independent HR checker',primaryEmail:'checker@org.invalid'}).returning();
 checker={...ctx,userId:await createAppUser(b.tenantId,checkPerson.id,'hr_admin'),personId:checkPerson.id};
 const units=await owner.db.insert(schema.businessUnit).values([{tenantId:b.tenantId,companyId:b.companyId,code:'LEGACY',name:'Legacy chosen unit'},{tenantId:b.tenantId,companyId:b.companyId,code:'MAPPED',name:'Reviewed mapped unit',label:'Reviewed mapped unit'}]).returning();oldBu=units[0].id;newBu=units[1].id;
});
const hire=(key:string,extra:Partial<Parameters<typeof hireEmployee>[1]>={})=>hireEmployee(ctx,{person:{fullName:'Fictional '+key,primaryEmail:key+'@org.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:hireDate,businessUnitId:oldBu,...extra});
async function publish(effectiveOn=today,businessUnitId:string|null=newBu){
 const id=await prepareCompanyOrganisationRun(ctx,{kind:'mapping',companyIds:[b.companyId],effectiveOn,changes:[{companyId:b.companyId,businessUnitId,parentCompanyId:null}]});
 const run=(await companyOrganisationRuns(ctx)).find(run=>run.id===id);expect(run).toBeTruthy();
 await decideCompanyOrganisationRun(checker,{id,digest:run!.digest,approve:true,reason:'Checked explicit company and independent BU identities'});
 let result=await processCompanyOrganisationRun(ctx,id);for(let n=0;n<5&&result.state==='staging';n++)result=await processCompanyOrganisationRun(ctx,id);
 expect(result.state,result.failure??'reviewed publication').toBe('published');return id;
}
const versions=(id:string)=>owner.db.select().from(schema.assignment).where(and(eq(schema.assignment.employmentId,id),isNull(schema.assignment.supersededAt))).orderBy(asc(schema.assignment.validFrom));
it('preserves legacy choice and historical prefix, then ignores manual BU in native hire, assignment, movement and correction owners',async()=>{
 const first=await hire('legacy');expect((await versions(first.employmentId))[0].businessUnitId).toBe(oldBu);
 const source=(await versions(first.employmentId))[0];const mapping=await publish();
 expect(await versions(first.employmentId)).toMatchObject([{validFrom:hireDate,validTo:today,businessUnitId:oldBu},{validFrom:today,validTo:null,businessUnitId:newBu}]);
 const [retained]=await owner.db.select().from(schema.assignment).where(eq(schema.assignment.id,source.id));expect(retained.supersededAt).not.toBeNull();expect(retained.businessUnitId).toBe(oldBu);
 const backdated=await hire('new-backdated',{businessUnitId:oldBu});expect((await versions(backdated.employmentId))[0].businessUnitId).toBeNull();
 await correctHireDetails(ctx,{employmentId:first.employmentId,reason:'Correct original position after mapping publication',changes:{positionId:b.positionId,businessUnitId:newBu}});expect((await versions(first.employmentId))[0].businessUnitId).toBe(oldBu);
 const next=await hire('derived',{hiredOn:today,businessUnitId:oldBu});expect((await versions(next.employmentId))[0].businessUnitId).toBe(newBu);
 await setEmploymentAssignment(ctx,{employmentId:next.employmentId,effectiveDate:today,businessUnitId:oldBu});expect((await versions(next.employmentId)).at(-1)?.businessUnitId).toBe(newBu);
 await createMovementEvent(ctx,{employmentId:next.employmentId,kind:'transfer',effectiveDate:today,departmentId:b.deptB,businessUnitId:oldBu});expect((await versions(next.employmentId)).at(-1)).toMatchObject({departmentId:b.deptB,businessUnitId:newBu});
 await createMovementEvent(ctx,{employmentId:next.employmentId,kind:'transfer',effectiveDate:today,departmentId:b.deptA});expect((await versions(next.employmentId)).at(-1)).toMatchObject({departmentId:b.deptA,businessUnitId:newBu});
 await correctHireDetails(ctx,{employmentId:next.employmentId,reason:'Correct original Personnel position',changes:{positionId:b.positionId,businessUnitId:oldBu}});expect((await versions(next.employmentId)).at(-1)?.businessUnitId).toBe(newBu);
 const review=await previewInformationCorrection(ctx,{employmentId:next.employmentId,changes:{employmentType:'part_time'},reason:'Correct signed employment type'});
 await correctInformation(ctx,{employmentId:next.employmentId,changes:{employmentType:'part_time'},reason:review.reason,fingerprint:review.fingerprint,method:'manual'});expect((await versions(next.employmentId)).at(-1)).toMatchObject({employmentType:'part_time',businessUnitId:newBu});
 expect(await withTenant(ctx,tx=>employmentOrganisationTagsTx(tx,ctx,{employmentId:next.employmentId,asOf:today}))).toMatchObject({mappingVersionId:mapping,businessUnitId:newBu,status:'ready'});
 const warnings=await withTenant(ctx,tx=>organisationImportWarningsTx(tx,ctx,{companyId:b.companyId,asOf:today,businessUnit:'Untrusted BU',parentCompany:'Untrusted Parent'}));expect(warnings.warnings).toHaveLength(3);expect(warnings.warnings.join(' ')).toContain(mapping);expect(warnings.warnings.join(' ')).toContain('Reviewed mapped unit');
 await expect(setCompanyParent(ctx,{companyId:b.companyId,parentCompanyId:b.companyId})).rejects.toThrow('reviewed dated changes');
});
it('makes an explicit missing-BU mapping pending, saves Personnel and blocks payroll and Rewards by employee without creating financial outputs',async()=>{
 const pendingOn=new Date(Date.parse(today+'T00:00:00Z')-86400000).toISOString().slice(0,10);
 await publish(pendingOn,null);const next=await hire('pending',{hiredOn:pendingOn,businessUnitId:oldBu});
 expect((await versions(next.employmentId)).at(-1)?.businessUnitId).toBeNull();
 await setCompensation(ctx,{employmentId:next.employmentId,basicSalary:5000,effectiveFrom:today});
 const [cycle]=await owner.db.insert(schema.payrollCycle).values({tenantId:b.tenantId,companyId:b.companyId,code:'ORG_READY',name:'Organisation readiness',runType:'regular'}).returning();
 const {batchId}=await createBatch(ctx,{companyId:b.companyId,payPeriod:today.slice(0,7),payrollCycleId:cycle.id});
 const advisory=await preProcessAdvisory(ctx,batchId);expect(advisory.missingCompensation).toEqual([]);expect(advisory.organisationGrouping).toEqual([expect.objectContaining({employmentId:next.employmentId,name:'Fictional pending'})]);
 await expect(generatePayslips(ctx,{batchId})).rejects.toThrow();expect(await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId,batchId))).toEqual([]);
 // New Rewards reviews require a proven current company/BU membership before their dated
 // roster is read. Today's corrected mapping must not clear yesterday's pending plan snapshot.
 await publish(today,newBu);
 expect((await preProcessAdvisory(ctx,batchId)).organisationGrouping).toEqual([]);
 expect(await rewardPolicyMemberships(ctx,[b.companyId])).toContainEqual({companyId:b.companyId,businessUnitId:newBu});
 expect(await withTenant(ctx,tx=>employmentOrganisationTagsTx(tx,ctx,{employmentId:next.employmentId,asOf:pendingOn}))).toMatchObject({status:'pending',businessUnitId:null});
 const grChecker=await setupChecker(ctx),{policy,salary,bonus}=await setupRewardLibrariesFixture(ctx,year,undefined,grChecker);
 const target={companyId:b.companyId,businessUnitId:newBu},source=await saveRewardPlanConfiguration(ctx,{groupId:null,expectedRevision:0,name:'Pending review',policy,targets:[target]});
 await expect(saveRewardSetupPlan(ctx,{versionId:source.versionId,expectedRevision:0,cycleName:'Pending review',snapshotDate:pendingOn,bindings:[{...target,salaryVersionId:salary,bonusVersionId:bonus,branchAcknowledged:false}],reason:'Check historical company structure'})).rejects.toThrow(/Group structure at the plan snapshot date/);
 expect(await owner.db.select().from(schema.rewardUnit)).toEqual([]);
 expect(await owner.db.select().from(schema.rewardEntry)).toEqual([]);
 expect(await owner.db.select().from(schema.rewardCycle)).toEqual([]);
 expect(await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId,batchId))).toEqual([]);
});
it('bounds a backdated projection by the next reviewed mapping, keeps future tags and is idempotent',async()=>{
 const id=(await hire('boundaries')).employmentId;await publish();
 const futureDate=new Date(Date.parse(today+'T00:00:00Z')+7*86400000).toISOString().slice(0,10);await publish(futureDate,oldBu);
 const earlierDate=new Date(Date.parse(today+'T00:00:00Z')-7*86400000).toISOString().slice(0,10);await publish(earlierDate,newBu);
 const rows=await versions(id);expect(rows.length).toBeGreaterThanOrEqual(3);expect(rows.at(-1)).toMatchObject({validFrom:futureDate,businessUnitId:oldBu});
 const before=JSON.stringify(rows);const projected=await withTenant(ctx,tx=>projectEmploymentOrganisationAssignmentTx(tx,ctx,{employmentId:id,effectiveOn:earlierDate,trigger:'restructure'}));expect(projected).toEqual({changed:0,assignmentIds:[]});expect(JSON.stringify(await versions(id))).toBe(before);
 const events=await owner.db.execute<{count:string}>(sql`select count(*)::text as count from domain_event where subject_employment_id=${id}::uuid and event_type='employment.organisation.projected'`);expect(Number(events[0].count)).toBeGreaterThan(0);
});
