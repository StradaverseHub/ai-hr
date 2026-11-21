/** The Rewards definers the staged imports leave as installed (5010, 5012, 5070) still keep staged rows out.
 * They belong to purpose roles (ai_hr_reward_setup_reader, ai_hr_reward_upload_reader) that the migration owner may
 * not act as, and that are neither the table owner nor BYPASSRLS, so the restrictive staged-row policies on
 * employment, person and job_grade apply to every read inside them. A staged hire never enters a planned review's
 * roster, and a staged grade is offered for a library only once it is visible. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import * as s from '../db/schema';
import type {SessionContext} from '../db/client';
import {hireEmployee} from '../core/org';
import {rewardLibraryGradeChoices} from '../packs/rewards/libraries';
import {todayInKualaLumpur} from '../lib/hr-date';
import {createApprovedRewardUnit,setupGrades} from './rewards-setup-fixture';
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

const today=todayInKualaLumpur(),year=Number(today.slice(0,4));
let b:Base,admin:SessionContext;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'rewards','active');admin=await entitledCtx(b);});

/** The owner stamps the marker the way an import chunk does; the 5010/5070 guard admits only the table owner. */
const stage=(table:'person'|'employment'|'job_grade',id:string,attempt:string|null)=>
 owner.db.execute(sql`update ${sql.identifier(table)} set import_pending_attempt_id=${attempt}::uuid where id=${id}::uuid`);

it('runs the four readers as their purpose owners with their installed bodies',async()=>{
 const rows=await owner.db.execute<{fn:string;owner:string;definer:boolean;staged:boolean}>(sql`select p.oid::regprocedure::text as fn,
  pg_get_userbyid(p.proowner)::text as owner,p.prosecdef as definer,
  (p.prosrc like '%import_pending_attempt_id%' or p.prosrc like '%import_marker_visible%') as staged
  from pg_proc p where p.oid in ('app.reward_uploaded_snapshot_roster(uuid,date)'::regprocedure,'app.reward_create_planned_unit_bound(uuid,uuid,uuid)'::regprocedure,
   'app.reward_setup_grade_choices()'::regprocedure,'app.reward_uploaded_validation(uuid)'::regprocedure) order by 1`);
 expect([...rows]).toEqual([
  {fn:'app.reward_create_planned_unit_bound(uuid,uuid,uuid)',owner:'ai_hr_reward_setup_reader',definer:true,staged:false},
  {fn:'app.reward_setup_grade_choices()',owner:'ai_hr_reward_setup_reader',definer:true,staged:false},
  {fn:'app.reward_uploaded_snapshot_roster(uuid,date)',owner:'ai_hr_reward_setup_reader',definer:true,staged:false},
  {fn:'app.reward_uploaded_validation(uuid)',owner:'ai_hr_reward_upload_reader',definer:true,staged:false},
 ]);
});

it('keeps a staged hire out of the planned review roster the setup reader builds',async()=>{
 const [unit]=await owner.db.insert(s.businessUnit).values({tenantId:b.tenantId,companyId:b.companyId,code:'STAGED',name:'Fictional staged roster unit'}).returning();
 const hire=(name:string)=>hireEmployee(admin,{person:{fullName:name,primaryEmail:randomUUID()+'@staged-roster.test'},companyId:b.companyId,
  departmentId:b.deptA,businessUnitId:unit.id,employmentType:'full_time',hiredOn:`${year-1}-01-01`});
 const visible=await hire('Fictional visible employee'),staged=await hire('Fictional staged employee');
 const attempt=randomUUID();
 await stage('person',staged.personId,attempt);await stage('employment',staged.employmentId,attempt);
 const unitId=await createApprovedRewardUnit(admin,{name:'Fictional staged roster review',year,companyId:b.companyId,businessUnitId:unit.id,snapshotDate:today});
 const roster=(await owner.db.execute<{id:string}>(sql`select employment_id::text as id from reward_entry where unit_id=${unitId}::uuid`)).map(row=>row.id);
 expect(roster).toContain(visible.employmentId);
 expect(roster).not.toContain(staged.employmentId);
});

it('offers a staged grade for a library only once it is visible',async()=>{
 await owner.db.execute(sql`insert into reward_setup_grant(tenant_id,user_id,company_id,role,valid_from,created_by,reason)
  values(${b.tenantId}::uuid,${admin.userId}::uuid,null,'gr','2000-01-01',${admin.userId}::uuid,'Explicit fictional setup authority')`);
 const grades=await setupGrades(admin),staged=grades.find(row=>row.grade==='23')!;
 const offered=async()=>(await rewardLibraryGradeChoices(admin)).map(row=>row.gradeId);
 const before=await offered();
 expect(before).toContain(staged.gradeId);
 await stage('job_grade',staged.gradeId,randomUUID());
 expect(await offered()).toEqual(before.filter(id=>id!==staged.gradeId));
 await stage('job_grade',staged.gradeId,null);
 expect(await offered()).toEqual(before);
});
