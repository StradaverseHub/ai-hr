/** Reversible native query-plan experiment. Never changes an installation or supplies release evidence. */
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {sql,eq} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {readEmployeeHomeIdentity} from '../../core/employee-home';
import {withTenant,type SessionContext} from '../../db/client';
import * as s from '../../db/schema';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from '../harness';
beforeAll(migrateTestDb);afterAll(closeAll);

it('measures visibility candidates and native policy plan reuse across separate caller transactions',async()=>{
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


 const signatures=['app.visible_employment_ids()','app.grants_have_role_for(jsonb,text,uuid)','app.login_blocked_on(uuid,date)'];
 const definition=async(signature:string)=>{
  const [row]=await owner.client<{ddl:string;attributes:Record<string,unknown>}[]>`select pg_get_functiondef(oid)as ddl,to_jsonb(pg_proc)-'prosrc' as attributes from pg_proc where oid=${signature}::regprocedure`;
  return row;
 };
 const originals=await Promise.all(signatures.map(async signature=>({signature,...await definition(signature)})));
 const stable=(attributes:Record<string,unknown>)=>Object.fromEntries(Object.entries(attributes).filter(([key])=>key!=='prolang'));
 const read=async(ctx:SessionContext)=>{
  const [row]=await withTenant(ctx,tx=>tx.execute<{ids:string[]}>(sql`select app.visible_employment_ids() as ids`));return row.ids.sort();
 };
 const outcome=async(ctx:SessionContext)=>{
  try{return {ids:await read(ctx)};}catch(error){let cause:unknown=error;while(cause instanceof Error&&cause.cause)cause=cause.cause;return {code:(cause as {code?:string})?.code??'unclassified'};}
 };
 const probes=users.slice(0,100),expected=new Map<string,string[]>(),phases:Record<string,unknown>={};
 const measure=async(phase:string)=>{
  const started=performance.now(),times:{role:string;ms:number}[]=[];
  await Promise.all(probes.map(async user=>{
   for(let repeat=0;repeat<10;repeat++){
    const before=performance.now(),ids=await read(context(user));times.push({role:user.role,ms:performance.now()-before});
    if(phase==='original'&&repeat===0)expected.set(user.id,ids);else expect(ids).toEqual(expected.get(user.id));
    expect(ids).toContain(user.employmentId);
    if(user.role==='employee'&&user.index%50>=4)expect(ids).toEqual([user.employmentId]);
   }
  }));
  const roles=Object.fromEntries(['employee','manager','hr_admin'].map(role=>{
   const values=times.filter(row=>row.role===role).map(row=>row.ms).sort((a,b)=>a-b);
   return[role,{samples:values.length,p50Ms:values[Math.floor((values.length-1)*.5)],p95Ms:values[Math.floor((values.length-1)*.95)]}];
  }));phases[phase]={transactions:times.length,wallMs:performance.now()-started,roles};
 };
 const malformed={...context(users[4]),grants:[{role:'employee',companyId:'not-a-uuid'}]};
 const emptyMalformed={...adminCtx(foreign),grants:[{role:'employee',companyId:'not-a-uuid'}]};
 const manager=users[2];
 const withoutReports=async()=>{
  try{await owner.db.update(s.reportingLine).set({supersededAt:new Date()}).where(eq(s.reportingLine.managerEmploymentId,manager.employmentId));return await read(context(manager));}
  finally{await owner.db.update(s.reportingLine).set({supersededAt:null}).where(eq(s.reportingLine.managerEmploymentId,manager.employmentId));}
 };
 const archivedRead=async()=>{
  try{await owner.db.update(s.appUser).set({archivedAt:new Date()}).where(eq(s.appUser.id,users[4].id));
   await expect(readEmployeeHomeIdentity(context(users[4]))).rejects.toThrow();return await read(context(users[4]));}
  finally{await owner.db.update(s.appUser).set({archivedAt:null}).where(eq(s.appUser.id,users[4].id));}
 };
 const controls={malformed:await outcome(malformed),emptyMalformed:await outcome(emptyMalformed),foreign:await read(adminCtx(foreign)),revoked:await withoutReports(),archived:await archivedRead()};
 const forged={...context(users[4]),roles:['super_admin'],grants:[{role:'super_admin',companyId:null}]};
 const forgedIds=await read(forged);
 try{
  for(const phase of ['original','visibility-candidate','grant-plan-cache','login-plan-cache','restored']){
   if(phase==='visibility-candidate')await owner.client.unsafe(readFileSync(new URL('./visible-employment-admin-candidate.sql',import.meta.url),'utf8'));
   if(phase==='grant-plan-cache')await owner.client.unsafe(readFileSync(new URL('./grant-role-plan-cache.sql',import.meta.url),'utf8'));
   if(phase==='login-plan-cache')await owner.client.unsafe(readFileSync(new URL('./login-status-plan-cache.sql',import.meta.url),'utf8'));
   if(phase==='restored')for(const original of originals)await owner.client.unsafe(original.ddl);
   for(const original of originals)expect(stable((await definition(original.signature)).attributes)).toEqual(stable(original.attributes));
   await measure(phase);
   expect(await outcome(malformed)).toEqual(controls.malformed);expect(await outcome(emptyMalformed)).toEqual(controls.emptyMalformed);
   expect(await read(adminCtx(foreign))).toEqual(controls.foreign);expect(await read(forged)).toEqual(forgedIds);
   await expect(readEmployeeHomeIdentity(forged)).rejects.toThrow();
   expect(await withoutReports()).toEqual(controls.revoked);expect(await archivedRead()).toEqual(controls.archived);
   expect(await read(context(users[4]))).toEqual(expected.get(users[4].id));
   writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'authorization-planning.json'),JSON.stringify({kind:'COMPONENT_ONLY',principals:500,activeProbes:100,independentTransactionsPerPhase:1000,phases,boundariesPreserved:true,limitations:'Native visibility reads, not HTTP capacity. Each additional phase is cumulative; independent rollback experiments still required if attribution is uncertain.'},null,2));
  }
 }finally{for(const original of originals){await owner.client.unsafe(original.ddl);expect(await definition(original.signature)).toEqual({ddl:original.ddl,attributes:original.attributes});}}
},480000);
