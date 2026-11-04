/** Reversible native query-plan experiment. Never changes an installation or supplies release evidence. */
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {sql,eq} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../../db/client';
import * as s from '../../db/schema';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from '../harness';
beforeAll(migrateTestDb);afterAll(closeAll);

it('preserves native visibility while evaluating each company grant once',async()=>{
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

 const signature='app.visible_employment_ids()';
 const definition=async()=>{
  const [row]=await owner.client`select pg_get_functiondef(oid) as ddl, to_jsonb(pg_proc)-'prosrc' as attributes
   from pg_proc where oid=${signature}::regprocedure`;
  return row;
 };
 const original=await definition();
 const candidate=readFileSync(new URL('./visible-employment-company-guard.sql',import.meta.url),'utf8');
 const read=async(ctx:SessionContext)=>{
  const [row]=await withTenant(ctx,tx=>tx.execute<{ids:string[]}>(sql`select app.visible_employment_ids() as ids`));
  return [...row.ids].sort();
 };
 const probes=users.slice(0,100);
 const expected=new Map<string,string[]>();
 const phases:Record<string,{p95Ms:number;wallMs:number}>={};
 const measure=async(phase:string)=>{
  const start=performance.now();
  const durations=await Promise.all(probes.map(async user=>{
   const before=performance.now();
   const ids=await read(context(user));
   const duration=performance.now()-before;
   expect(ids).toContain(user.employmentId);
   if(phase==='original')expected.set(user.id,ids);
   else expect(ids).toEqual(expected.get(user.id));
   return duration;
  }));
  durations.sort((a,b)=>a-b);
  phases[phase]={p95Ms:durations[94],wallMs:performance.now()-start};
 };
 try{
  await measure('original');
  const foreignIds=await read(adminCtx(foreign));
  const forged={...context(users[4]),roles:['super_admin'],grants:[{role:'super_admin',companyId:null}]};
  const forgedIds=await read(forged);
  const manager=users[2];
  const withoutReports=async()=>{
   try{
    await owner.db.update(s.reportingLine).set({supersededAt:new Date()}).where(eq(s.reportingLine.managerEmploymentId,manager.employmentId));
    return await read(context(manager));
   }finally{
    await owner.db.update(s.reportingLine).set({supersededAt:null}).where(eq(s.reportingLine.managerEmploymentId,manager.employmentId));
   }
  };
  const revokedIds=await withoutReports();
  expect(revokedIds.length).toBeLessThan(expected.get(manager.id)!.length);
  await owner.client.unsafe(candidate);
  expect((await definition()).attributes).toEqual(original.attributes);
  await measure('candidate');
  expect(await read(adminCtx(foreign))).toEqual(foreignIds);
  expect(await read(forged)).toEqual(forgedIds);
  expect(await withoutReports()).toEqual(revokedIds);
  expect(await read(context(manager))).toEqual(expected.get(manager.id));
 }finally{
  await owner.client.unsafe(original.ddl);
 }
 expect(await definition()).toEqual(original);
 await measure('restored');
 writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'visibility-company-guard.json'),
  JSON.stringify({kind:'COMPONENT_ONLY',principals:users.length,activeProbes:probes.length,phases},null,2));
},480000);
