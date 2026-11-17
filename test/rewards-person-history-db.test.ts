import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {defaultPolicy,emptyFacts,type RewardRole} from '../packs/rewards/model';
import {calculateRewards} from '../packs/rewards/engine';
import {getRewardUnit,withRewardHistoryBackfill,saveRewardEntry} from '../packs/rewards/service';
import {backfillRewardPersonHistory} from '../packs/rewards/person-history-backfill';
import {rewardPersonHistory,recordRewardPersonHistoryTx} from '../packs/rewards/person-history';
import {previewRewardPersonHistoryImport,importRewardPersonHistory,applyRewardPersonHistoryImportRowTx} from '../packs/rewards/person-history-upload';
import {rewardHistoryUploadHeaders} from '../packs/rewards/person-history-model';
import {createApprovedRewardUnit} from './rewards-setup-fixture';
import {setRewardMember} from './rewards-access-fixture';
import {closeAll,createAppUser,entitledCtx,owner,resetDb,seedBase,setModule,migrateTestDb,type Base} from './harness';
import {todayInKualaLumpur} from '../lib/hr-date';
import {toCsv} from '../lib/csv';

const today=todayInKualaLumpur(),year=Number(today.slice(0,4));
describe('Person reward history custody and upload',()=>{
 let b:Base,admin:SessionContext,unitId:string,entryId:string,employmentId:string,personId:string,pastUnitId:string,pastEntryId:string;
 let source:Awaited<ReturnType<typeof getRewardUnit>>['rows'][number]['source'];
 const actors:Partial<Record<RewardRole,SessionContext>>={};
 beforeAll(migrateTestDb);afterAll(closeAll);
 beforeEach(async()=>{
  await resetDb();b=await seedBase();await setModule(b.tenantId,'rewards','active');admin=await entitledCtx(b);
  const [adminPerson]=await owner.db.insert(schema.person).values({tenantId:b.tenantId,fullName:'Fictional history operator'}).returning();
  await owner.db.update(schema.appUser).set({personId:adminPerson.id}).where(eq(schema.appUser.id,admin.userId!));admin={...admin,personId:adminPerson.id};
  const [bu]=await owner.db.insert(schema.businessUnit).values({tenantId:b.tenantId,companyId:b.companyId,code:'HISTORY',name:'Fictional history unit'}).returning();
  const hired=await hireEmployee(admin,{person:{fullName:'Fictional history subject'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',employeeCode:'HIST-100',hiredOn:`${year-3}-01-01`});
  employmentId=hired.employmentId;personId=hired.personId;
  const [grade]=await owner.db.insert(schema.jobGrade).values({tenantId:b.tenantId,code:'12',name:'Fictional history grade'}).returning();
  await owner.db.update(schema.employment).set({gradeId:grade.id,confirmationDate:`${year-3}-04-01`}).where(eq(schema.employment.id,employmentId));
  await owner.db.update(schema.assignment).set({businessUnitId:bu.id}).where(eq(schema.assignment.employmentId,employmentId));
  await setCompensation(admin,{employmentId,basicSalary:5000,effectiveFrom:`${year-3}-01-01`});
  unitId=await createApprovedRewardUnit(admin,{name:'Fictional current history review',year,companyId:b.companyId,businessUnitId:bu.id,snapshotDate:today});
  const current=await getRewardUnit(admin,unitId),entry=current.rows.find(row=>row.source.employmentId===employmentId)!;entryId=entry.id;source=entry.source;
  await owner.db.update(schema.rewardEntry).set({facts:{...emptyFacts(),reviewed:true,talent:'STAR',performance:'OU'}}).where(eq(schema.rewardEntry.id,entryId));
  for(const role of ['bu','bg','pbp','ctro','ec'] as const){
   const [person]=await owner.db.insert(schema.person).values({tenantId:b.tenantId,fullName:`Fictional history ${role}`}).returning();
   const userId=await createAppUser(b.tenantId,person.id,'employee');actors[role]={...admin,userId,personId:person.id,roles:['employee'],grants:undefined};
   await setRewardMember(admin,unitId,(await getRewardUnit(admin,unitId)).unit.revision,userId,role);
  }
  const [cycle]=await owner.db.insert(schema.rewardCycle).values({tenantId:b.tenantId,name:'Fictional earlier reward history',year:year-1,createdBy:admin.userId!}).returning();
  const [past]=await owner.db.insert(schema.rewardUnit).values({tenantId:b.tenantId,companyId:b.companyId,businessUnitId:bu.id,cycleId:cycle.id,createdBy:admin.userId!,snapshotDate:`${year-1}-12-31`,policy:defaultPolicy(year-1)}).returning();pastUnitId=past.id;
  await owner.db.execute(sql`update reward_unit set preparation_required=false where id=${pastUnitId}::uuid`);
  const [pastEntry]=await owner.db.insert(schema.rewardEntry).values({tenantId:b.tenantId,unitId:past.id,employmentId,source,facts:{...emptyFacts(),reviewed:true,talent:'SCORE',performance:'ME'},recommendation:entry.recommendation}).returning();pastEntryId=pastEntry.id;
  await owner.db.execute(sql`insert into reward_person_history(tenant_id,company_id,employment_id,year,kind,source,unit_id,entry_id,talent,performance,merit_bp,promotion_bp,special_bp,increment_cents,total_increase_bp,promoted,bonus_cents,bonus_months_bp,lump_cents,created_by)
   values(${b.tenantId}::uuid,${b.companyId}::uuid,${employmentId}::uuid,${year-1},'annual','review',${pastUnitId}::uuid,${pastEntryId}::uuid,'SCORE','ME',450,0,0,22500,450,false,750000,15000,0,${admin.userId}::uuid)`);
 },120000); // Approved setup fixtures use independently checked libraries and organization evidence.

 it('returns independently expected prior awards under the current review and denies direct table reads to reviewers',async()=>{
  for(const role of ['bu','bg','pbp','ctro','ec'] as const){
   const rows=await rewardPersonHistory(actors[role]!,unitId,entryId);
   expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({year:year-1,talent:'SCORE',performance:'ME',incrementCents:22500,totalIncreaseBp:450,bonusCents:750000,bonusMonthsBp:15000});
  }
  const direct=await withTenant(actors.bu!,tx=>tx.execute(sql`select id from reward_person_history`));expect(direct).toHaveLength(0);
 });
 it('enforces BG and EC confidentiality and masks Senior amounts while retaining ratings',async()=>{
  await owner.db.execute(sql`update reward_entry set facts=jsonb_set(facts,'{confidentiality}','"bg"') where id=${entryId}::uuid`);
  expect(await rewardPersonHistory(actors.bu!,unitId,entryId)).toEqual([]);expect(await rewardPersonHistory(actors.pbp!,unitId,entryId)).toEqual([]);
  expect(await rewardPersonHistory(actors.bg!,unitId,entryId)).toHaveLength(1);
  await owner.db.execute(sql`update reward_entry set facts=jsonb_set(facts,'{confidentiality}','"ec"') where id=${entryId}::uuid`);
  expect(await rewardPersonHistory(actors.bg!,unitId,entryId)).toEqual([]);expect(await rewardPersonHistory(actors.ctro!,unitId,entryId)).toHaveLength(1);
  await owner.db.execute(sql`update reward_entry set facts=jsonb_set(jsonb_set(facts,'{confidentiality}','"standard"'),'{seniorPlan}','true') where id=${entryId}::uuid`);
  const [masked]=await rewardPersonHistory(actors.bu!,unitId,entryId);
  expect(masked).toMatchObject({talent:'SCORE',performance:'ME',incrementCents:null,totalIncreaseBp:null,meritBp:null,bonusCents:null,bonusMonthsBp:null,lumpCents:null,withheld:null});
  expect((await rewardPersonHistory(admin,unitId,entryId))[0].bonusCents).toBe(750000);
 });
 it('denies own history through the function and direct SELECT even with Group Rewards setup authority',async()=>{
  const userId=await createAppUser(b.tenantId,personId,'employee'),own={...admin,userId,personId,roles:['employee'],grants:undefined};
  await owner.db.insert(schema.rewardMember).values({tenantId:b.tenantId,unitId,userId,role:'gr'});
  await owner.db.execute(sql`insert into reward_setup_grant(tenant_id,user_id,role,valid_from,created_by,reason) values(${b.tenantId}::uuid,${userId}::uuid,'gr','2000-01-01',${admin.userId}::uuid,'Fictional own-history adversarial grant')`);
  expect(await rewardPersonHistory(own,unitId,entryId)).toEqual([]);
  expect(await withTenant(own,tx=>tx.execute(sql`select id from reward_person_history where employment_id=${employmentId}::uuid`))).toHaveLength(0);
  await expect(withTenant(admin,tx=>tx.execute(sql`select bonus_cents from reward_person_history`))).rejects.toThrow();
  expect(await withTenant(admin,tx=>tx.execute(sql`select id from reward_person_history where source='review'`))).toHaveLength(0);
 });
 it('rechecks role revocation and tenant binding on every read and refuses any alteration of a posted-source history row',async()=>{
  expect(await rewardPersonHistory(actors.bg!,unitId,entryId)).toHaveLength(1);
  await owner.db.execute(sql`delete from reward_member where unit_id=${unitId}::uuid and user_id=${actors.bg!.userId}::uuid`);
  expect(await rewardPersonHistory(actors.bg!,unitId,entryId)).toEqual([]);
  const other=await seedBase();await setModule(other.tenantId,'rewards','active');expect(await rewardPersonHistory(await entitledCtx(other),unitId,entryId)).toEqual([]);
  await expect(owner.db.execute(sql`update reward_person_history set bonus_cents=1 where entry_id=${pastEntryId}::uuid`)).rejects.toThrow(/append only/);
  expect((await rewardPersonHistory(admin,unitId,entryId))[0].bonusCents).toBe(750000);
 });
 it('binds upload preview to company identities, reports all invalid rows, and supersedes through the bulk job identity',async()=>{
  const raw={companyId:b.companyId,name:'fictional-history.csv',csv:toCsv([rewardHistoryUploadHeaders,['HIST-100',String(year-2),'STAR','AE','5','250','5000','1','Annual'],['missing',String(year-2),'STAR','AE','5','250','5000','1','Annual']])};
  const invalid=await previewRewardPersonHistoryImport(admin,raw);expect(invalid.rows).toHaveLength(1);expect(invalid.problems).toEqual([{line:3,reason:'Employee ID is unavailable or ambiguous in this company.',code:'employee'}]);
  await expect(importRewardPersonHistory(admin,raw,invalid.token)).rejects.toThrow(/valid, current/);
  const good={...raw,csv:toCsv([rewardHistoryUploadHeaders,['HIST-100',String(year-2),'STAR','AE','5','250','5000','1','Annual']])};
  const preview=await previewRewardPersonHistoryImport(admin,good),request=await importRewardPersonHistory(admin,good,preview.token);
  expect(request.jobId).toMatch(/^[a-f0-9-]{36}$/);
  await withTenant(admin,tx=>applyRewardPersonHistoryImportRowTx(tx,admin,b.companyId,request.jobId,preview.rows[0]));
  const replacement={...preview.rows[0],value:{...preview.rows[0].value,bonusCents:600000}};
  await withTenant(admin,tx=>applyRewardPersonHistoryImportRowTx(tx,admin,b.companyId,request.jobId,replacement));
  const stored=await owner.db.execute<{bonus_cents:string;superseded_at:Date|null}>(sql`select bonus_cents,superseded_at from reward_person_history where source='upload' and employment_id=${employmentId}::uuid order by created_at,id`);
  expect(stored).toHaveLength(2);expect(stored.filter(row=>row.superseded_at===null)).toHaveLength(1);expect(stored.filter(row=>row.superseded_at===null)[0].bonus_cents).toBe('600000');
  expect((await rewardPersonHistory(admin,unitId,entryId)).map(row=>row.year)).toEqual([year-1,year-2]);
 });
 it('records a whole review slice once and rolls back conflicting attempts instead of adopting different history',async()=>{
  await setRewardMember(admin,unitId,(await getRewardUnit(admin,unitId)).unit.revision,admin.userId!,'payroll');
  await owner.db.execute(sql`update reward_unit set status='approved' where id=${unitId}::uuid`);
  const view=await getRewardUnit(admin,unitId),row=view.rows.find(item=>item.id===entryId)!;
  const calculated=calculateRewards([row],{...defaultPolicy(year),ranges:{[row.source.grade]:[300000,500000,700000] as [number,number,number]}}).rows;
  await withTenant(admin,tx=>recordRewardPersonHistoryTx(tx,admin,view.unit,calculated));
  await expect(withTenant(admin,tx=>recordRewardPersonHistoryTx(tx,admin,view.unit,calculated.map(item=>({...item,bonusCents:1}))))).rejects.toThrow();
  const stored=await owner.db.execute<{bonus_cents:string}>(sql`select bonus_cents from reward_person_history where entry_id=${entryId}::uuid`);
  expect(stored).toHaveLength(1);expect(Number(stored[0].bonus_cents)).toBe(calculated[0].bonusCents);
 });
 it('keeps the same indexed person projection with 70 companies and 1,000 unrelated employments',async()=>{
  const before=await rewardPersonHistory(actors.bu!,unitId,entryId);
  const companies=await owner.db.insert(schema.company).values(Array.from({length:70},(_,i)=>({tenantId:b.tenantId,legalName:`Fictional history scale company ${i}`}))).returning({id:schema.company.id});
  const people=await owner.db.insert(schema.person).values(Array.from({length:1000},(_,i)=>({tenantId:b.tenantId,fullName:`Fictional history scale person ${i}`}))).returning({id:schema.person.id});
  await owner.db.insert(schema.employment).values(people.map((person,i)=>({tenantId:b.tenantId,companyId:companies[i%70].id,personId:person.id,employeeCode:`HS-${i}`,hiredOn:`${year-3}-01-01`})));
  expect(await rewardPersonHistory(actors.bu!,unitId,entryId)).toEqual(before);
  expect(await rewardPersonHistory(admin,unitId,entryId)).toEqual(before);
  const [index]=await owner.db.execute<{exists:boolean}>(sql`select exists(select 1 from pg_indexes where tablename='reward_person_history' and indexname='reward_person_history_person_year') as exists`);expect(index.exists).toBe(true);
 },180000); // 70-company / 1,000-person owner fixture measures the mandated group read shape.
 it('holds Access shared for both backfill modes and refuses unproved historical compensation',async()=>{
  for(const apply of [false,true]){
   const held=await withRewardHistoryBackfill(admin,unitId,apply,async tx=>(await tx.execute<{mode:string}>(sql`select app.access_lock_mode_held(${b.tenantId}::uuid) as mode`))[0].mode);
   expect(held).toBe('S');
  }
  await owner.db.insert(schema.rewardMember).values({tenantId:b.tenantId,unitId:pastUnitId,userId:admin.userId!,role:'payroll'});
  await owner.db.execute(sql`delete from reward_person_history where entry_id=${pastEntryId}::uuid`);
  await owner.db.execute(sql`update reward_unit set status='posted' where id=${pastUnitId}::uuid`);
  const report=await backfillRewardPersonHistory(admin,pastUnitId,false);
  expect(report.inserted).toBe(0);expect(report.accepted).toEqual([]);expect(report.refused.map(row=>row.entryId)).toEqual([pastEntryId]);
  expect(await owner.db.execute(sql`select id from reward_person_history where entry_id=${pastEntryId}::uuid`)).toHaveLength(0);
 });
 it('exposes allowlisted before/after edit values to Group Rewards and hides Senior details when that field is unavailable',async()=>{
  const view=await getRewardUnit(admin,unitId),row=view.rows.find(item=>item.id===entryId)!;
  await saveRewardEntry(admin,unitId,view.unit.revision,entryId,{...row.recommendation,meritBp:500,note:'Fictional next-approver note'});
  const read=()=>withTenant(admin,tx=>tx.execute<{changes:{field:string;before:unknown;after:unknown}[]}>(sql`select changes from app.reward_review_activity_changes(ARRAY[${unitId}::uuid],null,null)`));
  const changes=(await read()).flatMap(event=>event.changes);
  expect(changes).toContainEqual({field:'meritBp',before:null,after:500});expect(changes).toContainEqual({field:'note',before:null,after:'Fictional next-approver note'});
  await owner.db.execute(sql`update reward_entry set facts=jsonb_set(facts,'{seniorPlan}','true') where id=${entryId}::uuid`);
  await owner.db.execute(sql`insert into reward_role_permission(tenant_id,role,capability,allowed,level,changed_by) values(${b.tenantId}::uuid,'gr','senior.manage',false,'none',${admin.userId}::uuid)`);
  expect(await read()).toEqual([]);
 });
});
