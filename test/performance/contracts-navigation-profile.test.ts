/** Reversible native query-plan experiment. Never changes an installation or supplies release evidence. */
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {sql,eq} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../../db/client';
import * as s from '../../db/schema';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,setModule} from '../harness';
beforeAll(migrateTestDb);afterAll(closeAll);

it('skips impossible Contract roles while retaining native navigation and live authority',async()=>{
 await resetDb();const b=await seedBase(),foreign=await seedBase();await setModule(b.tenantId,'lifecycle','active');const base=adminCtx(b);
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


 const signatures=['app.contract_has_role(uuid,uuid,text)','app.contract_hr_admin(uuid)','app.contract_configure(uuid)','app.contract_gbs_company_scope(uuid)'];
 const definition=async(signature:string)=>{
  const [row]=await owner.client<{ddl:string;attributes:Record<string,unknown>}[]>`select pg_get_functiondef(oid)as ddl,to_jsonb(pg_proc)-'prosrc' as attributes from pg_proc where oid=${signature}::regprocedure`;
  return row;
 };
 const originals=await Promise.all(signatures.map(async signature=>({signature,...await definition(signature)})));
 const read=async(ctx:SessionContext)=>{
  const [row]=await withTenant(ctx,tx=>tx.execute<{access:{page:boolean;intake:boolean;configure:boolean}}>(sql`select app.contract_navigation_access() as access`));return row.access;
 };
 const expected=new Map<string,unknown>(),phases:Record<string,unknown>={},probes=users.slice(0,100);
 const measure=async(phase:string)=>{
  const start=performance.now(),times:{ms:number;role:string}[]=[];
  await Promise.all(probes.map(async user=>{
   const before=performance.now(),access=await read(context(user));times.push({ms:performance.now()-before,role:user.role});
   if(phase==='original'){
    expected.set(user.id,access);
    if(user.role==='hr_admin')expect(access).toMatchObject({page:true,configure:true});
    else expect(access).toEqual({page:false,intake:false,configure:false});
   }else expect(access).toEqual(expected.get(user.id));
  }));
  const summaries=Object.fromEntries(['employee','manager','hr_admin'].map(role=>{
   const rows=times.filter(row=>row.role===role).map(row=>row.ms).sort((a,b)=>a-b);
   return[role,{samples:rows.length,p95Ms:rows[Math.floor((rows.length-1)*.95)]}];
  }));phases[phase]={wallMs:performance.now()-start,roles:summaries};
 };
 const controls=async()=>{
  const user=users[4],ctx=context(user);
  expect(await read({...ctx,roles:['super_admin'],grants:[{role:'super_admin',companyId:null}]})).toEqual({page:false,intake:false,configure:false});
  const admin=users[0];
  try{await owner.db.update(s.appUser).set({archivedAt:new Date()}).where(eq(s.appUser.id,admin.id));expect(await read(context(admin))).toEqual({page:false,intake:false,configure:false});}
  finally{await owner.db.update(s.appUser).set({archivedAt:null}).where(eq(s.appUser.id,admin.id));}
  expect(await read(context(admin))).toMatchObject({page:true,configure:true});
  expect(await read(adminCtx(foreign))).toEqual({page:false,intake:false,configure:false});
 };
 try{
  await measure('original');await controls();
  await owner.client.unsafe(readFileSync(new URL('./contract-navigation-guards.sql',import.meta.url),'utf8'));
  for(const original of originals)expect((await definition(original.signature)).attributes).toEqual(original.attributes);
  await measure('candidate');await measure('candidate-warm');await controls();
  for(const original of originals)await owner.client.unsafe(original.ddl);
  await measure('restored');
 }finally{for(const original of originals){await owner.client.unsafe(original.ddl);expect(await definition(original.signature)).toEqual({ddl:original.ddl,attributes:original.attributes});}}
 writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'contract-navigation-guards.json'),JSON.stringify({kind:'COMPONENT_ONLY',principals:500,activeProbes:100,phases,ownerAclConfigPreserved:true,allDefinitionsRestored:true,limitations:'No Contract cases or canonical GBS/PBP fixture; positive workflow/assignment functional suites remain required before integration.'},null,2));
},480000);
