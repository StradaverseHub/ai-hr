/** Exercise the Home projections with a real restricted function/table owner. All role and ownership
 * changes roll back inside the isolated test database; this is not a populated migration rehearsal. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {saveEmployeeHomeConfiguration} from '../core/employee-home-configuration';
import {saveOwnHomePersonPrivacy} from '../core/employee-home-person-privacy';
import {defaultEmployeeHomeConfiguration} from '../lib/employee-home-defaults';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();});
it('honors a hidden peer opt-out under a NOSUPERUSER/NOBYPASSRLS owner and refuses ownership drift',async()=>{
 const on=todayInKualaLumpur(),hired=String(Number(on.slice(0,4))-4)+on.slice(4);
 async function worker(name:string){
  const employee=await hireEmployee(adminCtx(b),{person:{fullName:name,primaryEmail:randomUUID()+'@example.invalid'},
   companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:hired});
  const ctx:SessionContext={tenantId:b.tenantId,userId:await createAppUser(b.tenantId,employee.personId,'employee'),personId:employee.personId,roles:['employee']};
  return {...employee,ctx};
 }
 const own=await worker('Fictional viewer'),peer=await worker('Fictional private birthday');
 await owner.db.update(s.person).set({dateOfBirth:'2000'+on.slice(4)}).where(eq(s.person.id,peer.personId));
 const configuration=defaultEmployeeHomeConfiguration();configuration.teamVisibility='department';configuration.celebrations={enabled:true,scope:'department'};
 await saveEmployeeHomeConfiguration(adminCtx(b),{companyId:b.companyId,audienceRole:'employee',expectedOrdinal:0,configuration,reason:'Fictional restricted-owner acceptance'});
 await saveOwnHomePersonPrivacy(peer.ctx,{expectedOrdinal:0,hideBirthday:true,hideAnniversary:false});
 expect(await withTenant(own.ctx,tx=>tx.select().from(s.employeeHomePersonPrivacyRevision))).toEqual([]);
 const role='home_privacy_'+randomUUID().replaceAll('-',''),rollback=new Error('rollback-home-restricted-owner');let verified=false;
 try{await owner.withTenant(own.ctx,async tx=>{
  await tx.execute(sql.raw(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`));
  await tx.execute(sql.raw(`GRANT USAGE ON SCHEMA public,app TO ${role}`));
  // Production's migration owner owns these transitive tables and functions. Granting only SELECT
  // would exercise a different RLS environment and could conceal the permitted positive cohort.
  const tables=['company','employment','assignment','person','app_user','reporting_line','employee_home_configuration_revision',
   'employee_home_person_privacy_revision','leave_request','leave_request_date'];
  for(const table of tables)await tx.execute(sql.raw(`ALTER TABLE public.${table} OWNER TO ${role}`));
  await tx.execute(sql.raw(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role}`));
  await tx.execute(sql.raw(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO ${role}`));
  const names=['proven_company_date_points','leave_calendar_presence','own_home_dashboard_role','_home_peer_policy','_home_peer_cohort','home_team_page','home_celebration_page'];
  const functions=await tx.execute(sql`SELECT p.oid::regprocedure::text AS signature FROM pg_proc p
   JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app'
   AND p.proname=ANY(ARRAY[${sql.join(names.map(name=>sql`${name}`),sql`, `)}]::text[]) ORDER BY p.proname,p.oid`) as unknown as {signature:string}[];
  expect(functions).toHaveLength(names.length);
  for(const fn of functions)await tx.execute(sql.raw(`ALTER FUNCTION ${fn.signature} OWNER TO ${role}`));
  const [security]=await tx.execute(sql`SELECT rolsuper,rolbypassrls,pg_has_role('ai_hr_app',oid,'MEMBER') AS app_member
   FROM pg_roles WHERE rolname=${role}`) as unknown as {rolsuper:boolean;rolbypassrls:boolean;app_member:boolean}[];
  expect(security).toEqual({rolsuper:false,rolbypassrls:false,app_member:false});
  const [privacy]=await tx.execute(sql`SELECT relrowsecurity,relforcerowsecurity,pg_get_userbyid(relowner)::text AS owner
   FROM pg_class WHERE oid='public.employee_home_person_privacy_revision'::regclass`) as unknown as {relrowsecurity:boolean;relforcerowsecurity:boolean;owner:string}[];
  expect(privacy).toEqual({relrowsecurity:true,relforcerowsecurity:true,owner:role});
  await tx.execute(sql`SET LOCAL ROLE ai_hr_app`);
  const [projection]=await tx.execute(sql`SELECT app.home_celebration_page(${own.employmentId}::uuid) AS result`) as unknown as {result:{total:number;items:{kind:string;employmentId:string}[]}}[];
  expect(projection.result.total).toBe(1);expect(projection.result.items).toEqual([
   {employmentId:peer.employmentId,name:'Fictional private birthday',date:on,kind:'anniversary',years:4}]);
  expect(await tx.select().from(s.employeeHomePersonPrivacyRevision)).toEqual([]);
  await expect(tx.transaction(async attempt=>{
   await attempt.execute(sql`RESET ROLE`);
   await attempt.execute(sql`ALTER FUNCTION app.home_celebration_page(uuid,text,integer) OWNER TO postgres`);
   await attempt.execute(sql`SET LOCAL ROLE ai_hr_app`);
   await attempt.execute(sql`SELECT app.home_celebration_page(${own.employmentId}::uuid)`);
  })).rejects.toMatchObject({cause:expect.objectContaining({code:'42501',message:'Home privacy context unavailable'})});
  verified=true;throw rollback;
 });}catch(error){if(error!==rollback)throw error;}
 expect(verified).toBe(true);
 const roles=await owner.db.execute(sql`SELECT rolname FROM pg_roles WHERE rolname=${role}`);expect([...roles]).toEqual([]);
});
