/** Reversible native query-plan experiment. Never changes an installation or supplies release evidence. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {sql,eq} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../../db/client';
import * as s from '../../db/schema';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from '../harness';
beforeAll(migrateTestDb);afterAll(closeAll);

it('isolates Home role and reporting-visibility query planning with fresh native role proofs',async()=>{
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
 await owner.db.insert(s.reportingLine).values(users.filter(u=>u.index%50===2||u.index%50===3).flatMap(manager=>users.filter(u=>u.companyId===manager.companyId&&u.index%50>=4+(manager.index%50-2)*10&&u.index%50<14+(manager.index%50-2)*10).map(u=>({tenantId:b.tenantId,managerEmploymentId:manager.employmentId,subordinateEmploymentId:u.employmentId,lineType:'administrative',validFrom:'2025-01-01'}))));
 for(const table of ['company','department','person','employment','assignment','app_user','role_assignment','reporting_line'])await owner.client.unsafe('analyze '+table);
 const context=(u:typeof users[number]):SessionContext=>({...base,userId:u.id,personId:u.personId,roles:[u.role],grants:[{role:u.role,companyId:u.companyId}]});
 const read=async(ctx:SessionContext,employmentId:string)=>{
  const [row]=await withTenant(ctx,tx=>tx.execute(sql`select app.own_home_dashboard_role(${employmentId}::uuid) as role`));return row.role;
 };
 const definitions=[];
 for(const signature of ['app.own_home_dashboard_role(uuid)','app.can_see_employment(uuid)','app.is_admin_report_of(uuid,uuid)','app.heads_department_of(uuid,uuid)']){
  const [row]=await owner.client`select pg_get_functiondef(${signature}::regprocedure) as original,prosrc as body,
   proowner::text,proacl::text,prosecdef,provolatile,proconfig from pg_proc where oid=${signature}::regprocedure`;
  expect(row.original).toContain('LANGUAGE sql');const at=row.original.indexOf('AS $function$');expect(at).toBeGreaterThan(0);
  const header=row.original.slice(0,at).replace('LANGUAGE sql','LANGUAGE plpgsql');
  const cached=header+'AS $home_role_plan$ BEGIN RETURN ('+row.body.trim().replace(/;$/,'')+'); END; $home_role_plan$;';
  const {original,body,...security}=row;
  definitions.push({signature,original,body,security,cached});
 }
 const phases:Record<string,unknown>={},probes=users.slice(0,100);
 try{
  for(const phase of ['baseline','role-plan','visibility-plans','baseline-after']){
   for(const [i,definition]of definitions.entries())await owner.client.unsafe((phase==='role-plan'&&i===0||phase==='visibility-plans'&&i>0)?definition.cached:definition.original);
   for(const definition of definitions){
    const [security]=await owner.client`select proowner::text,proacl::text,prosecdef,provolatile,proconfig from pg_proc where oid=${definition.signature}::regprocedure`;
    expect(security).toEqual(definition.security);
   }
   for(const u of probes.slice(0,5))expect(await read(context(u),u.employmentId)).toBe(u.expected);
   await owner.client`select pg_stat_statements_reset()`;
   const times:number[]=[],started=performance.now();
   const results=await Promise.allSettled(probes.map(async u=>{const before=performance.now();expect(await read(context(u),u.employmentId)).toBe(u.expected);times.push(performance.now()-before);}));
   const elapsedMs=performance.now()-started,errors=results.flatMap(result=>result.status==='rejected'?[String(result.reason)]:[]);times.sort((a,b)=>a-b);
   const statements=await owner.client`select calls,total_exec_time,total_plan_time,left(query,1600) as normalized_query from pg_stat_statements where query not like '%pg_stat_%' order by total_exec_time+total_plan_time desc limit 12`;
   // Reusing a plan must never reuse a principal, role grant or reporting assignment result.
   expect(await read(context(users[4]),users[5].employmentId)).toBeNull();
   expect(await read(adminCtx(foreign),users[4].employmentId)).toBeNull();
   expect(await read({...context(users[4]),roles:['super_admin'],grants:[{role:'super_admin',companyId:null}]},users[4].employmentId)).toBeNull();
   try{await owner.db.update(s.appUser).set({archivedAt:new Date()}).where(eq(s.appUser.id,users[4].id));expect(await read(context(users[4]),users[4].employmentId)).toBeNull();}
   finally{await owner.db.update(s.appUser).set({archivedAt:null}).where(eq(s.appUser.id,users[4].id));}
   try{await owner.db.update(s.reportingLine).set({supersededAt:new Date()}).where(eq(s.reportingLine.managerEmploymentId,users[2].employmentId));expect(await read(context(users[2]),users[2].employmentId)).toBe('employee');}
   finally{await owner.db.update(s.reportingLine).set({supersededAt:null}).where(eq(s.reportingLine.managerEmploymentId,users[2].employmentId));}
   expect(await read(context(users[2]),users[2].employmentId)).toBe('manager');
   phases[phase]={principalInventory:500,activeProbes:100,elapsedMs,p50Ms:times[49],p95Ms:times[94],maxMs:times.at(-1),errors,liveBoundaryChecks:true,statements};
   writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'home-role-query.json'),JSON.stringify({kind:'REVERSIBLE_HOME_ROLE_PLAN_EXPERIMENT',releaseEligible:false,phases},null,2));expect(errors).toEqual([]);
  }
 }finally{for(const definition of definitions)await owner.client.unsafe(definition.original);}
},480000);
