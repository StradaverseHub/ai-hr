/** Exact native release journey for board 0c0d8710: rebind keeps its approver, reprices and refuses final EC changes. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,it,expect} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {dispatchNotifications} from '../core/notifications';
import {getRewardUnit,saveRewardEntry,decideRewardUnit,rewardPoolNotificationRecipients} from '../packs/rewards/service';
import {saveRewardLibrary} from '../packs/rewards/libraries';
import {rewardReviewPlans,previewRewardPlanGrid,saveRewardPlanGrid,type RewardPlanGridEdit} from '../packs/rewards/review-plans';
import {emptyFacts,type RewardRole} from '../packs/rewards/model';
import {createApprovedRewardUnit,setupGrades} from './rewards-setup-fixture';
import {configureRewardFixture,refreshRewardFixtureBudget} from './rewards-governance-fixture';
import {setRewardMember} from './rewards-access-fixture';
import {closeAll,createAppUser,entitledCtx,owner,resetDb,seedBase,setModule,migrateTestDb} from './harness';
import {todayInKualaLumpur} from '../lib/hr-date';
beforeAll(migrateTestDb);afterAll(closeAll);
it('reprices a released review, notifies its actual current approver, permits the next native approval, and locks the final EC result',async()=>{
 await resetDb();const b=await seedBase();await setModule(b.tenantId,'rewards','active');await setModule(b.tenantId,'notifications','active');let admin=await entitledCtx(b);const today=todayInKualaLumpur(),year=Number(today.slice(0,4));
 const[p]=await owner.db.insert(schema.person).values({tenantId:b.tenantId,fullName:'Fictional configuration editor',primaryEmail:randomUUID()+'@rebind.test'}).returning();await owner.db.update(schema.appUser).set({personId:p.id}).where(eq(schema.appUser.id,admin.userId!));admin={...admin,personId:p.id};
 const[bu]=await owner.db.insert(schema.businessUnit).values({tenantId:b.tenantId,companyId:b.companyId,code:'REBIND',name:'Fictional rebind BU'}).returning();const[grade]=await owner.db.insert(schema.jobGrade).values({tenantId:b.tenantId,code:'12',name:'Grade 12',rank:12}).returning();
 const employee=await hireEmployee(admin,{person:{fullName:'Fictional unchanged reward subject',primaryEmail:randomUUID()+'@rebind.test'},companyId:b.companyId,departmentId:b.deptA,businessUnitId:bu.id,gradeId:grade.id,employmentType:'full_time',hiredOn:`${year-2}-01-01`,employeeCode:'REBIND-SUBJECT'});await owner.db.update(schema.employment).set({confirmationDate:`${year-2}-04-01`}).where(eq(schema.employment.id,employee.employmentId));await setCompensation(admin,{employmentId:employee.employmentId,basicSalary:5000,effectiveFrom:`${year-2}-01-01`});
 const unitId=await createApprovedRewardUnit(admin,{name:'Fictional library rebind review',year,companyId:b.companyId,businessUnitId:bu.id,snapshotDate:today});const actors:Partial<Record<RewardRole,SessionContext>>={gr:admin},jobs:Partial<Record<RewardRole,string>>={};
 for(const role of ['bu','bg','ctro','ec','pbp'] as const){const hired=await hireEmployee(admin,{person:{fullName:`Fictional ${role} approver`,primaryEmail:randomUUID()+'@rebind.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:today,employeeCode:'R-'+role});const userId=await createAppUser(b.tenantId,hired.personId,'employee');actors[role]={...admin,userId,personId:hired.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};jobs[role]=hired.employmentId;await setRewardMember(admin,unitId,(await getRewardUnit(admin,unitId)).unit.revision,userId,role);}
 await setRewardMember(admin,unitId,(await getRewardUnit(admin,unitId)).unit.revision,admin.userId!,'payroll');
 const initial=await getRewardUnit(admin,unitId);await configureRewardFixture(admin,unitId,initial.unit.revision,{...initial.unit.policy,effectiveFrom:today,patActual:100,patTarget:100,targetMonthsBp:20000,multiplierBp:10000,ranges:{'12':[300000,500000,700000]}});
 const rated=await getRewardUnit(admin,unitId);expect(rated.rows).toHaveLength(1);await saveRewardEntry(admin,unitId,rated.unit.revision,rated.rows[0].id,rated.rows[0].recommendation,{...emptyFacts(),talent:'SCORE',performance:'ME',reviewed:true});await refreshRewardFixtureBudget(admin,unitId);
 const before=await getRewardUnit(admin,unitId);expect(await decideRewardUnit(actors.bu!,unitId,before.unit.revision,'submit','Fictional BU review checked and submitted')).toBe('bg');
 const oldSource=await owner.db.execute<{id:string;policy:unknown}>(sql`select v.id,v.policy from reward_policy_group_version v join reward_unit u on u.tenant_id=v.tenant_id and u.policy_group_version_id=v.id where u.id=${unitId}::uuid`);
 const grades=await setupGrades(admin),newBonus=await saveRewardLibrary(admin,{libraryId:null,versionId:null,expectedLock:0,name:'Explicitly selected one-month matrix',year,tags:[],groupDefault:false,previousLibraryId:null,data:{kind:'bonus',type:'standard',rows:grades.map(g=>({...g,months:[0,5000,10000,15000,20000]})),segments:[]},reason:'Approved explicit company matrix change',mode:'active'});
 const grid=await rewardReviewPlans(admin,{year}),row=grid.rows.find(r=>r.companyId===b.companyId)!;expect(row).toBeTruthy();const edit:RewardPlanGridEdit={companyId:row.companyId,expectedRevision:row.revision,planType:row.planType,reason:row.reason,salaryVersionId:row.salaryVersionId,bonusVersionId:newBonus,salaryReviewed:true,bonusReviewed:true,branchAcknowledged:false};const input={year,edits:[edit]},preview=await previewRewardPlanGrid(admin,input);expect(preview.summary.highImpact).toContain('released-library');
 const unchangedRevision=(await getRewardUnit(admin,unitId)).unit.revision;await expect(saveRewardPlanGrid(admin,input,preview.digest,'short')).rejects.toThrow(/reason/);expect((await getRewardUnit(admin,unitId)).unit.revision).toBe(unchangedRevision);
 await saveRewardPlanGrid(admin,input,preview.digest,'Current approver must review the deliberately changed company matrix');
 const rebound=await getRewardUnit(admin,unitId);expect(rebound.unit.status).toBe('bg');expect(rebound.unit.policy.bonusMatrix['12']).toEqual([0,5000,10000,15000,20000]);expect(rebound.rows[0].bonusCents).toBe(500000);expect(rebound.rows[0].source).toEqual(before.rows[0].source);expect(rebound.rows[0].recommendation).toEqual(before.rows[0].recommendation);
 expect(await owner.db.execute(sql`select id,policy from reward_policy_group_version where id=${oldSource[0].id}::uuid`)).toEqual(oldSource);
 const notices=await owner.db.execute<{id:string;payload:Record<string,unknown>}>(sql`select id,payload from domain_event where tenant_id=${b.tenantId}::uuid and aggregate_id=${unitId}::uuid and event_type='reward-unit.plan-rebound' and payload->>'libraryRebind'='true'`);expect(notices).toHaveLength(1);expect(JSON.stringify(notices[0].payload)).not.toMatch(/basicCents|bonusCents|salary/);
 const recipients=await withTenant(admin,async tx=>(await tx.execute<{id:string}>(sql`select app.reward_review_plan_rebind_recipients(${notices[0].id}::uuid) as id`)).map(r=>r.id));expect(recipients).toEqual([jobs.bg]);
 for(let i=0;i<5;i++){const result=await dispatchNotifications(admin,{limit:250});if(result.processed===0)break;}
 const projected=await owner.db.execute<{recipient_employment_id:string;kind:string}>(sql`select recipient_employment_id,kind from notification where source_event_id=${notices[0].id}::uuid`);expect(projected).toEqual([{recipient_employment_id:jobs.bg,kind:'rewards.plan-rebound'}]);
 expect(await decideRewardUnit(actors.bg!,unitId,rebound.unit.revision,'approve','Fictional current BG approver reviewed the repriced matrix')).toBe('gr');
 for(const[role,next]of [['gr','ctro'],['ctro','ec'],['ec','approved']] as const){const current=await getRewardUnit(actors[role]!,unitId);expect(await decideRewardUnit(actors[role]!,unitId,current.unit.revision,'approve',`Fictional ${role} reviewed changed calculation and approved`)).toBe(next);}
 const final=await getRewardUnit(admin,unitId),afterGrid=await rewardReviewPlans(admin,{year}),afterRow=afterGrid.rows.find(r=>r.companyId===b.companyId)!,blocked={year,edits:[{...edit,expectedRevision:afterRow.revision,bonusVersionId:row.bonusVersionId}]},blockedPreview=await previewRewardPlanGrid(admin,blocked);
 await expect(saveRewardPlanGrid(admin,blocked,blockedPreview.digest,'This attempt must not change a final EC-approved review')).rejects.toMatchObject({cause:{message:expect.stringMatching(/Final approved reviews are locked/)}});const kept=await getRewardUnit(admin,unitId);expect(kept.unit.policy).toEqual(final.unit.policy);expect(kept.unit.status).toBe('approved');expect(kept.unit.revision).toBe(final.unit.revision);
},180_000);
