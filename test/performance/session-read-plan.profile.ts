/** Diagnostic only: uncorrelated native self-membership set; actual Notice owner and unchanged RLS. */
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID,createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {client,withTenant,type SessionContext} from '../../db/client';
import * as s from '../../db/schema';
import {createNotice,publishNotice,pendingNoticeAcknowledgementTasks} from '../../core/notice';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from '../harness';
beforeAll(migrateTestDb);afterAll(closeAll);
type Wire={unsafe:(...args:any[])=>any;begin?:(...args:any[])=>any;savepoint?:(...args:any[])=>any};
function code(error:unknown){let e=error as {code?:string;cause?:unknown};for(let i=0;e&&i<8;i++){if(e.code)return e.code;e=e.cause as typeof e;}return String(error);}
it('compares actual empty/populated Notice reads while keeping pooled identities and revocation live',async()=>{
 expect(process.env.GITHUB_ACTIONS).toBe('true');expect(new URL(process.env.TEST_DATABASE_URL!).hostname).toBe('127.0.0.1');
 await resetDb();await owner.client`create extension if not exists pg_stat_statements`;
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
 for(const table of ['person','employment','assignment','app_user','role_assignment','notice','notice_recipient'])await owner.client.unsafe('analyze '+table);
 const ctx=(u:typeof users[number]):SessionContext=>({...adminCtx(tenants[u.tenant]),userId:u.id,personId:u.personId,roles:[u.role],grants:[{role:u.role,companyId:u.group?null:tenants[u.tenant].companyId}]});
 const pool=client as unknown as Wire,originalUnsafe=pool.unsafe,originalBegin=pool.begin;
 const store=new AsyncLocalStorage<Wire>(),seen=new WeakSet<object>(),templates=new Set<string>();
 let enabled=false,captured:{query:string;params:unknown[]}|undefined;let selectedCalls=0;
 function instrument(connection:Wire):Wire{
  if(seen.has(connection))return connection;seen.add(connection);
  const raw=connection.unsafe;
  connection.unsafe=function(...args:any[]){
   const [query,params,options]=args;
   if(!captured&&typeof query==='string'&&query.includes('"notice_recipient"')&&query.includes('"content_version"')&&Array.isArray(params))captured={query,params:params.slice()};
   if(enabled&&typeof query==='string'&&query.includes('"notice_recipient"')&&query.includes('"content_version"')){
    const before=`EXISTS(SELECT 1 FROM public.employment self_employment
    WHERE self_employment.id=notice_recipient.employment_id AND self_employment.tenant_id=notice_recipient.tenant_id
     AND app.is_self_person(self_employment.person_id))`;
    if(query.includes(before)){
     const replacement=`notice_recipient.employment_id IN (SELECT self_employment.id FROM public.employment self_employment
      WHERE self_employment.tenant_id=$1::uuid AND app.is_self_person(self_employment.person_id))`;
     templates.add(query);selectedCalls++;return Reflect.apply(raw,connection,[query.replace(before,replacement),params,options]);
    }
   }
   return Reflect.apply(raw,connection,args);
  };
  for(const key of ['begin','savepoint'] as const){const original=connection[key];if(typeof original!=='function')continue;
   connection[key]=function(...args:any[]){const index=args.findIndex(value=>typeof value==='function');if(index>=0){const callback=args[index];args[index]=function(this:unknown,...inputs:any[]){const nested=instrument(inputs[0]);inputs[0]=nested;return store.run(nested,()=>Reflect.apply(callback,this,inputs));};}return Reflect.apply(original,connection,args);};
  }
  return connection;
 }
 const reports:Record<string,unknown>={},noticeRows:typeof s.notice.$inferSelect[]=[];
 const save=()=>writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'notice-self-set-work.json'),JSON.stringify({kind:'REVERSIBLE_NOTICE_SELF_MEMBERSHIP_SET_EXPERIMENT',releaseEligible:false,principals:500,tenants:2,templateLimit:128,templateCount:templates.size,capturedQuerySha256:captured?createHash('sha256').update(captured.query).digest('hex'):null,reports},null,2));
 const expected=(u:typeof users[number],populated:boolean)=>populated?[{noticeId:noticeRows[u.tenant].id,employmentId:u.employmentId,title:noticeRows[u.tenant].title,contentVersion:noticeRows[u.tenant].contentVersion,sourceUpdatedAt:noticeRows[u.tenant].updatedAt}]:[];
 const read=async(u:typeof users[number],populated:boolean)=>{const rows=await pendingNoticeAcknowledgementTasks(ctx(u));expect(rows).toEqual(expected(u,populated));if(rows.length)expect(rows[0].sourceUpdatedAt).toBeInstanceOf(Date);return rows;};
 try{
  instrument(pool);
  for(const dataCase of ['empty','populated']){
   const populated=dataCase==='populated';
   if(populated)for(let t=0;t<2;t++){
    const b=tenants[t],{id}=await createNotice(adminCtx(b),{title:'Fictional planning notice '+t,body:'Read this fictional planning notice.',startOn:'2020-01-01',endOn:'2099-12-31',criteria:{companyIds:[b.companyId]},requiresAcknowledgement:true});
    expect((await publishNotice(adminCtx(b),id)).recipients).toBe(250);
    const [row]=await owner.db.select().from(s.notice).where(eq(s.notice.id,id));noticeRows.push(row);
   }
   for(const phase of ['before','prepared','restored']){
    enabled=phase==='prepared';selectedCalls=0;
    await Promise.all(users.slice(0,100).map(u=>read(u,populated)));await owner.client`select pg_stat_statements_reset()`;
    const times:number[]=[],started=performance.now();
    const results=await Promise.allSettled(users.map(async u=>{const before=performance.now();await read(u,populated);times.push(performance.now()-before);}));
    const errors=results.flatMap(r=>r.status==='rejected'?[String(r.reason)]:[]);expect(errors).toEqual([]);times.sort((a,b)=>a-b);
    const elapsedMs=performance.now()-started;
    const roleMedians:Record<string,number>={};
    for(const [label,index]of [['employee',11],['manager',2],['companyHR',1],['groupHR',0]] as const){const samples=[];for(let i=0;i<5;i++){const before=performance.now();await read(users[index],populated);samples.push(performance.now()-before);}roleMedians[label]=samples.sort((a,b)=>a-b)[2];}
    expect(captured).toBeDefined();
    const freshness=await withTenant(ctx(users[11]),async tx=>{
     const wire=store.getStore();expect(wire).toBeDefined();
     const ask=async()=>{const rows=await wire!.unsafe(captured!.query,captured!.params).values();return rows.map((row:unknown[])=>row[1]);};
     const own=populated?[users[11].employmentId]:[],other=populated?[users[12].employmentId]:[];
     expect(await ask()).toEqual(own);
     await tx.execute(sql`select set_config('app.roles','super_admin',true)`);expect(await ask()).toEqual([]);
     await tx.execute(sql`select set_config('app.roles','employee',true),set_config('app.user_id',${users[12].id},true)`);expect(await ask()).toEqual(other);
     await tx.execute(sql`select set_config('app.user_id',${users[11].id},true)`);
     await owner.db.update(s.appUser).set({archivedAt:new Date()}).where(eq(s.appUser.id,users[11].id));expect(await ask()).toEqual([]);
     await owner.db.update(s.appUser).set({archivedAt:null}).where(eq(s.appUser.id,users[11].id));expect(await ask()).toEqual(own);
     const named=await wire!.unsafe(`select count(*)::int as n,coalesce(sum(generic_plans),0)::text as generic,coalesce(sum(custom_plans),0)::text as custom from pg_prepared_statements where statement like '%"notice_recipient"%'`);
     return {sameConnectionIdentityChanges:true,liveArchiveObserved:true,preparedNoticeStatements:named[0]};
    });
    let malformed:string|null=null;try{await pendingNoticeAcknowledgementTasks({...ctx(users[11]),tenantId:'invalid-uuid'});}catch(error){malformed=code(error);}expect(malformed).toBe('22P02');
    const statements=await owner.client`select calls,total_plan_time,total_exec_time,left(query,2200) as normalized_query from pg_stat_statements where query not like '%pg_stat_%' order by total_plan_time+total_exec_time desc limit 24`;
    reports[dataCase+'-'+phase]={elapsedMs,p95Ms:times[474],roleMedians,selectedCalls,templateCount:templates.size,exact500OwnResults:true,freshness,malformed,statements};save();
   }
  }
 }finally{
  enabled=false;pool.unsafe=originalUnsafe;pool.begin=originalBegin;
  await owner.db.update(s.appUser).set({archivedAt:null}).where(eq(s.appUser.id,users[11].id));save();
 }
},240000);
