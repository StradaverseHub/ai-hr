/** Reversible development profile of the real dated-company reader. No application/migration change. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import * as s from '../db/schema';
import {provenCompanyDatesTx} from '../core/employment-company';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from './harness';
beforeAll(migrateTestDb);afterAll(closeAll);
const signature='app.proven_company_date_points(jsonb)';
it('profiles original / cached query plan / restored with live caller RLS and an independent SQL oracle',async()=>{
 await resetDb();const b=await seedBase(),foreign=await seedBase(),today=todayInKualaLumpur();
 const users=Array.from({length:500},()=>({personId:randomUUID(),employmentId:randomUUID(),userId:randomUUID()}));
 await owner.db.insert(s.person).values(users.map(u=>({id:u.personId,tenantId:b.tenantId,fullName:'Fictional dated-company profile',primaryEmail:u.userId+'@example.invalid'})));
 await owner.db.insert(s.employment).values(users.map(u=>({id:u.employmentId,tenantId:b.tenantId,personId:u.personId,companyId:b.companyId,hiredOn:'2020-01-01'})));
 await owner.db.insert(s.assignment).values(users.map(u=>({tenantId:b.tenantId,employmentId:u.employmentId,departmentId:b.deptA,companyId:b.companyId,employmentType:'full_time' as const,validFrom:'2020-01-01'})));
 await owner.db.insert(s.appUser).values(users.map(u=>({id:u.userId,tenantId:b.tenantId,personId:u.personId,workosUserId:'date_plan_'+u.userId})));
 await owner.db.insert(s.roleAssignment).values(users.map(u=>({tenantId:b.tenantId,appUserId:u.userId,role:'employee' as const,companyId:b.companyId})));
 for(const table of ['person','employment','assignment','app_user','role_assignment'])await owner.client.unsafe('analyze '+table);
 const ctx=(u:typeof users[number]):SessionContext=>({...adminCtx(b),userId:u.userId,personId:u.personId,roles:['employee'],grants:[{role:'employee',companyId:b.companyId}]});
 const [original]=await owner.client`select pg_get_functiondef(p.oid) as definition,p.prosrc as body,l.lanname as language,to_jsonb(p)-'prosrc'-'prolang' as attributes from pg_proc p join pg_language l on l.oid=p.prolang where p.oid=${signature}::regprocedure`;
 expect(original.language).toBe('sql');expect(original.body).toContain('jsonb_to_recordset(p_points)');
 const body=original.body.trim().replace(/;$/,'');const pieces=body.split('p_points');expect(pieces).toHaveLength(2);
 const candidate=original.definition.replace('LANGUAGE sql','LANGUAGE plpgsql').replace(original.body,'\nBEGIN\n RETURN QUERY\n'+body+';\nEND;\n');
 expect(candidate).not.toBe(original.definition);
 const profile:{kind:string;rows:Record<string,number>;controls:number;restored:boolean}={kind:'REVERSIBLE_COMPONENT_ONLY_NOT_500_USER_CAPACITY',rows:{},controls:0,restored:false};
 const save=()=>{if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(process.env.AIHR_FOCUSED_EVIDENCE_DIR+'/dated-company-plan-profile.json',JSON.stringify(profile,null,2));};
 const burst=async(role:'employee'|'administrator')=>{
  const started=performance.now();
  const results=await Promise.allSettled(users.map(async u=>{
   const value=await withTenant(role==='employee'?ctx(u):adminCtx(b),tx=>provenCompanyDatesTx(tx,[{employmentId:u.employmentId,date:today}]));
   expect(value.get(u.employmentId+'|'+today)).toEqual({companyId:b.companyId,reason:null});
  }));
  expect(results.filter(r=>r.status==='rejected')).toEqual([]);return performance.now()-started;
 };
 type Point={employmentId:string;date:string};
 const oracle=async(tx:Tx,points:unknown)=>{
  const serialized=JSON.stringify(points);
  const donor=(inner:Tx)=>inner.execute(sql`select employment_id::text as "employmentId",on_date::text as date,company_id::text as "companyId",reason from (${sql.raw(pieces[0])}${serialized}::jsonb${sql.raw(pieces[1])}) original order by employment_id,on_date`);
  const current=(inner:Tx)=>inner.execute(sql`select employment_id::text as "employmentId",on_date::text as date,company_id::text as "companyId",reason from app.proven_company_date_points(${serialized}::jsonb) order by employment_id,on_date`);
  const settle=async(run:(inner:Tx)=>PromiseLike<unknown>)=>{
   try{return {rows:await tx.transaction(async inner=>await run(inner))};}
   catch(error){let value:unknown=error;for(let i=0;i<5&&value&&typeof value==='object';i++){if('code'in value)return {sqlState:String(value.code)};value='cause'in value?value.cause:undefined;}throw error;}
  };
  expect(await settle(current)).toEqual(await settle(donor));profile.controls++;
 };
 try{
  // Warm the unchanged surrounding principal/visibility owners before either timed body.
  await burst('employee');await burst('administrator');
  for(const role of ['employee','administrator'] as const){profile.rows['original-'+role]=await burst(role);save();}
  await owner.client.unsafe(candidate);
  const [changed]=await owner.client`select l.lanname as language,to_jsonb(p)-'prosrc'-'prolang' as attributes from pg_proc p join pg_language l on l.oid=p.prolang where p.oid=${signature}::regprocedure`;
  expect(changed.language).toBe('plpgsql');expect(changed.attributes).toEqual(original.attributes);
  for(const role of ['employee','administrator'] as const){profile.rows['candidate-'+role]=await burst(role);save();}
  const a=users[0],other=users[1];
  const points:Point[]=[{employmentId:a.employmentId,date:today},{employmentId:a.employmentId,date:'2019-12-31'},{employmentId:other.employmentId,date:today},{employmentId:randomUUID(),date:today}];
  await withTenant(ctx(a),async tx=>{
   for(const input of [points,[],null,{invalid:true},[{employmentId:'not-a-uuid',date:today}]])await oracle(tx,input);
   await tx.execute(sql`select set_config('app.user_id',${other.userId},true)`);await oracle(tx,points);
   await tx.execute(sql`select set_config('app.tenant_id',${foreign.tenantId},true)`);await oracle(tx,points);
   await tx.execute(sql`select set_config('app.tenant_id',${b.tenantId},true),set_config('app.user_id',${a.userId},true),set_config('app.roles','super_admin',true)`);await oracle(tx,points);
  });
  await withTenant(adminCtx(b),tx=>oracle(tx,points));
  await withTenant(ctx(a),async tx=>{
   try{
    await owner.client`update app_user set archived_at=now() where id=${a.userId}::uuid`;
    await oracle(tx,points);
   }finally{await owner.client`update app_user set archived_at=null where id=${a.userId}::uuid`;}
   await oracle(tx,points);
   try{
    await owner.client`update assignment set valid_to=${today}::date where employment_id=${a.employmentId}::uuid`;
    await oracle(tx,points);
   }finally{await owner.client`update assignment set valid_to=null where employment_id=${a.employmentId}::uuid`;}
   await oracle(tx,points);
  });
 }finally{await owner.client.unsafe(original.definition);profile.restored=true;save();}
 const [restored]=await owner.client`select pg_get_functiondef(${signature}::regprocedure) as definition`;expect(restored.definition).toBe(original.definition);
 for(const role of ['employee','administrator'] as const){profile.rows['restored-'+role]=await burst(role);save();}
},180000);
