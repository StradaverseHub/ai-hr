/** Diagnostic only: actual OT-stage discovery with target-only prepared plans; no production adapter change. */
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID,createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {client,withTenant,type SessionContext} from '../../db/client';
import * as s from '../../db/schema';
import {hasOvertimePatternForDayTx} from '../../packs/attendance/overtime-patterns';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from '../harness';
beforeAll(migrateTestDb);afterAll(closeAll);
type Wire={unsafe:(...args:any[])=>any;begin?:(...args:any[])=>any;savepoint?:(...args:any[])=>any};
it('measures empty-formula actual stage detection before, during and after target-only plan reuse',async()=>{
 expect(process.env.GITHUB_ACTIONS).toBe('true');expect(new URL(process.env.TEST_DATABASE_URL!).hostname).toBe('127.0.0.1');
 await resetDb();await owner.client`create extension if not exists pg_stat_statements`;const day=todayInKualaLumpur();
 const tenants=[await seedBase(),await seedBase()];
 const users=tenants.flatMap((b,t)=>Array.from({length:250},(_,i)=>({tenant:t,id:randomUUID(),personId:randomUUID(),employmentId:randomUUID(),role:(i===0||i===1?'hr_admin':i===2?'manager':'employee') as 'hr_admin'|'manager'|'employee',group:i===0})));
 for(let t=0;t<2;t++){
  const b=tenants[t],rows=users.filter(u=>u.tenant===t);
  await owner.db.insert(s.person).values(rows.map((u,i)=>({id:u.personId,tenantId:b.tenantId,fullName:'Fictional plan participant '+t+'-'+i,primaryEmail:u.id+'@example.test'})));
  await owner.db.insert(s.employment).values(rows.map(u=>({id:u.employmentId,tenantId:b.tenantId,personId:u.personId,companyId:b.companyId,hiredOn:'2020-01-01'})));
  await owner.db.insert(s.assignment).values(rows.map(u=>({tenantId:b.tenantId,employmentId:u.employmentId,departmentId:b.deptA,companyId:b.companyId,employmentType:'full_time' as const,validFrom:'2020-01-01'})));
  await owner.db.insert(s.appUser).values(rows.map(u=>({id:u.id,tenantId:b.tenantId,personId:u.personId,workosUserId:'prepared_profile_'+u.id})));
  await owner.db.insert(s.roleAssignment).values(rows.map(u=>({tenantId:b.tenantId,appUserId:u.id,role:u.role,companyId:u.group?null:b.companyId})));
 }
 for(let t=0;t<2;t++)await owner.db.insert(s.attendance).values(users.filter(u=>u.tenant===t).map(u=>({tenantId:tenants[t].tenantId,employmentId:u.employmentId,attendanceDate:day})));
 for(const table of ['person','employment','assignment','app_user','role_assignment','attendance','overtime_pattern','overtime_pattern_version','overtime_pattern_assignment'])await owner.client.unsafe('analyze '+table);
 const ctx=(u:typeof users[number]):SessionContext=>({...adminCtx(tenants[u.tenant]),userId:u.id,personId:u.personId,roles:[u.role],grants:[{role:u.role,companyId:u.group?null:tenants[u.tenant].companyId}]});
 const pool=client as unknown as Wire,originalUnsafe=pool.unsafe,originalBegin=pool.begin;
 const store=new AsyncLocalStorage<Wire>(),seen=new WeakSet<object>(),templates=new Set<string>();
 let enabled=false,captured:{query:string;params:unknown[]}|undefined;let selectedCalls=0;
 function instrument(connection:Wire):Wire{
  if(seen.has(connection))return connection;seen.add(connection);
  const raw=connection.unsafe;
  connection.unsafe=function(...args:any[]){
   const [query,params,options]=args;
   if(!captured&&typeof query==='string'&&query.includes('"overtime_pattern_assignment"')&&query.includes('"superseded_at"')&&Array.isArray(params))captured={query,params:params.slice()};
   if(enabled&&typeof query==='string'&&query.includes('"overtime_pattern_assignment"')&&query.includes('"superseded_at"')&&Array.isArray(params)&&params.length>0&&options?.prepare!==false&&options?.simple!==true&&(templates.has(query)||templates.size<128)){
    templates.add(query);selectedCalls++;return Reflect.apply(raw,connection,[query,params,{...options,prepare:true}]);
   }
   return Reflect.apply(raw,connection,args);
  };
  for(const key of ['begin','savepoint'] as const){const original=connection[key];if(typeof original!=='function')continue;
   connection[key]=function(...args:any[]){const index=args.findIndex(value=>typeof value==='function');if(index>=0){const callback=args[index];args[index]=function(this:unknown,...inputs:any[]){const nested=instrument(inputs[0]);inputs[0]=nested;return store.run(nested,()=>Reflect.apply(callback,this,inputs));};}return Reflect.apply(original,connection,args);};
  }
  return connection;
 }

 const reports:Record<string,unknown>={};
 const save=()=>writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'overtime-discovery-work.json'),JSON.stringify({kind:'REVERSIBLE_TARGET_ONLY_OT_DISCOVERY_PLAN_EXPERIMENT',releaseEligible:false,sourceCase:'500 visible attendance rows; no formula assignments',principals:500,tenants:2,templateCount:templates.size,capturedQuerySha256:captured?createHash('sha256').update(captured.query).digest('hex'):null,reports},null,2));
 const read=async(u:typeof users[number])=>{const answer=await withTenant(ctx(u),tx=>hasOvertimePatternForDayTx(tx,ctx(u),{employmentId:u.employmentId,date:day}));expect(answer).toBe(false);};
 try{
  instrument(pool);
  for(const phase of ['before','prepared','restored']){
   enabled=phase==='prepared';selectedCalls=0;await Promise.all(users.slice(0,40).map(u=>read(u)));await owner.client`select pg_stat_statements_reset()`;
   const times:number[]=[],started=performance.now();const results=await Promise.allSettled(users.map(async u=>{const before=performance.now();await read(u);times.push(performance.now()-before);}));
   const elapsedMs=performance.now()-started,errors=results.flatMap(r=>r.status==='rejected'?[String(r.reason)]:[]);times.sort((a,b)=>a-b);
   const roleMedians:Record<string,number>={};for(const [label,index]of [['employee',11],['manager',2],['companyHR',1],['groupHR',0]] as const){const samples:number[]=[];for(let i=0;i<5;i++){const before=performance.now();await read(users[index]);samples.push(performance.now()-before);}roleMedians[label]=samples.sort((a,b)=>a-b)[2];}
   expect(captured).toBeDefined();
   const freshness=await withTenant(ctx(users[11]),async tx=>{const original=await tx.execute(sql`select app.principal_snapshot_current() as current`);expect(original[0].current).toBe(true);await tx.execute(sql`select set_config('app.roles','super_admin',true)`);expect((await tx.execute(sql`select app.principal_snapshot_current() as current`))[0].current).toBe(false);return {forgedRoleStillDenied:true};});
   const statements=await owner.client`select calls,total_plan_time,total_exec_time,left(query,2300) as normalized_query from pg_stat_statements where query not like '%pg_stat_%' order by total_plan_time+total_exec_time desc limit 30`;
   reports[phase]={elapsedMs,p95Ms:times[474],roleMedians,selectedCalls,templateCount:templates.size,errors,freshness,statements};save();expect(errors).toEqual([]);
  }
 }finally{enabled=false;pool.unsafe=originalUnsafe;pool.begin=originalBegin;save();}
},240000);
