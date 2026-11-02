/** Reversible query-plan experiment: current login and grants are evaluated on every statement. */
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {sql,eq} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../../db/client';
import * as s from '../../db/schema';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from '../harness';
beforeAll(migrateTestDb);afterAll(closeAll);
it('compares repeated live session guards and revocation outcomes before, during and after plan reuse',async()=>{
 await resetDb();const b=await seedBase(),base=adminCtx(b);
 const users=Array.from({length:500},(_,i)=>({id:randomUUID(),personId:randomUUID(),employmentId:randomUUID(),name:'Fictional session plan '+i}));
 await owner.db.insert(s.person).values(users.map(u=>({id:u.personId,tenantId:b.tenantId,fullName:u.name,primaryEmail:u.id+'@example.invalid'})));
 await owner.db.insert(s.employment).values(users.map(u=>({id:u.employmentId,tenantId:b.tenantId,personId:u.personId,companyId:b.companyId,hiredOn:'2025-01-01'})));
 await owner.db.insert(s.appUser).values(users.map(u=>({id:u.id,tenantId:b.tenantId,personId:u.personId,workosUserId:'session_plan_'+u.id})));
 await owner.db.insert(s.roleAssignment).values(users.map(u=>({tenantId:b.tenantId,appUserId:u.id,role:'employee' as const,companyId:b.companyId})));
 const definitions=[];
 for(const signature of ['app.principal_snapshot_current()','app.login_blocked_on(uuid,date)']){
  const [row]=await owner.client`select pg_get_functiondef(${signature}::regprocedure) as original,prosrc as body from pg_proc where oid=${signature}::regprocedure`;
  const name=signature.slice(4,signature.indexOf('(')),file=name==='principal_snapshot_current'?'0576_principal_snapshot_current.sql':'0579_configurable_access.sql';
  const source=readFileSync(new URL('../../db/migrations/'+file,import.meta.url),'utf8');
  const start=source.indexOf('CREATE FUNCTION app.'+name+'('),end=source.indexOf('$$;',start)+3;
  expect(start).toBeGreaterThanOrEqual(0);expect(end).toBeGreaterThan(start);
  const original=source.slice(start,end).replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION');
  const body=original.slice(original.indexOf('AS $$')+5,original.lastIndexOf('$$;'));
  const cached=original.replace('LANGUAGE sql','LANGUAGE plpgsql').replace(/AS (\$[^$]*\$)[\s\S]*\1/,(_all:string,delimiter:string)=>'AS '+delimiter+'\nBEGIN RETURN ('+body.trim().replace(/;$/,'')+'); END;\n'+delimiter);
  definitions.push({original,cached,installed:row.original});
 }
 const ctx=(u:typeof users[number]):SessionContext=>({...base,userId:u.id,personId:u.personId,roles:['employee'],grants:[{role:'employee',companyId:b.companyId}]});
 const probe=async()=>withTenant(ctx(users[0]),async tx=>{
  const first=await tx.execute(sql`select app.principal_snapshot_current() as current,app.login_blocked(${users[0].id}::uuid) as blocked`);
  await tx.execute(sql`select set_config('app.roles','super_admin',true)`);
  const forged=await tx.execute(sql`select app.principal_snapshot_current() as current`);
  return {current:first[0].current,blocked:first[0].blocked,forged:forged[0].current};
 });
 const phases:Record<string,unknown>={};
 try{
  for(const phase of ['baseline','candidate','baseline-after']){
   for(const definition of definitions)await owner.client.unsafe(phase==='candidate'?definition.cached:definition.original);
   const times:number[]=[],started=performance.now();
   const results=await Promise.allSettled(users.map(async u=>{
    const before=performance.now();
    const rows=await withTenant(ctx(u),tx=>tx.execute(sql`select app.principal_snapshot_current() as current,app.login_blocked(${u.id}::uuid) as blocked from generate_series(1,20)`));
    expect(rows).toHaveLength(20);expect(rows.every(row=>row.current===true&&row.blocked===false)).toBe(true);times.push(performance.now()-before);
   }));
   const elapsedMs=performance.now()-started,errors=results.flatMap(result=>result.status==='rejected'?[String(result.reason)]:[]);times.sort((a,b)=>a-b);
   expect(await probe()).toEqual({current:true,blocked:false,forged:false});
   try{
    await owner.db.update(s.appUser).set({archivedAt:new Date()}).where(eq(s.appUser.id,users[0].id));
    expect(await probe()).toEqual({current:false,blocked:true,forged:false});
   }finally{await owner.db.update(s.appUser).set({archivedAt:null}).where(eq(s.appUser.id,users[0].id));}
   try{
    await owner.db.update(s.employment).set({terminatedOn:'2025-01-02'}).where(eq(s.employment.id,users[0].employmentId));
    expect(await probe()).toEqual({current:false,blocked:true,forged:false});
   }finally{await owner.db.update(s.employment).set({terminatedOn:null}).where(eq(s.employment.id,users[0].employmentId));}
   expect(await probe()).toEqual({current:true,blocked:false,forged:false});
   phases[phase]={principals:500,guardPairsPerPrincipal:20,elapsedMs,p50Ms:times[249],p95Ms:times[474],maxMs:times.at(-1),errors,liveRevocationAndForgedRoleChecks:true};
   writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'session-read-plan.json'),JSON.stringify({kind:'REVERSIBLE_SESSION_PLAN_EXPERIMENT',releaseEligible:false,phases},null,2));
   expect(errors).toEqual([]);
  }
 }finally{for(const definition of definitions)await owner.client.unsafe(definition.installed);}
},180000);
