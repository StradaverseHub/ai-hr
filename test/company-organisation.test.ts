import {createBusinessUnit} from '../core/admin';
import {setLabelGlobal} from '../core/system-labels';
import {pgSqlState} from '../lib/db-error';
import {createApprovedRewardUnit} from './rewards-setup-fixture';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import {hireEmployee,terminateEmployment} from '../core/org';
import {companyOrganisationRunReport,prepareCompanyOrganisationRun,decideCompanyOrganisationRun,processCompanyOrganisationRun,deriveCompanyOrganisationTx,employmentOrganisationTagsTx} from '../core/company-organisation';
import {todayInKualaLumpur} from '../lib/hr-date';
let b:Base,checker:SessionContext,unit:string;const today=()=>todayInKualaLumpur();
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();checker={...adminCtx(b),userId:await createAppUser(b.tenantId,null,'hr_admin')};unit=await globalUnit('REVIEWED','Fictional Independent Unit');});
async function globalUnit(code:string,name:string){const row=await createBusinessUnit(adminCtx(b),{companyId:b.companyId,code,name});await setLabelGlobal(adminCtx(b),{kind:'business_unit',labelId:row.id,isGlobal:true});return row.id;}
const hire=(name:string)=>hireEmployee(adminCtx(b),{person:{fullName:name,primaryEmail:name+'@organisation.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2024-01-01'});
const prepare=(effectiveOn=today())=>prepareCompanyOrganisationRun(adminCtx(b),{kind:'mapping',companyIds:[b.companyId],effectiveOn,changes:[{companyId:b.companyId,businessUnitId:unit,parentCompanyId:null}]});
async function approve(id:string){const {run}=await companyOrganisationRunReport(checker,id);await decideCompanyOrganisationRun(checker,{id,digest:run.digest,approve:true,reason:'Reviewed exact fictional scope and mappings'});}
async function publish(id:string){await approve(id);let result=await processCompanyOrganisationRun(adminCtx(b),id);for(let i=0;result.state==='staging'&&i<20;i++)result=await processCompanyOrganisationRun(adminCtx(b),id);expect(result.state).toBe('published');return result;}
it('keeps legacy stored units, preview and approval invisible, then publishes exactly once through the native assignment owner',async()=>{
 const e=await hire('FictionalAlpha');await owner.db.update(schema.assignment).set({companyId:null}).where(eq(schema.assignment.employmentId,e.employmentId));const id=await prepare();
 const tag=()=>withTenant(adminCtx(b),tx=>employmentOrganisationTagsTx(tx,adminCtx(b),{employmentId:e.employmentId,asOf:today()}));
 expect((await tag()).status).toBe('legacy');expect((await companyOrganisationRunReport(adminCtx(b),id)).run.counts.total).toBe(1);
 await approve(id);expect((await tag()).status).toBe('legacy');await processCompanyOrganisationRun(adminCtx(b),id);
 expect(await tag()).toMatchObject({status:'ready',businessUnitId:unit,businessGroupId:b.companyId});
 const rows=await owner.db.select().from(schema.assignment).where(eq(schema.assignment.employmentId,e.employmentId));expect(rows.some(row=>!row.supersededAt&&row.validFrom===today()&&row.businessUnitId===unit)).toBe(true);
 expect((await processCompanyOrganisationRun(adminCtx(b),id)).state).toBe('published');
 const [count]=await owner.db.execute<{count:number}>(sql`select count(*)::int count from employment_organisation_classification where employment_id=${e.employmentId}`);expect(count.count).toBe(1);
});
it('requires a different current person/login, exact digest and current scoped roles',async()=>{
 await hire('FictionalIndependent');const id=await prepare(),{run}=await companyOrganisationRunReport(adminCtx(b),id);
 await expect(decideCompanyOrganisationRun(adminCtx(b),{id,digest:run.digest,approve:true,reason:'Cannot approve own proposal'})).rejects.toThrow();
 await expect(decideCompanyOrganisationRun(checker,{id,digest:'changed',approve:true,reason:'Incorrect frozen preview'})).rejects.toThrow();
 await approve(id);await owner.db.delete(schema.roleAssignment).where(eq(schema.roleAssignment.appUserId,checker.userId!));
 expect((await processCompanyOrganisationRun(adminCtx(b),id)).state).toBe('stale');
 expect((await withTenant(adminCtx(b),tx=>deriveCompanyOrganisationTx(tx,adminCtx(b),{companyId:b.companyId,asOf:today()}))).status).toBe('legacy');
});
it('rejects changed source rows/population between frozen preview and publication without partial visible effects',async()=>{
 await hire('FictionalBefore');const id=await prepare();await approve(id);await hire('FictionalConcurrent');
 const result=await processCompanyOrganisationRun(adminCtx(b),id);expect(result.state).toBe('stale');expect(result.counts.failed).toBeGreaterThan(0);
 const [count]=await owner.db.execute<{count:number}>(sql`select count(*)::int count from company_organisation_mapping`);expect(count.count).toBe(0);
});
it('retains inactive intervals and includes inactive, future and voided records in a full re-tag report',async()=>{
 const active=await hire('FictionalActive'),inactive=await hire('FictionalInactive');
 await terminateEmployment(adminCtx(b),{employmentId:inactive.employmentId,terminationDate:'2025-01-01',terminationType:'voluntary',terminationReason:'Fictional prior departure'});
 const voided=await hire('FictionalVoided');
 // Owner restore fixture: retain the complete0676 void aggregate, including the released original code.
 // A fictional attempt UUID is permitted here because the retained provenance column intentionally has no FK.
 await owner.db.update(schema.employment).set({voidedAt:new Date(),voidedBy:b.adminUserId,voidReason:'Fictional reverted-import record for the organisation report',voidedImportAttemptId:sql`gen_random_uuid()`,voidedEmployeeCode:sql`${schema.employment.employeeCode}`,employeeCode:null}).where(eq(schema.employment.id,voided.employmentId));
 await publish(await prepare());
 const before=await owner.db.select().from(schema.assignment).where(eq(schema.assignment.employmentId,inactive.employmentId));
 const id=await prepareCompanyOrganisationRun(adminCtx(b),{kind:'retag',companyIds:[b.companyId],effectiveOn:today()});
 const report=await companyOrganisationRunReport(adminCtx(b),id);expect(report.rows.map(row=>row.employmentId).sort()).toEqual([active.employmentId,inactive.employmentId,voided.employmentId].sort());expect(report.rows.find(row=>row.employmentId===inactive.employmentId)).toMatchObject({status:'inactive',outcome:'changed'});expect(report.rows.find(row=>row.employmentId===voided.employmentId)).toMatchObject({status:'voided',outcome:'skipped'});
 await publish(id);expect(await owner.db.select().from(schema.assignment).where(eq(schema.assignment.employmentId,inactive.employmentId))).toEqual(before);
 const [classified]=await owner.db.execute<{count:number}>(sql`select count(*)::int count from employment_organisation_classification where employment_id=${inactive.employmentId}`);expect(classified.count).toBe(1);
});
it('honours future/historical dates and tenant-pins native ancestry without exposing private subtree enumeration',async()=>{
 const e=await hire('FictionalFuture');await publish(await prepare('2090-01-01'));
 const tags=async(asOf:string)=>withTenant(adminCtx(b),tx=>employmentOrganisationTagsTx(tx,adminCtx(b),{employmentId:e.employmentId,asOf}));
 expect((await tags(today())).status).toBe('legacy');expect((await tags('2090-01-01')).businessUnitId).toBe(unit);
 const [otherTenant]=await owner.db.insert(schema.tenant).values({name:'Other tenant',workosOrgId:'other-org-organisation'}).returning();const [other]=await owner.db.insert(schema.company).values({tenantId:otherTenant.id,legalName:'Secret tenant company'}).returning();
 const [proof]=await withTenant(adminCtx(b),tx=>tx.execute<{descendant:boolean}>(sql`select app.is_company_descendant(${other.id}::uuid,${other.id}::uuid) descendant`));expect(proof.descendant).toBe(false);
 await expect(withTenant(adminCtx(b),tx=>deriveCompanyOrganisationTx(tx,adminCtx(b),{companyId:other.id,asOf:today()}))).rejects.toThrow();
 await expect(withTenant(adminCtx(b),tx=>tx.execute(sql`select * from app.company_subtree(${b.companyId}::uuid)`))).rejects.toThrow();
});
it('never lets raw application SQL publish an unprojected approved preview or mutate the published parent directly',async()=>{
 await hire('FictionalNative');const id=await prepare();await approve(id);
 await expect(withTenant(adminCtx(b),async tx=>{await tx.execute(sql`select app.process_company_organisation_run(${id}::uuid,500)`);await tx.execute(sql`select app.begin_company_organisation_publication(${id}::uuid)`);await tx.execute(sql`select app.finish_company_organisation_publication(${id}::uuid)`);})).rejects.toThrow();
 expect((await companyOrganisationRunReport(adminCtx(b),id)).run.state).toBe('approved');await processCompanyOrganisationRun(adminCtx(b),id);
 const [parent]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'New standalone company'}).returning();
 await expect(withTenant(adminCtx(b),tx=>tx.update(schema.company).set({parentCompanyId:parent.id}).where(eq(schema.company.id,b.companyId)))).rejects.toThrow();
});
it('current permission ancestry and company-tree visuals change only at the reviewed effective date; source-only grants cannot move out of scope',async()=>{
 const [destination]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Fictional destination root'}).returning();
 const [child]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Fictional moved company',parentCompanyId:b.companyId}).returning();
 const scopedUser=await createAppUser(b.tenantId,null,'hr_admin');await owner.db.update(schema.roleAssignment).set({companyId:b.companyId}).where(eq(schema.roleAssignment.appUserId,scopedUser));
 const scoped:SessionContext={...adminCtx(b),userId:scopedUser,grants:[{role:'hr_admin',companyId:b.companyId}]};
 const destinationUser=await createAppUser(b.tenantId,null,'hr_admin');await owner.db.update(schema.roleAssignment).set({companyId:destination.id}).where(eq(schema.roleAssignment.appUserId,destinationUser));
 const destinationCtx:SessionContext={...adminCtx(b),userId:destinationUser,grants:[{role:'hr_admin',companyId:destination.id}]};
 const rawUpdate=(ctx:SessionContext,name:string)=>withTenant(ctx,tx=>tx.update(schema.company).set({legalName:name}).where(eq(schema.company.id,child.id)).returning({id:schema.company.id}));
 const rawDelete=(ctx:SessionContext)=>withTenant(ctx,tx=>tx.delete(schema.company).where(eq(schema.company.id,child.id)).returning({id:schema.company.id}));
 const retainedDelete=async(ctx:SessionContext)=>{let failure:unknown;try{await rawDelete(ctx);}catch(error){failure=error;}expect(pgSqlState(failure)).toBe('23503');};
 const proposal={kind:'mapping' as const,companyIds:[child.id],effectiveOn:'2090-01-01',changes:[{companyId:child.id,businessUnitId:unit,parentCompanyId:destination.id}]};
 await expect(prepareCompanyOrganisationRun(scoped,proposal)).rejects.toThrow();
 await publish(await prepareCompanyOrganisationRun(adminCtx(b),proposal));
 const ancestry=()=>withTenant(adminCtx(b),tx=>tx.execute<{old:boolean;next:boolean;parent:string}>(sql`select app.is_company_descendant(${child.id}::uuid,${b.companyId}::uuid) old,app.is_company_descendant(${child.id}::uuid,${destination.id}::uuid) next,app.company_organisation_current_parent(${child.id}::uuid) parent`));
 expect((await ancestry())[0]).toEqual({old:true,next:false,parent:b.companyId});
 expect(await rawUpdate(destinationCtx,'Denied future destination edit')).toEqual([]);expect(await rawDelete(destinationCtx)).toEqual([]);
 expect(await rawUpdate(scoped,'Permitted current source edit')).toEqual([{id:child.id}]);await retainedDelete(scoped);
 const current={...proposal,effectiveOn:today()};await expect(prepareCompanyOrganisationRun(scoped,current)).rejects.toThrow();
 await publish(await prepareCompanyOrganisationRun(adminCtx(b),current));
 expect((await ancestry())[0]).toEqual({old:false,next:true,parent:destination.id});
 expect(await rawUpdate(scoped,'Denied former source edit')).toEqual([]);expect(await rawDelete(scoped)).toEqual([]);
 expect(await rawUpdate(destinationCtx,'Permitted current destination edit')).toEqual([{id:child.id}]);await retainedDelete(destinationCtx);
 await expect(withTenant(scoped,tx=>tx.insert(schema.company).values({tenantId:b.tenantId,legalName:'Denied new destination child',parentCompanyId:destination.id}))).rejects.toThrow();
 const [newChild]=await withTenant(destinationCtx,tx=>tx.insert(schema.company).values({tenantId:b.tenantId,legalName:'Permitted new destination child',parentCompanyId:destination.id}).returning({id:schema.company.id}));
 expect(await withTenant(destinationCtx,tx=>tx.delete(schema.company).where(eq(schema.company.id,newChild.id)).returning({id:schema.company.id}))).toEqual([{id:newChild.id}]);
 await expect(withTenant(scoped,tx=>deriveCompanyOrganisationTx(tx,scoped,{companyId:child.id,asOf:today()}))).rejects.toThrow();
});
it('staging is bounded and resumable with no visible mapping until all frozen rows reconcile',async()=>{
 const rows=[];for(let index=0;index<3;index++)rows.push(await hire(`FictionalStaged${index}`));
 const id=await prepare();await approve(id);
 await withTenant(adminCtx(b),tx=>tx.execute(sql`select app.process_company_organisation_run(${id}::uuid,1)`));
 expect((await companyOrganisationRunReport(adminCtx(b),id)).run.counts.staged).toBe(1);
 expect((await withTenant(adminCtx(b),tx=>deriveCompanyOrganisationTx(tx,adminCtx(b),{companyId:b.companyId,asOf:today()}))).status).toBe('legacy');
 expect((await processCompanyOrganisationRun(adminCtx(b),id)).state).toBe('published');
 const [count]=await owner.db.execute<{count:number}>(sql`select count(*)::int count from employment_organisation_classification where employment_id in (${sql.join(rows.map(row=>sql`${row.employmentId}::uuid`),sql`,`)})`);expect(count.count).toBe(3);
});
it('projects only a proven existing future hire interval and freezes that actual projection date',async()=>{
 const e=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional Future Hire',primaryEmail:'future-hire@organisation.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2030-04-01'});
 const source=await owner.db.select().from(schema.assignment).where(eq(schema.assignment.employmentId,e.employmentId));expect(source.some(row=>row.validFrom==='2030-04-01')).toBe(true);
 const id=await prepare(),report=await companyOrganisationRunReport(adminCtx(b),id);expect(report.rows.find(row=>row.employmentId===e.employmentId)).toMatchObject({status:'future',projectionOn:'2030-04-01'});
 await publish(id);const rows=await owner.db.select().from(schema.assignment).where(eq(schema.assignment.employmentId,e.employmentId));expect(rows.filter(row=>!row.supersededAt).every(row=>row.validFrom>='2030-04-01')).toBe(true);expect(rows.some(row=>!row.supersededAt&&row.businessUnitId===unit)).toBe(true);
});

it('admits a real Group Rewards checker only for the complete old/new unit footprint, without giving HR execution rights',async()=>{
 const reviewer=await hire('FictionalRewardsReviewer'),grUser=await createAppUser(b.tenantId,reviewer.personId,'employee');
 await publish(await prepare());await setModule(b.tenantId,'rewards','active');
 const rewardUnit=await createApprovedRewardUnit(adminCtx(b),{name:'Fictional reviewed unit',year:Number(today().slice(0,4)),companyId:b.companyId,businessUnitId:unit,snapshotDate:today()});
 await owner.db.insert(schema.rewardMember).values({tenantId:b.tenantId,unitId:rewardUnit,userId:grUser,role:'gr'});
 const gr:SessionContext={...adminCtx(b),userId:grUser,personId:reviewer.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
 const id=await prepare(),report=await companyOrganisationRunReport(gr,id);expect(report.run.canApprove).toBe(true);
 await decideCompanyOrganisationRun(gr,{id,digest:report.run.digest,approve:true,reason:'Reviewed both exact old and new Rewards unit scopes'});
 await expect(processCompanyOrganisationRun(gr,id)).rejects.toThrow();expect((await processCompanyOrganisationRun(adminCtx(b),id)).state).toBe('published');
 const otherUnit={id:await globalUnit('OTHER','Fictional other unit')};
 const next=await prepareCompanyOrganisationRun(adminCtx(b),{kind:'mapping',companyIds:[b.companyId],effectiveOn:today(),changes:[{companyId:b.companyId,businessUnitId:otherUnit.id,parentCompanyId:null}]});
 await expect(companyOrganisationRunReport(gr,next)).rejects.toThrow();
});

it('rejects forged organisation evidence through the generic SECURITY DEFINER auth appender and consumes exact native permits',async()=>{
 await hire('FictionalAudit');const id=await prepare();
 await expect(withTenant(adminCtx(b),tx=>tx.execute(sql`select app.append_auth_event(${b.tenantId}::uuid,'organisation-tag-run',${id}::uuid,'organisation-tag-run.published','user',${b.adminUserId}::uuid,'{}'::jsonb)`))).rejects.toThrow();
 await expect(withTenant(adminCtx(b),tx=>tx.execute(sql`select app.company_org_append_event(${b.tenantId}::uuid,'organisation-tag-run',${id}::uuid,'organisation-tag-run.published','user',${b.adminUserId}::uuid,'{}'::jsonb)`))).rejects.toThrow();
 const [proof]=await owner.db.execute<{permits:number;published:number}>(sql`select (select count(*)::int from company_organisation_audit_permit) permits,(select count(*)::int from domain_event where aggregate_id=${id}::uuid and event_type='organisation-tag-run.published') published`);expect(proof).toEqual({permits:0,published:0});
});
it('normalises raw backdated BU writes after activation while retaining recorded legacy corrections and publication prefixes',async()=>{
 const legacy={id:await globalUnit('RECORDED','Fictional recorded legacy unit')};
 const e=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional Legacy Provenance',primaryEmail:'legacy-provenance@organisation.test'},companyId:b.companyId,departmentId:b.deptA,businessUnitId:legacy.id,employmentType:'full_time',hiredOn:'2024-01-01'});
 await publish(await prepare());
 const rows=await owner.db.select().from(schema.assignment).where(eq(schema.assignment.employmentId,e.employmentId));
 const prefix=rows.find(row=>!row.supersededAt&&row.validFrom==='2024-01-01'&&row.validTo===today());expect(prefix?.businessUnitId).toBe(legacy.id);
 // Changing a recorded legacy row cannot author a different BU, even though its date is pre-activation.
 await withTenant(adminCtx(b),tx=>tx.update(schema.assignment).set({businessUnitId:unit}).where(eq(schema.assignment.id,prefix!.id)));
 const [unchanged]=await owner.db.select().from(schema.assignment).where(eq(schema.assignment.id,prefix!.id));expect(unchanged.businessUnitId).toBe(legacy.id);
 // Native correction/reversal pattern: supersede an actual historical source and insert its exact window.
 const restored=await withTenant(adminCtx(b),async tx=>{
  await tx.update(schema.assignment).set({supersededAt:new Date()}).where(eq(schema.assignment.id,prefix!.id));
  const [row]=await tx.insert(schema.assignment).values({tenantId:b.tenantId,employmentId:e.employmentId,companyId:prefix!.companyId,departmentId:prefix!.departmentId,employmentType:prefix!.employmentType,validFrom:prefix!.validFrom,validTo:prefix!.validTo,businessUnitId:unit}).returning();return row;
 });expect(restored.businessUnitId).toBe(legacy.id);
 // A genuinely new retroactive hire has no dated source and cannot submit a new historical BU.
 const retro=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional New Retro Hire',primaryEmail:'new-retro@organisation.test'},companyId:b.companyId,departmentId:b.deptA,businessUnitId:legacy.id,employmentType:'full_time',hiredOn:'2023-01-01'});
 const [retroSource]=await owner.db.select().from(schema.assignment).where(eq(schema.assignment.employmentId,retro.employmentId));expect(retroSource.businessUnitId).toBeNull();
 await withTenant(adminCtx(b),tx=>tx.update(schema.assignment).set({businessUnitId:legacy.id}).where(eq(schema.assignment.id,retroSource.id)));
 expect((await owner.db.select().from(schema.assignment).where(eq(schema.assignment.id,retroSource.id)))[0].businessUnitId).toBeNull();
 // Raw INSERT also fails to introduce a value before the employment's only proven interval.
 const inserted=await withTenant(adminCtx(b),async tx=>{const [row]=await tx.insert(schema.assignment).values({tenantId:b.tenantId,employmentId:retro.employmentId,companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',validFrom:'2022-01-01',validTo:'2023-01-01',businessUnitId:legacy.id}).returning();return row;});expect(inserted.businessUnitId).toBeNull();
});

it('native company policies return zero rows for ordinary and missing-principal actors without opening the private parent projection',async()=>{
 const e=await hire('FictionalMemberPolicy'),member=await createAppUser(b.tenantId,e.personId,'employee');await publish(await prepare());
 const contexts:SessionContext[]=[{...adminCtx(b),userId:member,personId:e.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]},{tenantId:b.tenantId,roles:['employee'],grants:[{role:'employee',companyId:null}]}];
 for(const ctx of contexts){
  expect(await withTenant(ctx,tx=>tx.delete(schema.company).where(eq(schema.company.id,b.companyId)).returning({id:schema.company.id}))).toEqual([]);
  expect(await withTenant(ctx,tx=>tx.update(schema.company).set({legalName:'Denied member update'}).where(eq(schema.company.id,b.companyId)).returning({id:schema.company.id}))).toEqual([]);
 }
 await expect(withTenant(contexts[1],tx=>tx.execute(sql`select app.company_organisation_current_parent(${b.companyId}::uuid)`))).rejects.toThrow();
});
it('keeps verified system owner tag writes working after publication and records system custody without granting human review authority',async()=>{
 const e=await hire('FictionalOwnerMovement');const future=todayInKualaLumpur(new Date(Date.now()+7*86400000));
 const {createMovementEvent}=await import('../core/movement');
 const {sweepDueMovements}=await import('../core/movement-apply');
 await createMovementEvent(adminCtx(b),{employmentId:e.employmentId,kind:'transfer',effectiveDate:future,departmentId:b.deptB,remarks:'Fictional previously admitted owner movement'});
 await publish(await prepare());
 const system:SessionContext={...adminCtx(b),userId:undefined,personId:null,grants:[{role:'hr_admin',companyId:b.companyId}]};
 const read=sql`select app.employment_organisation_tags(${e.employmentId}::uuid,${today()}::date) as tags`;
 expect((await owner.withTenant(system,tx=>tx.execute<{tags:{status:string;businessUnitId:string}}>(read)))[0].tags).toMatchObject({status:'ready',businessUnitId:unit});
 await expect(withTenant(system,tx=>tx.execute(read))).rejects.toThrow();
 await expect(owner.withTenant(system,tx=>tx.execute(sql`select app.employment_organisation_tags(${e.employmentId}::uuid,null::date)`))).rejects.toThrow();
 await expect(owner.withTenant(system,tx=>tx.execute(sql`select app.record_employment_organisation_tags(${e.employmentId}::uuid,${b.companyId}::uuid,null::date,'movement')`))).rejects.toThrow();
 await expect(owner.withTenant(system,async tx=>{await tx.execute(sql`SET LOCAL ROLE ai_hr_app`);return tx.execute(read);})).rejects.toThrow();
 await expect(withTenant(system,tx=>tx.execute(sql`select app.record_employment_organisation_tags(${e.employmentId}::uuid,${b.companyId}::uuid,${future}::date,'movement')`))).rejects.toThrow();
 expect(await sweepDueMovements(system,{today:future},owner.withTenant)).toMatchObject({applied:1,failed:0});
 expect(await sweepDueMovements(system,{today:future},owner.withTenant)).toMatchObject({applied:0,failed:0});
 const classes=await owner.db.execute<{kind:string;actor:string|null;tags:{businessUnitId:string}}>(sql`select actor_kind as kind,actor_id as actor,tags from employment_organisation_classification where employment_id=${e.employmentId}::uuid and effective_on=${future}::date`);
 expect(classes).toEqual([{kind:'system',actor:null,tags:expect.objectContaining({businessUnitId:unit})}]);
 const events=await owner.db.execute<{kind:string;actor:string|null}>(sql`select actor_type::text as kind,actor_id as actor from domain_event where tenant_id=${b.tenantId}::uuid and subject_employment_id=${e.employmentId}::uuid and event_type='employment.organisation-tagged' and payload->>'effectiveOn'=${future}`);
 expect(events).toEqual([{kind:'system',actor:null}]);
 const id=await prepare(),{run}=await companyOrganisationRunReport(adminCtx(b),id);await approve(id);
 await expect(owner.withTenant(system,tx=>tx.execute(sql`select app.prepare_company_organisation_run(${JSON.stringify({kind:'retag',companyIds:[b.companyId],effectiveOn:today()})}::jsonb)`))).rejects.toThrow();
 await expect(owner.withTenant(system,tx=>tx.execute(sql`select app.decide_company_organisation_run(${id}::uuid,${run.digest},true,'System is never a human checker')`))).rejects.toThrow();
 await expect(owner.withTenant(system,tx=>tx.execute(sql`select app.process_company_organisation_run(${id}::uuid,200)`))).rejects.toThrow();
 await expect(owner.withTenant(system,tx=>tx.execute(sql`select app.begin_company_organisation_publication(${id}::uuid)`))).rejects.toThrow();
 await expect(owner.withTenant(system,tx=>tx.execute(sql`select app.finish_company_organisation_publication(${id}::uuid)`))).rejects.toThrow();
 expect((await companyOrganisationRunReport(adminCtx(b),id)).run.state).toBe('approved');
});
it('tenant- and company-pins trusted no-login owner tag reads and rejects inconsistent user/system custody pairs',async()=>{
 const e=await hire('FictionalOwnerScope');await publish(await prepare());
 const [other]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Fictional ungranted owner company'}).returning();
 const system:SessionContext={...adminCtx(b),userId:undefined,personId:null,grants:[{role:'hr_admin',companyId:other.id}]};
 await expect(owner.withTenant(system,tx=>tx.execute(sql`select app.company_organisation_tags(${b.companyId}::uuid,${today()}::date)`))).rejects.toThrow();
 await expect(owner.withTenant(system,tx=>tx.execute(sql`select app.record_employment_organisation_tags(${e.employmentId}::uuid,${b.companyId}::uuid,${today()}::date,'movement')`))).rejects.toThrow();
 const [foreign]=await owner.db.insert(schema.tenant).values({workosOrgId:'fictional-owner-foreign-tenant',name:'Fictional foreign owner tenant'}).returning();
 await expect(owner.withTenant({...system,tenantId:foreign.id},tx=>tx.execute(sql`select app.company_organisation_tags(${b.companyId}::uuid,${today()}::date)`))).rejects.toThrow();
 for(const pair of [{kind:'user',actor:null},{kind:'system',actor:b.adminUserId}]){
  let failure:unknown;try{await owner.db.execute(sql`insert into employment_organisation_classification(tenant_id,employment_id,company_id,effective_on,mapping_version_id,tags,trigger,actor_kind,actor_id,idempotency_key) select tenant_id,employment_id,company_id,effective_on,mapping_version_id,tags,'movement',${pair.kind},${pair.actor}::uuid,idempotency_key||${':invalid-'+pair.kind} from employment_organisation_classification where employment_id=${e.employmentId}::uuid limit 1`);}catch(error){failure=error;}expect(pgSqlState(failure)).toBe('23514');
 }
});
