/** Installed native migration controls: every principal, scope and revocation remains fresh. */
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {sql,eq} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {assertAssignedWorkPrincipalTx} from '../core/approvals';
import {readEmployeeHomeIdentity} from '../core/employee-home';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from './harness';
beforeAll(migrateTestDb);afterAll(closeAll);

it('keeps installed authorization plans fresh across principals and live revocations',async()=>{
 await resetDb();const b=await seedBase(),foreign=await seedBase(),base=adminCtx(b);
 const companies=await owner.db.insert(s.company).values(Array.from({length:10},(_,i)=>({tenantId:b.tenantId,country:'MY',legalName:'Fictional role-profile company '+i}))).returning();
 const departments=await owner.db.insert(s.department).values(companies.map(c=>({tenantId:b.tenantId,companyId:c.id,name:'Fictional role-profile department'}))).returning();
 const users=Array.from({length:500},(_,i)=>({index:i,id:randomUUID(),personId:randomUUID(),employmentId:randomUUID(),companyId:companies[Math.floor(i/50)].id,departmentId:departments[Math.floor(i/50)].id,
  role:(i%50<2?'hr_admin':i%50===3?'manager':'employee') as 'hr_admin'|'manager'|'employee',expected:i%50<2?'hr_admin':i%50<4?'manager':'employee'}));
 await owner.db.insert(s.person).values(users.map(u=>({id:u.personId,tenantId:b.tenantId,fullName:'Fictional Home role '+u.index,primaryEmail:u.id+'@example.invalid'})));
 await owner.db.insert(s.employment).values(users.map(u=>({id:u.employmentId,tenantId:b.tenantId,personId:u.personId,companyId:u.companyId,hiredOn:'2025-01-01'})));
 await owner.db.insert(s.assignment).values(users.map(u=>({tenantId:b.tenantId,employmentId:u.employmentId,companyId:u.companyId,departmentId:u.departmentId,employmentType:'full_time' as const,validFrom:'2025-01-01'})));
 await owner.db.insert(s.appUser).values(users.map(u=>({id:u.id,tenantId:b.tenantId,personId:u.personId,workosUserId:'home_role_profile_'+u.id})));
 await owner.db.insert(s.roleAssignment).values(users.map(u=>({tenantId:b.tenantId,appUserId:u.id,role:u.role,companyId:u.companyId})));
 await owner.db.insert(s.reportingLine).values(users.filter(u=>u.index%50===2||u.index%50===3).flatMap(manager=>users.filter(u=>u.companyId===manager.companyId&&u.index%50>=4+(manager.index%50-2)*10&&u.index%50<14+(manager.index%50-2)*10).map(u=>({tenantId:b.tenantId,managerEmploymentId:manager.employmentId,subordinateEmploymentId:u.employmentId,lineType:'administrative' as const,validFrom:'2025-01-01'}))));
 for(const table of ['company','department','person','employment','assignment','app_user','role_assignment','reporting_line'])await owner.client.unsafe('analyze '+table);
 const context=(u:typeof users[number]):SessionContext=>({...base,userId:u.id,personId:u.personId,roles:[u.role],grants:[{role:u.role,companyId:u.companyId}]});


 const signatures=['app.visible_employment_ids()','app.login_blocked_on(uuid,date)'];
 const definition=async(signature:string)=>{
  const [row]=await owner.client<{ddl:string;attributes:Record<string,unknown>}[]>`select pg_get_functiondef(oid)as ddl,to_jsonb(pg_proc)-'prosrc' as attributes from pg_proc where oid=${signature}::regprocedure`;
  return row;
 };
 const originals=await Promise.all(signatures.map(async signature=>({signature,...await definition(signature)})));
 const read=async(ctx:SessionContext)=>{
  return withTenant(ctx,async tx=>{
   await assertAssignedWorkPrincipalTx(tx,ctx);
   const [row]=await tx.execute<{ids:string[]}>(sql`select app.visible_employment_ids() as ids`);return row.ids.sort();
  });
 };
 const outcome=async(ctx:SessionContext)=>{
  try{return {ids:await read(ctx)};}catch(error){let cause:unknown=error;while(cause instanceof Error&&cause.cause)cause=cause.cause;return {code:(cause as {code?:string})?.code??'unclassified',name:(error as Error).name};}
 };
 const probes=users.slice(0,100),expected=new Map<string,string[]>();
 const measure=async()=>Promise.all(probes.map(async user=>{
  for(let repeat=0;repeat<10;repeat++){
   const ids=await read(context(user));
   if(repeat===0)expected.set(user.id,ids);else expect(ids).toEqual(expected.get(user.id));
   expect(ids).toContain(user.employmentId);
   if(user.role==='employee'&&user.index%50>=4)expect(ids).toEqual([user.employmentId]);
  }
 }));
 const malformed={...context(users[4]),grants:[{role:'employee',companyId:'not-a-uuid'}]};
 const emptyMalformed={...adminCtx(foreign),grants:[{role:'employee',companyId:'not-a-uuid'}]};
 const manager=users[2];
 const withoutReports=async()=>{
  try{await owner.db.update(s.reportingLine).set({supersededAt:new Date()}).where(eq(s.reportingLine.managerEmploymentId,manager.employmentId));return await read(context(manager));}
  finally{await owner.db.update(s.reportingLine).set({supersededAt:null}).where(eq(s.reportingLine.managerEmploymentId,manager.employmentId));}
 };
 const archivedRead=async()=>{
  try{await owner.db.update(s.appUser).set({archivedAt:new Date()}).where(eq(s.appUser.id,users[4].id));
   await expect(readEmployeeHomeIdentity(context(users[4]))).rejects.toThrow();return await outcome(context(users[4]));}
  finally{await owner.db.update(s.appUser).set({archivedAt:null}).where(eq(s.appUser.id,users[4].id));}
 };
 const changedGrant=async()=>{
  const admin=users[0],stale=context(admin),fresh:SessionContext={...stale,roles:['employee'],grants:[{role:'employee',companyId:admin.companyId}]};
  try{
   await owner.db.update(s.roleAssignment).set({role:'employee'}).where(eq(s.roleAssignment.appUserId,admin.id));
   const refusal=await outcome(stale);expect(refusal).toMatchObject({name:'AssignedWorkPrincipalUnavailableError'});
   await expect(readEmployeeHomeIdentity(stale)).rejects.toThrow();
   const ids=await read(fresh);expect(ids).toEqual([admin.employmentId]);
   expect(await readEmployeeHomeIdentity(fresh)).toMatchObject({role:'employee',selectedEmploymentId:admin.employmentId});
   return {refusal,ids};
  }finally{await owner.db.update(s.roleAssignment).set({role:'hr_admin'}).where(eq(s.roleAssignment.appUserId,admin.id));}
 };
 const controls={malformed:await outcome(malformed),emptyMalformed:await outcome(emptyMalformed),foreign:await read(adminCtx(foreign)),revoked:await withoutReports(),archived:await archivedRead(),changedGrant:await changedGrant()};
 const forged={...context(users[4]),roles:['super_admin'],grants:[{role:'super_admin',companyId:null}]};
 const forgedOutcome=await outcome(forged);
 // Test the migration already applied by the runner; never replace native functions here.
 for(const signature of signatures){
  const [row]=await owner.client`select l.lanname,p.prosecdef,p.provolatile from pg_proc p join pg_language l on l.oid=p.prolang where p.oid=${signature}::regprocedure`;
  expect(row).toMatchObject({lanname:'plpgsql',prosecdef:true,provolatile:'s'});
 }
 await measure();
 // A current administrative manager also heads the shared department under the
 // existing HOD rule: both it and HR see exactly that company's50 employments.
 const companyIds=users.filter(user=>user.companyId===users[0].companyId).map(user=>user.employmentId).sort();
 expect(await read(context(users[0]))).toEqual(companyIds);
 expect(await read(context(users[2]))).toEqual(companyIds);
 expect(await outcome(malformed)).toEqual(controls.malformed);expect(await outcome(emptyMalformed)).toEqual(controls.emptyMalformed);
 expect(await read(adminCtx(foreign))).toEqual(controls.foreign);expect(await outcome(forged)).toEqual(forgedOutcome);
 await expect(readEmployeeHomeIdentity(forged)).rejects.toThrow();
 expect(await withoutReports()).toEqual(controls.revoked);expect(await archivedRead()).toEqual(controls.archived);expect(await changedGrant()).toEqual(controls.changedGrant);
 for(const original of originals)expect(await definition(original.signature)).toEqual({ddl:original.ddl,attributes:original.attributes});
 const migration=readFileSync(new URL('../db/migrations/2105_authorization_navigation_plans.sql',import.meta.url),'utf8');
 for(const name of ['visible-employment-admin-candidate.sql','login-status-plan-cache.sql'])expect(migration).toContain(readFileSync(new URL('./performance/'+name,import.meta.url),'utf8').trim());
},480000);
