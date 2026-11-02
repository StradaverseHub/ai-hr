/** Reversible component experiment. Existing eligibility decisions and migration source stay intact. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {withTenant,type Tx} from '../db/client';
import * as s from '../db/schema';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from './harness';
beforeAll(migrateTestDb);afterAll(closeAll);
it('compares original, plan reuse and restored wrapper while checking live native eligibility',async()=>{
 await resetDb();const b=await seedBase(),foreign=await seedBase();
 const users=Array.from({length:500},()=>({personId:randomUUID(),employmentId:randomUUID(),userId:randomUUID()}));
 await owner.db.insert(s.person).values(users.map(u=>({id:u.personId,tenantId:b.tenantId,fullName:'Fictional login profile',primaryEmail:u.userId+'@example.invalid'})));
 await owner.db.insert(s.employment).values(users.map(u=>({id:u.employmentId,tenantId:b.tenantId,personId:u.personId,companyId:b.companyId,hiredOn:'2020-01-01'})));
 await owner.db.insert(s.appUser).values(users.map(u=>({id:u.userId,tenantId:b.tenantId,personId:u.personId,workosUserId:'login_plan_'+u.userId})));
 for(const table of ['person','employment','app_user'])await owner.client.unsafe('analyze '+table);
 const signature='app.login_blocked(uuid)';
 const [original]=await owner.client`select pg_get_functiondef(p.oid)as definition,p.prosrc as body,l.lanname as language,to_jsonb(p)-'prosrc'-'prolang'as attributes from pg_proc p join pg_language l on l.oid=p.prolang where p.oid=${signature}::regprocedure`;
 expect(original.language).toBe('sql');
 const body=original.body.trim().replace(/;$/,'');
 expect(body).toMatch(/^SELECT\s+app\.login_blocked_on\(p_user_id,\s*current_date\)$/i);
 const candidate=original.definition.replace('LANGUAGE sql','LANGUAGE plpgsql').replace(original.body,'\nBEGIN\n RETURN (\n'+body+'\n );\nEND;\n');
 expect(candidate).not.toBe(original.definition);
 const profile={kind:'REVERSIBLE_COMPONENT_ONLY_NOT_500_USER_CAPACITY',callsPerBurst:10000,rows:{} as Record<string,number[]>,controls:0,restored:false};
 const save=()=>{if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(process.env.AIHR_FOCUSED_EVIDENCE_DIR+'/login-wrapper-plan-profile.json',JSON.stringify(profile,null,2));};
 const burst=async()=>{
  const start=performance.now();
  const rows=await withTenant(adminCtx(b),tx=>tx.execute<{userId:string;blocked:boolean}>(sql`select u.id::text as "userId",app.login_blocked(u.id)as blocked from unnest(${sql.raw('ARRAY['+users.map(u=>"'"+u.userId+"'::uuid").join(',')+']')})u(id) cross join generate_series(1,20)n`));
  expect(rows).toHaveLength(10000);expect(rows.every(row=>row.blocked===false)).toBe(true);
  const counts=new Map<string,number>();for(const row of rows)counts.set(row.userId,(counts.get(row.userId)??0)+1);
  expect(counts.size).toBe(500);expect([...counts.values()].every(n=>n===20)).toBe(true);
  return performance.now()-start;
 };
 const oracle=async(tx:Tx,id:string|null,expected:boolean)=>{
  const [row]=await tx.execute<{actual:boolean;donor:boolean}>(sql`select app.login_blocked(${id}::uuid)as actual,app.login_blocked_on(${id}::uuid,current_date)as donor`);
  expect(row.actual).toBe(row.donor);expect(row.actual).toBe(expected);profile.controls++;
 };
 try{
  await burst();profile.rows.original=[];for(let i=0;i<3;i++)profile.rows.original.push(await burst());save();
  await owner.client.unsafe(candidate);
  const [changed]=await owner.client`select l.lanname as language,to_jsonb(p)-'prosrc'-'prolang'as attributes from pg_proc p join pg_language l on l.oid=p.prolang where p.oid=${signature}::regprocedure`;
  expect(changed.language).toBe('plpgsql');expect(changed.attributes).toEqual(original.attributes);
  await burst();profile.rows.candidate=[];for(let i=0;i<3;i++)profile.rows.candidate.push(await burst());save();
  const a=users[0];
  await withTenant(adminCtx(b),async tx=>{
   await oracle(tx,a.userId,false);await oracle(tx,null,false);await oracle(tx,randomUUID(),false);await oracle(tx,foreign.adminUserId,false);
   await tx.execute(sql`select set_config('app.user_id',${users[1].userId},true),set_config('app.tenant_id',${foreign.tenantId},true),set_config('app.roles','super_admin',true)`);
   await oracle(tx,a.userId,false);
   await owner.client`update app_user set archived_at=now()where id=${a.userId}::uuid`;await oracle(tx,a.userId,true);
   await owner.client`update app_user set archived_at=null where id=${a.userId}::uuid`;await oracle(tx,a.userId,false);
   await owner.client`update employment set blacklisted_at=now()where id=${a.employmentId}::uuid`;await oracle(tx,a.userId,true);
   await owner.client`update employment set blacklisted_at=null,resignation_date=current_date-1 where id=${a.employmentId}::uuid`;await oracle(tx,a.userId,true);
   await owner.client`update employment set resignation_date=current_date where id=${a.employmentId}::uuid`;await oracle(tx,a.userId,false);
   await owner.client`update employment set resignation_date=current_date+1 where id=${a.employmentId}::uuid`;await oracle(tx,a.userId,false);
   await owner.client`update employment set resignation_date=null where id=${a.employmentId}::uuid`;await oracle(tx,a.userId,false);
  });
 }finally{
  await owner.client.unsafe(original.definition);profile.restored=true;save();
 }
 const [restored]=await owner.client`select pg_get_functiondef(${signature}::regprocedure)as definition`;expect(restored.definition).toBe(original.definition);
 await burst();profile.rows.restored=[];for(let i=0;i<3;i++)profile.rows.restored.push(await burst());save();
},180000);
