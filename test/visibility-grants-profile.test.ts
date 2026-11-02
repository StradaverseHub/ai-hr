/** Reversible component profile: reuse parsed grants within one native visibility call only. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from './harness';
beforeAll(migrateTestDb);afterAll(closeAll);
it('compares employee, manager and administrator visibility before, within and after parsed-grant reuse',async()=>{
 await resetDb();const b=await seedBase(),foreign=await seedBase();
 const companies=[b.companyId];for(let i=1;i<5;i++){const [c]=await owner.db.insert(s.company).values({tenantId:b.tenantId,country:'MY',legalName:'Fictional grant profile '+i}).returning();companies.push(c.id);}
 const users=Array.from({length:500},(_,i)=>({id:randomUUID(),personId:randomUUID(),employmentId:randomUUID(),companyId:companies[i%5]}));
 await owner.db.insert(s.person).values(users.map(u=>({id:u.personId,tenantId:b.tenantId,fullName:'Fictional grant profile',primaryEmail:u.id+'@example.invalid'})));
 await owner.db.insert(s.employment).values(users.map(u=>({id:u.employmentId,tenantId:b.tenantId,personId:u.personId,companyId:u.companyId,hiredOn:'2020-01-01'})));
 await owner.db.insert(s.appUser).values(users.map(u=>({id:u.id,tenantId:b.tenantId,personId:u.personId,workosUserId:'grant_profile_'+u.id})));
 await owner.db.insert(s.roleAssignment).values(users.map((u,i)=>({tenantId:b.tenantId,appUserId:u.id,role:(i===2?'manager':'employee') as 'manager'|'employee',companyId:u.companyId})));
 const reports=users.filter((u,i)=>i>2&&u.companyId===users[2].companyId).slice(0,10);
 await owner.db.insert(s.reportingLine).values(reports.map(u=>({tenantId:b.tenantId,managerEmploymentId:users[2].employmentId,subordinateEmploymentId:u.employmentId,lineType:'administrative' as const,validFrom:'2020-01-01'})));
 for(const table of ['employment','person','app_user','role_assignment','reporting_line'])await owner.client.unsafe('analyze '+table);
 const signature='app.visible_employment_ids()';
 const [original]=await owner.client`select pg_get_functiondef(p.oid)as definition,p.prosrc as body,to_jsonb(p)-'prosrc'as attributes from pg_proc p where p.oid=${signature}::regprocedure`;
 const declaration='DECLARE performance_has_admin boolean := false;',coarse='performance_has_admin := app.is_admin();',predicate='WHERE app.is_admin_for(c.company_id)';
 for(const marker of [declaration,coarse,predicate])expect(original.body.split(marker)).toHaveLength(2);
 const body=original.body.replace(declaration,declaration+'\n performance_admin_grants jsonb;').replace(coarse,coarse+`\n  IF performance_has_admin THEN
   SELECT jsonb_agg(jsonb_build_object('role',g.role,'companyId',g.company_id)) INTO performance_admin_grants FROM app.current_grants() g;
  END IF;`).replace(predicate,'WHERE app.grants_admin_for(performance_admin_grants,c.company_id)');
 const candidate=original.definition.replace(original.body,body);expect(candidate).not.toBe(original.definition);
 const profile={kind:'REVERSIBLE_COMPONENT_ONLY_NOT_500_USER_CAPACITY',phases:{} as Record<string,unknown>,restored:false};
 const save=()=>{if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(process.env.AIHR_FOCUSED_EVIDENCE_DIR+'/visibility-grants-profile.json',JSON.stringify(profile,null,2));};
 const ctx=(u:typeof users[number]):SessionContext=>({...adminCtx(b),userId:u.id,personId:u.personId,roles:[u===users[2]?'manager':'employee'],grants:[{role:u===users[2]?'manager':'employee',companyId:u.companyId}]});
 const burst=async(role:'employee'|'administrator'|'manager')=>{
  const start=performance.now();
  const results=await Promise.allSettled(users.map(async u=>{
   const context=role==='administrator'?adminCtx(b):role==='manager'?ctx(users[2]):ctx(u);
   const [row]=await withTenant(context,tx=>tx.execute<{ids:string[]}>(sql`select app.visible_employment_ids()as ids`));
   const expected=role==='administrator'?users.map(v=>v.employmentId):role==='manager'||u===users[2]?[users[2].employmentId,...reports.map(v=>v.employmentId)]:[u.employmentId];
   expect(row.ids).toEqual(expected.sort());
  }));expect(results.filter(r=>r.status==='rejected')).toEqual([]);return performance.now()-start;
 };
 const outcome=async(context:SessionContext,grants:string)=>{
  try{const [row]=await withTenant(context,async tx=>{await tx.execute(sql`select set_config('app.grants',${grants},true)`);return tx.execute<{ids:string[]}>(sql`select app.visible_employment_ids()as ids`);});return {ids:row.ids};}
  catch(error){let cause:unknown=error;for(let i=0;i<8&&cause&&typeof cause==='object';i++){if('code'in cause)return {code:String(cause.code)};cause='cause'in cause?cause.cause:undefined;}throw error;}
 };
 let baselineControls:unknown;
 try{
  for(const phase of ['original','candidate','restored']as const){
   await owner.client.unsafe(phase==='candidate'?candidate:original.definition);
   const [definition]=await owner.client`select pg_get_functiondef(p.oid)as definition,to_jsonb(p)-'prosrc'as attributes from pg_proc p where p.oid=${signature}::regprocedure`;
   expect(definition.attributes).toEqual(original.attributes);if(phase!=='candidate')expect(definition.definition).toBe(original.definition);
   const timings:Record<string,number[]>={};
   for(const role of ['employee','manager','administrator']as const){await burst(role);timings[role]=[await burst(role),await burst(role)];}
   const controls=[];
   for(const grants of ['[]','null','{}','{broken',JSON.stringify([{role:'employee',companyId:'invalid-uuid'}]),JSON.stringify([{role:'hr_admin',companyId:companies[0]}]),JSON.stringify([{role:'super_admin',companyId:null}])]){
    controls.push(await outcome(ctx(users[4]),grants));controls.push(await outcome(adminCtx(foreign),grants));
   }
   if(phase==='original')baselineControls=controls;else expect(controls).toEqual(baselineControls);
   const scoped=await outcome({...adminCtx(b),personId:null},JSON.stringify([{role:'hr_admin',companyId:companies[0]}]));
   expect(scoped).toEqual({ids:users.filter(u=>u.companyId===companies[0]).map(u=>u.employmentId).sort()});
   profile.phases[phase]={timings,controls:controls.length+1};save();
  }
 }finally{await owner.client.unsafe(original.definition);profile.restored=true;save();}
 const [restored]=await owner.client`select pg_get_functiondef(${signature}::regprocedure)as definition`;expect(restored.definition).toBe(original.definition);
},180000);
